import type { ReviewDiffPreviewSource } from "@t3tools/contracts";

export interface WorktreeDiffFile {
  readonly path: string;
  readonly added: number;
  readonly removed: number;
  readonly text: string;
}

const FILE_HEADER = /^diff --git (?:"?a\/(.+?)"?) (?:"?b\/(.+?)"?)$/;

/**
 * Split a unified patch into per-file sections for the control-center's
 * lightweight review. The full DiffPanel pipeline needs a thread context this
 * view does not have; a per-file collapse with line counts is enough to judge
 * whether a chain worktree is ready to merge.
 */
export function splitUnifiedPatch(patch: string): ReadonlyArray<WorktreeDiffFile> {
  const files: WorktreeDiffFile[] = [];
  let current: { path: string; added: number; removed: number; lines: string[] } | null = null;
  const flush = () => {
    if (current === null) return;
    files.push({
      path: current.path,
      added: current.added,
      removed: current.removed,
      text: current.lines.join("\n"),
    });
    current = null;
  };
  for (const line of patch.split("\n")) {
    const header = FILE_HEADER.exec(line);
    if (header !== null) {
      flush();
      current = { path: header[2] ?? header[1] ?? line, added: 0, removed: 0, lines: [line] };
      continue;
    }
    if (current === null) continue;
    current.lines.push(line);
    if (line.startsWith("+") && !line.startsWith("+++")) current.added += 1;
    else if (line.startsWith("-") && !line.startsWith("---")) current.removed += 1;
  }
  flush();
  return files;
}

/**
 * "worktree vs base" is the union of the branch's committed delta and the
 * uncommitted working tree — the diff preview reports them as two sources,
 * and a person merging the chain needs to see both.
 */
export function combineWorktreeDiffSources(
  sources: ReadonlyArray<ReviewDiffPreviewSource>,
): ReadonlyArray<{ readonly title: string; readonly files: ReadonlyArray<WorktreeDiffFile> }> {
  return sources
    .map((source) => ({
      title: source.kind === "working-tree" ? "커밋 전 변경" : "커밋된 변경 (base 대비)",
      files: splitUnifiedPatch(source.diff),
    }))
    .filter((section) => section.files.length > 0);
}
