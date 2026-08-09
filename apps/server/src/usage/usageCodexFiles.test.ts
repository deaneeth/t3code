import { describe, expect, it } from "@effect/vitest";

import { selectCodexTranscriptFiles } from "./usageCodexFiles.ts";

const file = (path: string) => ({ path, size: 1, mtimeMs: 1 });

describe("selectCodexTranscriptFiles", () => {
  it("prefers an active rollout over its archived copy", () => {
    const activeFiles = new Set<string>();
    const active = selectCodexTranscriptFiles({
      files: [file("/codex/sessions/2026/rollout-a.jsonl")],
      root: "/codex/sessions",
      sharedHomePath: "/codex",
      archived: false,
      activeFiles,
    });
    const archived = selectCodexTranscriptFiles({
      files: [
        file("/codex/archived_sessions/2026/rollout-a.jsonl"),
        file("/codex/archived_sessions/2026/rollout-b.jsonl"),
      ],
      root: "/codex/archived_sessions",
      sharedHomePath: "/codex",
      archived: true,
      activeFiles,
    });

    expect(active).toHaveLength(1);
    expect(archived.map((entry) => entry.path)).toEqual([
      "/codex/archived_sessions/2026/rollout-b.jsonl",
    ]);
  });

  it("does not confuse equal relative paths from different homes", () => {
    const activeFiles = new Set<string>();
    selectCodexTranscriptFiles({
      files: [file("/work/codex/sessions/rollout.jsonl")],
      root: "/work/codex/sessions",
      sharedHomePath: "/work/codex",
      archived: false,
      activeFiles,
    });
    const otherHome = selectCodexTranscriptFiles({
      files: [file("/other/codex/archived_sessions/rollout.jsonl")],
      root: "/other/codex/archived_sessions",
      sharedHomePath: "/other/codex",
      archived: true,
      activeFiles,
    });

    expect(otherHome).toHaveLength(1);
  });
});
