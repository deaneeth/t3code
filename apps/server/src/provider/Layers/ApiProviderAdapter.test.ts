import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import {
  ApiProviderSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";

import { makeApiProviderAdapter } from "./ApiProviderAdapter.ts";

const settings = ApiProviderSettings.make({
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
  customModels: [],
});

const sse = (events: ReadonlyArray<Record<string, unknown>>): string =>
  `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

describe("ApiProviderAdapter", () => {
  it.effect("executes a tool round, sends protocol-correct follow-up history, and completes", () =>
    Effect.gen(function* () {
      const requests: string[] = [];
      const httpClient = HttpClient.make((request) =>
        Effect.gen(function* () {
          const body =
            request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";
          requests.push(body);
          const response =
            requests.length === 1
              ? sse([
                  {
                    choices: [
                      {
                        delta: {
                          tool_calls: [
                            {
                              id: "call-read-1",
                              function: { name: "read_file", arguments: '{"path":"README.md"}' },
                            },
                          ],
                        },
                      },
                    ],
                  },
                  { usage: { prompt_tokens: 7, completion_tokens: 4 } },
                ])
              : sse([
                  { choices: [{ delta: { content: "The file was inspected." } }] },
                  { usage: { prompt_tokens: 11, completion_tokens: 5 } },
                ]);
          return HttpClientResponse.fromWeb(
            request,
            new Response(response, {
              status: 200,
              headers: {
                "content-type": "text/event-stream",
                "x-request-id": `mock-${requests.length}`,
              },
            }),
          );
        }),
      );
      const completed =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "turn.completed" }>>();
      const adapter = yield* makeApiProviderAdapter({
        instanceId: ProviderInstanceId.make("mock-api"),
        settings,
        apiKey: "test-key",
        httpClient,
        fileSystem: yield* FileSystem.FileSystem,
        childProcessSpawner: yield* ChildProcessSpawner.ChildProcessSpawner,
        path: yield* Path.Path,
        attachmentsDir: ".t3/attachments",
      }).pipe(Effect.provide(NodeServices.layer));
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        event.type === "turn.completed"
          ? Deferred.succeed(completed, event).pipe(Effect.ignore)
          : Effect.void,
      ).pipe(Effect.forkChild);
      const threadId = ThreadId.make("api-adapter-test");

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("api"),
        threadId,
        runtimeMode: "full-access",
        cwd: process.cwd(),
        modelSelection: { instanceId: ProviderInstanceId.make("mock-api"), model: "mock-model" },
      });
      yield* adapter.sendTurn({ threadId, input: "Inspect README.md", attachments: [] });
      const event = yield* Deferred.await(completed);

      expect(event.payload.state).toBe("completed");
      expect(requests).toHaveLength(2);
      expect(decodeJson(requests[1] ?? "")).toMatchObject({
        messages: [
          { role: "user", content: "Inspect README.md" },
          {
            role: "assistant",
            tool_calls: [{ id: "call-read-1", function: { name: "read_file" } }],
          },
          { role: "tool", tool_call_id: "call-read-1" },
        ],
      });
      expect((yield* adapter.readThread(threadId)).turns).toHaveLength(1);

      const persistedSession = (yield* adapter.listSessions())[0];
      expect(persistedSession?.resumeCursor).toBeDefined();
      yield* adapter.stopSession(threadId);
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("api"),
        threadId,
        runtimeMode: "full-access",
        cwd: process.cwd(),
        modelSelection: { instanceId: ProviderInstanceId.make("mock-api"), model: "mock-model" },
        ...(persistedSession?.resumeCursor !== undefined
          ? { resumeCursor: persistedSession.resumeCursor }
          : {}),
      });
      expect((yield* adapter.readThread(threadId)).turns).toHaveLength(1);
      expect((yield* adapter.rollbackThread(threadId, 1)).turns).toHaveLength(0);
      expect((yield* adapter.listSessions())[0]?.resumeCursor).toMatchObject({
        history: [],
        turns: [],
      });

      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
