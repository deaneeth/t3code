// @effect-diagnostics globalDate:off

/**
 * TaskGraph — deterministic task state machine.
 *
 * The TaskGraph is the core state machine of the Agent Kernel.
 * It owns ALL task state deterministically — the LLM can reason
 * about it, but T3 records truth.
 *
 * Replaces the simple agent loop with a structured representation
 * of what the agent is actually doing.
 *
 * Features:
 * - Task nodes with dependencies, status, assigned agents
 * - DAG-based dependency resolution
 * - Status tracking with event emission
 * - Crash recovery from serialized state
 * - Execution provenance (who changed what, why)
 *
 * @module agentRuntime/kernel/TaskGraph
 */

import { randomUUID } from "node:crypto";

// ─── Task Status ───────────────────────────────────────────────

export type TaskStatus =
  | "pending" // Not yet started
  | "ready" // Dependencies satisfied, can begin
  | "running" // Currently being executed
  | "blocked" // Waiting on user input or external dependency
  | "validating" // Execution complete, validation in progress
  | "completed" // Successfully finished
  | "failed" // Execution failed
  | "skipped" // Skipped due to dependency failure
  | "cancelled"; // Explicitly cancelled

export type TaskPriority = "critical" | "high" | "normal" | "low";

// ─── Task Node ─────────────────────────────────────────────────

export interface TaskNode {
  /** Unique task identifier. */
  readonly id: string;
  /** Human-readable objective. */
  readonly objective: string;
  /** IDs of tasks this task depends on. */
  readonly dependencies: ReadonlyArray<string>;
  /** Current status. */
  status: TaskStatus;
  /** Priority level. */
  readonly priority: TaskPriority;
  /** Optional: which agent/worker is assigned. */
  assignedAgent?: string | undefined;
  /** Relevant context for this task (files, findings, etc). */
  relevantContext?: TaskContext | undefined;
  /** Validation criteria that must be met for completion. */
  validationCriteria?: ReadonlyArray<ValidationCriterion> | undefined;
  /** Outputs produced by this task. */
  outputs?: TaskOutputs | undefined;
  /** Retry policy if task fails. */
  retryPolicy?: RetryPolicy | undefined;
  /** Number of attempts made. */
  attemptCount: number;
  /** Maximum attempts allowed. */
  maxAttempts: number;
  /** Error message if failed. */
  error?: string | undefined;
  /** Timestamps. */
  readonly createdAt: string;
  startedAt?: string | undefined;
  completedAt?: string | undefined;
  /** Execution provenance. */
  provenance?: TaskProvenance | undefined;
}

export interface TaskContext {
  /** Files relevant to this task. */
  readonly relevantFiles: ReadonlyArray<string>;
  /** Findings discovered during investigation. */
  readonly findings: ReadonlyArray<string>;
  /** Hypotheses being tested. */
  readonly hypotheses: ReadonlyArray<string>;
  /** Current understanding of the problem. */
  readonly understanding: string;
}

export interface TaskOutputs {
  /** Files changed. */
  readonly changedFiles: ReadonlyArray<string>;
  /** Test results. */
  readonly testResults?: ValidationState | undefined;
  /** Diffs produced. */
  readonly diffs: ReadonlyArray<string>;
  /** Summary of what was done. */
  readonly summary: string;
}

export interface ValidationCriterion {
  /** Unique criterion identifier. */
  readonly id: string;
  /** Human-readable description. */
  readonly description: string;
  /** How to check this criterion. */
  readonly checkType: "test" | "typecheck" | "lint" | "build" | "manual" | "custom";
  /** Specific target (e.g., test file, package name). */
  readonly target?: string | undefined;
  /** Whether this criterion is required for completion. */
  readonly required: boolean;
  /** Current state. */
  state: "pending" | "passing" | "failing" | "skipped";
}

export interface RetryPolicy {
  /** Maximum retry attempts. */
  readonly maxRetries: number;
  /** Delay between retries in ms. */
  readonly delayMs: number;
  /** Whether to use exponential backoff. */
  readonly exponentialBackoff: boolean;
  /** Conditions that trigger a retry. */
  readonly retryOn: ReadonlyArray<"error" | "timeout" | "validation-failure">;
}

export interface TaskProvenance {
  /** Which model was used. */
  readonly model: string;
  /** Which agent/worker executed. */
  readonly agentId: string;
  /** Which turn this was part of. */
  readonly turnId: string;
  /** Tool calls made during this task. */
  readonly toolCallIds: ReadonlyArray<string>;
  /** Checkpoint before execution. */
  readonly checkpointBefore?: string | undefined;
  /** Checkpoint after execution. */
  readonly checkpointAfter?: string | undefined;
  /** Token usage for this task. */
  readonly tokensUsed: number;
  /** Wall time in ms. */
  readonly wallTimeMs: number;
}

// ─── Validation State ──────────────────────────────────────────

export interface ValidationState {
  readonly tests: "not-run" | "passing" | "failing" | "error";
  readonly typecheck: "not-run" | "passing" | "failing" | "error";
  readonly lint: "not-run" | "passing" | "failing" | "error";
  readonly build: "not-run" | "passing" | "failing" | "error";
  readonly format: "not-run" | "passing" | "failing" | "error";
}

// ─── Task Graph Events ─────────────────────────────────────────

export type TaskGraphEvent =
  | {
      readonly kind: "task.created";
      readonly taskId: string;
      readonly objective: string;
      readonly timestamp: string;
    }
  | {
      readonly kind: "task.statusChanged";
      readonly taskId: string;
      readonly from: TaskStatus;
      readonly to: TaskStatus;
      readonly timestamp: string;
    }
  | {
      readonly kind: "task.assigned";
      readonly taskId: string;
      readonly agentId: string;
      readonly timestamp: string;
    }
  | {
      readonly kind: "task.output";
      readonly taskId: string;
      readonly output: TaskOutputs;
      readonly timestamp: string;
    }
  | {
      readonly kind: "task.error";
      readonly taskId: string;
      readonly error: string;
      readonly timestamp: string;
    }
  | {
      readonly kind: "task.validated";
      readonly taskId: string;
      readonly state: ValidationState;
      readonly timestamp: string;
    }
  | { readonly kind: "graph.completed"; readonly timestamp: string }
  | { readonly kind: "graph.failed"; readonly reason: string; readonly timestamp: string };

// ─── Task Graph ────────────────────────────────────────────────

export interface TaskGraphSnapshot {
  readonly nodes: ReadonlyArray<TaskNode>;
  readonly events: ReadonlyArray<TaskGraphEvent>;
  readonly completedAt?: string | undefined;
}

export class TaskGraph {
  private readonly nodes = new Map<string, TaskNode>();
  private readonly events: TaskGraphEvent[] = [];
  private readonly eventListeners: Array<(event: TaskGraphEvent) => void> = [];

  /**
   * Subscribe to task graph events.
   */
  onEvent(listener: (event: TaskGraphEvent) => void): () => void {
    this.eventListeners.push(listener);
    return () => {
      const idx = this.eventListeners.indexOf(listener);
      if (idx >= 0) this.eventListeners.splice(idx, 1);
    };
  }

  /**
   * Create a new task node.
   */
  createTask(input: {
    readonly objective: string;
    readonly dependencies?: ReadonlyArray<string> | undefined;
    readonly priority?: TaskPriority | undefined;
    readonly validationCriteria?: ReadonlyArray<ValidationCriterion> | undefined;
    readonly retryPolicy?: RetryPolicy | undefined;
    readonly maxAttempts?: number | undefined;
  }): TaskNode {
    const id = `task_${randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();

    const node: TaskNode = {
      id,
      objective: input.objective,
      dependencies: input.dependencies ?? [],
      status: "pending",
      priority: input.priority ?? "normal",
      validationCriteria: input.validationCriteria,
      attemptCount: 0,
      maxAttempts: input.maxAttempts ?? 3,
      retryPolicy: input.retryPolicy ?? {
        maxRetries: 2,
        delayMs: 1000,
        exponentialBackoff: true,
        retryOn: ["error"],
      },
      createdAt: now,
    };

    this.nodes.set(id, node);
    this.emit({ kind: "task.created", taskId: id, objective: input.objective, timestamp: now });

    // Check if task is ready (no dependencies)
    if (node.dependencies.length === 0) {
      this.updateStatus(id, "ready");
    }

    return this.nodes.get(id)!;
  }

  /**
   * Get a task by ID.
   */
  getTask(taskId: string): TaskNode | undefined {
    return this.nodes.get(taskId);
  }

  /**
   * Get all tasks.
   */
  getAllTasks(): ReadonlyArray<TaskNode> {
    return [...this.nodes.values()];
  }

  /**
   * Get tasks that are ready to execute.
   */
  getReadyTasks(): ReadonlyArray<TaskNode> {
    return [...this.nodes.values()].filter((n) => n.status === "ready");
  }

  /**
   * Get tasks that are currently running.
   */
  getRunningTasks(): ReadonlyArray<TaskNode> {
    return [...this.nodes.values()].filter((n) => n.status === "running");
  }

  /**
   * Check if all tasks are in a terminal state.
   */
  isComplete(): boolean {
    const statuses = [...this.nodes.values()].map((n) => n.status);
    return (
      statuses.length > 0 &&
      statuses.every(
        (s) => s === "completed" || s === "failed" || s === "skipped" || s === "cancelled",
      )
    );
  }

  /**
   * Check if all tasks completed successfully.
   */
  isSuccess(): boolean {
    const statuses = [...this.nodes.values()].map((n) => n.status);
    return statuses.length > 0 && statuses.every((s) => s === "completed");
  }

  /**
   * Mark a task as running.
   */
  startTask(taskId: string, agentId?: string): void {
    const node = this.nodes.get(taskId);
    if (!node || node.status !== "ready") return;

    this.updateStatus(taskId, "running");
    node.startedAt = new Date().toISOString();
    node.attemptCount++;

    if (agentId) {
      node.assignedAgent = agentId;
      this.emit({ kind: "task.assigned", taskId, agentId, timestamp: new Date().toISOString() });
    }
  }

  /**
   * Mark a task as completed with outputs.
   */
  completeTask(taskId: string, outputs: TaskOutputs): void {
    const node = this.nodes.get(taskId);
    if (!node || (node.status !== "running" && node.status !== "validating")) return;

    node.outputs = outputs;
    node.completedAt = new Date().toISOString();
    this.updateStatus(taskId, "completed");
    this.emit({
      kind: "task.output",
      taskId,
      output: outputs,
      timestamp: new Date().toISOString(),
    });

    // Check if any dependent tasks are now ready
    this.checkDependencies();
  }

  /**
   * Mark a task as failed.
   */
  failTask(taskId: string, error: string): void {
    const node = this.nodes.get(taskId);
    if (!node) return;

    node.error = error;
    this.updateStatus(taskId, "failed");
    this.emit({ kind: "task.error", taskId, error, timestamp: new Date().toISOString() });

    // Skip dependent tasks
    this.skipDependents(taskId);
  }

  /**
   * Mark a task as blocked (waiting on user input).
   * Terminal states (completed/failed/skipped/cancelled) are left untouched.
   */
  blockTask(taskId: string): void {
    const node = this.nodes.get(taskId);
    if (!node || this.isTerminal(node.status)) return;
    this.updateStatus(taskId, "blocked");
  }

  /**
   * Attempt to retry a failed task.
   */
  retryTask(taskId: string): boolean {
    const node = this.nodes.get(taskId);
    if (!node || node.status !== "failed") return false;

    const policy = node.retryPolicy ?? {
      maxRetries: 2,
      delayMs: 1000,
      exponentialBackoff: true,
      retryOn: ["error"],
    };
    if (node.attemptCount >= node.maxAttempts || node.attemptCount > policy.maxRetries) {
      return false;
    }

    node.error = undefined;
    this.updateStatus(taskId, "ready");
    return true;
  }

  /**
   * Cancel a task.
   * Terminal states (completed/failed/skipped/cancelled) are left untouched.
   */
  cancelTask(taskId: string): void {
    const node = this.nodes.get(taskId);
    if (!node || this.isTerminal(node.status)) return;
    this.updateStatus(taskId, "cancelled");
  }

  /**
   * Set validation criteria for a task.
   */
  setValidationCriteria(taskId: string, criteria: ReadonlyArray<ValidationCriterion>): void {
    const node = this.nodes.get(taskId);
    if (!node) return;
    node.validationCriteria = criteria;
  }

  /**
   * Update validation state for a task.
   */
  updateValidation(taskId: string, state: ValidationState): void {
    const node = this.nodes.get(taskId);
    if (!node) return;
    node.outputs = {
      changedFiles: node.outputs?.changedFiles ?? [],
      diffs: node.outputs?.diffs ?? [],
      summary: node.outputs?.summary ?? "",
      testResults: state,
    };
    this.emit({ kind: "task.validated", taskId, state, timestamp: new Date().toISOString() });
  }

  /**
   * Set execution provenance for a task.
   */
  setProvenance(taskId: string, provenance: TaskProvenance): void {
    const node = this.nodes.get(taskId);
    if (!node) return;
    node.provenance = provenance;
  }

  /**
   * Serialize the graph for crash recovery.
   */
  serialize(): TaskGraphSnapshot {
    return {
      nodes: [...this.nodes.values()],
      events: [...this.events],
    };
  }

  /**
   * Restore from a serialized snapshot.
   */
  static restore(snapshot: TaskGraphSnapshot): TaskGraph {
    const graph = new TaskGraph();
    for (const node of snapshot.nodes) {
      // Restore the node with its original status intact
      graph.nodes.set(node.id, { ...node });
    }
    // Replay events without re-emitting (preserve original timestamps)
    graph.events.push(...snapshot.events);
    return graph;
  }

  // ─── Private ───────────────────────────────────────────────

  private isTerminal(status: TaskStatus): boolean {
    return (
      status === "completed" ||
      status === "failed" ||
      status === "skipped" ||
      status === "cancelled"
    );
  }

  private updateStatus(taskId: string, to: TaskStatus): void {
    const node = this.nodes.get(taskId);
    if (!node) return;
    const from = node.status;
    if (from === to) return;
    node.status = to;
    this.emit({
      kind: "task.statusChanged",
      taskId,
      from,
      to,
      timestamp: new Date().toISOString(),
    });

    // Check graph completion
    if (
      this.isComplete() &&
      !this.events.some(
        (event) => event.kind === "graph.completed" || event.kind === "graph.failed",
      )
    ) {
      const success = this.isSuccess();
      this.emit({
        kind: success ? "graph.completed" : "graph.failed",
        reason: success ? "All tasks completed" : "One or more tasks failed",
        timestamp: new Date().toISOString(),
      });
    }
  }

  private checkDependencies(): void {
    for (const node of this.nodes.values()) {
      if (node.status !== "pending") continue;
      const depsSatisfied = node.dependencies.every((depId) => {
        const dep = this.nodes.get(depId);
        return dep?.status === "completed";
      });
      if (depsSatisfied) {
        this.updateStatus(node.id, "ready");
      }
    }
  }

  private skipDependents(taskId: string, visited = new Set<string>()): void {
    if (visited.has(taskId)) return;
    visited.add(taskId);
    for (const node of this.nodes.values()) {
      if (node.status === "pending" && node.dependencies.includes(taskId)) {
        this.updateStatus(node.id, "skipped");
        this.skipDependents(node.id, visited);
      }
    }
  }

  private emit(event: TaskGraphEvent): void {
    this.events.push(event);
    for (const listener of this.eventListeners) {
      try {
        listener(event);
      } catch {
        process.stderr.write(`[TaskGraph] Listener error: ${event.kind}\n`);
      }
    }
  }
}
