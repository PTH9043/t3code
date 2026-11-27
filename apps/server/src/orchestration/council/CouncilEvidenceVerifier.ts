// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFs from "node:fs/promises";
import * as NodePath from "node:path";
import type { EvidenceLedgerEntry, EvidenceVerificationStatus } from "@t3tools/contracts";
import { getOrCreateWorkspaceCodeGraph } from "../../mcp/codeGraph/CodeGraphIndex.ts";

/**
 * Boundary 1 Deterministic Evidence Ledger Verifier.
 *
 * Verifies every model-submitted code pointer directly against disk:
 * 1) Strict path-traversal boundary inside `projectRoot`
 * 2) Exact UTF-8 line range + `excerptSha256` & `fileHeadSha256`
 * 3) Hybrid AST symbol check via existing `CodeGraphIndex` (+ comment-aware word-boundary fallback)
 */

export interface EvidenceCandidateInput {
  readonly evidenceId: string;
  readonly councilId: string;
  readonly submittedBySeatId: string;
  readonly roundNum: 1 | 2 | 3;
  readonly filePath: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly astSymbol: string | null;
}

const ZERO_SHA256 = "0".repeat(64);

function sha256Hex(text: string): string {
  return NodeCrypto.createHash("sha256").update(text, "utf8").digest("hex");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function normalizeRelativePath(
  projectRoot: string,
  rawPath: string,
): {
  readonly absPath: string;
  readonly relPath: string;
  readonly insideRoot: boolean;
} {
  const rootResolved = NodePath.resolve(projectRoot);
  const cleaned = rawPath.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  const absPath = NodePath.resolve(rootResolved, cleaned);
  const rel = NodePath.relative(rootResolved, absPath);
  const insideRoot =
    rel !== "" && !rel.startsWith("..") && !NodePath.isAbsolute(rel) && absPath !== rootResolved;
  return {
    absPath,
    relPath: rel.split(NodePath.sep).join("/"),
    insideRoot,
  };
}

/** Strip line/block comments conservatively when falling back to regex symbol matching. */
function stripSimpleComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//gu, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:\\])\/\/[^\n]*/gu, "$1");
}

const NON_CODE_DOC_EXTENSIONS = new Set([
  ".md",
  ".markdown",
  ".txt",
  ".csv",
  ".tsv",
  ".html",
  ".htm",
  ".yaml",
  ".yml",
  ".toml",
]);

function splitJsonKeyPath(symbol: string): ReadonlyArray<string> {
  // Take first candidate before ` / ` if a model listed alternative keys, and strip JSONPath root `$`
  const primary = symbol.split(/\s+\/\s+/u)[0]?.trim() ?? symbol.trim();
  const tokens: string[] = [];
  for (const dotPart of primary.split(".")) {
    const trimmed = dotPart.trim().replace(/^\{([^,}]+)(?:,[^}]*)+\}$/u, "$1");
    if (!trimmed || trimmed === "$") continue;
    const bracketRx = /([^[\]]+)|\[(\*|\d+|"[^"]+"|'[^']+')\]/gu;
    let m: RegExpExecArray | null;
    while ((m = bracketRx.exec(trimmed)) !== null) {
      const seg = (m[1] ?? m[2] ?? "").replace(/^['"]|['"]$/gu, "").trim();
      if (seg.length > 0 && seg !== "$" && seg !== "*") tokens.push(seg);
    }
  }
  return tokens;
}

function jsonContainsSegmentChain(
  node: unknown,
  segments: ReadonlyArray<string>,
  depth = 0,
): boolean {
  if (segments.length === 0) return true;
  if (depth > 24 || node === null || typeof node !== "object") return false;
  const head = segments[0]!;
  const rest = segments.slice(1);

  if (Array.isArray(node)) {
    const idx = Number(head);
    if (Number.isInteger(idx) && idx >= 0 && idx < node.length) {
      if (jsonContainsSegmentChain(node[idx], rest, depth + 1)) return true;
    }
    // Also allow matching object properties inside array elements (e.g. `calls.IDOLUSDT.complete7d`)
    for (let i = 0; i < Math.min(node.length, 500); i += 1) {
      if (jsonContainsSegmentChain(node[i], segments, depth + 1)) return true;
    }
    return false;
  }

  const obj = node as Record<string, unknown>;
  if (Object.hasOwn(obj, head) && jsonContainsSegmentChain(obj[head], rest, depth + 1)) {
    return true;
  }
  // If matching from root failed at depth === 0, search nested subtrees boundedly
  if (depth === 0) {
    const stack: Array<{ readonly cur: unknown; readonly d: number }> = [{ cur: obj, d: 0 }];
    let visited = 0;
    while (stack.length > 0 && visited < 4_000) {
      const item = stack.pop()!;
      visited += 1;
      if (item.d > 12 || item.cur === null || typeof item.cur !== "object") continue;
      if (Array.isArray(item.cur)) {
        for (let i = 0; i < Math.min(item.cur.length, 200); i += 1) {
          stack.push({ cur: item.cur[i], d: item.d + 1 });
        }
      } else {
        const rec = item.cur as Record<string, unknown>;
        if (Object.hasOwn(rec, head) && jsonContainsSegmentChain(rec[head], rest, item.d + 1)) {
          return true;
        }
        for (const val of Object.values(rec)) {
          if (val !== null && typeof val === "object") {
            stack.push({ cur: val, d: item.d + 1 });
          }
        }
      }
    }
  }
  return false;
}

function verifyJsonSymbolInContent(input: {
  readonly raw: string;
  readonly excerpt: string;
  readonly symbol: string;
}): {
  readonly status: EvidenceVerificationStatus;
  readonly resolvedLine: number | null;
} | null {
  const segments = splitJsonKeyPath(input.symbol);
  if (segments.length === 0) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(input.raw);
  } catch {
    return null;
  }

  if (!jsonContainsSegmentChain(parsed, segments)) {
    return { status: "REJECTED_SYMBOL_NOT_FOUND", resolvedLine: null };
  }

  const leaf = segments[segments.length - 1]!;
  const parent = segments.length >= 2 ? segments[segments.length - 2]! : null;
  const quotedLeaf = `"${leaf}"`;
  const quotedParent = parent ? `"${parent}"` : null;

  if (
    input.excerpt.includes(quotedLeaf) ||
    input.excerpt.includes(leaf) ||
    (quotedParent !== null && input.excerpt.includes(quotedParent))
  ) {
    return { status: "VERIFIED_EXACT", resolvedLine: null };
  }

  const fullLines = input.raw.split(/\r?\n/u);
  const foundIdx = fullLines.findIndex(
    (line) => line.includes(quotedLeaf) || (quotedParent !== null && line.includes(quotedParent)),
  );
  return {
    status: "VERIFIED_SHIFTED",
    resolvedLine: foundIdx >= 0 ? foundIdx + 1 : 1,
  };
}

export async function verifyEvidenceEntryOnDisk(
  projectRoot: string,
  candidate: EvidenceCandidateInput,
  nowMs = Date.now(),
): Promise<EvidenceLedgerEntry> {
  const normalized = normalizeRelativePath(projectRoot, candidate.filePath);
  if (!normalized.insideRoot) {
    return {
      evidenceId: candidate.evidenceId,
      councilId: candidate.councilId,
      submittedBySeatId: candidate.submittedBySeatId,
      roundNum: candidate.roundNum,
      filePath: candidate.filePath,
      startLine: Math.max(1, Math.trunc(candidate.startLine)),
      endLine: Math.max(1, Math.trunc(candidate.endLine)),
      astSymbol: candidate.astSymbol,
      excerptSha256: ZERO_SHA256,
      fileHeadSha256: ZERO_SHA256,
      verificationStatus: "REJECTED_FILE_MISSING",
      verifiedAtMs: nowMs,
    };
  }

  let raw: string;
  try {
    // Also verify realpath stays within projectRoot to prevent symlink escapes
    const [realRoot, realTarget] = await Promise.all([
      NodeFs.realpath(NodePath.resolve(projectRoot)),
      NodeFs.realpath(normalized.absPath),
    ]);
    const realRel = NodePath.relative(realRoot, realTarget);
    if (realRel.startsWith("..") || NodePath.isAbsolute(realRel)) {
      return {
        evidenceId: candidate.evidenceId,
        councilId: candidate.councilId,
        submittedBySeatId: candidate.submittedBySeatId,
        roundNum: candidate.roundNum,
        filePath: normalized.relPath,
        startLine: Math.max(1, Math.trunc(candidate.startLine)),
        endLine: Math.max(1, Math.trunc(candidate.endLine)),
        astSymbol: candidate.astSymbol,
        excerptSha256: ZERO_SHA256,
        fileHeadSha256: ZERO_SHA256,
        verificationStatus: "REJECTED_FILE_MISSING",
        verifiedAtMs: nowMs,
      };
    }
    raw = await NodeFs.readFile(realTarget, "utf8");
  } catch {
    return {
      evidenceId: candidate.evidenceId,
      councilId: candidate.councilId,
      submittedBySeatId: candidate.submittedBySeatId,
      roundNum: candidate.roundNum,
      filePath: normalized.relPath,
      startLine: Math.max(1, Math.trunc(candidate.startLine)),
      endLine: Math.max(1, Math.trunc(candidate.endLine)),
      astSymbol: candidate.astSymbol,
      excerptSha256: ZERO_SHA256,
      fileHeadSha256: ZERO_SHA256,
      verificationStatus: "REJECTED_FILE_MISSING",
      verifiedAtMs: nowMs,
    };
  }

  const fileHeadSha256 = sha256Hex(raw);
  const lines = raw.split(/\r?\n/u);
  const startLine = Math.trunc(candidate.startLine);
  const endLine = Math.trunc(candidate.endLine);

  if (startLine < 1 || endLine > lines.length || startLine > endLine) {
    return {
      evidenceId: candidate.evidenceId,
      councilId: candidate.councilId,
      submittedBySeatId: candidate.submittedBySeatId,
      roundNum: candidate.roundNum,
      filePath: normalized.relPath,
      startLine: Math.max(1, startLine),
      endLine: Math.max(1, endLine),
      astSymbol: candidate.astSymbol,
      excerptSha256: ZERO_SHA256,
      fileHeadSha256,
      verificationStatus: "REJECTED_HASH_MISMATCH",
      verifiedAtMs: nowMs,
    };
  }

  const excerpt = lines.slice(startLine - 1, endLine).join("\n");
  const excerptSha256 = sha256Hex(excerpt);
  const trimmedSymbol = candidate.astSymbol?.trim() || null;

  let verificationStatus: EvidenceVerificationStatus = "VERIFIED_EXACT";
  let resolvedSymbolLine: number | null = null;

  if (trimmedSymbol !== null) {
    // 1) Primary: deterministic local AST symbol lookup via CodeGraphIndex
    let graphMatched = false;
    try {
      const graph = getOrCreateWorkspaceCodeGraph(projectRoot);
      const scopeDir = NodePath.dirname(normalized.relPath);
      graph.refresh(scopeDir === "." ? undefined : scopeDir);
      const hits = graph
        .querySymbols(trimmedSymbol, 100)
        .filter(
          (sym) =>
            sym.file.toLowerCase() === normalized.relPath.toLowerCase() &&
            (sym.name === trimmedSymbol || `${sym.parent ?? ""}.${sym.name}` === trimmedSymbol),
        );
      if (hits.length > 0) {
        graphMatched = true;
        const inRange = hits.find((sym) => sym.line >= startLine && sym.line <= endLine);
        if (inRange) {
          resolvedSymbolLine = inRange.line;
          verificationStatus = "VERIFIED_EXACT";
        } else {
          // Check if symbol is invoked or body falls within the claimed range even if declaration is above
          const nearest = hits.reduce((best, cur) =>
            Math.abs(cur.line - startLine) < Math.abs(best.line - startLine) ? cur : best,
          );
          resolvedSymbolLine = nearest.line;
          const symbolRx = new RegExp(`\\b${escapeRegExp(trimmedSymbol)}\\b`, "u");
          verificationStatus = symbolRx.test(stripSimpleComments(excerpt))
            ? "VERIFIED_EXACT"
            : "VERIFIED_SHIFTED";
        }
      }
    } catch {
      // Fall through to safe comment-stripped word-boundary verification
    }

    // 2) Secondary fallback (JSON nested key paths, docs/data files, or non-declaration symbol reference)
    if (!graphMatched) {
      const ext = NodePath.extname(normalized.relPath).toLowerCase();
      if (ext === ".json") {
        const jsonVerified = verifyJsonSymbolInContent({
          raw,
          excerpt,
          symbol: trimmedSymbol,
        });
        if (jsonVerified) {
          verificationStatus = jsonVerified.status;
          resolvedSymbolLine = jsonVerified.resolvedLine;
          return {
            evidenceId: candidate.evidenceId,
            councilId: candidate.councilId,
            submittedBySeatId: candidate.submittedBySeatId,
            roundNum: candidate.roundNum,
            filePath: normalized.relPath,
            startLine,
            endLine,
            astSymbol: trimmedSymbol,
            ...(resolvedSymbolLine !== null ? { resolvedSymbolLine } : {}),
            excerptSha256,
            fileHeadSha256,
            verificationStatus,
            verifiedAtMs: nowMs,
          };
        }
      }

      if (NON_CODE_DOC_EXTENSIONS.has(ext) || ext === ".jsonl") {
        const needle = trimmedSymbol.toLowerCase();
        const segments = trimmedSymbol
          .split(/[.>/]/u)
          .map((s) =>
            s
              .replace(/^#+\s*/u, "")
              .replace(/\(.*?\)/gu, "")
              .trim()
              .toLowerCase(),
          )
          .filter((s) => s.length >= 2);
        const excerptLower = excerpt.toLowerCase();
        const matchesExcerpt =
          excerptLower.includes(needle) ||
          (segments.length >= 1 && segments.every((seg) => excerptLower.includes(seg)));
        if (matchesExcerpt) {
          verificationStatus = "VERIFIED_EXACT";
        } else {
          const rawLower = raw.toLowerCase();
          if (
            rawLower.includes(needle) ||
            (segments.length >= 1 && segments.every((seg) => rawLower.includes(seg)))
          ) {
            const fullLines = raw.split(/\r?\n/u);
            const leaf = segments[segments.length - 1] ?? needle;
            const foundIdx = fullLines.findIndex((line) => line.toLowerCase().includes(leaf));
            resolvedSymbolLine = foundIdx >= 0 ? foundIdx + 1 : 1;
            verificationStatus = "VERIFIED_SHIFTED";
          } else {
            verificationStatus = "REJECTED_SYMBOL_NOT_FOUND";
          }
        }
      } else {
        // Strip optional trailing parenthetical commentary, e.g. `main (baseline check)` -> `main`
        const strippedAnnotation = trimmedSymbol.replace(/\s*\([^)]*\)\s*$/u, "").trim();
        const dottedLeaf = strippedAnnotation.includes(".")
          ? strippedAnnotation.split(".").pop()!.trim()
          : strippedAnnotation;
        const candidateIdent = dottedLeaf || strippedAnnotation || trimmedSymbol;
        const symbolRx = new RegExp(`\\b${escapeRegExp(candidateIdent)}\\b`, "u");
        const cleanExcerpt = stripSimpleComments(excerpt);
        if (symbolRx.test(cleanExcerpt)) {
          verificationStatus = "VERIFIED_EXACT";
        } else {
          const cleanFull = stripSimpleComments(raw);
          if (symbolRx.test(cleanFull)) {
            const fullLines = cleanFull.split(/\r?\n/u);
            const foundIdx = fullLines.findIndex((line) => symbolRx.test(line));
            resolvedSymbolLine = foundIdx >= 0 ? foundIdx + 1 : null;
            verificationStatus = "VERIFIED_SHIFTED";
          } else {
            verificationStatus = "REJECTED_SYMBOL_NOT_FOUND";
          }
        }
      }
    }
  }

  return {
    evidenceId: candidate.evidenceId,
    councilId: candidate.councilId,
    submittedBySeatId: candidate.submittedBySeatId,
    roundNum: candidate.roundNum,
    filePath: normalized.relPath,
    startLine,
    endLine,
    astSymbol: trimmedSymbol,
    ...(resolvedSymbolLine !== null ? { resolvedSymbolLine } : {}),
    excerptSha256,
    fileHeadSha256,
    verificationStatus,
    verifiedAtMs: nowMs,
  };
}

export async function verifyTargetFileLocksCas(
  projectRoot: string,
  locks: ReadonlyArray<{ readonly filePath: string; readonly expectedFileSha256: string }>,
): Promise<
  ReadonlyArray<{
    readonly filePath: string;
    readonly expectedSha256: string;
    readonly currentSha256: string | null;
  }>
> {
  const mismatches: Array<{
    readonly filePath: string;
    readonly expectedSha256: string;
    readonly currentSha256: string | null;
  }> = [];

  for (const lock of locks) {
    const norm = normalizeRelativePath(projectRoot, lock.filePath);
    if (!norm.insideRoot) {
      mismatches.push({
        filePath: lock.filePath,
        expectedSha256: lock.expectedFileSha256,
        currentSha256: null,
      });
      continue;
    }
    try {
      const raw = await NodeFs.readFile(norm.absPath, "utf8");
      const currentSha256 = sha256Hex(raw);
      if (currentSha256 !== lock.expectedFileSha256) {
        mismatches.push({
          filePath: lock.filePath,
          expectedSha256: lock.expectedFileSha256,
          currentSha256,
        });
      }
    } catch {
      mismatches.push({
        filePath: lock.filePath,
        expectedSha256: lock.expectedFileSha256,
        currentSha256: null,
      });
    }
  }
  return mismatches;
}
