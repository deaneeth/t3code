// @effect-diagnostics globalFetch:off globalTimers:off

/**
 * AgentLoop — the universal coding-agent loop.
 *
 * Provider-agnostic state machine that drives tool-based LLM interaction.
 * Calls the LLM transport for inference and executes tools through the
 * canonical tool registry.
 *
 * Features:
 * - Tool continuation (multi-round)
 * - Completion detection with proper stop-reason tracking
 * - Abort/cancel support via AbortSignal
 * - Retry on transient errors
 * - Max round limits
 * - Preserves original tool call ordering in results
 *
 * @module agentRuntime/AgentLoop
 */
import type { AgentTool, AgentToolContext, ToolResult } from "./AgentTool.ts";
import type {
  LLMTransport,
  TransportRequest,
  TransportStreamEvent,
  TransportToolCall,
  TransportUsage,
  TransportHistoryEntry,
  TransportAttachment,
} from "./transport/LLMTransport.ts";

export interface AgentLoopResult {
  readonly text: string;
  readonly toolCalls: Array<{
    readonly id: string;
    readonly name: string;
    readonly arguments: string;
    readonly result: string;
  }>;
  readonly usage: TransportUsage | undefined;
  readonly stopReason: "completed" | "max-rounds" | "error" | "interrupted";
  readonly history: Array<TransportHistoryEntry>;
}

export interface AgentLoopConfig {
  readonly maxRounds?: number | undefined;
  readonly stream?: boolean | undefined;
  readonly options?:
    | ReadonlyArray<{ readonly id: string; readonly value: string | boolean }>
    | undefined;
  /** AbortSignal to cancel the loop. */
  readonly signal?: AbortSignal | undefined;
  /** Max retries on transient (retryable) errors. Default: 2. */
  readonly maxRetries?: number | undefined;
}

export type AgentLoopEventCallback = (event: {
  readonly kind: "text-delta" | "tool-started" | "tool-completed" | "usage" | "round" | "retry";
  readonly text?: string | undefined;
  readonly toolName?: string | undefined;
  readonly toolId?: string | undefined;
  readonly success?: boolean | undefined;
  /** Failure detail for runtime surfaces; successful tool output stays private to the model loop. */
  readonly error?: string | undefined;
  readonly usage?: TransportUsage | undefined;
  readonly round?: number | undefined;
  readonly attempt?: number | undefined;
}) => void;

export async function runAgentLoop(input: {
  readonly transport: LLMTransport;
  readonly tools: ReadonlyArray<AgentTool>;
  readonly toolContext: AgentToolContext;
  readonly text: string;
  readonly history?: ReadonlyArray<TransportHistoryEntry> | undefined;
  readonly model: string;
  readonly baseUrl: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly attachments?: ReadonlyArray<TransportAttachment> | undefined;
  readonly config?: AgentLoopConfig | undefined;
  readonly onEvent?: AgentLoopEventCallback | undefined;
}): Promise<AgentLoopResult> {
  const { transport, tools, toolContext, text, model, baseUrl, headers, attachments } = input;
  const config = input.config ?? {};
  const maxRounds = Math.max(0, Math.floor(config.maxRounds ?? 12));
  const maxRetries = Math.max(0, Math.floor(config.maxRetries ?? 2));
  const signal = config.signal;
  const history: TransportHistoryEntry[] = [...(input.history ?? [])];
  const allToolResults: AgentLoopResult["toolCalls"] = [];
  let totalUsage: TransportUsage | undefined;
  let stopReason: AgentLoopResult["stopReason"] = "completed";
  let endedOnToolCalls = false;

  const toolIndex = new Map<string, AgentTool>();
  for (const tool of tools) toolIndex.set(tool.id, tool);

  const toolSchemas = tools.map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.id,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }));

  if (text.trim() !== "" || (attachments?.length ?? 0) > 0) {
    history.push({
      role: "user",
      content:
        attachments && attachments.length > 0
          ? [
              ...(text.trim() !== "" ? [{ type: "text", text }] : []),
              ...attachments.map((attachment) => ({
                type: "image_url",
                image_url: {
                  url: `data:${attachment.mimeType};base64,${attachment.data}`,
                },
              })),
            ]
          : text,
    });
  }

  let lastAssistantText = "";

  for (let round = 0; round < maxRounds; round += 1) {
    if (signal?.aborted) {
      stopReason = "interrupted";
      break;
    }

    input.onEvent?.({ kind: "round", round: round + 1 });

    const initialAttachments = round === 0 && attachments && attachments.length > 0;
    const request: TransportRequest = {
      model,
      text: initialAttachments ? text : "",
      history: initialAttachments ? history.slice(0, -1) : history,
      tools: toolSchemas,
      stream: config.stream ?? true,
      options: config.options,
      ...(initialAttachments ? { attachments } : {}),
    };

    const plan = transport.buildRequest({ request, baseUrl, headers });
    if (!plan) {
      stopReason = "error";
      lastAssistantText = "Error: Unable to build API request.";
      break;
    }

    // Execute with retry on transient errors
    let response: Response | undefined;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (signal?.aborted) {
        stopReason = "interrupted";
        break;
      }
      try {
        const controller = new AbortController();
        const onAbort = () => controller.abort();
        signal?.addEventListener("abort", onAbort, { once: true });
        try {
          response = await fetch(plan.url, {
            method: "POST",
            headers: { ...plan.headers, "content-type": "application/json" },
            body: JSON.stringify(plan.body),
            signal: controller.signal,
          });
        } finally {
          signal?.removeEventListener("abort", onAbort);
        }

        if (response.ok) break;

        const body = await response.text();
        const error = transport.normalizeError(body, response.status);

        if (!error.retryable || attempt >= maxRetries) {
          stopReason = "error";
          lastAssistantText = `Error: ${error.message}`;
          response = undefined;
          break;
        }
        input.onEvent?.({ kind: "retry", attempt: attempt + 1 });
        await waitForRetry(Math.min(250 * 2 ** attempt, 5_000), signal);
        if (signal?.aborted) {
          stopReason = "interrupted";
          break;
        }
      } catch (cause: unknown) {
        if (signal?.aborted) {
          stopReason = "interrupted";
          break;
        }
        const msg = cause instanceof Error ? cause.message : String(cause);
        if (attempt >= maxRetries) {
          stopReason = "error";
          lastAssistantText = `Network error: ${msg}`;
          response = undefined;
          break;
        }
        input.onEvent?.({ kind: "retry", attempt: attempt + 1 });
        await waitForRetry(Math.min(250 * 2 ** attempt, 5_000), signal);
        if (signal?.aborted) {
          stopReason = "interrupted";
          break;
        }
      }
    }

    if (stopReason !== "completed" || !response) break;

    const contentType = response.headers.get("content-type") ?? "";
    let assistantText = "";
    let toolCalls: TransportToolCall[] = [];
    let usage: TransportUsage | undefined;

    if (contentType.includes("json")) {
      try {
        const payload = (await response.json()) as Record<string, unknown>;
        const parsed = transport.parseResponse(payload);
        assistantText = parsed.text;
        toolCalls = [...parsed.toolCalls];
        usage = transport.normalizeUsage(payload);
      } catch (cause) {
        stopReason = "error";
        lastAssistantText = `Invalid provider response: ${cause instanceof Error ? cause.message : String(cause)}`;
        break;
      }
    } else {
      // SSE streaming — read from the response body stream
      const reader = response.body?.getReader();
      if (reader) {
        const decoder = new TextDecoder();
        let buffer = "";
        const toolCallsMap = new Map<string, { name: string; args: string }>();
        const toolCallIdsByIndex = new Map<number, string>();
        const toolCallIdsByItemId = new Map<string, string>();
        let toolCallIndex = 0;
        let streamError: string | undefined;

        try {
          while (true) {
            if (signal?.aborted) {
              stopReason = "interrupted";
              break;
            }
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });

            const parts = buffer.split(/\r?\n\r?\n/u);
            buffer = parts.pop() ?? "";
            for (const block of parts) {
              if (!block.trim()) continue;
              for (const event of transport.parseSseEvents(block)) {
                applyStreamEvent(
                  event,
                  toolCallsMap,
                  toolCallIdsByIndex,
                  toolCallIdsByItemId,
                  () => toolCallIndex++,
                );
                if (event.kind === "text-delta" && event.text) {
                  assistantText += event.text;
                  input.onEvent?.({ kind: "text-delta", text: event.text });
                }
                if (event.kind === "usage" && event.usage) usage = event.usage;
                if (event.kind === "error") {
                  streamError = event.error ?? "Provider stream returned an error.";
                  stopReason = "error";
                  lastAssistantText = `Error: ${streamError}`;
                  break;
                }
                if (event.kind === "done") break;
              }
              if (streamError) break;
            }
            if (streamError) break;
          }
          // Process remaining buffer
          buffer += decoder.decode();
          if (!streamError && buffer.trim()) {
            for (const event of transport.parseSseEvents(buffer)) {
              applyStreamEvent(
                event,
                toolCallsMap,
                toolCallIdsByIndex,
                toolCallIdsByItemId,
                () => toolCallIndex++,
              );
              if (event.kind === "text-delta" && event.text) {
                assistantText += event.text;
                input.onEvent?.({ kind: "text-delta", text: event.text });
              }
              if (event.kind === "usage" && event.usage) usage = event.usage;
              if (event.kind === "error") {
                streamError = event.error ?? "Provider stream returned an error.";
                stopReason = "error";
                lastAssistantText = `Error: ${streamError}`;
                break;
              }
            }
          }
        } finally {
          reader.releaseLock();
        }

        toolCalls = [...toolCallsMap.entries()].map(([id, call]) => ({
          id,
          name: call.name,
          arguments: call.args,
        }));
      } else {
        // Fallback: buffer entire response
        const sseText = await response.text();
        const lines = sseText.split("\n");
        let block = "";
        const toolCallsMap = new Map<string, { name: string; args: string }>();
        const toolCallIdsByIndex = new Map<number, string>();
        const toolCallIdsByItemId = new Map<string, string>();
        let toolCallIndex = 0;
        let streamError: string | undefined;

        for (const line of lines) {
          if (line.trim().length === 0 && block.length > 0) {
            for (const event of transport.parseSseEvents(block)) {
              applyStreamEvent(
                event,
                toolCallsMap,
                toolCallIdsByIndex,
                toolCallIdsByItemId,
                () => toolCallIndex++,
              );
              if (event.kind === "text-delta" && event.text) {
                assistantText += event.text;
                input.onEvent?.({ kind: "text-delta", text: event.text });
              }
              if (event.kind === "usage" && event.usage) usage = event.usage;
              if (event.kind === "error") {
                streamError = event.error ?? "Provider stream returned an error.";
                stopReason = "error";
                lastAssistantText = `Error: ${streamError}`;
                break;
              }
            }
            if (streamError) break;
            block = "";
          } else if (line.startsWith("data:")) {
            block += `${line}\n`;
          }
        }
        if (!streamError && block.length > 0) {
          for (const event of transport.parseSseEvents(block)) {
            applyStreamEvent(
              event,
              toolCallsMap,
              toolCallIdsByIndex,
              toolCallIdsByItemId,
              () => toolCallIndex++,
            );
            if (event.kind === "text-delta" && event.text) {
              assistantText += event.text;
              input.onEvent?.({ kind: "text-delta", text: event.text });
            }
            if (event.kind === "usage" && event.usage) usage = event.usage;
            if (event.kind === "error") {
              streamError = event.error ?? "Provider stream returned an error.";
              stopReason = "error";
              lastAssistantText = `Error: ${streamError}`;
              break;
            }
          }
        }
        toolCalls = [...toolCallsMap.entries()].map(([id, call]) => ({
          id,
          name: call.name,
          arguments: call.args,
        }));
      }
    }

    // Providers occasionally emit an empty placeholder tool call while
    // streaming. Do not surface it as a real tool invocation: it creates a
    // misleading failed tool item and can poison the next model round.
    toolCalls = toolCalls.filter(
      (call) => call.id.trim().length > 0 && call.name.trim().length > 0,
    );

    // Accumulate usage
    if (usage) {
      totalUsage = {
        inputTokens: (totalUsage?.inputTokens ?? 0) + (usage.inputTokens ?? 0),
        cachedInputTokens: (totalUsage?.cachedInputTokens ?? 0) + (usage.cachedInputTokens ?? 0),
        cacheCreationTokens:
          (totalUsage?.cacheCreationTokens ?? 0) + (usage.cacheCreationTokens ?? 0),
        outputTokens: (totalUsage?.outputTokens ?? 0) + (usage.outputTokens ?? 0),
        reasoningOutputTokens:
          (totalUsage?.reasoningOutputTokens ?? 0) + (usage.reasoningOutputTokens ?? 0),
        providerCostUsd: (totalUsage?.providerCostUsd ?? 0) + (usage.providerCostUsd ?? 0),
      };
      input.onEvent?.({ kind: "usage", usage: totalUsage });
    }

    // No tool calls: loop is complete
    if (toolCalls.length === 0) {
      endedOnToolCalls = false;
      if (assistantText.length > 0) {
        history.push({ role: "assistant", content: assistantText });
        lastAssistantText = assistantText;
      }
      break;
    }

    endedOnToolCalls = true;

    // Record assistant message with tool calls
    history.push({
      role: "assistant",
      content: assistantText.length > 0 ? assistantText : undefined,
      toolCalls,
    });
    if (assistantText.length > 0) lastAssistantText = assistantText;

    // Classify tools by risk level
    const readOnlyCalls: TransportToolCall[] = [];
    const writeCalls: TransportToolCall[] = [];
    for (const call of toolCalls) {
      const tool = toolIndex.get(call.name);
      if (tool && tool.risk === "read") {
        readOnlyCalls.push(call);
      } else {
        writeCalls.push(call);
      }
    }

    // Execute tools and collect results keyed by ID
    const resultMap = new Map<string, ToolResult>();

    // Read-only tools in parallel
    const readResultsRaw = await Promise.allSettled(
      readOnlyCalls.map(async (call) => {
        input.onEvent?.({ kind: "tool-started", toolName: call.name, toolId: call.id });
        const result = await executeTool(call, toolIndex, toolContext);
        input.onEvent?.({
          kind: "tool-completed",
          toolName: call.name,
          toolId: call.id,
          success: result.success,
          ...(result.success ? {} : { error: result.output }),
        });
        return { id: call.id, result };
      }),
    );
    for (const r of readResultsRaw) {
      if (r.status === "fulfilled") {
        resultMap.set(r.value.id, r.value.result);
      }
    }

    // Write tools sequentially
    for (const call of writeCalls) {
      input.onEvent?.({ kind: "tool-started", toolName: call.name, toolId: call.id });
      const result = await executeTool(call, toolIndex, toolContext);
      input.onEvent?.({
        kind: "tool-completed",
        toolName: call.name,
        toolId: call.id,
        success: result.success,
        ...(result.success ? {} : { error: result.output }),
      });
      resultMap.set(call.id, result);
    }

    // Reconstruct results in original tool call order
    const toolResults: Array<{ id: string; name: string; result: string }> = [];
    for (const call of toolCalls) {
      const toolResult = resultMap.get(call.id) ?? {
        output: `Tool '${call.name}' produced no result.`,
        success: false,
      };
      toolResults.push({ id: call.id, name: call.name, result: toolResult.output });
      allToolResults.push({
        id: call.id,
        name: call.name,
        arguments: call.arguments,
        result: toolResult.output,
      });
    }

    history.push({ role: "tool", toolResults });
  }

  if (stopReason === "completed" && (maxRounds === 0 || endedOnToolCalls)) {
    stopReason = "max-rounds";
  }
  if (stopReason === "completed" && signal?.aborted) {
    stopReason = "interrupted";
  }

  return {
    text: lastAssistantText,
    toolCalls: allToolResults,
    usage: totalUsage,
    stopReason,
    history,
  };
}

/**
 * Parse tool call arguments from JSON string. Returns empty object on parse failure.
 */
function safeParseArgs(raw: string): { args: Record<string, unknown>; error?: string } {
  try {
    return { args: JSON.parse(raw) as Record<string, unknown> };
  } catch {
    return { args: {}, error: `Malformed JSON in tool arguments: ${raw.substring(0, 100)}` };
  }
}

function waitForRetry(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    timer = setTimeout(finish, ms);
    if (signal?.aborted) finish();
    else signal?.addEventListener("abort", finish, { once: true });
  });
}

/**
 * Execute a single tool call, returning the result string.
 */
async function executeTool(
  call: TransportToolCall,
  toolIndex: Map<string, AgentTool>,
  context: AgentToolContext,
): Promise<ToolResult> {
  const tool = toolIndex.get(call.name);
  if (!tool) {
    return {
      output: `Unknown tool '${call.name}'. Available tools: ${[...toolIndex.keys()].join(", ")}`,
      success: false,
    };
  }

  const { args, error: parseError } = safeParseArgs(call.arguments);
  if (parseError) {
    return { output: parseError, success: false };
  }

  if (tool.validate) {
    const validationError = tool.validate(args);
    if (validationError) {
      return { output: `Validation error: ${validationError}`, success: false };
    }
  }

  try {
    const result = await tool.execute(args, context);
    return result;
  } catch (cause) {
    return { output: `Tool '${tool.id}' failed: ${String(cause)}`, success: false };
  }
}

/**
 * Apply a stream event to the accumulating tool calls map.
 */
function applyStreamEvent(
  event: TransportStreamEvent,
  toolCallsMap: Map<string, { name: string; args: string }>,
  toolCallIdsByIndex: Map<number, string>,
  toolCallIdsByItemId: Map<string, string>,
  nextIndex: () => number,
): void {
  if (event.kind === "tool-call" || event.kind === "tool-call-delta") {
    const index = event.toolCallIndex;
    const knownId = index === undefined ? undefined : toolCallIdsByIndex.get(index);
    const knownItemId =
      event.toolItemId === undefined ? undefined : toolCallIdsByItemId.get(event.toolItemId);
    // Some OpenAI-compatible streams (including SenseNova) repeat tool-call
    // chunks with empty IDs/names. Treat those as omitted so they merge into
    // the call established by the first non-empty chunk.
    const eventId = event.toolCallId?.trim() || undefined;
    const eventName = event.toolName?.trim() || undefined;
    const id = eventId ?? knownItemId ?? knownId ?? `tool-${index ?? nextIndex()}`;
    if (index !== undefined) toolCallIdsByIndex.set(index, id);
    if (event.toolItemId !== undefined) toolCallIdsByItemId.set(event.toolItemId, id);
    const existing = toolCallsMap.get(id) ?? { name: "", args: "" };
    toolCallsMap.set(id, {
      name: eventName ?? existing.name,
      args: existing.args + (event.toolArgumentsJson ?? event.toolArgumentsDelta ?? ""),
    });
  }
}
