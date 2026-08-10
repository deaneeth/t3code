/**
 * Universal Agent Runtime (UAR) — the canonical agent harness for T3 Code.
 *
 * This module provides the provider-agnostic agent runtime that owns
 * the complete coding-agent loop. API providers supply only LLM
 * inference transport; all agent behavior is defined here.
 *
 * @module agentRuntime
 */

// Core interfaces
export type {
  AgentTool,
  AgentToolContext,
  ToolResult,
  ToolRisk,
  ToolCapability,
  OpenAIToolDefinition,
} from "./AgentTool.ts";
export { toOpenAITool, toOpenAITools } from "./AgentTool.ts";

// Agent loop
export type { AgentLoopResult, AgentLoopConfig, AgentLoopEventCallback } from "./AgentLoop.ts";
export { runAgentLoop } from "./AgentLoop.ts";

// Context engine
export { ContextEngine } from "./ContextEngine.ts";
export type {
  ContextEngineConfig,
  SessionMemory,
  CompactionSummary,
  ContextEngineResult,
  ModelContextLimits,
} from "./ContextEngine.ts";

// Transport layer
export type {
  LLMTransport,
  TransportProviderKind,
  TransportBuildInput,
  TransportResponse,
  TransportError,
  TransportUsage,
  TransportHistoryEntry,
  TransportRequest,
  TransportStreamEvent,
  TransportToolCall,
} from "./transport/LLMTransport.ts";

export { createTransport, createTransportFromUrl, detectProviderKind } from "./transport/index.ts";

// Tools
export { canonicalTools } from "./tools/index.ts";
export { filesystemTools } from "./tools/filesystem.ts";
export { searchTools } from "./tools/search.ts";
export { shellTools } from "./tools/shell.ts";
export { gitTools } from "./tools/git.ts";
export { agentTools } from "./tools/agent.ts";

// MCP integration
export { wrapMCPTool, wrapMCPTools, discoverMCPTools } from "./MCPManager.ts";
export type { MCPToolDefinition } from "./MCPManager.ts";

// Subagents
export { SubagentManager } from "./SubagentManager.ts";
export type { SubagentTask, SubagentResult, SubagentManagerConfig } from "./SubagentManager.ts";

// Events
export { RuntimeEventEmitter, createEvent } from "./RuntimeEvents.ts";
export type { RuntimeEvent, RuntimeEventListener } from "./RuntimeEvents.ts";

// Telemetry
export { TelemetryCollector, formatTelemetrySummary } from "./Telemetry.ts";
export type { TelemetryMetrics } from "./Telemetry.ts";

// Conformance
export {
  runConformanceTest,
  runAllConformanceTests,
  createMockToolContext,
} from "./Conformance.ts";
export type { ConformanceTestResult } from "./Conformance.ts";

// Kernel (Agent Runtime orchestration layer)
export {
  TaskGraph,
  WorkingMemory,
  ContextCompiler,
  CompletionVerifier,
  ComplexityClassifier,
  ValidationEngine,
  EventStore,
  AgentBudget,
  AgentKernel,
  ToolRegistry,
  toToolDefinition,
  PolicyEngine,
  CapabilityResolver,
  OutputTruncator,
  ContextCompactor,
  ProjectDetector,
} from "./kernel/index.ts";
export type {
  TaskNode,
  TaskStatus,
  TaskPriority,
  TaskOutputs,
  TaskContext,
  TaskProvenance,
  TaskGraphEvent,
  TaskGraphSnapshot,
  ValidationCriterion,
  RetryPolicy,
  ValidationState,
  WorkingMemoryState,
  FileChange,
  ValidationSnapshot,
  UserDecision,
  SubagentReport,
  Artifact,
  ArtifactKind,
  CompiledContext,
  ContextMetadata,
  CompletionVerdict,
  TaskIntent,
  CompletionCheckState,
  CompletionCheckResult,
  ComplexityLevel,
  ComplexityAssessment,
  ValidationCheckType,
  ValidationRunConfig,
  ValidationResult,
  ValidationReport,
  BaselineState,
  KernelEvent,
  KernelEventKind,
  SessionState,
  BudgetLimits,
  BudgetUsage,
  BudgetCheck,
  BudgetExceededReason,
  ToolDefinition,
  ToolSideEffects,
  RetrySafety,
  ToolApprovalPolicy,
  ToolInvocation,
  InvocationStatus,
  ProviderCapabilities,
  ModelCapabilities,
  ProtocolCapabilities,
  ConnectionCapabilities,
  EffectiveCapabilities,
  TruncationConfig,
  TruncatedOutput,
  CompactionConfig,
  CompactionResult,
  ProjectType,
  ProjectProfile,
  ValidationCommands,
  AgentKernelConfig,
  KernelExecutionResult,
  LoopTerminationReason,
} from "./kernel/index.ts";
