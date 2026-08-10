/**
 * CompletionVerifier — evidence-based task completion with flexibility.
 *
 * Prevents "model says done, tests still failing" but also handles:
 * - No tests in repository
 * - No typecheck in repository
 * - CSS-only changes
 * - Baseline failures
 * - README changes
 *
 * @module agentRuntime/kernel/CompletionVerifier
 */

import type { TaskNode } from "./TaskGraph.ts";
import type { WorkingMemoryState } from "./WorkingMemory.ts";

export type TaskIntent =
  | "code-change"
  | "debug-fix"
  | "refactor"
  | "implementation"
  | "question"
  | "explanation"
  | "review"
  | "investigation";

export type ValidationStatus =
  | "not-run"
  | "passing"
  | "failing"
  | "error"
  | "not-available"
  | "not-applicable";

export interface CompletionCheckState {
  readonly task: TaskNode;
  readonly memory: WorkingMemoryState;
  readonly validation: {
    readonly tests: ValidationStatus;
    readonly typecheck: ValidationStatus;
    readonly lint: ValidationStatus;
    readonly build: ValidationStatus;
    readonly format: ValidationStatus;
  };
  readonly workspaceHasChanges: boolean;
  readonly hasOutput: boolean;
  /** What validation commands are available in this project. */
  readonly availableValidation: {
    readonly tests: boolean;
    readonly typecheck: boolean;
    readonly lint: boolean;
  };
}

export interface CompletionCheckResult {
  readonly met: boolean;
  readonly reason: string;
}

export interface CompletionVerdict {
  readonly complete: boolean;
  readonly intent: TaskIntent;
  readonly requirements: ReadonlyArray<{
    readonly description: string;
    readonly met: boolean;
    readonly reason: string;
  }>;
  readonly summary: string;
}

/**
 * Default completion requirements per intent type.
 * Uses "appropriate validation" — only checks what's available.
 */
const COMPLETION_RULES: Record<
  TaskIntent,
  Array<(state: CompletionCheckState) => CompletionCheckResult>
> = {
  "code-change": [
    (s) => ({
      met: s.workspaceHasChanges,
      reason: s.workspaceHasChanges ? "Workspace has changes" : "No workspace changes detected",
    }),
    (s) => {
      // Only check tests if tests are available
      if (!s.availableValidation.tests) {
        return { met: true, reason: "No tests in project (not applicable)" };
      }
      const testsOk = s.validation.tests === "passing" || s.validation.tests === "not-available";
      return {
        met: testsOk,
        reason: testsOk ? `Tests: ${s.validation.tests}` : `Tests failing`,
      };
    },
    (s) => {
      // Only check typecheck if typecheck is available
      if (!s.availableValidation.typecheck) {
        return { met: true, reason: "No typecheck in project (not applicable)" };
      }
      const typecheckOk =
        s.validation.typecheck === "passing" || s.validation.typecheck === "not-available";
      return {
        met: typecheckOk,
        reason: typecheckOk ? `Typecheck: ${s.validation.typecheck}` : `Typecheck failing`,
      };
    },
    (s) => ({
      met: s.hasOutput,
      reason: s.hasOutput ? "Task has outputs" : "No task outputs recorded",
    }),
  ],
  "debug-fix": [
    (s) => ({
      met: s.workspaceHasChanges,
      reason: s.workspaceHasChanges ? "Workspace has changes" : "No workspace changes detected",
    }),
    (s) => {
      if (!s.availableValidation.tests) {
        return { met: true, reason: "No tests in project (not applicable)" };
      }
      const testsOk = s.validation.tests === "passing" || s.validation.tests === "not-available";
      return {
        met: testsOk,
        reason: testsOk ? `Tests: ${s.validation.tests}` : `Tests failing`,
      };
    },
    (s) => ({
      met: s.memory.hypotheses.length === 0,
      reason:
        s.memory.hypotheses.length === 0
          ? "No unresolved hypotheses"
          : "Hypotheses remain unresolved",
    }),
  ],
  refactor: [
    (s) => ({
      met: s.workspaceHasChanges,
      reason: s.workspaceHasChanges ? "Workspace has changes" : "No workspace changes detected",
    }),
    (s) => {
      if (!s.availableValidation.tests) {
        return { met: true, reason: "No tests in project (not applicable)" };
      }
      const testsOk = s.validation.tests === "passing" || s.validation.tests === "not-available";
      return {
        met: testsOk,
        reason: testsOk ? `Tests: ${s.validation.tests}` : `Tests failing after refactor`,
      };
    },
  ],
  implementation: [
    (s) => ({
      met: s.workspaceHasChanges,
      reason: s.workspaceHasChanges ? "Workspace has changes" : "No workspace changes detected",
    }),
    (s) => ({
      met: s.hasOutput,
      reason: s.hasOutput ? "Implementation has outputs" : "No outputs recorded",
    }),
  ],
  question: [
    (s) => ({
      met: s.hasOutput,
      reason: s.hasOutput ? "Answer provided" : "No answer provided",
    }),
  ],
  explanation: [
    (s) => ({
      met: s.hasOutput,
      reason: s.hasOutput ? "Explanation provided" : "No explanation provided",
    }),
  ],
  review: [
    (s) => ({
      met: s.hasOutput,
      reason: s.hasOutput ? "Review findings recorded" : "No findings recorded",
    }),
    (s) => ({
      met: s.memory.understanding.length > 0,
      reason: s.memory.understanding.length > 0 ? "Assessment provided" : "No assessment provided",
    }),
  ],
  investigation: [
    (s) => ({
      met: s.hasOutput,
      reason: s.hasOutput ? "Investigation findings recorded" : "No findings recorded",
    }),
    (s) => ({
      met: s.memory.discoveries.length > 0,
      reason: s.memory.discoveries.length > 0 ? "Discoveries recorded" : "No discoveries recorded",
    }),
  ],
};

/**
 * CompletionVerifier checks if a task is actually complete.
 */
export class CompletionVerifier {
  /**
   * Verify task completion against requirements.
   */
  verify(state: CompletionCheckState): CompletionVerdict {
    const intent = this.classifyIntent(state);
    const rules = COMPLETION_RULES[intent];

    const requirements = rules.map((rule) => {
      const result = rule(state);
      return {
        description: result.reason,
        met: result.met,
        reason: result.reason,
      };
    });

    const complete = requirements.every((r) => r.met);
    const summary = complete
      ? `Task complete: ${intent}`
      : `Task incomplete: ${requirements
          .filter((r) => !r.met)
          .map((r) => r.reason)
          .join("; ")}`;

    return { complete, intent, requirements, summary };
  }

  /**
   * Classify the intent of a task.
   */
  private classifyIntent(state: CompletionCheckState): TaskIntent {
    const task = state.task;
    const objective = task.objective.toLowerCase();

    if (objective.includes("fix") || objective.includes("bug") || objective.includes("error")) {
      return "debug-fix";
    }
    if (objective.includes("refactor") || objective.includes("restructure")) {
      return "refactor";
    }
    if (
      objective.includes("implement") ||
      objective.includes("add") ||
      objective.includes("create")
    ) {
      return "implementation";
    }
    if (objective.includes("explain") || objective.includes("what is")) {
      return "explanation";
    }
    if (objective.includes("review") || objective.includes("audit")) {
      return "review";
    }
    if (objective.includes("investigate") || objective.includes("why")) {
      return "investigation";
    }
    if (objective.includes("?")) {
      return "question";
    }

    return "code-change";
  }
}
