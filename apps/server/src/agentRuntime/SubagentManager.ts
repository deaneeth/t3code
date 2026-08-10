// @effect-diagnostics globalTimers:off

/**
 * SubagentManager — orchestration of sub-agents for parallel tasks.
 *
 * Manages spawning, tracking, and collecting results from sub-agents.
 * Sub-agents are independent agent loops that run in parallel for
 * tasks like multi-file refactoring, test generation, or research.
 *
 * @module agentRuntime/SubagentManager
 */
import type { AgentTool, AgentToolContext, ToolResult } from "./AgentTool.ts";
import type {
  LLMTransport,
  TransportHistoryEntry,
  TransportUsage,
} from "./transport/LLMTransport.ts";
import { runAgentLoop, type AgentLoopResult, type AgentLoopConfig } from "./AgentLoop.ts";

export interface SubagentTask {
  /** Unique task identifier. */
  readonly id: string;
  /** The prompt/instruction for this sub-agent. */
  readonly prompt: string;
  /** Optional system context to prepend. */
  readonly systemPrompt?: string | undefined;
}

export interface SubagentResult {
  /** Task identifier. */
  readonly taskId: string;
  /** Whether the sub-agent completed successfully. */
  readonly success: boolean;
  /** The text output from the sub-agent. */
  readonly text: string;
  /** Tool calls made by the sub-agent. */
  readonly toolCalls: AgentLoopResult["toolCalls"];
  /** Token usage. */
  readonly usage: TransportUsage | undefined;
  /** How the sub-agent stopped. */
  readonly stopReason: AgentLoopResult["stopReason"];
  /** Error message if failed. */
  readonly error?: string | undefined;
}

export interface SubagentManagerConfig {
  /** Maximum concurrent sub-agents. Default: 3. */
  readonly maxConcurrency?: number | undefined;
  /** Max rounds per sub-agent. Default: 8. */
  readonly maxRounds?: number | undefined;
  /** Global timeout for all sub-agents. Default: 300000 (5 min). */
  readonly globalTimeoutMs?: number | undefined;
}

/**
 * SubagentManager orchestrates parallel sub-agent execution.
 */
export class SubagentManager {
  private readonly maxConcurrency: number;
  private readonly maxRounds: number;
  private readonly globalTimeoutMs: number;

  constructor(config?: SubagentManagerConfig) {
    const cfg = config ?? {};
    this.maxConcurrency = Math.max(1, Math.floor(cfg.maxConcurrency ?? 3));
    this.maxRounds = Math.max(0, Math.floor(cfg.maxRounds ?? 8));
    this.globalTimeoutMs = Math.max(1, Math.floor(cfg.globalTimeoutMs ?? 300_000));
  }

  /**
   * Execute multiple sub-agent tasks in parallel.
   * Respects maxConcurrency by running tasks in batches.
   */
  async executeParallel(
    tasks: ReadonlyArray<SubagentTask>,
    context: {
      readonly transport: LLMTransport;
      readonly tools: ReadonlyArray<AgentTool>;
      readonly toolContext: AgentToolContext;
      readonly model: string;
      readonly baseUrl: string;
      readonly headers: Readonly<Record<string, string>>;
      readonly config?: AgentLoopConfig | undefined;
    },
  ): Promise<ReadonlyArray<SubagentResult>> {
    if (tasks.length === 0) return [];

    const abortController = new AbortController();
    const timeoutId = setTimeout(() => abortController.abort(), this.globalTimeoutMs);

    try {
      const results: SubagentResult[] = [];
      const batches: Array<ReadonlyArray<SubagentTask>> = [];

      for (let i = 0; i < tasks.length; i += this.maxConcurrency) {
        batches.push(tasks.slice(i, i + this.maxConcurrency));
      }

      for (const batch of batches) {
        const batchResults = await Promise.all(
          batch.map(async (task) => {
            try {
              const result = await runAgentLoop({
                transport: context.transport,
                tools: context.tools,
                toolContext: context.toolContext,
                text: task.prompt,
                history: task.systemPrompt
                  ? [{ role: "system", content: task.systemPrompt }]
                  : undefined,
                model: context.model,
                baseUrl: context.baseUrl,
                headers: context.headers,
                config: {
                  ...context.config,
                  maxRounds: this.maxRounds,
                  signal: abortController.signal,
                },
              });

              return {
                taskId: task.id,
                success: result.stopReason === "completed",
                text: result.text,
                toolCalls: result.toolCalls,
                usage: result.usage,
                stopReason: result.stopReason,
              };
            } catch (cause) {
              return {
                taskId: task.id,
                success: false,
                text: "",
                toolCalls: [],
                usage: undefined,
                stopReason: "error" as const,
                error: String(cause),
              };
            }
          }),
        );
        results.push(...batchResults);
      }

      return results;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Create a "spawn_subagent" tool that can be used by the main agent loop.
   */
  createTool(): AgentTool {
    return {
      id: "spawn_subagent",
      description:
        "Spawn a sub-agent to perform an independent task in parallel. Returns when the sub-agent completes. Use for tasks that can run independently (e.g., researching a topic, generating tests for a file).",
      inputSchema: {
        type: "object",
        required: ["task_id", "prompt"],
        properties: {
          task_id: {
            type: "string",
            description: "Unique identifier for this sub-agent task",
          },
          prompt: {
            type: "string",
            description: "The instruction/prompt for the sub-agent",
          },
        },
        additionalProperties: false,
      },
      risk: "execute",
      capabilities: ["planning"],
      enabled: true,
      validate(args): string | undefined {
        if (typeof args.task_id !== "string" || args.task_id.length === 0) {
          return "task_id is required";
        }
        if (typeof args.prompt !== "string" || args.prompt.length === 0) {
          return "prompt is required";
        }
        return undefined;
      },
      async execute(_args, _context): Promise<ToolResult> {
        return {
          output: "Sub-agent spawned (handled by runtime).",
          success: true,
          metadata: { subagent: true, taskId: _args.task_id },
        };
      },
    };
  }
}
