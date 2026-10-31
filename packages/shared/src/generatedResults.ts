export const GENERATED_RESULT_MAX_BYTES = 64 * 1024 * 1024;
export const GENERATED_TEXT_PREVIEW_BYTES = 64 * 1024;
export const GENERATED_TEXT_VISIBLE_CHARS = 20_000;

const IMAGE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  avif: "image/avif",
  svg: "image/svg+xml",
};
const TEXT_TYPES: Record<string, string> = {
  txt: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
  json: "application/json",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  ts: "text/plain",
  tsx: "text/plain",
  js: "text/plain",
  jsx: "text/plain",
  py: "text/plain",
  css: "text/plain",
  html: "text/plain",
  htm: "text/plain",
  yaml: "text/plain",
  yml: "text/plain",
  sql: "text/plain",
  sh: "text/plain",
  cmd: "text/plain",
  rs: "text/plain",
  go: "text/plain",
  xml: "text/plain",
};

export function resultFileType(fileName: string) {
  const extension = /\.([a-z0-9]+)$/i.exec(fileName)?.[1]?.toLowerCase();
  if (!extension) return null;
  const imageMime = IMAGE_TYPES[extension];
  if (imageMime) return { kind: "image" as const, mimeType: imageMime };
  const textMime = TEXT_TYPES[extension];
  if (!textMime) return null;
  return { kind: "text" as const, mimeType: textMime, language: extension };
}

export function resultPathKey(value: string): string {
  let path = value.trim().replace(/^<|>$/g, "");
  if (/^file:/i.test(path)) {
    try {
      const url = new URL(path);
      if (url.hostname && url.hostname !== "localhost") return "";
      path = url.pathname.replace(/^\/([a-z]:\/)/i, "$1");
    } catch {
      return "";
    }
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(path) && !/^[a-z]:[\\/]/i.test(path)) {
    return "";
  }
  try {
    path = decodeURIComponent(path);
  } catch {
    /* Keep literal percent signs in file names. */
  }
  path = path.replaceAll("\\", "/");
  return /^[a-z]:\//i.test(path) ? path.toLowerCase() : path;
}

export function extractResultFileLinks(markdown: string) {
  // Code examples are instructions, not delivered files.
  const body = markdown
    .replace(/(^|\n) {0,3}(\x60{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n {0,3}\2[^\n]*(?=\n|$)|$)/g, "\n")
    .replace(/\x60+[^\n]*?\x60+/g, "");
  const definitions = new Map<string, string>();
  const normalizeLabel = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();
  for (const match of body.matchAll(/^ {0,3}\[([^\]\n]+)\]:\s*(<[^>\n]+>|\S+)/gm)) {
    definitions.set(normalizeLabel(match[1]!), match[2]!);
  }
  const paths = new Set<string>();
  const add = (href: string) => {
    if (/(?:#L\d|:\d+(?::\d+)?$)/i.test(href)) return;
    const path = resultPathKey(href);
    if (path && resultFileType(path)) paths.add(path);
  };
  for (const match of body.matchAll(/!?\[[^\]\n]*\]\((<[^>\n]+>|(?:[^()\n]|\([^()\n]*\))+?)\)/g)) {
    const href = match[1]!.trim();
    add(
      href.startsWith("<") ? href.slice(1, href.indexOf(">")) : href.replace(/\s+["'][^\n]*$/, ""),
    );
  }
  for (const match of body.matchAll(/!?\[([^\]\n]*)\]\[([^\]\n]*)\]/g)) {
    const href = definitions.get(normalizeLabel(match[2] || match[1]!));
    if (href) add(href);
  }
  return [...paths].slice(0, 32);
}

export function resultTextExcerpt(text: string, limit = GENERATED_TEXT_VISIBLE_CHARS): string {
  const end = Math.min(text.length, limit);
  const last = text.charCodeAt(end - 1);
  return text.slice(0, end < text.length && last >= 0xd800 && last <= 0xdbff ? end - 1 : end);
}

export async function readResultText(url: string, signal?: AbortSignal) {
  const response = await fetch(url, { signal: signal ?? null });
  if (!response.ok) throw new Error("텍스트를 읽을 수 없습니다. (" + response.status + ")");
  const text = await response.text();
  return {
    text: text.replace(/^\uFEFF/, ""),
    truncated: response.headers.get("x-t3-preview-truncated") === "true",
    byteLength: Number(
      response.headers.get("x-t3-asset-bytes") ?? response.headers.get("content-length") ?? 0,
    ),
  };
}
