/**
 * Google Gemini transport.
 *
 * Handles Gemini's generateContent/streamGenerateContent API.
 *
 * @module agentRuntime/transport/GeminiTransport
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

export class GeminiTransport implements LLMTransport {
  readonly providerKind = "gemini" as const;
  readonly protocol = "gemini-generate-content" as const;

  buildRequest(input: {
    readonly request: TransportRequest;
    readonly baseUrl: string;
    readonly headers: Readonly<Record<string, string>>;
  }): TransportRequestPlan | undefined {
    const { request, baseUrl, headers } = input;
    const contents = this.buildContents(request);
    const systemInstruction = this.buildSystemInstruction(request);
    const tools = request.tools?.map((tool: Record<string, unknown>) => {
      const fn = (tool as Record<string, unknown>).function as Record<string, unknown> | undefined;
      return {
        name: fn?.name ?? (tool as Record<string, unknown>).name,
        description: fn?.description ?? (tool as Record<string, unknown>).description,
        parameters: fn?.parameters ?? (tool as Record<string, unknown>).parameters,
      };
    });

    const body: Record<string, unknown> = { contents };
    if (systemInstruction) body.systemInstruction = { parts: [{ text: systemInstruction }] };
    const generationConfig: Record<string, unknown> = {};
    for (const opt of request.options ?? []) {
      if (opt.id === "temperature" && typeof opt.value === "string") {
        const value = Number(opt.value);
        if (Number.isFinite(value)) generationConfig.temperature = value;
      }
      if (opt.id === "maxOutputTokens" && typeof opt.value === "string") {
        const value = Number(opt.value);
        if (Number.isFinite(value) && value > 0) generationConfig.maxOutputTokens = value;
      }
    }
    if (Object.keys(generationConfig).length > 0) body.generationConfig = generationConfig;
    if (tools && tools.length > 0) {
      body.tools = [{ functionDeclarations: tools }];
    }

    const endpoint = request.stream
      ? `${baseUrl}/models/${encodeURIComponent(request.model)}:streamGenerateContent?alt=sse`
      : `${baseUrl}/models/${encodeURIComponent(request.model)}:generateContent`;

    return { url: endpoint, headers, body };
  }

  parseResponse(payload: unknown): { text: string; toolCalls: ReadonlyArray<TransportToolCall> } {
    if (!payload || typeof payload !== "object") return { text: "", toolCalls: [] };
    const root = payload as Record<string, unknown>;
    let text = "";
    const toolCalls: TransportToolCall[] = [];

    if (Array.isArray(root.candidates)) {
      for (const candidate of root.candidates) {
        if (!candidate || typeof candidate !== "object") continue;
        const content = (candidate as Record<string, unknown>).content;
        const parts =
          content && typeof content === "object"
            ? (content as Record<string, unknown>).parts
            : undefined;
        if (Array.isArray(parts)) {
          for (const [index, part] of parts.entries()) {
            if (!part || typeof part !== "object") continue;
            const p = part as Record<string, unknown>;
            if (typeof p.text === "string") text += p.text;
            const fc = p.functionCall;
            if (
              fc &&
              typeof fc === "object" &&
              typeof (fc as Record<string, unknown>).name === "string"
            ) {
              toolCalls.push({
                id: `gemini-tool-${index}`,
                name: (fc as Record<string, unknown>).name as string,
                arguments: JSON.stringify((fc as Record<string, unknown>).args ?? {}),
              });
            }
          }
        }
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
    const result: TransportStreamEvent[] = [];

    const candidates = Array.isArray(record.candidates) ? record.candidates : [];
    for (const candidate of candidates) {
      if (!candidate || typeof candidate !== "object") continue;
      const content = (candidate as Record<string, unknown>).content;
      const parts =
        content && typeof content === "object"
          ? (content as Record<string, unknown>).parts
          : undefined;
      if (Array.isArray(parts)) {
        for (const [index, part] of parts.entries()) {
          if (!part || typeof part !== "object") continue;
          const p = part as Record<string, unknown>;
          if (typeof p.text === "string") result.push({ kind: "text-delta", text: p.text });
          const fc = p.functionCall;
          if (fc && typeof fc === "object") {
            const call = fc as Record<string, unknown>;
            result.push({
              kind: "tool-call",
              toolCallIndex: index,
              ...(typeof call.name === "string" ? { toolName: call.name } : {}),
              ...(call.args && typeof call.args === "object"
                ? { toolArgumentsJson: JSON.stringify(call.args) }
                : {}),
            });
          }
        }
      }
    }

    const usage =
      record.usageMetadata && typeof record.usageMetadata === "object"
        ? (record.usageMetadata as Record<string, unknown>)
        : undefined;
    if (usage) {
      const normalized = this.normalizeUsageObj(usage);
      if (normalized) result.push({ kind: "usage", usage: normalized });
    }

    return result;
  }

  normalizeUsage(payload: unknown): TransportUsage | undefined {
    if (!payload || typeof payload !== "object") return undefined;
    const root = payload as Record<string, unknown>;
    const usage =
      root.usageMetadata && typeof root.usageMetadata === "object"
        ? (root.usageMetadata as Record<string, unknown>)
        : root;
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
        code = [error?.code, error?.status].find(
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
    const models = (payload as Record<string, unknown>).models;
    if (!Array.isArray(models)) return [];
    const seen = new Set<string>();
    return models.flatMap((value) => {
      if (!value || typeof value !== "object") return [];
      const record = value as Record<string, unknown>;
      const name = typeof record.name === "string" ? record.name.replace(/^models\//, "") : "";
      const methods = Array.isArray(record.supportedGenerationMethods)
        ? record.supportedGenerationMethods
        : [];
      if (
        name &&
        !seen.has(name) &&
        (methods.length === 0 || methods.includes("generateContent"))
      ) {
        seen.add(name);
        return [{ id: name, name }];
      }
      return [];
    });
  }

  private normalizeUsageObj(usage: Record<string, unknown>): TransportUsage | undefined {
    const result: Record<string, number> = {};
    if (typeof usage.promptTokenCount === "number")
      result.inputTokens = usage.promptTokenCount as number;
    if (typeof usage.candidatesTokenCount === "number")
      result.outputTokens = usage.candidatesTokenCount as number;
    if (typeof usage.cachedContentTokenCount === "number")
      result.cachedInputTokens = usage.cachedContentTokenCount as number;
    return Object.keys(result).length > 0 ? (result as TransportUsage) : undefined;
  }

  private buildSystemInstruction(request: TransportRequest): string | undefined {
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

  private buildContents(request: TransportRequest): Array<Record<string, unknown>> {
    const contents: Array<Record<string, unknown>> = [];
    for (const entry of request.history) {
      if (entry.role === "system") {
        // System prompts belong in body.systemInstruction (see buildSystemInstruction).
        continue;
      } else if (entry.role === "user") {
        contents.push({
          role: "user",
          parts: Array.isArray(entry.content)
            ? entry.content
            : [{ text: typeof entry.content === "string" ? entry.content : "" }],
        });
      } else if (entry.role === "assistant") {
        const parts: Array<Record<string, unknown>> = [];
        if (typeof entry.content === "string" && entry.content.length > 0) {
          parts.push({ text: entry.content });
        }
        for (const call of entry.toolCalls ?? []) {
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(call.arguments);
          } catch {
            /* keep empty */
          }
          parts.push({ functionCall: { name: call.name, args } });
        }
        contents.push({ role: "model", parts });
      } else if (entry.toolResults) {
        contents.push({
          role: "user",
          parts: entry.toolResults.map((r) => ({
            functionResponse: { name: r.name, response: { result: r.result } },
          })),
        });
      }
    }
    if (request.text || (request.attachments && request.attachments.length > 0)) {
      const parts: Array<Record<string, unknown>> = [{ text: request.text }];
      for (const attachment of request.attachments ?? []) {
        parts.push({ inlineData: { mimeType: attachment.mimeType, data: attachment.data } });
      }
      contents.push({ role: "user", parts });
    }
    return contents;
  }
}
