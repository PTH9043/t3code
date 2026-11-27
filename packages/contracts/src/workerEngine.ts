import * as Schema from "effect/Schema";

/**
 * T3 Worker Engine contracts (Orca-inspired durable mailbox, task/dispatch fencing,
 * two-tier heartbeat, decision gates, and explicit worktree review lifecycle).
 */

/** Hard ceiling for any single wait/check call (keeps 60s safety margin below 180s MCP timeouts). */
export const WORKER_ENGINE_MAX_WAIT_SECONDS = 120;
export const WORKER_ENGINE_MIN_WAIT_SECONDS = 1;
/** Default worker silence threshold before marking `stalled` and posting an escalation (5 min, Orca default). */
export const WORKER_HEARTBEAT_STALL_MS = 300_000;
/** Default worker silence abort ceiling (15 min). */
export const WORKER_HEARTBEAT_ABORT_MS = 900_000;
/** Default CLI `--wait` stderr keepalive cadence (15s, Orca check-keepalive). */
export const WORKER_CHECK_KEEPALIVE_MS = 15_000;
/** Single shared per-thread concurrent worker ceiling (shared with `DELEGATE_MAX_RUNNING`). */
export const WORKER_MAX_RUNNING_PER_THREAD = 6;
/** Consecutive failed dispatches on the same task before circuit breaking retries. */
export const WORKER_CIRCUIT_BREAKER_THRESHOLD = 3;

export const WorkerCallerKind = Schema.Literals([
  "t3_supervisor",
  "personal_ai",
  "council",
  "orchestra",
  "cli",
]);
export type WorkerCallerKind = typeof WorkerCallerKind.Type;

export const WorkerTaskStatus = Schema.Literals([
  "pending",
  "ready",
  "dispatched",
  "blocked",
  "completed",
  "failed",
  "cancelled",
]);
export type WorkerTaskStatus = typeof WorkerTaskStatus.Type;

export const WorkerDispatchStatus = Schema.Literals([
  "starting",
  "running",
  "stalled",
  "completed",
  "failed",
  "cancelled",
  "interrupted_by_restart",
  "abandoned",
]);
export type WorkerDispatchStatus = typeof WorkerDispatchStatus.Type;

export const WorkerWorktreeMode = Schema.Literals(["isolated", "current"]);
export type WorkerWorktreeMode = typeof WorkerWorktreeMode.Type;

export const WorkerWorktreeState = Schema.Literals([
  "none",
  "active",
  "review_ready",
  "merged",
  "discarded",
]);
export type WorkerWorktreeState = typeof WorkerWorktreeState.Type;

export const WorkerMailboxMessageType = Schema.Literals([
  "dispatch",
  "worker_done",
  "question",
  "answer",
  "escalation",
  "decision_gate",
  "heartbeat",
  "merge_ready",
  "status",
]);
export type WorkerMailboxMessageType = typeof WorkerMailboxMessageType.Type;

export const WorkerDeliveryStatus = Schema.Literals(["outstanding", "acknowledged", "fenced"]);
export type WorkerDeliveryStatus = typeof WorkerDeliveryStatus.Type;

export const WorkerDecisionGateRisk = Schema.Literals(["medium", "high", "critical"]);
export type WorkerDecisionGateRisk = typeof WorkerDecisionGateRisk.Type;

export const WorkerDecisionGateStatus = Schema.Literals(["open", "approved", "denied", "expired"]);
export type WorkerDecisionGateStatus = typeof WorkerDecisionGateStatus.Type;

export const WorkerOutcomeStatus = Schema.Literals(["succeeded", "failed", "blocked"]);
export type WorkerOutcomeStatus = typeof WorkerOutcomeStatus.Type;

export const WorkerOutcome = Schema.Struct({
  status: WorkerOutcomeStatus,
  summary: Schema.String,
  filesModified: Schema.Array(Schema.String),
  exitCode: Schema.optionalKey(Schema.Number),
  latencyMs: Schema.Number,
  provider: Schema.String,
  model: Schema.String,
  inputTokens: Schema.optionalKey(Schema.Number),
  outputTokens: Schema.optionalKey(Schema.Number),
  worktreePath: Schema.optionalKey(Schema.NullOr(Schema.String)),
  worktreeBranch: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
export type WorkerOutcome = typeof WorkerOutcome.Type;

export const WorkerTaskRecord = Schema.Struct({
  taskId: Schema.String,
  runId: Schema.String,
  threadId: Schema.String,
  ownerTurnId: Schema.NullOr(Schema.String),
  callerKind: WorkerCallerKind,
  dedupKey: Schema.String,
  idempotencyKey: Schema.NullOr(Schema.String),
  role: Schema.String,
  targetInstanceId: Schema.String,
  targetModel: Schema.NullOr(Schema.String),
  specText: Schema.String,
  ragFactsJson: Schema.NullOr(Schema.String),
  status: WorkerTaskStatus,
  activeDispatchId: Schema.NullOr(Schema.String),
  fencingEpoch: Schema.Number,
  failureCount: Schema.Number,
  worktreeMode: WorkerWorktreeMode,
  worktreePath: Schema.NullOr(Schema.String),
  worktreeBranch: Schema.NullOr(Schema.String),
  worktreeBaseRef: Schema.NullOr(Schema.String),
  worktreeState: WorkerWorktreeState,
  cwd: Schema.String,
  outcome: Schema.NullOr(WorkerOutcome),
  createdAtMs: Schema.Number,
  updatedAtMs: Schema.Number,
  finishedAtMs: Schema.NullOr(Schema.Number),
});
export type WorkerTaskRecord = typeof WorkerTaskRecord.Type;

export const WorkerDispatchRecord = Schema.Struct({
  dispatchId: Schema.String,
  taskId: Schema.String,
  runId: Schema.String,
  threadId: Schema.String,
  attempt: Schema.Number,
  fencingToken: Schema.Number,
  retryOfDispatchId: Schema.NullOr(Schema.String),
  executionId: Schema.NullOr(Schema.String),
  providerInstanceId: Schema.String,
  model: Schema.NullOr(Schema.String),
  role: Schema.String,
  status: WorkerDispatchStatus,
  lastHeartbeatAtMs: Schema.Number,
  heartbeatTimeoutMs: Schema.Number,
  lastToolSummary: Schema.NullOr(Schema.String),
  resultText: Schema.NullOr(Schema.String),
  errorMessage: Schema.NullOr(Schema.String),
  startedAtMs: Schema.Number,
  finishedAtMs: Schema.NullOr(Schema.Number),
});
export type WorkerDispatchRecord = typeof WorkerDispatchRecord.Type;

export const WorkerMailboxMessageRecord = Schema.Struct({
  sequence: Schema.Number,
  messageId: Schema.String,
  runId: Schema.String,
  threadId: Schema.String,
  taskId: Schema.NullOr(Schema.String),
  dispatchId: Schema.NullOr(Schema.String),
  fencingToken: Schema.NullOr(Schema.Number),
  fromActor: Schema.String,
  toActor: Schema.String,
  type: WorkerMailboxMessageType,
  outcome: Schema.NullOr(WorkerOutcomeStatus),
  subject: Schema.String,
  body: Schema.String,
  payloadJson: Schema.NullOr(Schema.String),
  deliveryId: Schema.NullOr(Schema.String),
  createdAtMs: Schema.Number,
  deliveredAtMs: Schema.NullOr(Schema.Number),
  acknowledgedAtMs: Schema.NullOr(Schema.Number),
});
export type WorkerMailboxMessageRecord = typeof WorkerMailboxMessageRecord.Type;

export const WorkerDeliveryRecord = Schema.Struct({
  deliveryId: Schema.String,
  runId: Schema.String,
  mailboxHandle: Schema.String,
  consumerGeneration: Schema.Number,
  messageIds: Schema.Array(Schema.String),
  status: WorkerDeliveryStatus,
  createdAtMs: Schema.Number,
  acknowledgedAtMs: Schema.NullOr(Schema.Number),
});
export type WorkerDeliveryRecord = typeof WorkerDeliveryRecord.Type;

export const WorkerDecisionGateRecord = Schema.Struct({
  gateId: Schema.String,
  taskId: Schema.String,
  dispatchId: Schema.NullOr(Schema.String),
  threadId: Schema.String,
  riskLevel: WorkerDecisionGateRisk,
  question: Schema.String,
  options: Schema.Array(Schema.String),
  status: WorkerDecisionGateStatus,
  resolution: Schema.NullOr(Schema.String),
  resolvedBy: Schema.NullOr(Schema.String),
  createdAtMs: Schema.Number,
  resolvedAtMs: Schema.NullOr(Schema.Number),
});
export type WorkerDecisionGateRecord = typeof WorkerDecisionGateRecord.Type;

export const WorkerDispatchInput = Schema.Struct({
  runId: Schema.optionalKey(Schema.String),
  threadId: Schema.String,
  ownerTurnId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  callerKind: Schema.optionalKey(WorkerCallerKind),
  taskId: Schema.optionalKey(Schema.String),
  idempotencyKey: Schema.optionalKey(Schema.String),
  retryOfDispatchId: Schema.optionalKey(Schema.String),
  role: Schema.String,
  targetInstanceId: Schema.String,
  targetModel: Schema.optionalKey(Schema.NullOr(Schema.String)),
  specText: Schema.String,
  ragFacts: Schema.optionalKey(Schema.Array(Schema.String)),
  cwd: Schema.String,
  worktreeMode: Schema.optionalKey(WorkerWorktreeMode),
  baseBranch: Schema.optionalKey(Schema.String),
  heartbeatTimeoutMs: Schema.optionalKey(Schema.Number),
  maxIdleMs: Schema.optionalKey(Schema.Number),
  maxWallTimeMs: Schema.optionalKey(Schema.Number),
  requireApproval: Schema.optionalKey(Schema.Boolean),
  approvalQuestion: Schema.optionalKey(Schema.String),
  approvalRiskLevel: Schema.optionalKey(WorkerDecisionGateRisk),
  toActor: Schema.optionalKey(Schema.String),
});
export type WorkerDispatchInput = typeof WorkerDispatchInput.Type;

export const WorkerDispatchReceipt = Schema.Struct({
  taskId: Schema.String,
  dispatchId: Schema.String,
  runId: Schema.String,
  fencingToken: Schema.Number,
  deduplicated: Schema.Boolean,
  reusedIdempotency: Schema.Boolean,
  status: WorkerTaskStatus,
  dispatchStatus: WorkerDispatchStatus,
  worktreeMode: WorkerWorktreeMode,
  worktreePath: Schema.NullOr(Schema.String),
  worktreeBranch: Schema.NullOr(Schema.String),
  worktreeState: WorkerWorktreeState,
  gateId: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
export type WorkerDispatchReceipt = typeof WorkerDispatchReceipt.Type;

export const WorkerCheckInput = Schema.Struct({
  runId: Schema.optionalKey(Schema.String),
  threadId: Schema.optionalKey(Schema.String),
  toActor: Schema.optionalKey(Schema.String),
  types: Schema.optionalKey(Schema.Array(WorkerMailboxMessageType)),
  wait: Schema.optionalKey(Schema.Boolean),
  timeoutSec: Schema.optionalKey(Schema.Number),
  peek: Schema.optionalKey(Schema.Boolean),
  limit: Schema.optionalKey(Schema.Number),
  consumerGeneration: Schema.optionalKey(Schema.Number),
});
export type WorkerCheckInput = typeof WorkerCheckInput.Type;

export const WorkerCheckResult = Schema.Struct({
  deliveryId: Schema.NullOr(Schema.String),
  replayed: Schema.Boolean,
  messages: Schema.Array(WorkerMailboxMessageRecord),
  hasMore: Schema.Boolean,
  activeDispatches: Schema.Array(WorkerDispatchRecord),
  clampedTimeoutSec: Schema.Number,
});
export type WorkerCheckResult = typeof WorkerCheckResult.Type;

export const WorkerAckInput = Schema.Struct({
  deliveryId: Schema.String,
  consumerGeneration: Schema.optionalKey(Schema.Number),
});
export type WorkerAckInput = typeof WorkerAckInput.Type;

export const WorkerAckResult = Schema.Struct({
  deliveryId: Schema.String,
  acknowledged: Schema.Boolean,
  acknowledgedMessageCount: Schema.Number,
});
export type WorkerAckResult = typeof WorkerAckResult.Type;

export const WorkerStopInput = Schema.Struct({
  dispatchId: Schema.String,
  reason: Schema.optionalKey(Schema.String),
});
export type WorkerStopInput = typeof WorkerStopInput.Type;

export const WorkerStopResult = Schema.Struct({
  dispatchId: Schema.String,
  taskId: Schema.String,
  stopped: Schema.Boolean,
  status: WorkerDispatchStatus,
  alreadyTerminated: Schema.optionalKey(Schema.Boolean),
  message: Schema.optionalKey(Schema.String),
});
export type WorkerStopResult = typeof WorkerStopResult.Type;

export const WorkerGateCreateInput = Schema.Struct({
  taskId: Schema.String,
  dispatchId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  fencingToken: Schema.optionalKey(Schema.Number),
  riskLevel: WorkerDecisionGateRisk,
  question: Schema.String,
  options: Schema.optionalKey(Schema.Array(Schema.String)),
});
export type WorkerGateCreateInput = typeof WorkerGateCreateInput.Type;

export const WorkerGateResolveInput = Schema.Struct({
  gateId: Schema.String,
  decision: Schema.Literals(["approve", "deny"]),
  resolution: Schema.optionalKey(Schema.String),
  resolvedBy: Schema.optionalKey(Schema.String),
});
export type WorkerGateResolveInput = typeof WorkerGateResolveInput.Type;

export const WorkerWorktreeDiffResult = Schema.Struct({
  taskId: Schema.String,
  worktreePath: Schema.NullOr(Schema.String),
  worktreeBranch: Schema.NullOr(Schema.String),
  worktreeBaseRef: Schema.NullOr(Schema.String),
  worktreeState: WorkerWorktreeState,
  statusShort: Schema.String,
  diffStat: Schema.String,
  diffPatch: Schema.String,
  filesModified: Schema.Array(Schema.String),
});
export type WorkerWorktreeDiffResult = typeof WorkerWorktreeDiffResult.Type;

export const WorkerWorktreeActionResult = Schema.Struct({
  taskId: Schema.String,
  action: Schema.Literals(["merge", "discard"]),
  worktreeState: WorkerWorktreeState,
  mergedCommit: Schema.optionalKey(Schema.NullOr(Schema.String)),
  message: Schema.String,
});
export type WorkerWorktreeActionResult = typeof WorkerWorktreeActionResult.Type;

export const WorkerStatusResult = Schema.Struct({
  tasks: Schema.Array(WorkerTaskRecord),
  activeDispatches: Schema.Array(WorkerDispatchRecord),
  openGates: Schema.Array(WorkerDecisionGateRecord),
  unreadMailboxCount: Schema.Number,
});
export type WorkerStatusResult = typeof WorkerStatusResult.Type;

/** Clamp any caller-requested wait timeout into [1, WORKER_ENGINE_MAX_WAIT_SECONDS] (120s). */
export function clampWorkerWaitSeconds(rawSeconds: number | undefined, fallback = 60): number {
  const candidate =
    rawSeconds !== undefined && Number.isFinite(rawSeconds) ? Math.floor(rawSeconds) : fallback;
  return Math.max(
    WORKER_ENGINE_MIN_WAIT_SECONDS,
    Math.min(WORKER_ENGINE_MAX_WAIT_SECONDS, candidate),
  );
}
