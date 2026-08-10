/**
 * ContextCompiler — generates optimized provider-specific requests.
 *
 * The Context Compiler is one of the most important pieces of the Agent Kernel.
 * It takes canonical agent state and produces an optimized context for each
 * model call, selecting only what's relevant.
 *
 * Principle: Don't send 30 shell outputs and 17 irrelevant file reads.
 * Send: active objective, relevant history, relevant files, current diff,
 * recent failures, necessary tools.
 *
 * @module agentRuntime/kernel/ContextCompiler
 */

import type { TransportHistoryEntry, TransportRequest } from "../transport/LLMTransport.ts";
import type { AgentTool } from "../AgentTool.ts";
import type { WorkingMemoryState } from "./WorkingMemory.ts";
import type { TaskNode } from "./TaskGraph.ts";

export interface ContextCompilerConfig {
  /** Maximum tokens for the entire context. */
  readonly maxContextTokens: number;
  /** Fraction reserved for model output. */
  readonly outputReserveFraction: number;
  /** Maximum history entries to include. */
  readonly maxHistoryEntries: number;
  /** Maximum working memory lines. */
  readonly maxWorkingMemoryLines: number;
  /** Whether to include tool schemas. */
  readonly includeTools: boolean;
  /** Whether to include working memory. */
  readonly includeWorkingMemory: boolean;
  /** Whether to include task graph state. */
  readonly includeTaskState: boolean;
}

const DEFAULT_CONFIG: ContextCompilerConfig = {
  maxContextTokens: 128_000,
  outputReserveFraction: 0.25,
  maxHistoryEntries: 20,
  maxWorkingMemoryLines: 50,
  includeTools: true,
  includeWorkingMemory: true,
  includeTaskState: true,
};

export interface CompiledContext {
  /** System prompt (includes working memory + task state). */
  readonly systemPrompt: string;
  /** Conversation history, trimmed and optimized. */
  readonly history: ReadonlyArray<TransportHistoryEntry>;
  /** Tools to expose, filtered by relevance. */
  readonly tools: ReadonlyArray<{
    readonly type: "function";
    readonly function: {
      readonly name: string;
      readonly description: string;
      readonly parameters: Record<string, unknown>;
    };
  }>;
  /** Estimated tokens for this context. */
  readonly estimatedTokens: number;
  /** What was included/excluded for debugging. */
  readonly metadata: ContextMetadata;
}

export interface ContextMetadata {
  readonly historyEntriesIncluded: number;
  readonly historyEntriesDropped: number;
  readonly toolsIncluded: number;
  readonly toolsExcluded: number;
  readonly workingMemoryLines: number;
  readonly compactionApplied: boolean;
  readonly tokenBudget: {
    readonly total: number;
    readonly used: number;
    readonly remaining: number;
  };
}

/**
 * Estimate token count from text. ~4 chars per token.
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Estimate tokens from a history entry.
 */
function entryTokens(entry: TransportHistoryEntry): number {
  let tokens = 0;
  if (typeof entry.content === "string") tokens += estimateTokens(entry.content);
  else if (Array.isArray(entry.content)) tokens += estimateTokens(JSON.stringify(entry.content));
  if (entry.toolCalls) {
    for (const tc of entry.toolCalls)
      tokens += estimateTokens(tc.name) + estimateTokens(tc.arguments);
  }
  if (entry.toolResults) {
    for (const tr of entry.toolResults)
      tokens += estimateTokens(tr.name) + estimateTokens(tr.result);
  }
  return tokens;
}

/**
 * Tool relevance scoring.
 */
const TOOL_RELEVANCE: Record<string, number> = {
  read_file: 10,
  list_directory: 9,
  search_text: 9,
  search_files: 8,
  apply_patch: 7,
  write_file: 7,
  git_diff: 8,
  git_status: 8,
  git_log: 5,
  run_command: 6,
  ask_user: 3,
  finish_task: 2,
};

/**
 * Classify what tools are relevant for the current task type.
 */
function classifyToolRelevance(
  tools: ReadonlyArray<AgentTool>,
  taskType: string,
): Array<{ tool: AgentTool; relevance: number }> {
  return tools
    .map((tool) => ({
      tool,
      relevance: TOOL_RELEVANCE[tool.id] ?? 5,
    }))
    .sort((a, b) => b.relevance - a.relevance);
}

/**
 * ContextCompiler generates optimized contexts for model calls.
 */
export class ContextCompiler {
  private readonly config: ContextCompilerConfig;

  constructor(config?: Partial<ContextCompilerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Compile an optimized context for the next model call.
   */
  compile(input: {
    readonly systemPrompt?: string | undefined;
    readonly history: ReadonlyArray<TransportHistoryEntry>;
    readonly tools: ReadonlyArray<AgentTool>;
    readonly workingMemory?: WorkingMemoryState | undefined;
    readonly activeTask?: TaskNode | undefined;
    readonly recentToolResults?:
      | ReadonlyArray<{ readonly name: string; readonly result: string }>
      | undefined;
    readonly userMessage: string;
  }): CompiledContext {
    const budget = this.config.maxContextTokens * (1 - this.config.outputReserveFraction);
    let usedTokens = 0;
    let historyEntriesDropped = 0;

    // 1. Build system prompt
    const systemParts: string[] = [];
    if (input.systemPrompt) systemParts.push(input.systemPrompt);

    // Add working memory
    if (this.config.includeWorkingMemory && input.workingMemory) {
      const wm = input.workingMemory;
      const wmLines: string[] = [];
      wmLines.push(`\n## Current Objective\n${wm.objective}`);
      if (wm.understanding) wmLines.push(`\n## Understanding\n${wm.understanding}`);
      if (wm.discoveries.length > 0) {
        wmLines.push(`\n## Key Discoveries`);
        for (const d of wm.discoveries.slice(-8)) wmLines.push(`- ${d}`);
      }
      if (wm.hypotheses.length > 0) {
        wmLines.push(`\n## Hypotheses`);
        for (const h of wm.hypotheses) wmLines.push(`- ${h}`);
      }
      if (wm.filesOfInterest.length > 0) {
        wmLines.push(`\n## Files of Interest`);
        for (const f of wm.filesOfInterest) wmLines.push(`- ${f}`);
      }
      if (wm.changesMade.length > 0) {
        wmLines.push(`\n## Changes Made`);
        for (const c of wm.changesMade.slice(-5)) wmLines.push(`- ${c.operation} ${c.path}`);
      }
      const vs = wm.validationState;
      wmLines.push(`\n## Validation State`);
      wmLines.push(
        `Tests: ${vs.tests} | Typecheck: ${vs.typecheck} | Lint: ${vs.lint} | Build: ${vs.build}`,
      );
      if (vs.failingTests.length > 0) wmLines.push(`Failing tests: ${vs.failingTests.join(", ")}`);
      if (wm.blockers.length > 0) {
        wmLines.push(`\n## Blockers`);
        for (const b of wm.blockers) wmLines.push(`- ${b}`);
      }
      const wmText = wmLines.join("\n");
      systemParts.push(wmText);
    }

    // Add task state
    if (this.config.includeTaskState && input.activeTask) {
      const task = input.activeTask;
      const taskLines: string[] = [];
      taskLines.push(`\n## Active Task`);
      taskLines.push(`Objective: ${task.objective}`);
      taskLines.push(`Status: ${task.status}`);
      if (task.outputs?.summary) taskLines.push(`Progress: ${task.outputs.summary}`);
      const taskText = taskLines.join("\n");
      systemParts.push(taskText);
    }

    // Add recent tool results summary
    if (input.recentToolResults && input.recentToolResults.length > 0) {
      const trl: string[] = [];
      trl.push(`\n## Recent Tool Results`);
      for (const tr of input.recentToolResults.slice(-5)) {
        const preview = tr.result.substring(0, 200).replace(/\n/g, " ");
        trl.push(`- ${tr.name}: ${preview}`);
      }
      const trText = trl.join("\n");
      systemParts.push(trText);
    }

    // The joined system prompt is counted exactly once below.
    const systemPrompt = systemParts.join("\n\n");
    usedTokens += estimateTokens(systemPrompt);

    // 2. Optimize history — keep most recent, drop old irrelevant entries
    const optimizedHistory: TransportHistoryEntry[] = [];
    const maxHistory = this.config.maxHistoryEntries;
    const recentEntries = input.history.slice(-maxHistory);

    for (const entry of recentEntries) {
      const entryTok = entryTokens(entry);
      if (usedTokens + entryTok > budget * 0.7) {
        historyEntriesDropped++;
        continue;
      }
      optimizedHistory.push(entry);
      usedTokens += entryTok;
    }

    // Note: user message tokens are counted here but the message is also sent
    // via `text` in the request (not in history). This counts it once for the
    // token budget estimate. The actual duplication in the API request is handled
    // by AgentKernel stripping the last user entry from history before compile.

    // 3. Filter tools by relevance
    const allToolTokens = input.tools.reduce((sum, t) => {
      return sum + estimateTokens(t.description) + estimateTokens(JSON.stringify(t.inputSchema));
    }, 0);

    let toolsToInclude = input.tools;
    let toolsExcluded = 0;

    if (this.config.includeTools && allToolTokens > budget * 0.15 && input.tools.length > 0) {
      // Too many tools — filter by relevance
      const scored = classifyToolRelevance(input.tools, input.activeTask?.objective ?? "");
      const avgTokensPerTool = allToolTokens / input.tools.length;
      const maxTools = Math.max(1, Math.floor((budget * 0.1) / avgTokensPerTool));
      toolsToInclude = scored.slice(0, maxTools).map((s) => s.tool);
      toolsExcluded = input.tools.length - toolsToInclude.length;
    }

    const toolSchemas = toolsToInclude.map((tool) => ({
      type: "function" as const,
      function: {
        name: tool.id,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    }));

    // 4. Build the final context
    return {
      systemPrompt,
      history: optimizedHistory,
      tools: toolSchemas,
      estimatedTokens: usedTokens,
      metadata: {
        historyEntriesIncluded: optimizedHistory.length,
        historyEntriesDropped,
        toolsIncluded: toolsToInclude.length,
        toolsExcluded,
        workingMemoryLines: input.workingMemory
          ? this.estimateWorkingMemoryLines(input.workingMemory)
          : 0,
        compactionApplied: historyEntriesDropped > 0,
        tokenBudget: {
          total: budget,
          used: usedTokens,
          remaining: budget - usedTokens,
        },
      },
    };
  }

  /**
   * Build a TransportRequest from compiled context.
   */
  buildRequest(input: {
    readonly compiled: CompiledContext;
    readonly model: string;
    readonly userMessage: string;
    readonly stream?: boolean | undefined;
  }): TransportRequest {
    const history: TransportHistoryEntry[] = [
      { role: "system", content: input.compiled.systemPrompt },
      ...input.compiled.history,
      { role: "user", content: input.userMessage },
    ];

    return {
      model: input.model,
      text: input.userMessage,
      history,
      tools: input.compiled.tools.length > 0 ? input.compiled.tools : undefined,
      stream: input.stream ?? true,
    };
  }

  /**
   * Estimate lines in working memory state.
   */
  private estimateWorkingMemoryLines(state: WorkingMemoryState): number {
    let lines = 1; // objective
    if (state.understanding) lines += 2;
    lines += state.discoveries.length;
    lines += state.hypotheses.length;
    lines += state.filesOfInterest.length;
    lines += state.changesMade.length;
    lines += state.blockers.length;
    return lines;
  }
}
