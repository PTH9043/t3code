import { describe, expect, it } from "vite-plus/test";

import { combineWorktreeDiffSources, splitUnifiedPatch } from "./worktreeDiffPresentation";

const patch = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 111..222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,2 +1,2 @@",
  "-old line",
  "+new line",
  " unchanged",
  "diff --git a/docs/b.md b/docs/b.md",
  "--- a/docs/b.md",
  "+++ b/docs/b.md",
  "@@ -0,0 +1,2 @@",
  "+added one",
  "+added two",
].join("\n");

describe("splitUnifiedPatch", () => {
  it("splits per file and counts changed lines without the header noise", () => {
    const files = splitUnifiedPatch(patch);
    expect(files.map((file) => file.path)).toEqual(["src/a.ts", "docs/b.md"]);
    expect(files[0]).toMatchObject({ added: 1, removed: 1 });
    expect(files[1]).toMatchObject({ added: 2, removed: 0 });
    expect(files[0]?.text).toContain("-old line");
  });

  it("returns nothing for an empty patch", () => {
    expect(splitUnifiedPatch("")).toEqual([]);
    expect(splitUnifiedPatch("\n")).toEqual([]);
  });
});

describe("combineWorktreeDiffSources", () => {
  const source = (kind: "working-tree" | "branch-range", diff: string) => ({
    id: kind,
    kind,
    title: kind,
    baseRef: null,
    headRef: null,
    diff,
    diffHash: "0",
    truncated: false,
  });

  it("keeps committed and uncommitted work as separate sections and drops empty ones", () => {
    const sections = combineWorktreeDiffSources([
      source("working-tree", patch),
      source("branch-range", ""),
    ]);
    expect(sections).toHaveLength(1);
    expect(sections[0]?.title).toBe("커밋 전 변경");
    expect(sections[0]?.files).toHaveLength(2);
  });
});
