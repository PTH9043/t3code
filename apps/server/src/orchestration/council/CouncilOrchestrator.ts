// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFs from "node:fs/promises";
import * as NodePath from "node:path";
import {
  CouncilError,
  type CouncilAcceptanceCheck,
  type CouncilApproveOverrideInput,
  type CouncilAbortInput,
  type CouncilClaimNode,
  type CouncilExecutePinnedSpecInput,
  type CouncilExecutePinnedSpecResult,
  type CouncilMode,
  type CouncilReverifyPinnedSpecInput,
  type CouncilSeatAssignment,
  type CouncilSeatProgress,
  type CouncilSessionSnapshot,
  type CouncilStartAutoSeatInput,
  type CouncilStreamEvent,
  type CouncilTriageInput,
  type CouncilTriageResult,
  type EffectiveCouncilMode,
  type EvidenceLedgerEntry,
  type ModelTargetRef,
  type ProjectId,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { CouncilStoreApi } from "../../persistence/CouncilStore.ts";
import { makeCouncilStore } from "../../persistence/CouncilStore.ts";
import {
  formatBillingErrorMessage,
  getUnavailableModelReason,
  isNonRetryableBillingError,
  recordUnavailableModelFromError,
} from "../../provider/workerFailurePolicy.ts";
import { unifiedExecutionLedger } from "../../t3x/executionLedger/UnifiedExecutionLedger.ts";
import {
  assignDynamicAnonHandles,
  computeStanceHash,
  computeSubjectiveOpinion,
  detectClaimDagCycles,
  enforceEvidenceGatedFlipRule,
  findUnresolvedP0Challenges,
  isPlaceholderEvidencePath,
  isTemplatePlaceholderEcho,
  scrubIdentityLeaks,
} from "./CouncilAntiSycophancy.ts";
import { verifyEvidenceEntryOnDisk, verifyTargetFileLocksCas } from "./CouncilEvidenceVerifier.ts";
import {
  buildPinnedSpecBodyForGate,
  buildVerifiedTargetFileLocks,
  computeCouncilSpecHash,
  executePinnedSpecWithCasAndGate,
  promoteCouncilToPinnedSpec,
  type DelegatedWorkerLaunchInput,
  type DelegatedWorkerLaunchOutcome,
  type IndependentCheckerInput,
  type IndependentCheckerOutcome,
} from "./CouncilExecutionBridge.ts";
import { appendHostAuditEntry, canonicalJson } from "../HostApprovalGate.ts";
import { computePinnedSpecHash } from "../PinnedSpecGate.ts";
import {
  buildAnonymizedRound2Prompt,
  buildArbiterSynthesisPrompt,
  buildBlindRound1Prompt,
  type AnonymizedProposalCard,
} from "./CouncilPrompts.ts";
import { evaluateCouncilTriage, resolveEffectiveCouncilMode } from "./CouncilTriage.ts";
import {
  resolveDynamicCouncilRoster,
  type ConfiguredSubordinateSlot,
  type TargetHealthAssessment,
} from "./DynamicCouncilRoster.ts";

/**
 * Model-Agnostic 7-Stage Deterministic Council State Machine & Orchestrator.
 *
 * Stages:
 * 1) AUTO_SEATING          — Resolve 1 Chair + 1..N dynamic subordinate slots with live health/fallback
 * 2) BLIND_ROUND_1         — Parallel isolated exploration (physical read isolation between seats)
 * 3) LEDGER_COMMIT_B1      — Disk SHA-256 + CodeGraph AST verification into append-only EvidenceLedger
 * 4) ANON_CRITIQUE_ROUND_2 — HMAC-SHA256 `Proposal-1..M` anonymization + identity scrubbing + Contrarian P0
 * 5) LEDGER_COMMIT_B2      — Evidence-Gated Flip blocking + Claim DAG cycle guard + Subjective Logic (b,d,u)
 * 6) ARBITER_SYNTHESIS_B3  — Structured consensus/disagreement/unique synthesis (+ max 1 targeted retry)
 * 7) PINNED_READY/DELEGATE — Immutable PinnedSpec + CAS lock + Worktree delegation + Zero Self-Approval
 */

export interface CouncilSeatTurnInput {
  readonly councilId: string;
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly projectRoot: string;
  readonly seat: CouncilSeatAssignment;
  readonly roundNum: 1 | 2 | 3;
  readonly retryAttempt?: number;
  readonly prompt: string;
  readonly runtimeMode?: RuntimeMode;
  readonly interactionMode?: ProviderInteractionMode;
  readonly onPartialOutput?: (fullOutput: string) => void;
  readonly onActivity?: () => void;
}

export interface CouncilRuntimeContext {
  readonly projectRoot: string;
  readonly chairModel: ModelTargetRef;
  readonly configuredSubordinates: ReadonlyArray<ConfiguredSubordinateSlot>;
  readonly fallbackCandidates: ReadonlyArray<{
    readonly target: ModelTargetRef;
    readonly supportsTemperature?: boolean;
  }>;
  readonly assessTargetHealth: (target: ModelTargetRef) => TargetHealthAssessment;
  readonly workspaceSummary: string;
  readonly runtimeMode?: RuntimeMode;
  readonly interactionMode?: ProviderInteractionMode;
}

export interface CouncilOrchestratorDeps {
  readonly store: CouncilStoreApi;
  readonly resolveContext: (input: {
    readonly threadId: ThreadId;
    readonly projectId: ProjectId;
  }) => Effect.Effect<CouncilRuntimeContext, CouncilError>;
  readonly runSeatTurn: (input: CouncilSeatTurnInput) => Effect.Effect<string, unknown>;
  readonly provisionWorktree?: (input: {
    readonly projectCwd: string;
    readonly branch: string;
  }) => Effect.Effect<{ readonly worktreePath: string; readonly refName: string }, unknown>;
  readonly launchWorker: (
    args: DelegatedWorkerLaunchInput,
  ) => Effect.Effect<DelegatedWorkerLaunchOutcome, unknown>;
  readonly runIndependentChecker?: (
    args: IndependentCheckerInput,
  ) => Effect.Effect<IndependentCheckerOutcome, unknown>;
  readonly publishTimelineReport?: (input: {
    readonly councilId: string;
    readonly threadId: ThreadId;
    readonly markdown: string;
  }) => Effect.Effect<void, unknown>;
  readonly abortCouncilWorkers?: (input: {
    readonly councilId: string;
    readonly reason: string;
  }) => Effect.Effect<void, unknown>;
  readonly abortSeatDispatch?: (input: {
    readonly councilId: string;
    readonly seatId: string;
    readonly roundNum: 1 | 2 | 3;
    readonly retryAttempt: number;
    readonly reason: string;
  }) => Effect.Effect<void, unknown>;
  readonly sqlClient?: SqlClient.SqlClient;
  readonly maxParallelSeats?: number;
  readonly round1SeatTimeoutMs?: number;
  readonly round2SeatTimeoutMs?: number;
  readonly round3SynthesisTimeoutMs?: number;
  readonly quorumRatio?: number;
  readonly stragglerGraceMs?: number;
}

export interface CouncilOrchestratorShape {
  readonly triage: (input: CouncilTriageInput) => Effect.Effect<CouncilTriageResult, CouncilError>;
  readonly startAutoSeat: (
    input: CouncilStartAutoSeatInput,
  ) => Effect.Effect<CouncilSessionSnapshot, CouncilError>;
  readonly getSession: (councilId: string) => Effect.Effect<CouncilSessionSnapshot, CouncilError>;
  readonly listThreadSessions: (
    threadId: ThreadId,
    limit?: number,
  ) => Effect.Effect<ReadonlyArray<CouncilSessionSnapshot>, CouncilError>;
  readonly approveOverride: (
    input: CouncilApproveOverrideInput,
  ) => Effect.Effect<CouncilSessionSnapshot, CouncilError>;
  readonly executePinnedSpec: (
    input: CouncilExecutePinnedSpecInput,
  ) => Effect.Effect<CouncilExecutePinnedSpecResult, CouncilError>;
  readonly reverifyPinnedSpec: (
    input: CouncilReverifyPinnedSpecInput,
  ) => Effect.Effect<CouncilSessionSnapshot, CouncilError>;
  readonly abort: (input: CouncilAbortInput) => Effect.Effect<CouncilSessionSnapshot, CouncilError>;
  readonly subscribe: (threadId: ThreadId) => Stream.Stream<CouncilStreamEvent, CouncilError>;
  /** Synchronously await an in-flight council session (primarily for deterministic tests). */
  readonly awaitCouncil: (
    councilId: string,
  ) => Effect.Effect<CouncilSessionSnapshot | null, CouncilError>;
}

export class CouncilOrchestratorService extends Context.Service<
  CouncilOrchestratorService,
  CouncilOrchestratorShape
>()("t3/orchestration/council/CouncilOrchestratorService") {}

interface ParsedEvidenceCandidate {
  readonly filePath: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly astSymbol: string | null;
}

interface ParsedProposalPayload {
  readonly claimKind: CouncilClaimNode["claimKind"];
  readonly severity: CouncilClaimNode["severity"];
  readonly targetClaimId: string | null;
  readonly responseTaxonomy: CouncilClaimNode["responseTaxonomy"];
  readonly statementKo: string;
  readonly proposedDiffSketch: string | null;
  readonly evidence: ReadonlyArray<ParsedEvidenceCandidate>;
  readonly acceptanceCommands: ReadonlyArray<string>;
}

interface ParsedSynthesisPayload {
  readonly titleKo: string;
  readonly executiveSummaryKo: string;
  readonly acceptedClaimIds: ReadonlyArray<string>;
  readonly targetFiles: ReadonlyArray<{
    readonly filePath: string;
    readonly patchIntentKo: string;
    readonly relatedEvidenceIds: ReadonlyArray<string>;
  }>;
  readonly acceptanceChecks: ReadonlyArray<CouncilAcceptanceCheck>;
  readonly unresolvedDisagreementsKo: ReadonlyArray<string>;
  readonly uniqueFindingsKo: ReadonlyArray<string>;
}

/** Tolerant envelope extractor handling fenced JSON and tokenizer trailing tokens (` ```Ble `). */
export function extractStructuredTagJson(raw: string, tagName: string): unknown | null {
  const openTag = `<${tagName}>`;
  const closeTag = `</${tagName}>`;
  const start = raw.indexOf(openTag);
  const end = start >= 0 ? raw.indexOf(closeTag, start + openTag.length) : -1;
  let candidate =
    start >= 0 && end > start ? raw.slice(start + openTag.length, end).trim() : raw.trim();

  // Strip optional markdown fence even with trailing short ascii tokenizer artifacts
  const fenceMatch = /^```(?:json)?\s*\r?\n([\s\S]*?)\r?\n```[A-Za-z0-9._-]{0,16}\s*$/u.exec(
    candidate,
  );
  if (fenceMatch?.[1]) {
    candidate = fenceMatch[1].trim();
  } else {
    const firstBrace = candidate.indexOf("{");
    const lastBrace = candidate.lastIndexOf("}");
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      candidate = candidate.slice(firstBrace, lastBrace + 1);
    }
  }

  try {
    return JSON.parse(candidate) as unknown;
  } catch {
    return null;
  }
}

const VALID_CLAIM_KINDS = new Set<CouncilClaimNode["claimKind"]>([
  "ROOT_DIAGNOSIS",
  "PATCH_PROPOSAL",
  "CONTRARIAN_CHALLENGE",
  "REBUTTAL_DEFENSE",
]);

const VALID_TAXONOMIES = new Set<CouncilClaimNode["responseTaxonomy"]>([
  "INITIAL",
  "NEW_EVIDENCE_ADDED",
  "SCOPE_NARROWED",
  "CONFIDENCE_REDUCED",
  "DEFERRED_ACCEPTED",
]);

const SAFE_VERIFY_COMMANDS = new Set([
  "vp",
  "node",
  "git",
  "python",
  "python3",
  "cargo",
  "tsc",
  "tsgo",
  "vitest",
  "pnpm",
  "npm",
]);

function parseSafeCommandString(cmdText: string): CouncilAcceptanceCheck | null {
  const trimmed = cmdText.trim().replace(/^\$\s*/u, "");
  if (!trimmed || /[|&;<>`$()]/u.test(trimmed)) return null;
  const parts = trimmed.split(/\s+/u).filter(Boolean);
  const command = parts[0];
  if (!command || !SAFE_VERIFY_COMMANDS.has(command.toLowerCase())) return null;
  return {
    label: trimmed.slice(0, 280),
    verifySpec: {
      command,
      args: parts.slice(1),
      timeoutMs: 60_000,
    },
  };
}

function parseEvidenceList(raw: unknown): ReadonlyArray<ParsedEvidenceCandidate> {
  if (!Array.isArray(raw)) return [];
  const out: ParsedEvidenceCandidate[] = [];
  for (const item of raw.slice(0, 16)) {
    if (typeof item !== "object" || item === null) continue;
    const obj = item as Record<string, unknown>;
    const filePath = typeof obj.filePath === "string" ? obj.filePath.trim() : "";
    const startLine = typeof obj.startLine === "number" ? Math.trunc(obj.startLine) : 0;
    const endLine = typeof obj.endLine === "number" ? Math.trunc(obj.endLine) : startLine;
    const astSymbol =
      typeof obj.astSymbol === "string" && obj.astSymbol.trim().length > 0
        ? obj.astSymbol.trim().slice(0, 200)
        : null;
    if (filePath.length > 0 && startLine >= 1 && !isPlaceholderEvidencePath(filePath)) {
      out.push({ filePath, startLine, endLine: Math.max(startLine, endLine), astSymbol });
    }
  }
  return out;
}

function parseProposalEnvelope(
  raw: string,
  tagName: "t3_council_proposal" | "t3_council_critique",
  seat: CouncilSeatAssignment,
  roundNum: 1 | 2,
): ParsedProposalPayload {
  const parsed = extractStructuredTagJson(raw, tagName);
  const obj =
    typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};

  const defaultKind: CouncilClaimNode["claimKind"] =
    seat.assignedRole === "CONTRARIAN_RED"
      ? "CONTRARIAN_CHALLENGE"
      : roundNum === 1
        ? "PATCH_PROPOSAL"
        : "REBUTTAL_DEFENSE";
  const claimKind =
    typeof obj.claimKind === "string" &&
    VALID_CLAIM_KINDS.has(obj.claimKind as CouncilClaimNode["claimKind"])
      ? (obj.claimKind as CouncilClaimNode["claimKind"])
      : defaultKind;

  const severity: CouncilClaimNode["severity"] =
    obj.severity === "P0" || obj.severity === "P1" || obj.severity === "P2"
      ? obj.severity
      : claimKind === "CONTRARIAN_CHALLENGE"
        ? "P0"
        : null;

  const responseTaxonomy: CouncilClaimNode["responseTaxonomy"] =
    typeof obj.responseTaxonomy === "string" &&
    VALID_TAXONOMIES.has(obj.responseTaxonomy as CouncilClaimNode["responseTaxonomy"])
      ? (obj.responseTaxonomy as CouncilClaimNode["responseTaxonomy"])
      : roundNum === 1
        ? "INITIAL"
        : "NEW_EVIDENCE_ADDED";

  const targetClaimId =
    typeof obj.targetClaimId === "string" && obj.targetClaimId.trim().length > 0
      ? obj.targetClaimId.trim().slice(0, 64)
      : null;

  const statementKo =
    typeof obj.statementKo === "string" && obj.statementKo.trim().length > 0
      ? obj.statementKo.trim().slice(0, 3900)
      : raw.trim().slice(0, 1200) || "(구조화 응답 없음)";

  const proposedDiffSketch =
    typeof obj.proposedDiffSketch === "string" && obj.proposedDiffSketch.trim().length > 0
      ? obj.proposedDiffSketch.trim().slice(0, 7800)
      : null;

  const acceptanceCommands = Array.isArray(obj.acceptanceCommands)
    ? obj.acceptanceCommands.filter(
        (c): c is string => typeof c === "string" && c.trim().length > 0,
      )
    : [];

  return {
    claimKind,
    severity,
    targetClaimId,
    responseTaxonomy,
    statementKo,
    proposedDiffSketch,
    evidence: parseEvidenceList(obj.evidence),
    acceptanceCommands,
  };
}

function parseSynthesisEnvelope(raw: string): ParsedSynthesisPayload | null {
  const parsed = extractStructuredTagJson(raw, "t3_council_synthesis");
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  const titleKo = typeof obj.titleKo === "string" ? obj.titleKo.trim().slice(0, 200) : "";
  const executiveSummaryKo =
    typeof obj.executiveSummaryKo === "string" ? obj.executiveSummaryKo.trim().slice(0, 8000) : "";
  if (!titleKo && !executiveSummaryKo) return null;

  const acceptedClaimIds = Array.isArray(obj.acceptedClaimIds)
    ? obj.acceptedClaimIds.filter((x): x is string => typeof x === "string" && x.trim().length > 0)
    : [];

  const targetFiles = Array.isArray(obj.targetFiles)
    ? obj.targetFiles.flatMap((item) => {
        if (typeof item !== "object" || item === null) return [];
        const f = item as Record<string, unknown>;
        const filePath = typeof f.filePath === "string" ? f.filePath.trim() : "";
        if (!filePath) return [];
        return [
          {
            filePath,
            patchIntentKo:
              typeof f.patchIntentKo === "string" && f.patchIntentKo.trim().length > 0
                ? f.patchIntentKo.trim().slice(0, 1000)
                : "합의된 변경 적용",
            relatedEvidenceIds: Array.isArray(f.relatedEvidenceIds)
              ? f.relatedEvidenceIds.filter((id): id is string => typeof id === "string")
              : [],
          },
        ];
      })
    : [];

  const acceptanceChecks: CouncilAcceptanceCheck[] = [];
  if (Array.isArray(obj.acceptanceChecks)) {
    for (const item of obj.acceptanceChecks) {
      if (typeof item !== "object" || item === null) continue;
      const c = item as Record<string, unknown>;
      const command = typeof c.command === "string" ? c.command.trim() : "";
      if (!command || !SAFE_VERIFY_COMMANDS.has(command.toLowerCase())) continue;
      const args = Array.isArray(c.args)
        ? c.args.filter((a): a is string => typeof a === "string")
        : [];
      const label =
        typeof c.label === "string" && c.label.trim().length > 0
          ? c.label.trim().slice(0, 280)
          : `${command} ${args.join(" ")}`.trim().slice(0, 280);
      acceptanceChecks.push({
        label,
        verifySpec: {
          command,
          args,
          timeoutMs: 60_000,
        },
      });
    }
  } else if (Array.isArray(obj.acceptanceCommands)) {
    for (const cmd of obj.acceptanceCommands) {
      if (typeof cmd !== "string") continue;
      const parsedCmd = parseSafeCommandString(cmd);
      if (parsedCmd) acceptanceChecks.push(parsedCmd);
    }
  }

  return {
    titleKo: titleKo || "다자간 위원회 합의 실행 명세",
    executiveSummaryKo: executiveSummaryKo || titleKo,
    acceptedClaimIds,
    targetFiles,
    acceptanceChecks,
    unresolvedDisagreementsKo: Array.isArray(obj.unresolvedDisagreementsKo)
      ? obj.unresolvedDisagreementsKo.filter((s): s is string => typeof s === "string")
      : [],
    uniqueFindingsKo: Array.isArray(obj.uniqueFindingsKo)
      ? obj.uniqueFindingsKo.filter((s): s is string => typeof s === "string")
      : [],
  };
}

async function listTopLevelDirectories(projectRoot: string): Promise<ReadonlyArray<string>> {
  try {
    const entries = await NodeFs.readdir(projectRoot, { withFileTypes: true });
    return entries
      .filter(
        (e) =>
          e.isDirectory() &&
          !e.name.startsWith(".") &&
          e.name !== "node_modules" &&
          e.name !== "dist" &&
          e.name !== "build",
      )
      .map((e) => e.name)
      .sort()
      .slice(0, 12);
  } catch {
    return [];
  }
}

function cleanFallbackTitle(userPrompt: string, topStatement?: string): string {
  const source = (topStatement ?? userPrompt)
    .replace(/[*#`_~>[\]]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (!source) return "다자간 위원회 합의 요약";
  return source.length > 76 ? `${source.slice(0, 75).trim()}…` : source;
}

function buildSynthesisRepairPrompt(rawOutput: string, mode: EffectiveCouncilMode): string {
  return [
    "직전 응답에서 `<t3_council_synthesis>` JSON 파싱에 실패했습니다.",
    "아래 원문 내용만 바탕으로, 설명 문장 없이 오직 `<t3_council_synthesis>` 와 `</t3_council_synthesis>` 태그 사이의 유효한 JSON 객체 하나만 출력하세요.",
    mode === "discussion" ? "`targetFiles`와 `acceptanceChecks`는 빈 배열 `[]`로 두세요." : "",
    "",
    "--- 직전 의장 원문 ---",
    rawOutput.slice(0, 6_000),
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildCouncilSynthesisMarkdown(input: {
  readonly mode: EffectiveCouncilMode;
  readonly seatCount: number;
  readonly titleKo: string;
  readonly executiveSummaryKo: string;
  readonly verifiedEvidence: ReadonlyArray<EvidenceLedgerEntry>;
  readonly flipBlockedCount: number;
  readonly uniqueFindingsKo: ReadonlyArray<string>;
  readonly unresolvedDisagreementsKo: ReadonlyArray<string>;
}): string {
  const modeLabel = input.mode === "discussion" ? "분석·토론 보고서" : "코드 수정 합의 명세";
  const lines: string[] = [
    `### 다자간 위원회 ${modeLabel} — ${input.titleKo}`,
    "",
    `> 합석 **${input.seatCount}석** · 원장 검증 근거 **${input.verifiedEvidence.length}건**` +
      (input.flipBlockedCount > 0
        ? ` · 무근거 동조(Flip) 차단 **${input.flipBlockedCount}건**`
        : ""),
    "",
    input.executiveSummaryKo.trim(),
  ];

  if (input.uniqueFindingsKo.length > 0) {
    lines.push("", "#### 소수파 고유 발견 및 경계 조건");
    for (const item of input.uniqueFindingsKo.slice(0, 6)) {
      lines.push(`- ${item}`);
    }
  }

  if (input.unresolvedDisagreementsKo.length > 0) {
    lines.push("", "#### 미해결 쟁점 및 유의사항");
    for (const item of input.unresolvedDisagreementsKo.slice(0, 6)) {
      lines.push(`- ${item}`);
    }
  }

  if (input.verifiedEvidence.length > 0) {
    lines.push("", "#### 주요 검증 근거 (원장 대조 완료)");
    const seen = new Set<string>();
    let count = 0;
    for (const ev of input.verifiedEvidence) {
      const loc = `${ev.filePath}:${ev.startLine}-${ev.endLine}`;
      if (seen.has(loc)) continue;
      seen.add(loc);
      lines.push(
        `- \`${loc}\`${ev.astSymbol ? ` (\`${ev.astSymbol}\`)` : ""} — \`sha256:${ev.excerptSha256.slice(0, 8)}\``,
      );
      count += 1;
      if (count >= 8) break;
    }
  }

  return lines.join("\n");
}

const IN_FLIGHT_COUNCIL_STATES = new Set<CouncilSessionSnapshot["state"]>([
  "AUTO_SEATING",
  "BLIND_ROUND_1",
  "LEDGER_COMMIT_B1",
  "ANON_CRITIQUE_ROUND_2",
  "LEDGER_COMMIT_B2",
  "ARBITER_SYNTHESIS_B3",
  "DELEGATED_RUNNING",
  "VERIFYING",
]);

export const makeCouncilOrchestrator = Effect.fn("CouncilOrchestrator.make")(function* (
  deps: CouncilOrchestratorDeps,
) {
  const pubsub = yield* PubSub.unbounded<CouncilStreamEvent>();
  const runningFibers = new Map<string, Fiber.Fiber<unknown, unknown>>();
  const abortedIds = new Set<string>();
  const seatProgressByCouncil = new Map<string, Map<string, CouncilSeatProgress>>();
  const concurrency = Math.max(1, Math.min(8, deps.maxParallelSeats ?? 6));
  const round1TimeoutMs = Math.max(50, deps.round1SeatTimeoutMs ?? 240_000);
  const round2TimeoutMs = Math.max(50, deps.round2SeatTimeoutMs ?? 180_000);
  const round3TimeoutMs = Math.max(50, deps.round3SynthesisTimeoutMs ?? 180_000);
  const quorumRatio = Math.max(0.5, Math.min(1.0, deps.quorumRatio ?? 0.67));
  const stragglerGraceMs = Math.max(20, deps.stragglerGraceMs ?? 60_000);

  const enrichSnapshot = (snap: CouncilSessionSnapshot): CouncilSessionSnapshot => {
    const map = seatProgressByCouncil.get(snap.councilId);
    if (!map || map.size === 0) return snap;
    return {
      ...snap,
      seatProgress: [...map.values()],
    };
  };

  const setSeatProgress = (councilId: string, progress: CouncilSeatProgress) => {
    let map = seatProgressByCouncil.get(councilId);
    if (!map) {
      map = new Map();
      seatProgressByCouncil.set(councilId, map);
    }
    map.set(progress.seatId, progress);
  };

  const publishThreadUpdate = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const sessions = yield* deps.store
        .listThreadSessions(threadId, 8)
        .pipe(Effect.catch(() => Effect.succeed<ReadonlyArray<CouncilSessionSnapshot>>([])));
      yield* PubSub.publish(pubsub, {
        kind: "updated",
        threadId,
        sessions: sessions.map(enrichSnapshot),
        updatedAt: new Date().toISOString(),
      });
    });

  const provideOptionalSql = <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, Exclude<R, SqlClient.SqlClient>> =>
    deps.sqlClient
      ? (Effect.provideService(
          effect as Effect.Effect<A, E, SqlClient.SqlClient>,
          SqlClient.SqlClient,
          deps.sqlClient,
        ) as Effect.Effect<A, E, Exclude<R, SqlClient.SqlClient>>)
      : (effect as Effect.Effect<A, E, Exclude<R, SqlClient.SqlClient>>);

  const runSeatsWithQuorumAndTimeout = (params: {
    readonly councilId: string;
    readonly threadId: ThreadId;
    readonly roundNum: 1 | 2;
    readonly retryAttempt: number;
    readonly roster: ReadonlyArray<CouncilSeatAssignment>;
    readonly seatTimeoutMs: number;
    readonly buildPrompt: (seat: CouncilSeatAssignment) => string;
    readonly invokeSeat: (
      seat: CouncilSeatAssignment,
      prompt: string,
      hooks: {
        readonly onPartialOutput: (fullOutput: string) => void;
        readonly onActivity: () => void;
      },
    ) => Effect.Effect<string, unknown>;
  }) =>
    Effect.scoped(
      Effect.gen(function* () {
        if (params.roster.length === 0) {
          return [] as ReadonlyArray<{
            readonly seat: CouncilSeatAssignment;
            readonly ok: boolean;
            readonly output: string;
          }>;
        }
        const sem = yield* Semaphore.make(concurrency);
        const allDone = yield* Deferred.make<void>();
        const outputs = new Map<
          string,
          { readonly seat: CouncilSeatAssignment; readonly ok: boolean; readonly output: string }
        >();
        const seatFibers = new Map<string, Fiber.Fiber<unknown, unknown>>();
        const partialBySeat = new Map<string, string>();
        const lastActivityBySeat = new Map<string, number>();
        const settledIds = new Set<string>();
        let graceArmed = false;

        const formatTimeoutOutput = (prefix: string, reason: string, seatId: string): string => {
          const partial = partialBySeat.get(seatId)?.trim() ?? "";
          if (!partial) return `${prefix} 시간 초과 실패: ${reason}`;
          return `${prefix} 시간 초과 실패: ${reason}\n\n[시간 초과 전 부분 출력 보존 (${partial.length}자)]\n${partial}`;
        };

        const nowInit = Date.now();
        const runnableRoster: CouncilSeatAssignment[] = [];
        for (const seat of params.roster) {
          const preUnavailableReason = seat.unavailable
            ? (seat.unavailableReason ?? "모델 사용 불가")
            : getUnavailableModelReason(
                seat.targetModel.providerInstanceId,
                seat.targetModel.modelId,
              );
          if (preUnavailableReason) {
            settledIds.add(seat.seatId);
            const displayReason = preUnavailableReason.startsWith("사용 불가")
              ? preUnavailableReason
              : `사용 불가: ${preUnavailableReason}`;
            setSeatProgress(params.councilId, {
              seatId: seat.seatId,
              roundNum: params.roundNum,
              state: "failed",
              startedAtMs: nowInit,
              finishedAtMs: nowInit,
              elapsedMs: 0,
              errorMessage: displayReason.slice(0, 450),
            });
            outputs.set(seat.seatId, {
              seat,
              ok: false,
              output: `${params.roundNum === 1 ? "좌석" : "Round 2"} ${displayReason}`,
            });
            continue;
          }
          runnableRoster.push(seat);
          setSeatProgress(params.councilId, {
            seatId: seat.seatId,
            roundNum: params.roundNum,
            state: "running",
            startedAtMs: nowInit,
            finishedAtMs: null,
            elapsedMs: 0,
            errorMessage: null,
          });
        }
        yield* publishThreadUpdate(params.threadId);

        if (runnableRoster.length === 0) {
          return params.roster.map(
            (seat) =>
              outputs.get(seat.seatId) ?? {
                seat,
                ok: false,
                output: "좌석 사용 불가",
              },
          );
        }

        const contrarianIds = runnableRoster
          .filter((s) => s.assignedRole === "CONTRARIAN_RED")
          .map((s) => s.seatId);
        const unavailableCount = params.roster.length - runnableRoster.length;
        const runnableQuorum =
          runnableRoster.length <= 2
            ? runnableRoster.length
            : Math.min(
                runnableRoster.length - 1,
                Math.max(2, Math.round(runnableRoster.length * quorumRatio)),
              );
        const quorumTarget = unavailableCount + runnableQuorum;

        const checkQuorumAndCompletion = () =>
          Effect.gen(function* () {
            if (settledIds.size >= params.roster.length) {
              yield* Deferred.succeed(allDone, undefined);
              return;
            }
            const chairDone = settledIds.has("seat_chair");
            const contrarianDone =
              contrarianIds.length === 0 || contrarianIds.some((id) => settledIds.has(id));
            if (!graceArmed && chairDone && contrarianDone && settledIds.size >= quorumTarget) {
              graceArmed = true;
              const settledWhenArmed = settledIds.size;
              const graceFib = yield* Effect.forkDetach(
                Effect.sleep(Duration.millis(stragglerGraceMs)).pipe(
                  Effect.andThen(
                    Effect.gen(function* () {
                      if (settledIds.size >= params.roster.length) return;
                      const cutoffMs = Date.now();
                      for (const seat of params.roster) {
                        if (settledIds.has(seat.seatId)) continue;
                        settledIds.add(seat.seatId);
                        const runningFib = seatFibers.get(seat.seatId);
                        if (runningFib) {
                          yield* Effect.forkDetach(
                            Fiber.interrupt(runningFib).pipe(Effect.catch(() => Effect.void)),
                          );
                        }
                        const partial = partialBySeat.get(seat.seatId)?.trim() ?? "";
                        const reason = `정족수(${settledWhenArmed}/${params.roster.length}) 완료 후 유예 ${Math.round(stragglerGraceMs / 1000)}초 초과로 조기 마감${partial ? ` (부분 출력 ${partial.length}자 보존)` : ""}`;
                        if (deps.abortSeatDispatch) {
                          yield* deps
                            .abortSeatDispatch({
                              councilId: params.councilId,
                              seatId: seat.seatId,
                              roundNum: params.roundNum,
                              retryAttempt: params.retryAttempt,
                              reason,
                            })
                            .pipe(Effect.catch(() => Effect.void));
                        }
                        setSeatProgress(params.councilId, {
                          seatId: seat.seatId,
                          roundNum: params.roundNum,
                          state: "timed_out",
                          startedAtMs: nowInit,
                          finishedAtMs: cutoffMs,
                          elapsedMs: Math.max(0, cutoffMs - nowInit),
                          errorMessage: reason.slice(0, 450),
                        });
                        outputs.set(seat.seatId, {
                          seat,
                          ok: false,
                          output: formatTimeoutOutput(
                            params.roundNum === 1 ? "좌석" : "Round 2",
                            reason,
                            seat.seatId,
                          ),
                        });
                      }
                      yield* publishThreadUpdate(params.threadId);
                      yield* Deferred.succeed(allDone, undefined);
                    }),
                  ),
                ),
              );
              seatFibers.set("__quorum_grace__", graceFib);
            }
          });

        const activityWindowMs = Math.max(
          25,
          Math.min(45_000, Math.floor(params.seatTimeoutMs / 2)),
        );
        const maxExtensionMs = Math.min(120_000, params.seatTimeoutMs);

        for (const seat of runnableRoster) {
          const prompt = params.buildPrompt(seat);
          const seatStartMs = Date.now();
          lastActivityBySeat.set(seat.seatId, seatStartMs);

          const fib = yield* Effect.forkDetach(
            sem
              .withPermits(1)(
                Effect.gen(function* () {
                  const outcomeDeferred = yield* Deferred.make<
                    | { readonly kind: "ok"; readonly value: string }
                    | { readonly kind: "error"; readonly err: unknown }
                    | { readonly kind: "timeout"; readonly reason: string }
                  >();

                  const execFib = yield* Effect.forkDetach(
                    params
                      .invokeSeat(seat, prompt, {
                        onPartialOutput: (text) => {
                          const prev = partialBySeat.get(seat.seatId) ?? "";
                          if (text.length >= prev.length) {
                            partialBySeat.set(seat.seatId, text);
                          }
                          lastActivityBySeat.set(seat.seatId, Date.now());
                        },
                        onActivity: () => {
                          lastActivityBySeat.set(seat.seatId, Date.now());
                        },
                      })
                      .pipe(
                        Effect.tap((value) =>
                          Deferred.succeed(outcomeDeferred, { kind: "ok", value }),
                        ),
                        Effect.catch((err) =>
                          Deferred.succeed(outcomeDeferred, { kind: "error", err }),
                        ),
                      ),
                  );

                  // Streaming-aware timeout watcher: extends up to `maxExtensionMs` while
                  // fresh streaming/tool activity keeps arriving; never auto-retries.
                  const watchFib = yield* Effect.forkDetach(
                    Effect.gen(function* () {
                      let extendedMs = 0;
                      let sleepMs = params.seatTimeoutMs;
                      while (true) {
                        yield* Effect.sleep(Duration.millis(sleepMs));
                        if (settledIds.has(seat.seatId)) return;
                        const nowMs = Date.now();
                        const lastAct = lastActivityBySeat.get(seat.seatId) ?? seatStartMs;
                        const activeRecently =
                          lastAct > seatStartMs && nowMs - lastAct < activityWindowMs;
                        if (activeRecently && extendedMs < maxExtensionMs) {
                          const stepMs = Math.min(activityWindowMs, maxExtensionMs - extendedMs);
                          extendedMs += stepMs;
                          sleepMs = stepMs;
                          continue;
                        }
                        const effectiveSec = Math.round((params.seatTimeoutMs + extendedMs) / 1000);
                        const partialLen = partialBySeat.get(seat.seatId)?.trim().length ?? 0;
                        const reason =
                          extendedMs > 0
                            ? `좌석 제한 시간(${effectiveSec}초, 스트리밍 연장 포함) 초과${partialLen > 0 ? ` · 부분 출력 ${partialLen}자 보존` : ""}`
                            : `좌석 제한 시간(${effectiveSec}초) 초과${partialLen > 0 ? ` · 부분 출력 ${partialLen}자 보존` : ""}`;
                        yield* Deferred.succeed(outcomeDeferred, { kind: "timeout", reason });
                        return;
                      }
                    }),
                  );

                  const outcome = yield* Deferred.await(outcomeDeferred).pipe(
                    Effect.ensuring(
                      Effect.gen(function* () {
                        yield* Fiber.interrupt(watchFib).pipe(Effect.catch(() => Effect.void));
                      }),
                    ),
                  );

                  if (outcome.kind === "timeout") {
                    yield* Fiber.interrupt(execFib).pipe(Effect.catch(() => Effect.void));
                  }

                  if (settledIds.has(seat.seatId)) return;
                  settledIds.add(seat.seatId);
                  const finishedMs = Date.now();
                  const elapsed = Math.max(0, finishedMs - seatStartMs);

                  if (outcome.kind === "ok") {
                    setSeatProgress(params.councilId, {
                      seatId: seat.seatId,
                      roundNum: params.roundNum,
                      state: "completed",
                      startedAtMs: seatStartMs,
                      finishedAtMs: finishedMs,
                      elapsedMs: elapsed,
                      errorMessage: null,
                    });
                    outputs.set(seat.seatId, { seat, ok: true, output: outcome.value });
                    yield* publishThreadUpdate(params.threadId);
                    yield* checkQuorumAndCompletion();
                    return;
                  }

                  if (outcome.kind === "timeout") {
                    setSeatProgress(params.councilId, {
                      seatId: seat.seatId,
                      roundNum: params.roundNum,
                      state: "timed_out",
                      startedAtMs: seatStartMs,
                      finishedAtMs: finishedMs,
                      elapsedMs: elapsed,
                      errorMessage: outcome.reason.slice(0, 450),
                    });
                    outputs.set(seat.seatId, {
                      seat,
                      ok: false,
                      output: formatTimeoutOutput(
                        params.roundNum === 1 ? "좌석" : "Round 2",
                        outcome.reason,
                        seat.seatId,
                      ),
                    });
                    if (deps.abortSeatDispatch) {
                      yield* deps
                        .abortSeatDispatch({
                          councilId: params.councilId,
                          seatId: seat.seatId,
                          roundNum: params.roundNum,
                          retryAttempt: params.retryAttempt,
                          reason: outcome.reason,
                        })
                        .pipe(Effect.catch(() => Effect.void));
                    }
                    yield* publishThreadUpdate(params.threadId);
                    yield* checkQuorumAndCompletion();
                    return;
                  }

                  const rawMsg =
                    outcome.err instanceof Error ? outcome.err.message : String(outcome.err);
                  recordUnavailableModelFromError({
                    providerInstanceId: seat.targetModel.providerInstanceId,
                    model: seat.targetModel.modelId,
                    errorMessage: rawMsg,
                  });
                  const msg = isNonRetryableBillingError(rawMsg)
                    ? formatBillingErrorMessage(rawMsg)
                    : rawMsg;
                  const errPartial =
                    typeof (outcome.err as { readonly partialOutput?: unknown } | null)
                      ?.partialOutput === "string"
                      ? ((outcome.err as { readonly partialOutput: string }).partialOutput ?? "")
                      : (partialBySeat.get(seat.seatId) ?? "");
                  const isTimedOutErr =
                    (outcome.err as { readonly timedOut?: unknown } | null)?.timedOut === true ||
                    msg.includes("시간 초과");
                  setSeatProgress(params.councilId, {
                    seatId: seat.seatId,
                    roundNum: params.roundNum,
                    state: isTimedOutErr ? "timed_out" : "failed",
                    startedAtMs: seatStartMs,
                    finishedAtMs: finishedMs,
                    elapsedMs: elapsed,
                    errorMessage: msg.slice(0, 450),
                  });
                  const baseFailText = `${params.roundNum === 1 ? "좌석" : "Round 2"} ${isTimedOutErr ? "시간 초과 실패" : "응답 실패"}: ${msg}`;
                  outputs.set(seat.seatId, {
                    seat,
                    ok: false,
                    output: errPartial.trim()
                      ? `${baseFailText}\n\n[중단 전 부분 출력 보존 (${errPartial.trim().length}자)]\n${errPartial.trim()}`
                      : baseFailText,
                  });
                  yield* publishThreadUpdate(params.threadId);
                  yield* checkQuorumAndCompletion();
                }),
              )
              .pipe(Effect.catchCause(() => Effect.void)),
          );
          seatFibers.set(seat.seatId, fib);
        }

        yield* Deferred.await(allDone).pipe(
          Effect.ensuring(
            Effect.forEach(
              seatFibers.values(),
              (fib) =>
                Effect.forkDetach(Fiber.interrupt(fib).pipe(Effect.catch(() => Effect.void))),
              { discard: true },
            ),
          ),
        );
        return params.roster.map(
          (seat) =>
            outputs.get(seat.seatId) ?? {
              seat,
              ok: false,
              output: "좌석 결과 없음",
            },
        );
      }),
    );

  const runCouncilPipeline = (input: {
    readonly councilId: string;
    readonly threadId: ThreadId;
    readonly projectId: ProjectId;
    readonly userPrompt: string;
    readonly mode: EffectiveCouncilMode;
    readonly ctx: CouncilRuntimeContext;
    readonly roster: ReadonlyArray<CouncilSeatAssignment>;
    readonly runtimeMode?: RuntimeMode;
    readonly interactionMode?: ProviderInteractionMode;
  }) =>
    Effect.gen(function* () {
      const {
        councilId,
        threadId,
        projectId,
        userPrompt,
        mode,
        ctx,
        roster,
        runtimeMode,
        interactionMode,
      } = input;
      const allIdentityTokens = roster.flatMap((s) => [
        s.targetModel.modelId,
        s.targetModel.displayName,
        s.targetModel.providerInstanceId,
      ]);

      let flipBlockedCount = 0;
      let researchRetryCount = 0;
      let targetedRetryFocus: ReadonlyArray<string> = [];
      let latestSynthesisDraft: ParsedSynthesisPayload | null = null;
      const collectedSafeChecks: CouncilAcceptanceCheck[] = [];

      const checkAborted = () => abortedIds.has(councilId);

      // Loop allows at most 1 targeted retry on unresolved P0 or insufficient verified evidence
      while (researchRetryCount <= 1) {
        if (checkAborted()) return;
        flipBlockedCount = 0;

        // Stage 2: BLIND_ROUND_1 (strict physical isolation — parallel execution with zero cross-visibility)
        yield* deps.store.updateSessionState({
          councilId,
          state: "BLIND_ROUND_1",
          researchRetryCount,
        });
        yield* publishThreadUpdate(threadId);

        const r1RawOutputs = yield* runSeatsWithQuorumAndTimeout({
          councilId,
          threadId,
          roundNum: 1,
          retryAttempt: researchRetryCount,
          roster,
          seatTimeoutMs: round1TimeoutMs,
          buildPrompt: (seat) =>
            buildBlindRound1Prompt({
              userPrompt,
              seat,
              workspaceSummary: ctx.workspaceSummary,
              mode,
              ...(targetedRetryFocus.length > 0 ? { targetedRetryFocus } : {}),
            }),
          invokeSeat: (seat, prompt, hooks) =>
            deps.runSeatTurn({
              councilId,
              threadId,
              projectId,
              projectRoot: ctx.projectRoot,
              seat,
              roundNum: 1,
              retryAttempt: researchRetryCount,
              ...(runtimeMode ? { runtimeMode } : {}),
              ...(interactionMode ? { interactionMode } : {}),
              prompt,
              onPartialOutput: hooks.onPartialOutput,
              onActivity: hooks.onActivity,
            }),
        });

        if (checkAborted()) return;

        // Stage 3: LEDGER_COMMIT_B1 — disk SHA-256 + CodeGraph AST verification
        yield* deps.store.updateSessionState({ councilId, state: "LEDGER_COMMIT_B1" });
        yield* publishThreadUpdate(threadId);

        const r1Handles = assignDynamicAnonHandles({
          councilId,
          roundNum: 1,
          seatIds: roster.map((s) => s.seatId),
          secretSalt: `${councilId}:r1:${researchRetryCount}`,
        });

        const r1LedgerEntries: EvidenceLedgerEntry[] = [];
        const r1Claims: CouncilClaimNode[] = [];
        const r1ClaimBySeat = new Map<string, CouncilClaimNode>();

        for (const item of r1RawOutputs) {
          const parsed = parseProposalEnvelope(item.output, "t3_council_proposal", item.seat, 1);
          for (const cmd of parsed.acceptanceCommands) {
            const safe = parseSafeCommandString(cmd);
            if (safe) collectedSafeChecks.push(safe);
          }

          const seatEvidence: EvidenceLedgerEntry[] = [];
          for (let evIdx = 0; evIdx < parsed.evidence.length; evIdx += 1) {
            const cand = parsed.evidence[evIdx]!;
            const verified = yield* Effect.promise(() =>
              verifyEvidenceEntryOnDisk(ctx.projectRoot, {
                evidenceId: `ev_${councilId.slice(-6)}_r1_${researchRetryCount}_${item.seat.seatId}_${evIdx}`,
                councilId,
                submittedBySeatId: item.seat.seatId,
                roundNum: 1,
                filePath: cand.filePath,
                startLine: cand.startLine,
                endLine: cand.endLine,
                astSymbol: cand.astSymbol,
              }),
            );
            seatEvidence.push(verified);
            r1LedgerEntries.push(verified);
          }

          const isEcho = !item.ok || isTemplatePlaceholderEcho(parsed.statementKo);
          const seatLedgerMap = new Map(seatEvidence.map((e) => [e.evidenceId, e]));
          const evIds = isEcho ? [] : seatEvidence.map((e) => e.evidenceId);
          const { opinion, exactCount, shiftedCount } = computeSubjectiveOpinion({
            evidenceIds: evIds,
            ledgerMap: seatLedgerMap,
          });

          const claim: CouncilClaimNode = {
            claimId: `clm_${councilId.slice(-6)}_r1_${researchRetryCount}_${item.seat.seatId}`,
            councilId,
            authorSeatId: item.seat.seatId,
            anonHandle: r1Handles.get(item.seat.seatId) ?? "Proposal-1",
            roundNum: 1,
            claimKind: parsed.claimKind,
            severity: parsed.severity,
            targetClaimId: null,
            responseTaxonomy: "INITIAL",
            stanceHash: computeStanceHash({
              proposedDiffSketch: parsed.proposedDiffSketch,
              evidenceEntries: isEcho ? [] : seatEvidence,
            }),
            statementKo: scrubIdentityLeaks(parsed.statementKo, allIdentityTokens),
            proposedDiffSketch: parsed.proposedDiffSketch
              ? scrubIdentityLeaks(parsed.proposedDiffSketch, allIdentityTokens)
              : null,
            evidenceIds: evIds,
            subjectiveOpinion: opinion,
            status: !isEcho && exactCount + shiftedCount > 0 ? "ACTIVE" : "REJECTED_NO_EVIDENCE",
          };
          r1Claims.push(claim);
          r1ClaimBySeat.set(item.seat.seatId, claim);
        }

        yield* deps.store.appendEvidenceEntries(r1LedgerEntries);
        yield* deps.store.upsertClaims(r1Claims);

        if (checkAborted()) return;

        // Stage 4: ANON_CRITIQUE_ROUND_2 — dynamic HMAC-SHA256 `Proposal-1..M` anonymization
        yield* deps.store.updateSessionState({ councilId, state: "ANON_CRITIQUE_ROUND_2" });
        yield* publishThreadUpdate(threadId);

        const r2Handles = assignDynamicAnonHandles({
          councilId,
          roundNum: 2,
          seatIds: roster.map((s) => s.seatId),
          secretSalt: `${councilId}:r2:${researchRetryCount}`,
        });

        const r1LedgerMap = new Map(r1LedgerEntries.map((e) => [e.evidenceId, e]));
        const anonymizedProposals: AnonymizedProposalCard[] = r1Claims
          .map((claim) => ({
            anonHandle: r2Handles.get(claim.authorSeatId) ?? claim.anonHandle,
            claimId: claim.claimId,
            claimKind: claim.claimKind,
            statementKo: scrubIdentityLeaks(claim.statementKo, allIdentityTokens),
            proposedDiffSketch: claim.proposedDiffSketch
              ? scrubIdentityLeaks(claim.proposedDiffSketch, allIdentityTokens)
              : null,
            verifiedEvidence: claim.evidenceIds
              .map((id) => r1LedgerMap.get(id))
              .filter(
                (e): e is EvidenceLedgerEntry =>
                  e !== undefined &&
                  (e.verificationStatus === "VERIFIED_EXACT" ||
                    e.verificationStatus === "VERIFIED_SHIFTED"),
              )
              .map((e) => ({
                evidenceId: e.evidenceId,
                filePath: e.filePath,
                startLine: e.startLine,
                endLine: e.endLine,
                astSymbol: e.astSymbol,
                excerptSha256Short: e.excerptSha256.slice(0, 8),
                status: e.verificationStatus,
              })),
          }))
          .sort((a, b) => a.anonHandle.localeCompare(b.anonHandle));

        const r2RawOutputs = yield* runSeatsWithQuorumAndTimeout({
          councilId,
          threadId,
          roundNum: 2,
          retryAttempt: researchRetryCount,
          roster,
          seatTimeoutMs: round2TimeoutMs,
          buildPrompt: (seat) =>
            buildAnonymizedRound2Prompt({
              userPrompt,
              seat,
              ownAnonHandle: r2Handles.get(seat.seatId) ?? "Proposal-1",
              ownRound1Claim: r1ClaimBySeat.get(seat.seatId) ?? null,
              anonymizedProposals,
              mode,
            }),
          invokeSeat: (seat, prompt, hooks) =>
            deps.runSeatTurn({
              councilId,
              threadId,
              projectId,
              projectRoot: ctx.projectRoot,
              seat,
              roundNum: 2,
              retryAttempt: researchRetryCount,
              ...(runtimeMode ? { runtimeMode } : {}),
              ...(interactionMode ? { interactionMode } : {}),
              prompt,
              onPartialOutput: hooks.onPartialOutput,
              onActivity: hooks.onActivity,
            }),
        });

        if (checkAborted()) return;

        // Stage 5: LEDGER_COMMIT_B2 — Evidence-Gated Flip blocking + DAG cycle check + SL scoring
        yield* deps.store.updateSessionState({ councilId, state: "LEDGER_COMMIT_B2" });
        yield* publishThreadUpdate(threadId);

        const r2LedgerEntries: EvidenceLedgerEntry[] = [];
        const r2ClaimsRaw: CouncilClaimNode[] = [];

        for (const item of r2RawOutputs) {
          const parsed = parseProposalEnvelope(item.output, "t3_council_critique", item.seat, 2);
          const seatEvidence: EvidenceLedgerEntry[] = [];
          for (let evIdx = 0; evIdx < parsed.evidence.length; evIdx += 1) {
            const cand = parsed.evidence[evIdx]!;
            const verified = yield* Effect.promise(() =>
              verifyEvidenceEntryOnDisk(ctx.projectRoot, {
                evidenceId: `ev_${councilId.slice(-6)}_r2_${researchRetryCount}_${item.seat.seatId}_${evIdx}`,
                councilId,
                submittedBySeatId: item.seat.seatId,
                roundNum: 2,
                filePath: cand.filePath,
                startLine: cand.startLine,
                endLine: cand.endLine,
                astSymbol: cand.astSymbol,
              }),
            );
            seatEvidence.push(verified);
            r2LedgerEntries.push(verified);
          }

          const combinedLedger = new Map<string, EvidenceLedgerEntry>([
            ...r1LedgerMap.entries(),
            ...seatEvidence.map((e) => [e.evidenceId, e] as const),
          ]);
          const isEcho = !item.ok || isTemplatePlaceholderEcho(parsed.statementKo);
          const ownR1 = r1ClaimBySeat.get(item.seat.seatId);
          const combinedEvIds = isEcho
            ? []
            : [...(ownR1?.evidenceIds ?? []), ...seatEvidence.map((e) => e.evidenceId)];
          const uniqueEvIds = [...new Set(combinedEvIds)];
          const candidateEvEntries = uniqueEvIds
            .map((id) => combinedLedger.get(id))
            .filter((e): e is EvidenceLedgerEntry => e !== undefined);

          const candidateClaim: CouncilClaimNode = {
            claimId: `clm_${councilId.slice(-6)}_r2_${researchRetryCount}_${item.seat.seatId}`,
            councilId,
            authorSeatId: item.seat.seatId,
            anonHandle: r2Handles.get(item.seat.seatId) ?? "Proposal-1",
            roundNum: 2,
            claimKind: parsed.claimKind,
            severity: parsed.severity,
            targetClaimId: parsed.targetClaimId,
            responseTaxonomy: parsed.responseTaxonomy,
            stanceHash: computeStanceHash({
              proposedDiffSketch: parsed.proposedDiffSketch,
              evidenceEntries: candidateEvEntries,
            }),
            statementKo: scrubIdentityLeaks(parsed.statementKo, allIdentityTokens),
            proposedDiffSketch: parsed.proposedDiffSketch
              ? scrubIdentityLeaks(parsed.proposedDiffSketch, allIdentityTokens)
              : null,
            evidenceIds: uniqueEvIds,
            subjectiveOpinion: { belief: 0, disbelief: 0, uncertainty: 1, baseRate: 0.5 },
            status: isEcho ? "REJECTED_NO_EVIDENCE" : "ACTIVE",
          };

          if (isEcho) {
            r2ClaimsRaw.push(candidateClaim);
          } else if (ownR1 && candidateClaim.claimKind !== "CONTRARIAN_CHALLENGE") {
            const flipEval = enforceEvidenceGatedFlipRule({
              round1Claim: ownR1,
              round2Candidate: candidateClaim,
              verifiedLedgerMap: combinedLedger,
            });
            if (flipEval.flipBlocked) {
              flipBlockedCount += 1;
              // Record the blocked R2 claim clearly while keeping R1 stance intact
              r2ClaimsRaw.push({
                ...candidateClaim,
                status: "FLIP_BLOCKED",
                subjectiveOpinion: ownR1.subjectiveOpinion,
              });
            } else {
              r2ClaimsRaw.push(flipEval.acceptedClaim);
            }
          } else {
            const { opinion, exactCount, shiftedCount } = computeSubjectiveOpinion({
              evidenceIds: uniqueEvIds,
              ledgerMap: combinedLedger,
            });
            r2ClaimsRaw.push({
              ...candidateClaim,
              subjectiveOpinion: opinion,
              status: exactCount + shiftedCount > 0 ? "ACTIVE" : "REJECTED_NO_EVIDENCE",
            });
          }
        }

        // Break any accidental cyclic targetClaimId links before persistence
        const allSoFar = [...r1Claims, ...r2ClaimsRaw];
        const cyclicSet = new Set(detectClaimDagCycles(allSoFar));
        const r2ClaimsSanitized = r2ClaimsRaw.map((c) =>
          cyclicSet.has(c.claimId) ? { ...c, targetClaimId: null } : c,
        );

        yield* deps.store.appendEvidenceEntries(r2LedgerEntries);
        yield* deps.store.upsertClaims(r2ClaimsSanitized);
        yield* deps.store.updateSessionState({
          councilId,
          state: "ARBITER_SYNTHESIS_B3",
          flipBlockedCount,
        });
        yield* publishThreadUpdate(threadId);

        if (checkAborted()) return;

        // Stage 6: ARBITER_SYNTHESIS_B3 — check P0 challenges & verified evidence sufficiency
        const snap = yield* deps.store.getSessionSnapshot(councilId);
        if (!snap) return;

        const fullLedgerMap = new Map(snap.ledgerEntries.map((e) => [e.evidenceId, e]));
        const verifiedLedger = snap.ledgerEntries.filter(
          (e) =>
            e.verificationStatus === "VERIFIED_EXACT" ||
            e.verificationStatus === "VERIFIED_SHIFTED",
        );
        const unresolvedP0 = findUnresolvedP0Challenges({
          roster,
          claims: snap.claims,
          ledgerMap: fullLedgerMap,
          maxChallengeRound: 1,
        });
        const lateRound2Notes = findUnresolvedP0Challenges({
          roster,
          claims: snap.claims,
          ledgerMap: fullLedgerMap,
        })
          .filter((c) => c.roundNum === 2)
          .map((c) => c.statementKo);

        // Bounded 1-time targeted retry if Round-1 P0 unresolved or zero verified evidence
        if ((unresolvedP0.length > 0 || verifiedLedger.length === 0) && researchRetryCount < 1) {
          researchRetryCount += 1;
          targetedRetryFocus =
            unresolvedP0.length > 0
              ? unresolvedP0.map(
                  (c) => `P0 반론 해소 필요(${c.claimId}): ${c.statementKo.slice(0, 180)}`,
                )
              : ["실존 파일 경로와 정확한 라인 범위의 검증 가능한 코드 근거가 0건입니다."];
          continue;
        }

        if (verifiedLedger.length === 0) {
          yield* deps.store.updateSessionState({
            councilId,
            state: "ABORTED",
            flipBlockedCount,
            researchRetryCount,
            errorMessage:
              "표적 재탐색 후에도 디스크 검증을 통과한 코드 근거가 0건이어서 위원회를 중단했습니다.",
          });
          yield* publishThreadUpdate(threadId);
          return;
        }

        // Invoke Chair (CHAIR_ARBITER) to synthesize verified claims
        const chairSeat = roster.find((s) => s.assignedRole === "CHAIR_ARBITER") ?? roster[0]!;
        const verifiedClaims = snap.claims
          .filter((c) => c.status === "ACTIVE" || c.status === "ACCEPTED")
          .sort((a, b) => b.subjectiveOpinion.belief - a.subjectiveOpinion.belief);

        const synthStartMs = Date.now();
        setSeatProgress(councilId, {
          seatId: chairSeat.seatId,
          roundNum: 3,
          state: "running",
          startedAtMs: synthStartMs,
          finishedAtMs: null,
          elapsedMs: 0,
          errorMessage: null,
        });
        yield* publishThreadUpdate(threadId);

        const synthRawOpt = yield* deps
          .runSeatTurn({
            councilId,
            threadId,
            projectId,
            projectRoot: ctx.projectRoot,
            seat: chairSeat,
            roundNum: 3,
            retryAttempt: researchRetryCount,
            ...(runtimeMode ? { runtimeMode } : {}),
            ...(interactionMode ? { interactionMode } : {}),
            prompt: buildArbiterSynthesisPrompt({
              userPrompt,
              verifiedClaims,
              verifiedLedger,
              unresolvedChallenges: unresolvedP0,
              mode,
            }),
          })
          .pipe(
            Effect.timeoutOption(Duration.millis(round3TimeoutMs)),
            Effect.catch(() => Effect.succeed(Option.none<string>())),
          );
        const synthRaw = Option.isSome(synthRawOpt) ? synthRawOpt.value : "";

        let parsedSynthesis = parseSynthesisEnvelope(synthRaw);
        // 1-time deterministic JSON repair retry if Chair returned prose without valid <t3_council_synthesis> JSON
        if (!parsedSynthesis && synthRaw.trim().length > 0 && !checkAborted()) {
          const repairedOpt = yield* deps
            .runSeatTurn({
              councilId,
              threadId,
              projectId,
              projectRoot: ctx.projectRoot,
              seat: chairSeat,
              roundNum: 3,
              retryAttempt: researchRetryCount + 10,
              ...(runtimeMode ? { runtimeMode } : {}),
              ...(interactionMode ? { interactionMode } : {}),
              prompt: buildSynthesisRepairPrompt(synthRaw, mode),
            })
            .pipe(
              Effect.timeoutOption(Duration.millis(Math.min(60_000, round3TimeoutMs))),
              Effect.catch(() => Effect.succeed(Option.none<string>())),
            );
          if (Option.isSome(repairedOpt)) {
            parsedSynthesis = parseSynthesisEnvelope(repairedOpt.value);
          }
        }

        const synthFinishMs = Date.now();
        setSeatProgress(councilId, {
          seatId: chairSeat.seatId,
          roundNum: 3,
          state: Option.isSome(synthRawOpt) ? "completed" : "timed_out",
          startedAtMs: synthStartMs,
          finishedAtMs: synthFinishMs,
          elapsedMs: Math.max(0, synthFinishMs - synthStartMs),
          errorMessage: Option.isSome(synthRawOpt) ? null : "의장 합성 제한 시간 초과",
        });

        const fallbackSummary =
          verifiedClaims
            .slice(0, 3)
            .map((c, idx) => `${idx + 1}. ${c.statementKo}`)
            .join("\n\n") || "검증된 근거를 기반으로 합의 요약을 구성했습니다.";

        latestSynthesisDraft = parsedSynthesis ?? {
          titleKo: cleanFallbackTitle(userPrompt, verifiedClaims[0]?.statementKo),
          executiveSummaryKo: fallbackSummary,
          acceptedClaimIds: verifiedClaims.slice(0, 4).map((c) => c.claimId),
          targetFiles: [],
          acceptanceChecks: collectedSafeChecks.slice(0, 4),
          unresolvedDisagreementsKo: [
            ...unresolvedP0.map((c) => c.statementKo),
            ...lateRound2Notes,
          ],
          uniqueFindingsKo: [],
        };

        const mergedDisagreements = [
          ...new Set([
            ...latestSynthesisDraft.unresolvedDisagreementsKo,
            ...unresolvedP0.map((c) => c.statementKo),
            ...lateRound2Notes,
          ]),
        ];

        // Mark accepted claims
        const acceptedSet = new Set(latestSynthesisDraft.acceptedClaimIds);
        const acceptedClaims = snap.claims
          .filter((c) => acceptedSet.has(c.claimId) && c.status === "ACTIVE")
          .map((c) => ({ ...c, status: "ACCEPTED" as const }));
        if (acceptedClaims.length > 0) {
          yield* deps.store.upsertClaims(acceptedClaims);
        }

        const synthesisReportMarkdown = buildCouncilSynthesisMarkdown({
          mode,
          seatCount: roster.length,
          titleKo: latestSynthesisDraft.titleKo,
          executiveSummaryKo: latestSynthesisDraft.executiveSummaryKo,
          verifiedEvidence: verifiedLedger,
          flipBlockedCount,
          uniqueFindingsKo: latestSynthesisDraft.uniqueFindingsKo,
          unresolvedDisagreementsKo: mergedDisagreements,
        });

        // Discussion mode: never block on code-patch AWAITING_OVERRIDE or promote a PinnedSpec.
        // Any remaining P0 disagreements are surfaced transparently inside `mergedDisagreements`.
        if (mode === "discussion") {
          yield* deps.store.updateSessionState({
            councilId,
            state: "COMPLETED",
            flipBlockedCount,
            researchRetryCount,
            synthesisReportMarkdown,
            errorMessage: null,
          });
          if (deps.publishTimelineReport) {
            yield* deps
              .publishTimelineReport({
                councilId,
                threadId,
                markdown: synthesisReportMarkdown,
              })
              .pipe(Effect.catch(() => Effect.void));
          }
          yield* publishThreadUpdate(threadId);
          return;
        }

        // Code-patch mode: if Round-1 P0 remains unresolved after retry, hold at AWAITING_OVERRIDE
        // while preserving the Chair's synthesized report in SQLite.
        if (unresolvedP0.length > 0) {
          yield* deps.store.updateSessionState({
            councilId,
            state: "AWAITING_OVERRIDE",
            flipBlockedCount,
            researchRetryCount,
            synthesisReportMarkdown,
            errorMessage: `미해결 P0 의무 반론 ${unresolvedP0.length}건이 남아 있습니다. 검토 후 보류 승인 또는 중단을 선택하세요.`,
          });
          yield* publishThreadUpdate(threadId);
          return;
        }

        // Stage 7 (`code_patch` mode): Promote verified synthesis to immutable PinnedSpec (+ PinnedSpecGate 1:1 pin)
        yield* provideOptionalSql(
          promoteCouncilToPinnedSpec({
            store: deps.store,
            councilId,
            threadId,
            projectId,
            projectRoot: ctx.projectRoot,
            roster,
            claims: snap.claims,
            ledgerEntries: snap.ledgerEntries,
            titleKo: latestSynthesisDraft.titleKo,
            executiveSummaryKo: latestSynthesisDraft.executiveSummaryKo,
            acceptedClaimIds: latestSynthesisDraft.acceptedClaimIds,
            targetFileCandidates: latestSynthesisDraft.targetFiles,
            acceptanceChecks:
              latestSynthesisDraft.acceptanceChecks.length > 0
                ? latestSynthesisDraft.acceptanceChecks
                : collectedSafeChecks,
            unresolvedDisagreementsKo: mergedDisagreements,
            uniqueFindingsKo: latestSynthesisDraft.uniqueFindingsKo,
          }),
        );

        yield* deps.store.updateSessionState({
          councilId,
          state: "PINNED_READY",
          flipBlockedCount,
          researchRetryCount,
          synthesisReportMarkdown,
          errorMessage: null,
        });
        if (deps.publishTimelineReport) {
          yield* deps
            .publishTimelineReport({
              councilId,
              threadId,
              markdown: synthesisReportMarkdown,
            })
            .pipe(Effect.catch(() => Effect.void));
        }
        yield* publishThreadUpdate(threadId);
        return;
      }
    }).pipe(
      Effect.catch((error) =>
        deps.store
          .updateSessionState({
            councilId: input.councilId,
            state: "ABORTED",
            errorMessage:
              error instanceof CouncilError
                ? error.message
                : `위원회 실행 오류: ${error instanceof Error ? error.message : String(error)}`,
          })
          .pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                unifiedExecutionLedger.finish({
                  executionId: input.councilId,
                  executionKind: "council",
                  status: "failed",
                  errorMessage:
                    error instanceof CouncilError
                      ? error.message
                      : `위원회 실행 오류: ${error instanceof Error ? error.message : String(error)}`,
                });
              }),
            ),
            Effect.andThen(publishThreadUpdate(input.threadId)),
            Effect.catch(() => Effect.void),
          ),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          unifiedExecutionLedger.finish({
            executionId: input.councilId,
            executionKind: "council",
            status: abortedIds.has(input.councilId) ? "cancelled" : "completed",
          });
          runningFibers.delete(input.councilId);
          abortedIds.delete(input.councilId);
        }),
      ),
    );

  const service: CouncilOrchestratorShape = {
    triage: Effect.fn("CouncilOrchestrator.triage")(function* (input) {
      const ctx = yield* deps.resolveContext({
        threadId: input.threadId,
        projectId: input.projectId,
      });
      const evalResult = evaluateCouncilTriage({ userPrompt: input.userPrompt });
      const topDirs = yield* Effect.promise(() => listTopLevelDirectories(ctx.projectRoot));
      const previewRoster = resolveDynamicCouncilRoster({
        activeChatChair: ctx.chairModel,
        configuredSubordinates: ctx.configuredSubordinates,
        fallbackCandidates: ctx.fallbackCandidates,
        assessTargetHealth: ctx.assessTargetHealth,
        topLevelDirs: topDirs,
      });
      return {
        score: evalResult.score,
        recommendation: evalResult.recommendation,
        reasons: [...evalResult.reasons],
        activeSubordinateCount: ctx.configuredSubordinates.filter((s) => s.enabled).length,
        previewRoster: [...previewRoster],
      };
    }),

    startAutoSeat: Effect.fn("CouncilOrchestrator.startAutoSeat")(function* (input) {
      yield* Effect.annotateCurrentSpan({
        "t3.thread_id": input.threadId,
        "t3.project_id": input.projectId,
      });
      const ctx = yield* deps.resolveContext({
        threadId: input.threadId,
        projectId: input.projectId,
      });
      const triage = evaluateCouncilTriage({
        userPrompt: input.userPrompt,
        forceCouncil: input.forceCouncil,
      });
      const topDirs = yield* Effect.promise(() => listTopLevelDirectories(ctx.projectRoot));

      const configuredSubordinates: ReadonlyArray<ConfiguredSubordinateSlot> =
        input.overrideSubordinateTargets !== undefined
          ? input.overrideSubordinateTargets.map((target) => ({
              target,
              enabled: true,
            }))
          : ctx.configuredSubordinates;

      const roster = resolveDynamicCouncilRoster({
        activeChatChair: ctx.chairModel,
        configuredSubordinates,
        fallbackCandidates: ctx.fallbackCandidates,
        assessTargetHealth: ctx.assessTargetHealth,
        topLevelDirs: topDirs,
      });

      // Guard against duplicate concurrent council sessions in the same thread
      const recentInThread = yield* deps.store
        .listThreadSessions(input.threadId, 5)
        .pipe(Effect.catch(() => Effect.succeed<ReadonlyArray<CouncilSessionSnapshot>>([])));
      const activeDuplicate = recentInThread.find(
        (s) => IN_FLIGHT_COUNCIL_STATES.has(s.state) && runningFibers.has(s.councilId),
      );
      if (activeDuplicate) {
        return yield* Effect.fail(
          new CouncilError({
            code: "INVALID_STATE",
            message: `이 대화방에서 이미 다자간 위원회(${activeDuplicate.councilId.slice(-6)})가 실행 중입니다. 완료 또는 중단 후 다시 소집해 주세요.`,
          }),
        );
      }

      const effectiveMode = resolveEffectiveCouncilMode(
        input.userPrompt,
        input.mode as CouncilMode | undefined,
      );
      const councilId = `cnc_${NodeCrypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
      yield* Effect.annotateCurrentSpan({
        "t3.council_id": councilId,
        "t3.execution_kind": "council",
        "t3.execution_id": councilId,
      });
      const nowMs = Date.now();

      yield* deps.store
        .createSession({
          councilId,
          threadId: input.threadId,
          projectId: input.projectId,
          userPrompt: input.userPrompt,
          mode: effectiveMode,
          chairModel: ctx.chairModel,
          roster,
          state: "AUTO_SEATING",
          triageScore: triage.score,
          nowMs,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new CouncilError({
                code: "EXECUTION_FAILED",
                message: `위원회 세션 생성 실패: ${String(cause)}`,
              }),
          ),
        );

      unifiedExecutionLedger.begin({
        executionId: councilId,
        executionKind: "council",
        threadId: input.threadId,
        projectId: input.projectId,
        summary: `다자간 위원회 (${roster.length}석): ${input.userPrompt.slice(0, 80)}`,
        provider: ctx.chairModel.driverId,
        model: ctx.chairModel.modelId,
        startedAtMs: nowMs,
      });

      yield* publishThreadUpdate(input.threadId);

      const effectiveRuntimeMode = input.runtimeMode ?? ctx.runtimeMode;
      const effectiveInteractionMode = input.interactionMode ?? ctx.interactionMode;

      const fiber = yield* Effect.forkDetach(
        runCouncilPipeline({
          councilId,
          threadId: input.threadId,
          projectId: input.projectId,
          userPrompt: input.userPrompt,
          mode: effectiveMode,
          ctx,
          roster,
          ...(effectiveRuntimeMode ? { runtimeMode: effectiveRuntimeMode } : {}),
          ...(effectiveInteractionMode ? { interactionMode: effectiveInteractionMode } : {}),
        }),
      );
      runningFibers.set(councilId, fiber);

      const snap = yield* deps.store.getSessionSnapshot(councilId).pipe(
        Effect.mapError(
          (cause) =>
            new CouncilError({
              code: "EXECUTION_FAILED",
              message: `세션 조회 실패: ${String(cause)}`,
            }),
        ),
      );
      if (!snap) {
        return yield* Effect.fail(
          new CouncilError({
            code: "NOT_FOUND",
            message: "방금 생성한 위원회 세션을 찾지 못했습니다.",
          }),
        );
      }
      return enrichSnapshot(snap);
    }),

    getSession: Effect.fn("CouncilOrchestrator.getSession")(function* (councilId) {
      const snap = yield* deps.store
        .getSessionSnapshot(councilId)
        .pipe(
          Effect.mapError(
            (cause) =>
              new CouncilError({
                code: "EXECUTION_FAILED",
                message: `세션 조회 실패: ${String(cause)}`,
              }),
          ),
        );
      if (!snap) {
        return yield* Effect.fail(
          new CouncilError({
            code: "NOT_FOUND",
            message: `위원회 세션 '${councilId}'을(를) 찾을 수 없습니다.`,
          }),
        );
      }
      return enrichSnapshot(snap);
    }),

    listThreadSessions: Effect.fn("CouncilOrchestrator.listThreadSessions")(
      function* (threadId, limit) {
        return yield* deps.store.listThreadSessions(threadId, limit).pipe(
          Effect.map((list) => list.map(enrichSnapshot)),
          Effect.mapError(
            (cause) =>
              new CouncilError({
                code: "EXECUTION_FAILED",
                message: `위원회 목록 조회 실패: ${String(cause)}`,
              }),
          ),
        );
      },
    ),

    approveOverride: Effect.fn("CouncilOrchestrator.approveOverride")(function* (input) {
      const snap = yield* service.getSession(input.councilId);
      if (snap.state !== "AWAITING_OVERRIDE") {
        return yield* Effect.fail(
          new CouncilError({
            code: "INVALID_STATE",
            message: `보류 승인은 AWAITING_OVERRIDE 상태에서만 가능합니다 (현재: ${snap.state}).`,
          }),
        );
      }
      const verifiedClaims = snap.claims
        .filter((c) => c.status === "ACTIVE" || c.status === "ACCEPTED")
        .sort((a, b) => b.subjectiveOpinion.belief - a.subjectiveOpinion.belief);

      // Discussion-mode sessions must NEVER be converted into code-patch PinnedSpecs on override
      if (snap.mode === "discussion") {
        const verifiedLedger = snap.ledgerEntries.filter(
          (e) =>
            e.verificationStatus === "VERIFIED_EXACT" ||
            e.verificationStatus === "VERIFIED_SHIFTED",
        );
        const markdown =
          snap.synthesisReportMarkdown ??
          buildCouncilSynthesisMarkdown({
            mode: "discussion",
            seatCount: snap.roster.length,
            titleKo: cleanFallbackTitle(snap.userPrompt, verifiedClaims[0]?.statementKo),
            executiveSummaryKo:
              verifiedClaims[0]?.statementKo ??
              `사용자 보류 승인(${input.reason})으로 확정된 분석·토론 보고서입니다.`,
            verifiedEvidence: verifiedLedger,
            flipBlockedCount: snap.flipBlockedCount,
            uniqueFindingsKo: [],
            unresolvedDisagreementsKo: [],
          });
        yield* deps.store
          .updateSessionState({
            councilId: snap.councilId,
            state: "COMPLETED",
            synthesisReportMarkdown: markdown,
            errorMessage: null,
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new CouncilError({
                  code: "EXECUTION_FAILED",
                  message: `상태 갱신 실패: ${String(cause)}`,
                }),
            ),
          );
        if (deps.publishTimelineReport) {
          yield* deps
            .publishTimelineReport({
              councilId: snap.councilId,
              threadId: snap.threadId,
              markdown,
            })
            .pipe(Effect.catch(() => Effect.void));
        }
        yield* publishThreadUpdate(snap.threadId);
        return yield* service.getSession(snap.councilId);
      }

      const ctx = yield* deps.resolveContext({
        threadId: snap.threadId,
        projectId: snap.projectId,
      });

      yield* provideOptionalSql(
        promoteCouncilToPinnedSpec({
          store: deps.store,
          councilId: snap.councilId,
          threadId: snap.threadId,
          projectId: snap.projectId,
          projectRoot: ctx.projectRoot,
          roster: snap.roster,
          claims: snap.claims,
          ledgerEntries: snap.ledgerEntries,
          titleKo: snap.userPrompt.slice(0, 80) || "다자간 위원회 보류 승인 명세",
          executiveSummaryKo:
            snap.synthesisReportMarkdown ??
            verifiedClaims[0]?.statementKo ??
            `사용자 보류 승인(${input.reason})으로 고정된 실행 명세입니다.`,
          acceptedClaimIds: verifiedClaims.slice(0, 4).map((c) => c.claimId),
          targetFileCandidates: [],
          acceptanceChecks: [],
          unresolvedDisagreementsKo: [],
          uniqueFindingsKo: [],
          allowP0Override: true,
          overrideReason: input.reason,
        }),
      );

      yield* deps.store
        .updateSessionState({
          councilId: snap.councilId,
          state: "PINNED_READY",
          errorMessage: null,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new CouncilError({
                code: "EXECUTION_FAILED",
                message: `상태 갱신 실패: ${String(cause)}`,
              }),
          ),
        );
      yield* publishThreadUpdate(snap.threadId);
      return yield* service.getSession(snap.councilId);
    }),

    executePinnedSpec: Effect.fn("CouncilOrchestrator.executePinnedSpec")(function* (input) {
      yield* Effect.annotateCurrentSpan({
        "t3.pinned_spec_id": input.pinnedSpecId,
      });
      const spec = yield* deps.store
        .getPinnedSpec(input.pinnedSpecId)
        .pipe(
          Effect.mapError(
            (cause) =>
              new CouncilError({
                code: "EXECUTION_FAILED",
                message: `PinnedSpec 조회 실패: ${String(cause)}`,
              }),
          ),
        );
      if (!spec) {
        return yield* Effect.fail(
          new CouncilError({
            code: "NOT_FOUND",
            message: `PinnedSpec '${input.pinnedSpecId}'을(를) 찾을 수 없습니다.`,
          }),
        );
      }
      const snap = yield* service.getSession(spec.councilId);
      yield* Effect.annotateCurrentSpan({
        "t3.thread_id": snap.threadId,
        "t3.project_id": snap.projectId,
        "t3.council_id": spec.councilId,
      });
      const ctx = yield* deps.resolveContext({
        threadId: snap.threadId,
        projectId: snap.projectId,
      });

      const execKey = `exec:${spec.councilId}`;
      const execFiber = yield* Effect.forkDetach(
        provideOptionalSql(
          executePinnedSpecWithCasAndGate({
            store: deps.store,
            request: input,
            projectRoot: ctx.projectRoot,
            roster: snap.roster,
            isTargetHealthy: (target) => ctx.assessTargetHealth(target).healthy,
            ...(deps.provisionWorktree ? { provisionWorktree: deps.provisionWorktree } : {}),
            launchWorker: deps.launchWorker,
            ...(deps.runIndependentChecker
              ? { runIndependentChecker: deps.runIndependentChecker }
              : {}),
            onStateChange: () => publishThreadUpdate(snap.threadId),
          }),
        ).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              runningFibers.delete(execKey);
            }),
          ),
        ),
      );
      runningFibers.set(execKey, execFiber);
      const result = yield* Fiber.join(execFiber);
      yield* publishThreadUpdate(snap.threadId);
      return result;
    }),

    reverifyPinnedSpec: Effect.fn("CouncilOrchestrator.reverifyPinnedSpec")(function* (input) {
      yield* Effect.annotateCurrentSpan({
        "t3.pinned_spec_id": input.pinnedSpecId,
      });
      const spec = yield* deps.store
        .getPinnedSpec(input.pinnedSpecId)
        .pipe(
          Effect.mapError(
            (cause) =>
              new CouncilError({
                code: "EXECUTION_FAILED",
                message: `PinnedSpec 조회 실패: ${String(cause)}`,
              }),
          ),
        );
      if (!spec) {
        return yield* Effect.fail(
          new CouncilError({
            code: "NOT_FOUND",
            message: `PinnedSpec '${input.pinnedSpecId}'을(를) 찾을 수 없습니다.`,
          }),
        );
      }
      if (spec.delegatedTaskId !== null) {
        return yield* Effect.fail(
          new CouncilError({
            code: "INVALID_STATE",
            message: "이미 실행에 착수한 PinnedSpec은 파일 잠금을 재갱신할 수 없습니다.",
          }),
        );
      }
      const snap = yield* service.getSession(spec.councilId);
      yield* Effect.annotateCurrentSpan({
        "t3.thread_id": snap.threadId,
        "t3.project_id": snap.projectId,
        "t3.council_id": spec.councilId,
      });
      const ctx = yield* deps.resolveContext({
        threadId: snap.threadId,
        projectId: snap.projectId,
      });

      const refreshedLocks = yield* Effect.promise(() =>
        buildVerifiedTargetFileLocks({
          projectRoot: ctx.projectRoot,
          candidates: spec.targetFilesLock.map((l) => ({
            filePath: l.filePath,
            patchIntentKo: l.patchIntentKo,
            relatedEvidenceIds: l.relatedEvidenceIds,
          })),
          verifiedLedger: snap.ledgerEntries,
        }),
      );
      const mismatches = yield* Effect.promise(() =>
        verifyTargetFileLocksCas(ctx.projectRoot, refreshedLocks),
      );
      if (refreshedLocks.length === 0 || mismatches.length > 0) {
        return yield* Effect.fail(
          new CouncilError({
            code: "STALE_PINNED_SPEC",
            message: "대상 파일을 디스크에서 재검증할 수 없습니다.",
            staleFiles: [...mismatches],
          }),
        );
      }

      const nextHash = computeCouncilSpecHash({
        councilId: spec.councilId,
        titleKo: spec.titleKo,
        targetFilesLock: refreshedLocks,
        acceptanceChecks: spec.acceptanceChecks,
        verifiedEvidenceIds: spec.verifiedEvidenceIds,
      });
      yield* deps.store
        .updatePinnedSpecFileLocks({
          pinnedSpecId: spec.pinnedSpecId,
          targetFilesLock: [...refreshedLocks],
          specHashSha256: nextHash,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new CouncilError({
                code: "EXECUTION_FAILED",
                message: `재검증 저장 실패: ${String(cause)}`,
              }),
          ),
        );

      // Keep 1:1 PinnedSpecGate (`pinned_task_specs`) hash synchronized on explicit pre-execution re-verify
      if (deps.sqlClient) {
        const nowIso = new Date().toISOString();
        const refreshedGateBody = buildPinnedSpecBodyForGate({
          pinnedSpecId: spec.pinnedSpecId,
          titleKo: spec.titleKo,
          executiveSummaryKo: spec.executiveSummaryKo,
          targetFilesLock: refreshedLocks,
          acceptanceChecks: spec.acceptanceChecks,
          verifiedEvidenceIds: spec.verifiedEvidenceIds,
        });
        const refreshedGateHash = computePinnedSpecHash(refreshedGateBody);
        const refreshedGateJson = canonicalJson(refreshedGateBody);
        yield* deps.sqlClient`UPDATE pinned_task_specs
          SET body_json = ${refreshedGateJson},
              spec_hash = ${refreshedGateHash},
              updated_at = ${nowIso}
          WHERE spec_id = ${spec.pinnedSpecId}
            AND executed_run_id IS NULL`.pipe(Effect.catch(() => Effect.void));
        yield* appendHostAuditEntry({
          kind: "spec.pinned",
          actorId: "human",
          actorKind: "human",
          resource: spec.pinnedSpecId,
          payload: {
            councilEvent: "council.spec_reverified",
            councilId: spec.councilId,
            previousSpecHash: spec.specHashSha256,
            nextSpecHash: nextHash,
            refreshedGateHash,
          },
          nowIso,
        }).pipe(
          Effect.provideService(SqlClient.SqlClient, deps.sqlClient),
          Effect.catch(() => Effect.void),
        );
      }

      yield* publishThreadUpdate(snap.threadId);
      return yield* service.getSession(spec.councilId);
    }),

    abort: Effect.fn("CouncilOrchestrator.abort")(function* (input) {
      const snap = yield* service.getSession(input.councilId);
      const abortReason = input.reason ?? "사용자가 다자간 위원회를 중단했습니다.";
      abortedIds.add(input.councilId);
      const fiber = runningFibers.get(input.councilId);
      if (fiber) {
        yield* Fiber.interrupt(fiber).pipe(Effect.catch(() => Effect.void));
        runningFibers.delete(input.councilId);
      }
      const execFiber = runningFibers.get(`exec:${input.councilId}`);
      if (execFiber) {
        yield* Fiber.interrupt(execFiber).pipe(Effect.catch(() => Effect.void));
        runningFibers.delete(`exec:${input.councilId}`);
      }
      if (deps.abortCouncilWorkers) {
        yield* deps
          .abortCouncilWorkers({ councilId: input.councilId, reason: abortReason })
          .pipe(Effect.catch(() => Effect.void));
      }
      unifiedExecutionLedger.finish({
        executionId: input.councilId,
        executionKind: "council",
        status: "cancelled",
        errorMessage: abortReason,
      });
      if (
        snap.pinnedSpec &&
        snap.pinnedSpec.delegatedTaskId !== null &&
        snap.state !== "COMPLETED" &&
        snap.pinnedSpec.specGateOutcome !== "pass"
      ) {
        yield* deps.store
          .releasePinnedSpecExecution({
            pinnedSpecId: snap.pinnedSpec.pinnedSpecId,
            delegatedTaskId: snap.pinnedSpec.delegatedTaskId,
          })
          .pipe(Effect.catch(() => Effect.void));
      }
      yield* deps.store
        .updateSessionState({
          councilId: input.councilId,
          state: "ABORTED",
          errorMessage: input.reason ?? "사용자가 다자간 위원회를 중단했습니다.",
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new CouncilError({
                code: "EXECUTION_FAILED",
                message: `중단 상태 저장 실패: ${String(cause)}`,
              }),
          ),
        );
      yield* publishThreadUpdate(snap.threadId);
      return yield* service.getSession(input.councilId);
    }),

    subscribe: (threadId) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const initial = yield* service.listThreadSessions(threadId, 8);
          const initialEvent: CouncilStreamEvent = {
            kind: "snapshot",
            threadId,
            sessions: [...initial],
            updatedAt: new Date().toISOString(),
          };
          const live = Stream.fromPubSub(pubsub).pipe(
            Stream.filter((event) => event.threadId === threadId),
          );
          return Stream.concat(Stream.succeed(initialEvent), live);
        }),
      ),

    awaitCouncil: Effect.fn("CouncilOrchestrator.awaitCouncil")(function* (councilId) {
      const fiber = runningFibers.get(councilId);
      if (fiber) {
        yield* Fiber.await(fiber);
      }
      return yield* deps.store
        .getSessionSnapshot(councilId)
        .pipe(
          Effect.mapError(
            (cause) =>
              new CouncilError({
                code: "EXECUTION_FAILED",
                message: `세션 대기 실패: ${String(cause)}`,
              }),
          ),
        );
    }),
  };

  return service;
});

export { makeCouncilStore };
