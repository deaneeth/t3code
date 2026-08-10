// @effect-diagnostics globalTimers:off

/**
 * Canonical shell tool for the agent runtime.
 *
 * Security model:
 * - Uses context.spawn (not Bun.spawn directly) for audit logging
 * - Timeout enforcement with process kill on timeout
 * - CWD validation against project root (the host controls process sandboxing)
 * - Stdout/stderr size limits to prevent memory exhaustion
 *
 * @module agentRuntime/tools/shell
 */
import type { AgentTool, AgentToolContext, ToolResult } from "../AgentTool.ts";

const MAX_OUTPUT_BYTES = 512 * 1024; // 512 KB
const DEFAULT_TIMEOUT_MS = 30_000;

export const runCommandTool: AgentTool = {
  id: "run_command",
  description:
    "Run a shell command with the project directory as its working directory. Use for build, test, lint, git operations, and other CLI tasks.",
  inputSchema: {
    type: "object",
    required: ["command"],
    properties: {
      command: {
        type: "string",
        description: "Shell command to execute",
      },
      timeout: {
        type: "number",
        description: "Maximum time in milliseconds before the process is killed (default 30000)",
      },
    },
    additionalProperties: false,
  },
  risk: "execute",
  capabilities: ["shell"],
  enabled: true,
  validate(args): string | undefined {
    if (typeof args.command !== "string" || args.command.trim().length === 0) {
      return "command is required and must be a non-empty string";
    }
    return undefined;
  },
  async execute(args, context): Promise<ToolResult> {
    const command = args.command as string;
    const timeoutMs =
      typeof args.timeout === "number" && args.timeout > 0
        ? Math.min(args.timeout, 120_000) // Hard cap at 2 minutes
        : DEFAULT_TIMEOUT_MS;

    // Validate CWD is under project root
    const resolvedCwd = await context.resolvePath(".");
    if (!resolvedCwd) {
      return { output: "Cannot resolve project root.", success: false };
    }

    let timedOut = false;
    let proc: Awaited<ReturnType<AgentToolContext["spawn"]>> | undefined;

    try {
      proc = await context.spawn("sh", ["-c", command], { cwd: resolvedCwd });

      // Set up timeout with process kill
      const timeoutId = setTimeout(() => {
        timedOut = true;
        proc?.kill();
      }, timeoutMs);

      try {
        const killForOutputLimit = () => proc?.kill();
        const [stdoutText, stderrText, exitCode] = await Promise.all([
          readStreamWithLimit(proc.stdout, MAX_OUTPUT_BYTES, killForOutputLimit),
          readStreamWithLimit(proc.stderr, MAX_OUTPUT_BYTES, killForOutputLimit),
          proc.exitCode,
        ]);

        clearTimeout(timeoutId);

        const output = [stdoutText, stderrText]
          .filter((s) => s.length > 0)
          .join("\n")
          .trim();

        if (timedOut) {
          return {
            output: `Command timed out after ${Math.round(timeoutMs / 1000)}s and was killed.\n\nPartial output:\n${output || "(no output)"}`,
            success: false,
          };
        }

        if (exitCode !== 0) {
          return {
            output: output || `Command exited with code ${exitCode}`,
            success: false,
          };
        }

        return {
          output: output || "(command completed with no output)",
          success: true,
        };
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (cause) {
      if (timedOut) {
        return {
          output: `Command timed out after ${Math.round(timeoutMs / 1000)}s and was killed.`,
          success: false,
        };
      }
      return {
        output: `Failed to run command: ${String(cause)}`,
        success: false,
      };
    }
  },
};

async function readStreamWithLimit(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  onLimit: () => void,
): Promise<string> {
  const reader = stream.getReader();
  const chunks: string[] = [];
  const decoder = new TextDecoder();
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        chunks.push("\n\n[Output truncated: exceeded size limit]");
        onLimit();
        await reader.cancel();
        break;
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    if (totalBytes <= maxBytes) {
      chunks.push(decoder.decode());
    }
  } finally {
    reader.releaseLock();
  }

  return chunks.join("");
}

export const shellTools: ReadonlyArray<AgentTool> = [runCommandTool];
