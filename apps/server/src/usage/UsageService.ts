/**
 * UsageService - scans provider transcripts and returns priced daily usage.
 *
 * The scan reads the provider CLIs' own session files rather than T3 Code's
 * orchestration projections, so usage covers turns driven outside T3 Code too.
 * This is the approach `ccusage` takes: Claude Code and Codex from JSONL
 * sessions, OpenCode from its SQLite database (plus legacy message files),
 * and CommandCode from its per-project sessions.
 *
 * Transcripts are append-only, so parsed records are memoised per file by
 * `(size, mtime)`. A cold 30-day scan of ~1.4 GB lands around 2-3 seconds; warm
 * scans only reparse files that changed.
 *
 * @module UsageService
 */
import * as NodeOS from "node:os";

import {
  USAGE_CONTRACT_VERSION,
  ClaudeSettings,
  CodexSettings,
  type UsageProviderKind,
  type UsageSource,
  type UsageSummary,
  type UsageSummaryInput,
  UsageReadError,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import { ServerConfig } from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import { resolveClaudeHomePath } from "../provider/Drivers/ClaudeHome.ts";
import { resolveCodexHomeLayout } from "../provider/Drivers/CodexHomeLayout.ts";
import { expandHomePath } from "../pathExpansion.ts";
import { UsageAggregator } from "./usageAggregation.ts";
import * as ApiProviderUsageLedger from "./ApiProviderUsageLedger.ts";
import { selectCodexTranscriptFiles } from "./usageCodexFiles.ts";
import { parseRateTable, type RateTable } from "./usagePricing.ts";
import {
  listTranscriptFilesDetailed,
  readDirectoryVolumeId,
  readTranscriptRecords,
  listOpenCodeSourceFilesDetailed,
} from "./usageTranscriptReader.ts";
import {
  decodeScanCache,
  dedupeWithinFile,
  encodeScanCache,
  pruneScanCache,
  type ScanCache,
} from "./usageScanCache.ts";
import type { UsageRecord } from "./usageTranscripts.ts";

const LITELLM_RATES_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

/** Rates move rarely; a day-old table keeps the page working offline. */
const RATES_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Files are filtered by mtime before opening. The slack covers a session whose
 * last write lands just before local midnight on the window's first day.
 */
const MTIME_SLACK_MS = 36 * 60 * 60 * 1000;

/** Longest window the UI offers, plus slack. Older entries are pruned. */
const CACHE_RETENTION_DAYS = 90;

/** On-disk shape of the rate snapshot. */
const RatesCacheFile = Schema.Struct({
  fetchedAtMs: Schema.Number,
  document: Schema.Unknown,
});
const decodeRatesCache = Schema.decodeUnknownEffect(
  Schema.fromJsonString(RatesCacheFile as unknown as Schema.Codec<typeof RatesCacheFile.Type>),
);
const encodeRatesCache = Schema.encodeEffect(
  Schema.fromJsonString(RatesCacheFile as unknown as Schema.Codec<typeof RatesCacheFile.Type>),
);

/** The scan cache is narrowed by hand in `usageScanCache`, so JSON is enough here. */
const ScanCacheJson = Schema.fromJsonString(Schema.Unknown as unknown as Schema.Codec<unknown>);
const decodeScanCacheFile = Schema.decodeUnknownEffect(ScanCacheJson);
const encodeScanCacheFile = Schema.encodeEffect(ScanCacheJson);

export class UsageService extends Context.Service<
  UsageService,
  {
    readonly readSummary: (input: UsageSummaryInput) => Effect.Effect<UsageSummary, UsageReadError>;
  }
>()("t3/usage/UsageService") {}

/** Empty summary, for suites that only need the RPC surface to resolve. */
export const layerTest = Layer.succeed(
  UsageService,
  UsageService.of({
    readSummary: (input) =>
      Effect.succeed({
        contractVersion: USAGE_CONTRACT_VERSION,
        readAt: "1970-01-01T00:00:00.000Z",
        timeZone: input.timeZone,
        sinceDay: input.sinceDay,
        untilDay: input.untilDay,
        buckets: [],
        sources: [],
        pricing: {
          status: "unavailable",
          source: LITELLM_RATES_URL,
          fetchedAt: null,
          knownModels: 0,
        },
        scanDurationMs: 0,
      }),
  }),
);

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const httpClient = yield* HttpClient.HttpClient;
  const apiUsageLedger = yield* Effect.serviceOption(ApiProviderUsageLedger.ApiProviderUsageLedger);

  const fileCache: ScanCache = new Map();
  let cacheDirty = false;

  const ratesCachePath = path.join(config.stateDir, "usage-model-rates.json");
  const scanCachePath = path.join(config.stateDir, "usage-scan-cache.json");
  let rates: RateTable = new Map();
  let ratesFetchedAtMs: number | null = null;
  let ratesStatus: UsageSummary["pricing"]["status"] = "unavailable";

  /**
   * Loads the LiteLLM rate table, preferring a fresh copy and falling back to
   * the on-disk snapshot. With neither, every model reports as unpriced rather
   * than the page failing.
   */
  const ensureRates = Effect.fn("UsageService.ensureRates")(function* () {
    const now = yield* Clock.currentTimeMillis;
    if (ratesFetchedAtMs !== null && now - ratesFetchedAtMs < RATES_TTL_MS) return;

    if (ratesFetchedAtMs === null) {
      const fromDisk = yield* fileSystem.readFileString(ratesCachePath).pipe(
        Effect.flatMap((raw) => decodeRatesCache(raw)),
        Effect.catchCause(() => Effect.succeed(null)),
      );
      if (fromDisk !== null) {
        const parsed = parseRateTable(fromDisk.document);
        if (parsed.size > 0) {
          rates = parsed;
          ratesFetchedAtMs = fromDisk.fetchedAtMs;
          ratesStatus = "cached";
          if (now - fromDisk.fetchedAtMs < RATES_TTL_MS) return;
        }
      }
    }

    const fetched = yield* httpClient.get(LITELLM_RATES_URL).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((response) => response.json),
      Effect.timeout(10_000),
      Effect.catchCause(() => Effect.succeed(null)),
    );
    if (fetched === null) {
      // The refresh failed; whatever we are serving is now past its TTL and
      // must not keep claiming to be fresh.
      if (rates.size > 0) ratesStatus = "cached";
      return;
    }

    const parsed = parseRateTable(fetched);
    if (parsed.size === 0) return;

    rates = parsed;
    ratesFetchedAtMs = now;
    ratesStatus = "fresh";

    yield* encodeRatesCache({ fetchedAtMs: now, document: fetched }).pipe(
      Effect.flatMap((serialized) => fileSystem.writeFileString(ratesCachePath, serialized)),
      Effect.catchCause(() => Effect.void),
    );
  });

  /**
   * Claude's config dir is the home itself when overridden, but a default
   * install nests transcripts under `~/.claude/projects`. Probe both.
   */
  const resolveClaudeTranscriptDir = (homePath: string) =>
    Effect.gen(function* () {
      const nested = path.join(homePath, ".claude", "projects");
      const nestedExists = yield* fileSystem
        .exists(nested)
        .pipe(Effect.catchCause(() => Effect.succeed(false)));
      return nestedExists ? nested : path.join(homePath, "projects");
    });

  /** Resolves the transcript directory for each provider. */
  const resolveTranscriptDirs = Effect.fn("UsageService.resolveTranscriptDirs")(function* () {
    // A settings failure must surface as an error: swallowing it here would
    // present "zero usage from every provider" as a valid answer.
    const settings = yield* settingsService.getSettings.pipe(
      Effect.catchCause(
        (cause) =>
          new UsageReadError({
            reason: "scanFailed",
            // Bounded description; the squashed failure travels as the cause.
            // Squashed, not the Cause tree: a full tree in a Defect field is
            // the unbounded wire payload the bounded detail exists to avoid.
            detail: "Server settings could not be read.",
            cause: Cause.squash(cause),
          }),
      ),
    );

    const dirs: Array<{
      readonly provider: UsageProviderKind;
      readonly dir: string;
      readonly instanceId?: string;
      readonly codexArchive?: boolean;
      readonly codexSharedHomePath?: string;
    }> = [];
    const seen = new Set<string>();
    const addDir = (
      provider: UsageProviderKind,
      dir: string,
      instanceId?: string,
      codexArchive = false,
      codexSharedHomePath?: string,
    ) => {
      const resolved = path.resolve(dir);
      const key = `${provider}\0${resolved}`;
      if (seen.has(key)) return;
      seen.add(key);
      dirs.push({
        provider,
        dir: resolved,
        ...(instanceId ? { instanceId } : {}),
        ...(codexArchive ? { codexArchive: true } : {}),
        ...(codexSharedHomePath ? { codexSharedHomePath } : {}),
      });
    };

    const claudeHome = yield* resolveClaudeHomePath(settings.providers.claudeAgent);
    addDir("claude", yield* resolveClaudeTranscriptDir(claudeHome), "claude");
    if (settings.providers.claudeAgent.homePath.trim().length === 0) {
      const alternateClaudeDir = path.join(NodeOS.homedir(), ".config", "claude", "projects");
      if (
        yield* fileSystem
          .exists(alternateClaudeDir)
          .pipe(Effect.catchCause(() => Effect.succeed(false)))
      ) {
        addDir("claude", alternateClaudeDir, "claude");
      }
    }
    const codexLayout = yield* resolveCodexHomeLayout(settings.providers.codex);
    addDir(
      "codex",
      path.join(codexLayout.sharedHomePath, "sessions"),
      "codex",
      false,
      codexLayout.sharedHomePath,
    );
    const archivedCodexDir = path.join(codexLayout.sharedHomePath, "archived_sessions");
    if (
      yield* fileSystem
        .exists(archivedCodexDir)
        .pipe(Effect.catchCause(() => Effect.succeed(false)))
    ) {
      addDir("codex", archivedCodexDir, "codex", true, codexLayout.sharedHomePath);
    }

    // OpenCode's data dir mirrors ccusage exactly: `OPENCODE_DATA_DIR` if set,
    // else the platform default at `~/.local/share/opencode`.
    const openCodeDataDirs =
      process.env.OPENCODE_DATA_DIR?.split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0) ?? [];
    addDir(
      "opencode",
      openCodeDataDirs[0] ?? path.join(NodeOS.homedir(), ".local", "share", "opencode"),
      "opencode",
    );
    for (const dataDir of openCodeDataDirs.slice(1))
      addDir("opencode", expandHomePath(dataDir), "opencode");
    const commandCodeDefaultDir = path.join(NodeOS.homedir(), ".commandcode", "projects");
    addDir("commandcode", commandCodeDefaultDir, "commandcode");

    // The provider-instance registry can run more than one home/data
    // directory at once. Usage must scan those locations too, otherwise the
    // UI silently under-reports a configured work or account instance.
    for (const [instanceId, instance] of Object.entries(settings.providerInstances)) {
      if (instance.driver === "claude") {
        const config = Schema.decodeUnknownOption(ClaudeSettings)(instance.config ?? {});
        if (Option.isSome(config)) {
          const home = yield* resolveClaudeHomePath(config.value);
          addDir("claude", yield* resolveClaudeTranscriptDir(home), instanceId);
        }
        continue;
      }
      if (instance.driver === "codex") {
        const config = Schema.decodeUnknownOption(CodexSettings)(instance.config ?? {});
        if (Option.isSome(config)) {
          const layout = yield* resolveCodexHomeLayout(config.value);
          addDir(
            "codex",
            path.join(layout.sharedHomePath, "sessions"),
            instanceId,
            false,
            layout.sharedHomePath,
          );
          const archivedInstanceCodexDir = path.join(layout.sharedHomePath, "archived_sessions");
          if (
            yield* fileSystem
              .exists(archivedInstanceCodexDir)
              .pipe(Effect.catchCause(() => Effect.succeed(false)))
          ) {
            addDir("codex", archivedInstanceCodexDir, instanceId, true, layout.sharedHomePath);
          }
        }
        continue;
      }
      if (instance.driver === "opencode") {
        const instanceEnv = new Map(
          (instance.environment ?? []).map((variable) => [variable.name, variable.value]),
        );
        const configured = instanceEnv.get("OPENCODE_DATA_DIR") ?? "";
        const dataDirs = configured
          .split(",")
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0);
        for (const dataDir of dataDirs) addDir("opencode", expandHomePath(dataDir), instanceId);
        continue;
      }
      if (instance.driver === "commandcode") {
        // CommandCode stores sessions below $HOME/.commandcode. The driver
        // can override HOME per instance, so include that isolated store.
        const instanceHome = instance.environment?.find(
          (variable) => variable.name === "HOME",
        )?.value;
        if (instanceHome && instanceHome.trim().length > 0) {
          addDir(
            "commandcode",
            path.join(expandHomePath(instanceHome.trim()), ".commandcode", "projects"),
            instanceId,
          );
        }
      }
    }

    return dirs;
  });

  /**
   * Loads the persisted scan cache exactly once per process.
   *
   * `Effect.cached` makes concurrent first readers await the same load rather
   * than each seeing a "loaded" flag set before the read finished and cold
   * scanning against an empty cache.
   */
  const ensureScanCacheLoaded = yield* Effect.cached(
    Effect.gen(function* () {
      const document = yield* fileSystem.readFileString(scanCachePath).pipe(
        Effect.flatMap((raw) => decodeScanCacheFile(raw)),
        Effect.catchCause(() => Effect.succeed(null)),
      );
      if (document === null) return;
      for (const [path, entry] of decodeScanCache(document)) fileCache.set(path, entry);
    }),
  );

  const persistScanCache = Effect.fn("UsageService.persistScanCache")(function* () {
    if (!cacheDirty) return;
    // Cleared only after the write lands, so a failed persist is retried on
    // the next scan instead of leaving disk permanently stale.
    yield* encodeScanCacheFile(encodeScanCache(fileCache)).pipe(
      Effect.flatMap((serialized) => fileSystem.writeFileString(scanCachePath, serialized)),
      Effect.map(() => {
        cacheDirty = false;
      }),
      // A cache we cannot write is a slower next start, not a failed read.
      Effect.catchCause(() => Effect.void),
    );
  });

  /** Parses one transcript, reusing the cached result when it is unchanged. */
  const readFileRecords = (
    filePath: string,
    size: number,
    mtimeMs: number,
    provider: UsageProviderKind,
  ): Effect.Effect<readonly UsageRecord[]> =>
    Effect.gen(function* () {
      const cached = fileCache.get(filePath);
      // Provider is part of the identity: if both providers were ever pointed
      // at one directory, a hit parsed by the other parser must not be reused.
      if (
        cached &&
        cached.size === size &&
        cached.mtimeMs === mtimeMs &&
        cached.provider === provider
      ) {
        return cached.records;
      }

      const parsed = yield* Effect.promise(() => readTranscriptRecords(filePath, provider));
      // A read failure is not an empty transcript: caching it under this
      // (size, mtime) would silently drop the file's usage until it changes.
      if (parsed === null) return [];
      // Stored already de-duplicated within the file, which is 99% of all
      // duplicates. The aggregator still runs the cross-file dedupe pass.
      const records = dedupeWithinFile(parsed);

      fileCache.set(filePath, { size, mtimeMs, provider, records });
      cacheDirty = true;
      return records;
    });

  const readSummary = Effect.fn("UsageService.readSummary")(function* (input: UsageSummaryInput) {
    if (input.sinceDay > input.untilDay) {
      return yield* new UsageReadError({
        reason: "invalidWindow",
        detail: `sinceDay '${input.sinceDay}' is after untilDay '${input.untilDay}'`,
      });
    }

    const startedAtMs = yield* Clock.currentTimeMillis;
    yield* ensureRates();
    yield* ensureScanCacheLoaded;

    const hostId = NodeOS.hostname();
    // The home resolvers ask for `Path` themselves; satisfy them from the
    // instance we already hold so `readSummary` stays context-free.
    const dirs = yield* resolveTranscriptDirs().pipe(Effect.provideService(Path.Path, path));
    const windowStart = DateTime.make(`${input.sinceDay}T00:00:00Z`);
    if (Option.isNone(windowStart)) {
      return yield* new UsageReadError({
        reason: "invalidWindow",
        detail: `sinceDay '${input.sinceDay}' is not a valid date`,
      });
    }
    const windowStartMs = DateTime.toEpochMillis(windowStart.value) - MTIME_SLACK_MS;

    const aggregator = new UsageAggregator({
      timeZone: input.timeZone,
      sinceDay: input.sinceDay,
      untilDay: input.untilDay,
      rates,
    });

    const sources: UsageSource[] = [];
    const livePaths = new Set<string>();
    const walkedRoots: string[] = [];
    const codexActiveFiles = new Set<string>();

    // API turns do not create provider transcript files. They are read from a
    // separate durable ledger and enter the same aggregator so the Usage page
    // cannot silently omit API traffic or mix provider-reported cost with a
    // rate-table estimate.
    if (Option.isSome(apiUsageLedger)) {
      const apiRecords = yield* apiUsageLedger.value.list();
      const sessionIds = new Set<string>();
      let recordsInWindow = 0;
      for (const record of apiRecords) {
        const timestampMs = Date.parse(record.recordedAt);
        if (!Number.isFinite(timestampMs)) continue;
        const usageRecord: UsageRecord = {
          provider: "api",
          timestampMs,
          model: record.model,
          sessionId: String(record.threadId),
          totals: {
            uncachedInputTokens: Math.max(
              0,
              (record.inputTokens ?? 0) - (record.cachedInputTokens ?? 0),
            ),
            cachedInputTokens: record.cachedInputTokens ?? 0,
            cacheCreationTokens: 0,
            outputTokens: record.outputTokens ?? 0,
            reasoningTokens: record.reasoningOutputTokens ?? 0,
          },
          reportedCostUsd: record.providerReportedCostUsd ?? null,
          dedupeKey: record.requestId
            ? `api:${record.requestId}`
            : `api:${record.turnId}:${record.recordedAt}`,
        };
        if (aggregator.add(usageRecord)) {
          recordsInWindow += 1;
          sessionIds.add(usageRecord.sessionId);
        }
      }
      const ledgerPath = path.join(config.stateDir, "api-provider-usage.json");
      sources.push({
        fingerprint: { hostId, provider: "api", resolvedHomePath: ledgerPath, volumeId: "" },
        status: "ok",
        scannedFiles: recordsInWindow > 0 ? 1 : 0,
        skippedFiles: recordsInWindow > 0 ? 0 : 1,
        malformedRecords: 0,
        distinctSessions: sessionIds.size,
        message: null,
      });
    }

    for (const { provider, dir, instanceId, codexArchive, codexSharedHomePath } of dirs) {
      const volumeId = yield* Effect.promise(() => readDirectoryVolumeId(dir));
      const exists = yield* fileSystem
        .exists(dir)
        .pipe(Effect.catchCause(() => Effect.succeed(false)));

      if (!exists) {
        sources.push({
          fingerprint: {
            hostId,
            provider,
            ...(instanceId ? { instanceId } : {}),
            resolvedHomePath: dir,
            volumeId,
          },
          status: "missing",
          scannedFiles: 0,
          skippedFiles: 0,
          malformedRecords: 0,
          distinctSessions: 0,
          message: "No transcript directory on this environment.",
        });
        continue;
      }

      walkedRoots.push(dir);
      const listing =
        provider === "opencode"
          ? yield* Effect.promise(() => listOpenCodeSourceFilesDetailed(dir, windowStartMs))
          : yield* Effect.promise(() => listTranscriptFilesDetailed(dir, windowStartMs));
      const files =
        provider === "codex"
          ? selectCodexTranscriptFiles({
              files: listing.files,
              root: dir,
              sharedHomePath: codexSharedHomePath ?? dir,
              archived: codexArchive ?? false,
              activeFiles: codexActiveFiles,
            })
          : listing.files;
      let scannedFiles = 0;
      let skippedFiles = 0;
      let readFailures = 0;
      // Distinct per directory. Buckets carry per-cell session counts, but a
      // session spans days and models, so clients total this figure instead.
      const sessionIds = new Set<string>();

      for (const file of files) {
        livePaths.add(file.path);
        const records = yield* readFileRecords(file.path, file.size, file.mtimeMs, provider);
        if (records.length === 0) {
          skippedFiles += 1;
          // An empty file and an unreadable file are not equivalent. The
          // latter must be visible to the caller instead of looking like a
          // legitimate zero-usage source.
          const cached = fileCache.get(file.path);
          if (!cached || cached.size !== file.size || cached.mtimeMs !== file.mtimeMs) {
            readFailures += 1;
          }
          continue;
        }
        scannedFiles += 1;
        for (const record of records) {
          // Only sessions that contributed in-window count: the mtime slack
          // admits boundary files whose records fall outside the range.
          if (aggregator.add(record) && record.sessionId.length > 0) {
            sessionIds.add(record.sessionId);
          }
        }
      }

      sources.push({
        fingerprint: {
          hostId,
          provider,
          ...(instanceId ? { instanceId } : {}),
          resolvedHomePath: dir,
          volumeId,
        },
        status:
          readFailures > 0 || listing.hadErrors ? (scannedFiles > 0 ? "partial" : "failed") : "ok",
        scannedFiles,
        skippedFiles,
        malformedRecords: 0,
        distinctSessions: sessionIds.size,
        message:
          readFailures > 0 || listing.hadErrors
            ? "One or more transcript files could not be read completely."
            : null,
      });
    }

    const pruned = pruneScanCache(fileCache, {
      livePaths,
      walkedRoots,
      windowStartMs,
      retentionCutoffMs: startedAtMs - CACHE_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    });
    if (pruned > 0) cacheDirty = true;
    yield* persistScanCache();

    const aggregated = aggregator.finish();
    const readAt = yield* DateTime.now;
    const finishedAtMs = yield* Clock.currentTimeMillis;

    return {
      contractVersion: USAGE_CONTRACT_VERSION,
      readAt: DateTime.formatIso(readAt),
      timeZone: input.timeZone,
      sinceDay: input.sinceDay,
      untilDay: input.untilDay,
      buckets: aggregated.buckets,
      sources,
      pricing: {
        status: ratesStatus,
        source: LITELLM_RATES_URL,
        fetchedAt:
          ratesFetchedAtMs === null
            ? null
            : DateTime.formatIso(DateTime.makeUnsafe(ratesFetchedAtMs)),
        knownModels: rates.size,
      },
      scanDurationMs: Math.max(0, finishedAtMs - startedAtMs),
    } satisfies UsageSummary;
  });

  return { readSummary } as const;
});

export const layer = Layer.effect(UsageService, make);
