import {
  EventId,
  ApprovalRequestId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSession,
  ProviderRuntimeEvent,
  ProviderSendTurnInput,
  ProviderSessionStartInput,
  ProviderTurnStartResult,
  RuntimeItemId,
  ThreadId,
  TurnId,
  type ProviderUserInputAnswers,
  type UserInputQuestion,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as Clock from "effect/Clock";
import { Buffer } from "node:buffer";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { RuntimeRequestId } from "@t3tools/contracts";

import type { ApiProviderSettings } from "@t3tools/contracts";
import {
  getProviderOptionBooleanSelectionValue,
  getProviderOptionStringSelectionValue,
} from "@t3tools/shared/model";
import {
  API_PROVIDER_PROFILE_BY_ID,
  buildApiProviderAuthHeaders,
  isApiProviderChatModel,
  normalizeApiProviderSettings,
} from "../apiProviderProfiles.ts";
import {
  normalizeUsagePayload,
  parseSseBlockEvents,
  readApiProviderText,
  redactApiSecret,
  resolveApiBaseUrl,
  summarizeApiProviderError,
  validateApiBaseUrl,
  type ApiProviderHistoryEntry,
  type ApiProviderToolCall,
  type ApiProviderUsageRecord,
} from "../apiProviderTransport.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import type { ProviderAdapterShape, ProviderThreadSnapshot } from "../Services/ProviderAdapter.ts";
import { collectStreamAsString } from "../providerSnapshot.ts";
import type { ApiProviderUsageLedger } from "../../usage/ApiProviderUsageLedger.ts";
import { resolveAttachmentPath } from "../../attachmentStore.ts";

const PROVIDER = ProviderDriverKind.make("api");

interface ApiTurn {
  readonly id: TurnId;
  readonly items: Array<unknown>;
  readonly historyStart: number;
  historyEnd?: number;
}

interface ApiSessionContext {
  session: ProviderSession;
  readonly turns: Array<ApiTurn>;
  interrupted: Set<TurnId>;
  readonly pendingApprovals: Map<
    ApprovalRequestId,
    Deferred.Deferred<"accept" | "acceptForSession" | "decline" | "cancel">
  >;
  readonly history: Array<ApiProviderHistoryEntry>;
  readonly sessionApprovedTools: Set<string>;
}

const API_TOOLS = [
  {
    type: "function",
    function: {
      name: "run_command",
      description: "Run a shell command in the project working directory.",
      parameters: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a UTF-8 text file in the project.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Write UTF-8 text to a project file.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ask_user",
      description:
        "Ask the user one or more structured multiple-choice questions before continuing.",
      parameters: {
        type: "object",
        properties: {
          questions: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                header: { type: "string" },
                question: { type: "string" },
                options: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: { label: { type: "string" }, description: { type: "string" } },
                    required: ["label", "description"],
                    additionalProperties: false,
                  },
                },
                multiSelect: { type: "boolean" },
              },
              required: ["id", "header", "question", "options"],
              additionalProperties: false,
            },
          },
        },
        required: ["questions"],
        additionalProperties: false,
      },
    },
  },
] as const;

const apiModelContextWindow = (settings: ApiProviderSettings, model: string): number | undefined =>
  String(settings.profileId) === "sensenova" && model === "sensenova-6.7-flash-lite"
    ? 262_144
    : undefined;

const approvalRequestTypeForTool = (
  toolName: string,
): "command_execution_approval" | "file_read_approval" | "file_change_approval" => {
  if (toolName === "read_file") return "file_read_approval";
  if (toolName === "write_file") return "file_change_approval";
  return "command_execution_approval";
};

const toolArguments = (value: string): Record<string, unknown> => {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
};

const responseInputFromHistory = (
  history: ReadonlyArray<ApiProviderHistoryEntry>,
): ReadonlyArray<Record<string, unknown>> =>
  history.flatMap((entry): ReadonlyArray<Record<string, unknown>> => {
    if (entry.role === "user") {
      return [
        {
          role: "user",
          content: Array.isArray(entry.content)
            ? entry.content
            : [
                {
                  type: "input_text",
                  text: typeof entry.content === "string" ? entry.content : "",
                },
              ],
        },
      ];
    }
    if (entry.role === "assistant") {
      return [
        ...(typeof entry.content === "string" && entry.content.length > 0
          ? [{ role: "assistant", content: [{ type: "output_text", text: entry.content }] }]
          : []),
        ...(entry.toolCalls ?? []).map((call) => ({
          type: "function_call",
          call_id: call.id,
          name: call.name,
          arguments: call.arguments,
        })),
      ];
    }
    return (entry.toolResults ?? []).map((result) => ({
      type: "function_call_output",
      call_id: result.id,
      output: result.result,
    }));
  });

const chatMessagesFromHistory = (
  history: ReadonlyArray<ApiProviderHistoryEntry>,
): ReadonlyArray<Record<string, unknown>> =>
  history.flatMap((entry) => {
    if (entry.role === "user") return [{ role: "user", content: entry.content }];
    if (entry.role === "assistant")
      return [
        {
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
        },
      ];
    return (entry.toolResults ?? []).map((result) => ({
      role: "tool",
      content: result.result,
      tool_call_id: result.id,
    }));
  });

const anthropicMessagesFromHistory = (
  history: ReadonlyArray<ApiProviderHistoryEntry>,
): ReadonlyArray<Record<string, unknown>> =>
  history.flatMap((entry) => {
    if (entry.role === "user") return [{ role: "user", content: entry.content }];
    if (entry.role === "assistant")
      return [
        {
          role: "assistant",
          content: [
            ...(typeof entry.content === "string" && entry.content.length > 0
              ? [{ type: "text", text: entry.content }]
              : []),
            ...(entry.toolCalls ?? []).map((call) => ({
              type: "tool_use",
              id: call.id,
              name: call.name,
              input: toolArguments(call.arguments),
            })),
          ],
        },
      ];
    return [
      {
        role: "user",
        content: (entry.toolResults ?? []).map((result) => ({
          type: "tool_result",
          tool_use_id: result.id,
          content: result.result,
        })),
      },
    ];
  });

const geminiContentsFromHistory = (
  history: ReadonlyArray<ApiProviderHistoryEntry>,
): ReadonlyArray<Record<string, unknown>> =>
  history.flatMap((entry) => {
    if (entry.role === "user")
      return [
        {
          role: "user",
          parts: Array.isArray(entry.content)
            ? entry.content
            : [{ text: typeof entry.content === "string" ? entry.content : "" }],
        },
      ];
    if (entry.role === "assistant")
      return [
        {
          role: "model",
          parts: [
            ...(typeof entry.content === "string" && entry.content.length > 0
              ? [{ text: entry.content }]
              : []),
            ...(entry.toolCalls ?? []).map((call) => ({
              functionCall: { name: call.name, args: toolArguments(call.arguments) },
            })),
          ],
        },
      ];
    return [
      {
        role: "user",
        parts: (entry.toolResults ?? []).map((result) => ({
          functionResponse: { name: result.name, response: { result: result.result } },
        })),
      },
    ];
  });
const decodeJsonValue = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const encodeJsonValue = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const ApiToolCallSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  arguments: Schema.String,
});
const ApiToolResultSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  result: Schema.String,
});
const ApiHistoryEntrySchema = Schema.Struct({
  role: Schema.Literals(["user", "assistant", "tool"]),
  content: Schema.optional(Schema.Unknown),
  toolCalls: Schema.optional(Schema.Array(ApiToolCallSchema)),
  toolResults: Schema.optional(Schema.Array(ApiToolResultSchema)),
});
const ApiResumeCursorSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  history: Schema.Array(ApiHistoryEntrySchema),
  turns: Schema.Array(
    Schema.Struct({
      id: TurnId,
      items: Schema.Array(Schema.Unknown),
      historyStart: Schema.Int,
      historyEnd: Schema.optional(Schema.Int),
    }),
  ),
});
const decodeApiResumeCursor = Schema.decodeUnknownOption(ApiResumeCursorSchema);

export function normalizeApiUserInputQuestions(raw: unknown): ReadonlyArray<UserInputQuestion> {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const question = value as Record<string, unknown>;
    const id = typeof question.id === "string" ? question.id.trim() : "";
    const header = typeof question.header === "string" ? question.header.trim() : "";
    const prompt = typeof question.question === "string" ? question.question.trim() : "";
    const optionsValue = Array.isArray(question.options) ? question.options : [];
    const options = optionsValue.flatMap((option) => {
      if (!option || typeof option !== "object" || Array.isArray(option)) return [];
      const item = option as Record<string, unknown>;
      const label = typeof item.label === "string" ? item.label.trim() : "";
      const description = typeof item.description === "string" ? item.description.trim() : "";
      return label && description ? [{ label, description }] : [];
    });
    return id && header && prompt && options.length > 0
      ? [
          {
            id,
            header,
            question: prompt,
            options,
            ...(typeof question.multiSelect === "boolean"
              ? { multiSelect: question.multiSelect }
              : {}),
          },
        ]
      : [];
  });
}

const resumeCursorForContext = (
  history: ReadonlyArray<ApiProviderHistoryEntry>,
  turns: ReadonlyArray<ApiTurn>,
) => ({
  schemaVersion: 1 as const,
  history,
  turns,
});

const nowIso = Effect.map(DateTime.now, DateTime.formatIso).pipe(
  Effect.mapError(
    (cause) =>
      new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "clock",
        detail: "Failed to read API provider runtime time.",
        cause,
      }),
  ),
);

function readToolCalls(
  protocol: ApiProviderSettings["protocol"],
  payload: unknown,
): ReadonlyArray<ApiProviderToolCall> {
  if (!payload || typeof payload !== "object") return [];
  const value = payload as Record<string, unknown>;
  if (protocol === "anthropic-messages") {
    return Array.isArray(value.content)
      ? value.content.flatMap((item) => {
          if (!item || typeof item !== "object") return [];
          const record = item as Record<string, unknown>;
          return record.type === "tool_use" &&
            typeof record.id === "string" &&
            typeof record.name === "string"
            ? [{ id: record.id, name: record.name, arguments: JSON.stringify(record.input ?? {}) }]
            : [];
        })
      : [];
  }
  if (protocol === "gemini-generate-content") {
    const candidates = Array.isArray(value.candidates) ? value.candidates : [];
    return candidates.flatMap((candidate) => {
      if (!candidate || typeof candidate !== "object") return [];
      const content = (candidate as Record<string, unknown>).content;
      const parts =
        content && typeof content === "object"
          ? (content as Record<string, unknown>).parts
          : undefined;
      return Array.isArray(parts)
        ? parts.flatMap((part, index) => {
            if (!part || typeof part !== "object") return [];
            const call = (part as Record<string, unknown>).functionCall;
            return call &&
              typeof call === "object" &&
              typeof (call as Record<string, unknown>).name === "string"
              ? [
                  {
                    id: `gemini-tool-${index}`,
                    name: (call as Record<string, unknown>).name as string,
                    arguments: JSON.stringify((call as Record<string, unknown>).args ?? {}),
                  },
                ]
              : [];
          })
        : [];
    });
  }
  if (protocol === "openai-responses") {
    const output = Array.isArray(value.output) ? value.output : [];
    return output.flatMap((item, index) => {
      if (!item || typeof item !== "object") return [];
      const record = item as Record<string, unknown>;
      return record.type === "function_call" && typeof record.name === "string"
        ? [
            {
              id: typeof record.call_id === "string" ? record.call_id : `responses-tool-${index}`,
              name: record.name,
              arguments: typeof record.arguments === "string" ? record.arguments : "{}",
            },
          ]
        : [];
    });
  }
  const choices = Array.isArray(value.choices) ? value.choices : [];
  const message =
    choices[0] && typeof choices[0] === "object"
      ? (choices[0] as Record<string, unknown>).message
      : undefined;
  const calls =
    message && typeof message === "object"
      ? (message as Record<string, unknown>).tool_calls
      : undefined;
  return Array.isArray(calls)
    ? calls.flatMap((call, index) => {
        if (!call || typeof call !== "object") return [];
        const record = call as Record<string, unknown>;
        const fn =
          record.function && typeof record.function === "object"
            ? (record.function as Record<string, unknown>)
            : undefined;
        return fn && typeof fn.name === "string"
          ? [
              {
                id: typeof record.id === "string" ? record.id : `chat-tool-${index}`,
                name: fn.name,
                arguments: typeof fn.arguments === "string" ? fn.arguments : "{}",
              },
            ]
          : [];
      })
    : [];
}

export function requestPlan(input: {
  readonly settings: ApiProviderSettings;
  readonly apiKey: string;
  readonly model: string;
  readonly text: string;
  readonly history: ReadonlyArray<ApiProviderHistoryEntry>;
  readonly attachments?: ReadonlyArray<{ readonly mimeType: string; readonly data: string }>;
  readonly options?: ReadonlyArray<{ readonly id: string; readonly value: string | boolean }>;
  readonly includeTools?: boolean;
  readonly stream?: boolean;
}) {
  const settings = normalizeApiProviderSettings(input.settings);
  const profile = API_PROVIDER_PROFILE_BY_ID.get(settings.profileId as never);
  if (!profile) return undefined;
  const baseUrl = resolveApiBaseUrl({
    defaultBaseUrl: profile.defaultBaseUrl,
    override: input.settings.baseUrl,
  });
  if (validateApiBaseUrl(baseUrl)) return undefined;
  const headers = {
    "content-type": "application/json",
    ...(settings.protocol === "anthropic-messages" ? { "anthropic-version": "2023-06-01" } : {}),
    ...(settings.protocol === "openai-responses" || settings.protocol === "openai-chat-completions"
      ? {
          ...(settings.organization.trim()
            ? { "OpenAI-Organization": settings.organization.trim() }
            : {}),
          ...(settings.project.trim() ? { "OpenAI-Project": settings.project.trim() } : {}),
        }
      : {}),
    ...buildApiProviderAuthHeaders({ settings, profile, apiKey: input.apiKey }),
  };
  const attachments = input.attachments ?? [];
  const isSenseNova = String(settings.profileId) === "sensenova";
  const isSenseNovaOfficialHost = isSenseNova && baseUrl.includes("api.sensenova.cn");
  const senseNovaPath = isSenseNovaOfficialHost ? "/llm/chat-completions" : "/chat/completions";
  const temperature = getProviderOptionStringSelectionValue(input.options, "temperature");
  const maxOutputTokens = getProviderOptionStringSelectionValue(input.options, "maxOutputTokens");
  const reasoningEffort = getProviderOptionStringSelectionValue(input.options, "reasoningEffort");
  const parallelToolCalls = getProviderOptionBooleanSelectionValue(
    input.options,
    "parallelToolCalls",
  );
  const includeTools = input.includeTools ?? true;
  const stream = input.stream ?? true;
  const userContent = apiUserContent(settings.protocol, input.text, attachments);
  const hasUserInput = input.text.length > 0 || attachments.length > 0;
  if (settings.protocol === "anthropic-messages") {
    return {
      url: `${baseUrl}/messages`,
      headers,
      body: {
        model: input.model,
        max_tokens: Number(maxOutputTokens ?? 4096),
        stream,
        ...(temperature !== undefined ? { temperature: Number(temperature) } : {}),
        ...(includeTools
          ? {
              tools: API_TOOLS.map((tool) => ({
                name: tool.function.name,
                description: tool.function.description,
                input_schema: tool.function.parameters,
              })),
            }
          : {}),
        messages: [
          ...anthropicMessagesFromHistory(input.history),
          ...(hasUserInput
            ? [{ role: "user", content: attachments.length > 0 ? userContent : input.text }]
            : []),
        ],
      },
    };
  }
  if (settings.protocol === "gemini-generate-content") {
    return {
      url: `${baseUrl}/models/${encodeURIComponent(input.model)}:${stream ? "streamGenerateContent?alt=sse" : "generateContent"}`,
      headers,
      body: {
        ...(temperature !== undefined || maxOutputTokens !== undefined
          ? {
              generationConfig: {
                ...(temperature !== undefined ? { temperature: Number(temperature) } : {}),
                ...(maxOutputTokens !== undefined
                  ? { maxOutputTokens: Number(maxOutputTokens) }
                  : {}),
              },
            }
          : {}),
        ...(includeTools
          ? {
              tools: [
                {
                  functionDeclarations: API_TOOLS.map((tool) => ({
                    name: tool.function.name,
                    description: tool.function.description,
                    parameters: tool.function.parameters,
                  })),
                },
              ],
            }
          : {}),
        contents: [
          ...geminiContentsFromHistory(input.history),
          ...(hasUserInput ? [{ role: "user", parts: userContent }] : []),
        ],
      },
    };
  }
  if (settings.protocol === "openai-responses") {
    return {
      url: `${baseUrl}/responses`,
      headers,
      body: {
        model: input.model,
        ...(maxOutputTokens !== undefined ? { max_output_tokens: Number(maxOutputTokens) } : {}),
        ...(reasoningEffort !== undefined ? { reasoning: { effort: reasoningEffort } } : {}),
        ...(includeTools && parallelToolCalls !== undefined
          ? { parallel_tool_calls: parallelToolCalls }
          : {}),
        input: [
          ...responseInputFromHistory(input.history),
          ...(hasUserInput ? [{ role: "user", content: userContent }] : []),
        ],
        ...(includeTools
          ? {
              tools: API_TOOLS.map((tool) => ({
                type: "function",
                name: tool.function.name,
                description: tool.function.description,
                parameters: tool.function.parameters,
                strict: false,
              })),
            }
          : {}),
        stream,
      },
    };
  }
  const isLegacySenseNovaHost = isSenseNovaOfficialHost;
  return {
    url: `${baseUrl}${isSenseNova ? senseNovaPath : "/chat/completions"}`,
    headers,
    body: {
      model: input.model,
      stream,
      ...(temperature !== undefined ? { temperature: Number(temperature) } : {}),
      ...(maxOutputTokens !== undefined
        ? { [isLegacySenseNovaHost ? "max_new_tokens" : "max_tokens"]: Number(maxOutputTokens) }
        : {}),
      ...(reasoningEffort !== undefined ? { reasoning_effort: reasoningEffort } : {}),
      ...(includeTools && (parallelToolCalls !== undefined || isSenseNova)
        ? { parallel_tool_calls: parallelToolCalls ?? true }
        : {}),
      ...(includeTools ? { tools: API_TOOLS, tool_choice: "auto" } : {}),
      ...(stream && isSenseNova ? { stream_options: { include_usage: true } } : {}),
      messages: [
        ...chatMessagesFromHistory(input.history),
        ...(hasUserInput
          ? [{ role: "user", content: attachments.length > 0 ? userContent : input.text }]
          : []),
      ],
    },
  };
}

function apiUserContent(
  protocol: ApiProviderSettings["protocol"],
  text: string,
  attachments: ReadonlyArray<{ readonly mimeType: string; readonly data: string }>,
) {
  if (protocol === "gemini-generate-content") {
    return [
      { text },
      ...attachments.map((attachment) => ({
        inlineData: { mimeType: attachment.mimeType, data: attachment.data },
      })),
    ];
  }
  if (protocol === "anthropic-messages") {
    return [
      { type: "text", text },
      ...attachments.map((attachment) => ({
        type: "image",
        source: { type: "base64", media_type: attachment.mimeType, data: attachment.data },
      })),
    ];
  }
  if (protocol === "openai-responses") {
    return [
      { type: "input_text", text },
      ...attachments.map((attachment) => ({
        type: "input_image",
        image_url: `data:${attachment.mimeType};base64,${attachment.data}`,
      })),
    ];
  }
  return [
    { type: "text", text },
    ...attachments.map((attachment) => ({
      type: "image_url",
      image_url: { url: `data:${attachment.mimeType};base64,${attachment.data}` },
    })),
  ];
}

export const makeApiProviderAdapter = Effect.fn("makeApiProviderAdapter")(function* (input: {
  readonly instanceId: ProviderInstanceId;
  readonly settings: ApiProviderSettings;
  readonly apiKey: string;
  readonly httpClient: HttpClient.HttpClient;
  readonly fileSystem: FileSystem.FileSystem;
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly path: Path.Path;
  readonly attachmentsDir: string;
  readonly usageLedger?: ApiProviderUsageLedger["Service"];
}) {
  const crypto = yield* Crypto.Crypto;
  const httpClient = input.httpClient;
  const instanceId = input.instanceId;
  const inputSettings = normalizeApiProviderSettings(input.settings);
  const apiKey = input.apiKey;
  const fileSystem = input.fileSystem;
  const childProcessSpawner = input.childProcessSpawner;
  const path = input.path;
  const attachmentsDir = input.attachmentsDir;
  const usageLedger = input.usageLedger;
  const events = yield* PubSub.unbounded<ProviderRuntimeEvent>();
  const sessions = new Map<ThreadId, ApiSessionContext>();
  const turnFibers = new Map<TurnId, Fiber.Fiber<void, never>>();
  let lastRateLimits: Readonly<Record<string, unknown>> = {};
  const initialNowMs = yield* Clock.currentTimeMillis;
  let localSenseNovaWindow = { startedAtMs: initialNowMs, requestCount: 0 };
  const pendingUserInputs = new Map<
    ApprovalRequestId,
    { readonly threadId: ThreadId; readonly answers: Deferred.Deferred<ProviderUserInputAnswers> }
  >();
  const nextUuid = crypto.randomUUIDv4.pipe(
    Effect.mapError(
      (cause) =>
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "crypto.randomUUIDv4",
          detail: "Failed to generate API provider runtime identifier.",
          cause,
        }),
    ),
  );
  const stamp = () =>
    Effect.all({ eventId: nextUuid.pipe(Effect.map(EventId.make)), createdAt: nowIso });
  const publish = (event: ProviderRuntimeEvent) =>
    PubSub.publish(events, event).pipe(Effect.asVoid);
  const failureDetail = (cause: unknown) =>
    redactApiSecret(String(cause), apiKey).replace(/\s+/gu, " ").slice(0, 500);
  const retryDelayMs = (
    headers: Readonly<Record<string, string>>,
    attempt: number,
    nowMs: number,
  ): number => {
    const retryAfter = Object.entries(headers).find(
      ([key]) => key.toLowerCase() === "retry-after",
    )?.[1];
    const parsed = retryAfter === undefined ? Number.NaN : Number(retryAfter);
    if (Number.isFinite(parsed) && parsed >= 0) return Math.min(parsed * 1_000, 30_000);
    const retryAt = retryAfter === undefined ? Number.NaN : Date.parse(retryAfter);
    if (Number.isFinite(retryAt)) return Math.min(Math.max(0, retryAt - nowMs), 30_000);
    return Math.min(250 * 2 ** attempt, 2_000);
  };
  const executeProviderRequest = (
    request: HttpClientRequest.HttpClientRequest,
    method: string,
    attempt = 0,
  ): Effect.Effect<HttpClientResponse.HttpClientResponse, ProviderAdapterRequestError> =>
    request.pipe(
      httpClient.execute,
      Effect.timeout("120 seconds"),
      Effect.flatMap((response) =>
        response.status >= 200 && response.status < 300
          ? Effect.succeed(response)
          : response.text.pipe(
              Effect.flatMap((body) =>
                Effect.gen(function* () {
                  if (
                    (response.status === 408 ||
                      response.status === 429 ||
                      response.status >= 500) &&
                    attempt < 2
                  ) {
                    const nowMs = yield* Clock.currentTimeMillis;
                    return yield* Effect.sleep(
                      `${retryDelayMs(response.headers ?? {}, attempt, nowMs)} millis`,
                    ).pipe(Effect.andThen(executeProviderRequest(request, method, attempt + 1)));
                  }
                  return yield* Effect.fail(
                    new ProviderAdapterRequestError({
                      provider: PROVIDER,
                      method,
                      detail: redactApiSecret(
                        summarizeApiProviderError(body, response.status),
                        apiKey,
                      ),
                    }),
                  );
                }),
              ),
            ),
      ),
      Effect.catch((cause) =>
        Effect.fail(
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method,
            detail: `API provider request timed out or could not be sent: ${failureDetail(cause)}`,
            cause,
          }),
        ),
      ),
    );

  const requireSession = (threadId: ThreadId) => {
    const context = sessions.get(threadId);
    return context
      ? Effect.succeed(context)
      : Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }));
  };

  const requestApproval = (
    context: ApiSessionContext,
    threadId: ThreadId,
    turnId: TurnId,
    toolName: string,
    detail: string,
    requestType = approvalRequestTypeForTool(toolName),
  ) =>
    Effect.gen(function* () {
      if (
        context.session.runtimeMode === "full-access" ||
        context.session.runtimeMode === "auto" ||
        (context.session.runtimeMode === "auto-accept-edits" && toolName !== "run_command")
      )
        return "accept" as const;
      if (context.sessionApprovedTools.has(toolName)) return "accept" as const;
      const requestId = ApprovalRequestId.make(`api-${turnId}-${context.pendingApprovals.size}`);
      const decision = yield* Deferred.make<"accept" | "acceptForSession" | "decline" | "cancel">();
      context.pendingApprovals.set(requestId, decision);
      yield* publish({
        type: "request.opened",
        ...(yield* stamp()),
        provider: PROVIDER,
        threadId,
        turnId,
        requestId: RuntimeRequestId.make(requestId),
        payload: { requestType, detail, args: { toolName } },
      });
      const result = yield* Deferred.await(decision);
      context.pendingApprovals.delete(requestId);
      if (result === "acceptForSession") context.sessionApprovedTools.add(toolName);
      yield* publish({
        type: "request.resolved",
        ...(yield* stamp()),
        provider: PROVIDER,
        threadId,
        turnId,
        requestId: RuntimeRequestId.make(requestId),
        payload: { requestType, decision: result },
      });
      return result;
    });

  const requestUserInput = (threadId: ThreadId, turnId: TurnId, rawArgs: string) =>
    Effect.gen(function* () {
      const parsed = yield* Effect.try({
        try: () => decodeJsonValue(rawArgs),
        catch: () => undefined,
      });
      const questionsValue =
        parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>).questions
          : undefined;
      const questions = normalizeApiUserInputQuestions(questionsValue);
      if (questions.length === 0)
        return yield* Effect.succeed("User questions were invalid or empty.");
      const requestId = ApprovalRequestId.make(`api-user-${turnId}-${pendingUserInputs.size}`);
      const answers = yield* Deferred.make<ProviderUserInputAnswers>();
      pendingUserInputs.set(requestId, { threadId, answers });
      yield* publish({
        type: "user-input.requested",
        ...(yield* stamp()),
        provider: PROVIDER,
        threadId,
        turnId,
        requestId: RuntimeRequestId.make(requestId),
        payload: { questions },
      });
      const result = yield* Deferred.await(answers);
      pendingUserInputs.delete(requestId);
      yield* publish({
        type: "user-input.resolved",
        ...(yield* stamp()),
        provider: PROVIDER,
        threadId,
        turnId,
        requestId: RuntimeRequestId.make(requestId),
        payload: { answers: result },
      });
      return encodeJsonValue(result);
    });

  const resolveProjectPath = (cwd: string | undefined, relative: string) =>
    Effect.gen(function* () {
      const root = cwd ?? ".";
      const canonicalRoot = yield* fileSystem.realPath(root).pipe(Effect.orElseSucceed(() => root));
      const lexicalPath = path.join(canonicalRoot, relative);
      const canonicalParent = yield* fileSystem
        .realPath(path.dirname(lexicalPath))
        .pipe(Effect.orElseSucceed(() => path.dirname(lexicalPath)));
      const resolved = path.join(canonicalParent, path.basename(lexicalPath));
      const canonicalTarget = yield* fileSystem
        .realPath(resolved)
        .pipe(Effect.orElseSucceed(() => resolved));
      const rootPrefix = canonicalRoot.endsWith(path.sep)
        ? canonicalRoot
        : `${canonicalRoot}${path.sep}`;
      return canonicalTarget === canonicalRoot || canonicalTarget.startsWith(rootPrefix)
        ? resolved
        : undefined;
    });

  const executeTool = (
    context: ApiSessionContext,
    threadId: ThreadId,
    turnId: TurnId,
    callId: string,
    name: string,
    rawArgs: string,
    cwd: string | undefined,
  ) =>
    Effect.gen(function* () {
      const parsed = yield* Effect.try({
        try: () => decodeJsonValue(rawArgs),
        catch: () => undefined,
      });
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        return yield* Effect.succeed("Tool arguments were invalid JSON.");
      const args = parsed as Record<string, unknown>;
      const toolId = RuntimeItemId.make(`api-tool-${turnId}-${callId}`);
      yield* publish({
        type: "item.started",
        ...(yield* stamp()),
        provider: PROVIDER,
        threadId,
        turnId,
        itemId: toolId,
        payload: {
          itemType:
            name === "run_command"
              ? "command_execution"
              : name === "write_file"
                ? "file_change"
                : "dynamic_tool_call",
          status: "inProgress",
          title: name,
          data: args,
        },
      });
      if (
        name !== "run_command" &&
        name !== "read_file" &&
        name !== "write_file" &&
        name !== "ask_user"
      ) {
        const detail = `Unknown tool '${name}'.`;
        yield* publish({
          type: "item.completed",
          ...(yield* stamp()),
          provider: PROVIDER,
          threadId,
          turnId,
          itemId: toolId,
          payload: { itemType: "dynamic_tool_call", status: "failed", title: name, detail },
        });
        return detail;
      }
      const detail =
        typeof args.command === "string"
          ? args.command
          : typeof args.path === "string"
            ? args.path
            : name;
      const approval =
        name === "ask_user"
          ? ("accept" as const)
          : yield* requestApproval(context, threadId, turnId, name, detail);
      if (approval === "decline" || approval === "cancel") {
        yield* publish({
          type: "item.completed",
          ...(yield* stamp()),
          provider: PROVIDER,
          threadId,
          turnId,
          itemId: toolId,
          payload: {
            itemType:
              name === "run_command"
                ? "command_execution"
                : name === "write_file"
                  ? "file_change"
                  : "dynamic_tool_call",
            status: "failed",
            title: name,
            detail: "Tool execution declined.",
          },
        });
        return "Tool execution was declined by the user.";
      }
      if (name === "ask_user") {
        const result = yield* requestUserInput(threadId, turnId, rawArgs);
        yield* publish({
          type: "item.completed",
          ...(yield* stamp()),
          provider: PROVIDER,
          threadId,
          turnId,
          itemId: toolId,
          payload: {
            itemType: "dynamic_tool_call",
            status: "completed",
            title: name,
            detail: result.slice(0, 4000),
          },
        });
        return result;
      }
      const result = yield* Effect.gen(function* () {
        if (name === "read_file") {
          const relative = typeof args.path === "string" ? args.path : "";
          if (!relative || relative.startsWith("/") || relative.split(/[\\/]/u).includes(".."))
            return yield* Effect.succeed("Path must be a relative project path.");
          const resolved = yield* resolveProjectPath(cwd, relative);
          if (!resolved) return yield* Effect.succeed("Path resolves outside the project.");
          return yield* fileSystem.readFileString(resolved);
        }
        if (name === "write_file") {
          const relative = typeof args.path === "string" ? args.path : "";
          if (!relative || relative.startsWith("/") || relative.split(/[\\/]/u).includes(".."))
            return yield* Effect.succeed("Path must be a relative project path.");
          const resolved = yield* resolveProjectPath(cwd, relative);
          if (!resolved) return yield* Effect.succeed("Path resolves outside the project.");
          yield* fileSystem.writeFileString(
            resolved,
            typeof args.content === "string" ? args.content : "",
          );
          return "File written successfully.";
        }
        if (name === "run_command") {
          const command = typeof args.command === "string" ? args.command : "";
          if (!command.trim()) return yield* Effect.succeed("Command is required.");
          return yield* Effect.scoped(
            Effect.gen(function* () {
              const shell = process.platform === "win32" ? "cmd.exe" : "/bin/sh";
              const shellArgs =
                process.platform === "win32" ? ["/d", "/s", "/c", command] : ["-lc", command];
              const child = yield* childProcessSpawner.spawn(
                ChildProcess.make(shell, shellArgs, { ...(cwd ? { cwd } : {}) }),
              );
              const [stdout, stderr, code] = yield* Effect.all(
                [
                  collectStreamAsString(child.stdout),
                  collectStreamAsString(child.stderr),
                  child.exitCode,
                ],
                { concurrency: "unbounded" },
              ).pipe(Effect.timeout("120 seconds"));
              const output = `exit ${Number(code)}\n${stdout}${stderr ? `\n${stderr}` : ""}`;
              return output.length > 100_000
                ? `${output.slice(0, 100_000)}\n[output truncated]`
                : output;
            }),
          );
        }
        return `Unknown tool '${name}'.`;
      }).pipe(Effect.catch((cause) => Effect.succeed(`Tool failed: ${String(cause)}`)));
      yield* publish({
        type: "item.completed",
        ...(yield* stamp()),
        provider: PROVIDER,
        threadId,
        turnId,
        itemId: toolId,
        payload: {
          itemType:
            name === "run_command"
              ? "command_execution"
              : name === "write_file"
                ? "file_change"
                : "dynamic_tool_call",
          status: "completed",
          title: name,
          detail: result.slice(0, 4000),
        },
      });
      return result;
    });

  const startSession = (input: ProviderSessionStartInput) =>
    Effect.gen(function* () {
      const existing = sessions.get(input.threadId);
      if (existing) return existing.session;
      const createdAt = yield* nowIso;
      const restored = Option.getOrUndefined(decodeApiResumeCursor(input.resumeCursor));
      const restoredHistory: Array<ApiProviderHistoryEntry> =
        restored?.history.map((entry) => ({
          role: entry.role,
          ...(entry.content !== undefined ? { content: entry.content } : {}),
          ...(entry.toolCalls !== undefined ? { toolCalls: entry.toolCalls } : {}),
          ...(entry.toolResults !== undefined ? { toolResults: entry.toolResults } : {}),
        })) ?? [];
      const restoredTurns: Array<ApiTurn> =
        restored?.turns.map((turn) => ({
          id: turn.id,
          items: [...turn.items],
          historyStart: turn.historyStart,
          ...(turn.historyEnd !== undefined ? { historyEnd: turn.historyEnd } : {}),
        })) ?? [];
      const restoredCursor = restored
        ? resumeCursorForContext(restoredHistory, restoredTurns)
        : undefined;
      const session: ProviderSession = {
        provider: PROVIDER,
        providerInstanceId: instanceId,
        status: "ready",
        runtimeMode: input.runtimeMode,
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(input.modelSelection?.model ? { model: input.modelSelection.model } : {}),
        threadId: input.threadId,
        ...(restoredCursor !== undefined ? { resumeCursor: restoredCursor } : {}),
        createdAt,
        updatedAt: createdAt,
      };
      sessions.set(input.threadId, {
        session,
        turns: restoredTurns,
        interrupted: new Set(),
        pendingApprovals: new Map(),
        sessionApprovedTools: new Set(),
        history: restoredHistory,
      });
      yield* publish({
        type: "session.started",
        ...(yield* stamp()),
        provider: PROVIDER,
        threadId: input.threadId,
        payload: { ...(restoredCursor !== undefined ? { resume: restoredCursor } : {}) },
      });
      return session;
    });

  const sendTurn = (
    input: ProviderSendTurnInput,
  ): Effect.Effect<ProviderTurnStartResult, ProviderAdapterError> =>
    Effect.gen(function* () {
      const context = yield* requireSession(input.threadId);
      if (context.session.status === "closed")
        return yield* new ProviderAdapterSessionClosedError({
          provider: PROVIDER,
          threadId: input.threadId,
        });
      const text = input.input?.trim() ?? "";
      if (!text && (input.attachments?.length ?? 0) === 0)
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: "API turns require text or an image attachment.",
        });
      const model = input.modelSelection?.model ?? context.session.model;
      if (!model)
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: "Select a model before sending an API turn.",
        });
      if (!isApiProviderChatModel(String(inputSettings.profileId), model))
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: `Model '${model}' is an image-generation model and cannot run a chat coding-agent turn.`,
        });
      const apiAttachments = yield* Effect.forEach(
        input.attachments ?? [],
        (attachment) =>
          Effect.gen(function* () {
            const attachmentPath = resolveAttachmentPath({ attachmentsDir, attachment });
            if (!attachmentPath)
              return yield* new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: "sendTurn",
                issue: `Invalid attachment id '${attachment.id}'.`,
              });
            const bytes = yield* fileSystem
              .readFile(attachmentPath)
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new ProviderAdapterRequestError({
                      provider: PROVIDER,
                      method: "sendTurn",
                      detail: "Failed to read API image attachment.",
                      cause,
                    }),
                ),
              );
            if (bytes.byteLength > 10 * 1024 * 1024)
              return yield* new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: "sendTurn",
                issue: "Image attachment exceeds the 10 MiB provider input limit.",
              });
            return { mimeType: attachment.mimeType, data: Buffer.from(bytes).toString("base64") };
          }),
        { concurrency: 1 },
      );
      const plan = requestPlan({
        settings: inputSettings,
        apiKey,
        model,
        text,
        history: context.history,
        attachments: apiAttachments,
        ...(input.modelSelection?.options ? { options: input.modelSelection.options } : {}),
      });
      if (!plan)
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: `Unknown API profile '${inputSettings.profileId}'.`,
        });
      const historyStart = context.history.length;
      context.history.push({
        role: "user",
        content:
          apiAttachments.length > 0
            ? apiUserContent(inputSettings.protocol, text, apiAttachments)
            : text,
      });
      const turnId = TurnId.make(yield* nextUuid);
      context.session = {
        ...context.session,
        status: "running",
        activeTurnId: turnId,
        model,
        updatedAt: yield* nowIso,
      };
      const turn: ApiTurn = {
        id: turnId,
        items: [{ type: "user_message", content: text }],
        historyStart,
      };
      context.turns.push(turn);
      yield* publish({
        type: "turn.started",
        ...(yield* stamp()),
        provider: PROVIDER,
        threadId: input.threadId,
        turnId,
        payload: { model },
      });

      const run = Effect.gen(function* () {
        let totalUsage: ApiProviderUsageRecord | undefined;
        let completed = false;
        const assistantItemId = RuntimeItemId.make(`api-assistant-${turnId}`);
        const consumeResponse = (response: HttpClientResponse.HttpClientResponse) =>
          Effect.gen(function* () {
            let assistantText = "";
            let usage: ApiProviderUsageRecord | undefined;
            const toolCalls = new Map<string, { name: string; args: string }>();
            const toolIdsByIndex = new Map<number, string>();
            const toolAliases = new Map<string, string>();
            let currentToolId: string | undefined;
            const consumeEvent = (event: ReturnType<typeof parseSseBlockEvents>[number]) =>
              Effect.gen(function* () {
                if (event.kind === "error")
                  return yield* new ProviderAdapterRequestError({
                    provider: PROVIDER,
                    method: "stream",
                    detail: event.message ?? "Provider returned a malformed stream event.",
                  });
                if (event.kind === "text-delta" && event.text) {
                  assistantText += event.text;
                  yield* publish({
                    type: "content.delta",
                    ...(yield* stamp()),
                    provider: PROVIDER,
                    threadId: input.threadId,
                    turnId,
                    itemId: assistantItemId,
                    payload: { streamKind: "assistant_text", delta: event.text },
                  });
                }
                if (event.kind === "tool-call" || event.kind === "tool-call-delta") {
                  if (event.toolItemId && event.toolCallId)
                    toolAliases.set(event.toolItemId, event.toolCallId);
                  const id =
                    event.toolCallId !== undefined
                      ? (toolAliases.get(event.toolCallId) ?? event.toolCallId)
                      : event.toolCallIndex !== undefined
                        ? (toolIdsByIndex.get(event.toolCallIndex) ??
                          `api-tool-call-${turnId}-${toolCalls.size}`)
                        : (currentToolId ?? `api-tool-call-${turnId}-${toolCalls.size}`);
                  currentToolId = id;
                  if (event.toolCallIndex !== undefined)
                    toolIdsByIndex.set(event.toolCallIndex, id);
                  const existing = toolCalls.get(id) ?? { name: "", args: "" };
                  toolCalls.set(id, {
                    name: event.toolName ?? existing.name,
                    args:
                      existing.args + (event.toolArgumentsJson ?? event.toolArgumentsDelta ?? ""),
                  });
                }
                if (event.kind === "usage" && event.usage) usage = event.usage;
              });
            const contentType =
              Object.entries(response.headers ?? {}).find(
                ([key]) => key.toLowerCase() === "content-type",
              )?.[1] ?? "";
            if (contentType.includes("json")) {
              const payload = yield* response.json;
              usage = normalizeUsagePayload(payload);
              assistantText = readApiProviderText(payload, inputSettings.protocol);
              for (const call of readToolCalls(inputSettings.protocol, payload))
                toolCalls.set(call.id, { name: call.name, args: call.arguments });
              if (assistantText.length > 0)
                yield* publish({
                  type: "content.delta",
                  ...(yield* stamp()),
                  provider: PROVIDER,
                  threadId: input.threadId,
                  turnId,
                  itemId: assistantItemId,
                  payload: { streamKind: "assistant_text", delta: assistantText },
                });
            } else {
              let block = "";
              yield* response.stream.pipe(
                Stream.decodeText(),
                Stream.splitLines,
                Stream.runForEach((line) =>
                  Effect.gen(function* () {
                    if (line.trim().length === 0) {
                      if (block.length > 0) {
                        for (const event of parseSseBlockEvents(block)) yield* consumeEvent(event);
                        block = "";
                      }
                    } else if (line.startsWith("data:")) {
                      block += `${line}\n`;
                    }
                  }),
                ),
              );
              if (block.length > 0)
                for (const event of parseSseBlockEvents(block)) yield* consumeEvent(event);
            }
            return {
              assistantText,
              toolCalls: [...toolCalls.entries()].map(([id, call]) => ({
                id,
                name: call.name,
                arguments: call.args,
              })),
              usage,
            };
          });
        const recordResponse = (
          response: HttpClientResponse.HttpClientResponse,
          requestId: string,
          usage: ApiProviderUsageRecord | undefined,
        ) =>
          Effect.gen(function* () {
            const headers = response.headers ?? {};
            const providerRequestId = Object.entries(headers).find(([key]) =>
              /^(x-request-id|request-id)$/iu.test(key),
            )?.[1];
            if (usage) {
              totalUsage = {
                inputTokens: (totalUsage?.inputTokens ?? 0) + (usage.inputTokens ?? 0),
                ...(usage.cachedInputTokens !== undefined ||
                totalUsage?.cachedInputTokens !== undefined
                  ? {
                      cachedInputTokens:
                        (totalUsage?.cachedInputTokens ?? 0) + (usage.cachedInputTokens ?? 0),
                    }
                  : {}),
                outputTokens: (totalUsage?.outputTokens ?? 0) + (usage.outputTokens ?? 0),
                ...(usage.reasoningOutputTokens !== undefined ||
                totalUsage?.reasoningOutputTokens !== undefined
                  ? {
                      reasoningOutputTokens:
                        (totalUsage?.reasoningOutputTokens ?? 0) +
                        (usage.reasoningOutputTokens ?? 0),
                    }
                  : {}),
                ...(usage.providerCostUsd !== undefined || totalUsage?.providerCostUsd !== undefined
                  ? {
                      providerCostUsd:
                        (totalUsage?.providerCostUsd ?? 0) + (usage.providerCostUsd ?? 0),
                    }
                  : {}),
              };
              const usedTokens = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
              const totalProcessedTokens =
                (totalUsage.inputTokens ?? 0) + (totalUsage.outputTokens ?? 0);
              const maxTokens = apiModelContextWindow(inputSettings, model);
              yield* publish({
                type: "thread.token-usage.updated",
                ...(yield* stamp()),
                provider: PROVIDER,
                threadId: input.threadId,
                turnId,
                payload: {
                  usage: {
                    usedTokens,
                    totalProcessedTokens,
                    ...(maxTokens !== undefined ? { maxTokens } : {}),
                    ...(usage.inputTokens !== undefined
                      ? { inputTokens: usage.inputTokens, lastInputTokens: usage.inputTokens }
                      : {}),
                    ...(usage.cachedInputTokens !== undefined
                      ? {
                          cachedInputTokens: usage.cachedInputTokens,
                          lastCachedInputTokens: usage.cachedInputTokens,
                        }
                      : {}),
                    ...(usage.outputTokens !== undefined
                      ? { outputTokens: usage.outputTokens, lastOutputTokens: usage.outputTokens }
                      : {}),
                    ...(usage.reasoningOutputTokens !== undefined
                      ? {
                          reasoningOutputTokens: usage.reasoningOutputTokens,
                          lastReasoningOutputTokens: usage.reasoningOutputTokens,
                        }
                      : {}),
                    lastUsedTokens: usedTokens,
                  },
                },
              });
            }
            const recordedAt = yield* nowIso;
            if (usageLedger)
              yield* usageLedger.append({
                providerInstanceId: instanceId,
                profileId: String(inputSettings.profileId),
                threadId: input.threadId,
                turnId,
                model,
                requestId: providerRequestId ?? requestId,
                ...(usage?.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
                ...(usage?.cachedInputTokens !== undefined
                  ? { cachedInputTokens: usage.cachedInputTokens }
                  : {}),
                ...(usage?.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
                ...(usage?.reasoningOutputTokens !== undefined
                  ? { reasoningOutputTokens: usage.reasoningOutputTokens }
                  : {}),
                ...(usage?.providerCostUsd !== undefined
                  ? {
                      providerReportedCostUsd: usage.providerCostUsd,
                      costSource: "provider-reported" as const,
                    }
                  : { costSource: "unavailable" as const }),
                recordedAt,
              });
            const rateLimitHeaders = [
              ...Object.entries(headers).filter(([key]) => /^(x-ratelimit|ratelimit)/iu.test(key)),
              ...Object.entries(headers).filter(([key]) => key.toLowerCase() === "retry-after"),
            ];
            if (rateLimitHeaders.length > 0) {
              const rateLimits = Object.fromEntries([
                ...rateLimitHeaders,
                ["model", model],
                ["telemetrySource", "provider-reported"],
              ]);
              lastRateLimits = rateLimits;
              yield* publish({
                type: "account.rate-limits.updated",
                ...(yield* stamp()),
                provider: PROVIDER,
                threadId: input.threadId,
                turnId,
                payload: { rateLimits },
              });
            } else if (String(inputSettings.profileId) === "sensenova") {
              const nowMs = Date.parse(recordedAt);
              const windowDurationMs = 5 * 60 * 60 * 1000;
              if (
                !Number.isFinite(nowMs) ||
                nowMs - localSenseNovaWindow.startedAtMs >= windowDurationMs
              ) {
                localSenseNovaWindow = {
                  startedAtMs: Number.isFinite(nowMs) ? nowMs : yield* Clock.currentTimeMillis,
                  requestCount: 0,
                };
              }
              let requestCount = localSenseNovaWindow.requestCount + 1;
              let windowStartedAtMs = localSenseNovaWindow.startedAtMs;
              if (usageLedger) {
                const recentRecords = yield* usageLedger.list();
                const windowStartMs = nowMs - windowDurationMs;
                const matchingRecords = recentRecords.filter(
                  (entry) =>
                    entry.providerInstanceId === instanceId &&
                    entry.profileId === String(inputSettings.profileId) &&
                    entry.model === model &&
                    Number.isFinite(Date.parse(entry.recordedAt)) &&
                    Date.parse(entry.recordedAt) >= windowStartMs,
                );
                requestCount = matchingRecords.length;
                windowStartedAtMs = matchingRecords.reduce(
                  (oldest, entry) => Math.min(oldest, Date.parse(entry.recordedAt)),
                  nowMs,
                );
              } else {
                localSenseNovaWindow = { startedAtMs: windowStartedAtMs, requestCount };
              }
              const rateLimits = {
                model,
                telemetrySource: "local-observation",
                "sensenova-quota-limit-requests": "1500",
                "sensenova-quota-remaining-requests": String(Math.max(0, 1500 - requestCount)),
                "sensenova-quota-reset-at": DateTime.formatIso(
                  DateTime.makeUnsafe(windowStartedAtMs + windowDurationMs),
                ),
              };
              lastRateLimits = rateLimits;
              yield* publish({
                type: "account.rate-limits.updated",
                ...(yield* stamp()),
                provider: PROVIDER,
                threadId: input.threadId,
                turnId,
                payload: { rateLimits },
              });
            }
          });

        for (let round = 0; round < 12; round += 1) {
          const requestId = yield* nextUuid;
          const currentPlan =
            round === 0
              ? plan
              : requestPlan({
                  settings: inputSettings,
                  apiKey,
                  model,
                  text: "",
                  history: context.history,
                  ...(input.modelSelection?.options
                    ? { options: input.modelSelection.options }
                    : {}),
                });
          if (!currentPlan)
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "sendTurn",
              issue: "Unable to build the API follow-up request.",
            });
          const response = yield* executeProviderRequest(
            HttpClientRequest.post(currentPlan.url).pipe(
              HttpClientRequest.setHeaders(currentPlan.headers),
              HttpClientRequest.setHeader("x-client-request-id", requestId),
              HttpClientRequest.bodyJsonUnsafe(currentPlan.body),
            ),
            round === 0 ? "sendTurn" : "sendTurn.followUp",
          );
          const result = yield* consumeResponse(response);
          yield* recordResponse(response, requestId, result.usage);
          if (result.toolCalls.length === 0) {
            if (result.assistantText.length > 0) {
              context.history.push({ role: "assistant", content: result.assistantText });
              turn.items.push({ type: "assistant_message", content: result.assistantText });
            }
            completed = true;
            break;
          }
          context.history.push({
            role: "assistant",
            ...(result.assistantText.length > 0 ? { content: result.assistantText } : {}),
            toolCalls: result.toolCalls,
          });
          turn.items.push({ type: "tool_calls", calls: result.toolCalls });
          const results: Array<{ id: string; name: string; result: string }> = [];
          for (const call of result.toolCalls) {
            const toolResult = yield* executeTool(
              context,
              input.threadId,
              turnId,
              call.id,
              call.name,
              call.arguments,
              context.session.cwd,
            );
            results.push({ id: call.id, name: call.name, result: toolResult });
            turn.items.push({
              type: "tool_result",
              id: call.id,
              name: call.name,
              result: toolResult,
            });
          }
          context.history.push({ role: "tool", toolResults: results });
        }
        if (!completed) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "sendTurn",
            detail: "The API provider exceeded the maximum tool-call rounds for this turn.",
          });
        }
        turn.historyEnd = context.history.length;
        const live = sessions.get(input.threadId);
        if (!live || live.interrupted.has(turnId)) return;
        const resumeCursor = resumeCursorForContext(live.history, live.turns);
        live.session = {
          ...live.session,
          status: "ready",
          activeTurnId: undefined,
          resumeCursor,
          updatedAt: yield* nowIso,
        };
        yield* publish({
          type: "turn.completed",
          ...(yield* stamp()),
          provider: PROVIDER,
          threadId: input.threadId,
          turnId,
          payload: {
            state: "completed",
            stopReason: "end_turn",
            ...(totalUsage
              ? {
                  usage: totalUsage,
                  ...(totalUsage.providerCostUsd !== undefined
                    ? { totalCostUsd: totalUsage.providerCostUsd }
                    : {}),
                }
              : {}),
          },
        });
      }).pipe(
        Effect.tapError((cause) =>
          Effect.gen(function* () {
            const live = sessions.get(input.threadId);
            const detail = `API provider request failed: ${failureDetail(cause)}`;
            if (live)
              live.session = {
                ...live.session,
                status: "error",
                activeTurnId: undefined,
                updatedAt: yield* nowIso,
                lastError: detail,
              };
            yield* publish({
              type: "turn.completed",
              ...(yield* stamp()),
              provider: PROVIDER,
              threadId: input.threadId,
              turnId,
              payload: { state: "failed", errorMessage: detail },
            });
          }),
        ),
        Effect.mapError(
          (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "sendTurn",
              detail: `API provider request failed: ${failureDetail(cause)}`,
              cause,
            }),
        ),
      );
      // The adapter API deliberately returns before the turn completes. A
      // detached fiber lets cancellation retain a real handle without tying the
      // request to the short-lived WebSocket command scope.
      const fiber = yield* run.pipe(Effect.ignore, Effect.forkDetach);
      turnFibers.set(turnId, fiber);
      yield* Fiber.await(fiber).pipe(
        Effect.flatMap(() =>
          Effect.sync(() => {
            if (turnFibers.get(turnId) === fiber) turnFibers.delete(turnId);
          }),
        ),
        Effect.ignore,
        Effect.forkDetach,
      );
      return {
        threadId: input.threadId,
        turnId,
        resumeCursor: resumeCursorForContext(context.history, context.turns),
      };
    });

  const unsupported = (operation: string) =>
    Effect.fail(
      new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: operation,
        detail: "This API profile does not support this operation yet.",
      }),
    );
  return {
    provider: PROVIDER,
    capabilities: { sessionModelSwitch: "in-session" },
    startSession,
    sendTurn,
    interruptTurn: (threadId: ThreadId, turnId?: TurnId) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        const active = turnId ?? context.session.activeTurnId;
        if (active) {
          context.interrupted.add(active);
          const fiber = turnFibers.get(active);
          if (fiber) yield* Fiber.interrupt(fiber);
          turnFibers.delete(active);
        }
        context.session = {
          ...context.session,
          status: "ready",
          activeTurnId: undefined,
          updatedAt: yield* nowIso,
        };
        if (active)
          yield* publish({
            type: "turn.aborted",
            ...(yield* stamp()),
            provider: PROVIDER,
            threadId,
            turnId: active,
            payload: { reason: "Interrupted by user." },
          });
      }),
    respondToRequest: (
      threadId: ThreadId,
      requestId: ApprovalRequestId,
      decision: "accept" | "acceptForSession" | "decline" | "cancel",
    ) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        const pending = context.pendingApprovals.get(requestId);
        if (!pending)
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "respondToRequest",
            issue: "Approval request is no longer pending.",
          });
        yield* Deferred.succeed(pending, decision);
      }),
    respondToUserInput: (
      threadId: ThreadId,
      requestId: ApprovalRequestId,
      answers: ProviderUserInputAnswers,
    ) =>
      Effect.gen(function* () {
        yield* requireSession(threadId);
        const pending = pendingUserInputs.get(requestId)?.answers;
        if (!pending)
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "respondToUserInput",
            issue: "User-input request is no longer pending.",
          });
        yield* Deferred.succeed(pending, answers);
      }),
    stopSession: (threadId: ThreadId) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        const active = context.session.activeTurnId;
        for (const pending of context.pendingApprovals.values())
          yield* Deferred.succeed(pending, "cancel");
        context.pendingApprovals.clear();
        for (const [requestId, pending] of pendingUserInputs) {
          if (pending.threadId === threadId) {
            yield* Deferred.succeed(pending.answers, {});
            pendingUserInputs.delete(requestId);
          }
        }
        if (active) {
          const fiber = turnFibers.get(active);
          if (fiber) yield* Fiber.interrupt(fiber);
          turnFibers.delete(active);
        }
        context.session = {
          ...context.session,
          status: "closed",
          activeTurnId: undefined,
          updatedAt: yield* nowIso,
        };
        sessions.delete(threadId);
      }),
    listSessions: () => Effect.succeed([...sessions.values()].map((context) => context.session)),
    hasSession: (threadId: ThreadId) => Effect.succeed(sessions.has(threadId)),
    readRateLimits: () => Effect.succeed(lastRateLimits),
    readThread: (threadId: ThreadId) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        return { threadId, turns: context.turns } satisfies ProviderThreadSnapshot;
      }),
    rollbackThread: (threadId: ThreadId, numTurns: number) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        if (!Number.isInteger(numTurns) || numTurns < 0 || numTurns > context.turns.length) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "rollbackThread",
            issue: "Rollback count must be a whole number within the current API thread.",
          });
        }
        if (numTurns === 0) return { threadId, turns: context.turns };
        const keepCount = context.turns.length - numTurns;
        const historyCut =
          keepCount === 0
            ? 0
            : (context.turns[keepCount - 1]?.historyEnd ?? context.history.length);
        context.turns.splice(keepCount);
        context.history.splice(historyCut);
        context.session = {
          ...context.session,
          resumeCursor: resumeCursorForContext(context.history, context.turns),
          updatedAt: yield* nowIso,
        };
        return { threadId, turns: context.turns };
      }),
    stopAll: () =>
      Effect.gen(function* () {
        for (const context of sessions.values())
          for (const pending of context.pendingApprovals.values())
            yield* Deferred.succeed(pending, "cancel");
        for (const pending of pendingUserInputs.values())
          yield* Deferred.succeed(pending.answers, {});
        pendingUserInputs.clear();
        for (const fiber of turnFibers.values()) yield* Fiber.interrupt(fiber);
        turnFibers.clear();
        sessions.clear();
      }),
    streamEvents: Stream.fromPubSub(events),
  } satisfies ProviderAdapterShape<ProviderAdapterError>;
});
