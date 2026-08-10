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
  ApprovalRequestId,
  ProviderSession,
  RuntimeItemId,
  RuntimeRequestId,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderUserInputAnswers,
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
  type TransportAttachment,
  type TransportHistoryEntry,
} from "../../agentRuntime/transport/index.ts";
import { runAgentLoop, type AgentLoopConfig } from "../../agentRuntime/AgentLoop.ts";
import { canonicalTools } from "../../agentRuntime/tools/index.ts";
import type { AgentTool, AgentToolContext } from "../../agentRuntime/AgentTool.ts";
import { ContextEngine } from "../../agentRuntime/ContextEngine.ts";
import { RuntimeEventEmitter, createEvent } from "../../agentRuntime/RuntimeEvents.ts";
import { TelemetryCollector } from "../../agentRuntime/Telemetry.ts";
import { wrapMCPTools, type MCPToolDefinition } from "../../agentRuntime/MCPManager.ts";
import type { ApiProviderUsageLedger } from "../../usage/ApiProviderUsageLedger.ts";

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
  readonly pendingApprovals: Map<string, (decision: ProviderApprovalDecision) => void>;
  readonly pendingUserInputs: Map<string, (answers: ProviderUserInputAnswers) => void>;
  readonly approvedTools: Set<string>;
  activeTurn?: { readonly turnId: TurnId; readonly controller: AbortController } | undefined;
}

interface UARAdapterConfig {
  /** API endpoint used by the universal transport. */
  readonly baseUrl?: string | undefined;
  /** API key forwarded to the configured endpoint. */
  readonly apiKey?: string | undefined;
  /** Fully formed provider authentication headers. Takes precedence over apiKey. */
  readonly headers?: Readonly<Record<string, string>> | undefined;
  /** Provider instance id copied onto emitted runtime events. */
  readonly providerInstanceId?: ProviderSessionStartInput["providerInstanceId"];
  /** Resolve a stored chat attachment into transport-ready bytes. */
  readonly resolveAttachment?: (input: {
    readonly attachment: NonNullable<ProviderSendTurnInput["attachments"]>[number];
  }) => Promise<TransportAttachment | undefined>;
  /** Additional MCP tools to include. */
  readonly mcpTools?: ReadonlyArray<MCPToolDefinition> | undefined;
  /** Custom tools to include beyond the canonical set. */
  readonly extraTools?: ReadonlyArray<AgentTool> | undefined;
  /** Agent loop configuration. */
  readonly loopConfig?: Partial<AgentLoopConfig> | undefined;
  /** Durable usage ledger shared by API-provider adapters. */
  readonly usageLedger?: ApiProviderUsageLedger["Service"] | undefined;
  readonly profileId?: string | undefined;
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
    ...(cfg.providerInstanceId ? { providerInstanceId: cfg.providerInstanceId } : {}),
    threadId,
    createdAt: new Date().toISOString(),
    ...(turnId ? { turnId } : {}),
  });

  const requestTypeForTool = (toolName: string) =>
    toolName === "run_command"
      ? "command_execution_approval"
      : toolName === "read_file"
        ? "file_read_approval"
        : toolName === "write_file"
          ? "file_change_approval"
          : "dynamic_tool_call";

  const requestApproval = async (
    session: UARSession,
    toolName: string,
    detail: string,
    args: Record<string, unknown>,
  ): Promise<ProviderApprovalDecision> => {
    if (session.runtimeMode !== "approval-required" || session.approvedTools.has(toolName)) {
      return "accept";
    }
    const turnId = session.activeTurn?.turnId;
    if (!turnId) return "cancel";
    const requestId = ApprovalRequestId.make(`uar-${turnId}-${randomUUID()}`);
    const key = String(requestId);
    const decision = await new Promise<ProviderApprovalDecision>((resolve) => {
      session.pendingApprovals.set(key, resolve);
      enqueue({
        ...baseEvent(session.threadId, turnId),
        requestId: RuntimeRequestId.make(requestId),
        type: "request.opened",
        payload: {
          requestType: requestTypeForTool(toolName),
          detail,
          args: { toolName, ...args },
        },
      });
      session.activeTurn?.controller.signal.addEventListener("abort", () => resolve("cancel"), {
        once: true,
      });
    });
    session.pendingApprovals.delete(key);
    if (decision === "acceptForSession") session.approvedTools.add(toolName);
    enqueue({
      ...baseEvent(session.threadId, turnId),
      requestId: RuntimeRequestId.make(requestId),
      type: "request.resolved",
      payload: { requestType: requestTypeForTool(toolName), decision },
    });
    return decision;
  };

  const requestUserInput = async (
    session: UARSession,
    args: Record<string, unknown>,
  ): Promise<{ readonly output: string; readonly success: boolean }> => {
    const questions = Array.isArray(args.questions)
      ? args.questions.filter(
          (question): question is Record<string, unknown> =>
            Boolean(question) && typeof question === "object" && !Array.isArray(question),
        )
      : [];
    const normalizedQuestions = questions.flatMap((question) => {
      const id = typeof question.id === "string" ? question.id.trim() : "";
      const header = typeof question.header === "string" ? question.header.trim() : "";
      const prompt = typeof question.question === "string" ? question.question.trim() : "";
      const options = Array.isArray(question.options)
        ? question.options.flatMap((option) => {
            if (!option || typeof option !== "object" || Array.isArray(option)) return [];
            const value = option as Record<string, unknown>;
            const label = typeof value.label === "string" ? value.label.trim() : "";
            const description =
              typeof value.description === "string" ? value.description.trim() : "";
            return label && description ? [{ label, description }] : [];
          })
        : [];
      if (!id || !header || !prompt || options.length === 0) return [];
      return [
        {
          id,
          header,
          question: prompt,
          options,
          ...(typeof question.multiSelect === "boolean"
            ? { multiSelect: question.multiSelect }
            : {}),
        },
      ];
    });
    if (normalizedQuestions.length === 0) {
      return { output: "User questions were invalid or empty.", success: false };
    }
    const turnId = session.activeTurn?.turnId;
    if (!turnId) return { output: "User input request has no active turn.", success: false };
    const requestId = ApprovalRequestId.make(`uar-user-${turnId}-${randomUUID()}`);
    const key = String(requestId);
    const answers = await new Promise<ProviderUserInputAnswers>((resolve) => {
      session.pendingUserInputs.set(key, resolve);
      enqueue({
        ...baseEvent(session.threadId, turnId),
        requestId: RuntimeRequestId.make(requestId),
        type: "user-input.requested",
        payload: { questions: normalizedQuestions },
      });
      session.activeTurn?.controller.signal.addEventListener("abort", () => resolve({}), {
        once: true,
      });
    });
    session.pendingUserInputs.delete(key);
    enqueue({
      ...baseEvent(session.threadId, turnId),
      requestId: RuntimeRequestId.make(requestId),
      type: "user-input.resolved",
      payload: { answers },
    });
    return { output: JSON.stringify(answers), success: true };
  };

  const buildTools = (session: UARSession): AgentTool[] => {
    const tools: AgentTool[] = [...canonicalTools];
    if (cfg.extraTools) tools.push(...cfg.extraTools);
    if (cfg.mcpTools && cfg.mcpTools.length > 0) tools.push(...wrapMCPTools(cfg.mcpTools));
    return tools
      .filter((tool) => {
        const readOnly = tool.risk === "read";
        const runtimeAllows =
          session.runtimeMode === "approval-required" ||
          session.runtimeMode === "auto" ||
          session.runtimeMode === "full-access" ||
          (session.runtimeMode === "auto-accept-edits" && (readOnly || tool.risk === "write"));
        const sandboxAllows =
          session.sandboxMode === "danger-full-access" ||
          (session.sandboxMode === "workspace-write" && (readOnly || tool.risk === "write"));
        return runtimeAllows && sandboxAllows;
      })
      .map((tool) => {
        if (tool.id === "ask_user") {
          return {
            ...tool,
            execute: async (args: Record<string, unknown>) => requestUserInput(session, args),
          };
        }
        return {
          ...tool,
          execute: async (args: Record<string, unknown>, context: AgentToolContext) => {
            const normalizedArgs = { ...args };
            if (
              (tool.id === "read_file" || tool.id === "write_file") &&
              typeof normalizedArgs.absoluteFilePath !== "string" &&
              typeof normalizedArgs.path === "string"
            ) {
              const { resolve } = await import("node:path");
              normalizedArgs.absoluteFilePath = resolve(session.cwd, normalizedArgs.path);
            }
            const detail =
              typeof normalizedArgs.command === "string"
                ? normalizedArgs.command
                : typeof normalizedArgs.absoluteFilePath === "string"
                  ? normalizedArgs.absoluteFilePath
                  : tool.id;
            const decision = await requestApproval(session, tool.id, detail, normalizedArgs);
            if (decision === "decline" || decision === "cancel") {
              return { output: "Tool execution was declined by the user.", success: false };
            }
            return tool.execute(normalizedArgs, context);
          },
        };
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
        const headers: Readonly<Record<string, string>> =
          cfg.headers ?? (cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {});

        const transport = createTransportFromUrl(baseUrl);
        const sessionId = `session_${randomUUID()}`;

        const session: UARSession = {
          threadId,
          cwd: input.cwd ?? process.cwd(),
          runtimeMode: input.runtimeMode,
          sandboxMode: input.sandboxMode ?? "danger-full-access",
          approvalPolicy: input.approvalPolicy ?? "never",
          createdAt: new Date().toISOString(),
          providerInstanceId: input.providerInstanceId ?? cfg.providerInstanceId,
          transport,
          model,
          baseUrl,
          headers,
          history: [],
          contextEngine: new ContextEngine(),
          eventEmitter: new RuntimeEventEmitter(),
          telemetry: new TelemetryCollector(sessionId),
          pendingApprovals: new Map(),
          pendingUserInputs: new Map(),
          approvedTools: new Set(),
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

        const text = input.input?.trim() ?? "";
        if (!text && (input.attachments?.length ?? 0) === 0) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "API turns require text or an image attachment.",
          });
        }
        if (input.modelSelection?.model) session.model = input.modelSelection.model;

        const attachments: TransportAttachment[] = [];
        const resolveAttachment = cfg.resolveAttachment;
        for (const attachment of input.attachments ?? []) {
          const resolved = resolveAttachment
            ? yield* Effect.tryPromise({
                try: () => resolveAttachment({ attachment }),
                catch: (cause) =>
                  new ProviderAdapterRequestError({
                    provider: PROVIDER,
                    method: "sendTurn",
                    detail: "Failed to resolve API image attachment.",
                    cause,
                  }),
              })
            : undefined;
          if (!resolved) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "sendTurn",
              issue: `Invalid or unsupported attachment '${attachment.id}'.`,
            });
          }
          attachments.push(resolved);
        }

        // Build history with context engine
        const historyResult = session.contextEngine.buildHistory(systemPrompt);
        const history = [...historyResult.history];
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
              ...(attachments.length > 0 ? { attachments } : {}),
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
                      ...(event.success === false && event.error?.trim()
                        ? { detail: event.error.trim().slice(0, 4_000) }
                        : {}),
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
        const newHistory = result.history.slice(history.length);
        session.contextEngine.recordTurn(newHistory, result.usage);
        session.history.push(...newHistory);

        const inputTokens = result.usage?.inputTokens ?? 0;
        const cachedInputTokens = result.usage?.cachedInputTokens ?? 0;
        const outputTokens = result.usage?.outputTokens ?? 0;
        const reasoningOutputTokens = result.usage?.reasoningOutputTokens ?? 0;
        const usedTokens = inputTokens + outputTokens + reasoningOutputTokens;
        if (usedTokens > 0) {
          if (cfg.usageLedger && cfg.profileId && cfg.providerInstanceId) {
            yield* cfg.usageLedger.append({
              providerInstanceId: cfg.providerInstanceId,
              profileId: cfg.profileId,
              threadId: input.threadId,
              turnId,
              model: session.model,
              requestId: `uar:${String(cfg.providerInstanceId)}:${String(turnId)}`,
              ...(inputTokens > 0 ? { inputTokens } : {}),
              ...(cachedInputTokens > 0 ? { cachedInputTokens } : {}),
              ...(outputTokens > 0 ? { outputTokens } : {}),
              ...(reasoningOutputTokens > 0 ? { reasoningOutputTokens } : {}),
              costSource: "unavailable",
              recordedAt: new Date().toISOString(),
            });
          }
          const usageStats = session.contextEngine.getMemory().usageStats;
          enqueue({
            ...baseEvent(input.threadId, turnId),
            type: "thread.token-usage.updated",
            payload: {
              usage: {
                usedTokens,
                totalProcessedTokens: usageStats.totalInputTokens + usageStats.totalOutputTokens,
                ...(inputTokens > 0 ? { inputTokens } : {}),
                ...(cachedInputTokens > 0 ? { cachedInputTokens } : {}),
                ...(outputTokens > 0 ? { outputTokens } : {}),
                ...(reasoningOutputTokens > 0 ? { reasoningOutputTokens } : {}),
                lastUsedTokens: usedTokens,
                ...(inputTokens > 0 ? { lastInputTokens: inputTokens } : {}),
                ...(cachedInputTokens > 0 ? { lastCachedInputTokens: cachedInputTokens } : {}),
                ...(outputTokens > 0 ? { lastOutputTokens: outputTokens } : {}),
                ...(reasoningOutputTokens > 0
                  ? { lastReasoningOutputTokens: reasoningOutputTokens }
                  : {}),
                toolUses: result.toolCalls.length,
              },
            },
          });
        }

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
          payload: {
            state: stopState,
            stopReason: result.stopReason,
            ...(result.usage ? { usage: result.usage } : {}),
          },
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

    respondToRequest: (threadId, requestId, decision) =>
      Effect.gen(function* () {
        const session = sessions.get(threadId);
        const resolve = session?.pendingApprovals.get(String(requestId));
        if (!resolve) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "respondToRequest",
            issue: "Approval request is no longer pending.",
          });
        }
        resolve(decision);
      }),

    respondToUserInput: (threadId, requestId, answers) =>
      Effect.gen(function* () {
        const session = sessions.get(threadId);
        const resolve = session?.pendingUserInputs.get(String(requestId));
        if (!resolve) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "respondToUserInput",
            issue: "User-input request is no longer pending.",
          });
        }
        resolve(answers);
      }),

    stopSession: (threadId: ThreadId) =>
      Effect.sync(() => {
        const session = sessions.get(threadId);
        if (session) {
          session.activeTurn?.controller.abort();
          for (const resolve of session.pendingApprovals.values()) resolve("cancel");
          for (const resolve of session.pendingUserInputs.values()) resolve({});
          session.pendingApprovals.clear();
          session.pendingUserInputs.clear();
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
          for (const resolve of session.pendingApprovals.values()) resolve("cancel");
          for (const resolve of session.pendingUserInputs.values()) resolve({});
          session.telemetry.markEnded();
        }
        sessions.clear();
      }),

    streamEvents: Stream.fromQueue(runtimeEventQueue),
  };
}
