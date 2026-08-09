/**
 * Pure parsers for the provider CLIs' on-disk session transcripts.
 *
 * Claude and CommandCode are line-at-a-time reducers so callers can stream
 * large files without materialising them; Codex keeps rolling file state;
 * OpenCode parses whole message payloads (SQLite rows or legacy message
 * files). None of them touch the filesystem.
 *
 * @module usageTranscripts
 */
import type { UsageProviderKind, UsageTokenTotals } from "@t3tools/contracts";

export interface UsageRecord {
  readonly provider: UsageProviderKind;
  readonly timestampMs: number;
  readonly model: string;
  readonly sessionId: string;
  readonly totals: UsageTokenTotals;
  readonly reportedCostUsd: number | null;
  /**
   * Key for cross-file de-duplication, or `null` when the record is inherently
   * unique and needs no dedup.
   */
  readonly dedupeKey: string | null;
}

const EMPTY_TOTALS: UsageTokenTotals = {
  uncachedInputTokens: 0,
  cachedInputTokens: 0,
  cacheCreationTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
};

function int(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

function parseTimestampMs(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

export function addTotals(a: UsageTokenTotals, b: UsageTokenTotals): UsageTokenTotals {
  return {
    uncachedInputTokens: a.uncachedInputTokens + b.uncachedInputTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
  };
}

export function totalTokens(totals: UsageTokenTotals): number {
  // reasoningTokens is a subset of outputTokens and must not be added again.
  return (
    totals.uncachedInputTokens +
    totals.cachedInputTokens +
    totals.cacheCreationTokens +
    totals.outputTokens
  );
}

/**
 * Cheap substring gate applied before `JSON.parse`.
 *
 * Transcripts are mostly tool output; only a minority of lines carry usage. On
 * a 30-day window this skips roughly half the lines outright and is worth about
 * an order of magnitude.
 */
export function mightCarryUsage(line: string, provider: UsageProviderKind): boolean {
  return provider === "claude"
    ? line.includes('"usage"')
    : provider === "codex"
      ? line.includes('"token_count"')
      : line.includes('"usage"');
}

/* -------------------------------------------------------------------------- */
/* Claude Code                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Parses one line of a Claude Code transcript.
 *
 * T3 Code writes one record per assistant *content block*, and every one of
 * those records repeats the same complete `usage` object for the parent
 * message. Summing them overcounts by roughly 2.4x on a real workload, so the
 * caller must drop repeats by `dedupeKey` and keep the first.
 */
export function parseClaudeLine(line: string): UsageRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  const record = parsed as Record<string, unknown>;
  if (record["type"] !== "assistant") return null;

  const message = record["message"];
  if (typeof message !== "object" || message === null) return null;
  const messageRecord = message as Record<string, unknown>;

  const usage = messageRecord["usage"];
  if (typeof usage !== "object" || usage === null) return null;
  const usageRecord = usage as Record<string, unknown>;

  const timestampMs = parseTimestampMs(record["timestamp"]);
  if (timestampMs === null) return null;

  const model = typeof messageRecord["model"] === "string" ? messageRecord["model"] : "";
  if (model.length === 0) return null;

  const messageId = typeof messageRecord["id"] === "string" ? messageRecord["id"] : null;
  const requestId = typeof record["requestId"] === "string" ? record["requestId"] : null;
  // Matches ccusage: prefer the message/request pair, fall back to whichever
  // half exists. Records with neither cannot be de-duplicated.
  const dedupeKey =
    messageId === null && requestId === null ? null : `${messageId ?? ""}:${requestId ?? ""}`;

  const cost = record["costUSD"];

  return {
    provider: "claude",
    timestampMs,
    model,
    sessionId: typeof record["sessionId"] === "string" ? record["sessionId"] : "",
    totals: {
      uncachedInputTokens: int(usageRecord["input_tokens"]),
      cachedInputTokens: int(usageRecord["cache_read_input_tokens"]),
      cacheCreationTokens: int(usageRecord["cache_creation_input_tokens"]),
      outputTokens: int(usageRecord["output_tokens"]),
      // Anthropic folds thinking tokens into output and does not break them out.
      reasoningTokens: 0,
    },
    reportedCostUsd: typeof cost === "number" && Number.isFinite(cost) ? cost : null,
    dedupeKey,
  };
}

/* -------------------------------------------------------------------------- */
/* Codex                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Rolling state for a single Codex rollout file.
 *
 * Codex `token_count` events carry no model, so the model is carried forward
 * from the most recent `turn_context`. Sessions that switch models mid-run
 * attribute correctly from the switch onward.
 */
export interface CodexScanState {
  model: string;
  sessionId: string;
  lastUsageSignature: string | null;
}

export function initialCodexScanState(): CodexScanState {
  return { model: "", sessionId: "", lastUsageSignature: null };
}

/**
 * Feeds one line of a Codex rollout into `state`, returning a record when the
 * line was a usage event.
 *
 * Deltas come from `last_token_usage`. Summing those across a session
 * reconciles with the session's final `total_token_usage`, provided
 * consecutive duplicate events are dropped, which this does.
 */
export function parseCodexLine(line: string, state: CodexScanState): UsageRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  const record = parsed as Record<string, unknown>;
  const payload = record["payload"];
  if (typeof payload !== "object" || payload === null) return null;
  const payloadRecord = payload as Record<string, unknown>;
  const payloadType = payloadRecord["type"];

  if (record["type"] === "session_meta") {
    const id = payloadRecord["id"] ?? payloadRecord["session_id"];
    if (typeof id === "string") state.sessionId = id;
    return null;
  }

  if (record["type"] === "turn_context") {
    if (typeof payloadRecord["model"] === "string") state.model = payloadRecord["model"];
    return null;
  }

  if (payloadType !== "token_count") return null;

  const info = payloadRecord["info"];
  if (typeof info !== "object" || info === null) return null;
  const last = (info as Record<string, unknown>)["last_token_usage"];
  if (typeof last !== "object" || last === null) return null;
  const lastRecord = last as Record<string, unknown>;

  // Only an event that is otherwise eligible may consume the duplicate
  // signature. A token_count arriving before its turn_context (no model yet)
  // must not poison it, or the re-emitted copy after the model is known would
  // be skipped as a duplicate and those tokens never counted.
  const timestampMs = parseTimestampMs(record["timestamp"]);
  if (timestampMs === null) return null;
  if (state.model.length === 0) return null;

  // Codex re-emits an unchanged token_count on some stream boundaries. Summing
  // those would double count, so identical consecutive payloads are skipped.
  const signature = JSON.stringify(lastRecord);
  if (signature === state.lastUsageSignature) return null;
  state.lastUsageSignature = signature;

  const inputTokens = int(lastRecord["input_tokens"]);
  const cachedInputTokens = int(lastRecord["cached_input_tokens"]);
  const cacheCreationTokens = int(lastRecord["cache_write_input_tokens"]);
  const outputTokens = int(lastRecord["output_tokens"]);

  const totals: UsageTokenTotals = {
    // Codex reports `input_tokens` inclusive of the cached portion.
    uncachedInputTokens: Math.max(0, inputTokens - cachedInputTokens - cacheCreationTokens),
    cachedInputTokens,
    cacheCreationTokens,
    outputTokens,
    // Reported inside output_tokens, surfaced separately for the token mix.
    reasoningTokens: Math.min(outputTokens, int(lastRecord["reasoning_output_tokens"])),
  };

  if (totalTokens(totals) === 0) return null;

  return {
    provider: "codex",
    timestampMs,
    model: state.model,
    sessionId: state.sessionId,
    totals,
    // Codex does not report cost in the rollout.
    reportedCostUsd: null,
    // Rollout files are unique per session, so events need no global dedup.
    dedupeKey: null,
  };
}

/* -------------------------------------------------------------------------- */
/* CommandCode                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Rolling state for a single CommandCode transcript file.
 *
 * CommandCode writes one JSON object per line: a `session` header announcing
 * the session id, then `message` lines. Usage rides on assistant messages
 * (`usage` with token and cost fields, plus the resolved `model`), but the
 * session id only appears on the header line, so records carry it forward.
 */
export interface CommandCodeScanState {
  sessionId: string;
}

export function initialCommandCodeScanState(): CommandCodeScanState {
  return { sessionId: "" };
}

/**
 * Parses one line of a CommandCode transcript.
 *
 * Only assistant messages with a `usage` object contribute. Usage carries
 * `inputTokens`, `cacheReadTokens`, `cacheWriteTokens` and `outputTokens`, and
 * a provider-reported `costUsd`; model comes from the `model` field verbatim
 * (`deepseek/deepseek-v4-flash`, provider prefix included). Verified against
 * real transcripts: records are unique per file, so no dedup key is needed.
 */
export function parseCommandCodeLine(
  line: string,
  state: CommandCodeScanState,
): UsageRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  const record = parsed as Record<string, unknown>;
  if (record["type"] === "session") {
    const id = record["id"];
    if (typeof id === "string") state.sessionId = id;
    return null;
  }
  if (record["type"] !== "message") return null;

  const message = record["message"];
  if (typeof message !== "object" || message === null) return null;
  const messageRecord = message as Record<string, unknown>;
  if (messageRecord["role"] !== "assistant") return null;

  const usage = record["usage"];
  if (typeof usage !== "object" || usage === null) return null;
  const usageRecord = usage as Record<string, unknown>;

  const timestampMs = parseTimestampMs(record["timestamp"]);
  // Cost is optional to read but the timestamps must parse: an assistant
  // record without one cannot be bucketed and is treated as malformed.
  if (timestampMs === null) return null;

  const model = typeof record["model"] === "string" ? record["model"] : "";
  if (model.length === 0) return null;

  const inputTokens = int(usageRecord["inputTokens"]);
  const cacheReadTokens = int(usageRecord["cacheReadTokens"]);
  const cacheWriteTokens = int(usageRecord["cacheWriteTokens"]);
  const outputTokens = int(usageRecord["outputTokens"]);
  const totals: UsageTokenTotals = {
    uncachedInputTokens: inputTokens,
    cachedInputTokens: cacheReadTokens,
    cacheCreationTokens: cacheWriteTokens,
    outputTokens,
    // CommandCode does not break reasoning out of output.
    reasoningTokens: 0,
  };
  if (totalTokens(totals) === 0) return null;

  const cost = usageRecord["costUsd"];

  return {
    provider: "commandcode",
    timestampMs,
    model,
    sessionId: state.sessionId,
    totals,
    reportedCostUsd: typeof cost === "number" && Number.isFinite(cost) ? cost : null,
    // Files are unique per session and records carry no duplicate signature,
    // so no global dedup is needed.
    dedupeKey: null,
  };
}

/* -------------------------------------------------------------------------- */
/* OpenCode                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Parses one OpenCode message payload into a usage record.
 *
 * Returns null when the message carries no tokens at all.
 *
 * Used by both SQLite `message` rows (`session_id` from the row) and legacy
 * files under `storage/message/<sessionId>/<messageId>.json` (session id from
 * the file path). The dedupe key is the message id, so when both sources hold
 * the same message only one record survives.
 */
export function parseOpenCodeMessage(
  parsed: unknown,
  sessionId: string,
  id: string | null,
): UsageRecord | null {
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;

  const tokens = record["tokens"];
  if (typeof tokens !== "object" || tokens === null) return null;
  const tokensRecord = tokens as Record<string, unknown>;
  const cache = tokensRecord["cache"];
  const cacheRecord =
    typeof cache === "object" && cache !== null ? (cache as Record<string, unknown>) : null;

  const inputTokens = int(tokensRecord["input"]);
  const outputTokens = int(tokensRecord["output"]);
  const cacheReadTokens = cacheRecord === null ? 0 : int(cacheRecord["read"]);
  const cacheWriteTokens = cacheRecord === null ? 0 : int(cacheRecord["write"]);
  const totals: UsageTokenTotals = {
    uncachedInputTokens: inputTokens,
    cachedInputTokens: cacheReadTokens,
    cacheCreationTokens: cacheWriteTokens,
    outputTokens,
    // Surface separately for the token mix; reported inside output.
    reasoningTokens: Math.min(outputTokens, int(tokensRecord["reasoning"])),
  };
  if (totalTokens(totals) === 0) return null;

  const time = record["time"];
  const timeRecord =
    typeof time === "object" && time !== null ? (time as Record<string, unknown>) : null;
  const created = timeRecord === null ? null : timeRecord["created"];
  // OpenCode writes epoch milliseconds; the string form is tolerated the same
  // way the CLI JSONL transcripts do.
  const timestampMs =
    typeof created === "number" && Number.isFinite(created)
      ? Math.trunc(created)
      : parseTimestampMs(created);
  if (timestampMs === null) return null;

  const modelID = typeof record["modelID"] === "string" ? record["modelID"] : "";
  const providerID = typeof record["providerID"] === "string" ? record["providerID"] : "";
  const model = providerID.length > 0 && modelID.length > 0 ? `${providerID}/${modelID}` : modelID;
  if (model.length === 0) return null;

  const cost = record["cost"];

  return {
    provider: "opencode",
    timestampMs,
    model,
    sessionId,
    totals,
    reportedCostUsd: typeof cost === "number" && Number.isFinite(cost) ? cost : null,
    // De-duplicates the same message seen in the SQLite DB and in a legacy
    // `storage/message` file, matching ccusage.
    dedupeKey: id ?? null,
  };
}

export { EMPTY_TOTALS };
