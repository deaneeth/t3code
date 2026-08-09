// @effect-diagnostics nodeBuiltinImport:off
/**
 * Raw filesystem access for transcript scanning.
 *
 * Isolated here so the rest of the usage code stays on Effect's `FileSystem`.
 * The direct `node:fs` streaming is deliberate: a cold 30-day window is ~1.4 GB
 * across ~1,500 files, and `readline` over a read stream is roughly an order of
 * magnitude cheaper than materialising each file. The equivalent Effect stream
 * pipeline is idiomatic but not fast enough to sit behind a page load.
 *
 * @module usageTranscriptReader
 */
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import * as NodeSqlite from "node:sqlite";

import type { UsageProviderKind } from "@t3tools/contracts";

import {
  initialCodexScanState,
  initialCommandCodeScanState,
  mightCarryUsage,
  parseClaudeLine,
  parseCodexLine,
  parseCommandCodeLine,
  parseOpenCodeMessage,
  type UsageRecord,
} from "./usageTranscripts.ts";

export interface TranscriptFile {
  readonly path: string;
  readonly size: number;
  readonly mtimeMs: number;
}

export interface TranscriptFileListing {
  readonly files: readonly TranscriptFile[];
  /** True when a directory/stat operation failed during the walk. */
  readonly hadErrors: boolean;
}

/**
 * Lists `.jsonl` transcripts under `root` last modified at or after `sinceMs`.
 *
 * Errors on individual entries are swallowed: session files rotate and get
 * removed while the walk is in flight, and a partial listing is far better than
 * failing the page.
 */
export async function listTranscriptFilesDetailed(
  root: string,
  sinceMs: number,
): Promise<TranscriptFileListing> {
  const found: TranscriptFile[] = [];
  let hadErrors = false;

  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await NodeFSP.readdir(dir, { withFileTypes: true });
    } catch {
      hadErrors = true;
      return;
    }
    for (const entry of entries) {
      const child = NodePath.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(child);
        continue;
      }
      if (!entry.name.endsWith(".jsonl")) continue;
      try {
        const stats = await NodeFSP.stat(child);
        if (stats.mtimeMs >= sinceMs) {
          found.push({ path: child, size: stats.size, mtimeMs: stats.mtimeMs });
        }
      } catch {
        // Vanished between readdir and stat.
        hadErrors = true;
      }
    }
  };

  await walk(root);
  return { files: found, hadErrors };
}

export async function listTranscriptFiles(
  root: string,
  sinceMs: number,
): Promise<readonly TranscriptFile[]> {
  return (await listTranscriptFilesDetailed(root, sinceMs)).files;
}

/**
 * Filesystem identity of a directory, as `device:inode`.
 *
 * Used to tell "two servers reading the same transcript directory" apart from
 * "two machines whose hostname and home path happen to match". Returns an empty
 * string when the directory cannot be stat'd.
 */
export async function readDirectoryVolumeId(path: string): Promise<string> {
  try {
    const stats = await NodeFSP.stat(path);
    return `${stats.dev}:${stats.ino}`;
  } catch {
    return "";
  }
}

/**
 * Streams one transcript and returns the usage records it contains, or `null`
 * when the file could not be read.
 *
 * The distinction matters to the caller's cache: a genuinely empty transcript
 * is a stable fact worth memoising, while a transient read failure memoised
 * under the same `(size, mtime)` key would silently drop that file's usage
 * until the file next changes.
 *
 * Codex carries the active model on `turn_context` lines that hold no usage of
 * their own, so those still have to pass through the reducer to keep model
 * attribution correct.
 */
export async function readTranscriptRecords(
  filePath: string,
  provider: UsageProviderKind,
): Promise<readonly UsageRecord[] | null> {
  const records: UsageRecord[] = [];
  const codexState = initialCodexScanState();
  const commandCodeState = initialCommandCodeScanState();

  try {
    if (provider === "opencode") {
      return NodePath.extname(filePath) === ".json"
        ? await readOpenCodeMessageFile(filePath)
        : await readOpenCodeDatabase(filePath);
    }

    const lines = NodeReadline.createInterface({
      input: NodeFS.createReadStream(filePath, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });

    for await (const line of lines) {
      if (provider === "codex") {
        if (
          !mightCarryUsage(line, provider) &&
          !line.includes('"turn_context"') &&
          !line.includes('"session_meta"')
        ) {
          continue;
        }
        const record = parseCodexLine(line, codexState);
        if (record !== null) records.push(record);
        continue;
      }

      if (provider === "commandcode") {
        // The session header announces the session id but carries no usage,
        // so it must pass through the reducer alongside usage-bearing lines.
        if (
          !mightCarryUsage(line, provider) &&
          !line.includes('"type": "session"') &&
          !line.includes('"type":"session"')
        ) {
          continue;
        }
      } else if (!mightCarryUsage(line, provider)) {
        continue;
      }
      if (provider === "commandcode") {
        const record = parseCommandCodeLine(line, commandCodeState);
        if (record !== null) records.push(record);
      } else {
        const record = parseClaudeLine(line);
        if (record !== null) records.push(record);
      }
    }
  } catch {
    return null;
  }

  return records;
}

/**
 * Resolves the OpenCode SQLite database path, if any.
 *
 * Mirrors OpenCode's data layout. A straight `opencode.db` is the primary
 * store; channel databases are also supported for installations that keep
 * more than one database beside it.
 */
export async function resolveOpenCodeDatabase(root: string): Promise<string | null> {
  const plain = NodePath.join(root, "opencode.db");
  try {
    const stats = await NodeFSP.stat(plain);
    if (stats.isFile()) return plain;
  } catch {
    // Fall through to channel databases.
  }
  let entries;
  try {
    entries = await NodeFSP.readdir(root);
  } catch {
    return null;
  }
  const candidates = entries.filter((name) => {
    if (!name.startsWith("opencode-") || !name.endsWith(".db")) return false;
    const channel = name.slice("opencode-".length, -".db".length);
    return channel.length > 0 && [...channel].every((ch) => /[\w-]/.test(ch));
  });
  const withMtime = await Promise.all(
    candidates.map(async (name) => {
      try {
        return { name, mtimeMs: (await NodeFSP.stat(NodePath.join(root, name))).mtimeMs };
      } catch {
        return null;
      }
    }),
  );
  const newest = withMtime
    .filter((entry): entry is { name: string; mtimeMs: number } => entry !== null)
    .toSorted((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name))[0];
  return newest === undefined ? null : NodePath.join(root, newest.name);
}

async function resolveOpenCodeDatabasePaths(root: string): Promise<readonly string[]> {
  const paths: string[] = [];
  const plain = NodePath.join(root, "opencode.db");
  try {
    if ((await NodeFSP.stat(plain)).isFile()) paths.push(plain);
  } catch {
    // The channel database fallback below is still useful.
  }
  let entries: readonly string[];
  try {
    entries = await NodeFSP.readdir(root);
  } catch {
    return paths;
  }
  for (const name of entries) {
    if (!name.startsWith("opencode-") || !name.endsWith(".db")) continue;
    const channel = name.slice("opencode-".length, -".db".length);
    if (![...channel].every((ch) => /[\w-]/.test(ch))) continue;
    const candidate = NodePath.join(root, name);
    try {
      if ((await NodeFSP.stat(candidate)).isFile()) paths.push(candidate);
    } catch {
      // A rotated channel can disappear between readdir and stat.
    }
  }
  return paths;
}

/**
 * Lists the usage sources inside one OpenCode data directory.
 *
 * Recent OpenCode stores usage in `opencode.db`; older installs keep one JSON
 * file per message under `storage/message/<session>/<message>.json`. Either
 * or both may be present. Returns `(size, mtime)` entries so they memoise in
 * the caller's scan cache exactly like JSONL transcripts.
 */
export async function listOpenCodeSourceFilesDetailed(
  root: string,
  sinceMs: number,
): Promise<TranscriptFileListing> {
  const found: TranscriptFile[] = [];
  let hadErrors = false;

  const addFile = async (path: string, includeWhenOld = false): Promise<void> => {
    try {
      const stats = await NodeFSP.stat(path);
      if (includeWhenOld || stats.mtimeMs >= sinceMs) {
        found.push({ path, size: stats.size, mtimeMs: stats.mtimeMs });
      }
    } catch {
      // Vanished between readdir and stat.
      hadErrors = true;
    }
  };

  // SQLite files are append-only stores whose mtime can lag the newest row
  // after a restore/copy. Always inspect them and let the record timestamp
  // enforce the requested window.
  for (const dbPath of await resolveOpenCodeDatabasePaths(root)) await addFile(dbPath, true);

  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await NodeFSP.readdir(dir, { withFileTypes: true });
    } catch {
      hadErrors = true;
      return;
    }
    for (const entry of entries) {
      const child = NodePath.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(child);
        continue;
      }
      if (!entry.name.endsWith(".json")) continue;
      await addFile(child);
    }
  };

  const legacyRoot = NodePath.join(root, "storage", "message");
  // The legacy JSON layout is optional. A missing directory is normal for a
  // healthy modern SQLite installation and must not turn the source partial.
  try {
    if ((await NodeFSP.stat(legacyRoot)).isDirectory()) await walk(legacyRoot);
  } catch {
    // No legacy store; the database list above remains authoritative.
  }

  return { files: found, hadErrors };
}

export async function listOpenCodeSourceFiles(
  root: string,
  sinceMs: number,
): Promise<readonly TranscriptFile[]> {
  return (await listOpenCodeSourceFilesDetailed(root, sinceMs)).files;
}

/**
 * Reads one legacy OpenCode message file into at most one usage record.
 *
 * The file holds a single message payload, so nothing is streamed.
 */
async function readOpenCodeMessageFile(filePath: string): Promise<readonly UsageRecord[]> {
  const raw = await NodeFSP.readFile(filePath, { encoding: "utf8" });
  const id = NodePath.basename(filePath, ".json");
  const sessionId = NodePath.basename(NodePath.dirname(filePath));
  const record = parseOpenCodeMessage(JSON.parse(raw), sessionId, id);
  return record === null ? [] : [record];
}

/**
 * Reads the OpenCode SQLite database and returns one record per message that
 * carried usage.
 *
 * Read-only, and immune to the database being written mid-scan: a row whose
 * JSON fails to parse is skipped rather than failing the whole scan.
 */
async function readOpenCodeDatabase(filePath: string): Promise<readonly UsageRecord[]> {
  const database = new NodeSqlite.DatabaseSync(filePath, { readOnly: true });
  try {
    const rows = database
      .prepare("SELECT id, session_id, data FROM message")
      .all() as unknown as readonly {
      id: string;
      session_id: string;
      data: string;
    }[];
    const records: UsageRecord[] = [];
    for (const row of rows) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(row.data);
      } catch {
        continue;
      }
      const record = parseOpenCodeMessage(parsed, row.session_id, row.id);
      if (record !== null) records.push(record);
    }
    return records;
  } finally {
    database.close();
  }
}
