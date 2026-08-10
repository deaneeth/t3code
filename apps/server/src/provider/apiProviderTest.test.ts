import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { ApiProviderProfileId } from "@t3tools/contracts";
import {
  explainApiProviderTestFailure,
  readApiProviderTestText,
  testApiProvider,
} from "./apiProviderTest.ts";

describe("API provider verification", () => {
  it("accepts the common provider response envelopes", () => {
    expect(readApiProviderTestText({ choices: [{ message: { content: "OK" } }] })).toBe("OK");
    expect(readApiProviderTestText({ data: { choices: [{ message: "OK" }] } })).toBe("OK");
    expect(readApiProviderTestText({ content: [{ type: "text", text: "OK" }] })).toBe("OK");
    expect(readApiProviderTestText({ output_text: "OK" })).toBe("OK");
  });

  it("rejects an empty provider response", () => {
    expect(readApiProviderTestText({ choices: [{ message: { content: "" } }] })).toBe("");
    expect(readApiProviderTestText({ status: { code: 0, message: "ok" } })).toBe("");
  });

  it("distinguishes an authenticated but undeployed model", () => {
    expect(
      explainApiProviderTestFailure("HTTP 400: Model not deployed (not_found).", "example-model"),
    ).toContain("authenticated");
    expect(explainApiProviderTestFailure("HTTP 401: Unauthorized.", "example-model")).toContain(
      "rejected this API key",
    );
  });

  it.effect("verifies both JSON and streaming inference", () =>
    Effect.gen(function* () {
      let requestCount = 0;
      const requestHeaders: Array<Readonly<Record<string, string>>> = [];
      const httpClient = HttpClient.make((request) => {
        requestCount += 1;
        requestHeaders.push(request.headers);
        const body =
          requestCount === 1
            ? JSON.stringify({ choices: [{ message: { content: "OK" } }] })
            : 'data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n\n';
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(body, {
              status: 200,
              headers: {
                "content-type": requestCount === 1 ? "application/json" : "text/event-stream",
              },
            }),
          ),
        );
      });
      const result = yield* testApiProvider(
        {
          profileId: ApiProviderProfileId.make("customOpenAICompatible"),
          protocol: "openai-chat-completions",
          baseUrl: "https://mock.example/v1",
          apiKeyHeader: "x-api-key",
          apiKeyPrefix: "",
          apiKey: "test-key",
          model: "mock-model",
        },
        httpClient,
      ).pipe(Effect.result);
      expect(result._tag).toBe("Success");
      expect(requestCount).toBe(2);
      expect(requestHeaders[0]).toMatchObject({ "x-api-key": "test-key" });
    }),
  );
});
