// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { describe, expect, it } from "@effect/vitest";

import { listOpenCodeSourceFiles, readTranscriptRecords } from "./usageTranscriptReader.ts";

async function makeTempDir(): Promise<string> {
  return NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-usage-reader-"));
}

describe("readTranscriptRecords for commandcode", () => {
  it("streams a session JSONL into records", async () => {
    const dir = await makeTempDir();
    const sessionId = "2ca9f2a2-b51c-41f8-a4fb-ae9dc5d13d1c";
    const file = NodePath.join(dir, `${sessionId}.jsonl`);
    await NodeFSP.writeFile(
      file,
      [
        JSON.stringify({
          type: "session",
          version: 3,
          id: sessionId,
          timestamp: "2026-08-07T20:27:59.456Z",
        }),
        JSON.stringify({
          type: "message",
          id: "12030463",
          timestamp: "2026-08-07T20:28:05.858Z",
          message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
          usage: {
            inputTokens: 38926,
            outputTokens: 136,
            cacheReadTokens: 7424,
            cacheWriteTokens: 0,
          },
          model: "deepseek/deepseek-v4-flash",
        }),
        // A session whose header is missing still yields records, but without
        // a session id they cannot be fingerprinted.
        JSON.stringify({
          type: "message",
          id: "abc",
          timestamp: "2026-08-07T20:28:06.000Z",
          message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
          usage: { inputTokens: 1, outputTokens: 2 },
          model: "deepseek/deepseek-v4-flash",
        }),
      ].join("\n"),
    );

    const records = await readTranscriptRecords(file, "commandcode");
    expect(records?.length).toBe(2);
    expect(records?.[0]?.sessionId).toBe(sessionId);
    expect(records?.[0]?.totals).toEqual({
      uncachedInputTokens: 38926,
      cachedInputTokens: 7424,
      cacheCreationTokens: 0,
      outputTokens: 136,
      reasoningTokens: 0,
    });
  });
});

describe("listOpenCodeSourceFiles + opencode db reading", () => {
  it("finds the db and yields records from message rows", async () => {
    const dir = await makeTempDir();
    const dbPath = NodePath.join(dir, "opencode.db");
    {
      const db = new NodeSqlite.DatabaseSync(dbPath);
      db.exec("CREATE TABLE message (id TEXT, session_id TEXT, data TEXT)");
      db.prepare("INSERT INTO message VALUES (?, ?, ?)").run(
        "msg_1",
        "ses_1",
        JSON.stringify({
          role: "assistant",
          tokens: {
            total: 14456,
            input: 12548,
            output: 59,
            reasoning: 58,
            cache: { write: 0, read: 1792 },
          },
          modelID: "mimo-v2.5-free",
          providerID: "opencode",
          time: { created: 1785177361757 },
        }),
      );
      db.prepare("INSERT INTO message VALUES (?, ?, ?)").run(
        "msg_2",
        "ses_1",
        JSON.stringify({ role: "user", content: [] }),
      );
      db.close();
    }

    const sources = await listOpenCodeSourceFiles(dir, 0);
    expect(sources.map((source) => NodePath.basename(source.path))).toEqual(["opencode.db"]);

    const records = await readTranscriptRecords(dbPath, "opencode");
    expect(records?.length).toBe(1);
    expect(records?.[0]).toMatchObject({
      provider: "opencode",
      model: "opencode/mimo-v2.5-free",
      sessionId: "ses_1",
      dedupeKey: "msg_1",
    });
    expect(records?.[0]?.totals.cachedInputTokens).toBe(1792);
    expect(records?.[0]?.totals.reasoningTokens).toBe(58);
  });

  it("returns empty when no db and no message files exist", async () => {
    const dir = await makeTempDir();
    expect(await listOpenCodeSourceFiles(dir, 0)).toEqual([]);
    expect(await readTranscriptRecords(NodePath.join(dir, "opencode.db"), "opencode")).toBe(null);
  });
});
