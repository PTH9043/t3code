/**
 * Text analysis for the FTS5 search indexes — the Workspace RAG and the shared
 * design library.
 *
 * SQLite's `unicode61` tokenizer only splits on spaces and punctuation, so a
 * Korean word keeps its particle attached: "수익률을" is one token, and a
 * search for "수익" never reaches it. On the live __OnChainBot corpus
 * (2026-09-11) that hid 7–71% of the chunks that really contained a term.
 * FTS5's trigram tokenizer is no cure either: it cannot MATCH terms shorter
 * than three characters, and most Korean nouns are two syllables.
 *
 * So text in bigram scripts (Hangul, Han, kana) is indexed as overlapping
 * two-character tokens, and a query term becomes the phrase of its bigrams —
 * "수익률" searches `"수익 익률"`, which matches wherever that substring
 * occurs. Query words lose a trailing particle or verb ending first, so
 * "대시보드를" looks for "대시보드". Latin words index as themselves and query
 * as prefixes, so "card" also finds "cards".
 */

const BIGRAM_SCRIPT = /[\p{Script=Hangul}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
const HANGUL = /\p{Script=Hangul}/u;
const WORD = /[a-z]{1,8}-\d{1,8}(?:-[a-z0-9]+)?|[\p{L}\p{N}]+/giu;
const DIGITS = /^\p{N}+$/u;
const HYPHEN_CODE_TERM = /^[a-z]{1,8}-\d{1,8}(?:-[a-z0-9]+)?$/iu;
const KOREAN_CLAUSE_PREFIX = /^(제\d+(?:조(?:의\d+)?|항|호|장|절))(.*)$/u;
const KOREAN_CLAUSE_TERM = /^제\d+(?:조(?:의\d+)?|항|호|장|절)$/u;

const normalize = (text: string): string => text.normalize("NFKC").toLowerCase();

interface Run {
  readonly bigram: boolean;
  readonly text: string;
}

/** Split a word into maximal runs of bigram-script and other characters. */
function splitRuns(word: string): ReadonlyArray<Run> {
  if (HYPHEN_CODE_TERM.test(word)) {
    return [{ bigram: false, text: word }];
  }
  const clauseMatch = KOREAN_CLAUSE_PREFIX.exec(word);
  if (clauseMatch) {
    const [, clause, rest] = clauseMatch;
    if (clause && (!rest || KOREAN_SUFFIXES.includes(rest))) {
      return [{ bigram: false, text: clause }];
    }
  }
  const runs: Run[] = [];
  let current = "";
  let currentBigram = false;
  for (const char of word) {
    const bigram = BIGRAM_SCRIPT.test(char);
    if (current.length > 0 && bigram !== currentBigram) {
      runs.push({ bigram: currentBigram, text: current });
      current = "";
    }
    current += char;
    currentBigram = bigram;
  }
  if (current.length > 0) runs.push({ bigram: currentBigram, text: current });
  return runs;
}

function bigramsOf(run: string): ReadonlyArray<string> {
  const chars = Array.from(run);
  if (chars.length <= 1) return chars;
  const grams: string[] = [];
  for (let index = 0; index < chars.length - 1; index++) {
    grams.push(`${chars[index]}${chars[index + 1]}`);
  }
  return grams;
}

/** The token stream stored in an analyzed FTS column. */
export function analyzeSearchText(text: string): string {
  const tokens: string[] = [];
  for (const word of normalize(text).match(WORD) ?? []) {
    if (HYPHEN_CODE_TERM.test(word)) {
      tokens.push(...word.split("-"));
      continue;
    }
    for (const run of splitRuns(word)) {
      if (run.bigram) tokens.push(...bigramsOf(run.text));
      else tokens.push(run.text);
    }
  }
  return tokens.join(" ");
}

/**
 * Trailing particles and verb endings dropped from Korean query words, longest
 * first. A strip only applies when at least two syllables remain, so nouns
 * that merely end in one of these ("결과", "추가", "회의") stay whole.
 */
const KOREAN_SUFFIXES: ReadonlyArray<string> = [
  "해주세요",
  "했습니다",
  "으로부터",
  "에서부터",
  "해줘요",
  "합니다",
  "이라는",
  "이라고",
  "에게서",
  "해줘",
  "했다",
  "하다",
  "하는",
  "하게",
  "하기",
  "해서",
  "하면",
  "되는",
  "되게",
  "까지",
  "부터",
  "에서",
  "에게",
  "한테",
  "으로",
  "처럼",
  "보다",
  "이나",
  "이랑",
  "하고",
  "에는",
  "에도",
  "라는",
  "라고",
  "한",
  "할",
  "된",
  "은",
  "는",
  "이",
  "가",
  "을",
  "를",
  "의",
  "에",
  "로",
  "와",
  "과",
  "도",
  "만",
  "나",
  "랑",
].toSorted((left, right) => right.length - left.length);

function stripKoreanSuffix(term: string): string {
  for (const suffix of KOREAN_SUFFIXES) {
    if (!term.endsWith(suffix)) continue;
    const stem = term.slice(0, term.length - suffix.length);
    if (Array.from(stem).length >= 2) return stem;
  }
  return term;
}

/**
 * Words that carry no retrieval signal: English function words, and Korean
 * connectives plus the task-talk every request contains ("작업", "확인",
 * "해줘"), which would otherwise match nearly every stored note.
 */
const STOPWORDS: ReadonlySet<string> = new Set([
  "a",
  "an",
  "the",
  "and",
  "or",
  "but",
  "of",
  "to",
  "in",
  "on",
  "for",
  "with",
  "at",
  "by",
  "from",
  "as",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "it",
  "its",
  "this",
  "that",
  "these",
  "those",
  "you",
  "we",
  "they",
  "he",
  "she",
  "my",
  "your",
  "our",
  "their",
  "can",
  "could",
  "should",
  "would",
  "will",
  "please",
  "into",
  "about",
  "than",
  "then",
  "so",
  "not",
  "no",
  "do",
  "does",
  "did",
  "have",
  "has",
  "had",
  "how",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "그리고",
  "그러나",
  "하지만",
  "그래서",
  "또는",
  "및",
  "등",
  "이것",
  "저것",
  "그것",
  "여기",
  "저기",
  "거기",
  "우리",
  "저희",
  "이번",
  "해당",
  "관련",
  "위해",
  "위한",
  "대한",
  "대해",
  "통해",
  "통한",
  "있는",
  "없는",
  "있다",
  "없다",
  "같은",
  "다른",
  "모든",
  "어떤",
  "무엇",
  "어떻게",
  "정도",
  "경우",
  "부분",
  "작업",
  "진행",
  "확인",
  "요청",
  "내용",
  "방법",
  "부탁",
  "해줘",
  "해주세요",
  "주세요",
  "그냥",
  "먼저",
  "다음",
  "이후",
  "현재",
  "지금",
]);

export interface SearchQuery {
  /** FTS5 MATCH expression over the analyzed columns. */
  readonly match: string;
  /** The normalized query terms, for coverage re-ranking and highlighting. */
  readonly terms: ReadonlyArray<string>;
}

export const MAX_QUERY_TERMS = 16;

function termClause(term: string): string {
  if (HYPHEN_CODE_TERM.test(term)) {
    return `"${term.split("-").join(" ")}"`;
  }
  if (KOREAN_CLAUSE_TERM.test(term)) {
    return `"${term}"`;
  }
  const chars = Array.from(term);
  if (BIGRAM_SCRIPT.test(chars[0] ?? "")) {
    // A lone syllable is only ever the head of an indexed bigram.
    return chars.length === 1 ? `"${term}"*` : `"${bigramsOf(term).join(" ")}"`;
  }
  return term.length >= 3 && !DIGITS.test(term) ? `"${term}"*` : `"${term}"`;
}

function isPriorityIdentifierTerm(term: string): boolean {
  return HYPHEN_CODE_TERM.test(term) || KOREAN_CLAUSE_TERM.test(term);
}

function collectQueryTerms(text: string, maxTerms: number): ReadonlyArray<string> {
  const allTerms: string[] = [];
  const seen = new Set<string>();
  const normalizedText = normalize(text).replace(
    /제\s+(\d+)\s+(조(?:\s*의\s*\d+)?|항|호|장|절)/gu,
    (_m, num: string, unit: string) => `제${num}${unit.replace(/\s+/gu, "")}`,
  );
  for (const word of normalizedText.match(WORD) ?? []) {
    for (const run of splitRuns(word)) {
      const term = run.bigram && HANGUL.test(run.text) ? stripKoreanSuffix(run.text) : run.text;
      if (STOPWORDS.has(term)) continue;
      if (!run.bigram && term.length < 2 && !DIGITS.test(term)) continue;
      if (seen.has(term)) continue;
      seen.add(term);
      allTerms.push(term);
    }
  }
  if (allTerms.length <= maxTerms) return allTerms;
  const kept = allTerms.slice(0, maxTerms);
  const overflowPriority = allTerms.slice(maxTerms).filter(isPriorityIdentifierTerm);
  for (const priorityTerm of overflowPriority) {
    let replaceIndex = -1;
    for (let i = kept.length - 1; i >= 0; i--) {
      if (!isPriorityIdentifierTerm(kept[i]!)) {
        replaceIndex = i;
        break;
      }
    }
    if (replaceIndex < 0) break;
    kept[replaceIndex] = priorityTerm;
  }
  return kept;
}

/**
 * Turn free text — often a whole task description — into an OR query over its
 * distinct meaningful terms. Every term is quoted, so nothing in the text can
 * inject FTS5 syntax.
 */
export function buildSearchQuery(
  text: string,
  maxTerms: number = MAX_QUERY_TERMS,
): SearchQuery | null {
  const terms = collectQueryTerms(text, maxTerms);
  if (terms.length === 0) return null;
  return { match: terms.map(termClause).join(" OR "), terms };
}

/**
 * How many distinct query terms occur in the text. BM25 alone happily ranks a
 * chunk that repeats one term above one that answers the whole question; this
 * is the re-ranking signal that favours covering more of it.
 */
export function termCoverage(terms: ReadonlyArray<string>, text: string): number {
  const haystack = normalize(text).replace(
    /제\s+(\d+)\s+(조(?:\s*의\s*\d+)?|항|호|장|절)/gu,
    (_m, num: string, unit: string) => `제${num}${unit.replace(/\s+/gu, "")}`,
  );
  let covered = 0;
  for (const term of terms) {
    if (haystack.includes(term)) covered += 1;
  }
  return covered;
}

/**
 * Cross-interaction (late-interaction) query-document pair scoring for Stage-2
 * reranking: evaluates exact identifier/clause alignment, term coverage ratio,
 * minimum window token proximity,ordered bigram adjacency, and heading matches.
 */
export function scoreQueryDocumentInteraction(input: {
  readonly query: string;
  readonly terms: ReadonlyArray<string>;
  readonly title: string;
  readonly tagsText?: string;
  readonly content: string;
}): number {
  const { query, terms, title, tagsText = "", content } = input;
  if (terms.length === 0) return 0;
  const normTitle = normalize(title);
  const normTags = normalize(tagsText);
  const normContent = normalize(content).replace(
    /제\s+(\d+)\s+(조(?:\s*의\s*\d+)?|항|호|장|절)/gu,
    (_m, num: string, unit: string) => `제${num}${unit.replace(/\s+/gu, "")}`,
  );
  const fullText = `${normTitle} ${normTags} ${normContent}`;

  // 1. Exact identifier / error code / Korean clause number match
  const normQuery = normalize(query).replace(
    /제\s+(\d+)\s+(조(?:\s*의\s*\d+)?|항|호|장|절)/gu,
    (_m, num: string, unit: string) => `제${num}${unit.replace(/\s+/gu, "")}`,
  );
  const queryCodes = [
    ...(normQuery.match(/\b[a-z]{1,8}-\d{1,8}(?:-[a-z0-9]+)?\b/gu) ?? []),
    ...(normQuery.match(/제\d+(?:조(?:의\d+)?|항|호|장|절)/gu) ?? []),
  ];
  let exactCodeScore = 0;
  if (queryCodes.length > 0) {
    let matchedCodes = 0;
    for (const code of queryCodes) {
      if (fullText.includes(code)) matchedCodes++;
    }
    exactCodeScore = matchedCodes / queryCodes.length;
  }

  // 2. Term coverage ratio & heading/title alignment
  const positions: number[] = [];
  let coveredCount = 0;
  let headingHits = 0;
  const headingZone = `${normTitle}\n${normContent.split("\n").slice(0, 3).join("\n")}`;
  for (const term of terms) {
    if (fullText.includes(term)) {
      coveredCount++;
      const pos = normContent.indexOf(term);
      if (pos >= 0) positions.push(pos);
    }
    if (headingZone.includes(term)) {
      headingHits++;
    }
  }
  if (coveredCount === 0 && exactCodeScore === 0) return 0;
  const coverageRatio = coveredCount / terms.length;
  const headingRatio = headingHits / terms.length;

  // 3. Ordered pair & proximity window density
  let proximityScore = 0;
  if (positions.length >= 2) {
    let orderedPairs = 0;
    for (let i = 0; i < positions.length - 1; i++) {
      if (positions[i]! <= positions[i + 1]!) orderedPairs++;
    }
    const orderRatio = orderedPairs / (positions.length - 1);
    const sortedPos = positions.toSorted((a, b) => a - b);
    const span = Math.max(1, sortedPos.at(-1)! - sortedPos[0]!);
    const density = Math.min(1, (positions.length * 40) / (span + 40));
    proximityScore = 0.6 * density + 0.4 * orderRatio;
  } else if (positions.length === 1 && terms.length === 1) {
    proximityScore = 1;
  }

  return 0.35 * coverageRatio + 0.35 * exactCodeScore + 0.15 * proximityScore + 0.15 * headingRatio;
}

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/** A short excerpt around the first matched term, matches wrapped in `[ ]`. */
export function makeSnippet(content: string, terms: ReadonlyArray<string>, maxChars = 240): string {
  const flat = content.replace(/\s+/gu, " ").trim();
  const lower = flat.toLowerCase();
  let first = -1;
  for (const term of terms) {
    const at = lower.indexOf(term);
    if (at >= 0 && (first < 0 || at < first)) first = at;
  }
  const start = first < 0 ? 0 : Math.max(0, first - Math.floor(maxChars / 3));
  const end = Math.min(flat.length, start + maxChars);
  let body = flat.slice(start, end);
  if (terms.length > 0) {
    const pattern = new RegExp(
      terms
        .toSorted((left, right) => right.length - left.length)
        .map(escapeRegExp)
        .join("|"),
      "giu",
    );
    body = body.replace(pattern, (hit) => `[${hit}]`);
  }
  return `${start > 0 ? "…" : ""}${body}${end < flat.length ? "…" : ""}`;
}

export const CHUNK_SIZE = 1_200;
export const CHUNK_OVERLAP = 200;

const TABLE_ROW_LINE = /^\s*\|.*\|\s*$/u;
const TABLE_SEPARATOR_LINE = /^\s*\|[\s:|-]+\|\s*$/u;

/** Extract active Markdown table header (header row + separator row) before `offset`. */
function findActiveTableHeader(text: string, offset: number): string {
  if (offset <= 0) return "";
  const firstLineEnd = text.indexOf("\n", offset);
  const firstLine = (
    firstLineEnd < 0 ? text.slice(offset) : text.slice(offset, firstLineEnd)
  ).trim();
  if (!TABLE_ROW_LINE.test(firstLine) || TABLE_SEPARATOR_LINE.test(firstLine)) return "";
  const beforeLines = text.slice(0, offset).trimEnd().split("\n");
  for (let i = beforeLines.length - 1; i >= 1; i--) {
    const line = beforeLines[i]!.trim();
    if (!TABLE_ROW_LINE.test(line)) return "";
    if (TABLE_SEPARATOR_LINE.test(line)) {
      const headerLine = beforeLines[i - 1]!.trim();
      if (TABLE_ROW_LINE.test(headerLine) && !TABLE_SEPARATOR_LINE.test(headerLine)) {
        const candidate = `${headerLine}\n${line}`;
        return candidate.length <= 240 ? candidate : "";
      }
      return "";
    }
  }
  return "";
}

/** Split a paragraph or oversized section without splitting surrogate pairs, preserving Markdown table headers across chunk boundaries. */
function chunkPlainContent(content: string, size = CHUNK_SIZE): ReadonlyArray<string> {
  const normalized = content.replaceAll("\r\n", "\n").trim();
  if (normalized.length === 0) return [];
  if (normalized.length <= size) return [normalized];

  const chunks: string[] = [];
  let start = 0;
  while (start < normalized.length) {
    const tableHeader = start > 0 ? findActiveTableHeader(normalized, start) : "";
    const effectiveSize = tableHeader ? Math.max(200, size - tableHeader.length - 1) : size;
    const hardEnd = Math.min(normalized.length, start + effectiveSize);
    let end = hardEnd;
    if (hardEnd < normalized.length) {
      const halfOffset = Math.floor(effectiveSize / 2);
      const candidate = normalized.slice(start + halfOffset, hardEnd);
      const paragraph = candidate.lastIndexOf("\n\n");
      const newline = candidate.lastIndexOf("\n");
      const space = candidate.lastIndexOf(" ");
      const boundary = paragraph >= 0 ? paragraph + 1 : newline >= 0 ? newline : space;
      if (boundary >= 0) end = start + halfOffset + boundary + 1;
    }
    if (end < normalized.length && /[\uD800-\uDBFF]/u.test(normalized[end - 1] ?? "")) end--;
    const rawSlice = normalized.slice(start, end).trim();
    const chunk =
      tableHeader && rawSlice.length > 0 && !rawSlice.startsWith(tableHeader)
        ? `${tableHeader}\n${rawSlice}`
        : rawSlice;
    if (chunk.length > 0) chunks.push(chunk);
    if (end >= normalized.length) break;
    if (tableHeader || findActiveTableHeader(normalized, end)) {
      start = end;
    } else {
      start = Math.max(start + 1, end - CHUNK_OVERLAP);
    }
    if (/[\uDC00-\uDFFF]/u.test(normalized[start] ?? "")) start++;
  }
  return chunks;
}

/**
 * Keep Markdown sections, Parent-Child heading hierarchies (H1~H6 and Korean
 * clause headers), and Markdown table headers intact before applying bounded overlap.
 */
export function chunkSearchableContent(content: string): ReadonlyArray<string> {
  const normalized = content.replaceAll("\r\n", "\n").trim();
  if (normalized.length <= CHUNK_SIZE) return normalized ? [normalized] : [];
  const sections: { heading: string; ancestorPrefix: string; text: string }[] = [];
  const headingStack: { level: number; text: string }[] = [];
  let heading = "",
    ancestorPrefix = "",
    lines: string[] = [],
    fenced = false;
  for (const line of normalized.split("\n")) {
    if (/^\s*(```|~~~)/u.test(line)) fenced = !fenced;
    const mdMatch = !fenced ? /^(#{1,6})\s+\S/u.exec(line) : null;
    const clauseMatch =
      !fenced && !mdMatch && line.trim().length <= 80
        ? /^제\s*\d+\s*조(?:의\s*\d+)?(?:\s*\([^)]*\))?(?:\s+\S.*)?$/u.exec(line.trim())
        : null;
    if (mdMatch || clauseMatch) {
      if (lines.length) sections.push({ heading, ancestorPrefix, text: lines.join("\n") });
      const level = mdMatch ? mdMatch[1]!.length : 7;
      while (headingStack.length > 0 && headingStack.at(-1)!.level >= level) {
        headingStack.pop();
      }
      headingStack.push({ level, text: line.trim() });
      heading = line;
      ancestorPrefix =
        headingStack.length > 1
          ? headingStack
              .slice(0, -1)
              .map((entry) => entry.text)
              .join(" > ")
              .slice(0, 120)
          : "";
      lines = [];
    }
    lines.push(line);
  }
  if (lines.length) sections.push({ heading, ancestorPrefix, text: lines.join("\n") });
  return sections.flatMap((section) => {
    const continuationPrefix = (
      section.ancestorPrefix ? `${section.ancestorPrefix}\n${section.heading}` : section.heading
    ).slice(0, 160);
    const firstChunkPrefix = section.ancestorPrefix;
    if (!continuationPrefix) return chunkPlainContent(section.text);
    const maxPrefixLen = Math.max(continuationPrefix.length, firstChunkPrefix.length);
    const chunks = chunkPlainContent(section.text, CHUNK_SIZE - maxPrefixLen - 1);
    return chunks.map((chunk, index) => {
      if (index === 0) {
        return firstChunkPrefix && !chunk.startsWith(firstChunkPrefix)
          ? `${firstChunkPrefix}\n${chunk}`
          : chunk;
      }
      return `${continuationPrefix}\n${chunk}`;
    });
  });
}

/** Bookkeeping tags ("original-chars-812") that would only add noise tokens. */
const BOOKKEEPING_TAG = /-chars-\d+$/u;

export function searchableTags(tags: ReadonlyArray<string>): ReadonlyArray<string> {
  return tags.filter((tag) => !BOOKKEEPING_TAG.test(tag));
}

export interface AnalyzedChunk {
  readonly chunkIndex: number;
  readonly content: string;
  readonly tagsText: string;
  readonly searchTitle: string;
  readonly searchTags: string;
  readonly searchBody: string;
}

/** Every row a knowledge item contributes to the RAG index (Contextual BM25 + hierarchical chunks). */
export function analyzeChunks(input: {
  readonly chunks?: ReadonlyArray<string>;
  readonly title: string;
  readonly content: string;
  readonly tags: ReadonlyArray<string>;
  readonly contextSummary?: string;
}): ReadonlyArray<AnalyzedChunk> {
  const tags = searchableTags(input.tags);
  const tagsText = tags.join(" ");
  const searchTitle = analyzeSearchText(input.title);
  const searchTags = analyzeSearchText(tagsText);
  const contextTokens = input.contextSummary ? analyzeSearchText(input.contextSummary) : "";
  return (input.chunks ?? chunkSearchableContent(input.content)).map((content, chunkIndex) => {
    const bodyTokens = analyzeSearchText(content);
    return {
      chunkIndex,
      content,
      tagsText,
      searchTitle,
      searchTags,
      searchBody: contextTokens ? `${contextTokens} ${bodyTokens}` : bodyTokens,
    };
  });
}
