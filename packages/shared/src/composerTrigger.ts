import * as DateTime from "effect/DateTime";

export type ComposerTriggerKind = "path" | "slash-command" | "slash-model" | "skill";
export type ComposerSlashCommand =
  | "model"
  | "plan"
  | "default"
  | "clear"
  | "rename"
  | "context"
  | "stats"
  | "help"
  | "todos"
  | "stop"
  | "revert"
  | "archive"
  | "unarchive"
  | "pin"
  | "unpin"
  | "snooze"
  | "unsnooze"
  | "settle"
  | "unsettle";

export interface StandaloneComposerSlashCommand {
  command: Exclude<ComposerSlashCommand, "model">;
  args: string;
}

export interface ComposerTrigger {
  kind: ComposerTriggerKind;
  query: string;
  rangeStart: number;
  rangeEnd: number;
}

const SIMPLE_MENTION_PATH_REGEX = /^[^\s@"\\]+$/;

export function serializeComposerMentionPath(path: string): string {
  if (SIMPLE_MENTION_PATH_REGEX.test(path)) {
    return path;
  }
  return `"${path.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function composerFileLinkBasename(path: string): string {
  const separatorIndex = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return separatorIndex >= 0 ? path.slice(separatorIndex + 1) : path;
}

function escapeMarkdownLinkLabel(label: string): string {
  return label.replaceAll("\\", "\\\\").replaceAll("[", "\\[").replaceAll("]", "\\]");
}

function encodeMarkdownLinkDestination(path: string): string {
  return encodeURI(path)
    .replaceAll("(", "%28")
    .replaceAll(")", "%29")
    .replaceAll("#", "%23")
    .replaceAll("?", "%3F")
    .replaceAll("\\", "%5C");
}

export function serializeComposerFileLink(path: string): string {
  const label = escapeMarkdownLinkLabel(composerFileLinkBasename(path));
  return `[${label}](${encodeMarkdownLinkDestination(path)})`;
}

function clampCursor(text: string, cursor: number): number {
  if (!Number.isFinite(cursor)) return text.length;
  return Math.max(0, Math.min(text.length, Math.floor(cursor)));
}

function isWhitespace(char: string): boolean {
  return char === " " || char === "\n" || char === "\t" || char === "\r";
}

/**
 * Detect an active trigger (@path, $skill, /command) at the cursor position.
 *
 * Accepts an optional `isWhitespaceChar` override so callers with inline
 * placeholder characters (e.g. terminal context chips on web) can treat
 * those as token boundaries.
 */
export function detectComposerTrigger(
  text: string,
  cursorInput: number,
  isWhitespaceChar?: (char: string) => boolean,
): ComposerTrigger | null {
  const cursor = clampCursor(text, cursorInput);
  const lineStart = text.lastIndexOf("\n", Math.max(0, cursor - 1)) + 1;
  const linePrefix = text.slice(lineStart, cursor);

  if (linePrefix.startsWith("/")) {
    const commandMatch = /^\/(\S*)$/.exec(linePrefix);
    if (commandMatch) {
      const commandQuery = commandMatch[1] ?? "";
      if (commandQuery.toLowerCase() === "model") {
        return {
          kind: "slash-model",
          query: "",
          rangeStart: lineStart,
          rangeEnd: cursor,
        };
      }
      return {
        kind: "slash-command",
        query: commandQuery,
        rangeStart: lineStart,
        rangeEnd: cursor,
      };
    }

    const modelMatch = /^\/model(?:\s+(.*))?$/.exec(linePrefix);
    if (modelMatch) {
      return {
        kind: "slash-model",
        query: (modelMatch[1] ?? "").trim(),
        rangeStart: lineStart,
        rangeEnd: cursor,
      };
    }
  }

  const wsCheck = isWhitespaceChar ?? isWhitespace;
  let tokenIdx = cursor - 1;
  while (tokenIdx >= 0 && !wsCheck(text[tokenIdx] ?? "")) {
    tokenIdx -= 1;
  }
  const tokenStart = tokenIdx + 1;

  const token = text.slice(tokenStart, cursor);
  if (token.startsWith("$")) {
    return {
      kind: "skill",
      query: token.slice(1),
      rangeStart: tokenStart,
      rangeEnd: cursor,
    };
  }
  if (!token.startsWith("@")) {
    return null;
  }

  return {
    kind: "path",
    query: token.slice(1),
    rangeStart: tokenStart,
    rangeEnd: cursor,
  };
}

const STANDALONE_NO_ARG_COMMANDS: ReadonlySet<string> = new Set([
  "plan",
  "default",
  "clear",
  "context",
  "stats",
  "help",
  "todos",
  "stop",
  "archive",
  "unarchive",
  "pin",
  "unpin",
  "unsnooze",
  "settle",
  "unsettle",
]);

const STANDALONE_ARG_COMMANDS: ReadonlySet<string> = new Set(["rename", "revert", "snooze"]);

export interface BuiltInSlashCommandDefinition {
  command: ComposerSlashCommand;
  label: string;
  description: string;
  requiresArg: boolean;
  argHint: string | null;
}

export const BUILT_IN_SLASH_COMMAND_DEFS: readonly BuiltInSlashCommandDefinition[] = [
  {
    command: "model",
    label: "/model",
    description: "Switch response model for this thread",
    requiresArg: false,
    argHint: null,
  },
  {
    command: "plan",
    label: "/plan",
    description: "Switch this thread into plan mode",
    requiresArg: false,
    argHint: null,
  },
  {
    command: "default",
    label: "/default",
    description: "Switch this thread back to normal build mode",
    requiresArg: false,
    argHint: null,
  },
  {
    command: "todos",
    label: "/todos",
    description: "Open the plan and task list for this thread",
    requiresArg: false,
    argHint: null,
  },
  {
    command: "clear",
    label: "/clear",
    description: "Start a new thread and clear this conversation",
    requiresArg: false,
    argHint: null,
  },
  {
    command: "rename",
    label: "/rename",
    description: "Rename this thread",
    requiresArg: true,
    argHint: "new title",
  },
  {
    command: "context",
    label: "/context",
    description: "Show context window usage for this thread",
    requiresArg: false,
    argHint: null,
  },
  {
    command: "stats",
    label: "/stats",
    description: "Show token usage and activity stats for this thread",
    requiresArg: false,
    argHint: null,
  },
  {
    command: "stop",
    label: "/stop",
    description: "Stop the current turn",
    requiresArg: false,
    argHint: null,
  },
  {
    command: "revert",
    label: "/revert",
    description: "Revert this thread to an earlier checkpoint",
    requiresArg: true,
    argHint: "checkpoint number",
  },
  {
    command: "snooze",
    label: "/snooze",
    description: "Snooze this thread until a duration from now has passed",
    requiresArg: true,
    argHint: "e.g. 30m, 2h, 1d",
  },
  {
    command: "unsnooze",
    label: "/unsnooze",
    description: "Unsnooze this thread",
    requiresArg: false,
    argHint: null,
  },
  {
    command: "archive",
    label: "/archive",
    description: "Archive this thread",
    requiresArg: false,
    argHint: null,
  },
  {
    command: "unarchive",
    label: "/unarchive",
    description: "Unarchive this thread",
    requiresArg: false,
    argHint: null,
  },
  {
    command: "pin",
    label: "/pin",
    description: "Pin this thread to the top of the sidebar",
    requiresArg: false,
    argHint: null,
  },
  {
    command: "unpin",
    label: "/unpin",
    description: "Unpin this thread from the sidebar",
    requiresArg: false,
    argHint: null,
  },
  {
    command: "settle",
    label: "/settle",
    description: "Settle this thread so it stops nagging you",
    requiresArg: false,
    argHint: null,
  },
  {
    command: "unsettle",
    label: "/unsettle",
    description: "Unsettle this thread",
    requiresArg: false,
    argHint: null,
  },
  {
    command: "help",
    label: "/help",
    description: "List all available slash commands",
    requiresArg: false,
    argHint: null,
  },
];

export const BUILT_IN_SLASH_COMMAND_BY_NAME: ReadonlyMap<string, BuiltInSlashCommandDefinition> =
  new Map(BUILT_IN_SLASH_COMMAND_DEFS.map((def) => [def.command, def]));

const SLASH_SNOOZE_DURATION_REGEX = /^(\d+)\s*(m|min|h|d|s)$/i;

export function parseSlashSnoozeDuration(input: string, now?: Date): string | null {
  const match = SLASH_SNOOZE_DURATION_REGEX.exec(input.trim());
  if (!match) {
    return null;
  }
  const value = Number(match[1]);
  const unit = (match[2] ?? "").toLowerCase();
  const milliseconds = unit.startsWith("m")
    ? value * 60_000
    : unit === "h"
      ? value * 3_600_000
      : unit === "s"
        ? value * 1_000
        : value * 86_400_000;
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) {
    return null;
  }
  const nowMillis = now !== undefined ? now.getTime() : DateTime.nowUnsafe().epochMilliseconds;
  return DateTime.formatIso(DateTime.add(DateTime.makeUnsafe(nowMillis), { milliseconds }));
}

export function parseStandaloneComposerSlashCommand(
  text: string,
): StandaloneComposerSlashCommand | null {
  const match = /^\/([A-Za-z][\w-]*)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!match) {
    return null;
  }
  const command = match[1]?.toLowerCase();
  const args = (match[2] ?? "").trim();
  if (!command) {
    return null;
  }
  if (STANDALONE_NO_ARG_COMMANDS.has(command)) {
    if (args.length > 0) {
      return null;
    }
    return { command: command as Exclude<ComposerSlashCommand, "model">, args: "" };
  }
  if (STANDALONE_ARG_COMMANDS.has(command)) {
    return { command: command as Exclude<ComposerSlashCommand, "model">, args };
  }
  return null;
}

export function replaceTextRange(
  text: string,
  rangeStart: number,
  rangeEnd: number,
  replacement: string,
): { text: string; cursor: number } {
  const safeStart = Math.max(0, Math.min(text.length, rangeStart));
  const safeEnd = Math.max(safeStart, Math.min(text.length, rangeEnd));
  const nextText = `${text.slice(0, safeStart)}${replacement}${text.slice(safeEnd)}`;
  return { text: nextText, cursor: safeStart + replacement.length };
}
