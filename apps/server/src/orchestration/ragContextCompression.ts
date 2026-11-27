/**
 * RAG Token & Compression Optimizer.
 *
 * Works alongside the SQLite disk-resident keyword routing graph (`workspaceRoutingGraph.ts`):
 * 1. Strips low-entropy formatting noise (markdown divider walls, redundant blank lines,
 *    exact duplicate lines) while preserving short clean passages verbatim.
 * 2. Deduplicates near-identical overlapping chunks via lightweight token Jaccard similarity.
 * 3. Demotes lower-ranked RAG hits (#3..N) to 1-line index pointers so the model sees the
 *    index first and only reads full source text on demand ("인덱싱을 보고 가는 것").
 */

import { runNativeSafe } from "../documents/nativeMemoryCore.ts";

const NATIVE_ARENA_BATCH_MIN_DOCS = 32;

const DECORATIVE_DIVIDER_LINE = /^\s*(?:[-=_*~`#]{4,}|[─━═┄┅┈┉]{3,})\s*$/u;

export interface RagCompressOptions {
  readonly maxChars?: number | undefined;
}

/**
 * Compresses a RAG passage without distorting short clean passages.
 * - Removes decorative divider lines and trailing spaces.
 * - Collapses 3+ consecutive newlines to 1 blank line.
 * - Drops exact duplicate lines (>= 14 chars).
 * - Optionally truncates long passages at a sentence/newline boundary.
 */
export function compressRagText(text: string, options?: RagCompressOptions): string {
  if (!text) return "";
  const rawLines = text.split(/\r?\n/u);
  const keptLines: string[] = [];
  const seenLongLines = new Set<string>();
  let consecutiveBlanks = 0;

  for (const rawLine of rawLines) {
    const trimmedRight = rawLine.trimEnd();
    const trimmed = trimmedRight.trim();
    if (trimmed.length === 0) {
      consecutiveBlanks += 1;
      if (consecutiveBlanks <= 1 && keptLines.length > 0) {
        keptLines.push("");
      }
      continue;
    }
    if (DECORATIVE_DIVIDER_LINE.test(trimmed)) {
      continue;
    }
    const normKey = trimmed.replace(/\s+/gu, " ").toLowerCase();
    if (normKey.length >= 14) {
      if (seenLongLines.has(normKey)) continue;
      seenLongLines.add(normKey);
    }
    consecutiveBlanks = 0;
    keptLines.push(trimmedRight);
  }

  while (keptLines.length > 0 && keptLines[keptLines.length - 1] === "") {
    keptLines.pop();
  }

  let compacted = keptLines.join("\n");
  const maxChars = options?.maxChars;
  if (maxChars !== undefined && maxChars > 40 && compacted.length > maxChars) {
    const slice = compacted.slice(0, maxChars - 10);
    const boundary = Math.max(
      slice.lastIndexOf("\n"),
      slice.lastIndexOf(". "),
      slice.lastIndexOf("다. "),
      slice.lastIndexOf("! "),
      slice.lastIndexOf("? "),
    );
    const cutAt = boundary >= Math.floor(maxChars * 0.55) ? boundary + 1 : slice.length;
    compacted = `${slice.slice(0, cutAt).trimEnd()}… [압축됨]`;
  }
  return compacted;
}

/**
 * Formats a lower-ranked RAG hit as a compact 1-line index pointer so the prompt
 * carries navigation pointers instead of dumping multi-KB raw chunks.
 */
export function formatRagIndexPointer(input: {
  readonly itemId: string;
  readonly chunkId?: string | undefined;
  readonly title: string;
  readonly text: string;
  readonly pdfEdition?: string | undefined;
  readonly maxSummaryChars?: number | undefined;
}): string {
  const maxSummary = input.maxSummaryChars ?? 140;
  const cleaned = compressRagText(input.text, { maxChars: maxSummary * 2 })
    .replace(/\s+/gu, " ")
    .trim();
  const summary = cleaned.length > maxSummary ? `${cleaned.slice(0, maxSummary - 1)}…` : cleaned;
  const chunkSuffix = input.chunkId ? `/c${input.chunkId}` : "";
  const editionSuffix = input.pdfEdition ? ` (${input.pdfEdition})` : "";
  return `[RAG 인덱스 #${input.itemId}${chunkSuffix}] ${input.title}${editionSuffix} — ${summary} (상세 원문은 필요 시 workspace_memory read로 정밀 조회)`;
}

function tokenizeForSimilarity(text: string): Set<string> {
  const tokens = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_-]+/gu, " ")
    .split(/\s+/u)
    .filter((t) => t.length >= 2);
  return new Set(tokens.slice(0, 120));
}

/**
 * Returns true if `candidate` has >= `threshold` (default 0.85) token-set Jaccard overlap
 * with any previously accepted long passage (>= 120 chars).
 */
export function isNearDuplicateRagText(
  candidate: string,
  acceptedTokenSets: ReadonlyArray<Set<string>>,
  threshold = 0.85,
): { readonly duplicate: boolean; readonly tokenSet: Set<string> } {
  const tokenSet = tokenizeForSimilarity(candidate);
  if (candidate.length < 80 || tokenSet.size < 8) {
    return { duplicate: false, tokenSet };
  }
  for (const prev of acceptedTokenSets) {
    if (prev.size < 8) continue;
    let intersection = 0;
    const [smaller, larger] = tokenSet.size <= prev.size ? [tokenSet, prev] : [prev, tokenSet];
    for (const tok of smaller) {
      if (larger.has(tok)) intersection += 1;
    }
    const union = tokenSet.size + prev.size - intersection;
    if (union > 0 && intersection / union >= threshold) {
      return { duplicate: true, tokenSet };
    }
  }
  return { duplicate: false, tokenSet };
}

/**
 * Batch RAG text compression that dispatches large batches (>= 32 docs) to the Rust
 * `bumpalo` Bump Arena (`native/t3-memory-core`) with zero-crash fallback to pure JS.
 */
export function compressRagTextBatch(
  docs: ReadonlyArray<string>,
  options?: RagCompressOptions,
): string[] {
  if (docs.length >= NATIVE_ARENA_BATCH_MIN_DOCS) {
    const native = runNativeSafe((addon) =>
      addon.compressAndBigramBatchArena([...docs], options?.maxChars ?? null, true),
    );
    if (native && native.compressedDocs.length === docs.length) {
      return [...native.compressedDocs];
    }
  }
  return docs.map((doc) => compressRagText(doc, options));
}

/**
 * Batch near-duplicate mask (`true` = duplicate of an earlier accepted doc) using the
 * Rust arena accelerator for batches >= 32 docs with transparent pure JS fallback.
 */
export function computeNearDuplicateRagMaskBatch(
  docs: ReadonlyArray<string>,
  threshold = 0.85,
): boolean[] {
  if (docs.length >= NATIVE_ARENA_BATCH_MIN_DOCS) {
    const native = runNativeSafe((addon) => addon.nearDuplicateMask([...docs], threshold));
    if (native && native.length === docs.length) {
      return native;
    }
  }
  const accepted: Set<string>[] = [];
  return docs.map((doc) => {
    const res = isNearDuplicateRagText(doc, accepted, threshold);
    if (!res.duplicate) accepted.push(res.tokenSet);
    return res.duplicate;
  });
}
