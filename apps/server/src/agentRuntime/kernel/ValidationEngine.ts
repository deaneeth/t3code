// @effect-diagnostics globalDate:off globalTimers:off

/**
 * ValidationEngine — deterministic evidence with project-aware validation.
 *
 * Uses ProjectDetector to find the right commands, tracks baselines,
 * and compares post-change results against pre-change state.
 *
 * @module agentRuntime/kernel/ValidationEngine
 */

import type { AgentToolContext } from "../AgentTool.ts";
import type { ValidationState } from "./TaskGraph.ts";
import {
  ProjectDetector,
  type ProjectProfile,
  type ValidationCommands,
} from "./ProjectDetector.ts";

export type ValidationCheckType = "tests" | "typecheck" | "lint" | "build" | "format";

export type ValidationStatus =
  | "not-run"
  | "passing"
  | "failing"
  | "error"
  | "not-available"
  | "not-applicable"
  | "baseline-failure";

export interface ValidationRunConfig {
  /** Which checks to run. */
  readonly checks: ReadonlyArray<ValidationCheckType>;
  /** Working directory. */
  readonly cwd: string;
  /** Timeout per check in ms. */
  readonly timeoutMs?: number | undefined;
  /** Project profile (if already detected). */
  readonly projectProfile?: ProjectProfile | undefined;
}

export interface ValidationResult {
  readonly check: ValidationCheckType;
  readonly status: ValidationStatus;
  readonly output: string;
  readonly durationMs: number;
  readonly details?: ReadonlyArray<string> | undefined;
  /** Whether this was a baseline failure (existed before changes). */
  readonly baselineFailure: boolean;
}

export interface BaselineState {
  /** Validation state before any changes. */
  readonly preChange: ValidationState;
  /** Timestamp of baseline capture. */
  readonly capturedAt: string;
}

export interface ValidationReport {
  readonly results: ReadonlyArray<ValidationResult>;
  readonly overallState: ValidationState;
  readonly durationMs: number;
  readonly summary: string;
  /** New failures compared to baseline. */
  readonly newFailures: ReadonlyArray<string>;
  /** Baseline failures (existed before changes). */
  readonly baselineFailures: ReadonlyArray<string>;
}

/**
 * ValidationEngine runs project-aware validation checks.
 */
export class ValidationEngine {
  private readonly projectDetector: ProjectDetector;
  private baseline: BaselineState | undefined;
  private readonly defaultTimeoutMs: number;

  constructor(config?: { readonly defaultTimeoutMs?: number | undefined }) {
    this.projectDetector = new ProjectDetector();
    this.defaultTimeoutMs = config?.defaultTimeoutMs ?? 60_000;
  }

  /**
   * Capture baseline validation state before making changes.
   */
  async captureBaseline(context: AgentToolContext): Promise<BaselineState> {
    const profile = await this.projectDetector.detect(context);
    const state = await this.runValidationState(profile, context);
    this.baseline = {
      preChange: state,
      capturedAt: new Date().toISOString(),
    };
    return this.baseline;
  }

  /**
   * Get the current baseline.
   */
  getBaseline(): BaselineState | undefined {
    return this.baseline;
  }

  /**
   * Run validation checks using project-defined commands.
   */
  async run(config: ValidationRunConfig, context: AgentToolContext): Promise<ValidationReport> {
    const startTime = Date.now();
    const profile = config.projectProfile ?? (await this.projectDetector.detect(context));
    const results: ValidationResult[] = [];
    const timeoutMs = config.timeoutMs ?? 60_000;

    for (const check of config.checks) {
      const result = await this.runCheck(check, profile, context, timeoutMs);
      results.push(result);
    }

    const durationMs = Date.now() - startTime;

    const overallState = this.buildOverallState(results);
    const newFailures = this.findNewFailures(overallState);
    const baselineFailures = this.baseline ? this.findBaselineFailures(overallState) : [];

    const passing = results.filter((r) => r.status === "passing").length;
    const failing = results.filter((r) => r.status === "failing").length;
    const notAvail = results.filter(
      (r) => r.status === "not-available" || r.status === "not-applicable",
    ).length;
    const baseline = results.filter((r) => r.baselineFailure).length;

    const summary = [
      `${results.length} checks: ${passing} passing, ${failing} failing`,
      notAvail > 0 ? `${notAvail} not available` : "",
      baseline > 0 ? `${baseline} baseline failures` : "",
      `(${durationMs}ms)`,
    ]
      .filter(Boolean)
      .join(", ");

    return { results, overallState, durationMs, summary, newFailures, baselineFailures };
  }

  /**
   * Determine which validation checks are relevant based on file changes.
   */
  inferChecks(changedFiles: ReadonlyArray<string>): ReadonlyArray<ValidationCheckType> {
    const checks: ValidationCheckType[] = [];
    const hasTs = changedFiles.some((f) => f.endsWith(".ts") || f.endsWith(".tsx"));
    const hasJs = changedFiles.some((f) => f.endsWith(".js") || f.endsWith(".jsx"));
    const hasCss = changedFiles.some((f) => f.endsWith(".css") || f.endsWith(".scss"));
    const hasConfig = changedFiles.some(
      (f) => f.endsWith(".json") || f.endsWith(".yaml") || f.endsWith(".yml"),
    );
    const hasTest = changedFiles.some((f) => f.includes(".test.") || f.includes(".spec."));
    const hasMigration = changedFiles.some((f) => f.includes("migration"));

    if (hasTs || hasJs) checks.push("typecheck");
    if (hasTs || hasJs || hasConfig) checks.push("lint");
    if (hasTest) checks.push("tests");
    if (hasMigration || hasConfig) checks.push("build");
    if (hasCss) checks.push("format");

    if (checks.length === 0) {
      checks.push("typecheck", "lint");
    }

    return [...new Set(checks)];
  }

  private async runCheck(
    check: ValidationCheckType,
    profile: ProjectProfile,
    context: AgentToolContext,
    timeoutMs: number,
  ): Promise<ValidationResult> {
    const start = Date.now();
    const command = this.getCommand(check, profile);

    if (!command) {
      return {
        check,
        status: "not-available",
        output: `No ${check} command configured for ${profile.type} projects`,
        durationMs: Date.now() - start,
        baselineFailure: false,
      };
    }

    try {
      const { output, exitCode, timedOut } = await this.runCommand(command, context, timeoutMs);

      if (timedOut) {
        return {
          check,
          status: "error",
          output: `Timed out after ${timeoutMs}ms`,
          durationMs: Date.now() - start,
          baselineFailure: false,
        };
      }

      const isBaseline = this.isBaselineFailure(check, exitCode !== 0);

      return {
        check,
        status: exitCode === 0 ? "passing" : isBaseline ? "baseline-failure" : "failing",
        output: output.substring(0, 5000),
        durationMs: Date.now() - start,
        details: exitCode !== 0 ? this.parseErrors(output) : undefined,
        baselineFailure: isBaseline,
      };
    } catch (cause) {
      return {
        check,
        status: "error",
        output: `${check} failed: ${String(cause)}`,
        durationMs: Date.now() - start,
        baselineFailure: false,
      };
    }
  }

  private getCommand(check: ValidationCheckType, profile: ProjectProfile): string | undefined {
    switch (check) {
      case "tests":
        return profile.commands.test;
      case "lint":
        return profile.commands.lint;
      case "typecheck":
        return profile.commands.typecheck;
      case "build":
        return profile.commands.build;
      case "format":
        return profile.commands.format;
    }
  }

  private async runValidationState(
    profile: ProjectProfile,
    context: AgentToolContext,
  ): Promise<ValidationState> {
    const checks: Array<{ check: ValidationCheckType; command: string | undefined }> = [
      { check: "tests", command: profile.commands.test },
      { check: "typecheck", command: profile.commands.typecheck },
      { check: "lint", command: profile.commands.lint },
      { check: "build", command: profile.commands.build },
      { check: "format", command: profile.commands.format },
    ];

    const results: Record<string, "not-run" | "passing" | "failing" | "error"> = {
      tests: "not-run",
      typecheck: "not-run",
      lint: "not-run",
      build: "not-run",
      format: "not-run",
    };

    for (const { check, command } of checks) {
      if (!command) continue;
      try {
        const { exitCode, timedOut } = await this.runCommand(
          command,
          context,
          this.defaultTimeoutMs,
        );
        results[check] = timedOut ? "error" : exitCode === 0 ? "passing" : "failing";
      } catch {
        // Command failed to run
      }
    }

    return results as unknown as ValidationState;
  }

  private buildOverallState(results: ReadonlyArray<ValidationResult>): ValidationState {
    const getStatus = (check: ValidationCheckType): "not-run" | "passing" | "failing" | "error" => {
      const r = results.find((x) => x.check === check);
      if (!r) return "not-run";
      if (r.status === "passing") return "passing";
      if (r.status === "failing" || r.status === "baseline-failure") return "failing";
      if (r.status === "error") return "error";
      return "not-run";
    };

    return {
      tests: getStatus("tests"),
      typecheck: getStatus("typecheck"),
      lint: getStatus("lint"),
      build: getStatus("build"),
      format: getStatus("format"),
    };
  }

  private findNewFailures(state: ValidationState): ReadonlyArray<string> {
    if (!this.baseline) return [];

    const failures: string[] = [];
    const base = this.baseline.preChange;

    if (state.tests === "failing" && base.tests !== "failing") failures.push("tests");
    if (state.typecheck === "failing" && base.typecheck !== "failing") failures.push("typecheck");
    if (state.lint === "failing" && base.lint !== "failing") failures.push("lint");
    if (state.build === "failing" && base.build !== "failing") failures.push("build");
    if (state.format === "failing" && base.format !== "failing") failures.push("format");

    return failures;
  }

  private findBaselineFailures(state: ValidationState): ReadonlyArray<string> {
    if (!this.baseline) return [];

    const failures: string[] = [];
    const base = this.baseline.preChange;

    if (state.tests === "failing" && base.tests === "failing") failures.push("tests");
    if (state.typecheck === "failing" && base.typecheck === "failing") failures.push("typecheck");
    if (state.lint === "failing" && base.lint === "failing") failures.push("lint");
    if (state.build === "failing" && base.build === "failing") failures.push("build");
    if (state.format === "failing" && base.format === "failing") failures.push("format");

    return failures;
  }

  private isBaselineFailure(check: ValidationCheckType, currentlyFailing: boolean): boolean {
    if (!this.baseline || !currentlyFailing) return false;
    const base = this.baseline.preChange;
    switch (check) {
      case "tests":
        return base.tests === "failing";
      case "typecheck":
        return base.typecheck === "failing";
      case "lint":
        return base.lint === "failing";
      case "build":
        return base.build === "failing";
      case "format":
        return base.format === "failing";
    }
  }

  /**
   * Spawn a command with a timeout and drain stdout + stderr.
   *
   * Both streams are consumed regardless of the outcome: a process that
   * writes more than the pipe buffer without being drained deadlocks on
   * exit. On timeout the process is killed and `timedOut` is set.
   */
  private async runCommand(
    command: string,
    context: AgentToolContext,
    timeoutMs: number,
  ): Promise<{ output: string; exitCode: number | null; timedOut: boolean }> {
    const proc = await context.spawn("sh", ["-c", command], { cwd: context.cwd });
    const outputPromise = Promise.all([this.readOutput(proc.stdout), this.readOutput(proc.stderr)]);

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => {
      timeoutId = setTimeout(() => {
        proc.kill();
        resolve(null);
      }, timeoutMs);
    });
    const exitCode = await Promise.race([proc.exitCode, timeout]);
    if (timeoutId !== undefined) clearTimeout(timeoutId);

    const [stdout, stderr] = await outputPromise;
    const timedOut = exitCode === null;
    return {
      output: timedOut ? "" : `${stdout}${stderr}\n`.trim(),
      exitCode,
      timedOut,
    };
  }

  private async readOutput(stream: ReadableStream<Uint8Array>): Promise<string> {
    const reader = stream.getReader();
    const chunks: string[] = [];
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(decoder.decode(value, { stream: true }));
      }
    } finally {
      reader.releaseLock();
    }
    chunks.push(decoder.decode());
    return chunks.join("");
  }

  private parseErrors(output: string): string[] {
    return output
      .split("\n")
      .filter(
        (l) =>
          l.includes("error") ||
          l.includes("Error") ||
          l.includes("FAIL") ||
          l.includes("✗") ||
          l.includes("×"),
      )
      .slice(0, 10);
  }
}
