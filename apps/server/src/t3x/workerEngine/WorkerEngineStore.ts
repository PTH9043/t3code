// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off
import * as NodeCrypto from "node:crypto";
import {
  WORKER_CIRCUIT_BREAKER_THRESHOLD,
  WORKER_HEARTBEAT_STALL_MS,
  WORKER_MAX_RUNNING_PER_THREAD,
  type WorkerCallerKind,
  type WorkerDispatchRecord,
  type WorkerDispatchStatus,
  type WorkerOutcome,
  type WorkerTaskRecord,
  type WorkerTaskStatus,
  type WorkerWorktreeMode,
  type WorkerWorktreeState,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export type WorkerEngineErrorCode =
  | "not_found"
  | "fencing_rejected"
  | "circuit_broken"
  | "concurrency_limit"
  | "invalid_state"
  | "conflict"
  | "worktree_error"
  | "storage_error";

export class WorkerEngineError extends Data.TaggedError("WorkerEngineError")<{
  readonly code: WorkerEngineErrorCode;
  readonly message: string;
  readonly details?: Record<string, unknown> | undefined;
}> {}

interface WorkerTaskRow {
  readonly task_id: string;
  readonly run_id: string;
  readonly thread_id: string;
  readonly owner_turn_id: string | null;
  readonly caller_kind: WorkerCallerKind;
  readonly dedup_key: string;
  readonly idempotency_key: string | null;
  readonly role: string;
  readonly target_instance_id: string;
  readonly target_model: string | null;
  readonly spec_text: string;
  readonly rag_facts_json: string | null;
  readonly status: WorkerTaskStatus;
  readonly active_dispatch_id: string | null;
  readonly fencing_epoch: number;
  readonly failure_count: number;
  readonly worktree_mode: WorkerWorktreeMode;
  readonly worktree_path: string | null;
  readonly worktree_branch: string | null;
  readonly worktree_base_ref: string | null;
  readonly worktree_state: WorkerWorktreeState;
  readonly cwd: string;
  readonly outcome_json: string | null;
  readonly created_at_ms: number;
  readonly updated_at_ms: number;
  readonly finished_at_ms: number | null;
}

interface WorkerDispatchRow {
  readonly dispatch_id: string;
  readonly task_id: string;
  readonly run_id: string;
  readonly thread_id: string;
  readonly attempt: number;
  readonly fencing_token: number;
  readonly retry_of_dispatch_id: string | null;
  readonly execution_id: string | null;
  readonly provider_instance_id: string;
  readonly model: string | null;
  readonly role: string;
  readonly status: WorkerDispatchStatus;
  readonly last_heartbeat_at_ms: number;
  readonly heartbeat_timeout_ms: number;
  readonly last_tool_summary: string | null;
  readonly result_text: string | null;
  readonly error_message: string | null;
  readonly started_at_ms: number;
  readonly finished_at_ms: number | null;
}

function parseOutcomeJson(raw: string | null): WorkerOutcome | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as WorkerOutcome;
  } catch {
    return null;
  }
}

function rowToTask(row: WorkerTaskRow): WorkerTaskRecord {
  return {
    taskId: row.task_id,
    runId: row.run_id,
    threadId: row.thread_id,
    ownerTurnId: row.owner_turn_id,
    callerKind: row.caller_kind,
    dedupKey: row.dedup_key,
    idempotencyKey: row.idempotency_key,
    role: row.role,
    targetInstanceId: row.target_instance_id,
    targetModel: row.target_model,
    specText: row.spec_text,
    ragFactsJson: row.rag_facts_json,
    status: row.status,
    activeDispatchId: row.active_dispatch_id,
    fencingEpoch: Number(row.fencing_epoch),
    failureCount: Number(row.failure_count),
    worktreeMode: row.worktree_mode,
    worktreePath: row.worktree_path,
    worktreeBranch: row.worktree_branch,
    worktreeBaseRef: row.worktree_base_ref,
    worktreeState: row.worktree_state,
    cwd: row.cwd,
    outcome: parseOutcomeJson(row.outcome_json),
    createdAtMs: Number(row.created_at_ms),
    updatedAtMs: Number(row.updated_at_ms),
    finishedAtMs: row.finished_at_ms === null ? null : Number(row.finished_at_ms),
  };
}

function rowToDispatch(row: WorkerDispatchRow): WorkerDispatchRecord {
  return {
    dispatchId: row.dispatch_id,
    taskId: row.task_id,
    runId: row.run_id,
    threadId: row.thread_id,
    attempt: Number(row.attempt),
    fencingToken: Number(row.fencing_token),
    retryOfDispatchId: row.retry_of_dispatch_id,
    executionId: row.execution_id,
    providerInstanceId: row.provider_instance_id,
    model: row.model,
    role: row.role,
    status: row.status,
    lastHeartbeatAtMs: Number(row.last_heartbeat_at_ms),
    heartbeatTimeoutMs: Number(row.heartbeat_timeout_ms),
    lastToolSummary: row.last_tool_summary,
    resultText: row.result_text,
    errorMessage: row.error_message,
    startedAtMs: Number(row.started_at_ms),
    finishedAtMs: row.finished_at_ms === null ? null : Number(row.finished_at_ms),
  };
}

export function computeWorkerDedupKey(input: {
  readonly role: string;
  readonly targetInstanceId: string;
  readonly targetModel?: string | null | undefined;
  readonly specText: string;
  readonly cwd: string;
}): string {
  const normalized = JSON.stringify({
    role: input.role.trim().toLowerCase(),
    targetInstanceId: input.targetInstanceId.trim(),
    targetModel: input.targetModel?.trim() ?? "",
    specText: input.specText.trim().replace(/\s+/g, " "),
    cwd: input.cwd.trim().toLowerCase(),
  });
  return NodeCrypto.createHash("sha256").update(normalized, "utf8").digest("hex").slice(0, 32);
}

export interface ClaimTaskDispatchInput {
  readonly taskId?: string | undefined;
  readonly dispatchId?: string | undefined;
  readonly runId: string;
  readonly threadId: string;
  readonly ownerTurnId?: string | null | undefined;
  readonly callerKind: WorkerCallerKind;
  readonly idempotencyKey?: string | null | undefined;
  readonly retryOfDispatchId?: string | null | undefined;
  readonly allowDuplicate?: boolean | undefined;
  readonly role: string;
  readonly targetInstanceId: string;
  readonly targetModel?: string | null | undefined;
  readonly specText: string;
  readonly ragFactsJson?: string | null | undefined;
  readonly cwd: string;
  readonly worktreeMode: WorkerWorktreeMode;
  readonly heartbeatTimeoutMs?: number | undefined;
  readonly maxRunningPerThread?: number | undefined;
  readonly executionId?: string | null | undefined;
}

export interface ClaimTaskDispatchResult {
  readonly task: WorkerTaskRecord;
  readonly dispatch: WorkerDispatchRecord;
  readonly deduplicated: boolean;
  readonly reusedIdempotency: boolean;
}

const mapSqlError = (operation: string) => (cause: unknown) =>
  new WorkerEngineError({
    code: "storage_error",
    message: `WorkerEngineStore.${operation} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
  });

export function makeWorkerEngineStore(sql: SqlClient.SqlClient) {
  const getTask = (taskId: string) =>
    sql<WorkerTaskRow>`SELECT * FROM worker_tasks WHERE task_id = ${taskId} LIMIT 1`.pipe(
      Effect.map((rows) => (rows[0] ? rowToTask(rows[0]) : null)),
      Effect.mapError(mapSqlError("getTask")),
    );

  const getDispatch = (dispatchId: string) =>
    sql<WorkerDispatchRow>`SELECT * FROM worker_dispatches WHERE dispatch_id = ${dispatchId} LIMIT 1`.pipe(
      Effect.map((rows) => (rows[0] ? rowToDispatch(rows[0]) : null)),
      Effect.mapError(mapSqlError("getDispatch")),
    );

  const listDispatchesByTask = (taskId: string) =>
    sql<WorkerDispatchRow>`
      SELECT * FROM worker_dispatches WHERE task_id = ${taskId} ORDER BY attempt DESC
    `.pipe(
      Effect.map((rows) => rows.map(rowToDispatch)),
      Effect.mapError(mapSqlError("listDispatchesByTask")),
    );

  const listTasks = (filter?: {
    readonly threadId?: string | undefined;
    readonly runId?: string | undefined;
    readonly taskId?: string | undefined;
    readonly limit?: number | undefined;
  }) =>
    Effect.gen(function* () {
      const limit = Math.max(1, Math.min(200, filter?.limit ?? 50));
      let rows: ReadonlyArray<WorkerTaskRow>;
      if (filter?.taskId) {
        rows = yield* sql<WorkerTaskRow>`
          SELECT * FROM worker_tasks WHERE task_id = ${filter.taskId} LIMIT ${limit}
        `;
      } else if (filter?.runId) {
        rows = yield* sql<WorkerTaskRow>`
          SELECT * FROM worker_tasks WHERE run_id = ${filter.runId} ORDER BY updated_at_ms DESC LIMIT ${limit}
        `;
      } else if (filter?.threadId) {
        rows = yield* sql<WorkerTaskRow>`
          SELECT * FROM worker_tasks WHERE thread_id = ${filter.threadId} ORDER BY updated_at_ms DESC LIMIT ${limit}
        `;
      } else {
        rows = yield* sql<WorkerTaskRow>`
          SELECT * FROM worker_tasks ORDER BY updated_at_ms DESC LIMIT ${limit}
        `;
      }
      return rows.map(rowToTask);
    }).pipe(Effect.mapError(mapSqlError("listTasks")));

  const listActiveDispatches = (filter?: {
    readonly threadId?: string | undefined;
    readonly runId?: string | undefined;
  }) =>
    Effect.gen(function* () {
      let rows: ReadonlyArray<WorkerDispatchRow>;
      if (filter?.runId) {
        rows = yield* sql<WorkerDispatchRow>`
          SELECT * FROM worker_dispatches
          WHERE run_id = ${filter.runId} AND status IN ('starting', 'running', 'stalled')
          ORDER BY started_at_ms ASC
        `;
      } else if (filter?.threadId) {
        rows = yield* sql<WorkerDispatchRow>`
          SELECT * FROM worker_dispatches
          WHERE thread_id = ${filter.threadId} AND status IN ('starting', 'running', 'stalled')
          ORDER BY started_at_ms ASC
        `;
      } else {
        rows = yield* sql<WorkerDispatchRow>`
          SELECT * FROM worker_dispatches
          WHERE status IN ('starting', 'running', 'stalled')
          ORDER BY started_at_ms ASC
        `;
      }
      return rows.map(rowToDispatch);
    }).pipe(Effect.mapError(mapSqlError("listActiveDispatches")));

  const claimTaskAndDispatch = (
    input: ClaimTaskDispatchInput,
  ): Effect.Effect<ClaimTaskDispatchResult, WorkerEngineError> =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const nowMs = yield* Clock.currentTimeMillis;
          const baseDedupKey = computeWorkerDedupKey({
            role: input.role,
            targetInstanceId: input.targetInstanceId,
            targetModel: input.targetModel,
            specText: input.specText,
            cwd: input.cwd,
          });
          const dedupKey = input.allowDuplicate
            ? `${baseDedupKey}:${NodeCrypto.randomUUID().replace(/-/g, "").slice(0, 8)}`
            : baseDedupKey;
          const idempotencyKey = input.idempotencyKey?.trim() || null;

          // 1. Idempotency receipt check (same caller retry returns the original task/dispatch).
          if (idempotencyKey) {
            const existingByKey = yield* sql<WorkerTaskRow>`
              SELECT * FROM worker_tasks WHERE idempotency_key = ${idempotencyKey} LIMIT 1
            `;
            if (existingByKey[0]) {
              const task = rowToTask(existingByKey[0]);
              const dispatchRows = yield* sql<WorkerDispatchRow>`
                SELECT * FROM worker_dispatches WHERE task_id = ${task.taskId} ORDER BY attempt DESC LIMIT 1
              `;
              if (dispatchRows[0]) {
                return {
                  task,
                  dispatch: rowToDispatch(dispatchRows[0]),
                  deduplicated: false,
                  reusedIdempotency: true,
                };
              }
            }
          }

          // 2. Active duplicate check (DB-backed deduplication across concurrent or repeated calls).
          // Allow explicit `dispatch({ taskId })` to start an approved `ready`/`pending` task.
          if (!input.retryOfDispatchId && !input.allowDuplicate) {
            const activeDupRows = yield* sql<WorkerTaskRow>`
              SELECT * FROM worker_tasks
              WHERE thread_id = ${input.threadId}
                AND dedup_key = ${dedupKey}
                AND status IN ('pending', 'ready', 'dispatched', 'blocked')
              LIMIT 1
            `;
            const dupCandidate = activeDupRows[0];
            const isExplicitReadyResume =
              dupCandidate !== undefined &&
              input.taskId !== undefined &&
              dupCandidate.task_id === input.taskId &&
              (dupCandidate.status === "ready" || dupCandidate.status === "pending");
            if (dupCandidate && !isExplicitReadyResume) {
              const task = rowToTask(dupCandidate);
              const dispatchRows = yield* sql<WorkerDispatchRow>`
                SELECT * FROM worker_dispatches
                WHERE dispatch_id = ${task.activeDispatchId ?? ""}
                LIMIT 1
              `;
              const fallbackRows = dispatchRows[0]
                ? dispatchRows
                : yield* sql<WorkerDispatchRow>`
                    SELECT * FROM worker_dispatches WHERE task_id = ${task.taskId} ORDER BY attempt DESC LIMIT 1
                  `;
              if (fallbackRows[0]) {
                return {
                  task,
                  dispatch: rowToDispatch(fallbackRows[0]),
                  deduplicated: true,
                  reusedIdempotency: false,
                };
              }
            }
          }

          // 3. Per-thread active concurrency ceiling (`WORKER_MAX_RUNNING_PER_THREAD = 6`).
          const maxRunning = input.maxRunningPerThread ?? WORKER_MAX_RUNNING_PER_THREAD;
          const runningCountRows = yield* sql<{ readonly cnt: number }>`
            SELECT COUNT(*) AS cnt FROM worker_dispatches
            WHERE thread_id = ${input.threadId} AND status IN ('starting', 'running', 'stalled')
          `;
          if (Number(runningCountRows[0]?.cnt ?? 0) >= maxRunning) {
            return yield* new WorkerEngineError({
              code: "concurrency_limit",
              message: `Thread ${input.threadId} already has ${maxRunning} active worker dispatches.`,
              details: { threadId: input.threadId, maxRunning },
            });
          }

          const heartbeatTimeoutMs = input.heartbeatTimeoutMs ?? WORKER_HEARTBEAT_STALL_MS;
          const dispatchId =
            input.dispatchId?.trim() ||
            `disp_${NodeCrypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;

          // 4. Retry path (`retryOfDispatchId`) — enforces settled prior attempt & circuit breaker.
          if (input.retryOfDispatchId) {
            const priorRows = yield* sql<WorkerDispatchRow>`
              SELECT * FROM worker_dispatches WHERE dispatch_id = ${input.retryOfDispatchId} LIMIT 1
            `;
            const prior = priorRows[0] ? rowToDispatch(priorRows[0]) : null;
            if (!prior) {
              return yield* new WorkerEngineError({
                code: "not_found",
                message: `Prior dispatch '${input.retryOfDispatchId}' not found.`,
              });
            }
            if (
              prior.status === "starting" ||
              prior.status === "running" ||
              prior.status === "stalled"
            ) {
              return yield* new WorkerEngineError({
                code: "invalid_state",
                message: `Prior dispatch '${prior.dispatchId}' is still active (${prior.status}). Stop it before retrying.`,
              });
            }
            const taskRows = yield* sql<WorkerTaskRow>`
              SELECT * FROM worker_tasks WHERE task_id = ${prior.taskId} LIMIT 1
            `;
            const existingTask = taskRows[0] ? rowToTask(taskRows[0]) : null;
            if (!existingTask) {
              return yield* new WorkerEngineError({
                code: "not_found",
                message: `Task '${prior.taskId}' not found for retry.`,
              });
            }
            if (existingTask.failureCount >= WORKER_CIRCUIT_BREAKER_THRESHOLD) {
              return yield* new WorkerEngineError({
                code: "circuit_broken",
                message: `Task '${existingTask.taskId}' failed ${existingTask.failureCount} times (limit ${WORKER_CIRCUIT_BREAKER_THRESHOLD}); circuit breaker prevents further automatic retries.`,
                details: { taskId: existingTask.taskId, failureCount: existingTask.failureCount },
              });
            }
            const nextEpoch = existingTask.fencingEpoch + 1;
            const nextAttempt = prior.attempt + 1;
            yield* sql`
              UPDATE worker_tasks
              SET status = 'dispatched',
                  active_dispatch_id = ${dispatchId},
                  fencing_epoch = ${nextEpoch},
                  updated_at_ms = ${nowMs},
                  finished_at_ms = NULL
              WHERE task_id = ${existingTask.taskId}
            `;
            yield* sql`
              INSERT INTO worker_dispatches (
                dispatch_id, task_id, run_id, thread_id, attempt, fencing_token,
                retry_of_dispatch_id, execution_id, provider_instance_id, model, role,
                status, last_heartbeat_at_ms, heartbeat_timeout_ms, started_at_ms
              ) VALUES (
                ${dispatchId}, ${existingTask.taskId}, ${existingTask.runId}, ${existingTask.threadId},
                ${nextAttempt}, ${nextEpoch}, ${prior.dispatchId}, ${input.executionId ?? null},
                ${input.targetInstanceId}, ${input.targetModel ?? existingTask.targetModel},
                ${input.role}, 'starting', ${nowMs}, ${heartbeatTimeoutMs}, ${nowMs}
              )
            `;
            const updatedTaskRows = yield* sql<WorkerTaskRow>`
              SELECT * FROM worker_tasks WHERE task_id = ${existingTask.taskId} LIMIT 1
            `;
            const newDispatchRows = yield* sql<WorkerDispatchRow>`
              SELECT * FROM worker_dispatches WHERE dispatch_id = ${dispatchId} LIMIT 1
            `;
            return {
              task: rowToTask(updatedTaskRows[0]!),
              dispatch: rowToDispatch(newDispatchRows[0]!),
              deduplicated: false,
              reusedIdempotency: false,
            };
          }

          // 5. Explicit existing ready task dispatch OR brand-new task creation.
          const taskId =
            input.taskId?.trim() ||
            `task_${NodeCrypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
          const existingTaskRows = yield* sql<WorkerTaskRow>`
            SELECT * FROM worker_tasks WHERE task_id = ${taskId} LIMIT 1
          `;

          let fencingToken = 1;
          let attempt = 1;

          if (existingTaskRows[0]) {
            const existing = rowToTask(existingTaskRows[0]);
            if (existing.status === "dispatched" || existing.status === "blocked") {
              return yield* new WorkerEngineError({
                code: "invalid_state",
                message: `Task '${taskId}' is already '${existing.status}' and cannot be started again.`,
              });
            }
            if (existing.failureCount >= WORKER_CIRCUIT_BREAKER_THRESHOLD) {
              return yield* new WorkerEngineError({
                code: "circuit_broken",
                message: `Task '${taskId}' exceeded circuit breaker threshold (${existing.failureCount}).`,
              });
            }
            const attemptRows = yield* sql<{ readonly maxAttempt: number | null }>`
              SELECT MAX(attempt) AS maxAttempt FROM worker_dispatches WHERE task_id = ${taskId}
            `;
            fencingToken = existing.fencingEpoch + 1;
            attempt = Number(attemptRows[0]?.maxAttempt ?? 0) + 1;
            yield* sql`
              UPDATE worker_tasks
              SET status = 'dispatched',
                  active_dispatch_id = ${dispatchId},
                  fencing_epoch = ${fencingToken},
                  updated_at_ms = ${nowMs},
                  finished_at_ms = NULL
              WHERE task_id = ${taskId}
            `;
          } else {
            yield* sql`
              INSERT INTO worker_tasks (
                task_id, run_id, thread_id, owner_turn_id, caller_kind,
                dedup_key, idempotency_key, role, target_instance_id, target_model,
                spec_text, rag_facts_json, status, active_dispatch_id, fencing_epoch,
                failure_count, worktree_mode, worktree_state, cwd,
                created_at_ms, updated_at_ms
              ) VALUES (
                ${taskId}, ${input.runId}, ${input.threadId}, ${input.ownerTurnId ?? null},
                ${input.callerKind}, ${dedupKey}, ${idempotencyKey}, ${input.role},
                ${input.targetInstanceId}, ${input.targetModel ?? null},
                ${input.specText}, ${input.ragFactsJson ?? null}, 'dispatched', ${dispatchId},
                ${fencingToken}, 0, ${input.worktreeMode}, 'none', ${input.cwd},
                ${nowMs}, ${nowMs}
              )
            `;
          }

          yield* sql`
            INSERT INTO worker_dispatches (
              dispatch_id, task_id, run_id, thread_id, attempt, fencing_token,
              retry_of_dispatch_id, execution_id, provider_instance_id, model, role,
              status, last_heartbeat_at_ms, heartbeat_timeout_ms, started_at_ms
            ) VALUES (
              ${dispatchId}, ${taskId}, ${input.runId}, ${input.threadId},
              ${attempt}, ${fencingToken}, NULL, ${input.executionId ?? null},
              ${input.targetInstanceId}, ${input.targetModel ?? null}, ${input.role},
              'starting', ${nowMs}, ${heartbeatTimeoutMs}, ${nowMs}
            )
          `;

          const taskRows = yield* sql<WorkerTaskRow>`
            SELECT * FROM worker_tasks WHERE task_id = ${taskId} LIMIT 1
          `;
          const dispatchRows = yield* sql<WorkerDispatchRow>`
            SELECT * FROM worker_dispatches WHERE dispatch_id = ${dispatchId} LIMIT 1
          `;
          return {
            task: rowToTask(taskRows[0]!),
            dispatch: rowToDispatch(dispatchRows[0]!),
            deduplicated: false,
            reusedIdempotency: false,
          };
        }),
      )
      .pipe(
        Effect.catch((error) =>
          error instanceof WorkerEngineError
            ? Effect.fail(error)
            : Effect.fail(mapSqlError("claimTaskAndDispatch")(error)),
        ),
      );

  const assertActiveFencing = (
    taskId: string,
    dispatchId: string,
    fencingToken: number,
  ): Effect.Effect<
    { readonly task: WorkerTaskRecord; readonly dispatch: WorkerDispatchRecord },
    WorkerEngineError
  > =>
    Effect.gen(function* () {
      const task = yield* getTask(taskId);
      if (!task) {
        return yield* new WorkerEngineError({
          code: "not_found",
          message: `Task '${taskId}' not found.`,
        });
      }
      const dispatch = yield* getDispatch(dispatchId);
      if (!dispatch || dispatch.taskId !== taskId) {
        return yield* new WorkerEngineError({
          code: "fencing_rejected",
          message: `Dispatch '${dispatchId}' does not belong to task '${taskId}'.`,
        });
      }
      if (
        task.activeDispatchId !== dispatchId ||
        task.fencingEpoch !== fencingToken ||
        dispatch.fencingToken !== fencingToken
      ) {
        return yield* new WorkerEngineError({
          code: "fencing_rejected",
          message: `Stale dispatch '${dispatchId}' (token ${fencingToken}) rejected; active dispatch is '${task.activeDispatchId}' (epoch ${task.fencingEpoch}).`,
          details: {
            taskId,
            dispatchId,
            fencingToken,
            activeDispatchId: task.activeDispatchId,
            fencingEpoch: task.fencingEpoch,
          },
        });
      }
      return { task, dispatch };
    });

  const markDispatchRunning = (dispatchId: string, fencingToken: number) =>
    Effect.gen(function* () {
      const nowMs = yield* Clock.currentTimeMillis;
      yield* sql`
        UPDATE worker_dispatches
        SET status = 'running', last_heartbeat_at_ms = ${nowMs}
        WHERE dispatch_id = ${dispatchId}
          AND fencing_token = ${fencingToken}
          AND status = 'starting'
      `.pipe(Effect.mapError(mapSqlError("markDispatchRunning")));
    });

  const recordHeartbeat = (dispatchId: string, fencingToken: number, toolSummary?: string | null) =>
    Effect.gen(function* () {
      const nowMs = yield* Clock.currentTimeMillis;
      const rows = yield* sql<WorkerDispatchRow>`
        SELECT * FROM worker_dispatches WHERE dispatch_id = ${dispatchId} LIMIT 1
      `.pipe(Effect.mapError(mapSqlError("recordHeartbeat")));
      const existing = rows[0];
      if (!existing) {
        return yield* new WorkerEngineError({
          code: "not_found",
          message: `Dispatch '${dispatchId}' not found.`,
        });
      }
      if (Number(existing.fencing_token) !== fencingToken) {
        return yield* new WorkerEngineError({
          code: "fencing_rejected",
          message: `Stale heartbeat for dispatch '${dispatchId}' (token ${fencingToken}).`,
        });
      }
      if (
        existing.status !== "starting" &&
        existing.status !== "running" &&
        existing.status !== "stalled"
      ) {
        return false;
      }
      yield* sql`
        UPDATE worker_dispatches
        SET status = 'running',
            last_heartbeat_at_ms = ${nowMs},
            last_tool_summary = COALESCE(${toolSummary ?? null}, last_tool_summary)
        WHERE dispatch_id = ${dispatchId} AND fencing_token = ${fencingToken}
      `.pipe(Effect.mapError(mapSqlError("recordHeartbeat")));
      return true;
    });

  const markDispatchStalled = (dispatchId: string, fencingToken: number) =>
    sql`
      UPDATE worker_dispatches
      SET status = 'stalled'
      WHERE dispatch_id = ${dispatchId}
        AND fencing_token = ${fencingToken}
        AND status IN ('starting', 'running')
    `.pipe(Effect.asVoid, Effect.mapError(mapSqlError("markDispatchStalled")));

  const completeDispatch = (input: {
    readonly taskId: string;
    readonly dispatchId: string;
    readonly fencingToken: number;
    readonly status: Extract<WorkerDispatchStatus, "completed" | "failed" | "cancelled">;
    readonly outcome: WorkerOutcome;
    readonly resultText?: string | null | undefined;
    readonly errorMessage?: string | null | undefined;
    readonly worktreeState?: WorkerWorktreeState | undefined;
  }): Effect.Effect<
    { readonly task: WorkerTaskRecord; readonly dispatch: WorkerDispatchRecord },
    WorkerEngineError
  > =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const { task } = yield* assertActiveFencing(
            input.taskId,
            input.dispatchId,
            input.fencingToken,
          );
          const nowMs = yield* Clock.currentTimeMillis;
          const nextTaskStatus: WorkerTaskStatus =
            input.status === "completed"
              ? "completed"
              : input.status === "cancelled"
                ? "cancelled"
                : "failed";
          const nextFailureCount =
            input.status === "failed" ? task.failureCount + 1 : task.failureCount;
          const nextWorktreeState =
            input.worktreeState ??
            (task.worktreePath && task.worktreeState === "active"
              ? "review_ready"
              : task.worktreeState);

          yield* sql`
            UPDATE worker_dispatches
            SET status = ${input.status},
                last_heartbeat_at_ms = ${nowMs},
                result_text = ${input.resultText ?? null},
                error_message = ${input.errorMessage ?? null},
                finished_at_ms = ${nowMs}
            WHERE dispatch_id = ${input.dispatchId} AND fencing_token = ${input.fencingToken}
          `;

          yield* sql`
            UPDATE worker_tasks
            SET status = ${nextTaskStatus},
                active_dispatch_id = NULL,
                failure_count = ${nextFailureCount},
                worktree_state = ${nextWorktreeState},
                outcome_json = ${JSON.stringify(input.outcome)},
                updated_at_ms = ${nowMs},
                finished_at_ms = ${nowMs}
            WHERE task_id = ${input.taskId}
          `;

          const updatedTaskRows = yield* sql<WorkerTaskRow>`
            SELECT * FROM worker_tasks WHERE task_id = ${input.taskId} LIMIT 1
          `;
          const updatedDispatchRows = yield* sql<WorkerDispatchRow>`
            SELECT * FROM worker_dispatches WHERE dispatch_id = ${input.dispatchId} LIMIT 1
          `;
          return {
            task: rowToTask(updatedTaskRows[0]!),
            dispatch: rowToDispatch(updatedDispatchRows[0]!),
          };
        }),
      )
      .pipe(
        Effect.catch((error) =>
          error instanceof WorkerEngineError
            ? Effect.fail(error)
            : Effect.fail(mapSqlError("completeDispatch")(error)),
        ),
      );

  const updateTaskWorktree = (input: {
    readonly taskId: string;
    readonly worktreeMode?: WorkerWorktreeMode | undefined;
    readonly worktreePath?: string | null | undefined;
    readonly worktreeBranch?: string | null | undefined;
    readonly worktreeBaseRef?: string | null | undefined;
    readonly worktreeState: WorkerWorktreeState;
  }) =>
    Effect.gen(function* () {
      const nowMs = yield* Clock.currentTimeMillis;
      const existing = yield* getTask(input.taskId);
      if (!existing) {
        return yield* new WorkerEngineError({
          code: "not_found",
          message: `Task '${input.taskId}' not found.`,
        });
      }
      yield* sql`
        UPDATE worker_tasks
        SET worktree_mode = ${input.worktreeMode ?? existing.worktreeMode},
            worktree_path = ${input.worktreePath !== undefined ? input.worktreePath : existing.worktreePath},
            worktree_branch = ${input.worktreeBranch !== undefined ? input.worktreeBranch : existing.worktreeBranch},
            worktree_base_ref = ${input.worktreeBaseRef !== undefined ? input.worktreeBaseRef : existing.worktreeBaseRef},
            worktree_state = ${input.worktreeState},
            updated_at_ms = ${nowMs}
        WHERE task_id = ${input.taskId}
      `.pipe(Effect.mapError(mapSqlError("updateTaskWorktree")));
      return (yield* getTask(input.taskId))!;
    });

  const updateTaskStatus = (
    taskId: string,
    status: WorkerTaskStatus,
    clearActiveDispatch = false,
  ) =>
    Effect.gen(function* () {
      const nowMs = yield* Clock.currentTimeMillis;
      yield* clearActiveDispatch
        ? sql`
            UPDATE worker_tasks
            SET status = ${status}, active_dispatch_id = NULL, updated_at_ms = ${nowMs}
            WHERE task_id = ${taskId}
          `.pipe(Effect.mapError(mapSqlError("updateTaskStatus")))
        : sql`
            UPDATE worker_tasks
            SET status = ${status}, updated_at_ms = ${nowMs}
            WHERE task_id = ${taskId}
          `.pipe(Effect.mapError(mapSqlError("updateTaskStatus")));
    });

  /**
   * Called once on server startup: any dispatch still `starting | running | stalled`
   * from a prior process is marked `interrupted_by_restart`. Its task transitions
   * to `failed` with its worktree preserved in `review_ready` (never auto-deleted)
   * so the supervisor can inspect diff or `--retry-of <dispatchId>`.
   */
  const reconcileInterruptedDispatches = (): Effect.Effect<
    ReadonlyArray<{ readonly task: WorkerTaskRecord; readonly dispatch: WorkerDispatchRecord }>,
    WorkerEngineError
  > =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const nowMs = yield* Clock.currentTimeMillis;
          const activeRows = yield* sql<WorkerDispatchRow>`
            SELECT * FROM worker_dispatches
            WHERE status IN ('starting', 'running', 'stalled')
            ORDER BY started_at_ms ASC
          `;
          if (activeRows.length === 0) return [];
          const reconciled: Array<{
            readonly task: WorkerTaskRecord;
            readonly dispatch: WorkerDispatchRecord;
          }> = [];
          for (const row of activeRows) {
            const dispatch = rowToDispatch(row);
            yield* sql`
              UPDATE worker_dispatches
              SET status = 'interrupted_by_restart',
                  error_message = COALESCE(error_message, '서버 재시작으로 인해 작업자 실행이 중단되었습니다.'),
                  finished_at_ms = ${nowMs}
              WHERE dispatch_id = ${dispatch.dispatchId}
            `;
            const taskRows = yield* sql<WorkerTaskRow>`
              SELECT * FROM worker_tasks WHERE task_id = ${dispatch.taskId} LIMIT 1
            `;
            if (taskRows[0]) {
              const task = rowToTask(taskRows[0]);
              const preservedWorktreeState: WorkerWorktreeState =
                task.worktreePath && task.worktreeState === "active"
                  ? "review_ready"
                  : task.worktreeState;
              yield* sql`
                UPDATE worker_tasks
                SET status = 'failed',
                    active_dispatch_id = NULL,
                    worktree_state = ${preservedWorktreeState},
                    updated_at_ms = ${nowMs},
                    finished_at_ms = ${nowMs}
                WHERE task_id = ${task.taskId}
                  AND active_dispatch_id = ${dispatch.dispatchId}
              `;
              const freshTask = yield* sql<WorkerTaskRow>`
                SELECT * FROM worker_tasks WHERE task_id = ${task.taskId} LIMIT 1
              `;
              const freshDispatch = yield* sql<WorkerDispatchRow>`
                SELECT * FROM worker_dispatches WHERE dispatch_id = ${dispatch.dispatchId} LIMIT 1
              `;
              if (freshTask[0] && freshDispatch[0]) {
                reconciled.push({
                  task: rowToTask(freshTask[0]),
                  dispatch: rowToDispatch(freshDispatch[0]),
                });
              }
            }
          }
          return reconciled;
        }),
      )
      .pipe(
        Effect.catch((error) =>
          error instanceof WorkerEngineError
            ? Effect.fail(error)
            : Effect.fail(mapSqlError("reconcileInterruptedDispatches")(error)),
        ),
      );

  const abandonPreFlightDispatch = (taskId: string, dispatchId: string) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const nowMs = yield* Clock.currentTimeMillis;
          yield* sql`
            UPDATE worker_dispatches
            SET status = 'abandoned', finished_at_ms = ${nowMs}
            WHERE dispatch_id = ${dispatchId} AND status = 'starting'
          `;
          yield* sql`
            UPDATE worker_tasks
            SET active_dispatch_id = NULL, updated_at_ms = ${nowMs}
            WHERE task_id = ${taskId} AND active_dispatch_id = ${dispatchId}
          `;
        }),
      )
      .pipe(Effect.mapError(mapSqlError("abandonPreFlightDispatch")));

  return {
    getTask,
    getDispatch,
    listTasks,
    listDispatchesByTask,
    listActiveDispatches,
    claimTaskAndDispatch,
    assertActiveFencing,
    markDispatchRunning,
    recordHeartbeat,
    markDispatchStalled,
    completeDispatch,
    updateTaskWorktree,
    updateTaskStatus,
    abandonPreFlightDispatch,
    reconcileInterruptedDispatches,
  };
}

export type WorkerEngineStore = ReturnType<typeof makeWorkerEngineStore>;
