// @effect-diagnostics globalDate:off

/**
 * Canonical Runtime Events — typed event system for the agent runtime.
 *
 * Provides structured, typed events for observability. Every significant
 * action in the agent runtime emits an event. Events are used for:
 * - Telemetry (phase 10)
 * - UI updates (streaming tool progress)
 * - Debugging and auditing
 *
 * @module agentRuntime/RuntimeEvents
 */
import { randomUUID } from "node:crypto";

/**
 * Base event interface. All runtime events extend this.
 */
export interface RuntimeEventBase {
  /** Unique event ID for correlation. */
  readonly eventId: string;
  /** ISO timestamp. */
  readonly timestamp: string;
  /** Session identifier. */
  readonly sessionId: string;
}

/** Agent loop started. */
export interface AgentLoopStartedEvent extends RuntimeEventBase {
  readonly kind: "agent-loop.started";
  readonly model: string;
  readonly toolCount: number;
}

/** Agent loop completed. */
export interface AgentLoopCompletedEvent extends RuntimeEventBase {
  readonly kind: "agent-loop.completed";
  readonly stopReason: string;
  readonly totalRounds: number;
  readonly totalToolCalls: number;
  readonly durationMs: number;
}

/** A round began. */
export interface RoundStartedEvent extends RuntimeEventBase {
  readonly kind: "round.started";
  readonly round: number;
}

/** LLM request sent. */
export interface LLMRequestEvent extends RuntimeEventBase {
  readonly kind: "llm.request";
  readonly model: string;
  readonly inputTokens: number | undefined;
  readonly hasTools: boolean;
}

/** LLM response received. */
export interface LLMResponseEvent extends RuntimeEventBase {
  readonly kind: "llm.response";
  readonly model: string;
  readonly outputTokens: number | undefined;
  readonly toolCallCount: number;
  readonly durationMs: number;
}

/** LLM error. */
export interface LLMErrorEvent extends RuntimeEventBase {
  readonly kind: "llm.error";
  readonly model: string;
  readonly error: string;
  readonly retryable: boolean;
  readonly attempt: number;
}

/** Text delta received (streaming). */
export interface TextDeltaEvent extends RuntimeEventBase {
  readonly kind: "text.delta";
  readonly delta: string;
}

/** Tool execution started. */
export interface ToolStartedEvent extends RuntimeEventBase {
  readonly kind: "tool.started";
  readonly toolId: string;
  readonly toolName: string;
  /** Whether this is an MCP tool. */
  readonly isMCP: boolean;
}

/** Tool execution completed. */
export interface ToolCompletedEvent extends RuntimeEventBase {
  readonly kind: "tool.completed";
  readonly toolId: string;
  readonly toolName: string;
  readonly success: boolean;
  readonly durationMs: number;
}

/** Compaction occurred. */
export interface CompactionEvent extends RuntimeEventBase {
  readonly kind: "context.compacted";
  readonly turnsCompacted: number;
  readonly summaryPreview: string;
}

/** Sub-agent spawned. */
export interface SubagentSpawnedEvent extends RuntimeEventBase {
  readonly kind: "subagent.spawned";
  readonly taskId: string;
  readonly promptPreview: string;
}

/** Sub-agent completed. */
export interface SubagentCompletedEvent extends RuntimeEventBase {
  readonly kind: "subagent.completed";
  readonly taskId: string;
  readonly success: boolean;
  readonly durationMs: number;
}

/** User interaction requested. */
export interface UserInteractionEvent extends RuntimeEventBase {
  readonly kind: "user.interaction";
  readonly questionCount: number;
}

/** Memory state changed. */
export interface MemoryStateEvent extends RuntimeEventBase {
  readonly kind: "memory.state";
  readonly recentTurns: number;
  readonly compactions: number;
  readonly estimatedTokens: number;
}

export type RuntimeEvent =
  | AgentLoopStartedEvent
  | AgentLoopCompletedEvent
  | RoundStartedEvent
  | LLMRequestEvent
  | LLMResponseEvent
  | LLMErrorEvent
  | TextDeltaEvent
  | ToolStartedEvent
  | ToolCompletedEvent
  | CompactionEvent
  | SubagentSpawnedEvent
  | SubagentCompletedEvent
  | UserInteractionEvent
  | MemoryStateEvent;

/**
 * Create a runtime event with auto-generated ID and timestamp.
 */
export function createEvent<K extends RuntimeEvent["kind"]>(
  kind: K,
  sessionId: string,
  data: Omit<Extract<RuntimeEvent, { kind: K }>, "eventId" | "timestamp" | "kind" | "sessionId">,
): Extract<RuntimeEvent, { kind: K }> {
  return {
    kind,
    eventId: `evt_${randomUUID()}`,
    timestamp: new Date().toISOString(),
    sessionId,
    ...data,
  } as Extract<RuntimeEvent, { kind: K }>;
}

/**
 * Event listener type.
 */
export type RuntimeEventListener = (event: RuntimeEvent) => void;

/**
 * EventEmitter for the agent runtime.
 * Collects listeners and dispatches events.
 */
export class RuntimeEventEmitter {
  private readonly listeners: Set<RuntimeEventListener> = new Set();
  private readonly eventLog: RuntimeEvent[] = [];
  private readonly maxLogSize: number;

  constructor(maxLogSize = 1000) {
    this.maxLogSize = maxLogSize;
  }

  /**
   * Add an event listener.
   */
  on(listener: RuntimeEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Emit an event to all listeners.
   */
  emit(event: RuntimeEvent): void {
    this.eventLog.push(event);
    if (this.eventLog.length > this.maxLogSize) {
      this.eventLog.shift();
    }
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (cause) {
        // Log listener errors to stderr for debugging
        process.stderr.write(
          `[RuntimeEvents] Listener error for ${event.kind}: ${String(cause)}\n`,
        );
      }
    }
  }

  /**
   * Get the event log for debugging.
   */
  getLog(): ReadonlyArray<RuntimeEvent> {
    return [...this.eventLog];
  }

  /**
   * Clear the event log.
   */
  clearLog(): void {
    this.eventLog.length = 0;
  }
}
