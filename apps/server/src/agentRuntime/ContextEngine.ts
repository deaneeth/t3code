/**
 * ContextEngine — token budgeting, compaction, and working memory.
 *
 * Manages the context window for an agent session:
 * - Token budgeting: tracks input/output/cached tokens per turn
 * - Compaction: summarizes old turns when context window fills
 * - Working memory: short-term (current session) + long-term (persisted)
 *
 * @module agentRuntime/ContextEngine
 */
import type { TransportHistoryEntry, TransportUsage } from "./transport/LLMTransport.ts";

/**
 * Model context window limits. Defaults to conservative estimates.
 */
export interface ModelContextLimits {
  /** Maximum context window in tokens. */
  readonly maxContextTokens: number;
  /** Fraction of context to reserve for completion output (default 0.25). */
  readonly outputReserveFraction: number;
  /** Maximum tokens for a single turn's input before compaction. */
  readonly maxTurnInputTokens: number;
}

const DEFAULT_LIMITS: ModelContextLimits = {
  maxContextTokens: 128_000,
  outputReserveFraction: 0.25,
  maxTurnInputTokens: 96_000,
};

/**
 * Rough token count estimator. ~4 chars per token for English text.
 * Good enough for budgeting; exact counts aren't needed for compaction.
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Estimate tokens from a content field that may be a string or structured array.
 */
function estimateContentTokens(
  content: string | Array<Record<string, unknown>> | undefined,
): number {
  if (typeof content === "string") return estimateTokens(content);
  if (Array.isArray(content)) {
    // Structured content (e.g., Gemini/OpenAI Responses) — estimate from JSON length
    return estimateTokens(JSON.stringify(content));
  }
  return 0;
}

function entryTokens(entry: TransportHistoryEntry): number {
  let tokens = 0;
  tokens += estimateContentTokens(entry.content);
  if (entry.toolCalls) {
    for (const tc of entry.toolCalls) {
      tokens += estimateTokens(tc.name) + estimateTokens(tc.arguments);
    }
  }
  if (entry.toolResults) {
    for (const tr of entry.toolResults) {
      tokens += estimateTokens(tr.name) + estimateTokens(tr.result);
    }
  }
  return tokens;
}

/**
 * A compacted summary of old turns.
 */
export interface CompactionSummary {
  readonly kind: "compacted";
  readonly summary: string;
  readonly turnCount: number;
  readonly tokenEstimate: number;
  /** The entries that were compacted (for audit). */
  readonly originalEntries: ReadonlyArray<TransportHistoryEntry>;
}

/**
 * Session memory state.
 */
export interface SessionMemory {
  /** Short-term: current conversation turns (rolling). */
  readonly recentTurns: ReadonlyArray<TransportHistoryEntry>;
  /** Compacted summaries of older turns. */
  readonly compactions: ReadonlyArray<CompactionSummary>;
  /** Total estimated tokens in memory. */
  readonly totalTokens: number;
  /** Token usage statistics across the session. */
  readonly usageStats: {
    readonly totalInputTokens: number;
    readonly totalOutputTokens: number;
    readonly totalCachedTokens: number;
    readonly turnCount: number;
  };
}

export interface ContextEngineConfig {
  readonly limits?: Partial<ModelContextLimits> | undefined;
  /** Minimum turns before compaction is allowed. */
  readonly minTurnsBeforeCompaction?: number | undefined;
  /** Maximum compaction summaries to keep. */
  readonly maxCompactions?: number | undefined;
}

export interface ContextEngineResult {
  /** Whether compaction was triggered. */
  readonly compacted: boolean;
  /** The history entries ready for the next LLM call. */
  readonly history: ReadonlyArray<TransportHistoryEntry>;
  /** Memory state. */
  readonly memory: SessionMemory;
}

/**
 * ContextEngine manages the context window for an agent session.
 */
export class ContextEngine {
  private readonly limits: ModelContextLimits;
  private readonly minTurnsBeforeCompaction: number;
  private readonly maxCompactions: number;
  private recentTurns: TransportHistoryEntry[] = [];
  private compactions: CompactionSummary[] = [];
  private totalInputTokens = 0;
  private totalOutputTokens = 0;
  private totalCachedTokens = 0;
  private turnCount = 0;

  constructor(config?: ContextEngineConfig) {
    const cfg = config ?? {};
    this.limits = { ...DEFAULT_LIMITS, ...cfg.limits };
    this.minTurnsBeforeCompaction = cfg.minTurnsBeforeCompaction ?? 3;
    this.maxCompactions = cfg.maxCompactions ?? 2;
  }

  /**
   * Record a completed turn's usage and append the entries.
   */
  recordTurn(entries: ReadonlyArray<TransportHistoryEntry>, usage?: TransportUsage): void {
    this.turnCount++;
    if (usage) {
      this.totalInputTokens += usage.inputTokens ?? 0;
      this.totalOutputTokens += usage.outputTokens ?? 0;
      this.totalCachedTokens += usage.cachedInputTokens ?? 0;
    }
    for (const entry of entries) {
      this.recentTurns.push(entry);
    }
  }

  /**
   * Build the history for the next LLM call.
   * Triggers compaction if the context window is likely to overflow.
   */
  buildHistory(systemPrompt?: string): ContextEngineResult {
    let compacted = false;

    // Check if compaction is needed
    if (this.turnCount >= this.minTurnsBeforeCompaction) {
      const totalTokens = this.estimateTotalTokens();
      const availableTokens =
        this.limits.maxContextTokens * (1 - this.limits.outputReserveFraction);

      if (totalTokens > availableTokens * 0.85) {
        compacted = this.compactOldestTurns(totalTokens, availableTokens);
      }
    }

    // Build final history
    const history: TransportHistoryEntry[] = [];

    // Add system prompt if provided
    if (systemPrompt) {
      history.push({ role: "system", content: systemPrompt });
    }

    // Add compaction summaries
    for (const compaction of this.compactions) {
      history.push({
        role: "user",
        content: `[Context of ${compaction.turnCount} earlier turns]: ${compaction.summary}`,
      });
    }

    // Add recent turns
    history.push(...this.recentTurns);

    return {
      compacted,
      history,
      memory: this.getMemory(),
    };
  }

  /**
   * Get current memory state.
   */
  getMemory(): SessionMemory {
    return {
      recentTurns: [...this.recentTurns],
      compactions: [...this.compactions],
      totalTokens: this.estimateTotalTokens(),
      usageStats: {
        totalInputTokens: this.totalInputTokens,
        totalOutputTokens: this.totalOutputTokens,
        totalCachedTokens: this.totalCachedTokens,
        turnCount: this.turnCount,
      },
    };
  }

  /**
   * Reset the engine for a new session.
   */
  reset(): void {
    this.recentTurns = [];
    this.compactions = [];
    this.totalInputTokens = 0;
    this.totalOutputTokens = 0;
    this.totalCachedTokens = 0;
    this.turnCount = 0;
  }

  /**
   * Get the system prompt token estimate.
   */
  systemPromptTokens(systemPrompt: string): number {
    return estimateTokens(systemPrompt);
  }

  private estimateTotalTokens(): number {
    let tokens = 0;
    for (const compaction of this.compactions) {
      tokens += compaction.tokenEstimate;
    }
    for (const turn of this.recentTurns) {
      tokens += entryTokens(turn);
    }
    return tokens;
  }

  /**
   * Compact the oldest turns by summarizing them.
   * Removes ~40% of old turns and replaces with a summary.
   */
  private compactOldestTurns(currentTokens: number, availableTokens: number): boolean {
    if (this.recentTurns.length < this.minTurnsBeforeCompaction) return false;

    // Find how many turns to compact (remove ~40% of recent turns)
    const turnsToCompact = Math.max(
      this.minTurnsBeforeCompaction,
      Math.floor(this.recentTurns.length * 0.4),
    );

    // Don't compact if we'd leave too few recent turns
    if (this.recentTurns.length - turnsToCompact < this.minTurnsBeforeCompaction) {
      return false;
    }

    const oldTurns = this.recentTurns.splice(0, turnsToCompact);
    const summaryTokens = Math.ceil(oldTurns.reduce((sum, t) => sum + entryTokens(t), 0) * 0.15);

    // Generate a compact summary
    const summaryParts: string[] = [];
    for (const turn of oldTurns) {
      if (turn.role === "assistant" && typeof turn.content === "string") {
        const firstLine = turn.content.split("\n")[0] ?? "";
        if (firstLine.length > 0) summaryParts.push(`Assistant: ${firstLine.substring(0, 100)}`);
      }
      if (turn.role === "tool" && turn.toolResults) {
        for (const tr of turn.toolResults) {
          const preview = tr.result.substring(0, 60).replace(/\n/g, " ");
          summaryParts.push(`Tool ${tr.name}: ${preview}`);
        }
      }
    }

    const summary =
      summaryParts.length > 0
        ? summaryParts.join("; ")
        : `${turnsToCompact} earlier turns (tool calls and responses)`;

    const compaction: CompactionSummary = {
      kind: "compacted",
      summary,
      turnCount: turnsToCompact,
      tokenEstimate: summaryTokens,
      originalEntries: oldTurns,
    };

    this.compactions.push(compaction);

    // Enforce max compactions
    if (this.compactions.length > this.maxCompactions) {
      this.compactions.shift();
    }

    return true;
  }
}
