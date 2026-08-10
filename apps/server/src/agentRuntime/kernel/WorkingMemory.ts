// @effect-diagnostics globalDate:off

/**
 * WorkingMemory — persistent agent state separate from conversation.
 *
 * Working memory stores the agent's current understanding, discoveries,
 * hypotheses, and artifacts. Unlike conversation history, it survives
 * compaction and provides the Context Compiler with structured input.
 *
 * This is the agent's "scratch pad" that persists across turns.
 *
 * @module agentRuntime/kernel/WorkingMemory
 */
import { randomUUID } from "node:crypto";

export interface WorkingMemoryState {
  /** Current objective the agent is working on. */
  readonly objective: string;
  /** Key discoveries made during investigation. */
  readonly discoveries: ReadonlyArray<string>;
  /** Hypotheses being tested. */
  readonly hypotheses: ReadonlyArray<string>;
  /** Current understanding of the problem/task. */
  readonly understanding: string;
  /** Files of interest for the current task. */
  readonly filesOfInterest: ReadonlyArray<string>;
  /** Changes made so far. */
  readonly changesMade: ReadonlyArray<FileChange>;
  /** Current validation state. */
  readonly validationState: ValidationSnapshot;
  /** Known blockers or issues. */
  readonly blockers: ReadonlyArray<string>;
  /** User decisions or approvals. */
  readonly userDecisions: ReadonlyArray<UserDecision>;
  /** Subagent reports. */
  readonly subagentReports: ReadonlyArray<SubagentReport>;
}

export interface FileChange {
  readonly path: string;
  readonly operation: "created" | "modified" | "deleted";
  readonly reason: string;
  readonly turnId: string;
  readonly timestamp: string;
}

export interface ValidationSnapshot {
  readonly lastRun: string | undefined;
  readonly tests: "not-run" | "passing" | "failing" | "error";
  readonly typecheck: "not-run" | "passing" | "failing" | "error";
  readonly lint: "not-run" | "passing" | "failing" | "error";
  readonly build: "not-run" | "passing" | "failing" | "error";
  readonly failingTests: ReadonlyArray<string>;
  readonly errors: ReadonlyArray<string>;
}

export interface UserDecision {
  readonly question: string;
  readonly answer: string;
  readonly timestamp: string;
}

export interface SubagentReport {
  readonly taskId: string;
  readonly agentId: string;
  readonly summary: string;
  readonly findings: ReadonlyArray<string>;
  readonly filesChanged: ReadonlyArray<string>;
  readonly success: boolean;
  readonly timestamp: string;
}

/**
 * Artifact types that the working memory tracks.
 */
export type ArtifactKind =
  | "finding"
  | "plan"
  | "command"
  | "test-result"
  | "build-result"
  | "file-change"
  | "diff"
  | "error"
  | "user-decision"
  | "approval"
  | "subagent-report";

export interface Artifact {
  readonly id: string;
  readonly kind: ArtifactKind;
  readonly content: string;
  readonly metadata: Record<string, unknown>;
  readonly timestamp: string;
}

/**
 * WorkingMemory manages the agent's persistent state.
 */
export class WorkingMemory {
  private state: WorkingMemoryState;
  private readonly artifacts: Artifact[] = [];
  private readonly maxArtifacts: number;

  constructor(initialObjective: string, maxArtifacts = 200) {
    this.maxArtifacts = Math.max(0, Math.floor(maxArtifacts));
    this.state = {
      objective: initialObjective,
      discoveries: [],
      hypotheses: [],
      understanding: "",
      filesOfInterest: [],
      changesMade: [],
      validationState: {
        lastRun: undefined,
        tests: "not-run",
        typecheck: "not-run",
        lint: "not-run",
        build: "not-run",
        failingTests: [],
        errors: [],
      },
      blockers: [],
      userDecisions: [],
      subagentReports: [],
    };
  }

  /**
   * Get the current state snapshot.
   */
  getState(): WorkingMemoryState {
    return {
      ...this.state,
      discoveries: [...this.state.discoveries],
      hypotheses: [...this.state.hypotheses],
      filesOfInterest: [...this.state.filesOfInterest],
      changesMade: this.state.changesMade.map((c) => ({ ...c })),
      blockers: [...this.state.blockers],
      userDecisions: this.state.userDecisions.map((d) => ({ ...d })),
      subagentReports: this.state.subagentReports.map((r) => ({ ...r })),
      validationState: {
        ...this.state.validationState,
        failingTests: [...this.state.validationState.failingTests],
        errors: [...this.state.validationState.errors],
      },
    };
  }

  /**
   * Update the objective.
   */
  setObjective(objective: string): void {
    this.state = { ...this.state, objective };
  }

  /**
   * Add a discovery.
   */
  addDiscovery(discovery: string): void {
    this.state = {
      ...this.state,
      discoveries: [...this.state.discoveries, discovery],
    };
    this.addArtifact({
      id: `art_${randomUUID()}`,
      kind: "finding",
      content: discovery,
      metadata: {},
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Add or update a hypothesis.
   */
  addHypothesis(hypothesis: string): void {
    this.state = {
      ...this.state,
      hypotheses: [...this.state.hypotheses, hypothesis],
    };
  }

  /**
   * Remove a hypothesis (e.g., when disproven).
   */
  removeHypothesis(hypothesis: string): void {
    this.state = {
      ...this.state,
      hypotheses: this.state.hypotheses.filter((h) => h !== hypothesis),
    };
  }

  /**
   * Update understanding.
   */
  setUnderstanding(understanding: string): void {
    this.state = { ...this.state, understanding };
  }

  /**
   * Add a file of interest.
   */
  addFileOfInterest(path: string): void {
    if (!this.state.filesOfInterest.includes(path)) {
      this.state = {
        ...this.state,
        filesOfInterest: [...this.state.filesOfInterest, path],
      };
    }
  }

  /**
   * Remove a file of interest.
   */
  removeFileOfInterest(path: string): void {
    this.state = {
      ...this.state,
      filesOfInterest: this.state.filesOfInterest.filter((f) => f !== path),
    };
  }

  /**
   * Record a file change.
   */
  recordChange(change: FileChange): void {
    this.state = {
      ...this.state,
      changesMade: [...this.state.changesMade, change],
    };
    this.addArtifact({
      id: `art_${randomUUID()}`,
      kind: "file-change",
      content: `${change.operation}: ${change.path} — ${change.reason}`,
      metadata: { path: change.path, operation: change.operation },
      timestamp: change.timestamp,
    });
  }

  /**
   * Update validation state.
   */
  updateValidation(state: Partial<ValidationSnapshot>): void {
    this.state = {
      ...this.state,
      validationState: {
        ...this.state.validationState,
        ...state,
        lastRun: new Date().toISOString(),
      },
    };
  }

  /**
   * Add a blocker.
   */
  addBlocker(blocker: string): void {
    this.state = {
      ...this.state,
      blockers: [...this.state.blockers, blocker],
    };
  }

  /**
   * Remove a blocker.
   */
  removeBlocker(blocker: string): void {
    this.state = {
      ...this.state,
      blockers: this.state.blockers.filter((b) => b !== blocker),
    };
  }

  /**
   * Record a user decision.
   */
  recordDecision(decision: UserDecision): void {
    this.state = {
      ...this.state,
      userDecisions: [...this.state.userDecisions, decision],
    };
    this.addArtifact({
      id: `art_${randomUUID()}`,
      kind: "user-decision",
      content: `Q: ${decision.question}\nA: ${decision.answer}`,
      metadata: {},
      timestamp: decision.timestamp,
    });
  }

  /**
   * Record a subagent report.
   */
  recordSubagentReport(report: SubagentReport): void {
    this.state = {
      ...this.state,
      subagentReports: [...this.state.subagentReports, report],
    };
    this.addArtifact({
      id: `art_${randomUUID()}`,
      kind: "subagent-report",
      content: report.summary,
      metadata: { taskId: report.taskId, success: report.success },
      timestamp: report.timestamp,
    });
  }

  /**
   * Add a generic artifact.
   */
  addArtifact(artifact: Artifact): void {
    this.artifacts.push(artifact);
    if (this.artifacts.length > this.maxArtifacts) {
      this.artifacts.shift();
    }
  }

  /**
   * Get artifacts filtered by kind.
   */
  getArtifacts(kind?: ArtifactKind): ReadonlyArray<Artifact> {
    if (!kind) return [...this.artifacts];
    return this.artifacts.filter((a) => a.kind === kind);
  }

  /**
   * Get the most recent artifact of a given kind.
   */
  getLatestArtifact(kind: ArtifactKind): Artifact | undefined {
    for (let i = this.artifacts.length - 1; i >= 0; i--) {
      if (this.artifacts[i]!.kind === kind) return this.artifacts[i];
    }
    return undefined;
  }

  /**
   * Serialize for persistence / context compiler.
   */
  serialize(): string {
    const lines: string[] = [];
    lines.push(`OBJECTIVE: ${this.state.objective}`);
    if (this.state.understanding) lines.push(`\nUNDERSTANDING: ${this.state.understanding}`);
    if (this.state.discoveries.length > 0) {
      lines.push(`\nDISCOVERIES (${this.state.discoveries.length}):`);
      for (const d of this.state.discoveries.slice(-10)) lines.push(`  - ${d}`);
    }
    if (this.state.hypotheses.length > 0) {
      lines.push(`\nHYPOTHESES (${this.state.hypotheses.length}):`);
      for (const h of this.state.hypotheses) lines.push(`  - ${h}`);
    }
    if (this.state.filesOfInterest.length > 0) {
      lines.push(`\nFILES OF INTEREST:`);
      for (const f of this.state.filesOfInterest) lines.push(`  - ${f}`);
    }
    if (this.state.changesMade.length > 0) {
      lines.push(`\nCHANGES MADE (${this.state.changesMade.length}):`);
      for (const c of this.state.changesMade.slice(-5)) lines.push(`  - ${c.operation} ${c.path}`);
    }
    const vs = this.state.validationState;
    lines.push(
      `\nVALIDATION: tests=${vs.tests} typecheck=${vs.typecheck} lint=${vs.lint} build=${vs.build}`,
    );
    if (vs.failingTests.length > 0) {
      lines.push(`  Failing: ${vs.failingTests.join(", ")}`);
    }
    if (this.state.blockers.length > 0) {
      lines.push(`\nBLOCKERS:`);
      for (const b of this.state.blockers) lines.push(`  - ${b}`);
    }
    return lines.join("\n");
  }

  /**
   * Serialize to JSON for crash recovery.
   */
  serializeJson(): string {
    return JSON.stringify({
      state: this.state,
      artifacts: this.artifacts,
    });
  }

  /**
   * Restore from JSON serialized state.
   */
  restore(data: string): void {
    const parsed = JSON.parse(data) as { state: WorkingMemoryState; artifacts: Artifact[] };
    this.state = parsed.state;
    this.artifacts.length = 0;
    this.artifacts.push(...parsed.artifacts);
  }

  /**
   * Reset for a new task.
   */
  reset(newObjective: string): void {
    this.state = {
      objective: newObjective,
      discoveries: [],
      hypotheses: [],
      understanding: "",
      filesOfInterest: [],
      changesMade: [],
      validationState: {
        lastRun: undefined,
        tests: "not-run",
        typecheck: "not-run",
        lint: "not-run",
        build: "not-run",
        failingTests: [],
        errors: [],
      },
      blockers: [],
      userDecisions: [],
      subagentReports: [],
    };
    this.artifacts.length = 0;
  }
}
