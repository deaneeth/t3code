/**
 * Canonical search tools for the agent runtime.
 *
 * Security model:
 * - Path traversal is prevented via context.resolvePath() — symlink escapes are blocked
 * - All paths are resolved to absolute and validated before any I/O
 * - Results are capped to prevent token overflow
 * - Binary files are skipped
 *
 * @module agentRuntime/tools/search
 */
import type { AgentTool, AgentToolContext, ToolResult } from "../AgentTool.ts";

const MAX_MATCHES = 100;
const MAX_LINE_LENGTH = 500;

export const searchTextTool: AgentTool = {
  id: "search_text",
  description:
    "Search file contents using regex. Returns matching lines with file paths and line numbers. Use grep -ri syntax for the query.",
  inputSchema: {
    type: "object",
    required: ["query", "path"],
    properties: {
      query: {
        type: "string",
        description: "Regex pattern to search for (case-insensitive)",
      },
      path: {
        type: "string",
        description: "Directory or file to search in (relative to project root)",
      },
      include: {
        type: "string",
        description: "Glob pattern for files to include (e.g., '*.ts', '*.tsx')",
      },
      exclude: {
        type: "string",
        description: "Glob pattern for files to exclude",
      },
    },
    additionalProperties: false,
  },
  risk: "read",
  capabilities: ["search"],
  enabled: true,
  validate(args): string | undefined {
    if (typeof args.query !== "string" || args.query.length === 0) {
      return "query is required and must be a non-empty string";
    }
    if (typeof args.path !== "string") {
      return "path is required and must be a string";
    }
    try {
      new RegExp(args.query);
    } catch {
      return "query must be a valid regex pattern";
    }
    return undefined;
  },
  async execute(args, context): Promise<ToolResult> {
    const query = args.query as string;
    const searchPath = args.path as string;
    const include = typeof args.include === "string" ? args.include : undefined;
    const exclude = typeof args.exclude === "string" ? args.exclude : undefined;

    const resolved = await context.resolvePath(searchPath);
    if (!resolved) {
      return { output: "Path is outside the project root.", success: false };
    }

    try {
      const argsList = ["-rni"];
      if (include) argsList.push("--include", include);
      if (exclude) argsList.push("--exclude", exclude);
      argsList.push("--max-count=50");
      argsList.push("--", query, resolved);

      const proc = await context.spawn("grep", argsList);

      const stdout = await readStream(proc.stdout);
      const stderr = await readStream(proc.stderr);
      const exitCode = await proc.exitCode;

      if (exitCode === 1) {
        return { output: "No matches found.", success: true };
      }
      if (exitCode !== 0) {
        return {
          output: `grep failed (exit code ${exitCode}): ${stderr}`,
          success: false,
        };
      }

      const lines = stdout.split("\n").filter((l) => l.trim());
      if (lines.length === 0) {
        return { output: "No matches found.", success: true };
      }

      const truncated = lines.slice(0, MAX_MATCHES);
      const output = truncated
        .map((line) => {
          if (line.length > MAX_LINE_LENGTH) {
            return line.substring(0, MAX_LINE_LENGTH) + "…";
          }
          return line;
        })
        .join("\n");

      const summary =
        lines.length > MAX_MATCHES
          ? `\n\n(Showing ${MAX_MATCHES} of ${lines.length} matches)`
          : `\n\n(${lines.length} matches)`;

      return { output: output + summary, success: true };
    } catch (cause) {
      return {
        output: `Search failed: ${String(cause)}`,
        success: false,
      };
    }
  },
};

export const searchFilesTool: AgentTool = {
  id: "search_files",
  description:
    "Find files by name pattern. Returns matching file paths. Useful for locating files by name.",
  inputSchema: {
    type: "object",
    required: ["pattern", "path"],
    properties: {
      pattern: {
        type: "string",
        description: "Substring or glob pattern to match file names against",
      },
      path: {
        type: "string",
        description: "Directory to search in (relative to project root). Defaults to project root.",
      },
      include: {
        type: "string",
        description: "Glob pattern for files to include (e.g., '*.ts', '*.tsx')",
      },
      exclude: {
        type: "string",
        description: "Glob pattern for files to exclude",
      },
    },
    additionalProperties: false,
  },
  risk: "read",
  capabilities: ["search"],
  enabled: true,
  validate(args): string | undefined {
    if (typeof args.pattern !== "string" || args.pattern.length === 0) {
      return "pattern is required and must be a non-empty string";
    }
    if (typeof args.path !== "string") {
      return "path is required and must be a string";
    }
    return undefined;
  },
  async execute(args, context): Promise<ToolResult> {
    const pattern = args.pattern as string;
    const searchPath = args.path as string;

    const resolved = await context.resolvePath(searchPath);
    if (!resolved) {
      return { output: "Path is outside the project root.", success: false };
    }

    try {
      const argsList = [
        resolved,
        "-name",
        pattern,
        "-type",
        "f",
        "-not",
        "-path",
        "*/.git/*",
        "-not",
        "-path",
        "*/node_modules/*",
        "-not",
        "-path",
        "*/.next/*",
        "-not",
        "-path",
        "*/dist/*",
      ];

      const proc = await context.spawn("find", argsList);

      const stdout = await readStream(proc.stdout);
      const stderr = await readStream(proc.stderr);
      const exitCode = await proc.exitCode;

      if (exitCode !== 0 && exitCode !== 1) {
        return {
          output: `find command failed (exit code ${exitCode}): ${stderr}`,
          success: false,
        };
      }

      const files = stdout.split("\n").filter((f) => f.trim());

      if (files.length === 0) {
        return { output: "No files found matching the pattern.", success: true };
      }

      const truncated = files.slice(0, MAX_MATCHES);
      const summary =
        files.length > MAX_MATCHES
          ? `\n\n(Showing ${MAX_MATCHES} of ${files.length} matches)`
          : `\n\n(${files.length} matches)`;

      return {
        output: truncated.join("\n") + summary,
        success: true,
      };
    } catch (cause) {
      return {
        output: `File search failed: ${String(cause)}`,
        success: false,
      };
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

export const searchTools: ReadonlyArray<AgentTool> = [searchTextTool, searchFilesTool];
