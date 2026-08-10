/**
 * ComplexityClassifier — determines execution strategy.
 *
 * Before execution, the classifier analyzes the task and determines
 * the appropriate level of autonomy. This prevents over-engineering
 * simple tasks while ensuring complex tasks get proper planning.
 *
 * Levels:
 * - trivial: rename variable, fix typo → fast path, no planning
 * - simple: single file change → fast path
 * - moderate: multi-file, clear scope → structured execution
 * - complex: cross-system, multiple concerns → planned + parallel
 * - high-risk: security, data, auth → full verification + review
 *
 * @module agentRuntime/kernel/ComplexityClassifier
 */

export type ComplexityLevel = "trivial" | "simple" | "moderate" | "complex" | "high-risk";

export interface ComplexityAssessment {
  readonly level: ComplexityLevel;
  readonly needsPlan: boolean;
  readonly needsSubagents: boolean;
  readonly needsVerifier: boolean;
  readonly needsFullValidation: boolean;
  readonly estimatedTurns: number;
  readonly estimatedFiles: number;
  readonly reasoning: string;
}

const HIGH_RISK_KEYWORDS = [
  "auth",
  "authentication",
  "authorization",
  "security",
  "encrypt",
  "decrypt",
  "password",
  "token",
  "session",
  "oauth",
  "jwt",
  "credential",
  "secret",
  "payment",
  "billing",
  "subscription",
  "charge",
  "database migration",
  "schema change",
  "drop table",
  "drop column",
  "rm -rf",
  "delete all",
  "purge",
];

const COMPLEX_KEYWORDS = [
  "architecture",
  "refactor",
  "migrate",
  "migration",
  "replace.*with",
  "redesign",
  "restructure",
  "across",
  "multiple",
  "system",
  "frontend.*backend",
  "backend.*frontend",
  "api.*client",
  "database",
  "cache",
  "queue",
  "worker",
  "scheduler",
];

const MODERATE_KEYWORDS = [
  "feature",
  "implement",
  "add",
  "create",
  "build",
  "component",
  "module",
  "service",
  "endpoint",
  "api",
  "test",
  "testing",
  "spec",
  "fixture",
  "config",
  "configuration",
  "settings",
  "ui",
  "interface",
  "layout",
  "page",
];

/**
 * ComplexityClassifier determines the appropriate execution strategy.
 */
export class ComplexityClassifier {
  /**
   * Classify the complexity of a task.
   */
  classify(input: {
    readonly userMessage: string;
    readonly repositorySize?: "small" | "medium" | "large" | undefined;
    readonly affectedSubsystems?: ReadonlyArray<string> | undefined;
    readonly hasExistingTests?: boolean | undefined;
  }): ComplexityAssessment {
    const msg = input.userMessage.toLowerCase();
    const reasons: string[] = [];

    // Check for high-risk keywords
    const isHighRisk = HIGH_RISK_KEYWORDS.some((kw) => msg.includes(kw));
    if (isHighRisk) {
      reasons.push("Contains high-risk keywords (security, auth, payments, destructive)");
    }

    // Check for complexity indicators
    const isComplex = COMPLEX_KEYWORDS.some((kw) => new RegExp(kw, "i").test(msg));
    if (isComplex) {
      reasons.push("Contains cross-system or architectural keywords");
    }

    // Check for moderate indicators
    const isModerate = MODERATE_KEYWORDS.some((kw) => msg.includes(kw));
    if (isModerate) {
      reasons.push("Contains feature/implementation keywords");
    }

    // Multi-subsystem detection
    const subsystems = input.affectedSubsystems?.length ?? 0;
    if (subsystems >= 3) {
      reasons.push(`Affects ${subsystems} subsystems`);
    }

    // Repository size influence
    if (input.repositorySize === "large") {
      reasons.push("Large repository increases context complexity");
    }

    // Simple indicators
    const isSimple =
      msg.startsWith("rename ") ||
      msg.startsWith("fix typo") ||
      msg.startsWith("add comment") ||
      msg.startsWith("update readme") ||
      (msg.trim() !== "" && msg.split(" ").length < 8 && !isComplex && !isModerate && !isHighRisk);

    // Trivial indicators — short messages still defer to keyword signals
    const isTrivial =
      msg.startsWith("rename ") ||
      msg.startsWith("fix typo") ||
      msg.startsWith("add comment") ||
      (msg.trim() !== "" && msg.split(" ").length < 5 && !isComplex && !isModerate && !isHighRisk);

    // Determine level
    let level: ComplexityLevel;
    let needsPlan: boolean;
    let needsSubagents: boolean;
    let needsVerifier: boolean;
    let needsFullValidation: boolean;
    let estimatedTurns: number;
    let estimatedFiles: number;

    if (isTrivial && !isHighRisk) {
      level = "trivial";
      needsPlan = false;
      needsSubagents = false;
      needsVerifier = false;
      needsFullValidation = false;
      estimatedTurns = 1;
      estimatedFiles = 1;
      reasons.push("Trivial task — fast path");
    } else if (isSimple && !isHighRisk && !isComplex) {
      level = "simple";
      needsPlan = false;
      needsSubagents = false;
      needsVerifier = false;
      needsFullValidation = false;
      estimatedTurns = 2;
      estimatedFiles = 1;
      reasons.push("Simple task — fast path");
    } else if (isHighRisk) {
      level = "high-risk";
      needsPlan = true;
      needsSubagents = false;
      needsVerifier = true;
      needsFullValidation = true;
      estimatedTurns = 8;
      estimatedFiles = subsystems > 0 ? subsystems * 3 : 5;
      reasons.push("High-risk task — full verification required");
    } else if (isComplex || subsystems >= 3) {
      level = "complex";
      needsPlan = true;
      needsSubagents = subsystems >= 2;
      needsVerifier = true;
      needsFullValidation = true;
      estimatedTurns = 10;
      estimatedFiles = subsystems > 0 ? subsystems * 2 : 6;
      reasons.push("Complex task — planned execution with verification");
    } else {
      level = "moderate";
      needsPlan = true;
      needsSubagents = false;
      needsVerifier = false;
      needsFullValidation = true;
      estimatedTurns = 5;
      estimatedFiles = 3;
      reasons.push("Moderate task — structured execution");
    }

    return {
      level,
      needsPlan,
      needsSubagents,
      needsVerifier,
      needsFullValidation,
      estimatedTurns,
      estimatedFiles,
      reasoning: reasons.join("; "),
    };
  }

  /**
   * Determine the execution strategy based on complexity.
   */
  getExecutionStrategy(assessment: ComplexityAssessment): {
    readonly loopMode: "fast" | "structured" | "planned" | "parallel";
    readonly maxRounds: number;
    readonly maxSubagents: number;
    readonly validationDepth: "none" | "targeted" | "full";
    readonly verifierModel?: string | undefined;
  } {
    switch (assessment.level) {
      case "trivial":
      case "simple":
        return {
          loopMode: "fast",
          maxRounds: 3,
          maxSubagents: 0,
          validationDepth: "none",
        };
      case "moderate":
        return {
          loopMode: "structured",
          maxRounds: 8,
          maxSubagents: 0,
          validationDepth: "targeted",
        };
      case "complex":
        return {
          loopMode: assessment.needsSubagents ? "parallel" : "planned",
          maxRounds: 15,
          maxSubagents: assessment.needsSubagents ? 3 : 0,
          validationDepth: "full",
        };
      case "high-risk":
        return {
          loopMode: "planned",
          maxRounds: 20,
          maxSubagents: 0,
          validationDepth: "full",
        };
    }
  }
}
