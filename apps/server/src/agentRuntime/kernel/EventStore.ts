// @effect-diagnostics globalDate:off

/**
 * EventStore — event sourcing for the Agent Kernel.
 *
 * Every significant action in the kernel is recorded as an event.
 * Current state is derived from events, not stored in mutable variables.
 *
 * Benefits: crash recovery, resume, debugging, replay, telemetry,
 * A/B testing, UI synchronization.
 *
 * @module agentRuntime/kernel/EventStore
 */

import { randomUUID } from "node:crypto";

// ─── Event Types ───────────────────────────────────────────────

export type KernelEventKind =
  | "turn.started"
  | "turn.completed"
  | "turn.failed"
  | "task.created"
  | "task.started"
  | "task.completed"
  | "task.failed"
  | "task.validated"
  | "plan.created"
  | "plan.updated"
  | "tool.requested"
  | "tool.started"
  | "tool.completed"
  | "tool.failed"
  | "approval.requested"
  | "approval.granted"
  | "approval.denied"
  | "file.changed"
  | "test.started"
  | "test.completed"
  | "validation.started"
  | "validation.completed"
  | "subagent.spawned"
  | "subagent.completed"
  | "context.compacted"
  | "context.compiled"
  | "usage.recorded"
  | "error.recorded"
  | "checkpoint.created"
  | "checkpoint.restored"
  | "recovery.started"
  | "recovery.completed";

export interface KernelEvent {
  readonly id: string;
  readonly kind: KernelEventKind;
  readonly timestamp: string;
  readonly sessionId: string;
  readonly taskId?: string | undefined;
  readonly data: Record<string, unknown>;
}

// ─── Derived State ─────────────────────────────────────────────

export interface SessionState {
  readonly sessionId: string;
  readonly startTime: string;
  readonly lastEventTime: string;
  readonly turnCount: number;
  readonly totalToolCalls: number;
  readonly totalModelCalls: number;
  readonly totalTokens: {
    readonly input: number;
    readonly output: number;
    readonly cached: number;
  };
  readonly totalCostUsd: number;
  readonly activeTasks: ReadonlyArray<string>;
  readonly completedTasks: ReadonlyArray<string>;
  readonly failedTasks: ReadonlyArray<string>;
  readonly changedFiles: ReadonlyArray<string>;
  readonly isComplete: boolean;
}

// ─── Event Store ───────────────────────────────────────────────

export class EventStore {
  private readonly events: KernelEvent[] = [];
  private readonly eventListeners: Array<(event: KernelEvent) => void> = [];
  private readonly sessionId: string;

  constructor(sessionId?: string) {
    this.sessionId = sessionId ?? `session_${randomUUID().slice(0, 8)}`;
  }

  /**
   * Record an event.
   */
  record(kind: KernelEventKind, data: Record<string, unknown>, taskId?: string): KernelEvent {
    const event: KernelEvent = {
      id: `evt_${randomUUID().slice(0, 8)}`,
      kind,
      timestamp: new Date().toISOString(),
      sessionId: this.sessionId,
      taskId,
      data,
    };

    this.events.push(event);
    this.notifyListeners(event);
    return event;
  }

  /**
   * Subscribe to events.
   */
  onEvent(listener: (event: KernelEvent) => void): () => void {
    this.eventListeners.push(listener);
    return () => {
      const idx = this.eventListeners.indexOf(listener);
      if (idx >= 0) this.eventListeners.splice(idx, 1);
    };
  }

  /**
   * Get all events.
   */
  getEvents(): ReadonlyArray<KernelEvent> {
    return [...this.events];
  }

  /**
   * Get events for a specific task.
   */
  getTaskEvents(taskId: string): ReadonlyArray<KernelEvent> {
    return this.events.filter((e) => e.taskId === taskId);
  }

  /**
   * Get events of a specific kind.
   */
  getEventsByKind(kind: KernelEventKind): ReadonlyArray<KernelEvent> {
    return this.events.filter((e) => e.kind === kind);
  }

  /**
   * Derive current session state from events.
   */
  deriveState(): SessionState {
    let turnCount = 0;
    let totalToolCalls = 0;
    let totalModelCalls = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let cachedTokens = 0;
    let totalCostUsd = 0;
    const activeTasks = new Set<string>();
    const completedTasks = new Set<string>();
    const failedTasks = new Set<string>();
    const changedFiles = new Set<string>();

    for (const event of this.events) {
      switch (event.kind) {
        case "turn.started":
          turnCount++;
          break;
        case "tool.requested":
          totalToolCalls++;
          break;
        case "context.compiled":
          totalModelCalls++;
          break;
        case "task.started":
          if (event.taskId) activeTasks.add(event.taskId);
          break;
        case "task.completed":
          if (event.taskId) {
            activeTasks.delete(event.taskId);
            completedTasks.add(event.taskId);
          }
          break;
        case "task.failed":
          if (event.taskId) {
            activeTasks.delete(event.taskId);
            failedTasks.add(event.taskId);
          }
          break;
        case "file.changed":
          if (typeof event.data.path === "string") changedFiles.add(event.data.path);
          break;
        case "usage.recorded":
          inputTokens += typeof event.data.inputTokens === "number" ? event.data.inputTokens : 0;
          outputTokens += typeof event.data.outputTokens === "number" ? event.data.outputTokens : 0;
          cachedTokens += typeof event.data.cachedTokens === "number" ? event.data.cachedTokens : 0;
          totalCostUsd += typeof event.data.costUsd === "number" ? event.data.costUsd : 0;
          break;
      }
    }

    const lastEvent = this.events[this.events.length - 1];

    return {
      sessionId: this.sessionId,
      startTime: this.events[0]?.timestamp ?? new Date().toISOString(),
      lastEventTime: lastEvent?.timestamp ?? new Date().toISOString(),
      turnCount,
      totalToolCalls,
      totalModelCalls,
      totalTokens: { input: inputTokens, output: outputTokens, cached: cachedTokens },
      totalCostUsd,
      activeTasks: [...activeTasks],
      completedTasks: [...completedTasks],
      failedTasks: [...failedTasks],
      changedFiles: [...changedFiles],
      isComplete: activeTasks.size === 0 && this.events.some((e) => e.kind === "turn.completed"),
    };
  }

  /**
   * Serialize for persistence (crash recovery).
   */
  serialize(): string {
    return JSON.stringify({
      sessionId: this.sessionId,
      events: this.events,
    });
  }

  /**
   * Restore from serialized state.
   */
  static restore(data: string): EventStore {
    const parsed = JSON.parse(data) as { sessionId: string; events: KernelEvent[] };
    const store = new EventStore(parsed.sessionId);
    // Inject events with their original timestamps preserved
    store.events.push(...parsed.events);
    return store;
  }

  /**
   * Inject an event with a specific timestamp (for restore operations).
   * @internal
   */
  injectEvent(event: KernelEvent): void {
    this.events.push(event);
  }

  /**
   * Get a human-readable summary of session activity.
   */
  getSummary(): string {
    const state = this.deriveState();
    const lines: string[] = [
      `Session: ${state.sessionId}`,
      `Duration: ${state.startTime} → ${state.lastEventTime}`,
      `Turns: ${state.turnCount}`,
      `Model calls: ${state.totalModelCalls}`,
      `Tool calls: ${state.totalToolCalls}`,
      `Tokens: ${state.totalTokens.input} in / ${state.totalTokens.output} out / ${state.totalTokens.cached} cached`,
      `Cost: $${state.totalCostUsd.toFixed(4)}`,
      `Tasks: ${state.completedTasks.length} completed, ${state.failedTasks.length} failed, ${state.activeTasks.length} active`,
      `Files changed: ${state.changedFiles.length}`,
    ];
    return lines.join("\n");
  }

  private notifyListeners(event: KernelEvent): void {
    for (const listener of this.eventListeners) {
      try {
        listener(event);
      } catch {
        process.stderr.write(`[EventStore] Listener error: ${event.kind}\n`);
      }
    }
  }
}
