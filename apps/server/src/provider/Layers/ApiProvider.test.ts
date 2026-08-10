import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import { ApiProviderSettings } from "@t3tools/contracts";

import { checkApiProviderStatus } from "./ApiProvider.ts";

describe("API provider status", () => {
  it.effect("uses SenseNova model metadata and excludes its image-only model", () =>
    Effect.gen(function* () {
      const httpClient = HttpClient.make((request) => {
        const response =
          request.method === "GET"
            ? new Response(
                JSON.stringify({
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
                }),
                { status: 200, headers: { "content-type": "application/json" } },
              )
            : new Response(JSON.stringify({ choices: [{ message: { content: "OK" } }] }), {
                status: 200,
                headers: { "content-type": "application/json" },
              });
        return Effect.succeed(HttpClientResponse.fromWeb(request, response));
      });
      const snapshot = yield* checkApiProviderStatus({
        settings: ApiProviderSettings.make({
          enabled: true,
          profileId: "sensenova",
          protocol: "openai-chat-completions",
          baseUrl: "https://token.sensenova.ai/v1",
          apiKeyHeader: "",
          apiKeyPrefix: "",
          apiKeyEnvironmentVariable: "T3_API_KEY",
          organization: "",
          project: "",
          region: "",
          customModels: [],
        }),
        apiKey: "test-key",
        httpClient,
      });
      expect(snapshot.models.map((model) => model.slug)).toEqual(["sensenova-6.7-flash-lite"]);
      expect(snapshot.models[0]?.capabilities).toMatchObject({
        contextWindow: 262144,
        maxOutputTokens: 65536,
        supportsToolCalls: true,
        supportsVision: true,
        supportsReasoning: true,
      });
      expect(snapshot.apiCapabilities?.toolCalls.state).toBe("partial");
    }),
  );

  it.effect("keeps a manually configured model usable when discovery is unavailable", () =>
    Effect.gen(function* () {
      const httpClient = HttpClient.make((request) => {
        const response =
          request.method === "GET"
            ? new Response("discovery disabled", { status: 404 })
            : new Response(JSON.stringify({ choices: [{ message: { content: "OK" } }] }), {
                status: 200,
                headers: { "content-type": "application/json" },
              });
        return Effect.succeed(HttpClientResponse.fromWeb(request, response));
      });
      const snapshot = yield* checkApiProviderStatus({
        settings: ApiProviderSettings.make({
          enabled: true,
          profileId: "customOpenAICompatible",
          protocol: "openai-chat-completions",
          baseUrl: "https://mock.example/v1",
          apiKeyHeader: "",
          apiKeyPrefix: "",
          apiKeyEnvironmentVariable: "T3_API_KEY",
          organization: "",
          project: "",
          region: "",
          customModels: ["manual-model"],
        }),
        apiKey: "test-key",
        httpClient,
      });
      expect(snapshot.status).toBe("ready");
      expect(snapshot.message).toContain("manual-model");
      expect(snapshot.models.map((model) => model.slug)).toContain("manual-model");
      expect(snapshot.apiCapabilities?.authentication.state).toBe("verified");
    }),
  );
});
