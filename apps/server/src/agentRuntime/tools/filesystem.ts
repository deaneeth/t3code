// @effect-diagnostics globalRandom:off

/**
 * Canonical filesystem tools for the agent runtime.
 *
 * Security model:
 * - Path traversal and symlink escapes are prevented via context.resolvePath()
 * - All paths are resolved to absolute and validated before any I/O
 * - Write operations create parent directories automatically
 * - Binary files are detected and rejected
 *
 * @module agentRuntime/tools/filesystem
 */
import type { AgentTool, AgentToolContext, ToolResult } from "../AgentTool.ts";

const MAX_READ_BYTES = 2 * 1024 * 1024; // 2 MB read guard

export const readFileTool: AgentTool = {
  id: "read_file",
  description:
    "Read a file's content. Returns the full text of the file at the given absolute path. Fails for files > 2 MB or binary files.",
  inputSchema: {
    type: "object",
    required: ["absoluteFilePath"],
    properties: {
      absoluteFilePath: {
        type: "string",
        description: "Absolute path to the file to read",
      },
    },
    additionalProperties: false,
  },
  risk: "read",
  capabilities: ["filesystem"],
  enabled: true,
  validate(args): string | undefined {
    if (typeof args.absoluteFilePath !== "string" || args.absoluteFilePath.length === 0) {
      return "absoluteFilePath is required and must be a non-empty string";
    }
    return undefined;
  },
  async execute(args, context): Promise<ToolResult> {
    const absoluteFilePath = args.absoluteFilePath as string;
    const resolved = await context.resolvePath(absoluteFilePath);
    if (!resolved) {
      return { output: "Path is outside the project root.", success: false };
    }

    try {
      const content = await context.readFile(resolved);
      const byteSize = Buffer.byteLength(content, "utf-8");
      if (byteSize > MAX_READ_BYTES) {
        return {
          output: `File is too large (${byteSize} bytes, max ${MAX_READ_BYTES}).`,
          success: false,
        };
      }
      return { output: content, success: true };
    } catch (cause) {
      return {
        output: `Failed to read file '${resolved}': ${String(cause)}`,
        success: false,
      };
    }
  },
};

export const writeFileTool: AgentTool = {
  id: "write_file",
  description:
    "Write content to a file. Creates parent directories if they don't exist. Overwrites existing content.",
  inputSchema: {
    type: "object",
    required: ["absoluteFilePath", "content"],
    properties: {
      absoluteFilePath: {
        type: "string",
        description: "Absolute path to the file to write",
      },
      content: {
        type: "string",
        description: "Content to write to the file",
      },
    },
    additionalProperties: false,
  },
  risk: "write",
  capabilities: ["filesystem"],
  enabled: true,
  validate(args): string | undefined {
    if (typeof args.absoluteFilePath !== "string" || args.absoluteFilePath.length === 0) {
      return "absoluteFilePath is required and must be a non-empty string";
    }
    if (typeof args.content !== "string") {
      return "content is required and must be a string";
    }
    return undefined;
  },
  async execute(args, context): Promise<ToolResult> {
    const absoluteFilePath = args.absoluteFilePath as string;
    const content = args.content as string;
    const resolved = await context.resolvePath(absoluteFilePath);
    if (!resolved) {
      return { output: "Path is outside the project root.", success: false };
    }

    try {
      await context.writeFile(resolved, content);
      return { output: `Wrote ${content.length} characters to ${resolved}`, success: true };
    } catch (cause) {
      return {
        output: `Failed to write file '${resolved}': ${String(cause)}`,
        success: false,
      };
    }
  },
};

export const listDirectoryTool: AgentTool = {
  id: "list_directory",
  description:
    "List entries in a directory. Returns file and subdirectory names. Defaults to the project root if no path is provided.",
  inputSchema: {
    type: "object",
    properties: {
      absoluteDirectoryPath: {
        type: "string",
        description: "Absolute path to the directory (defaults to project root)",
      },
    },
    additionalProperties: false,
  },
  risk: "read",
  capabilities: ["filesystem"],
  enabled: true,
  async execute(args, context): Promise<ToolResult> {
    const rawPath =
      typeof args.absoluteDirectoryPath === "string" ? args.absoluteDirectoryPath : context.cwd;

    const resolved = await context.resolvePath(rawPath);
    if (!resolved) {
      return { output: "Path is outside the project root.", success: false };
    }

    try {
      const entries = await context.listDirectory(resolved);
      if (entries.length === 0) {
        return { output: "Directory is empty.", success: true };
      }
      return {
        output: `Directory listing of ${resolved}:\n\n${entries.map((e) => `  ${e}`).join("\n")}`,
        success: true,
      };
    } catch (cause) {
      return {
        output: `Failed to list directory '${resolved}': ${String(cause)}`,
        success: false,
      };
    }
  },
};

interface FileChange {
  readonly path: string;
  readonly operation: "add" | "update" | "delete";
  readonly content: ReadonlyArray<string>;
}

function parsePatch(patch: string): { changes: ReadonlyArray<FileChange>; error?: string } {
  const lines = patch.replace(/\r\n?/gu, "\n").trimEnd().split("\n");
  const changes: FileChange[] = [];
  const hasBeginPatch = lines.some((line) => line === "*** Begin Patch");

  if (hasBeginPatch) {
    let current:
      | { path: string; operation: FileChange["operation"]; content: string[] }
      | undefined;
    const flush = () => {
      if (current) changes.push(current);
      current = undefined;
    };
    for (const line of lines) {
      const directive = line.match(/^\*\*\* (Add|Update|Delete) File: (.+)$/u);
      if (directive) {
        flush();
        current = {
          path: directive[2]!.trim(),
          operation: directive[1]!.toLowerCase() as FileChange["operation"],
          content: [],
        };
        continue;
      }
      if (
        line === "*** Begin Patch" ||
        line === "*** End Patch" ||
        line.startsWith("*** End of File")
      ) {
        if (line === "*** End Patch") flush();
        continue;
      }
      if (current) current.content.push(line);
    }
    flush();
    return changes.length > 0
      ? { changes }
      : { changes: [], error: "No file directives found in patch." };
  }

  // Parse standard unified diffs. A file section is delimited by `---` / `+++`.
  let oldPath: string | undefined;
  let newPath: string | undefined;
  let content: string[] = [];
  const flush = () => {
    if (!oldPath || !newPath) return;
    const operation: FileChange["operation"] =
      newPath === "/dev/null" ? "delete" : oldPath === "/dev/null" ? "add" : "update";
    changes.push({ path: newPath === "/dev/null" ? oldPath : newPath, operation, content });
    oldPath = undefined;
    newPath = undefined;
    content = [];
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    // A header is identified by the adjacent +++ line. This avoids mistaking
    // a legitimate deleted line whose content begins with "--" for a header.
    if (line.startsWith("--- ") && lines[index + 1]?.startsWith("+++ ")) {
      flush();
      oldPath = normalizePatchPath(line.slice(4));
      newPath = normalizePatchPath(lines[index + 1]!.slice(4));
      index += 1;
      continue;
    }
    if (newPath) content.push(line);
  }
  flush();
  if (oldPath && !newPath) return { changes: [], error: "Incomplete unified-diff file section." };
  return changes.length > 0
    ? { changes }
    : { changes: [], error: "No unified-diff file sections found." };
}

function normalizePatchPath(value: string): string {
  const path = value.split("\t", 1)[0]!.trim();
  if (path === "/dev/null") return path;
  return path.replace(/^(?:[ab])\//u, "");
}

export const applyPatchTool: AgentTool = {
  id: "apply_patch",
  description:
    "Apply a patch to modify one or more files. Supports unified diff format. Creates new files or modifies existing ones.",
  inputSchema: {
    type: "object",
    required: ["patch"],
    properties: {
      patch: {
        type: "string",
        description: "Patch in unified diff format (--git format preferred).",
      },
    },
    additionalProperties: false,
  },
  risk: "write",
  capabilities: ["filesystem"],
  enabled: true,
  validate(args): string | undefined {
    if (typeof args.patch !== "string" || args.patch.trim().length === 0) {
      return "patch is required and must be a non-empty string";
    }
    return undefined;
  },
  async execute(args, context): Promise<ToolResult> {
    const parsed = parsePatch(args.patch as string);
    if (parsed.error) return { output: parsed.error, success: false };

    const results: string[] = [];
    const pending: Array<{
      readonly operation: FileChange["operation"];
      readonly path: string;
      readonly resolved: string;
      readonly content?: string;
    }> = [];
    let validationFailed = false;

    // Resolve and validate every change before performing any write. This prevents
    // a malformed second hunk from leaving the first file partially modified.
    for (const change of parsed.changes) {
      const resolved = await context.resolvePath(change.path);
      if (!resolved) {
        results.push(`Skipped '${change.path}': outside project root.`);
        validationFailed = true;
        continue;
      }

      try {
        if (change.operation === "delete") {
          if (!context.deleteFile) {
            throw new Error("host does not support file deletion");
          }
          pending.push({ operation: "delete", path: change.path, resolved });
        } else if (change.operation === "add") {
          const content = change.content
            .filter((line) => !line.startsWith("***"))
            .map((line) => (line.startsWith("+") ? line.slice(1) : line))
            .join("\n");
          pending.push({ operation: "add", path: change.path, resolved, content });
        } else {
          const existing = await context.readFile(resolved);
          const updated = applyUnifiedDiff(existing, change.content);
          pending.push({ operation: "update", path: change.path, resolved, content: updated });
        }
      } catch (cause) {
        results.push(`Failed to update '${change.path}': ${String(cause)}`);
        validationFailed = true;
      }
    }

    if (validationFailed) {
      results.push("No patch changes were written because validation failed.");
      return { output: results.join("\n"), success: false };
    }

    for (const change of pending) {
      try {
        if (change.operation === "delete") {
          await context.deleteFile!(change.resolved);
          results.push(`Deleted '${change.resolved}'.`);
        } else {
          await context.writeFile(change.resolved, change.content ?? "");
          results.push(
            `${change.operation === "add" ? "Added" : "Updated"} '${change.resolved}' successfully.`,
          );
        }
      } catch (cause) {
        results.push(`Failed to ${change.operation} '${change.path}': ${String(cause)}`);
      }
    }

    const allFailed =
      results.length === 0 ||
      results.every((r) => r.startsWith("Failed") || r.startsWith("Skipped"));
    return {
      output: results.join("\n"),
      success: !allFailed && results.length > 0,
    };
  },
};

/**
 * Apply a unified diff to existing content.
 * Simplified approach: parse hunks and apply line-based changes.
 */
function applyUnifiedDiff(existingContent: string, diffContent: ReadonlyArray<string>): string {
  const lines = existingContent.split("\n");
  const result: string[] = [];
  let sourceIndex = 0;
  let sawHunk = false;
  for (let index = 0; index < diffContent.length; ) {
    const header = diffContent[index]!.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u);
    if (!header) {
      index += 1;
      continue;
    }
    sawHunk = true;
    const targetIndex = Number(header[1]) - 1;
    if (!Number.isInteger(targetIndex) || targetIndex < 0 || targetIndex > lines.length) {
      throw new Error(`Invalid hunk source line: ${header[1]}`);
    }
    result.push(...lines.slice(sourceIndex, targetIndex));
    sourceIndex = targetIndex;
    index += 1;
    while (index < diffContent.length && !diffContent[index]!.startsWith("@@ ")) {
      const line = diffContent[index]!;
      if (line.startsWith("\\")) {
        index += 1;
        continue;
      }
      if (line.startsWith(" ")) {
        const expected = line.slice(1);
        if (lines[sourceIndex] !== expected)
          throw new Error(`Patch context mismatch at line ${sourceIndex + 1}.`);
        result.push(lines[sourceIndex]!);
        sourceIndex += 1;
      } else if (line.startsWith("-")) {
        const expected = line.slice(1);
        if (lines[sourceIndex] !== expected)
          throw new Error(`Patch deletion mismatch at line ${sourceIndex + 1}.`);
        sourceIndex += 1;
      } else if (line.startsWith("+")) {
        result.push(line.slice(1));
      }
      index += 1;
    }
  }
  if (!sawHunk) throw new Error("Update patch contains no hunks.");
  result.push(...lines.slice(sourceIndex));
  return result.join("\n");
}

export const filesystemTools: ReadonlyArray<AgentTool> = [
  readFileTool,
  writeFileTool,
  listDirectoryTool,
  applyPatchTool,
];
