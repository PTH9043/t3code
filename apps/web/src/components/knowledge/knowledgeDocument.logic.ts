import type { WorkspaceWikiLink } from "@t3tools/contracts";
import {
  formatWorkspaceWikiIdLink,
  parseWorkspaceWikiLinks,
} from "@t3tools/shared/workspaceWikiLinks";

type LinkEvidence = Pick<WorkspaceWikiLink, "start" | "end" | "context" | "targetItemId">;

export function wikiIndexMatches(content: string, outgoing: ReadonlyArray<LinkEvidence>) {
  const occurrences = parseWorkspaceWikiLinks(content);
  return (
    occurrences.length === outgoing.length &&
    occurrences.every((parsed, index) => {
      const record = outgoing[index];
      return (
        record?.start === parsed.start &&
        record.end === parsed.end &&
        record.context === parsed.context
      );
    })
  );
}

export function wikiOccurrences(content: string, outgoing: ReadonlyArray<LinkEvidence>) {
  const records = new Map(outgoing.map((link) => [link.start, link]));
  return parseWorkspaceWikiLinks(content).map((parsed) => {
    const record = records.get(parsed.start);
    const matches =
      record?.end === parsed.end &&
      record.context === parsed.context &&
      (!parsed.explicitItemId || record.targetItemId === parsed.explicitItemId);
    return { ...parsed, targetItemId: matches ? record.targetItemId : null };
  });
}

function replaceOccurrences(
  content: string,
  changes: ReadonlyArray<{ start: number; end: number; replacement: string }>,
) {
  const parts: string[] = [];
  let start = 0;
  for (const change of changes) {
    parts.push(content.slice(start, change.start), change.replacement);
    start = change.end;
  }
  return parts.join("") + content.slice(start);
}

export function editableWikiBody(content: string, outgoing: ReadonlyArray<LinkEvidence>) {
  return replaceOccurrences(
    content,
    wikiOccurrences(content, outgoing).flatMap((link) =>
      link.targetItemId && !link.explicitItemId
        ? [
            {
              ...link,
              replacement: formatWorkspaceWikiIdLink(
                link.targetItemId,
                link.alias ?? link.targetTitle,
              ),
            },
          ]
        : [],
    ),
  );
}

export function wikiReaderMarkdown(content: string, outgoing: ReadonlyArray<LinkEvidence>) {
  const occurrences = wikiOccurrences(content, outgoing);
  const markdown = replaceOccurrences(
    content,
    occurrences.map((link, index) => {
      const label = (link.alias ?? link.targetTitle).replace(
        /[\\[\]\\`*_<>~&]/g,
        (char) => "&#" + char.charCodeAt(0) + ";",
      );
      return { ...link, replacement: "[" + label + "](#wiki-ref-" + index + ")" };
    }),
  );
  return { markdown, occurrences };
}

export function completionAt(content: string, caret: number) {
  const prefix = content.slice(0, caret);
  const match = /\[\[([^[\]\n|]*)$/.exec(prefix);
  if (!match) return null;
  const tail = /^[^[\]\n]*\]\]/.exec(content.slice(caret));
  return { start: match.index, end: caret + (tail?.[0].length ?? 0), query: match[1] ?? "" };
}
