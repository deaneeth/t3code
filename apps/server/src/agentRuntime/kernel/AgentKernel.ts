/**
 * AgentKernel — orchestrator with automatic continuation.
 *
 * The kernel drives the agent loop:
 * 1. Classify complexity
 * 2. Compile context
 * 3. Run agent loop
 * 4. Check completion
 * 5. If not complete, continue automatically
 *
 * Loop terminates only on:
 * - SUCCESS (completion verified)
 * - BLOCKED (waiting on user)
 * - WAITING_FOR_APPROVAL
 * - BUDGET_EXCEEDED
 * - FAILED
 * - CANCELLED
 *
 * @module agentRuntime/kernel/AgentKernel
 */

import type { AgentTool, AgentToolContext } from "../AgentTool.ts";
import type { AgentLoopResult, AgentLoopConfig } from "../AgentLoop.ts";
import { runAgentLoop } from "../AgentLoop.ts";
import type {
  LLMTransport,
  TransportHistoryEntry,
  TransportUsage,
} from "../transport/LLMTransport.ts";

import { TaskGraph } from "./TaskGraph.ts";
import type { TaskNode, ValidationState } from "./TaskGraph.ts";
import { WorkingMemory } from "./WorkingMemory.ts";
import type { WorkingMemoryState } from "./WorkingMemory.ts";
import { ContextCompiler } from "./ContextCompiler.ts";
import { ComplexityClassifier } from "./ComplexityClassifier.ts";
import type { ComplexityAssessment } from "./ComplexityClassifier.ts";
import { ValidationEngine } from "./ValidationEngine.ts";
import type { ValidationReport, BaselineState } from "./ValidationEngine.ts";
import { CompletionVerifier } from "./CompletionVerifier.ts";
import type { CompletionVerdict, TaskIntent } from "./CompletionVerifier.ts";
import { EventStore } from "./EventStore.ts";
import { AgentBudget } from "./AgentBudget.ts";
import type { BudgetLimits } from "./AgentBudget.ts";
import { ToolRegistry, toToolDefinition } from "./ToolRegistry.ts";
import type { ToolDefinition, ToolInvocation } from "./ToolRegistry.ts";
import { OutputTruncator } from "./OutputTruncator.ts";
import { ContextCompactor } from "./ContextCompactor.ts";
import { ProjectDetector } from "./ProjectDetector.ts";
import type { ProjectProfile } from "./ProjectDetector.ts";

// ─── Configuration ─────────────────────────────────────────────

export interface AgentKernelConfig {
  /** Maximum model rounds per turn (not user turns). */
  readonly maxModelRounds?: number | undefined;
  /** Budget limits override. */
  readonly budget?: Partial<BudgetLimits> | undefined;
  /** Working memory capacity. */
  readonly memoryCapacity?: number | undefined;
  /** Provider model name (for context limits). */
  readonly modelName?: string | undefined;
  /** AbortSignal for cancellation. */
  readonly signal?: AbortSignal | undefined;
  /** Stream events to caller. */
  readonly stream?: boolean | undefined;
  /** Maximum tool output characters before truncation. */
  readonly maxToolOutputChars?: number | undefined;
}

// ─── Execution Result ──────────────────────────────────────────

export type LoopTerminationReason =
  | "success"
  | "blocked"
  | "waiting-for-approval"
  | "budget-exceeded"
  | "failed"
  | "cancelled"
  | "max-rounds";

export interface KernelExecutionResult {
  readonly text: string;
  readonly toolCalls: AgentLoopResult["toolCalls"];
  readonly usage: TransportUsage | undefined;
  readonly stopReason: AgentLoopResult["stopReason"];
  readonly terminationReason: LoopTerminationReason;
  readonly validationReport?: ValidationReport | undefined;
  readonly completionVerdict?: CompletionVerdict | undefined;
  readonly sessionSummary: string;
  readonly budgetStatus: string;
  readonly modelRounds: number;
}

// ─── AgentKernel ───────────────────────────────────────────────

export class AgentKernel {
  private readonly taskGraph: TaskGraph;
  private readonly workingMemory: WorkingMemory;
  private readonly contextCompiler: ContextCompiler;
  private readonly classifier: ComplexityClassifier;
  private readonly validationEngine: ValidationEngine;
  private readonly completionVerifier: CompletionVerifier;
  private readonly eventStore: EventStore;
  private readonly budget: AgentBudget;
  private readonly toolRegistry: ToolRegistry;
  private readonly outputTruncator: OutputTruncator;
  private readonly contextCompactor: ContextCompactor;
  private readonly projectDetector: ProjectDetector;
  private readonly config: AgentKernelConfig;
  private assessment: ComplexityAssessment | undefined;
  private activeTaskId: string | undefined;
  private projectProfile: ProjectProfile | undefined;

  constructor(config?: AgentKernelConfig) {
    this.config = config ?? {};
    this.taskGraph = new TaskGraph();
    this.workingMemory = new WorkingMemory("Initialize");
    this.contextCompiler = new ContextCompiler();
    this.classifier = new ComplexityClassifier();
    this.validationEngine = new ValidationEngine();
    this.completionVerifier = new CompletionVerifier();
    this.eventStore = new EventStore();
    this.budget = new AgentBudget(this.config.budget);
    this.toolRegistry = new ToolRegistry();
    this.outputTruncator = new OutputTruncator(
      this.config.maxToolOutputChars
        ? { maxOutputChars: this.config.maxToolOutputChars }
        : undefined,
    );
    this.contextCompactor = new ContextCompactor();
    this.projectDetector = new ProjectDetector();

    // Register default tools
    this.registerDefaultTools();
  }

  /**
   * Initialize the kernel for a new user request.
   */
  async initialize(
    userMessage: string,
    context: AgentToolContext,
    metadata: {
      repositorySize?: "small" | "medium" | "large";
      affectedSubsystems?: ReadonlyArray<string>;
      hasExistingTests?: boolean;
    } = {},
  ): Promise<ComplexityAssessment> {
    // Detect project type
    this.projectProfile = await this.projectDetector.detect(context);

    // Capture baseline before making changes
    await this.validationEngine.captureBaseline(context);

    this.assessment = this.classifier.classify({
      userMessage,
      repositorySize: metadata.repositorySize,
      affectedSubsystems: metadata.affectedSubsystems,
      hasExistingTests: metadata.hasExistingTests,
    });

    this.eventStore.record("turn.started", {
      userMessage: userMessage.substring(0, 200),
      complexityLevel: this.assessment.level,
      projectType: this.projectProfile.type,
    });

    // Create initial task
    const task = this.taskGraph.createTask({
      objective: userMessage.substring(0, 200),
      priority: this.assessment.level === "high-risk" ? "critical" : "normal",
    });
    this.activeTaskId = task.id;

    this.eventStore.record(
      "task.created",
      {
        title: task.objective,
        taskId: task.id,
      },
      task.id,
    );

    return this.assessment;
  }

  /**
   * Execute a turn with automatic continuation.
   *
   * The loop continues until:
   * - Task is complete (verified by CompletionVerifier)
   * - Budget is exceeded
   * - Max rounds reached
   * - User approval needed
   * - Task fails
   */
  async executeTurn(
    history: TransportHistoryEntry[],
    tools: ReadonlyArray<AgentTool>,
    context: AgentToolContext,
    transport: LLMTransport,
    modelId: string,
    baseUrl: string,
    headers: Readonly<Record<string, string>>,
  ): Promise<KernelExecutionResult> {
    const maxRounds = this.config.maxModelRounds ?? 12;
    let modelRounds = 0;
    let lastResult: AgentLoopResult | undefined;
    let lastValidationReport: ValidationReport | undefined;
    let lastCompletionVerdict: CompletionVerdict | undefined;
    let terminationReason: LoopTerminationReason = "max-rounds";

    // Register tools
    for (const tool of tools) {
      const def = toToolDefinition(tool);
      this.toolRegistry.register(def);
    }

    // Automatic continuation loop
    while (modelRounds < maxRounds) {
      // 1. Check budget
      const budgetCheck = this.budget.check();
      if (!budgetCheck.allowed) {
        terminationReason = "budget-exceeded";
        this.eventStore.record("turn.failed", { reason: budgetCheck.exceeded });
        break;
      }

      // 2. Check signal
      if (this.config.signal?.aborted) {
        terminationReason = "cancelled";
        break;
      }

      // 3. Compile context
      const activeTask = this.activeTaskId ? this.taskGraph.getTask(this.activeTaskId) : undefined;
      const memoryState = this.workingMemory.getState();
      const lastUserMessage = [...history]
        .reverse()
        .find((h) => h.role === "user" && typeof h.content === "string");

      // Strip the last user entry from history — it's sent as `text`, not in history.
      // Only strip if the last entry is actually a user message.
      const lastHistoryEntry = history.at(-1);
      const historyForCompile = lastHistoryEntry?.role === "user" ? history.slice(0, -1) : history;

      const compiled = this.contextCompiler.compile({
        history: historyForCompile,
        tools: [...tools],
        workingMemory: memoryState,
        activeTask,
        userMessage: typeof lastUserMessage?.content === "string" ? lastUserMessage.content : "",
      });

      // 4. Apply context compaction
      const compacted = this.contextCompactor.compact(compiled.history as TransportHistoryEntry[]);

      this.eventStore.record("context.compiled", {
        inputTokens: compiled.estimatedTokens,
        toolsCount: compiled.tools.length,
        modelId,
        compactionLevel: compacted.level,
      });

      // 5. Get loop config from complexity
      const strategy = this.classifier.getExecutionStrategy(
        this.assessment ?? this.classifier.classify({ userMessage: "continue" }),
      );

      const loopConfig: AgentLoopConfig = {
        maxRounds: 1, // Single round per iteration
        stream: this.config.stream ?? true,
        signal: this.config.signal,
      };

      // 6. Run agent loop (single round)
      // Only the latest USER message is sent as `text`; continuation rounds
      // (last entry is an assistant or tool entry) send no extra user message.
      const lastEntry = history[history.length - 1];
      const userText =
        lastEntry?.role === "user" && typeof lastEntry.content === "string"
          ? lastEntry.content
          : "";

      // Prepend the compiled system prompt. If compaction kept the latest user
      // message, drop it here — runAgentLoop re-appends it as `text`.
      const historySent: Array<TransportHistoryEntry> = [
        { role: "system", content: compiled.systemPrompt },
        ...compacted.history,
      ];
      const lastSent = historySent[historySent.length - 1];
      if (userText !== "" && lastSent?.role === "user" && lastSent.content === userText) {
        historySent.pop();
      }

      const result = await runAgentLoop({
        transport,
        tools,
        toolContext: context,
        text: userText,
        history: historySent,
        model: modelId,
        baseUrl,
        headers,
        config: loopConfig,
      });

      modelRounds++;
      lastResult = result;

      // 7. Record usage
      if (result.usage) {
        this.budget.recordModelCall(
          result.usage.inputTokens ?? 0,
          result.usage.outputTokens ?? 0,
          result.usage.cachedInputTokens ?? 0,
          result.usage.providerCostUsd ?? 0,
        );
        this.eventStore.record("usage.recorded", {
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          cachedTokens: result.usage.cachedInputTokens,
        });
      }

      // 8. Process tool results with truncation
      for (const tc of result.toolCalls) {
        this.budget.recordToolCall();
        const truncated = this.outputTruncator.truncate(tc.result);
        this.eventStore.record("tool.completed", {
          name: tc.name,
          outputLength: truncated.originalSize,
          truncated: truncated.truncated,
        });
      }

      // 9. Update history with new entries. result.history is
      // [system, ...historySent, (user), assistant/tool entries...]; keep only
      // the entries beyond what we sent (and the user message we re-appended).
      const pushedUser = userText !== "" ? 1 : 0;
      history = [...history, ...result.history.slice(historySent.length + pushedUser)];

      // 10. Check if model wants to finish
      const finishCall = result.toolCalls.find((tc) => tc.name === "finish_task");
      if (finishCall) {
        // Model thinks it's done — verify
        lastCompletionVerdict = await this.verifyCompletion(tools, context, lastValidationReport);

        if (lastCompletionVerdict.complete) {
          terminationReason = "success";
          break;
        } else {
          // Not actually complete — continue loop
          this.eventStore.record("turn.completed", {
            toolCalls: result.toolCalls.length,
            stopReason: "continue",
            reason: lastCompletionVerdict.summary,
          });
          continue;
        }
      }

      // 11. Validate if needed
      if (strategy.validationDepth !== "none" && result.toolCalls.length > 0) {
        const changedFiles = this.eventStore.deriveState().changedFiles;
        if (changedFiles.length > 0) {
          const checks = this.validationEngine.inferChecks(changedFiles);
          lastValidationReport = await this.validationEngine.run(
            { checks, cwd: context.cwd, projectProfile: this.projectProfile },
            context,
          );
          this.eventStore.record("validation.completed", {
            checks: lastValidationReport.results.map((r) => `${r.check}:${r.status}`),
            newFailures: lastValidationReport.newFailures,
            baselineFailures: lastValidationReport.baselineFailures,
          });

          // Update working memory
          const vs = lastValidationReport.overallState;
          this.workingMemory.updateValidation({
            tests: vs.tests,
            typecheck: vs.typecheck,
            lint: vs.lint,
            build: vs.build,
          });
        }
      }

      // 12. Check if loop should continue
      if (result.stopReason === "completed") {
        // Model stopped — check if task is done
        lastCompletionVerdict = await this.verifyCompletion(tools, context, lastValidationReport);

        if (lastCompletionVerdict.complete) {
          terminationReason = "success";
          break;
        }

        // Not complete, but model stopped — need user input or continue
        if (this.needsUserInput(result)) {
          terminationReason = "blocked";
          break;
        }

        // Continue loop
        this.eventStore.record("turn.completed", {
          toolCalls: result.toolCalls.length,
          stopReason: "continue",
        });
        continue;
      }

      if (result.stopReason === "error") {
        terminationReason = "failed";
        break;
      }

      if (result.stopReason === "interrupted") {
        terminationReason = "cancelled";
        break;
      }
    }

    // Final state
    if (modelRounds >= maxRounds) {
      terminationReason = "max-rounds";
    }

    this.eventStore.record("turn.completed", {
      toolCalls: lastResult?.toolCalls.length ?? 0,
      stopReason: lastResult?.stopReason,
      terminationReason,
      modelRounds,
    });

    return {
      text: lastResult?.text ?? "",
      toolCalls: lastResult?.toolCalls ?? [],
      usage: lastResult?.usage,
      stopReason: lastResult?.stopReason ?? "completed",
      terminationReason,
      validationReport: lastValidationReport,
      completionVerdict: lastCompletionVerdict,
      sessionSummary: this.eventStore.getSummary(),
      budgetStatus: this.budget.getStatus(),
      modelRounds,
    };
  }

  /**
   * Get the event store.
   */
  getEventStore(): EventStore {
    return this.eventStore;
  }

  /**
   * Get the working memory.
   */
  getWorkingMemory(): WorkingMemory {
    return this.workingMemory;
  }

  /**
   * Get the task graph.
   */
  getTaskGraph(): TaskGraph {
    return this.taskGraph;
  }

  /**
   * Get the tool registry.
   */
  getToolRegistry(): ToolRegistry {
    return this.toolRegistry;
  }

  /**
   * Get budget status.
   */
  getBudgetStatus(): string {
    return this.budget.getStatus();
  }

  /**
   * Get session summary.
   */
  getSessionSummary(): string {
    return this.eventStore.getSummary();
  }

  /**
   * Serialize for persistence.
   */
  serialize(): string {
    return JSON.stringify({
      taskGraph: this.taskGraph.serialize(),
      workingMemory: this.workingMemory.serialize(),
      eventStore: this.eventStore.serialize(),
      assessment: this.assessment,
      activeTaskId: this.activeTaskId,
      projectProfile: this.projectProfile,
    });
  }

  /**
   * Restore from serialized state (crash recovery).
   *
   * After restoration:
   * - All running invocations become "interrupted" (unknown state)
   * - Completed invocations remain as-is
   * - The user can manually continue with a new turn
   */
  static restore(data: string, config?: AgentKernelConfig): AgentKernel {
    const parsed = JSON.parse(data);
    const kernel = new AgentKernel(config);

    // Restore task graph (static method returns a new instance)
    const restoredGraph = TaskGraph.restore(parsed.taskGraph);
    // Copy nodes from restored graph to existing one
    for (const task of restoredGraph.getAllTasks()) {
      kernel.taskGraph.createTask({
        objective: task.objective,
        priority: task.priority,
        maxAttempts: task.maxAttempts,
      });
    }

    // Restore working memory
    kernel.workingMemory.restore(parsed.workingMemory);

    // Restore event store — inject events with original timestamps
    const restoredStore = EventStore.restore(parsed.eventStore);
    for (const event of restoredStore.getEvents()) {
      kernel.eventStore.injectEvent(event);
    }

    // Restore assessment and active task
    kernel.assessment = parsed.assessment;
    kernel.activeTaskId = parsed.activeTaskId;
    kernel.projectProfile = parsed.projectProfile;

    // Mark any running tasks as interrupted
    const runningTasks = kernel.taskGraph.getRunningTasks();
    for (const task of runningTasks) {
      kernel.taskGraph.failTask(task.id, "Interrupted — please continue manually");
    }

    return kernel;
  }

  private registerDefaultTools(): void {
    // Tools are registered from the canonical tools list
    // This is called during construction
  }

  private async verifyCompletion(
    tools: ReadonlyArray<AgentTool>,
    context: AgentToolContext,
    validationReport: ValidationReport | undefined,
  ): Promise<CompletionVerdict> {
    const taskNode = this.activeTaskId ? this.taskGraph.getTask(this.activeTaskId) : undefined;
    if (!taskNode) {
      return {
        complete: false,
        intent: "code-change",
        requirements: [
          { description: "No active task", met: false, reason: "No active task found" },
        ],
        summary: "No active task to verify",
      };
    }

    const memoryState = this.workingMemory.getState();
    const vs = validationReport?.overallState;

    // Determine what validation is available
    const availableValidation = {
      tests: this.projectProfile?.commands.test !== undefined,
      typecheck: this.projectProfile?.commands.typecheck !== undefined,
      lint: this.projectProfile?.commands.lint !== undefined,
    };

    return this.completionVerifier.verify({
      task: taskNode,
      memory: memoryState,
      validation: vs ?? {
        tests: "not-run",
        typecheck: "not-run",
        lint: "not-run",
        build: "not-run",
        format: "not-run",
      },
      workspaceHasChanges: this.eventStore.deriveState().changedFiles.length > 0,
      hasOutput: memoryState.changesMade.length > 0 || memoryState.discoveries.length > 0,
      availableValidation,
    });
  }

  private needsUserInput(result: AgentLoopResult): boolean {
    // Check if any tool calls require user input
    return result.toolCalls.some((tc) => tc.name === "ask_user");
  }
}
