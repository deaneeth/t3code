// @effect-diagnostics globalDateInEffect:off globalDate:off nodeBuiltinImport:off

/**
 * UARAdapter — bridges the Universal Agent Runtime to the ProviderAdapter interface.
 *
 * This adapter implements `ProviderAdapterShape` by delegating to the UAR
 * for agent behavior while using the existing transport layer for LLM
 * communication. It is the integration point between the old and new
 * architectures.
 *
 * @module provider/Layers/UARAdapter
 */
import { randomUUID } from "node:crypto";
import {
  ProviderDriverKind,
  EventId,
  ProviderSession,
  RuntimeItemId,
  type ProviderRuntimeEvent,
  ThreadId,
  TurnId,
  type ProviderSendTurnInput,
  type ProviderSessionStartInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import {
  ProviderAdapterRequestError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import type { ProviderAdapterShape, ProviderThreadSnapshot } from "../Services/ProviderAdapter.ts";
import {
  createTransportFromUrl,
  type LLMTransport,
  type TransportHistoryEntry,
} from "../../agentRuntime/transport/index.ts";
import { runAgentLoop, type AgentLoopConfig } from "../../agentRuntime/AgentLoop.ts";
import { canonicalTools } from "../../agentRuntime/tools/index.ts";
import type { AgentTool, AgentToolContext } from "../../agentRuntime/AgentTool.ts";
import { ContextEngine } from "../../agentRuntime/ContextEngine.ts";
import { RuntimeEventEmitter, createEvent } from "../../agentRuntime/RuntimeEvents.ts";
import { TelemetryCollector } from "../../agentRuntime/Telemetry.ts";
import { wrapMCPTools, type MCPToolDefinition } from "../../agentRuntime/MCPManager.ts";

const PROVIDER = ProviderDriverKind.make("api");

interface UARSession {
  readonly threadId: ThreadId;
  readonly cwd: string;
  readonly runtimeMode: ProviderSessionStartInput["runtimeMode"];
  readonly sandboxMode: NonNullable<ProviderSessionStartInput["sandboxMode"]>;
  readonly approvalPolicy: NonNullable<ProviderSessionStartInput["approvalPolicy"]>;
  readonly createdAt: string;
  readonly providerInstanceId: ProviderSessionStartInput["providerInstanceId"];
  readonly transport: LLMTransport;
  model: string;
  readonly baseUrl: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly history: TransportHistoryEntry[];
  readonly contextEngine: ContextEngine;
  readonly eventEmitter: RuntimeEventEmitter;
  readonly telemetry: TelemetryCollector;
  activeTurn?: { readonly turnId: TurnId; readonly controller: AbortController } | undefined;
}

interface UARAdapterConfig {
  /** API endpoint used by the universal transport. */
  readonly baseUrl?: string | undefined;
  /** API key forwarded to the configured endpoint. */
  readonly apiKey?: string | undefined;
  /** Additional MCP tools to include. */
  readonly mcpTools?: ReadonlyArray<MCPToolDefinition> | undefined;
  /** Custom tools to include beyond the canonical set. */
  readonly extraTools?: ReadonlyArray<AgentTool> | undefined;
  /** Agent loop configuration. */
  readonly loopConfig?: Partial<AgentLoopConfig> | undefined;
  /** System prompt to prepend. */
  readonly systemPrompt?: string | undefined;
}

function snapshotForSession(
  threadId: ThreadId,
  history: ReadonlyArray<TransportHistoryEntry>,
): ProviderThreadSnapshot {
  const turns: Array<ProviderThreadSnapshot["turns"][number]> = [];
  for (let index = 0; index < history.length; index += 2) {
    const user = history[index];
    const assistant = history[index + 1];
    turns.push({
      id: TurnId.make(`turn_${Math.floor(index / 2)}`),
      items: [
        ...(user ? [{ kind: "user_message", content: user.content }] : []),
        ...(assistant ? [{ kind: "assistant_message", content: assistant.content }] : []),
      ],
    });
  }
  return { threadId, turns };
}

/**
 * Create a UARAdapter that implements ProviderAdapterShape.
 *
 * This wraps the universal agent runtime to provide the same interface
 * as the existing ApiProviderAdapter, enabling incremental migration.
 */
export function createUARAdapter(
  config?: UARAdapterConfig,
): ProviderAdapterShape<ProviderAdapterError> {
  const sessions = new Map<string, UARSession>();
  const cfg = config ?? {};
  const runtimeEventQueue = Effect.runSync(Queue.unbounded<ProviderRuntimeEvent>());

  const enqueue = (event: ProviderRuntimeEvent): void => {
    Effect.runSync(Queue.offer(runtimeEventQueue, event));
  };

  const baseEvent = (threadId: ThreadId, turnId?: TurnId) => ({
    eventId: EventId.make(`uar_${randomUUID()}`),
    provider: PROVIDER,
    threadId,
    createdAt: new Date().toISOString(),
    ...(turnId ? { turnId } : {}),
  });

  const buildTools = (session: UARSession): AgentTool[] => {
    const tools: AgentTool[] = [...canonicalTools];
    if (cfg.extraTools) tools.push(...cfg.extraTools);
    if (cfg.mcpTools && cfg.mcpTools.length > 0) tools.push(...wrapMCPTools(cfg.mcpTools));
    return tools.filter((tool) => {
      const readOnly = tool.risk === "read";
      const runtimeAllows =
        session.runtimeMode === "auto" ||
        session.runtimeMode === "full-access" ||
        (session.runtimeMode === "auto-accept-edits" && (readOnly || tool.risk === "write"));
      const approvalAllows = session.approvalPolicy === "never" || readOnly;
      const sandboxAllows =
        session.sandboxMode === "danger-full-access" ||
        (session.sandboxMode === "workspace-write" && (readOnly || tool.risk === "write"));
      return runtimeAllows && approvalAllows && sandboxAllows;
    });
  };

  const buildToolContext = (projectRoot: string): AgentToolContext => {
    const root = projectRoot;
    return {
      cwd: root,
      root,
      resolvePath: async (relative) => {
        const { dirname, isAbsolute, resolve } = await import("node:path");
        const { existsSync, realpathSync } = await import("node:fs");
        const resolved = isAbsolute(relative) ? resolve(relative) : resolve(root, relative);
        if (resolved !== root && !resolved.startsWith(`${root}/`)) return undefined;

        // Validate the nearest existing ancestor through realpath so a symlink
        // cannot redirect a write or read outside the project root.
        const realRoot = realpathSync(root);
        let existing = resolved;
        while (!existsSync(existing) && existing !== dirname(existing))
          existing = dirname(existing);
        const realExisting = realpathSync(existing);
        return realExisting === realRoot || realExisting.startsWith(`${realRoot}/`)
          ? resolved
          : undefined;
      },
      readFile: async (path) => {
        try {
          const { readFileSync } = await import("node:fs");
          return readFileSync(path, "utf-8");
        } catch (cause) {
          throw new Error(`Failed to read ${path}: ${String(cause)}`);
        }
      },
      writeFile: async (path, content) => {
        try {
          const { writeFileSync, mkdirSync } = await import("node:fs");
          const { dirname } = await import("node:path");
          mkdirSync(dirname(path), { recursive: true });
          writeFileSync(path, content, "utf-8");
        } catch (cause) {
          throw new Error(`Failed to write ${path}: ${String(cause)}`);
        }
      },
      deleteFile: async (path) => {
        const { unlinkSync } = await import("node:fs");
        unlinkSync(path);
      },
      listDirectory: async (path) => {
        try {
          const { readdirSync } = await import("node:fs");
          return readdirSync(path);
        } catch (cause) {
          throw new Error(`Failed to list ${path}: ${String(cause)}`);
        }
      },
      spawn: async (command, args, options) => {
        const { spawn } = await import("node:child_process");
        const child = spawn(command, [...args], {
          cwd: options?.cwd,
          stdio: ["ignore", "pipe", "pipe"],
        });
        return {
          stdout: new ReadableStream({
            start(controller) {
              child.stdout?.on("data", (data: Buffer) => controller.enqueue(new Uint8Array(data)));
              child.stdout?.on("end", () => controller.close());
              child.on("error", (err) => controller.error(err));
            },
          }),
          stderr: new ReadableStream({
            start(controller) {
              child.stderr?.on("data", (data: Buffer) => controller.enqueue(new Uint8Array(data)));
              child.stderr?.on("end", () => controller.close());
              child.on("error", (err) => controller.error(err));
            },
          }),
          exitCode: new Promise((resolve) => {
            child.on("exit", (code) => resolve(code));
            child.on("error", () => resolve(1));
          }),
          kill: () => child.kill(),
        };
      },
    };
  };

  return {
    provider: PROVIDER,
    capabilities: { sessionModelSwitch: "in-session" },

    startSession: (input: ProviderSessionStartInput) =>
      Effect.gen(function* () {
        const threadId = input.threadId;
        if (input.provider && input.provider !== PROVIDER) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "startSession",
            detail: `Provider mismatch: ${input.provider}`,
          });
        }
        const model = input.modelSelection?.model ?? "gpt-4o";
        sessions.get(threadId)?.activeTurn?.controller.abort();
        const baseUrl = (cfg.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/u, "");
        const headers: Record<string, string> = {};
        if (cfg.apiKey) headers["Authorization"] = `Bearer ${cfg.apiKey}`;

        const transport = createTransportFromUrl(baseUrl);
        const sessionId = `session_${randomUUID()}`;

        const session: UARSession = {
          threadId,
          cwd: input.cwd ?? process.cwd(),
          runtimeMode: input.runtimeMode,
          sandboxMode: input.sandboxMode ?? "danger-full-access",
          approvalPolicy: input.approvalPolicy ?? "never",
          createdAt: new Date().toISOString(),
          providerInstanceId: input.providerInstanceId,
          transport,
          model,
          baseUrl,
          headers,
          history: [],
          contextEngine: new ContextEngine(),
          eventEmitter: new RuntimeEventEmitter(),
          telemetry: new TelemetryCollector(sessionId),
        };

        sessions.set(threadId, session);
        enqueue({
          ...baseEvent(threadId),
          type: "session.started",
          payload: {},
        });

        // Register telemetry listener
        session.eventEmitter.on(session.telemetry.createListener());

        // Emit session started event
        session.eventEmitter.emit(
          createEvent("agent-loop.started", sessionId, {
            model,
            toolCount: canonicalTools.length,
          }),
        );

        return ProviderSession.make({
          provider: PROVIDER,
          threadId,
          ...(input.providerInstanceId ? { providerInstanceId: input.providerInstanceId } : {}),
          status: "ready",
          runtimeMode: input.runtimeMode,
          ...(input.cwd ? { cwd: input.cwd } : {}),
          model,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
      }),

    sendTurn: (input: ProviderSendTurnInput) =>
      Effect.gen(function* () {
        const session = sessions.get(input.threadId);
        if (!session) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "sendTurn",
            detail: `No session for thread ${input.threadId}`,
          });
        }

        const toolContext = buildToolContext(session.cwd);
        const allTools = buildTools(session);
        const systemPrompt = cfg.systemPrompt;

        if (input.attachments && input.attachments.length > 0) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue:
              "Image attachments require an attachment resolver and are not supported by this adapter yet.",
          });
        }
        if (input.modelSelection?.model) session.model = input.modelSelection.model;

        // Build history with context engine
        const historyResult = session.contextEngine.buildHistory(systemPrompt);
        const history = [...historyResult.history];
        const text = input.input ?? "";
        const turnId = TurnId.make(`turn_${randomUUID()}`);
        const controller = new AbortController();
        const toolItemIds = new Map<string, RuntimeItemId>();
        let totalRounds = 0;
        session.activeTurn = { turnId, controller };
        enqueue({
          ...baseEvent(input.threadId, turnId),
          type: "turn.started",
          payload: { model: session.model },
        });

        // Run the agent loop
        const result = yield* Effect.tryPromise({
          try: () =>
            runAgentLoop({
              transport: session.transport,
              tools: allTools,
              toolContext,
              text,
              history,
              model: session.model,
              baseUrl: session.baseUrl,
              headers: session.headers,
              config: { ...cfg.loopConfig, signal: controller.signal },
              onEvent: (event) => {
                const eventId = session.telemetry.getMetrics().sessionId;
                if (event.kind === "round") {
                  totalRounds = Math.max(totalRounds, event.round ?? 0);
                } else if (event.kind === "usage") {
                  session.eventEmitter.emit(
                    createEvent("llm.response", eventId, {
                      model: session.model,
                      outputTokens: event.usage?.outputTokens,
                      toolCallCount: 0,
                      durationMs: 0,
                    }),
                  );
                } else if (event.kind === "text-delta") {
                  session.eventEmitter.emit(
                    createEvent("text.delta", eventId, { delta: event.text ?? "" }),
                  );
                  enqueue({
                    ...baseEvent(input.threadId, turnId),
                    type: "content.delta",
                    payload: { streamKind: "assistant_text", delta: event.text ?? "" },
                  });
                } else if (event.kind === "tool-started") {
                  const itemId = RuntimeItemId.make(`item_${randomUUID()}`);
                  if (event.toolId) toolItemIds.set(event.toolId, itemId);
                  session.eventEmitter.emit(
                    createEvent("tool.started", eventId, {
                      toolId: event.toolId ?? "",
                      toolName: event.toolName ?? "",
                      isMCP: false,
                    }),
                  );
                  enqueue({
                    ...baseEvent(input.threadId, turnId),
                    itemId,
                    type: "item.started",
                    payload: {
                      itemType: "dynamic_tool_call",
                      status: "inProgress",
                      title: event.toolName ?? "Tool",
                    },
                  });
                } else if (event.kind === "tool-completed") {
                  const itemId = event.toolId ? toolItemIds.get(event.toolId) : undefined;
                  session.eventEmitter.emit(
                    createEvent("tool.completed", eventId, {
                      toolId: event.toolId ?? "",
                      toolName: event.toolName ?? "",
                      success: event.success ?? false,
                      durationMs: 0,
                    }),
                  );
                  enqueue({
                    ...baseEvent(input.threadId, turnId),
                    ...(itemId ? { itemId } : {}),
                    type: "item.completed",
                    payload: {
                      itemType: "dynamic_tool_call",
                      status: event.success === false ? "failed" : "completed",
                      title: event.toolName ?? "Tool",
                    },
                  });
                }
              },
            }),
          catch: (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "sendTurn",
              detail: `Agent loop failed: ${String(cause)}`,
              cause,
            }),
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (session.activeTurn?.turnId === turnId) session.activeTurn = undefined;
            }),
          ),
        );
        // Update session state
        session.contextEngine.recordTurn(
          [
            { role: "user", content: text },
            { role: "assistant", content: result.text || undefined },
          ],
          result.usage,
        );
        session.history.push(
          { role: "user", content: text },
          { role: "assistant", content: result.text || undefined },
        );

        // Emit completion event
        session.eventEmitter.emit(
          createEvent("agent-loop.completed", session.telemetry.getMetrics().sessionId, {
            stopReason: result.stopReason,
            totalRounds,
            totalToolCalls: result.toolCalls.length,
            durationMs: 0,
          }),
        );

        const stopState =
          result.stopReason === "completed"
            ? "completed"
            : result.stopReason === "interrupted"
              ? "interrupted"
              : "failed";
        enqueue({
          ...baseEvent(input.threadId, turnId),
          type: "turn.completed",
          payload: { state: stopState, stopReason: result.stopReason },
        });

        return { threadId: input.threadId, turnId };
      }),

    interruptTurn: (threadId: ThreadId, turnId?: TurnId) =>
      Effect.gen(function* () {
        const session = sessions.get(threadId);
        if (!session) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "interruptTurn",
            detail: `No session for thread ${threadId}`,
          });
        }
        if (session.activeTurn && (!turnId || session.activeTurn.turnId === turnId)) {
          session.activeTurn.controller.abort();
        }
      }),

    respondToRequest: (threadId, _requestId, _decision) =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "respondToRequest",
          detail: `Interactive approvals are not supported by the universal adapter for thread ${threadId}.`,
        }),
      ),

    respondToUserInput: (threadId, _requestId, _answers) =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "respondToUserInput",
          detail: `Interactive user input is not supported by the universal adapter for thread ${threadId}.`,
        }),
      ),

    stopSession: (threadId: ThreadId) =>
      Effect.sync(() => {
        const session = sessions.get(threadId);
        if (session) {
          session.activeTurn?.controller.abort();
          session.telemetry.markEnded();
          sessions.delete(threadId);
        }
      }),

    listSessions: () =>
      Effect.sync(() => {
        return [...sessions.values()].map((s) =>
          ProviderSession.make({
            provider: PROVIDER,
            threadId: s.threadId,
            ...(s.providerInstanceId ? { providerInstanceId: s.providerInstanceId } : {}),
            status: "ready",
            runtimeMode: s.runtimeMode,
            cwd: s.cwd,
            model: s.model,
            createdAt: s.createdAt,
            updatedAt: new Date().toISOString(),
          }),
        );
      }),

    hasSession: (threadId: ThreadId) => Effect.sync(() => sessions.has(threadId)),

    readThread: (threadId: ThreadId) =>
      Effect.gen(function* () {
        const session = sessions.get(threadId);
        if (!session) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "readThread",
            detail: `No session for thread ${threadId}`,
          });
        }

        return snapshotForSession(threadId, session.history);
      }),

    rollbackThread: (threadId: ThreadId, numTurns: number) =>
      Effect.gen(function* () {
        const session = sessions.get(threadId);
        if (!session) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "rollbackThread",
            detail: `No session for thread ${threadId}`,
          });
        }

        if (numTurns > 0) {
          const toRemove = Math.min(session.history.length, Math.floor(numTurns) * 2);
          session.history.splice(session.history.length - toRemove, toRemove);
          session.contextEngine.reset();
          for (let index = 0; index < session.history.length; index += 2) {
            session.contextEngine.recordTurn(session.history.slice(index, index + 2));
          }
        }

        return snapshotForSession(threadId, session.history);
      }),

    stopAll: () =>
      Effect.sync(() => {
        for (const [, session] of sessions) {
          session.telemetry.markEnded();
        }
        sessions.clear();
      }),

    streamEvents: Stream.fromQueue(runtimeEventQueue),
  };
}
