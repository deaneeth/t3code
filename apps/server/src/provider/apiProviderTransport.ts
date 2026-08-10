import type { ApiProviderProtocol } from "@t3tools/contracts";

/** A provider response after the HTTP layer has removed transport details. */
export interface ApiProviderModelRecord {
  readonly id: string;
  readonly name: string;
  readonly contextWindow?: number;
  readonly maxOutputTokens?: number;
  readonly supportsTools?: boolean;
  readonly supportsVision?: boolean;
  readonly supportsReasoning?: boolean;
  readonly inputTokenPriceUsd?: number;
  readonly outputTokenPriceUsd?: number;
}

export interface ApiProviderUsageRecord {
  readonly inputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly cacheCreationTokens?: number;
  readonly outputTokens?: number;
  readonly reasoningOutputTokens?: number;
  readonly providerCostUsd?: number;
}

export interface ApiProviderRequestPlan {
  readonly method: "GET" | "POST";
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: Readonly<Record<string, unknown>>;
}

export interface ApiProviderStreamEvent {
  readonly kind: "text-delta" | "tool-call-delta" | "tool-call" | "usage" | "done" | "error";
  readonly text?: string;
  readonly toolCallId?: string;
  readonly toolCallIndex?: number;
  /** Responses API uses an item id for argument deltas and a separate call id for history. */
  readonly toolItemId?: string;
  readonly toolName?: string;
  readonly toolArgumentsJson?: string;
  readonly toolArgumentsDelta?: string;
  readonly usage?: ApiProviderUsageRecord;
  readonly message?: string;
}

export interface ApiProviderToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: string;
}

export interface ApiProviderHistoryEntry {
  readonly role: "user" | "assistant" | "tool";
  readonly content?: unknown;
  readonly toolCalls?: ReadonlyArray<ApiProviderToolCall>;
  readonly toolResults?: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly result: string;
  }>;
}

const trimBaseUrl = (value: string): string => value.trim().replace(/\/+$/, "");

export function resolveApiBaseUrl(input: {
  readonly defaultBaseUrl: string;
  readonly override: string;
}): string {
  return trimBaseUrl(input.override) || trimBaseUrl(input.defaultBaseUrl);
}

export function validateApiBaseUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:")
      return "API base URL must use http or https.";
    if (url.username || url.password) return "API base URL must not contain embedded credentials.";
    return undefined;
  } catch {
    return "API base URL is not a valid URL.";
  }
}

export function apiKeyFingerprint(apiKey: string): string | undefined {
  const normalized = apiKey.trim();
  if (normalized.length === 0) return undefined;
  const suffix = normalized.slice(-4);
  return `••••${suffix}`;
}

/** Never include the secret in an error, log, URL, or serialized request. */
export function redactApiSecret(value: string, apiKey: string): string {
  const normalized = apiKey.trim();
  return normalized.length > 0 ? value.split(normalized).join("[REDACTED]") : value;
}

/** Extract the useful, provider-owned part of a failed HTTP response. */
export function summarizeApiProviderError(body: string, status: number): string {
  const compact = body.replace(/\s+/gu, " ").trim();
  if (compact.length === 0) return `HTTP ${status} with an empty response.`;
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === "object") {
      const root = parsed as Record<string, unknown>;
      const error =
        root.error && typeof root.error === "object"
          ? (root.error as Record<string, unknown>)
          : undefined;
      const message = [error?.message, root.message, error?.detail, root.detail].find(
        (value): value is string => typeof value === "string" && value.trim().length > 0,
      );
      const code = [error?.code, root.code, error?.type, root.type].find(
        (value): value is string => typeof value === "string" && value.trim().length > 0,
      );
      if (message && code) return `HTTP ${status}: ${message.trim()} (${code.trim()}).`;
      if (message) return `HTTP ${status}: ${message.trim()}.`;
    }
  } catch {
    // Some compatible providers return plain text or malformed JSON.
  }
  return `HTTP ${status}: ${compact.slice(0, 500)}`;
}

export function buildAuthHeaders(input: {
  readonly apiKey: string;
  readonly apiKeyHeader: string;
  readonly apiKeyPrefix?: string;
}): Readonly<Record<string, string>> {
  const key = input.apiKey.trim();
  if (key.length === 0) return {};
  return {
    [input.apiKeyHeader]: input.apiKeyPrefix ? `${input.apiKeyPrefix}${key}` : key,
  };
}

function normalizeModel(value: unknown): ApiProviderModelRecord | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id.trim() : "";
  if (id.length === 0) return undefined;
  const name = typeof record.name === "string" && record.name.trim() ? record.name.trim() : id;
  const contextWindow =
    typeof record.context_window === "number"
      ? record.context_window
      : typeof record.contextWindow === "number"
        ? record.contextWindow
        : typeof record.context_length === "number"
          ? record.context_length
          : typeof record.max_context_length === "number"
            ? record.max_context_length
            : undefined;
  const maxOutputTokens =
    typeof record.max_output_length === "number"
      ? record.max_output_length
      : typeof record.maxOutputTokens === "number"
        ? record.maxOutputTokens
        : typeof record.max_output_tokens === "number"
          ? record.max_output_tokens
          : undefined;
  const supportedFeatures = Array.isArray(record.supported_features)
    ? record.supported_features.filter((feature): feature is string => typeof feature === "string")
    : [];
  const inputModalities = Array.isArray(record.input_modalities)
    ? record.input_modalities.filter((modality): modality is string => typeof modality === "string")
    : [];
  return {
    id,
    name,
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    ...(supportedFeatures.length > 0
      ? {
          supportsTools: supportedFeatures.includes("tools"),
          supportsReasoning: supportedFeatures.includes("reasoning"),
        }
      : {}),
    ...(inputModalities.length > 0 ? { supportsVision: inputModalities.includes("image") } : {}),
  };
}

export function normalizeModelList(
  protocol: ApiProviderProtocol,
  payload: unknown,
  options?: { readonly profileId?: string },
): ReadonlyArray<ApiProviderModelRecord> {
  if (protocol === "gemini-generate-content") {
    const models =
      payload && typeof payload === "object"
        ? (payload as Record<string, unknown>).models
        : undefined;
    return Array.isArray(models)
      ? models.flatMap((value) => {
          if (!value || typeof value !== "object") return [];
          const record = value as Record<string, unknown>;
          const name = typeof record.name === "string" ? record.name.replace(/^models\//, "") : "";
          const methods = Array.isArray(record.supportedGenerationMethods)
            ? record.supportedGenerationMethods
            : [];
          return name && (methods.length === 0 || methods.includes("generateContent"))
            ? [{ id: name, name }]
            : [];
        })
      : [];
  }
  const data =
    payload && typeof payload === "object" ? (payload as Record<string, unknown>).data : undefined;
  if (!Array.isArray(data)) return [];
  const seen = new Set<string>();
  return data.flatMap((value) => {
    const model = normalizeModel(value);
    if (!model || seen.has(model.id)) return [];
    // SenseNova U1 Fast is an image-generation model. It is intentionally not
    // offered as a chat/agent model because its documented endpoint is
    // `/images/generations`, not `/chat/completions`.
    if (options?.profileId === "sensenova" && model.id === "sensenova-u1-fast") return [];
    seen.add(model.id);
    return [model];
  });
}

export function normalizeUsagePayload(payload: unknown): ApiProviderUsageRecord | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  let root = payload as Record<string, unknown>;
  if (root.data && typeof root.data === "object" && !Array.isArray(root.data)) {
    root = root.data as Record<string, unknown>;
  }
  if (root.response && typeof root.response === "object" && !Array.isArray(root.response)) {
    root = root.response as Record<string, unknown>;
  }
  const usage =
    root.usage && typeof root.usage === "object" ? (root.usage as Record<string, unknown>) : root;
  const promptTokens = typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : undefined;
  const knowledgeTokens = typeof usage.knowledge_tokens === "number" ? usage.knowledge_tokens : 0;
  const inputTokens =
    typeof usage.input_tokens === "number"
      ? usage.input_tokens
      : promptTokens !== undefined
        ? promptTokens + knowledgeTokens
        : undefined;
  const result: ApiProviderUsageRecord = {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(typeof usage.cached_input_tokens === "number"
      ? { cachedInputTokens: usage.cached_input_tokens }
      : {}),
    ...(typeof usage.output_tokens === "number" ? { outputTokens: usage.output_tokens } : {}),
    ...(typeof usage.completion_tokens === "number"
      ? { outputTokens: usage.completion_tokens }
      : {}),
    ...(typeof usage.reasoning_tokens === "number"
      ? { reasoningOutputTokens: usage.reasoning_tokens }
      : {}),
    ...(typeof usage.cost_usd === "number" ? { providerCostUsd: usage.cost_usd } : {}),
    ...(typeof root.cost === "number" ? { providerCostUsd: root.cost } : {}),
  };
  return Object.keys(result).length > 0 ? result : undefined;
}

/** Read assistant text from the JSON shapes used by the supported protocols. */
export function readApiProviderText(payload: unknown, protocol?: ApiProviderProtocol): string {
  if (!payload || typeof payload !== "object") return "";
  let root = payload as Record<string, unknown>;
  if (root.data && typeof root.data === "object" && !Array.isArray(root.data))
    root = root.data as Record<string, unknown>;
  if (typeof root.output_text === "string") return root.output_text;
  if (Array.isArray(root.output)) {
    return root.output
      .flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const record = item as Record<string, unknown>;
        if (typeof record.text === "string") return [record.text];
        const content = record.content;
        return Array.isArray(content)
          ? content.flatMap((part) =>
              part &&
              typeof part === "object" &&
              typeof (part as Record<string, unknown>).text === "string"
                ? [(part as Record<string, unknown>).text as string]
                : [],
            )
          : [];
      })
      .join("");
  }
  if (Array.isArray(root.content)) {
    return root.content
      .flatMap((part) =>
        part &&
        typeof part === "object" &&
        typeof (part as Record<string, unknown>).text === "string"
          ? [(part as Record<string, unknown>).text as string]
          : [],
      )
      .join("");
  }
  if (protocol === "gemini-generate-content") {
    return Array.isArray(root.candidates)
      ? root.candidates
          .flatMap((candidate) => {
            const content =
              candidate && typeof candidate === "object"
                ? (candidate as Record<string, unknown>).content
                : undefined;
            const parts =
              content && typeof content === "object"
                ? (content as Record<string, unknown>).parts
                : undefined;
            return Array.isArray(parts)
              ? parts.flatMap((part) =>
                  part &&
                  typeof part === "object" &&
                  typeof (part as Record<string, unknown>).text === "string"
                    ? [(part as Record<string, unknown>).text as string]
                    : [],
                )
              : [];
          })
          .join("")
      : "";
  }
  const first = Array.isArray(root.choices) ? root.choices[0] : undefined;
  if (!first || typeof first !== "object") return "";
  const choice = first as Record<string, unknown>;
  if (typeof choice.text === "string") return choice.text;
  if (typeof choice.message === "string") return choice.message;
  if (
    choice.message &&
    typeof choice.message === "object" &&
    typeof (choice.message as Record<string, unknown>).content === "string"
  )
    return (choice.message as Record<string, unknown>).content as string;
  return "";
}

export function modelDiscoveryRequest(input: {
  readonly protocol: ApiProviderProtocol;
  readonly baseUrl: string;
  readonly headers: Readonly<Record<string, string>>;
}): ApiProviderRequestPlan | undefined {
  if (input.baseUrl.includes("sensenova")) {
    const modelPath = input.baseUrl.includes("token.sensenova") ? "/models" : "/llm/models";
    return {
      method: "GET",
      url: `${trimBaseUrl(input.baseUrl)}${modelPath}`,
      headers: input.headers,
    };
  }
  if (input.protocol === "openai-responses" && input.baseUrl.includes("generativelanguage")) {
    return undefined;
  }
  if (input.protocol === "gemini-generate-content") {
    return { method: "GET", url: `${trimBaseUrl(input.baseUrl)}/models`, headers: input.headers };
  }
  return { method: "GET", url: `${trimBaseUrl(input.baseUrl)}/models`, headers: input.headers };
}

export function parseSseBlock(block: string): ApiProviderStreamEvent | undefined {
  return parseSseBlockEvents(block)[0];
}

export function parseSseBlockEvents(block: string): ReadonlyArray<ApiProviderStreamEvent> {
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
    return [{ kind: "error", message: "Provider returned malformed SSE JSON." }];
  }
  if (!parsed || typeof parsed !== "object") return [];
  let record = parsed as Record<string, unknown>;
  if (record.data && typeof record.data === "object" && !Array.isArray(record.data)) {
    const nested = record.data as Record<string, unknown>;
    if (nested.choices || nested.usage) record = nested;
  }
  const type = typeof record.type === "string" ? record.type : "";
  const delta =
    record.delta && typeof record.delta === "object"
      ? (record.delta as Record<string, unknown>)
      : undefined;
  const choices = Array.isArray(record.choices) ? record.choices[0] : undefined;
  const choiceDelta =
    choices && typeof choices === "object" ? (choices as Record<string, unknown>).delta : undefined;
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
  const result: ApiProviderStreamEvent[] = [];
  if (Array.isArray(choiceToolCalls)) {
    for (const [index, call] of choiceToolCalls.entries()) {
      if (!call || typeof call !== "object") continue;
      const functionValue = (call as Record<string, unknown>).function;
      const fn =
        functionValue && typeof functionValue === "object"
          ? (functionValue as Record<string, unknown>)
          : undefined;
      const id =
        typeof (call as Record<string, unknown>).id === "string"
          ? ((call as Record<string, unknown>).id as string)
          : undefined;
      const name = typeof fn?.name === "string" ? fn.name : undefined;
      const args = typeof fn?.arguments === "string" ? fn.arguments : undefined;
      result.push({
        kind: args ? "tool-call-delta" : "tool-call",
        toolCallIndex: index,
        ...(id ? { toolCallId: id } : {}),
        ...(name ? { toolName: name } : {}),
        ...(args ? { toolArgumentsDelta: args } : {}),
      });
    }
  }
  if (type === "response.function_call_arguments.delta") {
    const deltaValue = record.delta;
    if (typeof deltaValue === "string")
      result.push({
        kind: "tool-call-delta",
        toolArgumentsDelta: deltaValue,
        ...(typeof record.item_id === "string" ? { toolCallId: record.item_id } : {}),
      });
  }
  if (type === "response.output_item.added") {
    const item =
      record.item && typeof record.item === "object"
        ? (record.item as Record<string, unknown>)
        : undefined;
    if (item?.type === "function_call")
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
  if (type === "content_block_start") {
    const contentBlock =
      record.content_block && typeof record.content_block === "object"
        ? (record.content_block as Record<string, unknown>)
        : undefined;
    if (contentBlock?.type === "tool_use")
      result.push({
        kind: "tool-call",
        ...(typeof contentBlock.id === "string" ? { toolCallId: contentBlock.id } : {}),
        ...(typeof contentBlock.name === "string" ? { toolName: contentBlock.name } : {}),
      });
  }
  if (type === "content_block_delta") {
    const contentDelta =
      record.delta && typeof record.delta === "object"
        ? (record.delta as Record<string, unknown>)
        : undefined;
    if (contentDelta?.type === "input_json_delta" && typeof contentDelta.partial_json === "string")
      result.push({ kind: "tool-call-delta", toolArgumentsDelta: contentDelta.partial_json });
  }
  if (type === "response.output_text.delta" && typeof record.delta === "string") {
    result.push({ kind: "text-delta", text: record.delta });
  }
  const geminiPart =
    record.candidates &&
    Array.isArray(record.candidates) &&
    record.candidates[0] &&
    typeof record.candidates[0] === "object"
      ? (
          (record.candidates[0] as Record<string, unknown>).content as
            | Record<string, unknown>
            | undefined
        )?.parts
      : undefined;
  if (Array.isArray(geminiPart)) {
    const functionCall = geminiPart.find(
      (part) => part && typeof part === "object" && (part as Record<string, unknown>).functionCall,
    );
    const call =
      functionCall && typeof functionCall === "object"
        ? (functionCall as Record<string, unknown>).functionCall
        : undefined;
    if (call && typeof call === "object") {
      const value = call as Record<string, unknown>;
      result.push({
        kind: "tool-call",
        ...(typeof value.name === "string" ? { toolName: value.name } : {}),
        ...(value.args && typeof value.args === "object"
          ? { toolArgumentsJson: JSON.stringify(value.args) }
          : {}),
      });
    }
  }
  const text =
    typeof delta?.text === "string"
      ? delta.text
      : typeof choiceText === "string"
        ? choiceText
        : typeof record.text === "string"
          ? record.text
          : undefined;
  if (text) result.push({ kind: "text-delta", text });
  if (type.includes("completed") || type.includes("done")) result.push({ kind: "done" });
  const completedResponse =
    record.response && typeof record.response === "object"
      ? (record.response as Record<string, unknown>)
      : undefined;
  const usage =
    record.usage && typeof record.usage === "object"
      ? (record.usage as Record<string, unknown>)
      : record.usageMetadata && typeof record.usageMetadata === "object"
        ? (record.usageMetadata as Record<string, unknown>)
        : completedResponse?.usage && typeof completedResponse.usage === "object"
          ? (completedResponse.usage as Record<string, unknown>)
          : undefined;
  if (usage) {
    result.push({
      kind: "usage",
      usage: {
        ...(typeof usage.input_tokens === "number" ? { inputTokens: usage.input_tokens } : {}),
        ...(typeof usage.promptTokenCount === "number"
          ? { inputTokens: usage.promptTokenCount }
          : {}),
        ...(typeof usage.prompt_tokens === "number" ? { inputTokens: usage.prompt_tokens } : {}),
        ...(typeof usage.cached_input_tokens === "number"
          ? { cachedInputTokens: usage.cached_input_tokens }
          : {}),
        ...(typeof usage.cache_read_input_tokens === "number"
          ? { cachedInputTokens: usage.cache_read_input_tokens }
          : {}),
        ...(typeof usage.cache_creation_input_tokens === "number"
          ? { cacheCreationTokens: usage.cache_creation_input_tokens }
          : {}),
        ...(typeof usage.output_tokens === "number" ? { outputTokens: usage.output_tokens } : {}),
        ...(typeof usage.candidatesTokenCount === "number"
          ? { outputTokens: usage.candidatesTokenCount }
          : {}),
        ...(typeof usage.cachedContentTokenCount === "number"
          ? { cachedInputTokens: usage.cachedContentTokenCount }
          : {}),
        ...(typeof usage.completion_tokens === "number"
          ? { outputTokens: usage.completion_tokens }
          : {}),
        ...(typeof usage.reasoning_tokens === "number"
          ? { reasoningOutputTokens: usage.reasoning_tokens }
          : {}),
        ...(typeof usage.cost_usd === "number" ? { providerCostUsd: usage.cost_usd } : {}),
        ...(typeof usage.cost === "number" ? { providerCostUsd: usage.cost } : {}),
        ...(typeof record.cost_usd === "number" ? { providerCostUsd: record.cost_usd } : {}),
        ...(typeof usage.total_tokens === "number" &&
        usage.input_tokens === undefined &&
        usage.prompt_tokens === undefined
          ? { inputTokens: usage.total_tokens }
          : {}),
      },
    });
  }
  return result;
}
