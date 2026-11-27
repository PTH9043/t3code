/** Offsets use JavaScript string indices and cover both pairs of brackets. */
export interface ParsedWorkspaceWikiLink {
  start: number;
  end: number;
  targetTitle: string;
  targetStart: number;
  targetEnd: number;
  explicitItemId: string | null;
  alias: string | null;
  context: string;
}

function escapedAt(text: string, index: number) {
  let start = index;
  while (start > 0 && text[start - 1] === "\\") start--;
  return (index - start) % 2 === 1;
}

export function formatWorkspaceWikiIdLink(itemId: string, label: string) {
  const escaped = label.replace(/[\\\][|]/gu, "\\$&").replace(/[\r\n]+/gu, " ");
  return "[[id:" + encodeURIComponent(itemId) + "|" + escaped + "]]";
}

const unescapeLabel = (text: string) => text.replace(/\\([\\\][|])/gu, "$1");

function readParagraph(text: string, base: number, result: ParsedWorkspaceWikiLink[]) {
  if (!text.includes("[[")) return;
  const runs = [...text.matchAll(/`+/gu)];
  const nextRun = new Map<number, number>();
  const codeEnds = new Map<number, number>();
  for (let n = runs.length - 1; n >= 0; n--) {
    const run = runs[n]!;
    const close = nextRun.get(run[0].length);
    if (close !== undefined) codeEnds.set(run.index, close + run[0].length);
    nextRun.set(run[0].length, run.index);
  }
  const tokens = /`+|\[\[/gu;
  const link = /\[\[((?:\\[^\r\n]|[^|[\]\\\r\n])+)(?:\|((?:\\[^\r\n]|[^[\]\\\r\n])*))?\]\]/uy;
  for (let token; (token = tokens.exec(text)); ) {
    const start = token.index;
    if (escapedAt(text, start)) continue;
    if (token[0][0] === "`") {
      tokens.lastIndex = codeEnds.get(start) ?? tokens.lastIndex;
      continue;
    }
    link.lastIndex = start;
    const match = link.exec(text);
    if (!match) continue;
    const rawTarget = match[1]!;
    const targetTitle = unescapeLabel(rawTarget).trim();
    if (!targetTitle) continue;
    const alias = match[2] === undefined ? null : unescapeLabel(match[2]);
    let explicitItemId: string | null = null;
    if (targetTitle.startsWith("id:")) {
      try {
        explicitItemId = decodeURIComponent(targetTitle.slice(3));
      } catch {
        continue;
      }
      if (!explicitItemId) continue;
    }
    const end = link.lastIndex;
    const before = text.slice(Math.max(0, start - 100), start);
    const after = text.slice(end, end + 100);
    const lineStart = start - (before.length - before.lastIndexOf("\n") - 1);
    const nextLine = after.indexOf("\n");
    result.push({
      start: base + start,
      end: base + end,
      targetTitle,
      explicitItemId,
      alias,
      targetStart: base + start + 2 + rawTarget.length - rawTarget.trimStart().length,
      targetEnd: base + start + 2 + rawTarget.trimEnd().length,
      context: text.slice(lineStart, end + (nextLine < 0 ? after.length : nextLine)).trim(),
    });
    tokens.lastIndex = end;
  }
}

export function parseWorkspaceWikiLinks(content: string): ParsedWorkspaceWikiLink[] {
  const result: ParsedWorkspaceWikiLink[] = [];
  if (!content.includes("[[")) return result;
  let fence: string | null = null;
  let fenceQuoteDepth = 0;
  let paragraph = 0;
  for (const line of content.matchAll(/[^\r\n]*(?:\r\n|[\r\n])|[^\r\n]+$/gu)) {
    const raw = line[0].replace(/[\r\n]+$/u, "");
    const quotePrefix = /^(?: {0,3}>[ \t]?)+/u.exec(raw)?.[0] ?? "";
    const quoteDepth = quotePrefix.split(">").length - 1;
    const body = raw.slice(quotePrefix.length);
    if (fence && quoteDepth < fenceQuoteDepth) fence = null;
    const marker = /^(?: {0,3}(?:[-+*]|\d+[.)])[ \t]+)?[ \t]*(`{3,}|~{3,})(.*)$/u.exec(body);
    if (fence !== null) {
      if (
        marker &&
        quoteDepth === fenceQuoteDepth &&
        body.trimStart().startsWith(fence) &&
        marker[1]![0] === fence[0] &&
        marker[1]!.length >= fence.length &&
        !marker[2]!.trim()
      )
        fence = null;
      paragraph = line.index + line[0].length;
    } else if ((marker && (marker[1]![0] !== "`" || !marker[2]!.includes("`"))) || !body.trim()) {
      readParagraph(content.slice(paragraph, line.index), paragraph, result);
      fence = marker?.[1] ?? null;
      fenceQuoteDepth = quoteDepth;
      paragraph = line.index + line[0].length;
    }
  }
  if (!fence) readParagraph(content.slice(paragraph), paragraph, result);
  return result;
}
