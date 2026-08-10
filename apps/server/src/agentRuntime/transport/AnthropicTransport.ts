/**
 * Anthropic Messages transport.
 *
 * Handles Anthropic's native Messages API.
 *
 * @module agentRuntime/transport/AnthropicTransport
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

export class AnthropicTransport implements LLMTransport {
  readonly providerKind = "anthropic" as const;
  readonly protocol = "anthropic-messages" as const;

  buildRequest(input: {
    readonly request: TransportRequest;
    readonly baseUrl: string;
    readonly headers: Readonly<Record<string, string>>;
  }): TransportRequestPlan | undefined {
    const { request, baseUrl, headers } = input;
    const messages = this.buildMessages(request);
    const system = this.buildSystem(request);
    const tools = request.tools?.map((tool: Record<string, unknown>) => {
      const fn = (tool as Record<string, unknown>).function as Record<string, unknown> | undefined;
      return {
        name: fn?.name ?? (tool as Record<string, unknown>).name,
        description: fn?.description ?? (tool as Record<string, unknown>).description,
        input_schema: fn?.parameters ?? (tool as Record<string, unknown>).input_schema,
      };
    });

    let maxTokens = 4096;
    for (const opt of request.options ?? []) {
      if (opt.id === "maxOutputTokens" && typeof opt.value === "string") {
        const value = Number(opt.value);
        if (Number.isFinite(value) && value > 0) maxTokens = value;
      }
    }

    const body: Record<string, unknown> = {
      model: request.model,
      max_tokens: maxTokens,
      stream: request.stream,
      messages,
    };
    if (system) body.system = system;
    if (tools && tools.length > 0) body.tools = tools;
    for (const opt of request.options ?? []) {
      if (opt.id === "temperature" && typeof opt.value === "string") {
        const value = Number(opt.value);
        if (Number.isFinite(value)) body.temperature = value;
      }
    }

    return {
      url: `${baseUrl}/messages`,
      headers: {
        ...headers,
        "anthropic-version": "2023-06-01",
      },
      body,
    };
  }

  parseResponse(payload: unknown): { text: string; toolCalls: ReadonlyArray<TransportToolCall> } {
    if (!payload || typeof payload !== "object") return { text: "", toolCalls: [] };
    const root = payload as Record<string, unknown>;
    const content = Array.isArray(root.content) ? root.content : [];
    let text = "";
    const toolCalls: TransportToolCall[] = [];
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const b = block as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string") text += b.text;
      if (b.type === "tool_use" && typeof b.id === "string" && typeof b.name === "string") {
        toolCalls.push({
          id: b.id,
          name: b.name,
          arguments: JSON.stringify(b.input ?? {}),
        });
      }
    }
    return { text, toolCalls };
  }

  parseSseEvents(block: string): ReadonlyArray<TransportStreamEvent> {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("\n");
    if (!data) return [];

    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return [{ kind: "error", error: "Malformed SSE JSON." }];
    }
    if (!parsed || typeof parsed !== "object") return [];
    const record = parsed as Record<string, unknown>;
    const type = typeof record.type === "string" ? record.type : "";
    const result: TransportStreamEvent[] = [];

    if (type === "content_block_start") {
      const block =
        record.content_block && typeof record.content_block === "object"
          ? (record.content_block as Record<string, unknown>)
          : undefined;
      if (block?.type === "tool_use") {
        result.push({
          kind: "tool-call",
          ...(typeof record.index === "number" ? { toolCallIndex: record.index } : {}),
          ...(typeof block.id === "string" ? { toolCallId: block.id } : {}),
          ...(typeof block.name === "string" ? { toolName: block.name } : {}),
        });
      }
    }

    if (type === "content_block_delta") {
      const delta =
        record.delta && typeof record.delta === "object"
          ? (record.delta as Record<string, unknown>)
          : undefined;
      if (delta?.type === "input_json_delta" && typeof delta.partial_json === "string") {
        result.push({
          kind: "tool-call-delta",
          toolArgumentsDelta: delta.partial_json,
          ...(typeof record.index === "number" ? { toolCallIndex: record.index } : {}),
        });
      }
      if (delta?.type === "text_delta" && typeof delta.text === "string") {
        result.push({ kind: "text-delta", text: delta.text });
      }
    }

    if (type.includes("message_stop")) {
      result.push({ kind: "done" });
    }

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
    return this.normalizeUsageObj(payload as Record<string, unknown>);
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
        const msg = [error?.message, root.message].find(
          (v): v is string => typeof v === "string" && v.trim().length > 0,
        );
        code = [error?.type, root.type].find(
          (v): v is string => typeof v === "string" && v.trim().length > 0,
        );
        if (msg) message = `HTTP ${status}: ${msg.trim()}`;
      }
    } catch {
      /* not JSON */
    }
    return {
      message: code !== undefined ? `${message} (${code})` : message,
      status,
      retryable: status === 429 || status >= 500,
      ...(code !== undefined ? { code } : {}),
    };
  }

  buildDiscoveryRequest(_input: {
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
    return undefined;
  }

  normalizeModelList(): ReadonlyArray<TransportModelRecord> {
    return [];
  }

  private normalizeUsageObj(usage: Record<string, unknown>): TransportUsage | undefined {
    const result: Record<string, number> = {};
    if (typeof usage.input_tokens === "number") result.inputTokens = usage.input_tokens as number;
    if (typeof usage.output_tokens === "number")
      result.outputTokens = usage.output_tokens as number;
    if (typeof usage.cache_read_input_tokens === "number")
      result.cachedInputTokens = usage.cache_read_input_tokens as number;
    if (typeof usage.cache_creation_input_tokens === "number")
      result.cacheCreationTokens = usage.cache_creation_input_tokens as number;
    return Object.keys(result).length > 0 ? (result as TransportUsage) : undefined;
  }

  private buildSystem(request: TransportRequest): string | undefined {
    const parts: string[] = [];
    for (const entry of request.history) {
      if (
        entry.role === "system" &&
        typeof entry.content === "string" &&
        entry.content.length > 0
      ) {
        parts.push(entry.content);
      }
    }
    return parts.length > 0 ? parts.join("\n") : undefined;
  }

  private buildMessages(request: TransportRequest): Array<Record<string, unknown>> {
    const messages: Array<Record<string, unknown>> = [];
    for (const entry of request.history) {
      if (entry.role === "system") {
        // System prompts belong in the top-level `system` field (see buildSystem).
        continue;
      } else if (entry.role === "user") {
        messages.push({ role: "user", content: entry.content });
      } else if (entry.role === "assistant") {
        const content: Array<Record<string, unknown>> = [];
        if (typeof entry.content === "string" && entry.content.length > 0) {
          content.push({ type: "text", text: entry.content });
        }
        for (const call of entry.toolCalls ?? []) {
          let input: Record<string, unknown> = {};
          try {
            input = JSON.parse(call.arguments);
          } catch {
            /* keep empty */
          }
          content.push({ type: "tool_use", id: call.id, name: call.name, input });
        }
        messages.push({ role: "assistant", content });
      } else if (entry.toolResults) {
        messages.push({
          role: "user",
          content: entry.toolResults.map((r) => ({
            type: "tool_result",
            tool_use_id: r.id,
            content: r.result,
          })),
        });
      }
    }
    if (request.text || (request.attachments && request.attachments.length > 0)) {
      const userContent: Array<Record<string, unknown>> = [{ type: "text", text: request.text }];
      for (const attachment of request.attachments ?? []) {
        userContent.push({
          type: "image",
          source: { type: "base64", media_type: attachment.mimeType, data: attachment.data },
        });
      }
      messages.push({ role: "user", content: userContent });
    }
    return messages;
  }
}
