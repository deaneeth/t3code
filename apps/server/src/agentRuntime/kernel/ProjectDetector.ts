/**
 * ProjectDetector — detects project type and validation commands.
 *
 * Instead of hardcoding `npx vitest`, inspect the project and use
 * whatever the project defines.
 *
 * @module agentRuntime/kernel/ProjectDetector
 */

import type { AgentToolContext } from "../AgentTool.ts";

export type ProjectType =
  | "node"
  | "python"
  | "rust"
  | "go"
  | "java"
  | "dotnet"
  | "ruby"
  | "php"
  | "unknown";

export interface ValidationCommands {
  /** Test command. */
  readonly test: string | undefined;
  /** Lint command. */
  readonly lint: string | undefined;
  /** Type check command. */
  readonly typecheck: string | undefined;
  /** Build command. */
  readonly build: string | undefined;
  /** Format check command. */
  readonly format: string | undefined;
}

export interface ProjectProfile {
  /** Detected project type. */
  readonly type: ProjectType;
  /** Validation commands derived from the project. */
  readonly commands: ValidationCommands;
  /** Package manager (npm, yarn, pnpm, bun, cargo, go, etc). */
  readonly packageManager: string | undefined;
  /** Root config file that was inspected. */
  readonly configFile: string | undefined;
}

/**
 * ProjectDetector inspects the workspace and determines validation commands.
 */
export class ProjectDetector {
  /**
   * Detect project type and validation commands.
   */
  async detect(context: AgentToolContext): Promise<ProjectProfile> {
    const cwd = context.cwd;

    // Try Node.js first (most common in this codebase)
    const nodeProfile = await this.detectNode(context, cwd);
    if (nodeProfile) return nodeProfile;

    // Try Python
    const pythonProfile = await this.detectPython(context, cwd);
    if (pythonProfile) return pythonProfile;

    // Try Rust
    const rustProfile = await this.detectRust(context, cwd);
    if (rustProfile) return rustProfile;

    // Try Go
    const goProfile = await this.detectGo(context, cwd);
    if (goProfile) return goProfile;

    return {
      type: "unknown",
      commands: {
        test: undefined,
        lint: undefined,
        typecheck: undefined,
        build: undefined,
        format: undefined,
      },
      packageManager: undefined,
      configFile: undefined,
    };
  }

  /**
   * Get validation commands for a project type.
   */
  getValidationCommands(profile: ProjectProfile): ValidationCommands {
    return profile.commands;
  }

  private async detectNode(context: AgentToolContext, cwd: string): Promise<ProjectProfile | null> {
    // Check for package.json
    const pkgJsonPath = await context.resolvePath("package.json");
    if (!pkgJsonPath) return null;

    try {
      const pkgJson = JSON.parse(await context.readFile(pkgJsonPath));
      const scripts = pkgJson.scripts ?? {};
      const devDeps = { ...pkgJson.devDependencies, ...pkgJson.dependencies };

      // Detect package manager
      let packageManager: string | undefined;
      if (await context.resolvePath("bun.lockb")) packageManager = "bun";
      else if (await context.resolvePath("pnpm-lock.yaml")) packageManager = "pnpm";
      else if (await context.resolvePath("yarn.lock")) packageManager = "yarn";
      else packageManager = "npm";

      // Use project-defined scripts when available
      const commands: ValidationCommands = {
        test: scripts.test ?? (devDeps.vitest ? `${packageManager} run test` : undefined),
        lint: scripts.lint ?? (devDeps.eslint ? `${packageManager} run lint` : undefined),
        typecheck:
          scripts.typecheck ?? scripts.tsc ?? (devDeps.typescript ? `npx tsc --noEmit` : undefined),
        build: scripts.build ?? undefined,
        format: scripts.format ?? (devDeps.prettier ? `npx prettier --check .` : undefined),
      };

      return {
        type: "node",
        commands,
        packageManager,
        configFile: "package.json",
      };
    } catch {
      return null;
    }
  }

  private async detectPython(
    context: AgentToolContext,
    cwd: string,
  ): Promise<ProjectProfile | null> {
    const pyprojectPath = await context.resolvePath("pyproject.toml");
    const setupPyPath = await context.resolvePath("setup.py");

    if (!pyprojectPath && !setupPyPath) return null;

    const commands: ValidationCommands = {
      test: "pytest",
      lint: "ruff check .",
      typecheck: "mypy .",
      build: undefined,
      format: "ruff format --check .",
    };

    return {
      type: "python",
      commands,
      packageManager: "pip",
      configFile: pyprojectPath ? "pyproject.toml" : "setup.py",
    };
  }

  private async detectRust(context: AgentToolContext, cwd: string): Promise<ProjectProfile | null> {
    const cargoPath = await context.resolvePath("Cargo.toml");
    if (!cargoPath) return null;

    const commands: ValidationCommands = {
      test: "cargo test",
      lint: "cargo clippy -- -D warnings",
      typecheck: "cargo check",
      build: "cargo build",
      format: "cargo fmt --check",
    };

    return {
      type: "rust",
      commands,
      packageManager: "cargo",
      configFile: "Cargo.toml",
    };
  }

  private async detectGo(context: AgentToolContext, cwd: string): Promise<ProjectProfile | null> {
    const goModPath = await context.resolvePath("go.mod");
    if (!goModPath) return null;

    const commands: ValidationCommands = {
      test: "go test ./...",
      lint: "golangci-lint run",
      typecheck: undefined, // Go doesn't have a separate typecheck
      build: "go build ./...",
      format: "gofmt -l .",
    };

    return {
      type: "go",
      commands,
      packageManager: "go",
      configFile: "go.mod",
    };
  }
}
