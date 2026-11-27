import { Schema } from "effect";

/**
 * Canonical 9 collaboration / multi-agent execution paths in T3 Code.
 * Every path registers into ActiveWorkTracker, persists to `unified_execution_runs`,
 * tags spans with `t3.execution_kind`, and transitions to `interrupted_by_restart` on reboot.
 */
export const ExecutionKind = Schema.Literals([
  "orchestra",
  "meeting",
  "workflow_v2",
  "workspace_delegate",
  "council",
  "workspace_helper",
  "upgrade_room",
  "claude_subagent",
  "codex_subagent",
]);
export type ExecutionKind = typeof ExecutionKind.Type;

export const ALL_EXECUTION_KINDS: ReadonlyArray<ExecutionKind> = [
  "orchestra",
  "meeting",
  "workflow_v2",
  "workspace_delegate",
  "council",
  "workspace_helper",
  "upgrade_room",
  "claude_subagent",
  "codex_subagent",
];

export const ActiveWorkCategory = Schema.Literals(["delegation", "collaboration"]);
export type ActiveWorkCategory = typeof ActiveWorkCategory.Type;

export const ExecutionRunStatus = Schema.Literals([
  "running",
  "completed",
  "failed",
  "cancelled",
  "interrupted_by_restart",
]);
export type ExecutionRunStatus = typeof ExecutionRunStatus.Type;

export const ExecutionLedgerEntry = Schema.Struct({
  executionId: Schema.String,
  executionKind: ExecutionKind,
  activeWorkKind: ActiveWorkCategory,
  threadId: Schema.String,
  projectId: Schema.NullOr(Schema.String),
  parentRunId: Schema.NullOr(Schema.String),
  summary: Schema.String,
  status: ExecutionRunStatus,
  provider: Schema.NullOr(Schema.String),
  model: Schema.NullOr(Schema.String),
  errorMessage: Schema.NullOr(Schema.String),
  startedAtMs: Schema.Number,
  updatedAtMs: Schema.Number,
  finishedAtMs: Schema.NullOr(Schema.Number),
});
export type ExecutionLedgerEntry = typeof ExecutionLedgerEntry.Type;

export const ExecutionKindCounts = Schema.Struct({
  executionKind: ExecutionKind,
  running: Schema.Number,
  completed: Schema.Number,
  failed: Schema.Number,
  cancelled: Schema.Number,
  interruptedByRestart: Schema.Number,
  total: Schema.Number,
});
export type ExecutionKindCounts = typeof ExecutionKindCounts.Type;

export const ExecutionLedgerSummary = Schema.Struct({
  totalRuns: Schema.Number,
  activeRuns: Schema.Number,
  byKind: Schema.Array(ExecutionKindCounts),
  recentRuns: Schema.Array(ExecutionLedgerEntry),
});
export type ExecutionLedgerSummary = typeof ExecutionLedgerSummary.Type;
