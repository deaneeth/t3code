// @effect-diagnostics globalDate:off

/**
 * Telemetry — metrics collection for the agent runtime.
 *
 * Collects structured metrics for monitoring agent behavior:
 * - Token usage per session/turn/model
 * - Tool call counts and latencies
 * - Error rates and types
 * - Compaction events
 * - Sub-agent execution stats
 *
 * @module agentRuntime/Telemetry
 */
import type { RuntimeEvent, RuntimeEventListener } from "./RuntimeEvents.ts";
import type { TransportUsage } from "./transport/LLMTransport.ts";

export interface TelemetryMetrics {
  readonly sessionId: string;
  readonly startTime: string;
  readonly endTime: string | undefined;
  readonly totalTokens: TransportUsage;
  readonly toolCalls: ReadonlyArray<{
    readonly toolId: string;
    readonly count: number;
    readonly successCount: number;
    readonly totalDurationMs: number;
  }>;
  readonly rounds: number;
  readonly errors: ReadonlyArray<{
    readonly kind: string;
    readonly message: string;
    readonly timestamp: string;
  }>;
  readonly compactions: number;
  readonly subagents: number;
}

interface ToolMetric {
  count: number;
  successCount: number;
  totalDurationMs: number;
}

interface ErrorRecord {
  kind: string;
  message: string;
  timestamp: string;
}

/**
 * TelemetryCollector listens to RuntimeEvents and accumulates metrics.
 */
export class TelemetryCollector {
  private readonly sessionId: string;
  private readonly startTime: string;
  private inputTokens = 0;
  private outputTokens = 0;
  private cachedTokens = 0;
  private reasoningTokens = 0;
  private costUsd = 0;
  private toolMetrics = new Map<string, ToolMetric>();
  private errors: ErrorRecord[] = [];
  private rounds = 0;
  private compactions = 0;
  private subagents = 0;
  private endTime: string | undefined;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
    this.startTime = new Date().toISOString();
  }

  /**
   * Returns a RuntimeEventListener that can be registered with RuntimeEventEmitter.
   */
  createListener(): RuntimeEventListener {
    return (event) => {
      if (event.sessionId !== this.sessionId) return;
      this.processEvent(event);
    };
  }

  /**
   * Get the collected metrics.
   */
  getMetrics(): TelemetryMetrics {
    return {
      sessionId: this.sessionId,
      startTime: this.startTime,
      endTime: this.endTime,
      totalTokens: {
        inputTokens: this.inputTokens,
        cachedInputTokens: this.cachedTokens,
        outputTokens: this.outputTokens,
        reasoningOutputTokens: this.reasoningTokens,
        providerCostUsd: this.costUsd,
      },
      toolCalls: [...this.toolMetrics.entries()].map(([toolId, m]) => ({
        toolId,
        count: m.count,
        successCount: m.successCount,
        totalDurationMs: m.totalDurationMs,
      })),
      rounds: this.rounds,
      errors: [...this.errors],
      compactions: this.compactions,
      subagents: this.subagents,
    };
  }

  /**
   * Mark the session as ended.
   */
  markEnded(): void {
    this.endTime = new Date().toISOString();
  }

  private processEvent(event: RuntimeEvent): void {
    switch (event.kind) {
      case "agent-loop.started":
        break;
      case "agent-loop.completed":
        this.markEnded();
        break;
      case "round.started":
        this.rounds = Math.max(this.rounds, event.round);
        break;
      case "llm.response": {
        // Accumulate tokens from response
        if (event.outputTokens) this.outputTokens += event.outputTokens;
        break;
      }
      case "llm.error":
        this.errors.push({
          kind: "llm",
          message: event.error,
          timestamp: event.timestamp,
        });
        break;
      case "tool.started": {
        const existing = this.toolMetrics.get(event.toolId);
        if (existing) {
          existing.count++;
        } else {
          this.toolMetrics.set(event.toolId, {
            count: 1,
            successCount: 0,
            totalDurationMs: 0,
          });
        }
        break;
      }
      case "tool.completed": {
        const metric = this.toolMetrics.get(event.toolId);
        if (metric) {
          if (event.success) metric.successCount++;
          metric.totalDurationMs += event.durationMs;
        }
        break;
      }
      case "context.compacted":
        this.compactions++;
        break;
      case "subagent.spawned":
        this.subagents++;
        break;
      case "memory.state":
        // Track token usage from memory state
        break;
    }
  }
}

/**
 * Create a telemetry summary string for debugging.
 */
export function formatTelemetrySummary(metrics: TelemetryMetrics): string {
  const lines: string[] = [
    `Session: ${metrics.sessionId}`,
    `Duration: ${metrics.startTime} → ${metrics.endTime ?? "active"}`,
    `Rounds: ${metrics.rounds}`,
    `Tokens: ${metrics.totalTokens.inputTokens ?? 0} input, ${metrics.totalTokens.outputTokens ?? 0} output, ${metrics.totalTokens.cachedInputTokens ?? 0} cached`,
    `Cost: $${(metrics.totalTokens.providerCostUsd ?? 0).toFixed(4)}`,
    `Compactions: ${metrics.compactions}`,
    `Subagents: ${metrics.subagents}`,
  ];

  if (metrics.toolCalls.length > 0) {
    lines.push("Tool usage:");
    for (const tc of metrics.toolCalls) {
      lines.push(
        `  ${tc.toolId}: ${tc.count} calls (${tc.successCount} success), ${tc.totalDurationMs}ms total`,
      );
    }
  }

  if (metrics.errors.length > 0) {
    lines.push(`Errors: ${metrics.errors.length}`);
    for (const err of metrics.errors.slice(-5)) {
      lines.push(`  [${err.kind}] ${err.message.substring(0, 80)}`);
    }
  }

  return lines.join("\n");
}
