// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalErrorInEffectCatch:off
// @effect-diagnostics globalErrorInEffectFailure:off
import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";
import { createServer } from "node:http";

import {
  ApiProviderSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { makeApiProviderAdapter } from "./ApiProviderAdapter.ts";

const settings = ApiProviderSettings.make({
  enabled: true,
  profileId: "sensenova",
  protocol: "openai-chat-completions",
  baseUrl: "",
  apiKeyHeader: "x-api-key",
  apiKeyPrefix: "",
  apiKeyEnvironmentVariable: "T3_API_KEY",
  organization: "",
  project: "",
  region: "",
  customModels: [],
});
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

describe("ApiProvider network integration", () => {
  it.effect("completes a real HTTP streaming tool round against a local compatible endpoint", () =>
    Effect.gen(function* () {
      let requests = 0;
      const requestBodies: string[] = [];
      const server = createServer((request, response) => {
        requests += 1;
        let requestBody = "";
        request.on("data", (chunk: Buffer) => {
          requestBody += chunk.toString();
        });
        request.on("end", () => {
          requestBodies.push(requestBody);
        });
        response.setHeader("content-type", "text/event-stream");
        response.setHeader("x-request-id", `network-${requests}`);
        response.writeHead(200);
        if (requests === 1) {
          response.end(
            'data: {"choices":[{"delta":{"tool_calls":[{"id":"call-read","function":{"name":"read_file","arguments":"{\\"path\\":\\"README.md\\"}"}}]}}],"usage":{"prompt_tokens":7,"completion_tokens":4}}\n\ndata: [DONE]\n\n',
          );
        } else {
          response.end(
            'data: {"data":{"choices":[{"delta":{"content":"network complete"}}],"usage":{"prompt_tokens":11,"completion_tokens":5}}}\n\ndata: [DONE]\n\n',
          );
        }
      });
      const port = yield* Effect.tryPromise({
        try: () =>
          new Promise<number>((resolve, reject) => {
            server.once("error", reject);
            server.listen(0, "127.0.0.1", () => {
              const address = server.address();
              resolve(typeof address === "object" && address !== null ? address.port : 0);
            });
          }),
        catch: (error) => (error instanceof Error ? error : new Error(String(error))),
      });
      const httpClient = yield* HttpClient.HttpClient;
      const adapter = yield* makeApiProviderAdapter({
        instanceId: ProviderInstanceId.make("network-api"),
        settings: { ...settings, baseUrl: `http://127.0.0.1:${port}` },
        apiKey: "network-key",
        httpClient,
        fileSystem: yield* FileSystem.FileSystem,
        childProcessSpawner: yield* ChildProcessSpawner.ChildProcessSpawner,
        path: yield* Path.Path,
        attachmentsDir: ".t3/attachments",
      });
      const completed =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "turn.completed" }>>();
      let latestUsage:
        | Extract<ProviderRuntimeEvent, { type: "thread.token-usage.updated" }>
        | undefined;
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) => {
        if (event.type === "thread.token-usage.updated") latestUsage = event;
        return event.type === "turn.completed"
          ? Deferred.succeed(completed, event).pipe(Effect.ignore)
          : Effect.void;
      }).pipe(Effect.forkChild);
      const threadId = ThreadId.make("network-api-thread");
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("api"),
        threadId,
        runtimeMode: "full-access",
        cwd: process.cwd(),
        modelSelection: {
          instanceId: ProviderInstanceId.make("network-api"),
          model: "sensenova-6.7-flash-lite",
        },
      });
      yield* adapter.sendTurn({
        threadId,
        input: "Read README.md",
        attachments: [],
        modelSelection: {
          instanceId: ProviderInstanceId.make("network-api"),
          model: "sensenova-6.7-flash-lite",
          options: [{ id: "maxOutputTokens", value: "65536" }],
        },
      });
      const event = yield* Deferred.await(completed);
      expect(event.payload.state).toBe("completed");
      expect(requests).toBe(2);
      const firstBody = decodeJson(requestBodies[0] ?? "{}");
      expect(firstBody).toMatchObject({
        model: "sensenova-6.7-flash-lite",
        max_tokens: 65536,
        stream: true,
        stream_options: { include_usage: true },
        tool_choice: "auto",
        parallel_tool_calls: true,
      });
      expect(
        ((firstBody as { tools?: Array<{ function?: { name?: string } }> }).tools ?? [])[0]
          ?.function?.name,
      ).toBe("run_command");
      expect(latestUsage?.payload.usage).toMatchObject({
        usedTokens: 16,
        totalProcessedTokens: 27,
        maxTokens: 262144,
        inputTokens: 11,
        outputTokens: 5,
      });
      expect(yield* adapter.readRateLimits()).toMatchObject({
        model: "sensenova-6.7-flash-lite",
        telemetrySource: "local-observation",
        "sensenova-quota-limit-requests": "1500",
        "sensenova-quota-remaining-requests": "1498",
      });
      expect((yield* adapter.readThread(threadId)).turns).toHaveLength(1);
      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
      yield* Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve())));
    }).pipe(Effect.provide(NodeServices.layer), Effect.provide(FetchHttpClient.layer)),
  );
});
