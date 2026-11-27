import { describe, expect, it } from "vite-plus/test";
import { parseWorkspaceWikiLinks, formatWorkspaceWikiIdLink } from "./workspaceWikiLinks.ts";

describe("workspace wiki link parser", () => {
  it("preserves UTF-16 offsets and aliases outside backtick spans and fenced code", () => {
    const body = [
      "📌 [[One|custom]] `[[skip]]`",
      "``multi",
      "[[ignore]]`` [[two]]",
      "> ~~~md",
      "> [[fenced]]",
      "> ~~~~",
      "````",
      "```",
      "[[hidden]]",
      "````",
      "\\[[escaped]] [[마침]]",
    ].join("\r\n");
    const links = parseWorkspaceWikiLinks(body);
    expect(links.map((l) => body.slice(l.start, l.end))).toEqual([
      "[[One|custom]]",
      "[[two]]",
      "[[마침]]",
    ]);
    expect(links[0]).toMatchObject({ start: 3, targetTitle: "One", alias: "custom" });
    expect(links[1]?.context).toContain("[[two]]");
  });

  it("keeps quoted fence markers inside outer code and ends a quoted fence at the container boundary", () => {
    const text = [
      "```",
      "> ```",
      "[[outer code]]",
      "```",
      "> ~~~",
      "> [[quoted code]]",
      "[[visible]]",
    ].join("\r");
    expect(parseWorkspaceWikiLinks(text).map((link) => link.targetTitle)).toEqual(["visible"]);
  });

  it("round trips explicit IDs and labels with wiki delimiters", () => {
    const text = formatWorkspaceWikiIdLink("doc-id", "a] [b | c\\tail");
    expect(parseWorkspaceWikiLinks(text)).toMatchObject([
      { explicitItemId: "doc-id", alias: "a] [b | c\\tail" },
    ]);
    expect(
      parseWorkspaceWikiLinks("bad [[id:%XY]] ; `unclosed [[ok]]").map((l) => l.targetTitle),
    ).toEqual(["ok"]);
  });
});
