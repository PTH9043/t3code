import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { SpecGateOutcome, SpecProofSummary } from "./pinnedSpec.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

/**
 * Model-Agnostic Multi-Model Council, Shared Code Evidence Ledger & PinnedSpec Execution Contracts.
 *
 * Invariant 1 (Zero Hardcoded Models): No concrete model id literals exist anywhere in this schema.
 * Seats bind dynamically to runtime `ProviderInstanceId` + `ProviderDriverKind` + `modelId`.
 */

const Sha256Hex = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/));
const CouncilSeatId = TrimmedNonEmptyString.check(Schema.isPattern(/^seat_(?:chair|sub_[0-9]+)$/));

/** 1. Model-agnostic dynamic target reference (any runtime provider instance + model id). */
export const ModelTargetRef = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  driverId: ProviderDriverKind,
  modelId: TrimmedNonEmptyString.check(Schema.isMaxLength(160)),
  displayName: TrimmedNonEmptyString.check(Schema.isMaxLength(160)),
});
export type ModelTargetRef = typeof ModelTargetRef.Type;

/** 2. Capability tags used for capability-driven orthogonal role allocation (no model hardcoding). */
export const SubordinateCapabilityTag = Schema.Literals([
  "code_edit",
  "deep_reasoning",
  "fast_critic",
  "ast_json",
  "ko_nuance",
  "local_zero_cost",
]);
export type SubordinateCapabilityTag = typeof SubordinateCapabilityTag.Type;

export const subordinateCapabilityLabels: Record<SubordinateCapabilityTag, string> = {
  code_edit: "코드 수정",
  deep_reasoning: "심층 추론",
  fast_critic: "고속 비평",
  ast_json: "AST·구조 검증",
  ko_nuance: "한국어·계약 감사",
  local_zero_cost: "로컬 저비용",
};

/** 3. Six orthogonal council role archetypes independent of which models occupy the slots. */
export const CouncilRoleArchetype = Schema.Literals([
  "CHAIR_ARBITER",
  "CONTRARIAN_RED",
  "SYSTEM_ARCHITECT",
  "AST_LEDGER_AUDITOR",
  "EDGE_PERF_CRITIC",
  "INTENT_CONTRACT_GUARD",
]);
export type CouncilRoleArchetype = typeof CouncilRoleArchetype.Type;

export const councilRoleArchetypeLabels: Record<CouncilRoleArchetype, string> = {
  CHAIR_ARBITER: "의장 · 최종 합성",
  CONTRARIAN_RED: "의무 반론자 · 레드팀",
  SYSTEM_ARCHITECT: "수석 패치 설계",
  AST_LEDGER_AUDITOR: "원장 · 심볼 대조",
  EDGE_PERF_CRITIC: "경계 · 지연 분석",
  INTENT_CONTRACT_GUARD: "의도 · 계약 감사",
};

/** 4. Dynamically seated participant snapshot (1 Chair + N Subordinates). */
export const CouncilSeatAssignment = Schema.Struct({
  seatId: CouncilSeatId,
  targetModel: ModelTargetRef,
  assignedRole: CouncilRoleArchetype,
  capabilityTags: Schema.Array(SubordinateCapabilityTag),
  /** Sampling diversity offset applied when homogeneous models occupy multiple slots (0.0..0.25). */
  temperatureOffset: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 0.25 })),
  /** True when the underlying driver/model actually accepted the temperature offset. */
  temperatureApplied: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  directoryShardHint: Schema.NullOr(Schema.String.check(Schema.isMaxLength(256))),
  isFallbackSubstituted: Schema.Boolean,
  fallbackReason: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(256))),
  unavailable: Schema.optionalKey(Schema.Boolean),
  unavailableReason: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(500))),
});
export type CouncilSeatAssignment = typeof CouncilSeatAssignment.Type;

/** 5. Deterministic 7-stage FSM states (+ restart recovery & P0 override hold). */
export const CouncilMode = Schema.Literals(["auto", "discussion", "code_patch"]);
export type CouncilMode = typeof CouncilMode.Type;

export const EffectiveCouncilMode = Schema.Literals(["discussion", "code_patch"]);
export type EffectiveCouncilMode = typeof EffectiveCouncilMode.Type;

export const CouncilSeatExecutionState = Schema.Literals([
  "pending",
  "running",
  "completed",
  "timed_out",
  "failed",
]);
export type CouncilSeatExecutionState = typeof CouncilSeatExecutionState.Type;

export const CouncilSeatProgress = Schema.Struct({
  seatId: CouncilSeatId,
  roundNum: Schema.Literals([1, 2, 3]),
  state: CouncilSeatExecutionState,
  startedAtMs: Schema.NullOr(Schema.Number),
  finishedAtMs: Schema.NullOr(Schema.Number),
  elapsedMs: NonNegativeInt,
  errorMessage: Schema.optionalKey(Schema.NullOr(Schema.String.check(Schema.isMaxLength(500)))),
});
export type CouncilSeatProgress = typeof CouncilSeatProgress.Type;

export const CouncilState = Schema.Literals([
  "IDLE",
  "AUTO_SEATING",
  "BLIND_ROUND_1",
  "LEDGER_COMMIT_B1",
  "ANON_CRITIQUE_ROUND_2",
  "LEDGER_COMMIT_B2",
  "ARBITER_SYNTHESIS_B3",
  "AWAITING_OVERRIDE",
  "PINNED_READY",
  "DELEGATED_RUNNING",
  "VERIFYING",
  "COMPLETED",
  "ABORTED",
  "INTERRUPTED_BY_RESTART",
]);
export type CouncilState = typeof CouncilState.Type;

/** 6. Append-only Evidence Ledger verification outcomes (Boundary 1). */
export const EvidenceVerificationStatus = Schema.Literals([
  "VERIFIED_EXACT",
  "VERIFIED_SHIFTED",
  "REJECTED_FILE_MISSING",
  "REJECTED_HASH_MISMATCH",
  "REJECTED_SYMBOL_NOT_FOUND",
]);
export type EvidenceVerificationStatus = typeof EvidenceVerificationStatus.Type;

export const EvidenceLedgerEntry = Schema.Struct({
  evidenceId: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  councilId: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  submittedBySeatId: CouncilSeatId,
  roundNum: Schema.Literals([1, 2, 3]),
  filePath: TrimmedNonEmptyString.check(Schema.isMaxLength(512)),
  startLine: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  endLine: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  astSymbol: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(200))),
  resolvedSymbolLine: Schema.optionalKey(
    Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  ),
  excerptSha256: Sha256Hex,
  fileHeadSha256: Sha256Hex,
  verificationStatus: EvidenceVerificationStatus,
  verifiedAtMs: Schema.Number,
});
export type EvidenceLedgerEntry = typeof EvidenceLedgerEntry.Type;

/** 7. Claim-Evidence DAG node & 4-way structured critique response taxonomy (Boundary 2). */
export const CritiqueResponseTaxonomy = Schema.Literals([
  "INITIAL",
  "NEW_EVIDENCE_ADDED",
  "SCOPE_NARROWED",
  "CONFIDENCE_REDUCED",
  "DEFERRED_ACCEPTED",
]);
export type CritiqueResponseTaxonomy = typeof CritiqueResponseTaxonomy.Type;

export const CouncilClaimKind = Schema.Literals([
  "ROOT_DIAGNOSIS",
  "PATCH_PROPOSAL",
  "CONTRARIAN_CHALLENGE",
  "REBUTTAL_DEFENSE",
]);
export type CouncilClaimKind = typeof CouncilClaimKind.Type;

export const CouncilClaimSeverity = Schema.Literals(["P0", "P1", "P2"]);
export type CouncilClaimSeverity = typeof CouncilClaimSeverity.Type;

export const CouncilClaimStatus = Schema.Literals([
  "ACTIVE",
  "SUPERSEDED",
  "REJECTED_NO_EVIDENCE",
  "FLIP_BLOCKED",
  "ACCEPTED",
]);
export type CouncilClaimStatus = typeof CouncilClaimStatus.Type;

export const SubjectiveOpinion = Schema.Struct({
  belief: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  disbelief: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  uncertainty: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  baseRate: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })).pipe(
    Schema.withDecodingDefault(Effect.succeed(0.5)),
  ),
});
export type SubjectiveOpinion = typeof SubjectiveOpinion.Type;

export const CouncilClaimNode = Schema.Struct({
  claimId: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  councilId: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  authorSeatId: CouncilSeatId,
  /** Dynamic per-round anonymized handle ("Proposal-1" .. "Proposal-M"). */
  anonHandle: TrimmedNonEmptyString.check(Schema.isMaxLength(32)),
  roundNum: Schema.Literals([1, 2, 3]),
  claimKind: CouncilClaimKind,
  severity: Schema.NullOr(CouncilClaimSeverity).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  targetClaimId: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(64))),
  responseTaxonomy: CritiqueResponseTaxonomy,
  /** Normalized semantic stance hash (file+symbol+intent) to avoid whitespace false-positive flips. */
  stanceHash: Schema.String.check(Schema.isMaxLength(64)),
  statementKo: Schema.String.check(Schema.isMaxLength(4000)),
  proposedDiffSketch: Schema.NullOr(Schema.String.check(Schema.isMaxLength(8000))),
  evidenceIds: Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(64))),
  subjectiveOpinion: SubjectiveOpinion,
  status: CouncilClaimStatus,
});
export type CouncilClaimNode = typeof CouncilClaimNode.Type;

/** 8. Immutable target file SHA-256 CAS lock & PinnedSpec contract (Boundary 3). */
export const TargetFileLock = Schema.Struct({
  filePath: TrimmedNonEmptyString.check(Schema.isMaxLength(512)),
  expectedFileSha256: Sha256Hex,
  patchIntentKo: TrimmedNonEmptyString.check(Schema.isMaxLength(1000)),
  relatedEvidenceIds: Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(64))),
});
export type TargetFileLock = typeof TargetFileLock.Type;

/** Safe direct execFile verification spec (structurally compatible with WorkspaceDelegateVerifySpec). */
export const CouncilVerifySpec = Schema.Struct({
  command: TrimmedNonEmptyString,
  args: Schema.optionalKey(Schema.Array(Schema.String)),
  cwdRelative: Schema.optionalKey(TrimmedNonEmptyString),
  timeoutMs: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1_000)).check(
      Schema.isLessThanOrEqualTo(120_000),
    ),
  ),
  expectedExitCodes: Schema.optionalKey(Schema.Array(Schema.Int)),
});
export type CouncilVerifySpec = typeof CouncilVerifySpec.Type;

export const CouncilAcceptanceCheck = Schema.Struct({
  label: TrimmedNonEmptyString.check(Schema.isMaxLength(300)),
  verifySpec: CouncilVerifySpec,
});
export type CouncilAcceptanceCheck = typeof CouncilAcceptanceCheck.Type;

export const CouncilPinnedSpec = Schema.Struct({
  pinnedSpecId: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  councilId: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  threadId: ThreadId,
  projectId: ProjectId,
  titleKo: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  executiveSummaryKo: Schema.String.check(Schema.isMaxLength(8000)),
  acceptedClaimIds: Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(64))),
  verifiedEvidenceIds: Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(64))),
  targetFilesLock: Schema.Array(TargetFileLock).check(Schema.isMinLength(1)),
  /** Safe direct execFile verification specs (zero shell injection). */
  acceptanceChecks: Schema.Array(CouncilAcceptanceCheck).check(Schema.isMinLength(1)),
  unresolvedDisagreementsKo: Schema.Array(Schema.String.check(Schema.isMaxLength(1000))),
  uniqueFindingsKo: Schema.Array(Schema.String.check(Schema.isMaxLength(1000))).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  recommendedWorker: ModelTargetRef,
  availableWorkerCandidates: Schema.Array(ModelTargetRef).check(Schema.isMinLength(1)),
  specHashSha256: Sha256Hex,
  delegatedTaskId: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(128))),
  worktreePath: Schema.optionalKey(Schema.NullOr(Schema.String.check(Schema.isMaxLength(1024)))),
  worktreeBranch: Schema.optionalKey(Schema.NullOr(Schema.String.check(Schema.isMaxLength(256)))),
  specGateOutcome: Schema.optionalKey(Schema.NullOr(SpecGateOutcome)),
  specProofSummary: Schema.optionalKey(Schema.NullOr(SpecProofSummary)),
  createdAtMs: Schema.Number,
});
export type CouncilPinnedSpec = typeof CouncilPinnedSpec.Type;

/** 9. Full Council session snapshot returned to UI & streamed on state transitions. */
export const CouncilSessionSnapshot = Schema.Struct({
  councilId: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  threadId: ThreadId,
  projectId: ProjectId,
  userPrompt: Schema.String.check(Schema.isMaxLength(20_000)),
  mode: Schema.optionalKey(EffectiveCouncilMode),
  state: CouncilState,
  chairModel: ModelTargetRef,
  roster: Schema.Array(CouncilSeatAssignment),
  seatProgress: Schema.optionalKey(Schema.Array(CouncilSeatProgress)),
  triageScore: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  flipBlockedCount: NonNegativeInt,
  researchRetryCount: NonNegativeInt,
  ledgerEntries: Schema.Array(EvidenceLedgerEntry),
  claims: Schema.Array(CouncilClaimNode),
  pinnedSpec: Schema.NullOr(CouncilPinnedSpec),
  synthesisReportMarkdown: Schema.optionalKey(
    Schema.NullOr(Schema.String.check(Schema.isMaxLength(32_000))),
  ),
  errorMessage: Schema.NullOr(Schema.String.check(Schema.isMaxLength(2000))),
  createdAtMs: Schema.Number,
  updatedAtMs: Schema.Number,
});
export type CouncilSessionSnapshot = typeof CouncilSessionSnapshot.Type;

/** 10. 0ms Intelligent Triage result. */
export const CouncilTriageInput = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  userPrompt: Schema.String.check(Schema.isMaxLength(20_000)),
});
export type CouncilTriageInput = typeof CouncilTriageInput.Type;

export const CouncilTriageResult = Schema.Struct({
  score: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  recommendation: Schema.Literals(["skip", "suggest", "auto"]),
  reasons: Schema.Array(Schema.String.check(Schema.isMaxLength(200))),
  activeSubordinateCount: NonNegativeInt,
  previewRoster: Schema.Array(CouncilSeatAssignment),
});
export type CouncilTriageResult = typeof CouncilTriageResult.Type;

/** 11. Stale file lock mismatch metadata returned on CAS failure. */
export const CouncilStaleFileMismatch = Schema.Struct({
  filePath: Schema.String,
  expectedSha256: Schema.String,
  currentSha256: Schema.NullOr(Schema.String),
});
export type CouncilStaleFileMismatch = typeof CouncilStaleFileMismatch.Type;

/** 12. RPC Payloads & Methods (`WsRpcGroup`). */
export const COUNCIL_WS_METHODS = {
  triage: "council.triage",
  startAutoSeat: "council.startAutoSeat",
  getSession: "council.getSession",
  listThreadSessions: "council.listThreadSessions",
  approveOverride: "council.approveOverride",
  executePinnedSpec: "council.executePinnedSpec",
  reverifyPinnedSpec: "council.reverifyPinnedSpec",
  abort: "council.abort",
  subscribe: "council.subscribe",
} as const;

export const CouncilStartAutoSeatInput = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  userPrompt: TrimmedNonEmptyString.check(Schema.isMaxLength(20_000)),
  mode: Schema.optionalKey(CouncilMode),
  forceCouncil: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  overrideSubordinateTargets: Schema.optionalKey(Schema.Array(ModelTargetRef)),
  runtimeMode: Schema.optionalKey(
    Schema.Literals(["approval-required", "auto-accept-edits", "auto", "full-access"]),
  ),
  interactionMode: Schema.optionalKey(Schema.Literals(["default", "plan"])),
});
export type CouncilStartAutoSeatInput = typeof CouncilStartAutoSeatInput.Type;

export const CouncilGetSessionInput = Schema.Struct({
  councilId: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
});
export type CouncilGetSessionInput = typeof CouncilGetSessionInput.Type;

export const CouncilListThreadSessionsInput = Schema.Struct({
  threadId: ThreadId,
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20 }))),
});
export type CouncilListThreadSessionsInput = typeof CouncilListThreadSessionsInput.Type;

export const CouncilListThreadSessionsResult = Schema.Struct({
  sessions: Schema.Array(CouncilSessionSnapshot),
});
export type CouncilListThreadSessionsResult = typeof CouncilListThreadSessionsResult.Type;

export const CouncilApproveOverrideInput = Schema.Struct({
  councilId: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  reason: TrimmedNonEmptyString.check(Schema.isMaxLength(1000)),
});
export type CouncilApproveOverrideInput = typeof CouncilApproveOverrideInput.Type;

export const CouncilExecutePinnedSpecInput = Schema.Struct({
  pinnedSpecId: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  selectedWorkerOverride: Schema.optionalKey(ModelTargetRef),
  isolateInWorktree: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  idempotencyKey: TrimmedNonEmptyString.check(Schema.isMinLength(8), Schema.isMaxLength(64)),
});
export type CouncilExecutePinnedSpecInput = typeof CouncilExecutePinnedSpecInput.Type;

export const CouncilExecutePinnedSpecResult = Schema.Struct({
  pinnedSpecId: TrimmedNonEmptyString,
  councilId: TrimmedNonEmptyString,
  delegationId: TrimmedNonEmptyString,
  executedWorker: ModelTargetRef,
  fallbackUsed: Schema.Boolean,
  worktreePath: Schema.NullOr(Schema.String),
  worktreeBranch: Schema.NullOr(Schema.String),
  deduplicated: Schema.Boolean,
  startedAt: IsoDateTime,
});
export type CouncilExecutePinnedSpecResult = typeof CouncilExecutePinnedSpecResult.Type;

export const CouncilReverifyPinnedSpecInput = Schema.Struct({
  pinnedSpecId: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
});
export type CouncilReverifyPinnedSpecInput = typeof CouncilReverifyPinnedSpecInput.Type;

export const CouncilAbortInput = Schema.Struct({
  councilId: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  reason: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(500))),
});
export type CouncilAbortInput = typeof CouncilAbortInput.Type;

export const CouncilSubscribeInput = Schema.Struct({
  threadId: ThreadId,
});
export type CouncilSubscribeInput = typeof CouncilSubscribeInput.Type;

export const CouncilStreamEvent = Schema.Struct({
  kind: Schema.Literals(["snapshot", "updated"]),
  threadId: ThreadId,
  sessions: Schema.Array(CouncilSessionSnapshot),
  updatedAt: IsoDateTime,
});
export type CouncilStreamEvent = typeof CouncilStreamEvent.Type;

export class CouncilError extends Schema.TaggedErrorClass<CouncilError>()("CouncilError", {
  code: Schema.Literals([
    "INVALID_INPUT",
    "NOT_FOUND",
    "INVALID_STATE",
    "STALE_PINNED_SPEC",
    "UNRESOLVED_P0_CHALLENGE",
    "NO_AVAILABLE_MODELS",
    "EXECUTION_FAILED",
  ]),
  message: Schema.String,
  staleFiles: Schema.optionalKey(Schema.Array(CouncilStaleFileMismatch)),
}) {}
