import { describe, expect, it } from "vite-plus/test";
import { WorkspaceKnowledgeItemId } from "@t3tools/contracts";
import {
  formatWorkspaceWikiIdLink,
  parseWorkspaceWikiLinks,
} from "@t3tools/shared/workspaceWikiLinks";
import {
  completionAt,
  editableWikiBody,
  wikiIndexMatches,
  wikiOccurrences,
  wikiReaderMarkdown,
} from "./knowledgeDocument.logic";

describe("project wiki references", () => {
  it("keeps a resolved occurrence's ID when its title has changed and a later namesake needs an explicit choice", () => {
    const source = "📝 [[Spec|처음]] and [[Spec]]";
    const [first, second] = parseWorkspaceWikiLinks(source);
    const id = WorkspaceKnowledgeItemId.make("original-id");
    const evidence = [
      { ...first!, targetTitle: "Renamed", targetItemId: id },
      { ...second!, targetItemId: null },
    ];
    expect(wikiOccurrences(source, evidence).map((link) => link.targetItemId)).toEqual([id, null]);
    expect(editableWikiBody(source, evidence)).toBe("📝 [[id:original-id|처음]] and [[Spec]]");
  });

  it("rejects an offset from a stale different body and does not convert literal code or fenced examples", () => {
    const original = "use [[abc]]";
    const [old] = parseWorkspaceWikiLinks(original);
    const evidence = [{ ...old!, targetItemId: WorkspaceKnowledgeItemId.make("first") }];
    expect(wikiIndexMatches(original, evidence)).toBe(true);
    expect(wikiIndexMatches("use [[xyz]]", evidence)).toBe(false);
    expect(wikiOccurrences("use [[xyz]]", evidence)[0]?.targetItemId).toBeNull();
    const raw = [
      "`[[literal]]`",
      "~~~",
      "[[example]]",
      "~~~",
      formatWorkspaceWikiIdLink("odd/id", "x](*y)"),
    ].join("\n");
    const { markdown, occurrences } = wikiReaderMarkdown(raw, []);
    expect(occurrences).toHaveLength(1);
    expect(markdown).toContain("`[[literal]]`");
    expect(markdown).toContain("[[example]]");
    expect(markdown).toContain("&#93;");
  });

  it("replaces only the completion at the cursor, including the existing closing brackets", () => {
    const text = "a [[te]] and [[Other]]";
    expect(completionAt(text, 6)).toEqual({ start: 2, end: 8, query: "te" });
    expect(completionAt(text, text.length)).toBeNull();
    expect(completionAt("x\n[[", 4)).toEqual({ start: 2, end: 4, query: "" });
  });
});
