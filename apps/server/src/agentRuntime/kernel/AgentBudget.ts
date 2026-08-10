// @effect-diagnostics globalDate:off

/**
 * AgentBudget — cost, turn, and token limits.
 *
 * Prevents runaway spending and runaway agents.
 * Before each model call, the kernel checks budget.
 * If exceeded, the kernel stops gracefully.
 *
 * @module agentRuntime/kernel/AgentBudget
 */

export interface BudgetLimits {
  /** Maximum total cost in USD. */
  maxCostUsd: number;
  /** Maximum number of turns (user-to-model cycles). */
  maxTurns: number;
  /** Maximum total tokens across all calls. */
  maxTokens: number;
  /** Maximum tool calls per session. */
  maxToolCalls: number;
  /** Maximum subagents spawned. */
  maxSubagents: number;
  /** Maximum file changes. */
  maxFileChanges: number;
  /** Timeout in ms (0 = no timeout). */
  timeoutMs: number;
}

export interface BudgetUsage {
  costUsd: number;
  turns: number;
  tokens: { input: number; output: number; cached: number };
  toolCalls: number;
  subagents: number;
  fileChanges: number;
  elapsedMs: number;
}

export type BudgetExceededReason =
  | "cost"
  | "turns"
  | "tokens"
  | "toolCalls"
  | "subagents"
  | "fileChanges"
  | "timeout";

export interface BudgetCheck {
  allowed: boolean;
  exceeded?: BudgetExceededReason | undefined;
  usage: BudgetUsage;
  remaining: {
    costUsd: number;
    turns: number;
    tokens: number;
    toolCalls: number;
    subagents: number;
    fileChanges: number;
    timeMs: number;
  };
  warnings: string[];
}

const DEFAULT_LIMITS: BudgetLimits = {
  maxCostUsd: 1.0,
  maxTurns: 30,
  maxTokens: 1_000_000,
  maxToolCalls: 100,
  maxSubagents: 5,
  maxFileChanges: 50,
  timeoutMs: 30 * 60 * 1000, // 30 minutes
};

export class AgentBudget {
  private readonly limits: BudgetLimits;
  private readonly usage: BudgetUsage;
  private readonly startTime: number;
  private readonly warnings: string[] = [];

  constructor(limits?: Partial<BudgetLimits>) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    this.startTime = Date.now();
    this.usage = {
      costUsd: 0,
      turns: 0,
      tokens: { input: 0, output: 0, cached: 0 },
      toolCalls: 0,
      subagents: 0,
      fileChanges: 0,
      elapsedMs: 0,
    };
  }

  /**
   * Check if an action is allowed within budget.
   */
  check(): BudgetCheck {
    this.usage.elapsedMs = Date.now() - this.startTime;
    const remaining = this.computeRemaining();
    const warnings = this.checkWarnings();

    // Check limits
    if (this.usage.costUsd >= this.limits.maxCostUsd) {
      return { allowed: false, exceeded: "cost", usage: { ...this.usage }, remaining, warnings };
    }
    if (this.usage.turns >= this.limits.maxTurns) {
      return { allowed: false, exceeded: "turns", usage: { ...this.usage }, remaining, warnings };
    }
    if (this.totalTokens() >= this.limits.maxTokens) {
      return { allowed: false, exceeded: "tokens", usage: { ...this.usage }, remaining, warnings };
    }
    if (this.usage.toolCalls >= this.limits.maxToolCalls) {
      return {
        allowed: false,
        exceeded: "toolCalls",
        usage: { ...this.usage },
        remaining,
        warnings,
      };
    }
    if (this.usage.subagents >= this.limits.maxSubagents) {
      return {
        allowed: false,
        exceeded: "subagents",
        usage: { ...this.usage },
        remaining,
        warnings,
      };
    }
    if (this.usage.fileChanges >= this.limits.maxFileChanges) {
      return {
        allowed: false,
        exceeded: "fileChanges",
        usage: { ...this.usage },
        remaining,
        warnings,
      };
    }
    if (this.limits.timeoutMs > 0 && this.usage.elapsedMs >= this.limits.timeoutMs) {
      return { allowed: false, exceeded: "timeout", usage: { ...this.usage }, remaining, warnings };
    }

    return { allowed: true, usage: { ...this.usage }, remaining, warnings };
  }

  /**
   * Record a model call's token usage.
   */
  recordModelCall(
    inputTokens: number,
    outputTokens: number,
    cachedTokens: number,
    costUsd: number,
  ): void {
    this.usage.tokens.input += inputTokens;
    this.usage.tokens.output += outputTokens;
    this.usage.tokens.cached += cachedTokens;
    this.usage.costUsd += costUsd;
    this.usage.turns++;
  }

  /**
   * Record a tool call.
   */
  recordToolCall(): void {
    this.usage.toolCalls++;
  }

  /**
   * Record a file change.
   */
  recordFileChange(): void {
    this.usage.fileChanges++;
  }

  /**
   * Record a subagent spawn.
   */
  recordSubagent(): void {
    this.usage.subagents++;
  }

  /**
   * Get current usage snapshot.
   */
  getUsage(): Readonly<BudgetUsage> {
    this.usage.elapsedMs = Date.now() - this.startTime;
    return { ...this.usage };
  }

  /**
   * Get limits.
   */
  getLimits(): Readonly<BudgetLimits> {
    return { ...this.limits };
  }

  /**
   * Get budget status summary.
   */
  getStatus(): string {
    const usage = this.getUsage();
    const remaining = this.computeRemaining();
    const totalTok = this.totalTokens();
    return [
      `Cost: $${usage.costUsd.toFixed(4)} / $${this.limits.maxCostUsd} (${remaining.costUsd.toFixed(4)} left)`,
      `Turns: ${usage.turns} / ${this.limits.maxTurns} (${remaining.turns} left)`,
      `Tokens: ${totalTok} / ${this.limits.maxTokens} (${remaining.tokens} left)`,
      `Tool calls: ${usage.toolCalls} / ${this.limits.maxToolCalls} (${remaining.toolCalls} left)`,
      `Files changed: ${usage.fileChanges} / ${this.limits.maxFileChanges} (${remaining.fileChanges} left)`,
      `Time: ${(usage.elapsedMs / 1000).toFixed(0)}s / ${(this.limits.timeoutMs / 1000).toFixed(0)}s`,
    ].join("\n");
  }

  private totalTokens(): number {
    // cached tokens are a subset of input tokens, don't double-count
    return this.usage.tokens.input + this.usage.tokens.output;
  }

  private computeRemaining(): BudgetCheck["remaining"] {
    const totalTok = this.totalTokens();
    const timeMs =
      this.limits.timeoutMs > 0
        ? Math.max(0, this.limits.timeoutMs - this.usage.elapsedMs)
        : Infinity;

    return {
      costUsd: Math.max(0, this.limits.maxCostUsd - this.usage.costUsd),
      turns: Math.max(0, this.limits.maxTurns - this.usage.turns),
      tokens: Math.max(0, this.limits.maxTokens - totalTok),
      toolCalls: Math.max(0, this.limits.maxToolCalls - this.usage.toolCalls),
      subagents: Math.max(0, this.limits.maxSubagents - this.usage.subagents),
      fileChanges: Math.max(0, this.limits.maxFileChanges - this.usage.fileChanges),
      timeMs,
    };
  }

  private checkWarnings(): string[] {
    const warnings: string[] = [];
    const usage = this.usage;

    if (this.limits.maxCostUsd > 0 && usage.costUsd > this.limits.maxCostUsd * 0.8) {
      warnings.push(
        `Cost at ${Math.min(100, (usage.costUsd / this.limits.maxCostUsd) * 100).toFixed(0)}% of limit`,
      );
    }
    if (this.limits.maxTurns > 0 && usage.turns > this.limits.maxTurns * 0.8) {
      warnings.push(
        `Turns at ${Math.min(100, (usage.turns / this.limits.maxTurns) * 100).toFixed(0)}% of limit`,
      );
    }
    if (this.limits.maxTokens > 0 && this.totalTokens() > this.limits.maxTokens * 0.8) {
      warnings.push(
        `Tokens at ${Math.min(100, (this.totalTokens() / this.limits.maxTokens) * 100).toFixed(0)}% of limit`,
      );
    }

    return warnings;
  }
}
