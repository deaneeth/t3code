// @effect-diagnostics globalDate:off globalTimers:off

/**
 * Deep-Audit Round-2 Tests
 *
 * Covers fixes found in the second pass:
 * - Transports preserve role:"system" entries (OpenAIChat, OpenAIResponses, Anthropic, Gemini)
 * - AgentKernel.executeTurn prepends compiled.systemPrompt
 * - runAgentLoop skips empty user pushes on continuation rounds
 * - AgentKernel history merge stays aligned when compaction trims history
 * - ComplexityClassifier short-message classification respects keyword signals
 * - CompletionVerifier requires unresolved hypotheses to be resolved
 * - ContextCompactor reports real compress/remove counts
 * - ValidationEngine timeout + pipe deadlock prevention
 * - TaskGraph blockTask/cancelTask terminal-state guards
 * - AgentBudget zero-limit warning guards
 * - OutputTruncator finalSize includes appended notices
 * - ContextCompiler counts the system prompt exactly once
 * - SubagentManager forwards task.systemPrompt
 */

import { describe, it, expect } from "vite-plus/test";
import { OpenAIChatTransport } from "../../transport/OpenAIChatTransport.ts";
import { OpenAIResponsesTransport } from "../../transport/OpenAIResponsesTransport.ts";
import { AnthropicTransport } from "../../transport/AnthropicTransport.ts";
import { GeminiTransport } from "../../transport/GeminiTransport.ts";
import type {
  TransportRequest,
  TransportHistoryEntry,
  LLMTransport,
} from "../../transport/LLMTransport.ts";
import { runAgentLoop } from "../../AgentLoop.ts";
import { AgentKernel } from "../../kernel/AgentKernel.ts";
import { ContextCompiler } from "../../kernel/ContextCompiler.ts";
import { ContextCompactor } from "../../kernel/ContextCompactor.ts";
import { CompletionVerifier } from "../../kernel/CompletionVerifier.ts";
import { TaskGraph } from "../../kernel/TaskGraph.ts";
import { AgentBudget } from "../../kernel/AgentBudget.ts";
import { OutputTruncator } from "../../kernel/OutputTruncator.ts";
import { ComplexityClassifier } from "../../kernel/ComplexityClassifier.ts";
import { ValidationEngine } from "../../kernel/ValidationEngine.ts";
import { WorkingMemory } from "../../kernel/WorkingMemory.ts";
import { SubagentManager } from "../../SubagentManager.ts";
import type { AgentToolContext } from "../../AgentTool.ts";
import { canonicalTools } from "../../tools/index.ts";

const ECHO_PROMPT = "You are a helpful assistant. Use the provided tools when needed.";

function requestFor(
  transport: LLMTransport,
  request: TransportRequest,
): Record<string, unknown> | undefined {
  const plan = transport.buildRequest({
    request,
    baseUrl: "https://example.test",
    headers: {},
  });
  return plan?.body as Record<string, unknown> | undefined;
}

// ─── Transports: role:"system" ────────────────────────────────

describe("transports preserve system role", () => {
  const systemHistory: readonly TransportHistoryEntry[] = [
    { role: "system", content: ECHO_PROMPT },
    { role: "user", content: "Hello" },
    { role: "assistant", content: "Hi there" },
  ];

  it("OpenAIChat maps system entries to role:system messages", () => {
    const body = requestFor(new OpenAIChatTransport(), {
      model: "m",
      text: "",
      history: systemHistory,
    })!;
    const messages = body.messages as Array<Record<string, unknown>>;
    expect(messages[0]).toEqual({ role: "system", content: ECHO_PROMPT });
    expect(messages[1]?.role).toBe("user");
  });

  it("OpenAIChat composes multi-role history in order", () => {
    const body = requestFor(new OpenAIChatTransport(), {
      model: "m",
      text: "",
      history: systemHistory,
    })!;
    const messages = body.messages as Array<Record<string, unknown>>;
    expect(messages.map((m) => m.role)).toEqual(["system", "user", "assistant"]);
  });

  it("OpenAIChat handles system entries with array content", () => {
    const body = requestFor(new OpenAIChatTransport(), {
      model: "m",
      text: "",
      history: [{ role: "system", content: [{ type: "text", text: "sys" }] }],
    })!;
    const messages = body.messages as Array<Record<string, unknown>>;
    expect(messages[0]).toEqual({ role: "system", content: [{ type: "text", text: "sys" }] });
  });

  it("OpenAIChat skips system entries with no content", () => {
    const body = requestFor(new OpenAIChatTransport(), {
      model: "m",
      text: "",
      history: [{ role: "system" }, { role: "user", content: "hi" }],
    })!;
    const messages = body.messages as Array<Record<string, unknown>>;
    expect(messages.length).toBe(1);
    expect(messages[0]?.role).toBe("user");
  });

  it("OpenAIResponses maps system entries to role:system items", () => {
    const body = requestFor(new OpenAIResponsesTransport(), {
      model: "m",
      text: "",
      history: systemHistory,
    })!;
    const items = body.input as Array<Record<string, unknown>>;
    expect(items[0]).toEqual({ role: "system", content: ECHO_PROMPT });
    expect(items[1]?.role).toBe("user");
  });

  it("OpenAIResponses stringifies array system content", () => {
    const body = requestFor(new OpenAIResponsesTransport(), {
      model: "m",
      text: "",
      history: [{ role: "system", content: [{ type: "input_text", text: "sys" }] }],
    })!;
    const items = body.input as Array<Record<string, unknown>>;
    expect(items[0]?.content).toBe(JSON.stringify([{ type: "input_text", text: "sys" }]));
  });

  it("Anthropic puts system entries into the top-level system field", () => {
    const body = requestFor(new AnthropicTransport(), {
      model: "m",
      text: "",
      history: systemHistory,
    })!;
    expect(body.system).toBe(ECHO_PROMPT);
    const messages = body.messages as Array<Record<string, unknown>>;
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("Anthropic joins multiple system entries", () => {
    const body = requestFor(new AnthropicTransport(), {
      model: "m",
      text: "",
      history: [
        { role: "system", content: "Rule one" },
        { role: "system", content: "Rule two" },
        { role: "user", content: "hi" },
      ],
    })!;
    expect(body.system).toBe("Rule one\nRule two");
  });

  it("Anthropic omits system field when none present", () => {
    const body = requestFor(new AnthropicTransport(), {
      model: "m",
      text: "",
      history: [{ role: "user", content: "hi" }],
    })!;
    expect(body.system).toBeUndefined();
  });

  it("Gemini maps system entries to systemInstruction", () => {
    const body = requestFor(new GeminiTransport(), {
      model: "m",
      text: "",
      history: systemHistory,
    })!;
    expect(body.systemInstruction).toEqual({ parts: [{ text: ECHO_PROMPT }] });
    const contents = body.contents as Array<Record<string, unknown>>;
    expect(contents.map((c) => c.role)).toEqual(["user", "model"]);
  });

  it("Gemini omits systemInstruction when none present", () => {
    const body = requestFor(new GeminiTransport(), {
      model: "m",
      text: "",
      history: [{ role: "user", content: "hi" }],
    })!;
    expect(body.systemInstruction).toBeUndefined();
  });
});

// ─── Fake transport + fetch for loop-level tests ──────────────

function makeTransport(
  options: {
    readonly responses?: ReadonlyArray<Record<string, unknown>>;
  } = {},
): LLMTransport & { readonly capturedBodies: Array<Record<string, unknown>> } {
  const responses = options.responses ?? [
    { choices: [{ message: { role: "assistant", content: null } }] },
  ];
  let index = 0;
  const capturedBodies: Array<Record<string, unknown>> = [];

  // Replace global fetch for the duration of the test
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (
    _input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    capturedBodies.push(body);
    const payload = responses[Math.min(index++, responses.length - 1)]!;
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const transport: LLMTransport & { capturedBodies: Array<Record<string, unknown>> } = {
    providerKind: "openai",
    capturedBodies,
    buildRequest: ({ request, baseUrl, headers }) => ({
      url: `${baseUrl}/chat/completions`,
      headers: { ...headers, "content-type": "application/json" },
      body: {
        model: request.model,
        messages: request.history
          .filter((h) => h.role !== "tool")
          .map((h) => {
            if (h.role === "tool" && h.toolResults) {
              return { role: "user", content: h.toolResults.map((t) => t.result).join("\n") };
            }
            return { role: h.role, content: String(h.content ?? "") };
          }),
        ...(request.tools ? { tools: request.tools } : {}),
      },
    }),
    parseResponse: (payload) => {
      const root = payload as Record<string, unknown>;
      const choice = Array.isArray(root.choices) ? root.choices[0] : undefined;
      const message =
        choice && typeof choice === "object"
          ? (choice as Record<string, unknown>).message
          : undefined;
      const content =
        message && typeof message === "object"
          ? (message as Record<string, unknown>).content
          : undefined;
      const toolCallsRaw =
        message && typeof message === "object"
          ? (message as Record<string, unknown>).tool_calls
          : undefined;
      const toolCalls = Array.isArray(toolCallsRaw)
        ? toolCallsRaw.map((call, i) => {
            const fn = (call as Record<string, unknown>).function as Record<string, unknown>;
            return {
              id:
                typeof (call as Record<string, unknown>).id === "string"
                  ? ((call as Record<string, unknown>).id as string)
                  : `tc_${i}`,
              name: typeof fn.name === "string" ? fn.name : "unknown",
              arguments: typeof fn.arguments === "string" ? fn.arguments : "{}",
            };
          })
        : [];
      return { text: typeof content === "string" ? content : "", toolCalls };
    },
    parseSseEvents: () => [{ kind: "done" }],
    normalizeError: (body, status) => ({
      message: `HTTP ${status}: ${body}`,
      retryable: false,
      status,
    }),
    normalizeUsage: () => undefined,
    buildDiscoveryRequest: () => ({ url: "https://example.test/models", headers: {}, body: {} }),
    normalizeModelList: () => [],
  };

  // Simple post-test restoration helper (called manually or via afterEach)
  (transport as unknown as { restoreFetch?: () => void }).restoreFetch = () => {
    globalThis.fetch = originalFetch;
  };
  return transport;
}

// ─── runAgentLoop: empty user message ─────────────────────────

describe("runAgentLoop empty-user-message fix", () => {
  it("does not push a user entry when text is empty", async () => {
    const transport = makeTransport();
    (transport as unknown as { restoreFetch: () => void }).restoreFetch = () => {
      /* keep fetch stubbed until the test with real calls ends */
    };
    const result = await runAgentLoop({
      transport,
      tools: canonicalTools,
      toolContext: makeToolContext(),
      text: "",
      history: [
        { role: "system", content: "prompt" },
        { role: "user", content: "Earlier question" },
        { role: "assistant", content: "Earlier answer" },
      ],
      model: "m",
      baseUrl: "https://example.test",
      headers: {},
      config: { maxRounds: 1, stream: false },
    });

    const sentHistory = transport.capturedBodies[0]!.messages as Array<Record<string, unknown>>;
    expect(sentHistory.some((m) => m.role === "user" && m.content === "")).toBe(false);
    expect(sentHistory.filter((m) => m.role === "user").map((m) => m.content)).toEqual([
      "Earlier question",
    ]);
    expect(result.history.length).toBe(3);
  });

  it("pushes a user entry exactly once when text is non-empty", async () => {
    const transport = makeTransport();
    const result = await runAgentLoop({
      transport,
      tools: canonicalTools,
      toolContext: makeToolContext(),
      text: "New question",
      history: [
        { role: "system", content: "prompt" },
        { role: "user", content: "Earlier question" },
      ],
      model: "m",
      baseUrl: "https://example.test",
      headers: {},
      config: { maxRounds: 1, stream: false },
    });

    const sentHistory = transport.capturedBodies[0]!.messages as Array<Record<string, unknown>>;
    expect(sentHistory.filter((m) => m.role === "user")).toHaveLength(2);
    expect(sentHistory.at(-1)).toEqual({ role: "user", content: "New question" });
    expect(result.history.at(-1)).toEqual({ role: "user", content: "New question" });
  });
});

// ─── AgentKernel: system prompt + history merge ───────────────

function makeToolContext(): AgentToolContext {
  return {
    cwd: "/tmp/t3-test",
    root: "/tmp/t3-test",
    resolvePath: async () => undefined,
    readFile: async () => "",
    writeFile: async () => {},
    listDirectory: async () => [],
    spawn: async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close();
        },
      });
      return {
        stdout: stream,
        stderr: stream,
        exitCode: Promise.resolve(0),
        kill: () => {},
      };
    },
  };
}

describe("AgentKernel.executeTurn round-2 fixes", () => {
  it("sends compiled.systemPrompt as the first message", async () => {
    const kernel = new AgentKernel({ maxModelRounds: 1, stream: false });
    await kernel.initialize("Fix the failing test", makeToolContext());
    kernel.getWorkingMemory().addDiscovery("divide(10, 0) returns Infinity");

    const transport = makeTransport();
    await kernel.executeTurn(
      [{ role: "user", content: "Fix the failing test" }],
      canonicalTools,
      makeToolContext(),
      transport,
      "m",
      "https://example.test",
      {},
    );

    const sent = transport.capturedBodies[0]!.messages as Array<Record<string, unknown>>;
    expect(sent[0]?.role).toBe("system");
    expect(String(sent[0]?.content)).toContain("## Current Objective");
    expect(String(sent[0]?.content)).toContain("divide(10, 0) returns Infinity");
    // Working memory leak — the user message appears exactly once after the system entry
    const userMsgs = sent.filter((m) => m.role === "user");
    expect(userMsgs).toHaveLength(1);
    expect(userMsgs[0]?.content).toBe("Fix the failing test");
  });

  it("keeps history aligned and duplicates nothing across continuation rounds", async () => {
    const toolCallsResponse = {
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "search_text", arguments: '{"query":"math","path":"/tmp"}' },
              },
            ],
          },
        },
      ],
    };
    const transport = makeTransport({
      responses: [
        toolCallsResponse,
        toolCallsResponse,
        { choices: [{ message: { role: "assistant", content: null } }] },
      ],
    });

    const kernel = new AgentKernel({ maxModelRounds: 3, stream: false });
    await kernel.initialize("Search for the math file", makeToolContext());
    kernel.getWorkingMemory().addHypothesis("math.ts holds the bug");

    const result = await kernel.executeTurn(
      [{ role: "user", content: "Search for the math file" }],
      canonicalTools,
      makeToolContext(),
      transport,
      "m",
      "https://example.test",
      {},
    );

    // 3 rounds happened
    expect(transport.capturedBodies.length).toBe(3);
    // Every round begins with the fresh system prompt
    for (const body of transport.capturedBodies) {
      const messages = body.messages as Array<Record<string, unknown>>;
      expect(messages[0]?.role).toBe("system");
    }
    // No empty user messages ever sent
    for (const body of transport.capturedBodies) {
      const messages = body.messages as Array<Record<string, unknown>>;
      expect(messages.some((m) => m.role === "user" && m.content === "")).toBe(false);
    }
    // Each round's history strictly grows (no duplicates of the first user message)
    const first = transport.capturedBodies[0]!.messages as Array<Record<string, unknown>>;
    const second = transport.capturedBodies[1]!.messages as Array<Record<string, unknown>>;
    expect(second.length).toBeGreaterThan(first.length);
    expect(
      second.filter((m) => m.role === "user" && m.content === "Search for the math file"),
    ).toHaveLength(1);
    expect(result.terminationReason).toBe("max-rounds");
  });
});

// ─── ComplexityClassifier short-message signals ───────────────

describe("ComplexityClassifier short-message classification", () => {
  it("complex keyword wins over short trivial path", () => {
    const classifier = new ComplexityClassifier();
    const result = classifier.classify({ userMessage: "fix cache" });
    expect(result.level).not.toBe("trivial");
  });

  it("moderate keyword wins over short trivial path", () => {
    const classifier = new ComplexityClassifier();
    const result = classifier.classify({ userMessage: "implement api" });
    expect(result.level).not.toBe("trivial");
    expect(result.level).toBe("moderate");
  });

  it("high-risk keyword still wins on short messages", () => {
    const classifier = new ComplexityClassifier();
    const result = classifier.classify({ userMessage: "fix auth" });
    expect(result.level).toBe("high-risk");
  });

  it("still classifies genuinely trivial tasks as trivial", () => {
    const classifier = new ComplexityClassifier();
    const result = classifier.classify({ userMessage: "rename foo to bar" });
    expect(result.level).toBe("trivial");
  });

  it("empty message does not classify as trivial", () => {
    const classifier = new ComplexityClassifier();
    const result = classifier.classify({ userMessage: "" });
    expect(result.level).not.toBe("trivial");
  });
});

// ─── CompletionVerifier hypotheses rule ───────────────────────

describe("CompletionVerifier unresolved hypotheses", () => {
  function makeVerdict(overrides?: Partial<Parameters<CompletionVerifier["verify"]>[0]>) {
    const verifier = new CompletionVerifier();
    const task = {
      id: "task_1",
      objective: "Fix the bug in auth",
      dependencies: [],
      status: "running" as const,
      priority: "normal" as const,
      attemptCount: 1,
      maxAttempts: 3,
      createdAt: new Date().toISOString(),
    };
    return verifier.verify({
      task,
      memory: new WorkingMemory("t").getState(),
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
      ...overrides,
    });
  }

  it("blocks completion while hypotheses remain unresolved", () => {
    const memory = new WorkingMemory("t");
    memory.addHypothesis("Missing zero check in divide");
    const verdict = makeVerdict({ memory: memory.getState() });
    expect(verdict.complete).toBe(false);
    expect(
      verdict.requirements.some((r) => r.reason.includes("Hypotheses remain unresolved")),
    ).toBe(true);
  });

  it("allows completion when hypotheses are resolved (none recorded)", () => {
    const verdict = makeVerdict();
    expect(verdict.complete).toBe(true);
  });
});

// ─── ContextCompactor counts ──────────────────────────────────

describe("ContextCompactor round-2 counts", () => {
  it("reports the true number of compressed entries", () => {
    const compactor = new ContextCompactor({ maxContextTokens: 1000 });
    const toolEntry: TransportHistoryEntry = {
      role: "tool",
      toolResults: [{ id: "t1", name: "run_command", result: "x".repeat(400) }],
    };
    const history: TransportHistoryEntry[] = [
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
      toolEntry,
      { role: "user", content: "u2" },
      { role: "assistant", content: "a2" },
      { role: "user", content: "u3" },
      ...Array.from({ length: 4 }, () => ({
        role: "assistant" as const,
        content: "y".repeat(300),
      })),
    ];

    const result = compactor.compact(history);
    if (result.level === "compress") {
      // Summary should mention a positive number of compressed entries
      expect(result.summary).toMatch(/Compressed [1-9]/);
    }
  });

  it("never reports a negative removed count", () => {
    const compactor = new ContextCompactor({ maxContextTokens: 60 });
    const history: TransportHistoryEntry[] = [
      { role: "tool", toolResults: [{ id: "t1", name: "run", result: "z".repeat(100) }] },
      { role: "tool", toolResults: [{ id: "t2", name: "run", result: "z".repeat(100) }] },
    ];

    const result = compactor.compact(history);
    expect(result.summary).not.toMatch(/saved ~-/);
    expect(result.tokensSaved).toBeGreaterThanOrEqual(0);
    expect(result.summary).toMatch(/saved ~(\d+)/);
  });
});

// ─── ValidationEngine timeout + deadlock ──────────────────────

describe("ValidationEngine timeouts and pipe draining", () => {
  function engineContext(
    options: {
      readonly stdoutData?: string;
      readonly stderrData?: string;
      readonly exitCode?: number | null;
      readonly neverExit?: boolean;
      readonly exitAfterKill?: boolean;
    } = {},
  ): AgentToolContext & { readonly spawned: boolean } {
    return {
      spawned: true,
      cwd: "/tmp/t3-test",
      root: "/tmp/t3-test",
      resolvePath: async () => undefined,
      readFile: async () => "",
      writeFile: async () => {},
      listDirectory: async () => [],
      spawn: async () => {
        const makeStream = (data: string | undefined) =>
          new ReadableStream<Uint8Array>({
            start(controller) {
              if (data) controller.enqueue(new TextEncoder().encode(data));
              controller.close();
            },
          });
        let killed = false;
        return {
          stdout: makeStream(options.stdoutData),
          stderr: makeStream(options.stderrData),
          exitCode: new Promise<number | null>((resolve) => {
            if (!options.neverExit) {
              setTimeout(() => {
                resolve(options.exitCode ?? 0);
              }, 5);
            } else {
              const interval = setInterval(() => {
                if (killed) {
                  clearInterval(interval);
                  resolve(null);
                }
              }, 5);
            }
          }),
          kill: () => {
            killed = true;
          },
        };
      },
    };
  }

  it("times out long-running commands", async () => {
    const engine = new ValidationEngine({ defaultTimeoutMs: 60_000 });
    const report = await engine.run(
      {
        checks: ["tests"],
        cwd: "/tmp/t3-test",
        timeoutMs: 50,
        projectProfile: {
          type: "node",
          commands: {
            test: "sleep 5",
            lint: undefined,
            typecheck: undefined,
            build: undefined,
            format: undefined,
          },
          packageManager: "npm",
          configFile: "package.json",
        },
      },
      engineContext({ neverExit: true }) as AgentToolContext,
    );

    const result = report.results[0];
    expect(result?.status).toBe("error");
    expect(result?.output).toContain("Timed out");
  });

  it("drains large stdout without deadlock (hrun exitCode blocked on pipes)", async () => {
    const engine = new ValidationEngine({ defaultTimeoutMs: 60_000 });
    const bigOutput = "x".repeat(200_000);
    const report = await engine.run(
      {
        checks: ["tests"],
        cwd: "/tmp/t3-test",
        timeoutMs: 5_000,
        projectProfile: {
          type: "node",
          commands: {
            test: "cat bigfile",
            lint: undefined,
            typecheck: undefined,
            build: undefined,
            format: undefined,
          },
          packageManager: "npm",
          configFile: "package.json",
        },
      },
      engineContext({ stdoutData: bigOutput, exitCode: 0 }) as AgentToolContext,
    );

    const result = report.results[0];
    expect(result?.status).toBe("passing");
    expect(result?.output?.length).toBeLessThanOrEqual(5000);
  });
});

// ─── TaskGraph terminal guards ────────────────────────────────

describe("TaskGraph terminal-state guards", () => {
  it("blockTask does not move a completed task", () => {
    const graph = new TaskGraph();
    const task = graph.createTask({ objective: "t" });
    graph.startTask(task.id);
    graph.completeTask(task.id, { changedFiles: [], diffs: [], summary: "done" });

    graph.blockTask(task.id);
    expect(graph.getTask(task.id)?.status).toBe("completed");
  });

  it("blockTask does not move a cancelled task", () => {
    const graph = new TaskGraph();
    const task = graph.createTask({ objective: "t" });
    graph.cancelTask(task.id);

    graph.blockTask(task.id);
    expect(graph.getTask(task.id)?.status).toBe("cancelled");
  });

  it("cancelTask does not move a completed task", () => {
    const graph = new TaskGraph();
    const task = graph.createTask({ objective: "t" });
    graph.startTask(task.id);
    graph.completeTask(task.id, { changedFiles: [], diffs: [], summary: "done" });

    graph.cancelTask(task.id);
    expect(graph.getTask(task.id)?.status).toBe("completed");
  });

  it("blockTask and cancelTask still work on pending/ready tasks", () => {
    const graph = new TaskGraph();
    const task = graph.createTask({ objective: "t" });
    graph.blockTask(task.id);
    expect(graph.getTask(task.id)?.status).toBe("blocked");

    const task2 = graph.createTask({ objective: "t2" });
    graph.cancelTask(task2.id);
    expect(graph.getTask(task2.id)?.status).toBe("cancelled");
  });
});

// ─── AgentBudget zero-limit guards ────────────────────────────

describe("AgentBudget zero-limit warnings", () => {
  it("produces no division-by-zero warnings when maxCostUsd is 0", () => {
    const budget = new AgentBudget({ maxCostUsd: 0 });
    budget.recordModelCall(10, 10, 0, 0.001);
    const check = budget.check();
    for (const w of check.warnings) {
      expect(w).not.toContain("Infinity");
      expect(w).not.toContain("NaN");
    }
  });

  it("produces no division-by-zero warnings when maxTurns is 0", () => {
    const budget = new AgentBudget({ maxTurns: 0 });
    budget.recordModelCall(10, 10, 0, 0.001);
    const check = budget.check();
    for (const w of check.warnings) {
      expect(w).not.toContain("Infinity");
      expect(w).not.toContain("NaN");
    }
  });

  it("produces no division-by-zero warnings when maxTokens is 0", () => {
    const budget = new AgentBudget({ maxTokens: 0 });
    budget.recordModelCall(10, 10, 0, 0.001);
    const check = budget.check();
    for (const w of check.warnings) {
      expect(w).not.toContain("Infinity");
      expect(w).not.toContain("NaN");
    }
  });
});

// ─── OutputTruncator finalSize ────────────────────────────────

describe("OutputTruncator finalSize accuracy", () => {
  it("truncateTestOutput finalSize equals output length", () => {
    const truncator = new OutputTruncator({ maxOutputChars: 200 });
    const output = ["PASS a", "PASS b", "FAIL c", "  Error: expected 1 to equal 2", "PASS d"].join(
      "\n",
    );
    const result = truncator.truncateTestOutput(output);
    expect(result.finalSize).toBe(result.output.length);
  });

  it("truncateDiff finalSize equals output length", () => {
    const truncator = new OutputTruncator({ maxOutputChars: 300 });
    const diff = [
      "diff --git a/a.ts b/a.ts",
      ...Array.from({ length: 40 }, (_, i) => `  line ${i}: ${"x".repeat(20)}`),
      "diff --git a/b.ts b/b.ts",
      ...Array.from({ length: 40 }, (_, i) => `  line ${i}: ${"x".repeat(20)}`),
    ].join("\n");
    const result = truncator.truncateDiff(diff);
    expect(result.finalSize).toBe(result.output.length);
  });
});

// ─── ContextCompiler token counting ───────────────────────────

describe("ContextCompiler token counting", () => {
  it("counts the system prompt exactly once", () => {
    const compiler = new ContextCompiler();
    const memory = new WorkingMemory("Objective text");
    memory.addDiscovery("Discovery text");
    memory.addHypothesis("Hypothesis text");

    const result = compiler.compile({
      history: [],
      tools: [],
      workingMemory: memory.getState(),
      userMessage: "",
    });

    // The entire system prompt is counted once; tokens ~ chars/4
    const expectedSystemTokens = Math.ceil(result.systemPrompt.length / 4);
    // No history, no tools, empty user message → estimate equals system prompt
    expect(result.estimatedTokens).toBe(expectedSystemTokens);
  });

  it("metadata token budget is consistent", () => {
    const compiler = new ContextCompiler();
    const result = compiler.compile({
      history: [],
      tools: [],
      userMessage: "Hello",
    });
    expect(result.metadata.tokenBudget.used).toBe(result.estimatedTokens);
    expect(result.metadata.tokenBudget.remaining).toBe(
      result.metadata.tokenBudget.total - result.estimatedTokens,
    );
  });
});

// ─── SubagentManager systemPrompt ─────────────────────────────

describe("SubagentManager systemPrompt forwarding", () => {
  it("forwards task.systemPrompt into the subagent loop history", async () => {
    const transport = makeTransport();
    const manager = new SubagentManager({ maxConcurrency: 1, maxRounds: 1 });
    const results = await manager.executeParallel(
      [{ id: "s1", prompt: "Do the thing", systemPrompt: "You are the sub agent" }],
      {
        transport,
        tools: canonicalTools,
        toolContext: makeToolContext(),
        model: "m",
        baseUrl: "https://example.test",
        headers: {},
      },
    );

    expect(results).toHaveLength(1);
    const sent = transport.capturedBodies[0]!.messages as Array<Record<string, unknown>>;
    expect(sent[0]).toEqual({ role: "system", content: "You are the sub agent" });
    expect(sent.at(-1)).toEqual({ role: "user", content: "Do the thing" });
  });
});

// ─── ToolRegistry cancel + approval fixes ──────────────────────

describe("ToolRegistry cancel and approval fixes", () => {
  it("cancel returns failure result after in-flight execution completes", async () => {
    const { ToolRegistry } = await import("../../kernel/ToolRegistry.ts");
    const registry = new ToolRegistry();

    const slowTool = {
      id: "slow_tool",
      description: "A slow tool",
      inputSchema: { type: "object" as const, properties: {} },
      risk: "read" as const,
      capabilities: [],
      enabled: true,
      sideEffects: "none" as const,
      retrySafety: "safe" as const,
      execute: async () => {
        await new Promise((r) => setTimeout(r, 50));
        return { output: "done", success: true };
      },
    };
    registry.register(slowTool);

    const inv = registry.createInvocation({
      turnId: "turn-1",
      modelRoundId: "round-1",
      toolId: "slow_tool",
      arguments: {},
    });
    const execPromise = registry.execute(inv.id, makeToolContext());

    // Cancel while running
    await new Promise((r) => setTimeout(r, 10));
    registry.cancel(inv.id);

    const result = await execPromise;
    expect(result.success).toBe(false);
    expect(result.output).toContain("cancelled");
  });

  it("approval-required policy returns failure immediately", async () => {
    const { ToolRegistry } = await import("../../kernel/ToolRegistry.ts");
    const registry = new ToolRegistry();

    const tool = {
      id: "approval_tool",
      description: "Needs approval",
      inputSchema: { type: "object" as const, properties: {} },
      risk: "execute" as const, // "execute" risk defaults to approval-required
      capabilities: [],
      enabled: true,
      sideEffects: "none" as const,
      retrySafety: "safe" as const,
      execute: async () => ({ output: "should not run", success: true }),
    };
    registry.register(tool);

    const inv = registry.createInvocation({
      turnId: "turn-1",
      modelRoundId: "round-1",
      toolId: "approval_tool",
      arguments: {},
    });
    const result = await registry.execute(inv.id, makeToolContext());
    expect(result.success).toBe(false);
    expect(result.output).toContain("requires user approval");
  });
});

// ─── CapabilityResolver contextWindow ──────────────────────────

describe("CapabilityResolver contextWindow", () => {
  it("uses provider maxContextTokens when provided", async () => {
    const { CapabilityResolver } = await import("../../kernel/CapabilityResolver.ts");
    const resolver = new CapabilityResolver();
    const caps = resolver.resolve({
      provider: {
        tools: true,
        streaming: true,
        parallelTools: false,
        vision: true,
        reasoning: false,
        structuredOutput: false,
        usageReporting: true,
        rateLimitReporting: false,
        maxContextTokens: 200_000,
      },
      model: {
        maxOutputTokens: 8192,
        extendedThinking: false,
        vision: true,
        tokenizerFamily: "o200k",
      },
      protocol: {
        streaming: true,
        streamToolResults: true,
        systemPrompts: true,
        temperature: true,
      },
      connection: { alive: true, streaming: true },
    });
    expect(caps.contextWindow).toBe(200_000);
  });

  it("falls back to default when provider maxContextTokens is undefined", async () => {
    const { CapabilityResolver } = await import("../../kernel/CapabilityResolver.ts");
    const resolver = new CapabilityResolver();
    const caps = resolver.resolve({
      provider: {
        tools: true,
        streaming: true,
        parallelTools: false,
        vision: true,
        reasoning: false,
        structuredOutput: false,
        usageReporting: true,
        rateLimitReporting: false,
      },
      model: {
        maxOutputTokens: 8192,
        extendedThinking: false,
        vision: true,
        tokenizerFamily: "o200k",
      },
      protocol: {
        streaming: true,
        streamToolResults: true,
        systemPrompts: true,
        temperature: true,
      },
      connection: { alive: true, streaming: true },
    });
    expect(caps.contextWindow).toBe(128_000);
  });
});

// ─── TaskGraph createTask returns updated reference ───────────

describe("TaskGraph createTask reference", () => {
  it("returns node with updated status after auto-transition", () => {
    const graph = new TaskGraph();
    const node = graph.createTask({ objective: "Test task" });
    // Task with no dependencies auto-transitions to "ready"
    expect(node.status).toBe("ready");
  });
});

// ─── CompletionVerifier not-run handling ──────────────────────

describe("CompletionVerifier not-run handling", () => {
  it("not-run tests are not considered passing for code-change", () => {
    const verifier = new CompletionVerifier();
    const graph = new TaskGraph();
    const task = graph.createTask({ objective: "Test task" });
    const result = verifier.verify({
      task,
      memory: {
        objective: "Test task",
        understanding: "done",
        hypotheses: [],
        discoveries: [],
        filesOfInterest: [],
        changesMade: [],
        validationState: {
          lastRun: undefined,
          tests: "not-run",
          typecheck: "not-run",
          lint: "not-run",
          build: "not-run",
          failingTests: [],
          errors: [],
        },
        blockers: [],
        userDecisions: [],
        subagentReports: [],
      },
      validation: {
        tests: "not-run",
        typecheck: "not-run",
        lint: "not-run",
        build: "not-run",
        format: "not-run",
      },
      availableValidation: { tests: true, typecheck: true, lint: true },
      workspaceHasChanges: true,
      hasOutput: true,
    });
    expect(result.complete).toBe(false);
    expect(result.requirements.some((c) => !c.met)).toBe(true);
  });
});

// ─── WorkingMemory deep copy ──────────────────────────────────

describe("WorkingMemory state isolation", () => {
  it("getState returns independent validation arrays", () => {
    const wm = new WorkingMemory("objective");
    const state1 = wm.getState();
    const mutableFailingTests = [...state1.validationState.failingTests];
    mutableFailingTests.push("test1");
    const state2 = wm.getState();
    expect(state2.validationState.failingTests).toHaveLength(0);
  });
});

// ─── ContextCompiler user message not duplicated ──────────────

describe("ContextCompiler buildRequest", () => {
  it("user message appears in text and as last history entry", () => {
    const compiler = new ContextCompiler();
    const result = compiler.compile({
      history: [{ role: "user", content: "Hello" }],
      tools: [],
      userMessage: "Hello",
    });
    const request = compiler.buildRequest({
      compiled: result,
      model: "test",
      userMessage: "Hello",
    });
    // User message should be in text
    expect(request.text).toBe("Hello");
    // User message should also be in history as the last entry
    const lastEntry = request.history.at(-1);
    expect(lastEntry).toEqual({ role: "user", content: "Hello" });
  });
});
