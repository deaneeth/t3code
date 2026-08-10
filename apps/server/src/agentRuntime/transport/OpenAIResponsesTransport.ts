/**
 * OpenAI Responses transport.
 *
 * Handles OpenAI's native Responses API.
 *
 * @module agentRuntime/transport/OpenAIResponsesTransport
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

export class OpenAIResponsesTransport implements LLMTransport {
  readonly providerKind = "openai" as const;
  readonly protocol = "openai-responses" as const;

  buildRequest(input: {
    readonly request: TransportRequest;
    readonly baseUrl: string;
    readonly headers: Readonly<Record<string, string>>;
  }): TransportRequestPlan | undefined {
    const { request, baseUrl, headers } = input;
    const inputItems = this.buildInput(request);
    const tools = request.tools?.map((tool: Record<string, unknown>) => {
      const fn = (tool as Record<string, unknown>).function as Record<string, unknown> | undefined;
      return {
        type: "function",
        name: fn?.name ?? (tool as Record<string, unknown>).name,
        description: fn?.description ?? (tool as Record<string, unknown>).description,
        parameters: fn?.parameters ?? (tool as Record<string, unknown>).parameters,
        strict: false,
      };
    });

    const body: Record<string, unknown> = {
      model: request.model,
      input: inputItems,
      stream: request.stream,
    };

    for (const opt of request.options ?? []) {
      if (opt.id === "maxOutputTokens" && typeof opt.value === "string") {
        const value = Number(opt.value);
        if (Number.isFinite(value) && value > 0) body.max_output_tokens = value;
      }
      if (opt.id === "reasoningEffort" && typeof opt.value === "string") {
        body.reasoning = { effort: opt.value };
      }
      if (opt.id === "parallelToolCalls" && typeof opt.value === "boolean") {
        body.parallel_tool_calls = opt.value;
      }
    }

    if (tools && tools.length > 0) body.tools = tools;

    return { url: `${baseUrl}/responses`, headers, body };
  }

  parseResponse(payload: unknown): { text: string; toolCalls: ReadonlyArray<TransportToolCall> } {
    if (!payload || typeof payload !== "object") return { text: "", toolCalls: [] };
    const root = payload as Record<string, unknown>;

    let text = typeof root.output_text === "string" ? root.output_text : "";
    if (!text && Array.isArray(root.output)) {
      for (const item of root.output) {
        if (!item || typeof item !== "object") continue;
        const record = item as Record<string, unknown>;
        if (typeof record.text === "string") text += record.text;
      }
    }

    const toolCalls = this.extractToolCalls(root);
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
    const record = parsed as Record<string, unknown>;
    const type = typeof record.type === "string" ? record.type : "";
    const result: TransportStreamEvent[] = [];

    if (type === "response.function_call_arguments.delta") {
      const deltaValue = record.delta;
      if (typeof deltaValue === "string") {
        result.push({
          kind: "tool-call-delta",
          toolArgumentsDelta: deltaValue,
          ...(typeof record.item_id === "string" ? { toolItemId: record.item_id } : {}),
        });
      }
    }

    if (type === "response.output_item.added") {
      const item =
        record.item && typeof record.item === "object"
          ? (record.item as Record<string, unknown>)
          : undefined;
      if (item?.type === "function_call") {
        result.push({
          kind: "tool-call",
          ...(typeof item.call_id === "string"
            ? { toolCallId: item.call_id }
            : typeof item.id === "string"
              ? { toolCallId: item.id }
              : {}),
          ...(typeof item.id === "string" && typeof item.call_id === "string"
            ? { toolItemId: item.id }
            : {}),
          ...(typeof item.name === "string" ? { toolName: item.name } : {}),
          ...(typeof item.arguments === "string" ? { toolArgumentsJson: item.arguments } : {}),
        });
      }
    }

    if (type === "response.output_text.delta" && typeof record.delta === "string") {
      result.push({ kind: "text-delta", text: record.delta });
    }

    if (type.includes("completed") || type.includes("done")) result.push({ kind: "done" });

    const completedResponse =
      record.response && typeof record.response === "object"
        ? (record.response as Record<string, unknown>)
        : undefined;
    const usage =
      record.usage && typeof record.usage === "object"
        ? (record.usage as Record<string, unknown>)
        : completedResponse?.usage && typeof completedResponse.usage === "object"
          ? (completedResponse.usage as Record<string, unknown>)
          : undefined;
    if (usage) {
      const normalized = this.normalizeUsageObj(usage);
      if (normalized) result.push({ kind: "usage", usage: normalized });
    }

    return result;
  }

  normalizeUsage(payload: unknown): TransportUsage | undefined {
    if (!payload || typeof payload !== "object") return undefined;
    const usage = payload as Record<string, unknown>;
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
        const msg = [error?.message, root.message].find(
          (v): v is string => typeof v === "string" && v.trim().length > 0,
        );
        code = [error?.code, root.code, error?.type].find(
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
    return { url: `${input.baseUrl}/models`, headers: { ...input.headers }, body: {} };
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
      return [{ id, name: id }];
    });
  }

  private normalizeUsageObj(usage: Record<string, unknown>): TransportUsage | undefined {
    const result: Record<string, number> = {};
    if (typeof usage.input_tokens === "number") result.inputTokens = usage.input_tokens as number;
    if (typeof usage.output_tokens === "number")
      result.outputTokens = usage.output_tokens as number;
    if (typeof usage.cached_input_tokens === "number")
      result.cachedInputTokens = usage.cached_input_tokens as number;
    if (typeof usage.reasoning_tokens === "number")
      result.reasoningOutputTokens = usage.reasoning_tokens as number;
    if (typeof usage.cost_usd === "number") result.providerCostUsd = usage.cost_usd as number;
    return Object.keys(result).length > 0 ? (result as TransportUsage) : undefined;
  }

  private buildInput(request: TransportRequest): Array<Record<string, unknown>> {
    const items: Array<Record<string, unknown>> = [];
    for (const entry of request.history) {
      if (entry.role === "system") {
        if (entry.content !== undefined) {
          items.push({
            role: "system",
            content:
              typeof entry.content === "string" ? entry.content : JSON.stringify(entry.content),
          });
        }
      } else if (entry.role === "user") {
        items.push({
          role: "user",
          content: Array.isArray(entry.content)
            ? entry.content
            : [
                {
                  type: "input_text",
                  text: typeof entry.content === "string" ? entry.content : "",
                },
              ],
        });
      } else if (entry.role === "assistant") {
        if (typeof entry.content === "string" && entry.content.length > 0) {
          items.push({
            role: "assistant",
            content: [{ type: "output_text", text: entry.content }],
          });
        }
        for (const call of entry.toolCalls ?? []) {
          items.push({
            type: "function_call",
            call_id: call.id,
            name: call.name,
            arguments: call.arguments,
          });
        }
      } else if (entry.toolResults) {
        for (const result of entry.toolResults) {
          items.push({
            type: "function_call_output",
            call_id: result.id,
            output: result.result,
          });
        }
      }
    }
    if (request.text || (request.attachments && request.attachments.length > 0)) {
      const content: Array<Record<string, unknown>> = [{ type: "input_text", text: request.text }];
      for (const attachment of request.attachments ?? []) {
        content.push({
          type: "input_image",
          image_url: `data:${attachment.mimeType};base64,${attachment.data}`,
        });
      }
      items.push({ role: "user", content });
    }
    return items;
  }

  private extractToolCalls(root: Record<string, unknown>): ReadonlyArray<TransportToolCall> {
    if (!Array.isArray(root.output)) return [];
    return root.output.flatMap((item, index) => {
      if (!item || typeof item !== "object") return [];
      const record = item as Record<string, unknown>;
      if (record.type === "function_call" && typeof record.name === "string") {
        return [
          {
            id: typeof record.call_id === "string" ? record.call_id : `responses-tool-${index}`,
            name: record.name,
            arguments: typeof record.arguments === "string" ? record.arguments : "{}",
          },
        ];
      }
      return [];
    });
  }
}
