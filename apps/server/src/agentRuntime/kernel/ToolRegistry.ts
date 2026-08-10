// @effect-diagnostics globalDate:off

/**
 * ToolRegistry — universal tool runtime with lifecycle management.
 *
 * This is the central registry for all agent tools. It provides:
 * - Canonical tool interface with side effects and retry safety
 * - Tool invocation tracking with idempotency
 * - Approval/policy boundary
 * - Output truncation
 *
 * @module agentRuntime/kernel/ToolRegistry
 */

import { randomUUID } from "node:crypto";
import type { AgentTool, AgentToolContext, ToolResult } from "../AgentTool.ts";

// ─── Enhanced Tool Interface ───────────────────────────────────

export type ToolSideEffects = "none" | "filesystem" | "process" | "network" | "destructive";
export type RetrySafety = "safe" | "conditional" | "unsafe";
export type ToolApprovalPolicy = "auto" | "approval-required" | "denied";

export interface ToolDefinition {
  /** Unique tool identifier. */
  readonly id: string;
  /** Human-readable description for the LLM. */
  readonly description: string;
  /** JSON Schema for the tool's input parameters. */
  readonly inputSchema: Record<string, unknown>;
  /** Risk classification. */
  readonly risk: "read" | "write" | "execute" | "destructive" | "network";
  /** What side effects this tool produces. */
  readonly sideEffects: ToolSideEffects;
  /** Whether it's safe to retry this tool automatically. */
  readonly retrySafety: RetrySafety;
  /** Capability tags for dynamic loading. */
  readonly capabilities: ReadonlyArray<string>;
  /** Whether this tool is enabled by default. */
  readonly enabled: boolean;
  /** Pre-execution argument validation. */
  readonly validate?: ((args: Record<string, unknown>) => string | undefined) | undefined;
  /** Execute the tool. */
  execute(args: Record<string, unknown>, context: AgentToolContext): Promise<ToolResult>;
}

/**
 * Convert an existing AgentTool to a ToolDefinition with defaults.
 */
export function toToolDefinition(tool: AgentTool): ToolDefinition {
  const sideEffects = deriveSideEffects(tool);
  const retrySafety = deriveRetrySafety(tool);
  return {
    ...tool,
    sideEffects,
    retrySafety,
  };
}

function deriveSideEffects(tool: AgentTool): ToolSideEffects {
  switch (tool.risk) {
    case "read":
      return "none";
    case "write":
      return "filesystem";
    case "execute":
      return "process";
    case "network":
      return "network";
    case "destructive":
      return "destructive";
  }
}

function deriveRetrySafety(tool: AgentTool): RetrySafety {
  switch (tool.risk) {
    case "read":
      return "safe";
    case "write":
      return "conditional";
    case "execute":
      return "conditional";
    case "network":
      return "safe";
    case "destructive":
      return "unsafe";
  }
}

// ─── Tool Invocation Lifecycle ─────────────────────────────────

export type InvocationStatus =
  | "requested"
  | "awaiting-approval"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface ToolInvocation {
  /** Unique invocation ID (assigned by kernel). */
  readonly id: string;
  /** Turn this invocation belongs to. */
  readonly turnId: string;
  /** Model round within the turn (for continuation tracking). */
  readonly modelRoundId: string;
  /** Task this invocation belongs to. */
  readonly taskId?: string | undefined;
  /** Provider-assigned tool call ID (for idempotency detection). */
  readonly providerToolCallId?: string | undefined;
  /** Tool being invoked. */
  readonly toolId: string;
  /** Arguments passed to the tool. */
  readonly arguments: Record<string, unknown>;
  /** Current status. */
  status: InvocationStatus;
  /** When execution started. */
  startedAt?: string | undefined;
  /** When execution completed. */
  completedAt?: string | undefined;
  /** Execution result. */
  result?: ToolResult | undefined;
  /** Workspace revision at time of invocation (for idempotency). */
  readonly workspaceRevision?: string | undefined;
  /** Checkpoint ID if checkpointing is enabled. */
  readonly checkpointId?: string | undefined;
  /** If this is a replay, the original invocation ID. */
  readonly replayOf?: string | undefined;
  /** Number of retry attempts. */
  attemptCount: number;
}

// ─── Policy Engine ─────────────────────────────────────────────

export class PolicyEngine {
  private readonly rules: Map<string, ToolApprovalPolicy> = new Map();

  constructor() {
    // Default policies by risk level
    this.rules.set("read", "auto");
    this.rules.set("write", "auto");
    this.rules.set("execute", "approval-required");
    this.rules.set("network", "auto");
    this.rules.set("destructive", "approval-required");
  }

  /**
   * Set policy for a specific tool.
   */
  setPolicy(toolId: string, policy: ToolApprovalPolicy): void {
    this.rules.set(toolId, policy);
  }

  /**
   * Check if a tool invocation is allowed.
   */
  check(toolId: string, risk: string): ToolApprovalPolicy {
    const toolPolicy = this.rules.get(toolId);
    if (toolPolicy) return toolPolicy;

    const riskPolicy = this.rules.get(risk);
    if (riskPolicy) return riskPolicy;

    return "approval-required";
  }
}

// ─── Tool Registry ─────────────────────────────────────────────

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();
  private readonly invocations = new Map<string, ToolInvocation>();
  private readonly policy: PolicyEngine;

  constructor() {
    this.policy = new PolicyEngine();
  }

  /**
   * Register a tool.
   */
  register(tool: ToolDefinition): void {
    this.tools.set(tool.id, tool);
  }

  /**
   * Register multiple tools.
   */
  registerAll(tools: ReadonlyArray<ToolDefinition>): void {
    for (const tool of tools) {
      this.register(tool);
    }
  }

  /**
   * Get a tool by ID.
   */
  get(toolId: string): ToolDefinition | undefined {
    return this.tools.get(toolId);
  }

  /**
   * Get all enabled tools.
   */
  getEnabled(): ReadonlyArray<ToolDefinition> {
    return [...this.tools.values()].filter((t) => t.enabled);
  }

  /**
   * Get tools filtered by capability.
   */
  getByCapability(capability: string): ReadonlyArray<ToolDefinition> {
    return [...this.tools.values()].filter((t) => t.enabled && t.capabilities.includes(capability));
  }

  /**
   * Create a tool invocation (tracks lifecycle).
   *
   * @param input.providerToolCallId - Provider-assigned ID for idempotency detection
   * @param input.modelRoundId - Model round within the turn (for continuation tracking)
   * @param input.workspaceRevision - Workspace state at invocation time
   */
  createInvocation(input: {
    readonly turnId: string;
    readonly modelRoundId: string;
    readonly taskId?: string | undefined;
    readonly providerToolCallId?: string | undefined;
    readonly toolId: string;
    readonly arguments: Record<string, unknown>;
    readonly workspaceRevision?: string | undefined;
  }): ToolInvocation {
    const invocation: ToolInvocation = {
      id: `inv_${randomUUID().slice(0, 8)}`,
      turnId: input.turnId,
      modelRoundId: input.modelRoundId,
      taskId: input.taskId,
      providerToolCallId: input.providerToolCallId,
      toolId: input.toolId,
      arguments: input.arguments,
      status: "requested",
      workspaceRevision: input.workspaceRevision,
      attemptCount: 0,
    };
    this.invocations.set(invocation.id, invocation);
    return invocation;
  }

  /**
   * Check if this is a duplicate invocation.
   *
   * Idempotency rule:
   * - Same providerToolCallId → duplicate (replay)
   * - Same tool + args in a later model round → legitimate new invocation
   */
  findDuplicate(providerToolCallId: string): ToolInvocation | undefined {
    for (const inv of this.invocations.values()) {
      if (
        inv.providerToolCallId === providerToolCallId &&
        inv.status !== "failed" &&
        inv.status !== "cancelled"
      ) {
        return inv;
      }
    }
    return undefined;
  }

  /**
   * Execute a tool through the registry with full lifecycle.
   */
  async execute(invocationId: string, context: AgentToolContext): Promise<ToolResult> {
    const invocation = this.invocations.get(invocationId);
    if (!invocation) {
      return { output: "Invocation not found", success: false };
    }

    const tool = this.tools.get(invocation.toolId);
    if (!tool) {
      invocation.status = "failed";
      return { output: `Tool '${invocation.toolId}' not found`, success: false };
    }

    // Check policy
    const policy = this.policy.check(tool.id, tool.risk);
    if (policy === "denied") {
      invocation.status = "failed";
      return { output: `Tool '${tool.id}' is denied by policy`, success: false };
    }
    if (policy === "approval-required") {
      invocation.status = "awaiting-approval";
      return { output: `Tool '${tool.id}' requires user approval`, success: false };
    }

    // Validate args
    if (tool.validate) {
      const error = tool.validate(invocation.arguments);
      if (error) {
        invocation.status = "failed";
        return { output: `Validation error: ${error}`, success: false };
      }
    }

    // Execute
    invocation.status = "running";
    invocation.startedAt = new Date().toISOString();
    invocation.attemptCount++;

    try {
      const result = await tool.execute(invocation.arguments, context);
      if ((invocation.status as InvocationStatus) === "cancelled") {
        return { output: "Tool execution was cancelled", success: false };
      }
      invocation.result = result;
      invocation.status = result.success ? "completed" : "failed";
      invocation.completedAt = new Date().toISOString();
      return result;
    } catch (cause) {
      const result: ToolResult = {
        output: `Tool execution failed: ${String(cause)}`,
        success: false,
      };
      invocation.result = result;
      invocation.status = "failed";
      invocation.completedAt = new Date().toISOString();
      return result;
    }
  }

  /**
   * Cancel a running invocation.
   */
  cancel(invocationId: string): boolean {
    const invocation = this.invocations.get(invocationId);
    if (!invocation) return false;
    if (invocation.status === "completed" || invocation.status === "failed") return false;
    invocation.status = "cancelled";
    invocation.completedAt = new Date().toISOString();
    return true;
  }

  /**
   * Get all invocations for a turn.
   */
  getTurnInvocations(turnId: string): ReadonlyArray<ToolInvocation> {
    return [...this.invocations.values()].filter((i) => i.turnId === turnId);
  }

  /**
   * Get all completed invocations (for idempotency checks).
   */
  getCompleted(): ReadonlyArray<ToolInvocation> {
    return [...this.invocations.values()].filter((i) => i.status === "completed");
  }

  /**
   * Check if a tool can be retried.
   */
  canRetry(invocationId: string): boolean {
    const invocation = this.invocations.get(invocationId);
    if (!invocation) return false;
    if (invocation.status !== "failed") return false;

    const tool = this.tools.get(invocation.toolId);
    if (!tool) return false;

    if (tool.retrySafety === "unsafe") return false;
    if (tool.retrySafety === "conditional" && invocation.attemptCount >= 2) return false;

    return true;
  }

  /**
   * Serialize invocations for crash recovery.
   */
  serializeInvocations(): string {
    const invocations = [...this.invocations.values()];
    return JSON.stringify(invocations);
  }
}
