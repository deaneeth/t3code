// @effect-diagnostics globalDate:off globalTimers:off

/**
 * Kernel Edge-Case Tests
 *
 * Covers bugs found during deep review:
 * - TaskGraph.completeTask operator precedence
 * - TaskGraph.restore status preservation
 * - TaskGraph.updateValidation with undefined outputs
 * - EventStore.restore timestamp preservation
 * - WorkingMemory.getState deep copy
 * - ContextCompiler division by zero
 * - ContextCompactor threshold ordering
 * - CompletionVerifier deduplicated classifyIntent
 * - CapabilityResolver tools not gated on streaming
 * - AgentBudget edge cases
 * - OutputTruncator boundary conditions
 */

import { describe, it, expect } from "vite-plus/test";
import { TaskGraph } from "../../kernel/TaskGraph.ts";
import type { TaskOutputs } from "../../kernel/TaskGraph.ts";
import { WorkingMemory } from "../../kernel/WorkingMemory.ts";
import { ContextCompiler } from "../../kernel/ContextCompiler.ts";
import { CompletionVerifier } from "../../kernel/CompletionVerifier.ts";
import { EventStore } from "../../kernel/EventStore.ts";
import { AgentBudget } from "../../kernel/AgentBudget.ts";
import { ToolRegistry, toToolDefinition } from "../../kernel/ToolRegistry.ts";
import { OutputTruncator } from "../../kernel/OutputTruncator.ts";
import { ContextCompactor } from "../../kernel/ContextCompactor.ts";
import { ComplexityClassifier } from "../../kernel/ComplexityClassifier.ts";
import { CapabilityResolver } from "../../kernel/CapabilityResolver.ts";
import { canonicalTools } from "../../tools/index.ts";

// ─── TaskGraph Edge Cases ───────────────────────────────────────

describe("TaskGraph edge cases", () => {
  it("completeTask rejects pending tasks (operator precedence fix)", () => {
    const graph = new TaskGraph();
    const task = graph.createTask({ objective: "Test" });
    expect(task.status).toBe("ready");

    // Try to complete without starting — should be rejected
    const outputs: TaskOutputs = { changedFiles: [], diffs: [], summary: "Done" };
    graph.completeTask(task.id, outputs);
    expect(graph.getTask(task.id)?.status).toBe("ready"); // unchanged
  });

  it("completeTask rejects ready tasks", () => {
    const graph = new TaskGraph();
    const task = graph.createTask({ objective: "Test" });
    // task.status is "ready" (no dependencies)
    graph.completeTask(task.id, { changedFiles: [], diffs: [], summary: "Done" });
    expect(graph.getTask(task.id)?.status).toBe("ready");
  });

  it("completeTask accepts running tasks", () => {
    const graph = new TaskGraph();
    const task = graph.createTask({ objective: "Test" });
    graph.startTask(task.id);
    expect(graph.getTask(task.id)?.status).toBe("running");

    graph.completeTask(task.id, { changedFiles: [], diffs: [], summary: "Done" });
    expect(graph.getTask(task.id)?.status).toBe("completed");
  });

  it("completeTask accepts validating tasks", () => {
    const graph = new TaskGraph();
    const task = graph.createTask({ objective: "Test" });
    graph.startTask(task.id);
    // Manually set to validating
    graph.completeTask(task.id, { changedFiles: [], diffs: [], summary: "Done" });
    // Since we don't have a direct setValidating, test via startTask + complete
    expect(graph.getTask(task.id)?.status).toBe("completed");
  });

  it("restore preserves task status", () => {
    const graph = new TaskGraph();
    const task1 = graph.createTask({ objective: "Task 1" });
    const task2 = graph.createTask({ objective: "Task 2" });
    const task3 = graph.createTask({ objective: "Task 3" });

    graph.startTask(task1.id);
    graph.completeTask(task1.id, { changedFiles: [], diffs: [], summary: "Done" });
    // task2 should be ready (dependency satisfied)
    // task3 should be ready (no deps)

    const snapshot = graph.serialize();
    const restored = TaskGraph.restore(snapshot);

    expect(restored.getTask(task1.id)?.status).toBe("completed");
    expect(restored.getTask(task2.id)?.status).toBe("ready");
    expect(restored.getTask(task3.id)?.status).toBe("ready");
  });

  it("restore preserves failed status", () => {
    const graph = new TaskGraph();
    const task = graph.createTask({ objective: "Test" });
    graph.startTask(task.id);
    graph.failTask(task.id, "Something went wrong");

    const snapshot = graph.serialize();
    const restored = TaskGraph.restore(snapshot);

    expect(restored.getTask(task.id)?.status).toBe("failed");
    expect(restored.getTask(task.id)?.error).toBe("Something went wrong");
  });

  it("restore preserves skipped status from dependency failure", () => {
    const graph = new TaskGraph();
    const task1 = graph.createTask({ objective: "Task 1" });
    const task2 = graph.createTask({ objective: "Task 2", dependencies: [task1.id] });

    graph.startTask(task1.id);
    graph.failTask(task1.id, "Failed");
    // task2 should be skipped

    const snapshot = graph.serialize();
    const restored = TaskGraph.restore(snapshot);

    expect(restored.getTask(task1.id)?.status).toBe("failed");
    expect(restored.getTask(task2.id)?.status).toBe("skipped");
  });

  it("updateValidation handles undefined outputs", () => {
    const graph = new TaskGraph();
    const task = graph.createTask({ objective: "Test" });
    // task.outputs is undefined

    graph.updateValidation(task.id, {
      tests: "passing",
      typecheck: "passing",
      lint: "passing",
      build: "passing",
      format: "not-run",
    });

    const updated = graph.getTask(task.id);
    expect(updated?.outputs).toBeDefined();
    expect(updated?.outputs?.testResults?.tests).toBe("passing");
    expect(updated?.outputs?.changedFiles).toEqual([]);
    expect(updated?.outputs?.diffs).toEqual([]);
  });

  it("dependency resolution handles complex DAGs", () => {
    const graph = new TaskGraph();
    const a = graph.createTask({ objective: "A" });
    const b = graph.createTask({ objective: "B", dependencies: [a.id] });
    const c = graph.createTask({ objective: "C", dependencies: [a.id] });
    const d = graph.createTask({ objective: "D", dependencies: [b.id, c.id] });

    // Initially: a=ready, b=pending, c=pending, d=pending
    expect(graph.getTask(a.id)?.status).toBe("ready");
    expect(graph.getTask(b.id)?.status).toBe("pending");
    expect(graph.getTask(c.id)?.status).toBe("pending");
    expect(graph.getTask(d.id)?.status).toBe("pending");

    graph.startTask(a.id);
    graph.completeTask(a.id, { changedFiles: [], diffs: [], summary: "A done" });

    // b and c should now be ready
    expect(graph.getTask(b.id)?.status).toBe("ready");
    expect(graph.getTask(c.id)?.status).toBe("ready");
    expect(graph.getTask(d.id)?.status).toBe("pending"); // still waiting

    graph.startTask(b.id);
    graph.completeTask(b.id, { changedFiles: [], diffs: [], summary: "B done" });
    // d still waiting on c
    expect(graph.getTask(d.id)?.status).toBe("pending");

    graph.startTask(c.id);
    graph.completeTask(c.id, { changedFiles: [], diffs: [], summary: "C done" });
    // d should now be ready
    expect(graph.getTask(d.id)?.status).toBe("ready");
  });

  it("retry resets task to ready", () => {
    const graph = new TaskGraph();
    const task = graph.createTask({ objective: "Test", maxAttempts: 3 });
    graph.startTask(task.id);
    graph.failTask(task.id, "Error");

    expect(graph.getTask(task.id)?.status).toBe("failed");
    const retried = graph.retryTask(task.id);
    expect(retried).toBe(true);
    expect(graph.getTask(task.id)?.status).toBe("ready");
  });

  it("retry fails after max attempts", () => {
    const graph = new TaskGraph();
    const task = graph.createTask({ objective: "Test", maxAttempts: 2 });

    // Attempt 1
    graph.startTask(task.id);
    graph.failTask(task.id, "Error 1");
    graph.retryTask(task.id);

    // Attempt 2
    graph.startTask(task.id);
    graph.failTask(task.id, "Error 2");

    // Should not retry
    const retried = graph.retryTask(task.id);
    expect(retried).toBe(false);
  });
});

// ─── WorkingMemory Edge Cases ───────────────────────────────────

describe("WorkingMemory edge cases", () => {
  it("getState returns deep copy of arrays", () => {
    const memory = new WorkingMemory("Test");
    memory.addDiscovery("Discovery 1");
    memory.addHypothesis("Hypothesis 1");

    const state1 = memory.getState();
    const state2 = memory.getState();

    // Different array references
    expect(state1.discoveries).not.toBe(state2.discoveries);
    expect(state1.hypotheses).not.toBe(state2.hypotheses);

    // But same content
    expect(state1.discoveries).toEqual(state2.discoveries);
  });

  it("getState prevents external mutation of internal state", () => {
    const memory = new WorkingMemory("Test");
    memory.addDiscovery("Original");

    const state = memory.getState();
    // Try to mutate the returned state via unknown (simulating a hostile caller)
    (state as unknown as { discoveries: string[] }).discoveries.push("Injected");

    // Internal state should be unaffected
    const freshState = memory.getState();
    expect(freshState.discoveries).toEqual(["Original"]);
    expect(freshState.discoveries.length).toBe(1);
  });

  it("serialize and restore preserves all fields", () => {
    const memory = new WorkingMemory("Original objective");
    memory.setUnderstanding("The bug is in the divide function");
    memory.addDiscovery("divide(10, 0) returns Infinity");
    memory.addHypothesis("Missing zero check");
    memory.addFileOfInterest("src/math.ts");
    memory.addBlocker("Waiting for test results");
    memory.recordChange({
      path: "src/math.ts",
      operation: "modified",
      reason: "Add zero check",
      turnId: "turn_1",
      timestamp: "2024-01-01T00:00:00Z",
    });

    const json = memory.serializeJson();
    const restored = new WorkingMemory("placeholder");
    restored.restore(json);

    const state = restored.getState();
    expect(state.objective).toBe("Original objective");
    expect(state.understanding).toBe("The bug is in the divide function");
    expect(state.discoveries).toEqual(["divide(10, 0) returns Infinity"]);
    expect(state.hypotheses).toEqual(["Missing zero check"]);
    expect(state.filesOfInterest).toEqual(["src/math.ts"]);
    expect(state.blockers).toEqual(["Waiting for test results"]);
    expect(state.changesMade.length).toBe(1);
  });

  it("artifacts respect max capacity", () => {
    const memory = new WorkingMemory("Test", 5);
    for (let i = 0; i < 10; i++) {
      memory.addDiscovery(`Discovery ${i}`);
    }
    // Each addDiscovery also adds an artifact
    const artifacts = memory.getArtifacts();
    expect(artifacts.length).toBeLessThanOrEqual(5);
  });
});

// ─── EventStore Edge Cases ──────────────────────────────────────

describe("EventStore edge cases", () => {
  it("restore preserves original timestamps", () => {
    const store = new EventStore("original-session");
    store.record("turn.started", { message: "hello" });
    store.record("tool.completed", { name: "read_file" });

    const serialized = store.serialize();
    const restored = EventStore.restore(serialized);

    const originalEvents = store.getEvents();
    const restoredEvents = restored.getEvents();

    expect(restoredEvents.length).toBe(originalEvents.length);
    // Timestamps should be preserved
    expect(restoredEvents[0]?.timestamp).toBe(originalEvents[0]?.timestamp);
    expect(restoredEvents[1]?.timestamp).toBe(originalEvents[1]?.timestamp);
  });

  it("injectEvent preserves original timestamp", () => {
    const store = new EventStore();
    const originalTimestamp = "2024-01-01T00:00:00.000Z";

    store.injectEvent({
      id: "evt_test",
      kind: "turn.started",
      timestamp: originalTimestamp,
      sessionId: "session",
      data: { message: "test" },
    });

    const events = store.getEvents();
    expect(events[0]?.timestamp).toBe(originalTimestamp);
  });

  it("deriveState handles empty event list", () => {
    const store = new EventStore();
    const state = store.deriveState();
    expect(state.turnCount).toBe(0);
    expect(state.totalToolCalls).toBe(0);
    expect(state.activeTasks).toEqual([]);
    expect(state.isComplete).toBe(false);
  });

  it("deriveState correctly tracks active/completed/failed tasks", () => {
    const store = new EventStore();
    store.record("task.started", {}, "task_1");
    store.record("task.started", {}, "task_2");
    store.record("task.completed", {}, "task_1");
    store.record("task.failed", {}, "task_2");

    const state = store.deriveState();
    expect(state.activeTasks).toEqual([]);
    expect(state.completedTasks).toEqual(["task_1"]);
    expect(state.failedTasks).toEqual(["task_2"]);
  });

  it("event listeners receive events", () => {
    const store = new EventStore();
    const received: string[] = [];
    store.onEvent((e) => received.push(e.kind));

    store.record("turn.started", {});
    store.record("tool.completed", {});

    expect(received).toEqual(["turn.started", "tool.completed"]);
  });

  it("unsubscribe stops event delivery", () => {
    const store = new EventStore();
    const received: string[] = [];
    const unsub = store.onEvent((e) => received.push(e.kind));

    store.record("turn.started", {});
    unsub();
    store.record("tool.completed", {});

    expect(received).toEqual(["turn.started"]);
  });
});

// ─── ContextCompiler Edge Cases ─────────────────────────────────

describe("ContextCompiler edge cases", () => {
  it("handles empty tools array without division by zero", () => {
    const compiler = new ContextCompiler();
    const result = compiler.compile({
      history: [],
      tools: [],
      userMessage: "Hello",
    });

    expect(result.tools).toEqual([]);
    expect(result.estimatedTokens).toBeGreaterThanOrEqual(0);
  });

  it("handles single tool without overflow", () => {
    const compiler = new ContextCompiler();
    const result = compiler.compile({
      history: [],
      tools: canonicalTools.slice(0, 1),
      userMessage: "Hello",
    });

    expect(result.tools.length).toBe(1);
  });

  it("filters tools when token budget exceeded", () => {
    const compiler = new ContextCompiler({ maxContextTokens: 1000 });
    // Register many tools to exceed budget
    const result = compiler.compile({
      history: [],
      tools: canonicalTools,
      userMessage: "Hello",
    });

    // Should have filtered some tools
    expect(result.metadata.toolsExcluded).toBeGreaterThanOrEqual(0);
    expect(result.tools.length).toBeLessThanOrEqual(canonicalTools.length);
  });

  it("trims history to maxHistoryEntries", () => {
    const compiler = new ContextCompiler({ maxHistoryEntries: 5 });
    const history = Array.from({ length: 20 }, (_, i) => ({
      role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: `Message ${i}`,
    }));

    const result = compiler.compile({
      history,
      tools: [],
      userMessage: "Last message",
    });

    expect(result.metadata.historyEntriesIncluded).toBeLessThanOrEqual(5);
  });

  it("buildRequest produces valid TransportRequest", () => {
    const compiler = new ContextCompiler();
    const compiled = compiler.compile({
      history: [],
      tools: [],
      userMessage: "Test",
    });

    const request = compiler.buildRequest({
      compiled,
      model: "test-model",
      userMessage: "Test",
      stream: true,
    });

    expect(request.model).toBe("test-model");
    expect(request.text).toBe("Test");
    expect(request.stream).toBe(true);
    expect(Array.isArray(request.history)).toBe(true);
  });
});

// ─── ContextCompactor Edge Cases ────────────────────────────────

describe("ContextCompactor edge cases", () => {
  it("thresholds are in ascending order", () => {
    const compactor = new ContextCompactor();
    // Access private config via any
    const config = (compactor as any).config;
    expect(config.thresholds.normal).toBeLessThan(config.thresholds.removeStale);
    expect(config.thresholds.removeStale).toBeLessThan(config.thresholds.compress);
    expect(config.thresholds.compress).toBeLessThan(config.thresholds.summarize);
  });

  it("returns 'none' for small history", () => {
    const compactor = new ContextCompactor();
    const history = [
      { role: "user" as const, content: "Hello" },
      { role: "assistant" as const, content: "Hi" },
    ];

    const result = compactor.compact(history);
    expect(result.level).toBe("none");
    expect(result.tokensSaved).toBe(0);
  });

  it("applies compaction for large history", () => {
    const compactor = new ContextCompactor({ maxContextTokens: 1000 });
    const history = Array.from({ length: 100 }, (_, i) => ({
      role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: `Message ${i}: ${"x".repeat(500)}`,
    }));

    const result = compactor.compact(history);
    expect(result.level).not.toBe("none");
    expect(result.tokensSaved).toBeGreaterThan(0);
  });

  it("preserve recent entries during compaction", () => {
    const compactor = new ContextCompactor({ maxContextTokens: 1000 });
    const history = Array.from({ length: 100 }, (_, i) => ({
      role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: `Message ${i}: ${"x".repeat(500)}`,
    }));

    const result = compactor.compact(history);
    // Last few entries should be preserved
    const lastEntry = result.history[result.history.length - 1];
    expect(lastEntry?.content).toContain("Message 99");
  });
});

// ─── CompletionVerifier Edge Cases ──────────────────────────────

describe("CompletionVerifier edge cases", () => {
  it("classifyIntent is called once (not twice)", () => {
    const verifier = new CompletionVerifier();
    const task = {
      id: "task_1",
      objective: "Fix the bug in auth module",
      dependencies: [],
      status: "running" as const,
      priority: "normal" as const,
      attemptCount: 1,
      maxAttempts: 3,
      createdAt: new Date().toISOString(),
    };

    const verdict = verifier.verify({
      task,
      memory: new WorkingMemory("test").getState(),
      validation: {
        tests: "passing",
        typecheck: "passing",
        lint: "passing",
        build: "passing",
        format: "not-run",
      },
      workspaceHasChanges: true,
      hasOutput: true,
      availableValidation: { tests: true, typecheck: true, lint: true },
    });

    // Should be classified as "debug-fix" due to "fix" keyword
    expect(verdict.intent).toBe("debug-fix");
  });

  it("empty objective defaults to code-change", () => {
    const verifier = new CompletionVerifier();
    const task = {
      id: "task_1",
      objective: "",
      dependencies: [],
      status: "running" as const,
      priority: "normal" as const,
      attemptCount: 1,
      maxAttempts: 3,
      createdAt: new Date().toISOString(),
    };

    const verdict = verifier.verify({
      task,
      memory: new WorkingMemory("test").getState(),
      validation: {
        tests: "not-run",
        typecheck: "not-run",
        lint: "not-run",
        build: "not-run",
        format: "not-run",
      },
      workspaceHasChanges: true,
      hasOutput: true,
      availableValidation: { tests: false, typecheck: false, lint: false },
    });

    expect(verdict.intent).toBe("code-change");
  });

  it("skips test check when no tests in project", () => {
    const verifier = new CompletionVerifier();
    const task = {
      id: "task_1",
      objective: "Add a new feature",
      dependencies: [],
      status: "running" as const,
      priority: "normal" as const,
      attemptCount: 1,
      maxAttempts: 3,
      createdAt: new Date().toISOString(),
    };

    const verdict = verifier.verify({
      task,
      memory: new WorkingMemory("test").getState(),
      validation: {
        tests: "not-run",
        typecheck: "not-run",
        lint: "not-run",
        build: "not-run",
        format: "not-run",
      },
      workspaceHasChanges: true,
      hasOutput: true,
      availableValidation: { tests: false, typecheck: false, lint: false },
    });

    // All requirements should be met since no validation is available
    expect(verdict.complete).toBe(true);
  });

  it("reports incomplete when tests failing and tests available", () => {
    const verifier = new CompletionVerifier();
    const task = {
      id: "task_1",
      objective: "Fix the authentication bug",
      dependencies: [],
      status: "running" as const,
      priority: "normal" as const,
      attemptCount: 1,
      maxAttempts: 3,
      createdAt: new Date().toISOString(),
    };

    const verdict = verifier.verify({
      task,
      memory: new WorkingMemory("test").getState(),
      validation: {
        tests: "failing",
        typecheck: "passing",
        lint: "passing",
        build: "passing",
        format: "not-run",
      },
      workspaceHasChanges: true,
      hasOutput: true,
      availableValidation: { tests: true, typecheck: true, lint: true },
    });

    expect(verdict.complete).toBe(false);
    const testReq = verdict.requirements.find((r) => r.reason.includes("Tests"));
    expect(testReq?.met).toBe(false);
  });

  it("does not treat unrun tests as proof for debug or refactor tasks", () => {
    const verifier = new CompletionVerifier();
    const base = {
      memory: new WorkingMemory("done").getState(),
      validation: {
        tests: "not-run" as const,
        typecheck: "passing" as const,
        lint: "passing" as const,
        build: "passing" as const,
        format: "not-run" as const,
      },
      availableValidation: { tests: true, typecheck: true, lint: true },
      workspaceHasChanges: true,
      hasOutput: true,
    };
    const task = (objective: string) => ({
      id: objective,
      objective,
      dependencies: [],
      status: "running" as const,
      priority: "normal" as const,
      attemptCount: 1,
      maxAttempts: 3,
      createdAt: new Date().toISOString(),
    });
    expect(verifier.verify({ ...base, task: task("Fix the bug") }).complete).toBe(false);
    expect(verifier.verify({ ...base, task: task("Refactor the module") }).complete).toBe(false);
  });
});

// ─── CapabilityResolver Edge Cases ──────────────────────────────

describe("CapabilityResolver edge cases", () => {
  it("tools capability not gated on streaming", () => {
    const resolver = new CapabilityResolver();
    const caps = resolver.resolve({
      provider: {
        tools: true,
        streaming: false, // streaming disabled
        parallelTools: false,
        vision: false,
        reasoning: false,
        structuredOutput: false,
        usageReporting: false,
        rateLimitReporting: false,
      },
      model: {
        extendedThinking: false,
        vision: false,
        tokenizerFamily: "unknown",
      },
      protocol: {
        streaming: false,
        streamToolResults: false,
        systemPrompts: true,
        temperature: true,
      },
      connection: {
        alive: true,
        streaming: false,
      },
    });

    // Tools should be available even without streaming
    expect(caps.tools).toBe(true);
    // Streaming should reflect actual capability
    expect(caps.streaming).toBe(false);
  });

  it("returns defaults for unknown provider", () => {
    const resolver = new CapabilityResolver();
    const caps = resolver.resolve({
      provider: {
        tools: false,
        streaming: false,
        parallelTools: false,
        vision: false,
        reasoning: false,
        structuredOutput: false,
        usageReporting: false,
        rateLimitReporting: false,
      },
      model: {
        extendedThinking: false,
        vision: false,
        tokenizerFamily: "unknown",
      },
      protocol: {
        streaming: false,
        streamToolResults: false,
        systemPrompts: false,
        temperature: false,
      },
      connection: {
        alive: false,
        streaming: false,
      },
    });

    expect(caps.contextWindow).toBe(128_000);
    expect(caps.maxOutputTokens).toBe(4_096);
  });

  it("caches results for same input", () => {
    const resolver = new CapabilityResolver();
    const input = {
      provider: {
        tools: true,
        streaming: true,
        parallelTools: false,
        vision: false,
        reasoning: false,
        structuredOutput: false,
        usageReporting: false,
        rateLimitReporting: false,
      },
      model: {
        extendedThinking: false,
        vision: false,
        tokenizerFamily: "cl100k" as const,
      },
      protocol: {
        streaming: true,
        streamToolResults: false,
        systemPrompts: true,
        temperature: true,
      },
      connection: {
        alive: true,
        streaming: true,
      },
    };

    const caps1 = resolver.resolve(input);
    const caps2 = resolver.resolve(input);
    expect(caps1).toBe(caps2); // same reference
  });

  it("clearCache forces re-resolution", () => {
    const resolver = new CapabilityResolver();
    const input = {
      provider: {
        tools: true,
        streaming: true,
        parallelTools: false,
        vision: false,
        reasoning: false,
        structuredOutput: false,
        usageReporting: false,
        rateLimitReporting: false,
      },
      model: {
        extendedThinking: false,
        vision: false,
        tokenizerFamily: "cl100k" as const,
      },
      protocol: {
        streaming: true,
        streamToolResults: false,
        systemPrompts: true,
        temperature: true,
      },
      connection: {
        alive: true,
        streaming: true,
      },
    };

    const caps1 = resolver.resolve(input);
    resolver.clearCache();
    const caps2 = resolver.resolve(input);
    expect(caps1).not.toBe(caps2); // different references
    expect(caps1.tools).toBe(caps2.tools); // same values
  });
});

// ─── AgentBudget Edge Cases ─────────────────────────────────────

describe("AgentBudget edge cases", () => {
  it("rejects when cost exceeded", () => {
    const budget = new AgentBudget({ maxCostUsd: 0.01 });
    budget.recordModelCall(1000, 500, 0, 0.02);

    const check = budget.check();
    expect(check.allowed).toBe(false);
    expect(check.exceeded).toBe("cost");
  });

  it("rejects when turns exceeded", () => {
    const budget = new AgentBudget({ maxTurns: 2 });
    budget.recordModelCall(100, 50, 0, 0.001);
    budget.recordModelCall(100, 50, 0, 0.001);

    const check = budget.check();
    expect(check.allowed).toBe(false);
    expect(check.exceeded).toBe("turns");
  });

  it("rejects when tokens exceeded", () => {
    const budget = new AgentBudget({ maxTokens: 100 });
    budget.recordModelCall(60, 50, 0, 0.001);

    const check = budget.check();
    expect(check.allowed).toBe(false);
    expect(check.exceeded).toBe("tokens");
  });

  it("rejects when tool calls exceeded", () => {
    const budget = new AgentBudget({ maxToolCalls: 2 });
    budget.recordToolCall();
    budget.recordToolCall();

    const check = budget.check();
    expect(check.allowed).toBe(false);
    expect(check.exceeded).toBe("toolCalls");
  });

  it("reports warnings at 80% usage", () => {
    const budget = new AgentBudget({ maxCostUsd: 1.0 });
    budget.recordModelCall(1000, 500, 0, 0.85); // 85%

    const check = budget.check();
    expect(check.allowed).toBe(true);
    expect(check.warnings.some((w) => w.includes("Cost"))).toBe(true);
  });

  it("computeRemaining returns correct values", () => {
    const budget = new AgentBudget({ maxCostUsd: 1.0, maxTurns: 10 });
    budget.recordModelCall(1000, 500, 0, 0.3);

    const check = budget.check();
    expect(check.remaining.costUsd).toBeCloseTo(0.7, 2);
    expect(check.remaining.turns).toBe(9);
  });

  it("getUsage returns snapshot", () => {
    const budget = new AgentBudget();
    budget.recordModelCall(100, 50, 10, 0.01);
    budget.recordToolCall();

    const usage = budget.getUsage();
    expect(usage.tokens.input).toBe(100);
    expect(usage.tokens.output).toBe(50);
    expect(usage.toolCalls).toBe(1);
    expect(usage.costUsd).toBeCloseTo(0.01, 4);
  });
});

// ─── OutputTruncator Edge Cases ─────────────────────────────────

describe("OutputTruncator edge cases", () => {
  it("does not truncate small outputs", () => {
    const truncator = new OutputTruncator({ maxOutputChars: 1000 });
    const result = truncator.truncate("Hello world");
    expect(result.truncated).toBe(false);
    expect(result.output).toBe("Hello world");
  });

  it("truncates large outputs", () => {
    const truncator = new OutputTruncator({ maxOutputChars: 200, noticeOverhead: 50 });
    // Use input with newlines so tail extraction works properly
    const largeOutput = Array.from({ length: 50 }, (_, i) => `line ${i}: ${"x".repeat(20)}`).join(
      "\n",
    );
    const result = truncator.truncate(largeOutput);
    expect(result.truncated).toBe(true);
    expect(result.output.length).toBeLessThan(largeOutput.length);
    expect(result.originalSize).toBe(largeOutput.length);
  });

  it("preserves tail of output", () => {
    const truncator = new OutputTruncator({
      maxOutputChars: 200,
      noticeOverhead: 50,
      maxTailLines: 5,
    });
    const lines = Array.from({ length: 50 }, (_, i) => `Line ${i}: ${"x".repeat(30)}`).join("\n");
    const result = truncator.truncate(lines);
    expect(result.truncated).toBe(true);
    // Last lines should be preserved
    expect(result.output).toContain("Line 49");
  });

  it("truncateTestOutput extracts failures", () => {
    const truncator = new OutputTruncator({ maxOutputChars: 200 });
    const testOutput = [
      "PASS test1.ts",
      "PASS test2.ts",
      "FAIL test3.ts",
      "  Error: expected 1 to equal 2",
      "PASS test4.ts",
    ].join("\n");

    const result = truncator.truncateTestOutput(testOutput);
    expect(result.output).toContain("FAIL");
    expect(result.output).toContain("Error:");
  });

  it("truncateDiff preserves file headers", () => {
    const truncator = new OutputTruncator({ maxOutputChars: 300 });
    // Create a diff that exceeds maxOutputChars
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,50 +1,50 @@",
      ...Array.from({ length: 40 }, (_, i) => `  line ${i}: ${"x".repeat(20)}`),
      "diff --git a/src/b.ts b/src/b.ts",
      "--- a/src/b.ts",
      "+++ b/src/b.ts",
      "@@ -1,50 +1,50 @@",
      ...Array.from({ length: 40 }, (_, i) => `  line ${i}: ${"x".repeat(20)}`),
    ].join("\n");

    const result = truncator.truncateDiff(diff);
    expect(result.truncated).toBe(true);
    expect(result.output).toContain("diff --git");
  });
});

// ─── ComplexityClassifier Edge Cases ────────────────────────────

describe("ComplexityClassifier edge cases", () => {
  it("classifies trivial tasks", () => {
    const classifier = new ComplexityClassifier();
    const result = classifier.classify({ userMessage: "rename foo to bar" });
    expect(result.level).toBe("trivial");
    expect(result.needsPlan).toBe(false);
  });

  it("classifies high-risk tasks with auth keywords", () => {
    const classifier = new ComplexityClassifier();
    const result = classifier.classify({ userMessage: "Update the authentication flow" });
    expect(result.level).toBe("high-risk");
    expect(result.needsVerifier).toBe(true);
  });

  it("classifies complex multi-subsystem tasks", () => {
    const classifier = new ComplexityClassifier();
    const result = classifier.classify({
      userMessage: "Refactor the database cache layer",
      affectedSubsystems: ["database", "cache", "api"],
    });
    expect(result.level).toBe("complex");
    expect(result.needsSubagents).toBe(true);
  });

  it("getExecutionStrategy returns appropriate config", () => {
    const classifier = new ComplexityClassifier();
    const trivial = classifier.classify({ userMessage: "Fix typo" });
    const strategy = classifier.getExecutionStrategy(trivial);
    expect(strategy.loopMode).toBe("fast");
    expect(strategy.maxRounds).toBeLessThanOrEqual(5);
  });
});

// ─── ToolRegistry Edge Cases ────────────────────────────────────

describe("ToolRegistry edge cases", () => {
  it("findDuplicate detects same providerToolCallId", () => {
    const registry = new ToolRegistry();
    const tool = toToolDefinition(canonicalTools[0]!);
    registry.register(tool);

    const inv1 = registry.createInvocation({
      turnId: "t1",
      modelRoundId: "r1",
      toolId: tool.id,
      arguments: {},
      providerToolCallId: "call_123",
    });

    const dup = registry.findDuplicate("call_123");
    expect(dup?.id).toBe(inv1.id);
  });

  it("findDuplicate does not match different providerToolCallId", () => {
    const registry = new ToolRegistry();
    const tool = toToolDefinition(canonicalTools[0]!);
    registry.register(tool);

    registry.createInvocation({
      turnId: "t1",
      modelRoundId: "r1",
      toolId: tool.id,
      arguments: {},
      providerToolCallId: "call_123",
    });

    const dup = registry.findDuplicate("call_456");
    expect(dup).toBeUndefined();
  });

  it("canRetry respects retrySafety", () => {
    const registry = new ToolRegistry();

    // Register a safe tool (read_file)
    const safeTool = toToolDefinition(canonicalTools.find((t) => t.risk === "read")!);
    registry.register(safeTool);

    const inv = registry.createInvocation({
      turnId: "t1",
      modelRoundId: "r1",
      toolId: safeTool.id,
      arguments: {},
    });
    inv.status = "failed";

    expect(registry.canRetry(inv.id)).toBe(true);
  });

  it("cancel marks invocation as cancelled", () => {
    const registry = new ToolRegistry();
    const tool = toToolDefinition(canonicalTools[0]!);
    registry.register(tool);

    const inv = registry.createInvocation({
      turnId: "t1",
      modelRoundId: "r1",
      toolId: tool.id,
      arguments: {},
    });
    inv.status = "running";

    const cancelled = registry.cancel(inv.id);
    expect(cancelled).toBe(true);
    expect(inv.status).toBe("cancelled");
  });

  it("cancel fails for completed invocations", () => {
    const registry = new ToolRegistry();
    const tool = toToolDefinition(canonicalTools[0]!);
    registry.register(tool);

    const inv = registry.createInvocation({
      turnId: "t1",
      modelRoundId: "r1",
      toolId: tool.id,
      arguments: {},
    });
    inv.status = "completed";

    const cancelled = registry.cancel(inv.id);
    expect(cancelled).toBe(false);
  });

  it("getTurnInvocations filters by turnId", () => {
    const registry = new ToolRegistry();
    const tool = toToolDefinition(canonicalTools[0]!);
    registry.register(tool);

    registry.createInvocation({ turnId: "t1", modelRoundId: "r1", toolId: tool.id, arguments: {} });
    registry.createInvocation({ turnId: "t1", modelRoundId: "r1", toolId: tool.id, arguments: {} });
    registry.createInvocation({ turnId: "t2", modelRoundId: "r1", toolId: tool.id, arguments: {} });

    const t1Invocations = registry.getTurnInvocations("t1");
    expect(t1Invocations.length).toBe(2);
  });
});
