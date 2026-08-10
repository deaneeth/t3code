import { describe, expect, it } from "vite-plus/test";
import {
  apiKeyFingerprint,
  buildAuthHeaders,
  modelDiscoveryRequest,
  normalizeUsagePayload,
  normalizeModelList,
  parseSseBlock,
  parseSseBlockEvents,
  readApiProviderText,
  redactApiSecret,
  resolveApiBaseUrl,
  summarizeApiProviderError,
  validateApiBaseUrl,
} from "./apiProviderTransport.ts";
import { ApiProviderSettings } from "@t3tools/contracts";
import { normalizeApiUserInputQuestions, requestPlan } from "./Layers/ApiProviderAdapter.ts";

describe("api provider transport", () => {
  it("unwraps SenseNova data usage and includes knowledge tokens in input usage", () => {
    expect(
      normalizeUsagePayload({
        data: {
          usage: { prompt_tokens: 4, knowledge_tokens: 2, completion_tokens: 3, total_tokens: 9 },
        },
      }),
    ).toMatchObject({ inputTokens: 6, outputTokens: 3 });
  });

  it("normalizes endpoints and never exposes an API key in diagnostics", () => {
    expect(resolveApiBaseUrl({ defaultBaseUrl: "https://api.example/v1/", override: "  " })).toBe(
      "https://api.example/v1",
    );
    expect(apiKeyFingerprint("sk-secret-1234")).toBe("••••1234");
    expect(redactApiSecret("request sk-secret-1234 failed", "sk-secret-1234")).toBe(
      "request [REDACTED] failed",
    );
    expect(buildAuthHeaders({ apiKey: "key", apiKeyHeader: "x-api-key" })).toEqual({
      "x-api-key": "key",
    });
    expect(validateApiBaseUrl("https://api.example/v1")).toBeUndefined();
    expect(validateApiBaseUrl("file:///etc/passwd")).toBe("API base URL must use http or https.");
    expect(validateApiBaseUrl("https://user:secret@example.com")).toContain("embedded credentials");
    expect(
      summarizeApiProviderError(
        '{"error":{"message":"model is not available","code":"ModelNotFound"}}',
        400,
      ),
    ).toBe("HTTP 400: model is not available (ModelNotFound).");
    expect(summarizeApiProviderError("bad request", 400)).toBe("HTTP 400: bad request");
    expect(
      normalizeUsagePayload({ usage: { prompt_tokens: 4, completion_tokens: 3 }, cost: 0.02 }),
    ).toEqual({ inputTokens: 4, outputTokens: 3, providerCostUsd: 0.02 });
    const customAuthSettings = ApiProviderSettings.make({
      enabled: true,
      profileId: "customOpenAICompatible",
      protocol: "openai-chat-completions",
      baseUrl: "https://api.example/v1",
      apiKeyHeader: "x-api-key",
      apiKeyPrefix: "",
      apiKeyEnvironmentVariable: "T3_API_KEY",
      organization: "",
      project: "",
      region: "",
      customModels: [],
    });
    expect(
      requestPlan({
        settings: customAuthSettings,
        apiKey: "key",
        model: "model",
        text: "hello",
        history: [],
      })?.headers,
    ).toMatchObject({ "x-api-key": "key" });
    expect(
      requestPlan({
        settings: { ...customAuthSettings, organization: "org-test", project: "project-test" },
        apiKey: "key",
        model: "model",
        text: "hello",
        history: [],
      })?.headers,
    ).toMatchObject({ "OpenAI-Organization": "org-test", "OpenAI-Project": "project-test" });
    const noAuthSettings = ApiProviderSettings.make({
      ...customAuthSettings,
      apiKeyHeader: "none",
    });
    expect(
      requestPlan({
        settings: noAuthSettings,
        apiKey: "key",
        model: "model",
        text: "hello",
        history: [],
      })?.headers,
    ).not.toHaveProperty("Authorization");
  });

  it("discovers OpenAI-compatible and Gemini model lists with explicit unsupported states", () => {
    expect(
      modelDiscoveryRequest({
        protocol: "openai-chat-completions",
        baseUrl: "https://api.example/v1",
        headers: {},
      })?.url,
    ).toBe("https://api.example/v1/models");
    expect(
      modelDiscoveryRequest({
        protocol: "anthropic-messages",
        baseUrl: "https://api.anthropic.com/v1",
        headers: {},
      })?.url,
    ).toBe("https://api.anthropic.com/v1/models");
    expect(
      modelDiscoveryRequest({
        protocol: "openai-chat-completions",
        baseUrl: "https://api.sensenova.cn/v1",
        headers: {},
      })?.url,
    ).toBe("https://api.sensenova.cn/v1/llm/models");
    expect(
      modelDiscoveryRequest({
        protocol: "openai-chat-completions",
        baseUrl: "https://token.sensenova.ai/v1",
        headers: {},
      })?.url,
    ).toBe("https://token.sensenova.ai/v1/models");
    expect(normalizeModelList("openai-chat-completions", { data: [{ id: "model-a" }] })).toEqual([
      { id: "model-a", name: "model-a" },
    ]);
    expect(
      normalizeModelList("gemini-generate-content", { models: [{ name: "models/gemini-test" }] }),
    ).toEqual([{ id: "gemini-test", name: "gemini-test" }]);
  });

  it("parses text, usage, and terminal SSE events", () => {
    expect(parseSseBlock('data: {"delta":{"text":"hello"}}')).toEqual({
      kind: "text-delta",
      text: "hello",
    });
    expect(parseSseBlock('data: {"type":"response.output_text.delta","delta":"hello"}')).toEqual({
      kind: "text-delta",
      text: "hello",
    });
    expect(parseSseBlock('data: {"usage":{"input_tokens":3,"output_tokens":2}}')).toEqual({
      kind: "usage",
      usage: { inputTokens: 3, outputTokens: 2 },
    });
    expect(parseSseBlock("data: [DONE]")).toEqual({ kind: "done" });
    expect(
      readApiProviderText(
        {
          output: [{ type: "message", content: [{ type: "output_text", text: "responses text" }] }],
        },
        "openai-responses",
      ),
    ).toBe("responses text");
  });

  it("normalizes tool-call fragments from OpenAI, Responses, and Anthropic streams", () => {
    expect(
      parseSseBlock(
        'data: {"choices":[{"delta":{"tool_calls":[{"id":"call-1","index":0,"function":{"name":"run_command","arguments":"abc"}}]}}]}',
      ),
    ).toMatchObject({
      kind: "tool-call-delta",
      toolCallId: "call-1",
      toolCallIndex: 0,
      toolName: "run_command",
      toolArgumentsDelta: "abc",
    });
    expect(
      parseSseBlock(
        'data: {"type":"response.function_call_arguments.delta","item_id":"call-2","delta":"{}"}',
      ),
    ).toEqual({ kind: "tool-call-delta", toolCallId: "call-2", toolArgumentsDelta: "{}" });
    expect(
      parseSseBlock(
        'data: {"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"README.md\\"}"}}',
      ),
    ).toEqual({ kind: "tool-call-delta", toolArgumentsDelta: '{"path":"README.md"}' });
  });

  it("keeps text and usage when a provider combines them in one SSE event", () => {
    expect(
      parseSseBlockEvents(
        'data: {"delta":{"text":"hello"},"usage":{"input_tokens":3,"output_tokens":2}}',
      ),
    ).toEqual([
      { kind: "text-delta", text: "hello" },
      { kind: "usage", usage: { inputTokens: 3, outputTokens: 2 } },
    ]);
  });

  it("maps Responses tools and follow-up history to Responses input items", () => {
    const settings = ApiProviderSettings.make({
      enabled: true,
      profileId: "openai",
      protocol: "openai-responses",
      baseUrl: "https://api.example/v1",
      apiKeyHeader: "",
      apiKeyPrefix: "",
      apiKeyEnvironmentVariable: "T3_API_KEY",
      organization: "",
      project: "",
      region: "",
      customModels: [],
    });
    const first = requestPlan({
      settings,
      apiKey: "key",
      model: "gpt-test",
      text: "inspect",
      history: [],
    });
    expect(first?.body).toMatchObject({ input: [{ role: "user" }] });
    expect(
      (first?.body as { tools: ReadonlyArray<Record<string, unknown>> }).tools[0],
    ).toMatchObject({ type: "function", name: "run_command" });
    const followUp = requestPlan({
      settings,
      apiKey: "key",
      model: "gpt-test",
      text: "",
      history: [
        { role: "user", content: "inspect" },
        {
          role: "assistant",
          toolCalls: [{ id: "call-1", name: "read_file", arguments: '{"path":"README.md"}' }],
        },
        { role: "tool", toolResults: [{ id: "call-1", name: "read_file", result: "contents" }] },
      ],
    });
    expect(followUp?.body).toMatchObject({
      input: [
        { role: "user" },
        { type: "function_call", call_id: "call-1", name: "read_file" },
        { type: "function_call_output", call_id: "call-1", output: "contents" },
      ],
    });
    expect((followUp?.body as { input: ReadonlyArray<unknown> }).input).not.toContainEqual({
      role: "user",
      content: [{ type: "input_text", text: "" }],
    });
  });

  it("parses provider-specific tool calls and usage without protocol fallbacks", () => {
    expect(parseSseBlock('data: {"content_block_start":{"type":"tool_use"}}')).toBeUndefined();
    expect(
      parseSseBlock(
        'data: {"type":"content_block_start","content_block":{"type":"tool_use","id":"anthropic-1","name":"read_file"}}',
      ),
    ).toMatchObject({ kind: "tool-call", toolCallId: "anthropic-1", toolName: "read_file" });
    expect(
      parseSseBlock(
        'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"run_command","args":{"command":"pwd"}}}]}}],"usageMetadata":{"promptTokenCount":4}}',
      ),
    ).toMatchObject({ kind: "tool-call", toolName: "run_command" });
    expect(
      parseSseBlock(
        'data: {"usage":{"promptTokenCount":4,"candidatesTokenCount":6,"cachedContentTokenCount":2}}',
      ),
    ).toEqual({ kind: "usage", usage: { inputTokens: 4, cachedInputTokens: 2, outputTokens: 6 } });
    expect(
      parseSseBlock(
        'data: {"type":"response.output_item.added","item":{"type":"function_call","id":"item-1","call_id":"response-1","name":"read_file","arguments":"{\\"path\\":\\"README.md\\"}"}}',
      ),
    ).toMatchObject({
      kind: "tool-call",
      toolCallId: "response-1",
      toolItemId: "item-1",
      toolName: "read_file",
    });
  });

  it("maps image attachments into each native request format", () => {
    const settings = (
      protocol:
        | "openai-responses"
        | "openai-chat-completions"
        | "anthropic-messages"
        | "gemini-generate-content",
    ) =>
      ApiProviderSettings.make({
        enabled: true,
        profileId:
          protocol === "gemini-generate-content"
            ? "googleGemini"
            : protocol === "anthropic-messages"
              ? "anthropic"
              : protocol === "openai-chat-completions"
                ? "customOpenAICompatible"
                : "openai",
        protocol,
        baseUrl: "https://api.example/v1",
        apiKeyHeader: "",
        apiKeyPrefix: "",
        apiKeyEnvironmentVariable: "T3_API_KEY",
        organization: "",
        project: "",
        region: "",
        customModels: [],
      });
    const attachment = [{ mimeType: "image/png", data: "aGVsbG8=" }];
    expect(
      requestPlan({
        settings: settings("openai-chat-completions"),
        apiKey: "key",
        model: "vision",
        text: "look",
        history: [],
        attachments: attachment,
      })?.body,
    ).toMatchObject({
      messages: [{ content: [{ type: "text", text: "look" }, { type: "image_url" }] }],
    });
    expect(
      requestPlan({
        settings: settings("anthropic-messages"),
        apiKey: "key",
        model: "vision",
        text: "look",
        history: [],
        attachments: attachment,
      })?.body,
    ).toMatchObject({
      messages: [
        {
          content: [
            { type: "text", text: "look" },
            { type: "image", source: { type: "base64", media_type: "image/png" } },
          ],
        },
      ],
    });
    expect(
      requestPlan({
        settings: settings("gemini-generate-content"),
        apiKey: "key",
        model: "vision",
        text: "look",
        history: [],
        attachments: attachment,
      })?.body,
    ).toMatchObject({
      contents: [
        { parts: [{ text: "look" }, { inlineData: { mimeType: "image/png", data: "aGVsbG8=" } }] },
      ],
    });
  });

  it("normalizes only renderable structured user questions", () => {
    expect(normalizeApiUserInputQuestions({ questions: [] })).toEqual([]);
    expect(
      normalizeApiUserInputQuestions([
        {
          id: "choice",
          header: "Choice",
          question: "Pick one",
          options: [{ label: "A", description: "A choice" }],
          multiSelect: false,
        },
        { id: "invalid", header: "", question: "Missing header", options: [] },
      ]),
    ).toEqual([
      {
        id: "choice",
        header: "Choice",
        question: "Pick one",
        options: [{ label: "A", description: "A choice" }],
        multiSelect: false,
      },
    ]);
    expect(
      normalizeApiUserInputQuestions([
        {
          id: "choice",
          header: "Choice",
          question: "Pick one",
          options: [{ label: "A", description: "A choice" }],
          multiSelect: true,
        },
      ]),
    ).toEqual([
      {
        id: "choice",
        header: "Choice",
        question: "Pick one",
        options: [{ label: "A", description: "A choice" }],
        multiSelect: true,
      },
    ]);
  });

  it("applies only explicitly selected model options to native request fields", () => {
    const settings = ApiProviderSettings.make({
      enabled: true,
      profileId: "customOpenAICompatible",
      protocol: "openai-chat-completions",
      baseUrl: "https://api.example/v1",
      apiKeyHeader: "",
      apiKeyPrefix: "",
      apiKeyEnvironmentVariable: "T3_API_KEY",
      organization: "",
      project: "",
      region: "",
      customModels: [],
    });
    const body = requestPlan({
      settings,
      apiKey: "key",
      model: "model-a",
      text: "hello",
      history: [],
      options: [
        { id: "temperature", value: "0.2" },
        { id: "maxOutputTokens", value: "8192" },
        { id: "parallelToolCalls", value: false },
      ],
    })?.body as Record<string, unknown>;
    expect(body).toMatchObject({ temperature: 0.2, max_tokens: 8192, parallel_tool_calls: false });
  });

  it("uses SenseNova's documented Chat Completions contract instead of Responses", () => {
    const settings = ApiProviderSettings.make({
      enabled: true,
      profileId: "openai",
      protocol: "openai-responses",
      baseUrl: "https://token.sensenova.ai/v1",
      apiKeyHeader: "",
      apiKeyPrefix: "",
      apiKeyEnvironmentVariable: "T3_API_KEY",
      organization: "",
      project: "",
      region: "",
      customModels: [],
    });
    const plan = requestPlan({
      settings,
      apiKey: "key",
      model: "sensenova-6.7-flash-lite",
      text: "hello",
      history: [],
      options: [{ id: "maxOutputTokens", value: "4096" }],
    });
    expect(plan).toMatchObject({
      url: "https://token.sensenova.ai/v1/chat/completions",
      body: {
        max_tokens: 4096,
        stream_options: { include_usage: true },
        tool_choice: "auto",
        parallel_tool_calls: true,
      },
    });
    const body = plan?.body as { tools?: ReadonlyArray<{ function?: { name?: string } }> };
    expect(body.tools?.[0]?.function?.name).toBe("run_command");
  });

  it("normalizes SenseNova model metadata and excludes its image-only U1 model from chat", () => {
    expect(
      normalizeModelList(
        "openai-chat-completions",
        {
          data: [
            {
              id: "sensenova-6.7-flash-lite",
              name: "SenseNova 6.7 Flash-Lite",
              context_length: 262144,
              max_output_length: 65536,
              input_modalities: ["text", "image"],
              supported_features: ["tools", "reasoning"],
            },
            { id: "sensenova-u1-fast", name: "SenseNova U1 Fast" },
          ],
        },
        { profileId: "sensenova" },
      ),
    ).toEqual([
      {
        id: "sensenova-6.7-flash-lite",
        name: "SenseNova 6.7 Flash-Lite",
        contextWindow: 262144,
        maxOutputTokens: 65536,
        supportsTools: true,
        supportsVision: true,
        supportsReasoning: true,
      },
    ]);
  });

  it("uses SenseNova's documented native route for the official API host", () => {
    const settings = ApiProviderSettings.make({
      enabled: true,
      profileId: "sensenova",
      protocol: "openai-chat-completions",
      baseUrl: "https://api.sensenova.cn/v1",
      apiKeyHeader: "",
      apiKeyPrefix: "",
      apiKeyEnvironmentVariable: "T3_API_KEY",
      organization: "",
      project: "",
      region: "",
      customModels: [],
    });
    expect(
      requestPlan({
        settings,
        apiKey: "key",
        model: "SenseNova-V6.5-Pro",
        text: "hello",
        history: [],
      })?.url,
    ).toBe("https://api.sensenova.cn/v1/llm/chat-completions");
  });

  it("reads SenseNova's nested streaming envelope", () => {
    expect(
      parseSseBlock(
        'data: {"data":{"choices":[{"delta":"hello"}],"usage":{"prompt_tokens":2,"completion_tokens":1}}}',
      ),
    ).toEqual({ kind: "text-delta", text: "hello" });
  });
});
