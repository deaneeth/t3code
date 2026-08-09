import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Data from "effect/Data";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as Schema from "effect/Schema";

const COMMANDCODE_API_BASE = "https://api.commandcode.ai";

export interface CommandCodeUsageData {
  readonly plan: {
    readonly id: string;
    readonly displayName: string;
    readonly status: string;
    readonly currentPeriodEnd: string;
    readonly daysToRenewal: number;
  };
  readonly cycle: {
    readonly totalRemaining: number;
    readonly monthlyRemaining: number;
    readonly purchasedRemaining: number;
    readonly freeRemaining: number;
    readonly totalSpent: number;
    readonly totalPool: number;
    readonly usagePercent: number;
    readonly totalRequests: number;
  };
  readonly windowLimits: {
    readonly limited: boolean;
    readonly fiveHour: {
      readonly used: number;
      readonly cap: number;
      readonly percentage: number;
      readonly exceeded: boolean;
      readonly resetAtMs: number;
      readonly resetsIn: string;
    };
    readonly weekly: {
      readonly used: number;
      readonly cap: number;
      readonly percentage: number;
      readonly exceeded: boolean;
      readonly resetAtMs: number;
      readonly resetsIn: string;
    };
  };
}

class CommandCodeUsageError extends Data.TaggedError("CommandCodeUsageError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const AuthJsonSchema = Schema.Struct({
  apiKey: Schema.optional(Schema.String),
});

const CreditsResponseSchema = Schema.Struct({
  credits: Schema.Struct({
    monthlyCredits: Schema.Number,
    purchasedCredits: Schema.Number,
    freeCredits: Schema.Number,
  }),
  windowLimits: Schema.optional(
    Schema.Struct({
      limited: Schema.optional(Schema.Boolean),
      fiveHour: Schema.optional(
        Schema.Struct({
          used: Schema.optional(Schema.Number),
          cap: Schema.optional(Schema.Number),
          exceeded: Schema.optional(Schema.Boolean),
          resetAt: Schema.optional(Schema.Number),
        }),
      ),
      weekly: Schema.optional(
        Schema.Struct({
          used: Schema.optional(Schema.Number),
          cap: Schema.optional(Schema.Number),
          exceeded: Schema.optional(Schema.Boolean),
          resetAt: Schema.optional(Schema.Number),
        }),
      ),
    }),
  ),
});

const SubscriptionResponseSchema = Schema.Struct({
  success: Schema.optional(Schema.Boolean),
  data: Schema.optional(
    Schema.Struct({
      planId: Schema.optional(Schema.String),
      status: Schema.optional(Schema.String),
      currentPeriodStart: Schema.optional(Schema.String),
      currentPeriodEnd: Schema.optional(Schema.String),
    }),
  ),
});

const UsageResponseSchema = Schema.Struct({
  totalCount: Schema.Number,
  totalCost: Schema.Number,
  totalTokensIn: Schema.Number,
  totalTokensOut: Schema.Number,
});

function formatPlanName(planId: string): string {
  if (!planId || planId === "unknown") return "Command Code";
  const withoutPrefix = planId.replace(/^(?:individual|teams)-/u, "");
  return withoutPrefix
    .split(/[-_]/u)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}

function formatResetsIn(resetAtMs: number, nowMs: number): string {
  if (!Number.isFinite(resetAtMs) || resetAtMs <= 0) return "not active";
  const diffMs = resetAtMs - nowMs;
  if (diffMs <= 0) return "resetting soon";

  const diffMinutes = Math.max(1, Math.ceil(diffMs / 60_000));
  const days = Math.floor(diffMinutes / 1440);
  const hours = Math.floor((diffMinutes % 1440) / 60);
  const minutes = diffMinutes % 60;

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0 && days === 0) parts.push(`${minutes}m`);
  return parts.join(" ") || "resetting soon";
}

function computeDaysToRenewal(endMs: number, nowMs: number): number {
  const diffMs = endMs - nowMs;
  return Math.ceil(diffMs / (24 * 60 * 60 * 1000));
}

function getUsagePercent(used: number, total: number): number {
  if (total <= 0) return 0;
  return Math.min(100, Math.round((used / total) * 100));
}

function makeRequest(httpClient: HttpClient.HttpClient, url: string, apiKey: string) {
  return httpClient
    .get(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    .pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((response) => response.json),
    );
}

export function fetchCommandCodeUsage(
  authJsonPath: string,
): Effect.Effect<
  CommandCodeUsageData,
  CommandCodeUsageError,
  FileSystem.FileSystem | HttpClient.HttpClient
> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const httpClient = yield* HttpClient.HttpClient;

    const authContent = yield* fs.readFileString(authJsonPath).pipe(
      Effect.mapError(
        (cause) =>
          new CommandCodeUsageError({
            message: `Failed to read auth.json: ${authJsonPath}`,
            cause,
          }),
      ),
    );

    const auth = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(AuthJsonSchema))(
      authContent,
    ).pipe(
      Effect.mapError(
        (cause) =>
          new CommandCodeUsageError({
            message: "Invalid auth.json format",
            cause,
          }),
      ),
    );

    if (!auth.apiKey) {
      return yield* new CommandCodeUsageError({
        message: "No API key found in CommandCode auth.json",
      });
    }

    const apiKey = auth.apiKey;

    const [creditsResponse, subscriptionResponse, usageResponse] = yield* Effect.all([
      makeRequest(httpClient, `${COMMANDCODE_API_BASE}/alpha/billing/credits`, apiKey),
      makeRequest(httpClient, `${COMMANDCODE_API_BASE}/alpha/billing/subscriptions`, apiKey),
      makeRequest(httpClient, `${COMMANDCODE_API_BASE}/alpha/usage/summary`, apiKey),
    ]).pipe(
      Effect.mapError(
        (cause) =>
          new CommandCodeUsageError({
            message: "Failed to fetch CommandCode usage data",
            cause,
          }),
      ),
    );

    const credits = yield* Schema.decodeUnknownEffect(CreditsResponseSchema)(creditsResponse).pipe(
      Effect.mapError(
        (cause) =>
          new CommandCodeUsageError({
            message: "Invalid credits response",
            cause,
          }),
      ),
    );

    const subscription = yield* Schema.decodeUnknownEffect(SubscriptionResponseSchema)(
      subscriptionResponse,
    ).pipe(
      Effect.mapError(
        (cause) =>
          new CommandCodeUsageError({
            message: "Invalid subscription response",
            cause,
          }),
      ),
    );

    const usage = yield* Schema.decodeUnknownEffect(UsageResponseSchema)(usageResponse).pipe(
      Effect.mapError(
        (cause) =>
          new CommandCodeUsageError({
            message: "Invalid usage response",
            cause,
          }),
      ),
    );

    const planId = subscription.data?.planId ?? "unknown";
    const planStatus = subscription.data?.status ?? "unknown";
    const currentPeriodEnd = subscription.data?.currentPeriodEnd ?? "";
    const monthlyRemaining = Math.max(0, credits.credits?.monthlyCredits ?? 0);
    const purchasedRemaining = Math.max(0, credits.credits?.purchasedCredits ?? 0);
    const freeRemaining = Math.max(0, credits.credits?.freeCredits ?? 0);
    const totalRemaining = monthlyRemaining + purchasedRemaining + freeRemaining;
    const totalSpent = Math.max(0, usage.totalCost ?? 0);

    // The API returns remaining balances and period spend. Derive the pool
    // from those live values instead of embedding a plan-price table that can
    // silently go stale when CommandCode adds or changes a plan.
    const totalPool = totalSpent + totalRemaining;
    const usagePercent = totalPool > 0 ? getUsagePercent(totalSpent, totalPool) : 0;

    const fiveHourUsed = credits.windowLimits?.fiveHour?.used ?? 0;
    const fiveHourCap = credits.windowLimits?.fiveHour?.cap ?? 0;
    const fiveHourResetAt = credits.windowLimits?.fiveHour?.resetAt ?? 0;

    const weeklyUsed = credits.windowLimits?.weekly?.used ?? 0;
    const weeklyCap = credits.windowLimits?.weekly?.cap ?? 0;
    const weeklyResetAt = credits.windowLimits?.weekly?.resetAt ?? 0;

    const nowMs = yield* Clock.currentTimeMillis;
    const periodEndMs = DateTime.make(currentPeriodEnd).pipe(
      Option.map(DateTime.toEpochMillis),
      Option.getOrElse(() => 0),
    );

    return {
      plan: {
        id: planId,
        displayName: formatPlanName(planId),
        status: planStatus,
        currentPeriodEnd,
        daysToRenewal: periodEndMs ? computeDaysToRenewal(periodEndMs, nowMs) : 0,
      },
      cycle: {
        totalRemaining,
        monthlyRemaining,
        purchasedRemaining,
        freeRemaining,
        totalSpent,
        totalPool,
        usagePercent,
        totalRequests: usage.totalCount ?? 0,
      },
      windowLimits: {
        limited: credits.windowLimits?.limited ?? false,
        fiveHour: {
          used: fiveHourUsed,
          cap: fiveHourCap,
          percentage: fiveHourCap > 0 ? Math.min(100, (fiveHourUsed / fiveHourCap) * 100) : 0,
          exceeded:
            fiveHourCap > 0
              ? (credits.windowLimits?.fiveHour?.exceeded ?? fiveHourUsed >= fiveHourCap)
              : false,
          resetAtMs: fiveHourResetAt,
          resetsIn: formatResetsIn(fiveHourResetAt, nowMs),
        },
        weekly: {
          used: weeklyUsed,
          cap: weeklyCap,
          percentage: weeklyCap > 0 ? Math.min(100, (weeklyUsed / weeklyCap) * 100) : 0,
          exceeded:
            weeklyCap > 0
              ? (credits.windowLimits?.weekly?.exceeded ?? weeklyUsed >= weeklyCap)
              : false,
          resetAtMs: weeklyResetAt,
          resetsIn: formatResetsIn(weeklyResetAt, nowMs),
        },
      },
    };
  });
}
