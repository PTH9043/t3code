import type { VisemeWeights } from "@t3tools/contracts";

const FENCE_OPEN_RE = /^\s*(`{3,}|~{3,})/;
const TABLE_ROW_RE = /^\s*\|.*\|\s*$/;
const TABLE_DIVIDER_RE = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/;
const HORIZONTAL_RULE_RE = /^\s*(?:[-*_]\s*){3,}$/;
const HEADING_PREFIX_RE = /^\s*#{1,6}\s+/;
const ADVICE_HEADING_RE = /^\s*#{1,6}\s*\[?\s*(?:비서실장의\s*조언|조언)\s*\]?\s*$/u;
const STRUCTURAL_HEADING_ONLY_RE = /^\s*#{1,6}\s*\[[^\]]+\]\s*$/;
const SQL_STATEMENT_LINE_RE =
  /^\s*(?:SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM|CREATE\s+TABLE|ALTER\s+TABLE|DROP\s+TABLE|WITH\s+\w+\s+AS|PRAGMA)\b/iu;
const QUESTION_CARD_JSON_START_RE = /^\s*\{\s*"questions"\s*:/;
const URL_RE = /\b(?:https?|file|ws|wss):\/\/[^\s<>()]+/giu;
const MD_LINK_RE = /\[([^\]]+)\]\((?:[^)\s]+(?:\s+"[^"]*")?)\)/gu;
const MD_IMAGE_RE = /!\[[^\]]*\]\([^)]*\)/gu;
const INLINE_CODE_RE = /`[^`]*`/gu;
const HTML_COMMENT_RE = /<!--[\s\S]*?-->/gu;
const WINDOWS_PATH_RE = /\b[A-Za-z]:\\[^\s,;:()[\]{}"']+/gu;
const POSIX_OR_REPO_PATH_RE =
  /(?:^|[\s(])(?:\.{0,2}\/|apps\/|packages\/|scripts\/|docs\/|src\/|\/(?:usr|etc|var|home|opt|tmp)\/)[A-Za-z0-9._@\-/\\]+(?:#L\d+(?:-L?\d+)?)?/gu;
const FILENAME_WITH_EXT_RE =
  /\b[A-Za-z0-9_.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|sql|sqlite|py|md|css|html|yaml|yml|toml|sh|cmd|vbs|log|ndjson|vrm|vrma|livliv)\b(?:#L\d+(?:-L?\d+)?)?/giu;
const ARRAY_INDEX_RE = /\b[A-Za-z_$][A-Za-z0-9_$.]*\[[^\]\n]{1,32}\]/gu;
const IDENTIFIER_CALL_RE =
  /\b[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*){1,}\([^)\n]{0,48}\)/gu;
const INLINE_EMOTION_TAG_RE = /\[(?:joy|anger|sad|happy|neutral|surprised|fear|disgust)\]/giu;
const MARKDOWN_DECORATION_RE = /[*_~>#]+/gu;
const LIST_BULLET_RE = /^\s*(?:[-*+•]|\d+[.)])\s+/;

/**
 * Strips code constructs, file paths, array indexes (`items[0]`), Markdown tables,
 * and URLs from a single non-fenced line so TTS only reads natural prose aloud.
 */
export function sanitizeLineForSpeech(rawLine: string): string {
  const trimmed = rawLine.trim();
  if (!trimmed) return "";
  if (HORIZONTAL_RULE_RE.test(trimmed)) return "";
  if (TABLE_DIVIDER_RE.test(trimmed) || TABLE_ROW_RE.test(trimmed)) return "";
  if (SQL_STATEMENT_LINE_RE.test(trimmed)) return "";
  if (QUESTION_CARD_JSON_START_RE.test(trimmed)) return "";

  if (ADVICE_HEADING_RE.test(trimmed)) {
    // Closing advice header is kept silent; its body sentence is spoken cleanly.
    return "";
  }
  if (STRUCTURAL_HEADING_ONLY_RE.test(trimmed)) {
    return "";
  }

  let line = trimmed
    .replace(HTML_COMMENT_RE, " ")
    .replace(MD_IMAGE_RE, " ")
    // Preserve human label inside markdown link `[label](url)` unless the label itself is a code/file path.
    .replace(MD_LINK_RE, (_match, label: string) => ` ${label} `)
    .replace(INLINE_CODE_RE, " ")
    .replace(URL_RE, " ")
    .replace(WINDOWS_PATH_RE, " ")
    .replace(POSIX_OR_REPO_PATH_RE, " ")
    .replace(FILENAME_WITH_EXT_RE, " ")
    .replace(ARRAY_INDEX_RE, " ")
    .replace(IDENTIFIER_CALL_RE, " ")
    .replace(INLINE_EMOTION_TAG_RE, " ")
    .replace(HEADING_PREFIX_RE, "")
    .replace(LIST_BULLET_RE, "")
    .replace(MARKDOWN_DECORATION_RE, "")
    .replace(/\(\s*\)/g, "")
    .replace(/\[\s*\]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  // Drop residual bracket-only or symbol-only fragments (e.g. `{`, `}`, `;`, `=>`).
  if (!/[가-힣A-Za-z0-9]/u.test(line)) return "";
  if (/^[\[\]{}();:=<>.,/\\|+\-*&^%$#@!~`'"\s]+$/u.test(line)) return "";

  // Clean dangling punctuation caused by removed inline code (e.g., "에서 를" or ":, .").
  line = line
    .replace(/\s+([.,!?;:])/g, "$1")
    .replace(/([.,!?;:])\1+/g, "$1")
    .trim();
  return line;
}

const SENTENCE_BOUNDARY_RE = /(?<=[.?!。？！—])\s+|\n+/u;

/**
 * Incremental streaming sanitizer that consumes arbitrary token deltas from
 * Claude / Gemini / Codex, drops code fences, SQL, tables, file paths, URLs,
 * and array index tokens in flight, and emits clean Korean breath-sized speech chunks.
 */
export class SpeechSanitizerStream {
  private lineBuffer = "";
  private activeFenceChar: "`" | "~" | null = null;
  private activeFenceLen = 0;
  private inJsonQuestionCard = false;
  private jsonBraceDepth = 0;
  private speechBuffer = "";
  private readonly maxChunkChars: number;

  constructor(options?: { readonly maxChunkChars?: number }) {
    this.maxChunkChars = options?.maxChunkChars ?? 160;
  }

  /** Feeds a streaming delta and returns any complete breath-unit speech chunks ready for TTS. */
  push(delta: string): string[] {
    if (!delta) return [];
    this.lineBuffer += delta;
    const emitted: string[] = [];

    let newlineIndex = this.lineBuffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = this.lineBuffer.slice(0, newlineIndex).replace(/\r$/u, "");
      this.lineBuffer = this.lineBuffer.slice(newlineIndex + 1);
      this.processCompletedLine(line, emitted);
      newlineIndex = this.lineBuffer.indexOf("\n");
    }

    return emitted;
  }

  /** Flushes any remaining buffered tail at end-of-stream. */
  flush(): string[] {
    const emitted: string[] = [];
    if (this.lineBuffer.length > 0) {
      const remaining = this.lineBuffer.replace(/\r$/u, "");
      this.lineBuffer = "";
      this.processCompletedLine(remaining, emitted);
    }
    const tail = this.speechBuffer.trim();
    this.speechBuffer = "";
    if (tail) {
      emitted.push(...this.splitOversizedChunk(tail));
    }
    return emitted;
  }

  reset(): void {
    this.lineBuffer = "";
    this.activeFenceChar = null;
    this.activeFenceLen = 0;
    this.inJsonQuestionCard = false;
    this.jsonBraceDepth = 0;
    this.speechBuffer = "";
  }

  private processCompletedLine(line: string, emitted: string[]): void {
    const trimmed = line.trim();

    // 1. Track fenced code blocks (``` or ~~~), including Antigravity trailing suffix tokens like ```Ble.
    const fenceMatch = FENCE_OPEN_RE.exec(trimmed);
    if (this.activeFenceChar !== null) {
      if (
        fenceMatch?.[1] &&
        fenceMatch[1][0] === this.activeFenceChar &&
        fenceMatch[1].length >= this.activeFenceLen &&
        /^[`~]+[A-Za-z0-9._-]{0,16}$/u.test(trimmed)
      ) {
        this.activeFenceChar = null;
        this.activeFenceLen = 0;
      }
      return;
    }
    if (fenceMatch?.[1]) {
      this.activeFenceChar = fenceMatch[1][0] as "`" | "~";
      this.activeFenceLen = fenceMatch[1].length;
      this.flushSpeechBuffer(emitted);
      return;
    }

    // 2. Track bare trailing JSON question card block (`{"questions": [...]}`)
    if (!this.inJsonQuestionCard && QUESTION_CARD_JSON_START_RE.test(trimmed)) {
      this.inJsonQuestionCard = true;
      this.jsonBraceDepth = 0;
    }
    if (this.inJsonQuestionCard) {
      for (const ch of line) {
        if (ch === "{") this.jsonBraceDepth += 1;
        else if (ch === "}") this.jsonBraceDepth -= 1;
      }
      if (this.jsonBraceDepth <= 0) {
        this.inJsonQuestionCard = false;
      }
      return;
    }

    // 3. Sanitize regular prose line
    const clean = sanitizeLineForSpeech(line);
    if (!clean) {
      // Blank line / stripped code block acts as a natural breath boundary.
      this.flushSpeechBuffer(emitted);
      return;
    }

    this.speechBuffer = this.speechBuffer ? `${this.speechBuffer} ${clean}` : clean;
    this.extractReadyBreathChunks(emitted);
  }

  private extractReadyBreathChunks(emitted: string[]): void {
    const parts = this.speechBuffer.split(SENTENCE_BOUNDARY_RE);
    if (parts.length <= 1) {
      if (this.speechBuffer.length >= this.maxChunkChars) {
        this.flushSpeechBuffer(emitted);
      }
      return;
    }
    // Emit all finished sentences; keep trailing partial fragment for the next delta.
    const trailing = parts.pop() ?? "";
    for (const part of parts) {
      const cleaned = part.trim();
      if (cleaned) {
        emitted.push(...this.splitOversizedChunk(cleaned));
      }
    }
    this.speechBuffer = trailing;
  }

  private flushSpeechBuffer(emitted: string[]): void {
    const text = this.speechBuffer.trim();
    this.speechBuffer = "";
    if (text) {
      emitted.push(...this.splitOversizedChunk(text));
    }
  }

  private splitOversizedChunk(text: string): string[] {
    if (text.length <= this.maxChunkChars) return [text];
    const chunks: string[] = [];
    let current = "";
    for (const word of text.split(/\s+/u)) {
      if (current && current.length + 1 + word.length > this.maxChunkChars) {
        chunks.push(current);
        current = word;
      } else {
        current = current ? `${current} ${word}` : word;
      }
    }
    if (current) chunks.push(current);
    return chunks;
  }
}

/** Convenience single-pass helper for completed replies. */
export function sanitizeTextForSpeech(text: string, maxChunkChars = 160): string[] {
  const stream = new SpeechSanitizerStream({ maxChunkChars });
  const out = stream.push(text);
  out.push(...stream.flush());
  return out;
}

// Hangul medial vowel index (0..20) -> dominant 5-vowel viseme bucket
// 0:ㅏ 1:ㅐ 2:ㅑ 3:ㅒ 4:ㅓ 5:ㅔ 6:ㅕ 7:ㅖ 8:ㅗ 9:ㅘ 10:ㅙ 11:ㅚ 12:ㅛ 13:ㅜ 14:ㅝ 15:ㅞ 16:ㅟ 17:ㅠ 18:ㅡ 19:ㅢ 20:ㅣ
const HANGUL_MEDIAL_TO_VISEME: ReadonlyArray<keyof Omit<VisemeWeights, "silence">> = [
  "a", // ㅏ
  "e", // ㅐ
  "a", // ㅑ
  "e", // ㅒ
  "o", // ㅓ
  "e", // ㅔ
  "o", // ㅕ
  "e", // ㅖ
  "o", // ㅗ
  "a", // ㅘ
  "e", // ㅙ
  "e", // ㅚ
  "o", // ㅛ
  "u", // ㅜ
  "o", // ㅝ
  "e", // ㅞ
  "i", // ㅟ
  "u", // ㅠ
  "u", // ㅡ
  "i", // ㅢ
  "i", // ㅣ
];

/**
 * Maps a Korean syllable or ASCII vowel to a 5-vowel `VisemeWeights` snapshot
 * for deterministic lip-sync during `window.speechSynthesis` fallback playback.
 */
export function charToVisemeWeights(ch: string): VisemeWeights {
  if (!ch || /[\s.,!?;:\-—()[\]]/u.test(ch)) {
    return { a: 0, i: 0, u: 0, e: 0, o: 0, silence: 1 };
  }
  const code = ch.charCodeAt(0);
  let bucket: keyof Omit<VisemeWeights, "silence"> | null = null;
  if (code >= 0xac00 && code <= 0xd7a3) {
    const medialIndex = Math.floor(((code - 0xac00) % 588) / 28);
    bucket = HANGUL_MEDIAL_TO_VISEME[medialIndex] ?? "a";
  } else {
    const low = ch.toLowerCase();
    if (low === "a") bucket = "a";
    else if (low === "i" || low === "y") bucket = "i";
    else if (low === "u" || low === "w") bucket = "u";
    else if (low === "e") bucket = "e";
    else if (low === "o") bucket = "o";
    else if (/[a-z0-9]/u.test(low)) bucket = "e";
  }
  if (!bucket) {
    return { a: 0, i: 0, u: 0, e: 0, o: 0, silence: 1 };
  }
  return {
    a: bucket === "a" ? 0.85 : 0,
    i: bucket === "i" ? 0.8 : 0,
    u: bucket === "u" ? 0.8 : 0,
    e: bucket === "e" ? 0.78 : 0,
    o: bucket === "o" ? 0.82 : 0,
    silence: 0.15,
  };
}
