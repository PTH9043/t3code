// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import type {
  CouncilClaimNode,
  CouncilSeatAssignment,
  EvidenceLedgerEntry,
  SubjectiveOpinion,
} from "@t3tools/contracts";

/**
 * 4-Stage Anti-Sycophancy & Evidence-Weighted Consensus Engine (Boundary 2).
 *
 * - Gate 2: Dynamic per-round HMAC-SHA256 anonymization (`Proposal-1..M`) + self-id text scrubbing
 * - Gate 3: Evidence-Gated Flip Rule (rejects stance flips lacking novel verified disk evidence)
 * - Gate 4: Subjective Logic opinion triple `ω = (b, d, u, a)` driven strictly by verified evidence
 * - DAG Cycle Guard: Prevents circular `targetClaimId` references
 * - Contrarian Gate: Verifies whether P0 challenges from `CONTRARIAN_RED` received structured resolution
 */

const SELF_IDENTITY_PATTERNS: ReadonlyArray<RegExp> = [
  /\b(?:claude(?:\s*(?:opus|sonnet|haiku|code))?[\w.-]*|gpt-[\w.-]+|codex[\w.-]*|o[134]-(?:mini|preview|pro)?|gemini[\w.-]*|antigravity|qwen[\w.-]*|deepseek[\w.-]*|exaone[\w.-]*|llama[\w.-]*|grok[\w.-]*|opencode|ollama)\b/giu,
];

/** Scrub model/provider/account identity leaks so Round-2 critiques stay identity-blind (IBC -> 0). */
export function scrubIdentityLeaks(text: string, extraTokens: ReadonlyArray<string> = []): string {
  let scrubbed = text;
  for (const rx of SELF_IDENTITY_PATTERNS) {
    scrubbed = scrubbed.replace(rx, "[익명 제안자]");
  }
  for (const token of extraTokens) {
    const trimmed = token.trim();
    if (trimmed.length < 3) continue;
    const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    scrubbed = scrubbed.replace(new RegExp(escaped, "giu"), "[익명 제안자]");
  }
  return scrubbed;
}

/** Deterministic per-round HMAC-SHA256 permutation mapping `seatId -> Proposal-1..M`. */
export function assignDynamicAnonHandles(input: {
  readonly councilId: string;
  readonly roundNum: 1 | 2 | 3;
  readonly seatIds: ReadonlyArray<string>;
  readonly secretSalt?: string;
}): ReadonlyMap<string, string> {
  const key = input.secretSalt ?? `${input.councilId}:round:${input.roundNum}`;
  const keyed = input.seatIds.map((seatId) => ({
    seatId,
    digest: NodeCrypto.createHmac("sha256", key).update(seatId).digest("hex"),
  }));
  keyed.sort((a, b) => a.digest.localeCompare(b.digest));

  const map = new Map<string, string>();
  keyed.forEach((entry, index) => {
    map.set(entry.seatId, `Proposal-${index + 1}`);
  });
  return map;
}

/**
 * Normalized semantic stance hash so whitespace/phrasing edits don't cause false-positive flip blocks.
 * Captures target file paths + AST symbols + normalized diff intent.
 */
export function computeStanceHash(input: {
  readonly proposedDiffSketch: string | null;
  readonly evidenceEntries: ReadonlyArray<EvidenceLedgerEntry>;
}): string {
  const verifiedLocators = input.evidenceEntries
    .filter(
      (e) =>
        e.verificationStatus === "VERIFIED_EXACT" || e.verificationStatus === "VERIFIED_SHIFTED",
    )
    .map((e) => `${e.filePath.toLowerCase()}#${(e.astSymbol ?? "").toLowerCase()}`)
    .sort();
  const normalizedSketch = (input.proposedDiffSketch ?? "")
    .toLowerCase()
    .replace(/\s+/gu, " ")
    .trim();
  const canonical = JSON.stringify({
    locators: [...new Set(verifiedLocators)],
    sketch: normalizedSketch,
  });
  return NodeCrypto.createHash("sha256").update(canonical, "utf8").digest("hex");
}

/** Subjective Logic opinion triple ω = (b, d, u, a) computed strictly from disk-verified evidence. */
export function computeSubjectiveOpinion(input: {
  readonly evidenceIds: ReadonlyArray<string>;
  readonly ledgerMap: ReadonlyMap<string, EvidenceLedgerEntry>;
  readonly unresolvedP0Count?: number;
  readonly unresolvedP1Count?: number;
}): {
  readonly opinion: SubjectiveOpinion;
  readonly exactCount: number;
  readonly shiftedCount: number;
} {
  let exactCount = 0;
  let shiftedCount = 0;
  let astMatched = false;

  for (const id of input.evidenceIds) {
    const entry = input.ledgerMap.get(id);
    if (!entry) continue;
    if (entry.verificationStatus === "VERIFIED_EXACT") {
      exactCount += 1;
      if (entry.astSymbol !== null) astMatched = true;
    } else if (entry.verificationStatus === "VERIFIED_SHIFTED") {
      shiftedCount += 1;
    }
  }

  if (exactCount === 0 && shiftedCount === 0) {
    return {
      opinion: { belief: 0.0, disbelief: 0.0, uncertainty: 1.0, baseRate: 0.5 },
      exactCount: 0,
      shiftedCount: 0,
    };
  }

  const rawUncertainty = 1.0 - 0.35 * exactCount - 0.15 * shiftedCount - (astMatched ? 0.3 : 0.0);
  const uncertainty = Number(Math.max(0.05, Math.min(1.0, rawUncertainty)).toFixed(3));
  const rawDisbelief =
    0.35 * (input.unresolvedP0Count ?? 0) + 0.15 * (input.unresolvedP1Count ?? 0);
  const disbelief = Number(Math.min(1.0 - uncertainty, Math.max(0.0, rawDisbelief)).toFixed(3));
  const belief = Number(Math.max(0.0, 1.0 - uncertainty - disbelief).toFixed(3));

  return {
    opinion: { belief, disbelief, uncertainty, baseRate: 0.5 },
    exactCount,
    shiftedCount,
  };
}

/**
 * Gate 3 — Evidence-Gated Flip Rule (Anti-Sycophancy Defense).
 *
 * If an agent changes its Round-1 stance in Round 2 WITHOUT introducing at least one
 * novel disk-verified (`VERIFIED_EXACT`) evidence entry absent from Round 1, the flip is
 * rejected as sycophantic conformity (`FLIP_BLOCKED`) and the Round-1 stance is preserved.
 */
export function enforceEvidenceGatedFlipRule(input: {
  readonly round1Claim: CouncilClaimNode;
  readonly round2Candidate: CouncilClaimNode;
  readonly verifiedLedgerMap: ReadonlyMap<string, EvidenceLedgerEntry>;
}): {
  readonly acceptedClaim: CouncilClaimNode;
  readonly flipBlocked: boolean;
} {
  const isVerifiedOnDisk = (id: string) => {
    const status = input.verifiedLedgerMap.get(id)?.verificationStatus;
    return status === "VERIFIED_EXACT" || status === "VERIFIED_SHIFTED";
  };

  const r1ValidSet = new Set(input.round1Claim.evidenceIds.filter(isVerifiedOnDisk));
  const r2ValidList = input.round2Candidate.evidenceIds.filter(isVerifiedOnDisk);
  const novelVerified = r2ValidList.filter((id) => !r1ValidSet.has(id));

  const stanceChanged = input.round1Claim.stanceHash !== input.round2Candidate.stanceHash;

  if (stanceChanged && novelVerified.length === 0) {
    return {
      acceptedClaim: {
        ...input.round1Claim,
        status: "FLIP_BLOCKED",
      },
      flipBlocked: true,
    };
  }

  const { opinion, exactCount, shiftedCount } = computeSubjectiveOpinion({
    evidenceIds: input.round2Candidate.evidenceIds,
    ledgerMap: input.verifiedLedgerMap,
  });

  const hasValidEvidence = exactCount + shiftedCount > 0;
  return {
    acceptedClaim: {
      ...input.round2Candidate,
      subjectiveOpinion: opinion,
      status: hasValidEvidence ? "ACTIVE" : "REJECTED_NO_EVIDENCE",
    },
    flipBlocked: false,
  };
}

/** Reject cyclic `targetClaimId` graphs (TumorBoard / MAPS acyclic Claim-Evidence DAG invariant). */
export function detectClaimDagCycles(
  claims: ReadonlyArray<Pick<CouncilClaimNode, "claimId" | "targetClaimId">>,
): ReadonlyArray<string> {
  const byId = new Map(claims.map((c) => [c.claimId, c.targetClaimId]));
  const cyclicIds: string[] = [];

  for (const claim of claims) {
    const visited = new Set<string>([claim.claimId]);
    let cursor = claim.targetClaimId;
    while (cursor !== null && cursor !== undefined) {
      if (visited.has(cursor)) {
        cyclicIds.push(claim.claimId);
        break;
      }
      visited.add(cursor);
      cursor = byId.get(cursor) ?? null;
    }
  }
  return cyclicIds;
}

const VALID_RESOLUTION_TAXONOMIES = new Set<CouncilClaimNode["responseTaxonomy"]>([
  "NEW_EVIDENCE_ADDED",
  "SCOPE_NARROWED",
  "CONFIDENCE_REDUCED",
  "DEFERRED_ACCEPTED",
]);

const PLACEHOLDER_STATEMENT_PATTERNS: ReadonlyArray<RegExp> = [
  /^핵심\s*진단\s*및\s*제안\s*요약\s*\(한국어/iu,
  /^익명\s*제안에\s*대한\s*코드\s*근거\s*기반\s*반론/iu,
  /^<(?:여기에_|익명_제안에_|실제_원인_|합의된_실행_|핵심_결론을_)[^>]*>$/iu,
  /^\(구조화 응답 없음\)$/u,
];

const PLACEHOLDER_PATH_PATTERNS: ReadonlyArray<RegExp> = [
  /^packages\/contracts\/src\/example\.ts$/iu,
  /^apps\/server\/src\/example\.ts$/iu,
  /^src\/example\.(?:ts|test\.ts)$/iu,
  /^<[^>]+>$/u,
];

/** Detects unedited prompt schema examples echoed verbatim by small/weak models. */
export function isTemplatePlaceholderEcho(statementKo: string): boolean {
  const trimmed = statementKo.trim();
  if (!trimmed) return true;
  return PLACEHOLDER_STATEMENT_PATTERNS.some((rx) => rx.test(trimmed));
}

export function isPlaceholderEvidencePath(filePath: string): boolean {
  const trimmed = filePath.trim();
  if (!trimmed) return true;
  return PLACEHOLDER_PATH_PATTERNS.some((rx) => rx.test(trimmed));
}

/**
 * Evaluate unresolved P0 challenges raised by `CONTRARIAN_RED` (or any seat with verified evidence).
 * A P0 challenge is only considered resolved if a subsequent rebuttal/defense targets it with one of
 * the 4 structured response taxonomies AND (for `NEW_EVIDENCE_ADDED`) supplies verified evidence.
 *
 * When `maxChallengeRound` is specified (e.g. `1`), only P0 challenges raised up to that round
 * trigger hard blocking / full research retry, preventing late Round-2 challenges that had zero
 * subsequent rebuttal opportunity from causing infinite retry loops.
 */
export function findUnresolvedP0Challenges(input: {
  readonly roster: ReadonlyArray<CouncilSeatAssignment>;
  readonly claims: ReadonlyArray<CouncilClaimNode>;
  readonly ledgerMap: ReadonlyMap<string, EvidenceLedgerEntry>;
  readonly maxChallengeRound?: 1 | 2;
}): ReadonlyArray<CouncilClaimNode> {
  const contrarianSeats = new Set(
    input.roster.filter((s) => s.assignedRole === "CONTRARIAN_RED").map((s) => s.seatId),
  );

  const hasVerifiedEvidence = (claim: CouncilClaimNode) =>
    claim.evidenceIds.some((id) => {
      const st = input.ledgerMap.get(id)?.verificationStatus;
      return st === "VERIFIED_EXACT" || st === "VERIFIED_SHIFTED";
    });

  const p0Challenges = input.claims.filter(
    (c) =>
      c.claimKind === "CONTRARIAN_CHALLENGE" &&
      c.severity === "P0" &&
      c.status !== "REJECTED_NO_EVIDENCE" &&
      (input.maxChallengeRound === undefined || c.roundNum <= input.maxChallengeRound) &&
      (contrarianSeats.has(c.authorSeatId) || hasVerifiedEvidence(c)) &&
      hasVerifiedEvidence(c),
  );

  return p0Challenges.filter((challenge) => {
    const resolved = input.claims.some((response) => {
      if (response.claimId === challenge.claimId) return false;
      if (response.targetClaimId !== challenge.claimId) return false;
      if (response.status === "REJECTED_NO_EVIDENCE" || response.status === "FLIP_BLOCKED") {
        return false;
      }
      if (!VALID_RESOLUTION_TAXONOMIES.has(response.responseTaxonomy)) return false;
      if (response.responseTaxonomy === "NEW_EVIDENCE_ADDED") {
        return hasVerifiedEvidence(response);
      }
      return true;
    });
    return !resolved;
  });
}
