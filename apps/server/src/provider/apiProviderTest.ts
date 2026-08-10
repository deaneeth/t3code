import {
  ApiProviderSettings,
  ApiProviderTestError,
  type ApiProviderTestInput,
  type ApiProviderTestResult,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import * as Stream from "effect/Stream";
import { requestPlan } from "./Layers/ApiProviderAdapter.ts";
import { isApiProviderChatModel, normalizeApiProviderSettings } from "./apiProviderProfiles.ts";
import {
  parseSseBlockEvents,
  readApiProviderText,
  redactApiSecret,
  summarizeApiProviderError,
} from "./apiProviderTransport.ts";

export function readApiProviderTestText(payload: unknown): string {
  return readApiProviderText(payload);
}

export function explainApiProviderTestFailure(detail: string, model: string): string {
  if (/model\s+(?:is\s+)?not\s+deployed|model\s+is\s+not\s+found/iu.test(detail)) {
    return `${detail} The API key is authenticated, but SenseNova has not enabled '${model}' for this account. Enable/deploy the model in the SenseNova console, then test again.`;
  }
  if (/forbidden|unauthorized|invalid\s+(?:api\s+)?key/iu.test(detail)) {
    return `${detail} The provider rejected this API key or account authorization.`;
  }
  return detail;
}

const readStreamingApiText = (response: HttpClientResponse.HttpClientResponse) =>
  Effect.gen(function* () {
    const contentType =
      Object.entries(response.headers ?? {}).find(
        ([key]) => key.toLowerCase() === "content-type",
      )?.[1] ?? "";
    if (contentType.includes("json")) return readApiProviderTestText(yield* response.json);
    let block = "";
    let text = "";
    yield* response.stream.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.runForEach((line) =>
        Effect.sync(() => {
          if (line.trim().length === 0) {
            if (block.length > 0) {
              for (const event of parseSseBlockEvents(block))
                if (event.kind === "text-delta") text += event.text ?? "";
              block = "";
            }
          } else if (line.startsWith("data:")) {
            block += `${line}\n`;
          }
        }),
      ),
    );
    if (block.length > 0)
      for (const event of parseSseBlockEvents(block))
        if (event.kind === "text-delta") text += event.text ?? "";
    return text;
  });

export const testApiProvider = (
  input: ApiProviderTestInput,
  httpClient: HttpClient.HttpClient,
): Effect.Effect<ApiProviderTestResult, ApiProviderTestError> =>
  Effect.gen(function* () {
    const settings = normalizeApiProviderSettings(
      ApiProviderSettings.make({
        enabled: true,
        profileId: input.profileId,
        protocol: input.protocol,
        baseUrl: input.baseUrl,
        apiKeyHeader: input.apiKeyHeader ?? "",
        apiKeyPrefix: input.apiKeyPrefix ?? "",
        apiKeyEnvironmentVariable: "T3_API_KEY",
        organization: "",
        project: "",
        region: "",
        customModels: [],
      }),
    );
    if (!isApiProviderChatModel(String(settings.profileId), input.model))
      return yield* new ApiProviderTestError({
        profileId: input.profileId,
        detail: `Model '${input.model}' is an image-generation model and cannot be tested as a chat provider.`,
      });
    const plan = requestPlan({
      settings,
      apiKey: input.apiKey,
      model: input.model,
      text: "Reply with exactly: OK",
      history: [],
      options: [{ id: "maxOutputTokens", value: "64" }],
      includeTools: false,
      stream: false,
    });
    if (!plan?.body)
      return yield* new ApiProviderTestError({
        profileId: input.profileId,
        detail: "This provider profile could not build a test request.",
      });
    const executeTestRequest =
      (failurePrefix: string) => (request: HttpClientRequest.HttpClientRequest) =>
        request.pipe(
          httpClient.execute,
          Effect.timeout("30 seconds"),
          Effect.catch((cause) =>
            Effect.fail(
              new ApiProviderTestError({
                profileId: input.profileId,
                detail: redactApiSecret(`${failurePrefix}: ${String(cause)}`, input.apiKey).slice(
                  0,
                  500,
                ),
              }),
            ),
          ),
        );
    const response = yield* HttpClientRequest.post(plan.url).pipe(
      HttpClientRequest.setHeaders({
        ...plan.headers,
        ...(settings.protocol === "anthropic-messages"
          ? { "anthropic-version": "2023-06-01" }
          : {}),
      }),
      HttpClientRequest.bodyJsonUnsafe(plan.body),
      executeTestRequest("Provider connection failed"),
    );
    if (response.status < 200 || response.status >= 300) {
      const body = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
      return yield* new ApiProviderTestError({
        profileId: input.profileId,
        detail: explainApiProviderTestFailure(
          redactApiSecret(summarizeApiProviderError(body, response.status), input.apiKey),
          input.model,
        ),
      });
    }
    const payload = yield* response.json.pipe(
      Effect.catch((cause) =>
        Effect.fail(
          new ApiProviderTestError({
            profileId: input.profileId,
            detail: `Provider returned an invalid JSON response: ${String(cause).replace(/\s+/gu, " ").slice(0, 300)}`,
          }),
        ),
      ),
    );
    const text = readApiProviderTestText(payload).trim();
    if (!text)
      return yield* new ApiProviderTestError({
        profileId: input.profileId,
        detail: "Provider responded successfully but returned no assistant text.",
      });
    const streamingPlan = requestPlan({
      settings,
      apiKey: input.apiKey,
      model: input.model,
      text: "Reply with exactly: OK",
      history: [],
      options: [{ id: "maxOutputTokens", value: "64" }],
      includeTools: false,
      stream: true,
    });
    if (!streamingPlan?.body)
      return yield* new ApiProviderTestError({
        profileId: input.profileId,
        detail: "This provider profile could not build a streaming test request.",
      });
    const streamingResponse = yield* HttpClientRequest.post(streamingPlan.url).pipe(
      HttpClientRequest.setHeaders({
        ...streamingPlan.headers,
        ...(settings.protocol === "anthropic-messages"
          ? { "anthropic-version": "2023-06-01" }
          : {}),
      }),
      HttpClientRequest.bodyJsonUnsafe(streamingPlan.body),
      executeTestRequest("Streaming verification failed"),
    );
    if (streamingResponse.status < 200 || streamingResponse.status >= 300) {
      const body = yield* streamingResponse.text.pipe(Effect.orElseSucceed(() => ""));
      return yield* new ApiProviderTestError({
        profileId: input.profileId,
        detail: explainApiProviderTestFailure(
          redactApiSecret(summarizeApiProviderError(body, streamingResponse.status), input.apiKey),
          input.model,
        ),
      });
    }
    const streamingText = (yield* readStreamingApiText(streamingResponse).pipe(
      Effect.mapError(
        (cause) =>
          new ApiProviderTestError({
            profileId: input.profileId,
            detail: `Streaming response could not be read: ${String(cause).replace(/\s+/gu, " ").slice(0, 300)}`,
          }),
      ),
    )).trim();
    if (!streamingText)
      return yield* new ApiProviderTestError({
        profileId: input.profileId,
        detail: "Provider returned text for JSON mode but no assistant text for streaming mode.",
      });
    const checkedAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso), Effect.orDie);
    return { model: input.model, response: text.slice(0, 500), checkedAt };
  });
