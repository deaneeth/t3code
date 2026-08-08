import {
  EventId,
  type ProviderApprovalDecision,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSession,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  type ProviderSessionStartInput,
  RuntimeItemId,
  type ThreadId,
  TurnId,
  type CommandCodeSettings,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import { collectStreamAsString } from "../providerSnapshot.ts";
import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";
import type { EventNdjsonLogger } from "./EventNdjsonLogger.ts";
import type {
  ProviderAdapterShape,
  ProviderThreadSnapshot,
  ProviderThreadTurnSnapshot,
} from "../Services/ProviderAdapter.ts";

const PROVIDER = ProviderDriverKind.make("commandcode");
const DEFAULT_MAX_TURNS = "100";
const DEFAULT_TURN_TIMEOUT_MS = 5 * 60 * 1000;

interface CommandCodeResultFrame {
  readonly type: "result";
  readonly subtype?: unknown;
  readonly sessionId?: unknown;
  readonly stopReason?: unknown;
  readonly usage?: unknown;
  readonly finalText?: unknown;
  readonly error?: unknown;
}

interface CommandCodeTurn {
  readonly turnId: TurnId;
  readonly prompt: string;
  readonly items: Array<unknown>;
}

interface ActiveCommandCodeTurn {
  readonly turnId: TurnId;
  readonly child: ChildProcessSpawner.ChildProcessHandle;
  interrupted: boolean;
  assistantMessageIndex: number;
  assistantItemId: string | undefined;
  thinkingItemId: string | undefined;
}

interface CommandCodeSessionContext {
  readonly threadId: ThreadId;
  session: ProviderSession;
  commandCodeSessionId: string | undefined;
  readonly sessionScope: Scope.Closeable;
  readonly turns: Array<CommandCodeTurn>;
  activeTurn: ActiveCommandCodeTurn | undefined;
  stopped: boolean;
}

export interface CommandCodeAdapterLiveOptions {
  readonly instanceId?: ProviderInstanceId;
  readonly environment?: NodeJS.ProcessEnv;
  readonly nativeEventLogger?: EventNdjsonLogger;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function readCommandCodeSessionId(cursor: unknown): string | undefined {
  if (typeof cursor === "string" && cursor.trim().length > 0) return cursor.trim();
  const fromRecord = stringValue(recordValue(cursor)?.sessionId);
  return fromRecord ? fromRecord.trim() : undefined;
}

function toolItemType(
  toolName: string,
): "command_execution" | "file_change" | "mcp_tool_call" | "dynamic_tool_call" {
  const normalized = toolName.toLowerCase();
  if (/(?:bash|shell|command|exec|terminal)/u.test(normalized)) return "command_execution";
  if (/(?:write|edit|patch|delete|move)/u.test(normalized)) return "file_change";
  if (normalized.includes("mcp")) return "mcp_tool_call";
  return "dynamic_tool_call";
}

function readToolName(event: Record<string, unknown>): string {
  return stringValue(event.toolName) ?? stringValue(event.name) ?? "CommandCode tool";
}

export function runtimeModeArgs(
  runtimeMode: ProviderSession["runtimeMode"],
  plan: boolean,
): ReadonlyArray<string> {
  if (plan) return ["--permission-mode", "plan"];
  switch (runtimeMode) {
    case "approval-required":
      return ["--permission-mode", "standard"];
    case "auto-accept-edits":
    case "auto":
      return ["--permission-mode", "auto-accept"];
    case "full-access":
      return ["--yolo"];
    default:
      return ["--permission-mode", "standard"];
  }
}

export function resultStopState(
  result: CommandCodeResultFrame | undefined,
): "completed" | "failed" | "interrupted" {
  if (!result) return "failed";
  const stopReason = stringValue(result?.stopReason)?.toLowerCase();
  if (stopReason === "cancelled" || stopReason === "canceled" || stopReason === "interrupted") {
    return "interrupted";
  }
  return (result?.error != null && result.error !== false && result.error !== "") ||
    stringValue(result?.subtype) === "error"
    ? "failed"
    : "completed";
}

export function usageSnapshot(usage: unknown): Record<string, number> | undefined {
  const record = recordValue(usage);
  if (!record) return undefined;
  const numeric = (key: string) =>
    typeof record[key] === "number" && Number.isFinite(record[key]) && record[key] >= 0
      ? record[key]
      : undefined;
  const inputTokens = numeric("inputTokens");
  const outputTokens = numeric("outputTokens");
  const reasoningOutputTokens = numeric("reasoningOutputTokens");
  const cachedInputTokens = numeric("cachedInputTokens");
  const maxTokens = numeric("maxTokens") ?? numeric("contextWindow") ?? numeric("context_window");
  const hasTokenComponents =
    inputTokens !== undefined || outputTokens !== undefined || reasoningOutputTokens !== undefined;
  const totalTokens =
    numeric("totalTokens") ??
    numeric("total") ??
    numeric("tokens") ??
    (hasTokenComponents
      ? (inputTokens ?? 0) + (outputTokens ?? 0) + (reasoningOutputTokens ?? 0)
      : undefined);
  if (totalTokens === undefined) return undefined;
  return {
    totalTokens,
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(reasoningOutputTokens !== undefined ? { reasoningOutputTokens } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
  };
}

export function makeCommandCodeAdapter(
  settings: CommandCodeSettings,
  options?: CommandCodeAdapterLiveOptions,
) {
  return Effect.gen(function* () {
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("commandcode");
    const environment = options?.environment ?? process.env;
    const crypto = yield* Crypto.Crypto;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const serverConfig = yield* ServerConfig;
    const runtimeEvents = yield* Queue.unbounded<ProviderRuntimeEvent>();
    const sessions = new Map<ThreadId, CommandCodeSessionContext>();
    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

    const randomUUID = crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "crypto.randomUUIDv4",
            detail: "Failed to generate CommandCode runtime identifier.",
            cause,
          }),
      ),
    );

    const emit = (input: {
      readonly type: ProviderRuntimeEvent["type"];
      readonly threadId: ThreadId;
      readonly turnId?: TurnId;
      readonly itemId?: string;
      readonly payload: unknown;
      readonly method?: string;
      readonly raw?: unknown;
    }) =>
      Effect.gen(function* () {
        const event: ProviderRuntimeEvent = {
          eventId: EventId.make(yield* randomUUID),
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: input.threadId,
          createdAt: DateTime.formatIso(yield* DateTime.now),
          ...(input.turnId ? { turnId: input.turnId } : {}),
          ...(input.itemId ? { itemId: RuntimeItemId.make(input.itemId) } : {}),
          type: input.type,
          payload: input.payload,
          ...(input.raw !== undefined
            ? {
                raw: {
                  source: "commandcode.cli.event" as const,
                  ...(input.method ? { method: input.method } : {}),
                  payload: input.raw,
                },
              }
            : {}),
        } as ProviderRuntimeEvent;
        if (input.turnId && input.type.startsWith("item.")) {
          const turn = sessions
            .get(input.threadId)
            ?.turns.find((entry) => entry.turnId === input.turnId);
          turn?.items.push({
            type: input.type,
            ...(input.itemId ? { itemId: input.itemId } : {}),
            payload: input.payload,
          });
        }
        yield* Queue.offer(runtimeEvents, event);
      });

    const updateSession = (context: CommandCodeSessionContext, patch: Partial<ProviderSession>) =>
      Effect.gen(function* () {
        context.session = {
          ...context.session,
          ...patch,
          updatedAt: yield* nowIso,
        };
      });

    const logNative = (context: CommandCodeSessionContext, method: string, payload: unknown) =>
      Effect.gen(function* () {
        if (!options?.nativeEventLogger) return;
        yield* options.nativeEventLogger.write(
          {
            observedAt: yield* nowIso,
            event: {
              id: yield* randomUUID,
              kind: "notification",
              provider: PROVIDER,
              threadId: context.threadId,
              method,
              payload,
            },
          },
          context.threadId,
        );
      }).pipe(Effect.catchCause((c) => Effect.logWarning("nativeEventLogger failed", c)));

    const handleEvent = Effect.fn("CommandCodeAdapter.handleEvent")(function* (
      context: CommandCodeSessionContext,
      turn: ActiveCommandCodeTurn,
      event: Record<string, unknown>,
    ) {
      const turnId = turn.turnId;
      const type = stringValue(event.type);
      const raw = { type: "event", event };
      if (!type) return;
      yield* logNative(context, type, event);

      switch (type) {
        case "run_start":
          yield* emit({
            type: "session.state.changed",
            threadId: context.threadId,
            turnId,
            payload: { state: "running", reason: "CommandCode run started." },
            method: type,
            raw,
          });
          return;
        case "message_start": {
          turn.assistantMessageIndex += 1;
          const assistantItemId = `assistant-${turnId}-${turn.assistantMessageIndex}`;
          turn.assistantItemId = assistantItemId;
          turn.thinkingItemId = undefined;
          yield* emit({
            type: "item.started",
            threadId: context.threadId,
            turnId,
            itemId: assistantItemId,
            payload: { itemType: "assistant_message", status: "inProgress" },
            method: type,
            raw,
          });
          return;
        }
        case "text_delta":
          if (typeof event.delta === "string" && event.delta.length > 0) {
            yield* emit({
              type: "content.delta",
              threadId: context.threadId,
              turnId,
              itemId: turn.assistantItemId ?? `assistant-${turnId}-1`,
              payload: { streamKind: "assistant_text", delta: event.delta },
              method: type,
              raw,
            });
          }
          return;
        case "message_end":
          yield* emit({
            type: "item.completed",
            threadId: context.threadId,
            turnId,
            itemId: turn.assistantItemId ?? `assistant-${turnId}-1`,
            payload: { itemType: "assistant_message", status: "completed" },
            method: type,
            raw,
          });
          return;
        case "thinking_start": {
          const thinkingItemId = `thinking-${turnId}-${turn.assistantMessageIndex ?? 1}`;
          turn.thinkingItemId = thinkingItemId;
          yield* emit({
            type: "item.started",
            threadId: context.threadId,
            turnId,
            itemId: thinkingItemId,
            payload: { itemType: "reasoning", status: "inProgress" },
            method: type,
            raw,
          });
          return;
        }
        case "thinking_delta":
          if (typeof event.delta === "string" && event.delta.length > 0) {
            yield* emit({
              type: "content.delta",
              threadId: context.threadId,
              turnId,
              itemId: turn.thinkingItemId ?? `thinking-${turnId}-1`,
              payload: { streamKind: "reasoning_text", delta: event.delta },
              method: type,
              raw,
            });
          }
          return;
        case "thinking_end":
          yield* emit({
            type: "item.completed",
            threadId: context.threadId,
            turnId,
            itemId: turn.thinkingItemId ?? `thinking-${turnId}-1`,
            payload: {
              itemType: "reasoning",
              status: "completed",
              ...(typeof event.text === "string" ? { data: { text: event.text } } : {}),
            },
            method: type,
            raw,
          });
          return;
        case "tool_queued":
        case "tool_running":
        case "tool_update":
        case "tool_completed":
        case "tool_errored": {
          const toolName = readToolName(event);
          const toolCallId = stringValue(event.toolCallId) ?? `${turnId}-${toolName}`;
          const completed = type === "tool_completed" || type === "tool_errored";
          yield* emit({
            type: completed
              ? "item.completed"
              : type === "tool_queued"
                ? "item.started"
                : "item.updated",
            threadId: context.threadId,
            turnId,
            itemId: toolCallId,
            payload: {
              itemType: toolItemType(toolName),
              status: completed ? (type === "tool_errored" ? "failed" : "completed") : "inProgress",
              title: toolName,
              ...(typeof event.description === "string" ? { detail: event.description } : {}),
              ...(event.input !== undefined ||
              event.result !== undefined ||
              event.error !== undefined ||
              event.partial !== undefined
                ? {
                    data: {
                      input: event.input,
                      result: event.result,
                      error: event.error,
                      partial: event.partial,
                    },
                  }
                : {}),
            },
            method: type,
            raw,
          });
          return;
        }
        case "tool_hook_blocked": {
          const toolName = readToolName(event);
          const toolCallId = stringValue(event.toolCallId) ?? `${turnId}-${toolName}`;
          yield* emit({
            type: "tool.denied",
            threadId: context.threadId,
            turnId,
            payload: {
              toolName,
              toolUseId: toolCallId,
              reason: stringValue(event.hookOutput) ?? "CommandCode blocked this tool call.",
            },
            method: type,
            raw,
          });
          yield* emit({
            type: "item.completed",
            threadId: context.threadId,
            turnId,
            itemId: toolCallId,
            payload: {
              itemType: toolItemType(toolName),
              status: "failed",
              title: toolName,
              detail: stringValue(event.hookOutput) ?? "CommandCode blocked this tool call.",
            },
            method: type,
            raw,
          });
          return;
        }
        case "tool_denied": {
          const toolName = readToolName(event);
          const toolCallId = stringValue(event.toolCallId) ?? `${turnId}-${toolName}`;
          const reason = stringValue(event.reason) ?? "CommandCode denied this tool call.";
          yield* emit({
            type: "tool.denied",
            threadId: context.threadId,
            turnId,
            payload: {
              toolName,
              toolUseId: toolCallId,
              reason,
            },
            method: type,
            raw,
          });
          yield* emit({
            type: "item.completed",
            threadId: context.threadId,
            turnId,
            itemId: toolCallId,
            payload: {
              itemType: toolItemType(toolName),
              status: "declined",
              title: toolName,
              detail: reason,
            },
            method: type,
            raw,
          });
          return;
        }
        case "model_request_end": {
          const usage = usageSnapshot(event.usage);
          if (usage) {
            yield* emit({
              type: "thread.token-usage.updated",
              threadId: context.threadId,
              turnId,
              payload: {
                usage: {
                  usedTokens: usage.totalTokens,
                  ...(usage.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
                  ...(usage.cachedInputTokens !== undefined
                    ? { cachedInputTokens: usage.cachedInputTokens }
                    : {}),
                  ...(usage.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
                  ...(usage.reasoningOutputTokens !== undefined
                    ? { reasoningOutputTokens: usage.reasoningOutputTokens }
                    : {}),
                  ...(usage.maxTokens !== undefined ? { maxTokens: usage.maxTokens } : {}),
                },
              },
              method: type,
              raw,
            });
          }
          return;
        }
        case "message_update":
          yield* emit({
            type: "item.updated",
            threadId: context.threadId,
            turnId,
            itemId: turn.assistantItemId ?? `assistant-${turnId}-1`,
            payload: {
              itemType: "assistant_message",
              status: "inProgress",
              ...(event.content !== undefined ? { data: event.content } : {}),
            },
            method: type,
            raw,
          });
          return;
        case "notice": {
          const message = stringValue(event.message) ?? "CommandCode emitted a notice.";
          yield* emit({
            type: event.level === "error" ? "runtime.error" : "runtime.warning",
            threadId: context.threadId,
            turnId,
            payload: {
              message,
              ...(event.detail !== undefined ? { detail: event.detail } : {}),
              ...(event.level === "error" ? { class: "provider_error" } : {}),
            },
            method: type,
            raw,
          });
          return;
        }
        case "interrupted":
          yield* emit({
            type: "turn.aborted",
            threadId: context.threadId,
            turnId,
            payload: { reason: "CommandCode turn interrupted." },
            method: type,
            raw,
          });
          return;
        case "api_retry":
          // Transport-level retry heartbeat. Surfacing each attempt as a
          // warning row spammed the work log (like 10 rows during a 502 storm);
          // the terminal result/error path reports the actual failure. Keep
          // the session visibly alive instead (matches Claude adapter behavior).
          yield* emit({
            type: "session.state.changed",
            threadId: context.threadId,
            turnId,
            payload: {
              state: "running",
              reason: `api_retry:${stringValue(event.attempt) ?? "?"}/${stringValue(event.max_retries) ?? "?"}`,
            },
            method: type,
            raw,
          });
          return;
        case "tool_input_coerced":
        case "tool_input_repaired":
        case "compaction_start":
        case "compaction_done":
        case "mod_error":
          yield* emit({
            type: "runtime.warning",
            threadId: context.threadId,
            turnId,
            payload: {
              message: stringValue(event.message) ?? `CommandCode reported ${type}.`,
              detail: event,
            },
            method: type,
            raw,
          });
          return;
        case "run_error":
          yield* emit({
            type: "runtime.error",
            threadId: context.threadId,
            turnId,
            payload: {
              message: stringValue(event.error) ?? "CommandCode reported a run error.",
              class: "provider_error",
            },
            method: type,
            raw,
          });
          return;
        case "continuation_recovery":
          yield* emit({
            type: "runtime.warning",
            threadId: context.threadId,
            turnId,
            payload: {
              message: stringValue(event.message) ?? `CommandCode reported ${type}.`,
              detail: event,
            },
            method: type,
            raw,
          });
          return;
      }
    });

    const runTurn = Effect.fn("CommandCodeAdapter.runTurn")(function* (
      context: CommandCodeSessionContext,
      turn: ActiveCommandCodeTurn,
      stderr: { value: string },
    ) {
      let result: CommandCodeResultFrame | undefined;
      let sawText = false;
      let sawAssistantStart = false;
      let sawAssistantEnd = false;
      const turnEventStream = turn.child.stdout.pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.filter((line) => line.trim().length > 0),
      );

      const parseLine = (line: string) =>
        Effect.gen(function* () {
          const parsed = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(
            line,
          ).pipe(
            Effect.catch(() =>
              emit({
                type: "runtime.warning",
                threadId: context.threadId,
                turnId: turn.turnId,
                payload: { message: "CommandCode emitted a non-JSON output line.", detail: line },
                method: "stdout",
                raw: line,
              }).pipe(Effect.as(undefined)),
            ),
          );
          if (parsed === undefined) return;

          const frame = recordValue(parsed);
          if (!frame) return;
          if (frame.type === "result") {
            result = {
              type: "result",
              subtype: frame.subtype,
              sessionId: frame.sessionId,
              stopReason: frame.stopReason,
              usage: frame.usage,
              finalText: frame.finalText,
              error: typeof frame.error === "string" ? frame.error : (frame.error ?? undefined),
            } as CommandCodeResultFrame;
            if (!sawText && typeof frame.finalText === "string" && frame.finalText.length > 0) {
              sawText = true;
              const assistantItemId = turn.assistantItemId ?? `assistant-${turn.turnId}-1`;
              if (!sawAssistantStart) {
                yield* emit({
                  type: "item.started",
                  threadId: context.threadId,
                  turnId: turn.turnId,
                  itemId: assistantItemId,
                  payload: { itemType: "assistant_message", status: "inProgress" },
                  method: "result",
                  raw: frame,
                });
              }
              yield* emit({
                type: "content.delta",
                threadId: context.threadId,
                turnId: turn.turnId,
                itemId: assistantItemId,
                payload: { streamKind: "assistant_text", delta: frame.finalText },
                method: "result",
                raw: frame,
              });
              if (!sawAssistantEnd) {
                yield* emit({
                  type: "item.completed",
                  threadId: context.threadId,
                  turnId: turn.turnId,
                  itemId: assistantItemId,
                  payload: { itemType: "assistant_message", status: "completed" },
                  method: "result",
                  raw: frame,
                });
              }
            }
            return;
          }
          if (frame.type === "event" && recordValue(frame.event)) {
            const event = frame.event as Record<string, unknown>;
            if (event.type === "message_start") sawAssistantStart = true;
            if (event.type === "message_end") sawAssistantEnd = true;
            if (event.type === "text_delta" && typeof event.delta === "string") sawText = true;
            yield* handleEvent(context, turn, event);
          }
        });

      yield* Effect.all(
        [
          turnEventStream.pipe(Stream.runForEach(parseLine)),
          turn.child.stderr.pipe(
            Stream.decodeText(),
            Stream.runFold(
              () => "",
              (all, chunk) => all + chunk,
            ),
            Effect.tap((value) => Effect.sync(() => (stderr.value = value))),
          ),
          turn.child.exitCode.pipe(Effect.map(Number)),
        ],
        { concurrency: "unbounded" },
      ).pipe(
        Effect.flatMap(([_, _stderr, exitCode]) =>
          Effect.gen(function* () {
            if (turn.interrupted || resultStopState(result) === "interrupted") {
              if (!turn.interrupted) {
                yield* emit({
                  type: "turn.aborted",
                  threadId: context.threadId,
                  turnId: turn.turnId,
                  payload: { reason: "CommandCode turn interrupted." },
                });
              }
              return;
            }

            const stopState = resultStopState(result);
            const maxTurns =
              stringValue(result?.subtype)?.toLowerCase() === "max_turns" ||
              stringValue(result?.stopReason)?.toLowerCase() === "max_turns";
            const state =
              stopState === "completed" && (exitCode === 0 || maxTurns) ? "completed" : "failed";
            if (state === "failed") {
              yield* emit({
                type: "runtime.error",
                threadId: context.threadId,
                turnId: turn.turnId,
                payload: {
                  message:
                    stringValue(result?.error) ??
                    (stderr.value.trim() || `CommandCode exited with code ${exitCode}.`),
                  class: "provider_error",
                },
              });
            }
            yield* emit({
              type: "turn.completed",
              threadId: context.threadId,
              turnId: turn.turnId,
              payload: {
                state,
                stopReason: stringValue(result?.stopReason) ?? null,
                ...(result?.usage !== undefined ? { usage: result.usage } : {}),
                ...(stringValue(result?.error) ? { errorMessage: stringValue(result?.error) } : {}),
              },
            });
          }),
        ),
      );

      const sessionId = stringValue(result?.sessionId);
      if (sessionId) {
        context.commandCodeSessionId = sessionId;
        yield* updateSession(context, {
          resumeCursor: { sessionId },
          status: "ready",
          activeTurnId: undefined,
        });
      } else {
        yield* updateSession(context, { status: "ready", activeTurnId: undefined });
      }
      context.activeTurn = undefined;
      if (!context.stopped) {
        yield* emit({
          type: "session.state.changed",
          threadId: context.threadId,
          payload: { state: "ready" },
        });
      }
    });

    const stopSessionInternal = (context: CommandCodeSessionContext) =>
      Effect.gen(function* () {
        context.stopped = true;
        const active = context.activeTurn;
        if (active) yield* active.child.kill({ killSignal: "SIGTERM" }).pipe(Effect.ignore);
        context.activeTurn = undefined;
        yield* Scope.close(context.sessionScope, Exit.void).pipe(Effect.ignore);
        sessions.delete(context.threadId);
        yield* updateSession(context, { status: "closed", activeTurnId: undefined });
        yield* emit({
          type: "session.exited",
          threadId: context.threadId,
          payload: {
            reason: "CommandCode session stopped.",
            recoverable: false,
            exitKind: "graceful",
          },
        }).pipe(Effect.catchCause(() => Effect.void));
      });

    const requireSession = (threadId: ThreadId) => {
      const context = sessions.get(threadId);
      return context
        ? Effect.succeed(context)
        : Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }));
    };

    const startSession = Effect.fn("CommandCodeAdapter.startSession")(function* (
      input: ProviderSessionStartInput,
    ) {
      if (input.provider !== undefined && input.provider !== PROVIDER) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "startSession",
          issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
        });
      }
      const existing = sessions.get(input.threadId);
      if (existing) yield* stopSessionInternal(existing);
      const createdAt = DateTime.formatIso(yield* DateTime.now);
      const model =
        input.modelSelection?.instanceId === boundInstanceId
          ? input.modelSelection.model
          : undefined;
      if (input.modelSelection && input.modelSelection.instanceId !== boundInstanceId) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "startSession",
          issue: `Model selection is bound to '${input.modelSelection.instanceId}', expected '${boundInstanceId}'.`,
        });
      }
      const resumeSessionId = readCommandCodeSessionId(input.resumeCursor);
      const session: ProviderSession = {
        provider: PROVIDER,
        providerInstanceId: boundInstanceId,
        status: "ready",
        runtimeMode: input.runtimeMode,
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(model ? { model } : {}),
        threadId: input.threadId,
        ...(input.resumeCursor !== undefined ? { resumeCursor: input.resumeCursor } : {}),
        createdAt,
        updatedAt: createdAt,
      };
      const context: CommandCodeSessionContext = {
        threadId: input.threadId,
        session,
        commandCodeSessionId: resumeSessionId,
        sessionScope: yield* Scope.make(),
        turns: [],
        activeTurn: undefined,
        stopped: false,
      };
      sessions.set(input.threadId, context);
      yield* emit({
        type: "session.started",
        threadId: input.threadId,
        payload: {
          message: "CommandCode session started.",
          ...(resumeSessionId ? { resume: { sessionId: resumeSessionId } } : {}),
        },
      });
      yield* emit({
        type: "thread.started",
        threadId: input.threadId,
        payload: resumeSessionId ? { providerThreadId: resumeSessionId } : {},
      });
      yield* emit({
        type: "session.state.changed",
        threadId: input.threadId,
        payload: { state: "ready" },
      });
      return session;
    });

    const sendTurn = Effect.fn("CommandCodeAdapter.sendTurn")(function* (
      input: ProviderSendTurnInput,
    ) {
      const context = yield* requireSession(input.threadId);
      if (context.activeTurn) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: "CommandCode does not support concurrent turns in one session.",
        });
      }
      const modelSelection = input.modelSelection;
      if (modelSelection && modelSelection.instanceId !== boundInstanceId) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: `Model selection is bound to '${modelSelection.instanceId}', expected '${boundInstanceId}'.`,
        });
      }
      const text = input.input?.trim() ?? "";
      const attachmentNotes = (input.attachments ?? []).map((attachment) => {
        const path = resolveAttachmentPath({
          attachmentsDir: serverConfig.attachmentsDir,
          attachment,
        });
        return path ? `An attached ${attachment.mimeType} file is available at: ${path}` : null;
      });
      if (
        (text.length === 0 && attachmentNotes.every((note) => note === null)) ||
        !context.session.cwd
      ) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue:
            text.length === 0 && attachmentNotes.every((note) => note === null)
              ? "CommandCode turns require text input or a valid attachment."
              : "CommandCode sessions require a working directory.",
        });
      }

      const prompt = [text, ...attachmentNotes.filter((note): note is string => note !== null)]
        .filter(Boolean)
        .join("\n\n");
      const turnId = TurnId.make(`commandcode-turn-${yield* randomUUID}`);
      const model = modelSelection?.model ?? context.session.model;
      const effort = getModelSelectionStringOptionValue(modelSelection, "effort");
      const interactionMode = input.interactionMode === "plan";
      const args = [
        ...tokenizeCliArgs(settings.launchArgs),
        "--trust",
        "--skip-onboarding",
        "--no-auto-update",
        ...(context.commandCodeSessionId ? ["--session", context.commandCodeSessionId] : []),
        ...(model ? ["--model", model] : []),
        ...(effort ? ["--effort", effort] : []),
        ...runtimeModeArgs(context.session.runtimeMode, interactionMode),
        ...(settings.addDirs?.flatMap((dir) => ["--add-dir", dir]) ?? []),
        "--max-turns",
        DEFAULT_MAX_TURNS,
        "--output-format",
        "json",
        "-p",
        prompt,
      ];
      const spawnCommand = yield* resolveSpawnCommand(settings.binaryPath, args, {
        env: environment,
        extendEnv: true,
      });
      const child = yield* spawner
        .spawn(
          ChildProcess.make(spawnCommand.command, spawnCommand.args, {
            cwd: context.session.cwd,
            env: environment,
            extendEnv: true,
            forceKillAfter: "5 seconds",
            shell: spawnCommand.shell,
          }),
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapterProcessError({
                provider: PROVIDER,
                threadId: input.threadId,
                detail: "Failed to spawn CommandCode.",
                cause,
              }),
          ),
          Effect.provideService(Scope.Scope, context.sessionScope),
        );

      const activeTurn: ActiveCommandCodeTurn = {
        turnId,
        child,
        interrupted: false,
        assistantMessageIndex: 0,
        assistantItemId: undefined,
        thinkingItemId: undefined,
      };
      context.activeTurn = activeTurn;
      context.turns.push({ turnId, prompt, items: [] });
      yield* updateSession(context, {
        status: "running",
        activeTurnId: turnId,
        ...(model ? { model } : {}),
        lastError: undefined,
      });
      yield* emit({
        type: "turn.started",
        threadId: input.threadId,
        turnId,
        payload: { ...(model ? { model } : {}), ...(effort ? { effort } : {}) },
      });
      yield* emit({
        type: "session.state.changed",
        threadId: input.threadId,
        payload: { state: "running" },
      });
      const stderr = { value: "" };
      yield* runTurn(context, activeTurn, stderr).pipe(
        Effect.provideService(Scope.Scope, context.sessionScope),
        Effect.timeoutOption(DEFAULT_TURN_TIMEOUT_MS),
        Effect.tap((turnResult) =>
          Option.isNone(turnResult)
            ? Effect.gen(function* () {
                activeTurn.interrupted = true;
                yield* activeTurn.child.kill({ killSignal: "SIGTERM" }).pipe(Effect.ignore);
                yield* emit({
                  type: "runtime.error",
                  threadId: input.threadId,
                  turnId,
                  payload: {
                    message: "CommandCode turn timed out.",
                    class: "provider_error",
                  },
                });
                yield* updateSession(context, {
                  status: "error",
                  activeTurnId: undefined,
                  lastError: "CommandCode turn timed out.",
                });
                context.activeTurn = undefined;
                if (!context.stopped) {
                  yield* emit({
                    type: "session.state.changed",
                    threadId: input.threadId,
                    payload: { state: "ready" },
                  });
                }
              })
            : Effect.void,
        ),
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            context.activeTurn = undefined;
            const detail = Cause.pretty(cause);
            yield* updateSession(context, {
              status: "error",
              activeTurnId: undefined,
              lastError: detail,
            });
            yield* emit({
              type: "runtime.error",
              threadId: input.threadId,
              turnId,
              payload: {
                message: detail || "CommandCode turn failed.",
                class: "transport_error",
                detail: cause,
              },
            });
          }).pipe(Effect.catchCause(() => Effect.void)),
        ),
        Effect.forkDetach,
      );
      return {
        threadId: input.threadId,
        turnId,
        ...(context.commandCodeSessionId
          ? { resumeCursor: { sessionId: context.commandCodeSessionId } }
          : {}),
      };
    });

    const interruptTurn = (threadId: ThreadId, turnId?: TurnId) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        const active = context.activeTurn;
        if (!active || (turnId !== undefined && active.turnId !== turnId)) return;
        active.interrupted = true;
        yield* active.child.kill({ killSignal: "SIGTERM" }).pipe(Effect.ignore);
      });

    const adapter = {
      provider: PROVIDER,
      capabilities: { sessionModelSwitch: "in-session" as const },
      startSession,
      sendTurn,
      interruptTurn,
      respondToRequest: (
        _threadId: ThreadId,
        _requestId: string,
        _decision: ProviderApprovalDecision,
      ) =>
        Effect.fail(
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "permission.reply",
            detail: "CommandCode headless mode does not expose interactive permission requests.",
          }),
        ),
      respondToUserInput: (
        _threadId: ThreadId,
        _requestId: string,
        _answers: Record<string, unknown>,
      ) =>
        Effect.fail(
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "user-input.reply",
            detail: "CommandCode headless mode does not expose interactive user-input requests.",
          }),
        ),
      stopSession: (threadId: ThreadId) =>
        Effect.gen(function* () {
          const context = sessions.get(threadId);
          if (!context)
            return yield* new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId });
          yield* stopSessionInternal(context);
        }),
      listSessions: () => Effect.succeed([...sessions.values()].map((context) => context.session)),
      hasSession: (threadId: ThreadId) => Effect.succeed(sessions.has(threadId)),
      readThread: (
        threadId: ThreadId,
      ): Effect.Effect<ProviderThreadSnapshot, ProviderAdapterError> =>
        Effect.gen(function* () {
          const context = yield* requireSession(threadId);
          return {
            threadId,
            turns: context.turns.map(
              (turn): ProviderThreadTurnSnapshot => ({ id: turn.turnId, items: turn.items }),
            ),
          };
        }),
      rollbackThread: (threadId: ThreadId, numTurns: number) =>
        Effect.gen(function* () {
          const context = yield* requireSession(threadId);
          if (!Number.isInteger(numTurns) || numTurns < 0 || numTurns > context.turns.length) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "rollbackThread",
              issue: `Invalid rollback count ${numTurns}.`,
            });
          }
          if (context.activeTurn) {
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "thread.rollback",
              detail: "Cannot roll back while a CommandCode turn is running.",
            });
          }
          context.turns.splice(Math.max(0, context.turns.length - numTurns), numTurns);
          // CommandCode has no documented headless rewind operation. Starting
          // a fresh session prevents future turns from accidentally using the
          // state that T3 just rolled back on disk.
          context.commandCodeSessionId = undefined;
          yield* updateSession(context, { resumeCursor: undefined });
          return {
            threadId,
            turns: context.turns.map(
              (turn): ProviderThreadTurnSnapshot => ({ id: turn.turnId, items: turn.items }),
            ),
          } satisfies ProviderThreadSnapshot;
        }),
      stopAll: () =>
        Effect.forEach([...sessions.values()], stopSessionInternal, {
          concurrency: "unbounded",
          discard: true,
        }),
      streamEvents: Stream.fromQueue(runtimeEvents),
    } satisfies ProviderAdapterShape<ProviderAdapterError>;

    yield* Effect.addFinalizer(() =>
      Effect.forEach([...sessions.values()], stopSessionInternal, {
        concurrency: "unbounded",
        discard: true,
      }).pipe(
        Effect.andThen(Queue.shutdown(runtimeEvents)),
        Effect.catchCause(() => Effect.void),
      ),
    );

    return adapter;
  });
}
