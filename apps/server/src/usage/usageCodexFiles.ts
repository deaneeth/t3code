// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import type { TranscriptFile } from "./usageTranscriptReader.ts";

/**
 * Selects Codex rollout files while preferring an active copy over an archived
 * copy with the same relative path. Codex moves files between these roots, and
 * keeping both copies would make an unchanged rollout count twice.
 */
export function selectCodexTranscriptFiles(input: {
  readonly files: readonly TranscriptFile[];
  readonly root: string;
  readonly sharedHomePath: string;
  readonly archived: boolean;
  readonly activeFiles: Set<string>;
}): readonly TranscriptFile[] {
  const keys = input.files.map(
    (file) => `${input.sharedHomePath}\0${NodePath.relative(input.root, file.path)}`,
  );

  if (input.archived) {
    return input.files.filter((_, index) => !input.activeFiles.has(keys[index]!));
  }

  for (const key of keys) input.activeFiles.add(key);
  return input.files;
}
