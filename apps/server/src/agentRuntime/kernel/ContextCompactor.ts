/**
 * ContextCompactor — automatic context window management.
 *
 * When context usage exceeds thresholds, compact old content:
 * - < 75%: normal
 * - 75-85%: remove stale tool results
 * - 85-92%: compress old tool outputs + history
 * - > 92%: create compact working summary
 *
 * @module agentRuntime/kernel/ContextCompactor
 */

import type { TransportHistoryEntry, TransportUsage } from "../transport/LLMTransport.ts";

export interface CompactionConfig {
  /** Maximum context tokens. */
  readonly maxContextTokens: number;
  /** Fraction to reserve for output. */
  readonly outputReserveFraction: number;
  /** Thresholds for compaction levels. */
  readonly thresholds: {
    readonly normal: number;
    readonly removeStale: number;
    readonly compress: number;
    readonly summarize: number;
  };
}

const DEFAULT_CONFIG: CompactionConfig = {
  maxContextTokens: 128_000,
  outputReserveFraction: 0.25,
  thresholds: {
    normal: 0.6,
    removeStale: 0.75,
    compress: 0.85,
    summarize: 0.92,
  },
};

export interface CompactionResult {
  /** The compacted history. */
  readonly history: ReadonlyArray<TransportHistoryEntry>;
  /** The compaction level applied. */
  readonly level: "none" | "remove-stale" | "compress" | "summarize";
  /** How many tokens were saved. */
  readonly tokensSaved: number;
  /** Summary of what was done. */
  readonly summary: string;
}

/**
 * Estimate tokens from text (~4 chars/token).
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Estimate tokens from a history entry.
 */
function entryTokens(entry: TransportHistoryEntry): number {
  let tokens = 0;
  if (typeof entry.content === "string") {
    tokens += estimateTokens(entry.content);
  } else if (Array.isArray(entry.content)) {
    tokens += estimateTokens(JSON.stringify(entry.content));
  }
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

export class ContextCompactor {
  private readonly config: CompactionConfig;

  constructor(config?: Partial<CompactionConfig>) {
    this.config = {
      maxContextTokens: config?.maxContextTokens ?? DEFAULT_CONFIG.maxContextTokens,
      outputReserveFraction: config?.outputReserveFraction ?? DEFAULT_CONFIG.outputReserveFraction,
      thresholds: {
        ...DEFAULT_CONFIG.thresholds,
        ...config?.thresholds,
      },
    };
  }

  /**
   * Check if compaction is needed and apply it.
   */
  compact(history: ReadonlyArray<TransportHistoryEntry>): CompactionResult {
    const budget = this.config.maxContextTokens * (1 - this.config.outputReserveFraction);
    const totalTokens = history.reduce((sum, h) => sum + entryTokens(h), 0);
    const usage = totalTokens / budget;

    if (usage < this.config.thresholds.normal) {
      return {
        history,
        level: "none",
        tokensSaved: 0,
        summary: "Context usage normal, no compaction needed",
      };
    }

    if (usage < this.config.thresholds.removeStale) {
      return this.removeStaleToolResults(history, totalTokens, budget);
    }

    if (usage < this.config.thresholds.compress) {
      return this.compressHistory(history, totalTokens, budget);
    }

    return this.summarizeHistory(history, totalTokens, budget);
  }

  /**
   * Level 1: Remove old tool results (keep last N).
   */
  private removeStaleToolResults(
    history: ReadonlyArray<TransportHistoryEntry>,
    totalTokens: number,
    budget: number,
  ): CompactionResult {
    const keepLast = 5; // Keep last 5 tool results
    const compacted: TransportHistoryEntry[] = [];
    let toolResultCount = 0;
    let savedTokens = 0;

    // Iterate in reverse to keep recent results
    for (let i = history.length - 1; i >= 0; i--) {
      const entry = history[i]!;
      if (entry.role === "tool") {
        toolResultCount++;
        if (toolResultCount > keepLast) {
          savedTokens += entryTokens(entry);
          continue; // Skip old tool results
        }
      }
      compacted.unshift(entry);
    }

    return {
      history: compacted,
      level: "remove-stale",
      tokensSaved: savedTokens,
      summary: `Removed ${Math.max(0, toolResultCount - keepLast)} stale tool results, saved ~${savedTokens} tokens`,
    };
  }

  /**
   * Level 2: Compress old tool outputs and history.
   */
  private compressHistory(
    history: ReadonlyArray<TransportHistoryEntry>,
    totalTokens: number,
    budget: number,
  ): CompactionResult {
    const compacted: TransportHistoryEntry[] = [];
    let savedTokens = 0;
    let compressedCount = 0;
    const cutoffIndex = Math.floor(history.length * 0.3); // Keep last 70% intact

    for (let i = 0; i < history.length; i++) {
      const entry = history[i]!;

      if (i < cutoffIndex && entry.role === "tool" && entry.toolResults) {
        // Compress old tool results to just a summary
        const compressed: TransportHistoryEntry = {
          role: entry.role,
          content: entry.content,
          toolCalls: entry.toolCalls,
          toolResults: entry.toolResults.map((tr) => ({
            ...tr,
            result: `[Compressed: ${tr.result.length} chars]`,
          })),
          options: entry.options,
        };
        compressedCount++;
        savedTokens += entryTokens(entry) - entryTokens(compressed);
        compacted.push(compressed);
      } else if (
        i < cutoffIndex &&
        typeof entry.content === "string" &&
        entry.content.length > 1000
      ) {
        // Compress long messages
        const compressed: TransportHistoryEntry = {
          role: entry.role,
          content: entry.content.slice(0, 500) + "\n... [compressed] ...",
          toolCalls: entry.toolCalls,
          toolResults: entry.toolResults,
          options: entry.options,
        };
        compressedCount++;
        savedTokens += entryTokens(entry) - entryTokens(compressed);
        compacted.push(compressed);
      } else {
        compacted.push(entry);
      }
    }

    const finalSaved = Math.max(0, savedTokens);
    return {
      history: compacted,
      level: "compress",
      tokensSaved: finalSaved,
      summary:
        compressedCount > 0
          ? `Compressed ${compressedCount} old entries, saved ~${finalSaved} tokens`
          : `History within budget after compress pass, saved ~${finalSaved} tokens`,
    };
  }

  /**
   * Level 3: Summarize everything into a compact summary.
   */
  private summarizeHistory(
    history: ReadonlyArray<TransportHistoryEntry>,
    totalTokens: number,
    budget: number,
  ): CompactionResult {
    // Create a summary entry
    const summaryParts: string[] = ["[Context compacted — previous history summarized]"];

    // Extract key information
    const toolCalls = history.filter((h) => h.toolCalls?.length);
    const userMessages = history.filter((h) => h.role === "user");
    const assistantMessages = history.filter((h) => h.role === "assistant");

    if (userMessages.length > 0) {
      const lastUser = userMessages[userMessages.length - 1];
      if (lastUser) {
        summaryParts.push(
          `Last user request: ${typeof lastUser.content === "string" ? lastUser.content.slice(0, 200) : "complex content"}`,
        );
      }
    }

    if (toolCalls.length > 0) {
      summaryParts.push(`Tools used: ${toolCalls.length} tool calls`);
    }

    if (assistantMessages.length > 0) {
      const lastAssistant = assistantMessages[assistantMessages.length - 1];
      if (lastAssistant) {
        summaryParts.push(
          `Last response: ${typeof lastAssistant.content === "string" ? lastAssistant.content.slice(0, 200) : "complex content"}`,
        );
      }
    }

    const summaryEntry: TransportHistoryEntry = {
      role: "system",
      content: summaryParts.join("\n"),
    };

    // Keep only the last few entries
    const recentHistory = history.slice(-3);
    const compacted = [summaryEntry, ...recentHistory];

    const savedTokens = Math.max(
      0,
      totalTokens - compacted.reduce((s, h) => s + entryTokens(h), 0),
    );

    return {
      history: compacted,
      level: "summarize",
      tokensSaved: savedTokens,
      summary: `Summarized ${history.length} entries into compact summary, saved ~${savedTokens} tokens`,
    };
  }
}
