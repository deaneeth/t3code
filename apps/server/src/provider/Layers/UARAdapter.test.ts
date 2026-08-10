// @effect-diagnostics globalFetch:off nodeBuiltinImport:off

import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";

import {
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";

import { createUARAdapter } from "./UARAdapter.ts";

describe("UARAdapter", () => {
  it.effect(
    "runs a turn, publishes canonical events, preserves empty assistant turns, and rolls back safely",
    () =>
      Effect.gen(function* () {
        const originalFetch = globalThis.fetch;
        const requests: Request[] = [];
        globalThis.fetch = (async (
          input: Parameters<typeof fetch>[0],
          init?: Parameters<typeof fetch>[1],
        ) => {
          requests.push(input instanceof Request ? input : new Request(String(input), init));
          return new Response(JSON.stringify({ choices: [{ message: { content: "hello" } }] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }) as unknown as typeof globalThis.fetch;

        try {
          const completed =
            yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "turn.completed" }>>();
          const adapter = createUARAdapter({
            baseUrl: "https://mock.example/v1",
            apiKey: "test-key",
            loopConfig: { stream: false },
          });
          const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
            event.type === "turn.completed"
              ? Deferred.succeed(completed, event).pipe(Effect.ignore)
              : Effect.void,
          ).pipe(Effect.forkChild);
          const threadId = ThreadId.make("uar-adapter-test");

          const session = yield* adapter.startSession({
            provider: ProviderDriverKind.make("api"),
            threadId,
            runtimeMode: "full-access",
            cwd: process.cwd(),
            modelSelection: {
              instanceId: ProviderInstanceId.make("mock-api"),
              model: "mock-model",
            },
          });
          expect(session.model).toBe("mock-model");

          const result = yield* adapter.sendTurn({ threadId, input: "say hello", attachments: [] });
          const event = yield* Deferred.await(completed);
          expect(result.threadId).toBe(threadId);
          expect(event.payload.state).toBe("completed");
          expect(requests).toHaveLength(1);
          expect((yield* adapter.readThread(threadId)).turns).toHaveLength(1);

          // `numTurns = 0` must be a no-op; the old splice(-0) behavior erased all history.
          expect((yield* adapter.rollbackThread(threadId, 0)).turns).toHaveLength(1);
          expect((yield* adapter.rollbackThread(threadId, 1)).turns).toHaveLength(0);

          const attachmentFailure = yield* Effect.result(
            adapter.sendTurn({
              threadId,
              input: "image",
              attachments: [
                {
                  type: "image",
                  id: "image-1",
                  name: "x.png",
                  mimeType: "image/png",
                  sizeBytes: 1,
                },
              ],
            }),
          );
          expect(Result.isFailure(attachmentFailure)).toBe(true);

          yield* Fiber.interrupt(eventsFiber);
          yield* adapter.stopSession(threadId);
        } finally {
          globalThis.fetch = originalFetch;
        }
      }).pipe(Effect.scoped),
  );
});
