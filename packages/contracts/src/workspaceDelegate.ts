import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { DelegateMandate } from "./delegateMandate.ts";
import { HandoffEnvelopeV1 } from "./handoffContract.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import { SubordinateRole } from "./settings.ts";

/**
 * Hands a task from the answering model to a model the user placed under it
 * (account settings, "하위 모델"). The subordinate runs as a full agent in the
 * same working directory and its answer comes back as the tool result.
 */
export const WorkspaceDelegateLimitReason = Schema.Literals([
  "max_wall_time",
  "max_idle",
  "max_wait_rounds",
]);
export type WorkspaceDelegateLimitReason = typeof WorkspaceDelegateLimitReason.Type;

export const WorkspaceDelegateCriticContext = Schema.Struct({
  /** Independent pinned specification or acceptance criteria (separate from author summary). */
  pinnedSpec: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(16_000))),
  /** Raw deterministic verifier output (test/typecheck/lint/git diff evidence). */
  deterministicEvidence: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(20_000))),
  /** Explicit independent review checklist items. */
  checklist: Schema.optionalKey(Schema.Array(TrimmedNonEmptyString)),
  /**
   * Opt-in review profile. Defaults to "standard".
   * Only when explicitly set to "security" does the advisor inject the
   * evidence-based security-audit rubric (never auto-forced on ordinary tasks).
   */
  auditProfile: Schema.optionalKey(Schema.Literals(["standard", "security"])),
});
export type WorkspaceDelegateCriticContext = typeof WorkspaceDelegateCriticContext.Type;

export const WorkspaceDelegateVerifySpec = Schema.Struct({
  /** Executable name (e.g. "node", "vp", "git", "python"). Direct execFile without shell injection. */
  command: TrimmedNonEmptyString,
  /** Command arguments. */
  args: Schema.optionalKey(Schema.Array(Schema.String)),
  /** Optional relative subdirectory inside the workspace root. */
  cwdRelative: Schema.optionalKey(TrimmedNonEmptyString),
  /** Optional timeout in milliseconds (default 60_000, max 120_000). */
  timeoutMs: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1_000)).check(
      Schema.isLessThanOrEqualTo(120_000),
    ),
  ),
  /** Expected exit codes (default [0]). */
  expectedExitCodes: Schema.optionalKey(Schema.Array(Schema.Int)),
});
export type WorkspaceDelegateVerifySpec = typeof WorkspaceDelegateVerifySpec.Type;

export const WorkspaceDelegateTaskItem = Schema.Struct({
  /** The subordinate for this task: its role, model, "auto", or exact address. */
  to: TrimmedNonEmptyString,
  /** The self-contained assignment. The subordinate sees nothing else of the conversation. */
  task: TrimmedNonEmptyString.check(Schema.isMaxLength(60_000)),
  /** Optional 6-field structured handoff envelope enforcing refs, write_policy, and done_when. */
  handoff: Schema.optionalKey(HandoffEnvelopeV1),
  /** Optional immutable authorization boundary for this delegation. */
  mandate: Schema.optionalKey(DelegateMandate),
  /** Optional independent critic context (used for advisor/reviewer isolation). */
  criticContext: Schema.optionalKey(WorkspaceDelegateCriticContext),
  /** When true on write-capable roles (`worker`/`writer`), allocates an isolated Git worktree to prevent concurrent file collisions. */
  worktreeIsolation: Schema.optionalKey(Schema.Boolean),
  /** Set true to spawn a fresh run even if an identical delegation is already running. */
  allowDuplicate: Schema.optionalKey(Schema.Boolean),
});
export type WorkspaceDelegateTaskItem = typeof WorkspaceDelegateTaskItem.Type;

export const WorkspaceDelegateInput = Schema.Struct({
  /**
   * `status` lists the caller's subordinates and active delegations. `run` starts
   * one task and waits up to the client-safe timeout. `run_parallel` starts multiple
   * independent tasks concurrently and waits together. `start` starts one task (or
   * `tasks[]`) without waiting and returns delegationId(s) immediately. `start_parallel`
   * starts `tasks[]` without waiting and returns all delegationIds. `wait` collects
   * one (`delegationId`) or several (`delegationIds`) delegations with per-item results.
   * `join` acts as a barrier over a `batchRunId` or `delegationIds` and reports
   * `allSettled`, `counts`, and `unresolvedIds`. `verify` runs a deterministic check
   * (`command_exit`) in the workspace before/alongside LLM review. `cancel` stops one (`delegationId`).
   */
  action: Schema.Literals([
    "status",
    "run",
    "run_parallel",
    "start",
    "start_parallel",
    "wait",
    "join",
    "verify",
    "cancel",
  ]),
  /** The subordinate for `run`/`start`: its role, "auto", or its model when several share a role. */
  to: Schema.optionalKey(TrimmedNonEmptyString),
  /** The self-contained assignment for `run`/`start`. The subordinate sees nothing else of the conversation. */
  task: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(60_000))),
  /** Optional 6-field structured handoff envelope for `run`/`start`. */
  handoff: Schema.optionalKey(HandoffEnvelopeV1),
  /** Optional immutable authorization boundary for `run`/`start`. */
  mandate: Schema.optionalKey(DelegateMandate),
  /** Optional independent critic context for `advisor` isolated review. */
  criticContext: Schema.optionalKey(WorkspaceDelegateCriticContext),
  /** When true on write-capable roles (`worker`/`writer`), allocates an isolated Git worktree for this delegation. */
  worktreeIsolation: Schema.optionalKey(Schema.Boolean),
  /** Optional deterministic verification spec for `action: "verify"`. */
  verifySpec: Schema.optionalKey(WorkspaceDelegateVerifySpec),
  /** Optional per-call wait timeout in seconds (clamped to 10..120s to stay under 180s client limit). */
  waitTimeoutSec: Schema.optionalKey(Schema.Number),
  /** Set true to spawn a fresh run even if an identical delegation is already running. */
  allowDuplicate: Schema.optionalKey(Schema.Boolean),
  /** Emit a thread completion activity/notification when a background delegation settles. */
  notifyOnComplete: Schema.optionalKey(Schema.Boolean),
  /** Multiple assignments to launch concurrently with `run_parallel` / `start_parallel` / `start`. */
  tasks: Schema.optionalKey(Schema.Array(WorkspaceDelegateTaskItem)),
  /** Returned by a `start` or `run` that was still working. Used by `wait` and `cancel`. */
  delegationId: Schema.optionalKey(TrimmedNonEmptyString),
  /** Multiple delegation IDs to collect concurrently with `action: "wait"` or `action: "join"`. */
  delegationIds: Schema.optionalKey(Schema.Array(TrimmedNonEmptyString)),
  /** Batch run identifier returned by `start_parallel` / `run_parallel`, usable with `action: "join"`. */
  batchRunId: Schema.optionalKey(TrimmedNonEmptyString),
});
export type WorkspaceDelegateInput = typeof WorkspaceDelegateInput.Type;

export const WorkspaceDelegateSubordinate = Schema.Struct({
  unavailable: Schema.optionalKey(Schema.Literal(true)),
  role: SubordinateRole,
  /** Display name of the account the subordinate runs on. */
  account: Schema.String,
  instanceId: ProviderInstanceId,
  model: Schema.String,
});
export type WorkspaceDelegateSubordinate = typeof WorkspaceDelegateSubordinate.Type;

export const WorkspaceDelegateItemStatus = Schema.Literals([
  "completed",
  "running",
  "stalled",
  "failed",
  "cancelled",
  "limit_exceeded",
  "interrupted_by_restart",
  "not_found",
]);
export type WorkspaceDelegateItemStatus = typeof WorkspaceDelegateItemStatus.Type;

export const WorkspaceDelegateBatchItemResult = Schema.Struct({
  to: Schema.String,
  status: WorkspaceDelegateItemStatus,
  delegationId: Schema.String,
  text: Schema.NullOr(Schema.String),
  message: Schema.NullOr(Schema.String),
  deduplicated: Schema.optionalKey(Schema.Boolean),
  lastActivityAt: Schema.optionalKey(Schema.String),
  lastToolSummary: Schema.optionalKey(Schema.NullOr(Schema.String)),
  elapsedSec: Schema.optionalKey(Schema.Number),
  remainingWaitRounds: Schema.optionalKey(Schema.Number),
  limitReason: Schema.optionalKey(WorkspaceDelegateLimitReason),
  worktreePath: Schema.optionalKey(Schema.NullOr(Schema.String)),
  worktreeBranch: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
export type WorkspaceDelegateBatchItemResult = typeof WorkspaceDelegateBatchItemResult.Type;

export const WorkspaceDelegateBatchCounts = Schema.Struct({
  total: Schema.Int,
  completed: Schema.Int,
  running: Schema.Int,
  stalled: Schema.Int,
  failed: Schema.Int,
  cancelled: Schema.Int,
  limitExceeded: Schema.Int,
  interruptedByRestart: Schema.Int,
  notFound: Schema.Int,
});
export type WorkspaceDelegateBatchCounts = typeof WorkspaceDelegateBatchCounts.Type;

export const WorkspaceDelegateVerifierOutcome = Schema.Struct({
  verdict: Schema.Literals(["CONFIRM", "REJECT", "UNVERIFIED_ERROR"]),
  passed: Schema.Boolean,
  exitCode: Schema.NullOr(Schema.Int),
  summary: Schema.String,
  stdoutTail: Schema.String,
  stderrTail: Schema.String,
});
export type WorkspaceDelegateVerifierOutcome = typeof WorkspaceDelegateVerifierOutcome.Type;

export const WorkspaceDelegateResult = Schema.Struct({
  /** The subordinates assigned to the calling model. Empty when none are. */
  subordinates: Schema.Array(WorkspaceDelegateSubordinate),
  /** Null for `status`. `running` means: call `wait` with `delegationId` / `delegationIds`. */
  status: Schema.NullOr(WorkspaceDelegateItemStatus),
  delegationId: Schema.NullOr(Schema.String),
  /** The subordinate's answer once `completed`. */
  text: Schema.NullOr(Schema.String),
  message: Schema.NullOr(Schema.String),
  /** Populated by `run_parallel`, `start_parallel`, `wait` (multi-ID), and `join`. */
  results: Schema.optionalKey(Schema.Array(WorkspaceDelegateBatchItemResult)),
  /** Batch run ID for split/join correlation. */
  batchRunId: Schema.optionalKey(Schema.String),
  /** True when every delegation in a `join` / batch call has reached a terminal state. */
  allSettled: Schema.optionalKey(Schema.Boolean),
  /** Unsettled delegation IDs remaining in a `join` / batch call. */
  unresolvedIds: Schema.optionalKey(Schema.Array(Schema.String)),
  /** Structured status counts for batch / `join` reporting. */
  counts: Schema.optionalKey(WorkspaceDelegateBatchCounts),
  /** Populated by `action: "verify"` deterministic command checks. */
  verifierOutcome: Schema.optionalKey(WorkspaceDelegateVerifierOutcome),
  /** Populated when `worktreeIsolation: true` provisioned an isolated Git worktree. */
  worktreePath: Schema.optionalKey(Schema.NullOr(Schema.String)),
  /** Populated when `worktreeIsolation: true` provisioned an isolated Git branch. */
  worktreeBranch: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
export type WorkspaceDelegateResult = typeof WorkspaceDelegateResult.Type;

export class WorkspaceDelegateError extends Schema.TaggedErrorClass<WorkspaceDelegateError>()(
  "WorkspaceDelegateError",
  { message: Schema.String },
) {}
