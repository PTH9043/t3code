import * as Schema from "effect/Schema";
import { NonNegativeInt, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * NewAutoUsage (T3) 자율 미션 컨트롤 통합 대시보드 계약 스키마.
 *
 * 핵심 원칙:
 * 1. 제로 하드코딩 모델: 모든 크루 역할은 런타임 `providerInstanceId` + `modelSlug`에 유동 바인딩된다.
 * 2. Pass-by-Reference (포인터 교신): 에이전트 간 교신은 `CompactHandoffPacket` (3줄 요약 + Artifact/Worktree 포인터)만 전달한다.
 * 3. 실제 대화창(Thread) 연동: 모든 미션은 프로젝트 소속 `threadId`에 바인딩되어 대화창↔자율 운영실 양방향 제어된다.
 */

export const MISSION_CONTROL_WS_METHODS = {
  getSnapshot: "missionControl.getSnapshot",
  subscribe: "missionControl.subscribe",
  createMission: "missionControl.createMission",
  cancelMission: "missionControl.cancelMission",
  deleteMission: "missionControl.deleteMission",
  decideApproval: "missionControl.decideApproval",
  upsertCrewRole: "missionControl.upsertCrewRole",
  deleteCrewRole: "missionControl.deleteCrewRole",
  startSyncMeeting: "missionControl.startSyncMeeting",
  startRoundtableMeeting: "missionControl.startRoundtableMeeting",
  cancelMeeting: "missionControl.cancelMeeting",
  deleteMeeting: "missionControl.deleteMeeting",
  promoteMeetingToMission: "missionControl.promoteMeetingToMission",
  setSynapsePruned: "missionControl.setSynapsePruned",
  killSwitch: "missionControl.killSwitch",
  generateDigestNow: "missionControl.generateDigestNow",
  runHeartbeatCheck: "missionControl.runHeartbeatCheck",
  inspectArtifact: "missionControl.inspectArtifact",
} as const;

export const MissionControlErrorCode = Schema.Literals([
  "NOT_FOUND",
  "INVALID_INPUT",
  "INVALID_STATE",
  "BUDGET_EXCEEDED",
  "KILL_SWITCH_ACTIVE",
  "FENCING_CONFLICT",
  "EXECUTION_FAILED",
  "UNAVAILABLE",
]);
export type MissionControlErrorCode = typeof MissionControlErrorCode.Type;

export class MissionControlError extends Schema.TaggedErrorClass<MissionControlError>()(
  "MissionControlError",
  {
    code: MissionControlErrorCode,
    message: Schema.String,
  },
) {}

export const MissionStatus = Schema.Literals([
  "CREATED",
  "PLANNING",
  "EXECUTING",
  "VERIFYING",
  "AWAITING_APPROVAL",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
]);
export type MissionStatus = typeof MissionStatus.Type;

export const MissionModelTier = Schema.Literals(["TIER_S", "TIER_A", "TIER_B"]);
export type MissionModelTier = typeof MissionModelTier.Type;

export const MissionOrgTier = Schema.Literals([
  "L0_COMMANDER",
  "L1_LEAD",
  "L2_SPECIALIST",
  "L3_SUPPORT",
]);
export type MissionOrgTier = typeof MissionOrgTier.Type;

export const MissionExecutionStyle = Schema.Literals(["hierarchical_ops", "persistent_goal"]);
export type MissionExecutionStyle = typeof MissionExecutionStyle.Type;

export const MissionMeetingStyle = Schema.Literals(["roundtable", "blind_audit"]);
export type MissionMeetingStyle = typeof MissionMeetingStyle.Type;

export const MissionMeetingStatus = Schema.Literals([
  "RUNNING",
  "CONSENSUS_REACHED",
  "COMPLETED",
  "CANCELLED",
]);
export type MissionMeetingStatus = typeof MissionMeetingStatus.Type;

export const MissionMeetingStance = Schema.Literals([
  "propose",
  "agree",
  "partial_disagree",
  "counter",
  "synthesize",
]);
export type MissionMeetingStance = typeof MissionMeetingStance.Type;

export const MissionCrewStatus = Schema.Literals([
  "IDLE",
  "WORKING",
  "BLOCKED",
  "ERROR",
  "RATE_LIMITED",
]);
export type MissionCrewStatus = typeof MissionCrewStatus.Type;

export const MissionEscalationTier = Schema.Literals(["TIER_0", "TIER_1", "TIER_2"]);
export type MissionEscalationTier = typeof MissionEscalationTier.Type;

export const MissionCircuitBreakerState = Schema.Literals(["OK", "THROTTLED", "TRIPPED_TO_INBOX"]);
export type MissionCircuitBreakerState = typeof MissionCircuitBreakerState.Type;

export const MissionApprovalAction = Schema.Literals([
  "approve",
  "modify_resume",
  "reject_rollback",
  "snooze",
]);
export type MissionApprovalAction = typeof MissionApprovalAction.Type;

export const MissionTriggerReason = Schema.Literals([
  "DESTRUCTIVE_OP",
  "EXTERNAL_SIDE_EFFECT",
  "BUDGET_EXCEEDED",
  "HOP_LIMIT",
  "REWORK_LIMIT",
  "REPEAT_ERROR_HASH",
  "STALL_LOOP",
  "CHECKER_CONFLICT",
  "SYNC_MEETING_DECISION",
  "ORPHAN_RECOVERY",
  "FINAL_MERGE_CONFIRM",
]);
export type MissionTriggerReason = typeof MissionTriggerReason.Type;

export const MissionReportScope = Schema.Literals([
  "MISSION_DONE",
  "DAILY_DIGEST",
  "CRITICAL_ALERT",
]);
export type MissionReportScope = typeof MissionReportScope.Type;

export const MissionHandoffIntent = Schema.Literals([
  "PLAN",
  "IMPLEMENT",
  "VERIFY",
  "FIX_REQUIRED",
  "APPROVE",
  "ESCALATE",
  "SYNC_NOTE",
]);
export type MissionHandoffIntent = typeof MissionHandoffIntent.Type;

export const MissionDagStepStatus = Schema.Literals([
  "PENDING",
  "RUNNING",
  "VERIFYING",
  "AWAITING_APPROVAL",
  "COMPLETED",
  "FAILED",
  "SKIPPED",
]);
export type MissionDagStepStatus = typeof MissionDagStepStatus.Type;

/**
 * Pass-by-Reference (포인터 교신) 경량 핸드오프 패킷.
 * 이전 대화 원문/로그 전체를 넘기지 않고 3줄 요약 + Artifact/Worktree 포인터만 전달한다.
 */
export const CompactHandoffPointers = Schema.Struct({
  worktreePath: Schema.NullOr(Schema.String),
  changedFiles: Schema.Array(Schema.String),
  artifactIds: Schema.Array(Schema.String),
  failingTestCmd: Schema.NullOr(Schema.String),
  taskId: Schema.NullOr(Schema.String),
});
export type CompactHandoffPointers = typeof CompactHandoffPointers.Type;

export const CompactHandoffProof = Schema.Struct({
  command: Schema.String,
  exitCode: Schema.Number,
  artifactId: Schema.NullOr(Schema.String),
  summary: Schema.String,
});
export type CompactHandoffProof = typeof CompactHandoffProof.Type;

export const CompactHandoffPacket = Schema.Struct({
  schemaVersion: Schema.Literal("handoff.v2"),
  missionId: Schema.String,
  hopCount: NonNegativeInt,
  reworkCycle: NonNegativeInt,
  fromRole: Schema.String,
  toRole: Schema.String,
  intent: MissionHandoffIntent,
  summary3Lines: Schema.Array(Schema.String),
  pointers: CompactHandoffPointers,
  verificationCriteria: Schema.Array(Schema.String),
  verificationProof: Schema.NullOr(CompactHandoffProof),
  idempotencyKey: Schema.String,
  estimatedTokens: NonNegativeInt,
});
export type CompactHandoffPacket = typeof CompactHandoffPacket.Type;

export const MissionCrewRole = Schema.Struct({
  id: Schema.String,
  projectId: ProjectId,
  roleKey: Schema.String,
  displayName: Schema.String,
  description: Schema.String,
  providerInstanceId: Schema.String,
  modelSlug: Schema.String,
  modelTier: MissionModelTier,
  orgTier: Schema.optionalKey(MissionOrgTier),
  reportsToRoleKey: Schema.optionalKey(Schema.NullOr(Schema.String)),
  specialtyTags: Schema.optionalKey(Schema.Array(Schema.String)),
  canModerate: Schema.optionalKey(Schema.Boolean),
  importanceScore: Schema.optionalKey(Schema.Number),
  fallbackInstanceId: Schema.NullOr(Schema.String),
  fallbackModelSlug: Schema.NullOr(Schema.String),
  systemDirective: Schema.String,
  allowedTools: Schema.Array(Schema.String),
  currentStatus: MissionCrewStatus,
  activeMissionId: Schema.NullOr(Schema.String),
  activeTaskId: Schema.NullOr(Schema.String),
  contextPercent: Schema.Number,
  turnCount: NonNegativeInt,
  maxTurns: NonNegativeInt,
  lastHeartbeatAtMs: Schema.NullOr(Schema.Number),
  enabled: Schema.Boolean,
  updatedAtMs: Schema.Number,
});
export type MissionCrewRole = typeof MissionCrewRole.Type;

export const MissionDagStep = Schema.Struct({
  stepId: Schema.String,
  roleKey: Schema.String,
  roleDisplayName: Schema.String,
  title: Schema.String,
  status: MissionDagStepStatus,
  providerInstanceId: Schema.NullOr(Schema.String),
  modelSlug: Schema.NullOr(Schema.String),
  taskId: Schema.NullOr(Schema.String),
  worktreePath: Schema.NullOr(Schema.String),
  worktreeBranch: Schema.NullOr(Schema.String),
  summary: Schema.NullOr(Schema.String),
  tokensUsed: NonNegativeInt,
  cachedTokens: NonNegativeInt,
  durationMs: NonNegativeInt,
});
export type MissionDagStep = typeof MissionDagStep.Type;

export const MissionRun = Schema.Struct({
  id: Schema.String,
  projectId: ProjectId,
  threadId: Schema.NullOr(ThreadId),
  title: Schema.String,
  goalPrompt: Schema.String,
  doneCriteria: Schema.Array(Schema.String),
  status: MissionStatus,
  activeRoleId: Schema.NullOr(Schema.String),
  plannerTaskId: Schema.NullOr(Schema.String),
  activeTaskId: Schema.NullOr(Schema.String),
  worktreePath: Schema.NullOr(Schema.String),
  worktreeBranch: Schema.NullOr(Schema.String),
  assignedRoles: Schema.Array(Schema.String),
  dagSteps: Schema.Array(MissionDagStep),
  executionStyle: Schema.optionalKey(MissionExecutionStyle),
  maxSteps: Schema.optionalKey(Schema.NullOr(NonNegativeInt)),
  maxMinutes: Schema.optionalKey(Schema.NullOr(NonNegativeInt)),
  maxTokens: Schema.optionalKey(Schema.NullOr(NonNegativeInt)),
  verificationCommands: Schema.optionalKey(Schema.Array(Schema.String)),
  sourceMeetingId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  hopCount: NonNegativeInt,
  reworkCount: NonNegativeInt,
  turnCount: NonNegativeInt,
  totalTokensUsed: NonNegativeInt,
  totalCachedTokens: NonNegativeInt,
  totalCostUsd: Schema.Number,
  budgetLimitUsd: Schema.Number,
  circuitBreakerState: MissionCircuitBreakerState,
  lastErrorHash: Schema.NullOr(Schema.String),
  repeatErrorCount: NonNegativeInt,
  leaseOwner: Schema.NullOr(Schema.String),
  leaseEpoch: NonNegativeInt,
  leaseExpiresAtMs: Schema.NullOr(Schema.Number),
  digestLine: Schema.NullOr(Schema.String),
  createdAtMs: Schema.Number,
  updatedAtMs: Schema.Number,
  completedAtMs: Schema.NullOr(Schema.Number),
});
export type MissionRun = typeof MissionRun.Type;

export const MissionDecisionCard = Schema.Struct({
  gateId: Schema.String,
  taskId: Schema.String,
  missionId: Schema.NullOr(Schema.String),
  projectId: ProjectId,
  threadId: Schema.NullOr(ThreadId),
  missionTitle: Schema.String,
  escalationTier: MissionEscalationTier,
  triggerReason: MissionTriggerReason,
  status: Schema.Literals(["pending", "resolved", "cancelled", "expired"]),
  title: Schema.String,
  context3LinesMd: Schema.String,
  aiRecommendation: Schema.String,
  riskLevel: Schema.Literals(["low", "medium", "high", "critical"]),
  estimatedCostUsd: Schema.Number,
  changedFilesCount: NonNegativeInt,
  diffUri: Schema.NullOr(Schema.String),
  worktreePath: Schema.NullOr(Schema.String),
  decisionNote: Schema.NullOr(Schema.String),
  decidedBy: Schema.NullOr(Schema.String),
  resolution: Schema.NullOr(Schema.String),
  snoozedUntilMs: Schema.NullOr(Schema.Number),
  createdAtMs: Schema.Number,
  resolvedAtMs: Schema.NullOr(Schema.Number),
});
export type MissionDecisionCard = typeof MissionDecisionCard.Type;

export const MissionReport = Schema.Struct({
  id: Schema.String,
  projectId: ProjectId,
  missionId: Schema.NullOr(Schema.String),
  threadId: Schema.NullOr(ThreadId),
  scope: MissionReportScope,
  title: Schema.String,
  bodyMd: Schema.String,
  summary3Lines: Schema.Array(Schema.String),
  dedupFingerprint: Schema.NullOr(Schema.String),
  deliveredTelegram: Schema.Boolean,
  createdAtMs: Schema.Number,
});
export type MissionReport = typeof MissionReport.Type;

export const MissionBudgetSummary = Schema.Struct({
  dailySpentUsd: Schema.Number,
  dailyLimitUsd: Schema.Number,
  totalInputTokens: NonNegativeInt,
  totalCachedTokens: NonNegativeInt,
  totalCompletionTokens: NonNegativeInt,
  cacheHitRatePercent: Schema.Number,
  zeroTokenSkipsCount: NonNegativeInt,
  circuitTripsToday: NonNegativeInt,
  rateLimitErrorsToday: NonNegativeInt,
  killSwitchActive: Schema.Boolean,
});
export type MissionBudgetSummary = typeof MissionBudgetSummary.Type;

export const MissionActivityItem = Schema.Struct({
  id: Schema.String,
  missionId: Schema.NullOr(Schema.String),
  threadId: Schema.NullOr(ThreadId),
  roleKey: Schema.NullOr(Schema.String),
  roleDisplayName: Schema.String,
  level: Schema.Literals(["info", "warn", "error", "success"]),
  message: Schema.String,
  artifactId: Schema.NullOr(Schema.String),
  createdAtMs: Schema.Number,
});
export type MissionActivityItem = typeof MissionActivityItem.Type;

export const MissionHandoffItem = Schema.Struct({
  id: Schema.String,
  missionId: Schema.NullOr(Schema.String),
  threadId: Schema.NullOr(ThreadId),
  sequence: NonNegativeInt,
  fromActor: Schema.String,
  toActor: Schema.String,
  type: Schema.String,
  subject: Schema.String,
  packet: Schema.NullOr(CompactHandoffPacket),
  bodyPreview: Schema.String,
  createdAtMs: Schema.Number,
});
export type MissionHandoffItem = typeof MissionHandoffItem.Type;

export const MissionSynapsePacket = Schema.Struct({
  id: Schema.String,
  meetingId: Schema.String,
  roundNum: NonNegativeInt,
  fromRoleKey: Schema.String,
  fromDisplayName: Schema.String,
  fromOrgTier: MissionOrgTier,
  replyToRoleKeys: Schema.Array(Schema.String),
  upwardFeedback: Schema.Boolean,
  stance: MissionMeetingStance,
  claim: Schema.String,
  evidence: Schema.Array(Schema.String),
  riskOrCounter: Schema.String,
  selectedForNextRound: Schema.Boolean,
  importanceContribution: Schema.Number,
  tokenCount: NonNegativeInt,
  createdAtMs: Schema.Number,
});
export type MissionSynapsePacket = typeof MissionSynapsePacket.Type;

export const MissionMeetingRecord = Schema.Struct({
  id: Schema.String,
  projectId: ProjectId,
  threadId: Schema.NullOr(ThreadId),
  topic: Schema.String,
  moderatorRoleKey: Schema.String,
  moderatorDisplayName: Schema.String,
  participantRoleKeys: Schema.Array(Schema.String),
  prunedRoleKeys: Schema.Array(Schema.String),
  meetingStyle: MissionMeetingStyle,
  maxRounds: NonNegativeInt,
  currentRound: NonNegativeInt,
  status: MissionMeetingStatus,
  earlyStopReason: Schema.NullOr(Schema.String),
  finalSynthesisMd: Schema.String,
  consensusSummaryLines: Schema.Array(Schema.String),
  linkedMissionId: Schema.NullOr(Schema.String),
  totalTokens: NonNegativeInt,
  estimatedSavedTokens: NonNegativeInt,
  totalCostUsd: Schema.Number,
  packets: Schema.Array(MissionSynapsePacket),
  createdAtMs: Schema.Number,
  completedAtMs: Schema.NullOr(Schema.Number),
});
export type MissionMeetingRecord = typeof MissionMeetingRecord.Type;

export const MissionSynapseWeightRecord = Schema.Struct({
  domainTag: Schema.String,
  roleKey: Schema.String,
  providerInstanceId: Schema.String,
  modelSlug: Schema.String,
  importanceEma: Schema.Number,
  tokenEfficiencyEma: Schema.Number,
  adoptionRate: Schema.Number,
  sampleCount: NonNegativeInt,
  pruned: Schema.Boolean,
  updatedAtMs: Schema.Number,
});
export type MissionSynapseWeightRecord = typeof MissionSynapseWeightRecord.Type;

export const MissionControlCounts = Schema.Struct({
  working: NonNegativeInt,
  awaitingApproval: NonNegativeInt,
  idle: NonNegativeInt,
  completedToday: NonNegativeInt,
  totalMissions: NonNegativeInt,
  activeMeetings: Schema.optionalKey(NonNegativeInt),
});
export type MissionControlCounts = typeof MissionControlCounts.Type;

export const MissionControlSnapshot = Schema.Struct({
  projectId: ProjectId,
  generatedAtMs: Schema.Number,
  counts: MissionControlCounts,
  budget: MissionBudgetSummary,
  crewRoles: Schema.Array(MissionCrewRole),
  missions: Schema.Array(MissionRun),
  meetings: Schema.optionalKey(Schema.Array(MissionMeetingRecord)),
  synapseWeights: Schema.optionalKey(Schema.Array(MissionSynapseWeightRecord)),
  pendingApprovals: Schema.Array(MissionDecisionCard),
  recentResolvedApprovals: Schema.Array(MissionDecisionCard),
  reports: Schema.Array(MissionReport),
  activities: Schema.Array(MissionActivityItem),
  handoffs: Schema.Array(MissionHandoffItem),
});
export type MissionControlSnapshot = typeof MissionControlSnapshot.Type;

export const MissionControlStreamEvent = Schema.Struct({
  type: Schema.Literals([
    "snapshot",
    "heartbeat",
    "mission_updated",
    "meeting_updated",
    "approval_updated",
    "crew_updated",
    "report_updated",
    "kill_switch",
  ]),
  projectId: ProjectId,
  snapshot: Schema.NullOr(MissionControlSnapshot),
  timestampMs: Schema.Number,
});
export type MissionControlStreamEvent = typeof MissionControlStreamEvent.Type;

// ---------------------------------------------------------------------------
// RPC Inputs & Results
// ---------------------------------------------------------------------------

export const MissionGetSnapshotInput = Schema.Struct({
  projectId: ProjectId,
  threadId: Schema.optionalKey(ThreadId),
});
export type MissionGetSnapshotInput = typeof MissionGetSnapshotInput.Type;

export const MissionSubscribeInput = Schema.Struct({
  projectId: ProjectId,
  threadId: Schema.optionalKey(ThreadId),
});
export type MissionSubscribeInput = typeof MissionSubscribeInput.Type;

export const MissionRoleModelOverride = Schema.Struct({
  roleKey: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  providerInstanceId: TrimmedNonEmptyString.check(Schema.isMaxLength(120)),
  modelSlug: TrimmedNonEmptyString.check(Schema.isMaxLength(160)),
});
export type MissionRoleModelOverride = typeof MissionRoleModelOverride.Type;

export const MissionCreateInput = Schema.Struct({
  projectId: ProjectId,
  title: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(180))),
  goalPrompt: TrimmedNonEmptyString.check(Schema.isMaxLength(8000)),
  doneCriteria: Schema.optionalKey(
    Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(300))),
  ),
  /** 실제 대화창에서 실행하거나 기존 대화창에 바인딩할 때 지정 */
  threadId: Schema.optionalKey(ThreadId),
  /** true이고 threadId가 없으면 프로젝트에 새 실제 대화창을 자동 생성해 바인딩 */
  createNewThread: Schema.optionalKey(Schema.Boolean),
  assignedRoles: Schema.optionalKey(
    Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(64))),
  ),
  roleModelOverrides: Schema.optionalKey(Schema.Array(MissionRoleModelOverride)),
  budgetLimitUsd: Schema.optionalKey(Schema.Number),
  requireFinalApproval: Schema.optionalKey(Schema.Boolean),
  autoMergeOnApprove: Schema.optionalKey(Schema.Boolean),
  executionStyle: Schema.optionalKey(MissionExecutionStyle),
  maxSteps: Schema.optionalKey(Schema.Number),
  maxMinutes: Schema.optionalKey(Schema.Number),
  maxTokens: Schema.optionalKey(Schema.Number),
  verificationCommands: Schema.optionalKey(
    Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(300))),
  ),
  sourceMeetingId: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(120))),
  autoTriage: Schema.optionalKey(Schema.Boolean),
});
export type MissionCreateInput = typeof MissionCreateInput.Type;

export const MissionCancelInput = Schema.Struct({
  projectId: ProjectId,
  missionId: TrimmedNonEmptyString.check(Schema.isMaxLength(120)),
  reason: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(500))),
});
export type MissionCancelInput = typeof MissionCancelInput.Type;

export const MissionDeleteInput = Schema.Struct({
  projectId: ProjectId,
  missionId: TrimmedNonEmptyString.check(Schema.isMaxLength(120)),
});
export type MissionDeleteInput = typeof MissionDeleteInput.Type;

export const MissionDecideApprovalInput = Schema.Struct({
  projectId: ProjectId,
  gateId: TrimmedNonEmptyString.check(Schema.isMaxLength(120)),
  action: MissionApprovalAction,
  note: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(2000))),
  snoozeMinutes: Schema.optionalKey(Schema.Number),
});
export type MissionDecideApprovalInput = typeof MissionDecideApprovalInput.Type;

export const MissionCrewRoleUpsertInput = Schema.Struct({
  projectId: ProjectId,
  id: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(120))),
  roleKey: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  displayName: TrimmedNonEmptyString.check(Schema.isMaxLength(80)),
  description: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(400))),
  providerInstanceId: TrimmedNonEmptyString.check(Schema.isMaxLength(120)),
  modelSlug: TrimmedNonEmptyString.check(Schema.isMaxLength(160)),
  modelTier: MissionModelTier,
  orgTier: Schema.optionalKey(MissionOrgTier),
  reportsToRoleKey: Schema.optionalKey(Schema.NullOr(Schema.String.check(Schema.isMaxLength(64)))),
  specialtyTags: Schema.optionalKey(
    Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(48))),
  ),
  canModerate: Schema.optionalKey(Schema.Boolean),
  fallbackInstanceId: Schema.optionalKey(
    Schema.NullOr(Schema.String.check(Schema.isMaxLength(120))),
  ),
  fallbackModelSlug: Schema.optionalKey(
    Schema.NullOr(Schema.String.check(Schema.isMaxLength(160))),
  ),
  systemDirective: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(4000))),
  allowedTools: Schema.optionalKey(
    Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(80))),
  ),
  maxTurns: Schema.optionalKey(Schema.Number),
  enabled: Schema.optionalKey(Schema.Boolean),
});
export type MissionCrewRoleUpsertInput = typeof MissionCrewRoleUpsertInput.Type;

export const MissionCrewRoleDeleteInput = Schema.Struct({
  projectId: ProjectId,
  roleId: TrimmedNonEmptyString.check(Schema.isMaxLength(120)),
});
export type MissionCrewRoleDeleteInput = typeof MissionCrewRoleDeleteInput.Type;

export const MissionSyncMeetingInput = Schema.Struct({
  projectId: ProjectId,
  topic: TrimmedNonEmptyString.check(Schema.isMaxLength(2000)),
  missionId: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(120))),
  threadId: Schema.optionalKey(ThreadId),
  participantRoleKeys: Schema.optionalKey(
    Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(64))),
  ),
});
export type MissionSyncMeetingInput = typeof MissionSyncMeetingInput.Type;

export const MissionRoundtableStartInput = Schema.Struct({
  projectId: ProjectId,
  topic: TrimmedNonEmptyString.check(Schema.isMaxLength(4000)),
  threadId: Schema.optionalKey(ThreadId),
  createNewThread: Schema.optionalKey(Schema.Boolean),
  moderatorRoleKey: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(64))),
  participantRoleKeys: Schema.optionalKey(
    Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(64))),
  ),
  meetingStyle: Schema.optionalKey(MissionMeetingStyle),
  maxRounds: Schema.optionalKey(Schema.Number),
  autoSparseSelect: Schema.optionalKey(Schema.Boolean),
});
export type MissionRoundtableStartInput = typeof MissionRoundtableStartInput.Type;

export const MissionMeetingActionInput = Schema.Struct({
  projectId: ProjectId,
  meetingId: TrimmedNonEmptyString.check(Schema.isMaxLength(120)),
  reason: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(500))),
});
export type MissionMeetingActionInput = typeof MissionMeetingActionInput.Type;

export const MissionPromoteMeetingInput = Schema.Struct({
  projectId: ProjectId,
  meetingId: TrimmedNonEmptyString.check(Schema.isMaxLength(120)),
  executionStyle: Schema.optionalKey(MissionExecutionStyle),
  requireFinalApproval: Schema.optionalKey(Schema.Boolean),
});
export type MissionPromoteMeetingInput = typeof MissionPromoteMeetingInput.Type;

export const MissionSynapsePruneInput = Schema.Struct({
  projectId: ProjectId,
  domainTag: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  roleKey: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  providerInstanceId: TrimmedNonEmptyString.check(Schema.isMaxLength(120)),
  modelSlug: TrimmedNonEmptyString.check(Schema.isMaxLength(160)),
  pruned: Schema.Boolean,
});
export type MissionSynapsePruneInput = typeof MissionSynapsePruneInput.Type;

export const MissionKillSwitchInput = Schema.Struct({
  projectId: ProjectId,
  active: Schema.Boolean,
  reason: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(500))),
});
export type MissionKillSwitchInput = typeof MissionKillSwitchInput.Type;

export const MissionDigestNowInput = Schema.Struct({
  projectId: ProjectId,
});
export type MissionDigestNowInput = typeof MissionDigestNowInput.Type;

export const MissionHeartbeatCheckInput = Schema.Struct({
  projectId: ProjectId,
});
export type MissionHeartbeatCheckInput = typeof MissionHeartbeatCheckInput.Type;

export const MissionHeartbeatCheckResult = Schema.Struct({
  projectId: ProjectId,
  checkedAtMs: Schema.Number,
  llmCalled: Schema.Boolean,
  dirtyFilesCount: NonNegativeInt,
  staleMissionsRecovered: NonNegativeInt,
  summary: Schema.String,
});
export type MissionHeartbeatCheckResult = typeof MissionHeartbeatCheckResult.Type;

export const MissionInspectArtifactInput = Schema.Struct({
  projectId: ProjectId,
  artifactId: TrimmedNonEmptyString.check(Schema.isMaxLength(120)),
  maxChars: Schema.optionalKey(Schema.Number),
});
export type MissionInspectArtifactInput = typeof MissionInspectArtifactInput.Type;

export const MissionInspectArtifactResult = Schema.Struct({
  artifactId: Schema.String,
  toolName: Schema.String,
  rawByteSize: NonNegativeInt,
  content: Schema.String,
  truncated: Schema.Boolean,
  createdAt: Schema.String,
});
export type MissionInspectArtifactResult = typeof MissionInspectArtifactResult.Type;
