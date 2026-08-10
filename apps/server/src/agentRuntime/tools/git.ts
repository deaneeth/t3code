/**
 * Canonical git tools for the agent runtime.
 *
 * Security model:
 * - Uses context.spawn (not Bun.spawn directly) for audit logging
 * - CWD validation against project root
 * - Output size limits to prevent token overflow
 *
 * @module agentRuntime/tools/git
 */
import type { AgentTool, AgentToolContext, ToolResult } from "../AgentTool.ts";

const MAX_OUTPUT_CHARS = 8000;

export const gitStatusTool: AgentTool = {
  id: "git_status",
  description:
    "Show the working tree status. Returns modified, added, deleted, and untracked files.",
  inputSchema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  risk: "read",
  capabilities: ["git"],
  enabled: true,
  async execute(_args, context): Promise<ToolResult> {
    const resolvedCwd = await context.resolvePath(".");
    if (!resolvedCwd) {
      return { output: "Cannot resolve project root.", success: false };
    }

    try {
      const proc = await context.spawn("git", ["status", "--short"], { cwd: resolvedCwd });
      const [stdout, stderr] = await Promise.all([
        readStream(proc.stdout),
        readStream(proc.stderr),
      ]);
      const exitCode = await proc.exitCode;

      if (exitCode !== 0) {
        return { output: `git status failed: ${stderr}`, success: false };
      }

      const output = stdout.trim();
      if (!output) {
        return { output: "Working tree is clean — no changes.", success: true };
      }

      return {
        output: truncate(output, MAX_OUTPUT_CHARS),
        success: true,
      };
    } catch (cause) {
      return { output: `git status failed: ${String(cause)}`, success: false };
    }
  },
};

export const gitDiffTool: AgentTool = {
  id: "git_diff",
  description:
    "Show file changes. Without arguments, shows unstaged changes. Pass --staged for staged changes, or a commit hash to diff against that commit.",
  inputSchema: {
    type: "object",
    properties: {
      staged: {
        type: "boolean",
        description: "If true, show staged changes (--staged)",
      },
      commit: {
        type: "string",
        description: "Commit hash to diff against",
      },
      file: {
        type: "string",
        description: "Specific file to diff",
      },
    },
    additionalProperties: false,
  },
  risk: "read",
  capabilities: ["git"],
  enabled: true,
  async execute(args, context): Promise<ToolResult> {
    const resolvedCwd = await context.resolvePath(".");
    if (!resolvedCwd) {
      return { output: "Cannot resolve project root.", success: false };
    }

    const gitArgs = ["diff"];
    if (args.staged === true) gitArgs.push("--staged");
    if (typeof args.commit === "string") gitArgs.push(args.commit);
    if (typeof args.file === "string") {
      // Validate file path doesn't escape project root
      const resolvedFile = await context.resolvePath(args.file);
      if (!resolvedFile) {
        return { output: "File path is outside the project root.", success: false };
      }
      gitArgs.push("--", args.file);
    }

    try {
      const proc = await context.spawn("git", gitArgs, { cwd: resolvedCwd });
      const [stdout, stderr] = await Promise.all([
        readStream(proc.stdout),
        readStream(proc.stderr),
      ]);
      const exitCode = await proc.exitCode;

      if (exitCode !== 0) {
        return { output: `git diff failed: ${stderr}`, success: false };
      }

      const output = stdout.trim();
      if (!output) {
        return { output: "No changes.", success: true };
      }

      return {
        output: truncate(output, MAX_OUTPUT_CHARS),
        success: true,
      };
    } catch (cause) {
      return { output: `git diff failed: ${String(cause)}`, success: false };
    }
  },
};

export const gitLogTool: AgentTool = {
  id: "git_log",
  description:
    "Show recent git log with authors and dates. Useful for understanding recent project history.",
  inputSchema: {
    type: "object",
    properties: {
      count: {
        type: "number",
        description: "Number of recent commits to show (default 10)",
      },
    },
    additionalProperties: false,
  },
  risk: "read",
  capabilities: ["git"],
  enabled: true,
  async execute(args, context): Promise<ToolResult> {
    const resolvedCwd = await context.resolvePath(".");
    if (!resolvedCwd) {
      return { output: "Cannot resolve project root.", success: false };
    }

    const count = typeof args.count === "number" ? Math.max(1, Math.min(args.count, 50)) : 10;

    try {
      const proc = await context.spawn(
        "git",
        ["log", `--max-count=${count}`, "--format=%h %s (%an, %ar)"],
        { cwd: resolvedCwd },
      );
      const [stdout, stderr] = await Promise.all([
        readStream(proc.stdout),
        readStream(proc.stderr),
      ]);
      const exitCode = await proc.exitCode;

      if (exitCode !== 0) {
        return { output: `git log failed: ${stderr}`, success: false };
      }

      const output = stdout.trim();
      if (!output) {
        return { output: "No commits found.", success: true };
      }

      return {
        output: truncate(output, MAX_OUTPUT_CHARS),
        success: true,
      };
    } catch (cause) {
      return { output: `git log failed: ${String(cause)}`, success: false };
    }
  },
};

async function readStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const chunks: string[] = [];
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
  } finally {
    reader.releaseLock();
  }
  return chunks.join("");
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.substring(0, maxChars) + `\n\n[Truncated at ${maxChars} chars]`;
}

export const gitTools: ReadonlyArray<AgentTool> = [gitStatusTool, gitDiffTool, gitLogTool];
