/**
 * Agent Kernel — orchestration layer for the Agent Runtime.
 *
 * @module agentRuntime/kernel
 */

// Core orchestration
export { TaskGraph } from "./TaskGraph.ts";
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
} from "./TaskGraph.ts";

export { WorkingMemory } from "./WorkingMemory.ts";
export type {
  WorkingMemoryState,
  FileChange,
  ValidationSnapshot,
  UserDecision,
  SubagentReport,
  Artifact,
  ArtifactKind,
} from "./WorkingMemory.ts";

export { ContextCompiler } from "./ContextCompiler.ts";
export type { ContextCompilerConfig, CompiledContext, ContextMetadata } from "./ContextCompiler.ts";

// Completion and verification
export { CompletionVerifier } from "./CompletionVerifier.ts";
export type {
  CompletionVerdict,
  TaskIntent,
  CompletionCheckState,
  CompletionCheckResult,
  ValidationStatus,
} from "./CompletionVerifier.ts";

// Complexity and planning
export { ComplexityClassifier } from "./ComplexityClassifier.ts";
export type { ComplexityLevel, ComplexityAssessment } from "./ComplexityClassifier.ts";

// Validation
export { ValidationEngine } from "./ValidationEngine.ts";
export type {
  ValidationCheckType,
  ValidationRunConfig,
  ValidationResult,
  ValidationReport,
  BaselineState,
  ValidationStatus as ValidationEngineStatus,
} from "./ValidationEngine.ts";

// Project detection
export { ProjectDetector } from "./ProjectDetector.ts";
export type { ProjectType, ProjectProfile, ValidationCommands } from "./ProjectDetector.ts";

// Event sourcing
export { EventStore } from "./EventStore.ts";
export type { KernelEvent, KernelEventKind, SessionState } from "./EventStore.ts";

// Budget control
export { AgentBudget } from "./AgentBudget.ts";
export type {
  BudgetLimits,
  BudgetUsage,
  BudgetCheck,
  BudgetExceededReason,
} from "./AgentBudget.ts";

// Tool registry and lifecycle
export { ToolRegistry, toToolDefinition, PolicyEngine } from "./ToolRegistry.ts";
export type {
  ToolDefinition,
  ToolSideEffects,
  RetrySafety,
  ToolApprovalPolicy,
  ToolInvocation,
  InvocationStatus,
} from "./ToolRegistry.ts";

// Capability resolution
export { CapabilityResolver } from "./CapabilityResolver.ts";
export type {
  ProviderCapabilities,
  ModelCapabilities,
  ProtocolCapabilities,
  ConnectionCapabilities,
  EffectiveCapabilities,
} from "./CapabilityResolver.ts";

// Output truncation
export { OutputTruncator } from "./OutputTruncator.ts";
export type { TruncationConfig, TruncatedOutput } from "./OutputTruncator.ts";

// Context compaction
export { ContextCompactor } from "./ContextCompactor.ts";
export type { CompactionConfig, CompactionResult } from "./ContextCompactor.ts";

// Main orchestrator
export { AgentKernel } from "./AgentKernel.ts";
export type {
  AgentKernelConfig,
  KernelExecutionResult,
  LoopTerminationReason,
} from "./AgentKernel.ts";
