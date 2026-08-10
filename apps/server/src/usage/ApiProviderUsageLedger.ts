import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { NonNegativeInt, ProviderInstanceId, ThreadId, TurnId } from "@t3tools/contracts";
import { ServerConfig } from "../config.ts";

export const ApiProviderUsageRecord = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  profileId: Schema.String,
  threadId: ThreadId,
  turnId: TurnId,
  model: Schema.String,
  requestId: Schema.optional(Schema.String),
  inputTokens: Schema.optional(NonNegativeInt),
  cachedInputTokens: Schema.optional(NonNegativeInt),
  outputTokens: Schema.optional(NonNegativeInt),
  reasoningOutputTokens: Schema.optional(NonNegativeInt),
  providerReportedCostUsd: Schema.optional(Schema.Number),
  estimatedCostUsd: Schema.optional(Schema.Number),
  costSource: Schema.Literals(["provider-reported", "pricing-catalog", "unavailable"]),
  recordedAt: Schema.String,
});
export type ApiProviderUsageRecord = typeof ApiProviderUsageRecord.Type;

export class ApiProviderUsageLedger extends Context.Service<
  ApiProviderUsageLedger,
  {
    readonly append: (record: ApiProviderUsageRecord) => Effect.Effect<void>;
    readonly list: () => Effect.Effect<ReadonlyArray<ApiProviderUsageRecord>>;
  }
>()("t3/usage/ApiProviderUsageLedger") {}

const UsageRecordsJson = Schema.fromJsonString(
  Schema.Array(ApiProviderUsageRecord) as unknown as Schema.Codec<
    ReadonlyArray<ApiProviderUsageRecord>
  >,
);
const decodeRecords = Schema.decodeUnknownSync(UsageRecordsJson);
const encodeRecords = Schema.encodeSync(UsageRecordsJson);

export const layer = Layer.effect(
  ApiProviderUsageLedger,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const filePath = path.join(config.stateDir, "api-provider-usage.json");
    let records: Array<ApiProviderUsageRecord> = yield* fileSystem.readFileString(filePath).pipe(
      Effect.map((raw) => [...decodeRecords(raw)]),
      Effect.orElseSucceed(() => [] as Array<ApiProviderUsageRecord>),
    );
    let persistQueue: Effect.Effect<void> = Effect.void;
    const persist = () => {
      const temporaryPath = `${filePath}.tmp`;
      return fileSystem.writeFileString(temporaryPath, encodeRecords(records)).pipe(
        Effect.andThen(fileSystem.rename(temporaryPath, filePath)),
        Effect.catch(() => Effect.void),
      );
    };
    return ApiProviderUsageLedger.of({
      append: (record) =>
        Effect.gen(function* () {
          if (
            record.requestId &&
            records.some((existing) => existing.requestId === record.requestId)
          )
            return;
          records = [...records, record].slice(-20_000);
          persistQueue = persistQueue.pipe(Effect.andThen(persist));
          yield* persistQueue;
        }),
      list: () => Effect.succeed(records),
    });
  }),
);
