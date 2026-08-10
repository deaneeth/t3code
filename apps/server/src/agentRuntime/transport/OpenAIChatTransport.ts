/**
 * OpenAI Chat Completions transport.
 *
 * Handles providers that use the /chat/completions endpoint:
 * SenseNova, OpenRouter, Groq, Together, DeepSeek, xAI, Mistral, etc.
 *
 * @module agentRuntime/transport/OpenAIChatTransport
 */
import type {
  LLMTransport,
  TransportRequest,
  TransportRequestPlan,
  TransportStreamEvent,
  TransportToolCall,
  TransportUsage,
  TransportModelRecord,
  TransportError,
} from "./LLMTransport.ts";

export class OpenAIChatTransport implements LLMTransport {
  readonly providerKind = "openai" as const;
  readonly protocol = "openai-chat-completions" as const;

  buildRequest(input: {
    readonly request: TransportRequest;
    readonly baseUrl: string;
    readonly headers: Readonly<Record<string, string>>;
  }): TransportRequestPlan | undefined {
    const { request, baseUrl, headers } = input;
    const messages = this.buildMessages(request);
    const body: Record<string, unknown> = {
      model: request.model,
      stream: request.stream,
      messages,
    };

    for (const opt of request.options ?? []) {
      if (opt.id === "temperature" && typeof opt.value === "string") {
        const value = Number(opt.value);
        if (Number.isFinite(value)) body.temperature = value;
      }
      if (opt.id === "maxOutputTokens" && typeof opt.value === "string") {
        const value = Number(opt.value);
        if (Number.isFinite(value) && value > 0) body.max_tokens = value;
      }
      if (opt.id === "reasoningEffort" && typeof opt.value === "string") {
        body.reasoning_effort = opt.value;
      }
    }

    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools;
      body.tool_choice = "auto";
      body.parallel_tool_calls = true;
      body.stream_options = { include_usage: true };
    }

    return {
      url: `${baseUrl}/chat/completions`,
      headers,
      body,
    };
  }

  parseResponse(payload: unknown): { text: string; toolCalls: ReadonlyArray<TransportToolCall> } {
    if (!payload || typeof payload !== "object") return { text: "", toolCalls: [] };
    const root = payload as Record<string, unknown>;
    const choices = Array.isArray(root.choices) ? root.choices : [];
    const message =
      choices[0] && typeof choices[0] === "object"
        ? (choices[0] as Record<string, unknown>).message
        : undefined;

    let text = "";
    if (message && typeof message === "object") {
      const content = (message as Record<string, unknown>).content;
      if (typeof content === "string") text = content;
    }

    const toolCalls = this.extractToolCalls(message);
    return { text, toolCalls };
  }

  parseSseEvents(block: string): ReadonlyArray<TransportStreamEvent> {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("\n");
    if (!data || data === "[DONE]") return data === "[DONE]" ? [{ kind: "done" }] : [];

    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return [{ kind: "error", error: "Malformed SSE JSON." }];
    }
    if (!parsed || typeof parsed !== "object") return [];

    let record = parsed as Record<string, unknown>;
    if (record.data && typeof record.data === "object" && !Array.isArray(record.data)) {
      const nested = record.data as Record<string, unknown>;
      if (nested.choices || nested.usage) record = nested;
    }

    const result: TransportStreamEvent[] = [];
    const choices = Array.isArray(record.choices) ? record.choices[0] : undefined;
    const choiceDelta =
      choices && typeof choices === "object"
        ? (choices as Record<string, unknown>).delta
        : undefined;
    const choiceText =
      typeof choiceDelta === "string"
        ? choiceDelta
        : choiceDelta && typeof choiceDelta === "object"
          ? (choiceDelta as Record<string, unknown>).content
          : undefined;

    const choiceToolCalls =
      choiceDelta && typeof choiceDelta === "object"
        ? (choiceDelta as Record<string, unknown>).tool_calls
        : undefined;
    if (Array.isArray(choiceToolCalls)) {
      for (const [index, call] of choiceToolCalls.entries()) {
        if (!call || typeof call !== "object") continue;
        const fn = (call as Record<string, unknown>).function;
        const functionObj =
          fn && typeof fn === "object" ? (fn as Record<string, unknown>) : undefined;
        const id =
          typeof (call as Record<string, unknown>).id === "string"
            ? ((call as Record<string, unknown>).id as string)
            : undefined;
        const name = typeof functionObj?.name === "string" ? functionObj.name : undefined;
        const args = typeof functionObj?.arguments === "string" ? functionObj.arguments : undefined;
        result.push({
          kind: args ? "tool-call-delta" : "tool-call",
          toolCallIndex: index,
          ...(id !== undefined ? { toolCallId: id } : {}),
          ...(name !== undefined ? { toolName: name } : {}),
          ...(args !== undefined ? { toolArgumentsDelta: args } : {}),
        });
      }
    }

    const delta =
      record.delta && typeof record.delta === "object"
        ? (record.delta as Record<string, unknown>)
        : undefined;
    const text =
      typeof delta?.text === "string"
        ? delta.text
        : typeof choiceText === "string"
          ? choiceText
          : typeof record.text === "string"
            ? record.text
            : undefined;
    if (text) result.push({ kind: "text-delta", text });

    const usage =
      record.usage && typeof record.usage === "object"
        ? (record.usage as Record<string, unknown>)
        : undefined;
    if (usage) {
      const normalized = this.normalizeUsageObj(usage);
      if (normalized) result.push({ kind: "usage", usage: normalized });
    }

    return result;
  }

  normalizeUsage(payload: unknown): TransportUsage | undefined {
    if (!payload || typeof payload !== "object") return undefined;
    let root = payload as Record<string, unknown>;
    if (root.data && typeof root.data === "object" && !Array.isArray(root.data)) {
      root = root.data as Record<string, unknown>;
    }
    const usage =
      root.usage && typeof root.usage === "object" ? (root.usage as Record<string, unknown>) : root;
    return this.normalizeUsageObj(usage);
  }

  normalizeError(body: string, status: number): TransportError {
    const compact = body.replace(/\s+/gu, " ").trim();
    let message = `HTTP ${status}`;
    let code: string | undefined;
    try {
      const parsed: unknown = JSON.parse(body);
      if (parsed && typeof parsed === "object") {
        const root = parsed as Record<string, unknown>;
        const error =
          root.error && typeof root.error === "object"
            ? (root.error as Record<string, unknown>)
            : undefined;
        const msg = [error?.message, root.message, error?.detail, root.detail].find(
          (v): v is string => typeof v === "string" && v.trim().length > 0,
        );
        code = [error?.code, root.code, error?.type, root.type].find(
          (v): v is string => typeof v === "string" && v.trim().length > 0,
        );
        if (msg) message = `HTTP ${status}: ${msg.trim()}`;
      }
    } catch {
      // Not JSON
    }
    return {
      message: code !== undefined ? `${message} (${code})` : message,
      status,
      retryable: status === 429 || status >= 500,
      ...(code !== undefined ? { code } : {}),
    };
  }

  buildDiscoveryRequest(input: {
    readonly request: TransportRequest;
    readonly baseUrl: string;
    readonly headers: Readonly<Record<string, string>>;
  }):
    | {
        readonly url: string;
        readonly headers: Record<string, string>;
        readonly body: Record<string, unknown>;
      }
    | undefined {
    return {
      url: `${input.baseUrl}/models`,
      headers: { ...input.headers },
      body: {},
    };
  }

  normalizeModelList(payload: unknown): ReadonlyArray<TransportModelRecord> {
    if (!payload || typeof payload !== "object") return [];
    const data = (payload as Record<string, unknown>).data;
    if (!Array.isArray(data)) return [];
    const seen = new Set<string>();
    return data.flatMap((value) => {
      if (!value || typeof value !== "object") return [];
      const record = value as Record<string, unknown>;
      const id = typeof record.id === "string" ? record.id.trim() : "";
      if (!id || seen.has(id)) return [];
      seen.add(id);
      const name = typeof record.name === "string" && record.name.trim() ? record.name.trim() : id;
      const contextWindow =
        typeof record.context_window === "number"
          ? record.context_window
          : typeof record.contextWindow === "number"
            ? record.contextWindow
            : typeof record.context_length === "number"
              ? record.context_length
              : undefined;
      const maxOutputTokens =
        typeof record.max_output_tokens === "number"
          ? record.max_output_tokens
          : typeof record.maxOutputTokens === "number"
            ? record.maxOutputTokens
            : undefined;
      const result: TransportModelRecord = { id, name };
      if (contextWindow !== undefined)
        (result as { contextWindow?: number }).contextWindow = contextWindow;
      if (maxOutputTokens !== undefined)
        (result as { maxOutputTokens?: number }).maxOutputTokens = maxOutputTokens;
      return [result];
    });
  }

  private normalizeUsageObj(usage: Record<string, unknown>): TransportUsage | undefined {
    const result: Record<string, number> = {};
    if (typeof usage.prompt_tokens === "number") result.inputTokens = usage.prompt_tokens as number;
    if (typeof usage.cached_input_tokens === "number")
      result.cachedInputTokens = usage.cached_input_tokens as number;
    if (typeof usage.output_tokens === "number")
      result.outputTokens = usage.output_tokens as number;
    if (typeof usage.completion_tokens === "number")
      result.outputTokens = usage.completion_tokens as number;
    if (typeof usage.reasoning_tokens === "number")
      result.reasoningOutputTokens = usage.reasoning_tokens as number;
    if (typeof usage.cost_usd === "number") result.providerCostUsd = usage.cost_usd as number;
    return Object.keys(result).length > 0 ? (result as TransportUsage) : undefined;
  }

  private buildMessages(request: TransportRequest): Array<Record<string, unknown>> {
    const messages: Array<Record<string, unknown>> = [];
    for (const entry of request.history) {
      if (entry.role === "system") {
        if (entry.content !== undefined) {
          messages.push({ role: "system", content: entry.content });
        }
      } else if (entry.role === "user") {
        messages.push({ role: "user", content: entry.content });
      } else if (entry.role === "assistant") {
        messages.push({
          role: "assistant",
          ...(entry.content !== undefined ? { content: entry.content } : { content: null }),
          ...(entry.toolCalls && entry.toolCalls.length > 0
            ? {
                tool_calls: entry.toolCalls.map((call) => ({
                  id: call.id,
                  type: "function",
                  function: { name: call.name, arguments: call.arguments },
                })),
              }
            : {}),
        });
      } else if (entry.toolResults) {
        for (const result of entry.toolResults) {
          messages.push({
            role: "tool",
            content: result.result,
            tool_call_id: result.id,
          });
        }
      }
    }
    if (request.text || (request.attachments && request.attachments.length > 0)) {
      if (!request.attachments || request.attachments.length === 0) {
        messages.push({ role: "user", content: request.text });
      } else {
        messages.push({
          role: "user",
          content: [
            { type: "text", text: request.text },
            ...request.attachments.map((attachment) => ({
              type: "image_url",
              image_url: {
                url: `data:${attachment.mimeType};base64,${attachment.data}`,
              },
            })),
          ],
        });
      }
    }
    return messages;
  }

  private extractToolCalls(message: unknown): ReadonlyArray<TransportToolCall> {
    if (!message || typeof message !== "object") return [];
    const calls = (message as Record<string, unknown>).tool_calls;
    if (!Array.isArray(calls)) return [];
    return calls.flatMap((call, index) => {
      if (!call || typeof call !== "object") return [];
      const record = call as Record<string, unknown>;
      const fn =
        record.function && typeof record.function === "object"
          ? (record.function as Record<string, unknown>)
          : undefined;
      if (fn && typeof fn.name === "string") {
        return [
          {
            id: typeof record.id === "string" ? record.id : `chat-tool-${index}`,
            name: fn.name,
            arguments: typeof fn.arguments === "string" ? fn.arguments : "{}",
          },
        ];
      }
      return [];
    });
  }
}
