// @effect-diagnostics globalDate:off globalDateInEffect:off anyUnknownInErrorContext:off
import {
  ALL_EXECUTION_KINDS,
  type ActiveWorkCategory,
  type ExecutionKind,
  type ExecutionKindCounts,
  type ExecutionLedgerEntry,
  type ExecutionLedgerSummary,
  type ExecutionRunStatus,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { activeWorkRegistry } from "../../orchestration/ActiveWorkTracker.ts";

const MAX_IN_MEMORY_RUNS = 2_000;
const RESTART_INTERRUPTED_DEFAULT_MESSAGE = "서버 재시작으로 인해 실행이 중단되었습니다.";

export function activeWorkKindForExecutionKind(executionKind: ExecutionKind): ActiveWorkCategory {
  switch (executionKind) {
    case "workspace_delegate":
    case "workspace_helper":
    case "claude_subagent":
    case "codex_subagent":
      return "delegation";
    case "orchestra":
    case "meeting":
    case "workflow_v2":
    case "council":
    case "upgrade_room":
      return "collaboration";
  }
}

export interface BeginExecutionInput {
  readonly executionId: string;
  readonly executionKind: ExecutionKind;
  readonly activeWorkKind?: ActiveWorkCategory | undefined;
  readonly threadId: string;
  readonly projectId?: string | null | undefined;
  readonly parentRunId?: string | null | undefined;
  readonly summary: string;
  readonly provider?: string | null | undefined;
  readonly model?: string | null | undefined;
  readonly startedAtMs?: number | undefined;
}

export interface FinishExecutionInput {
  readonly executionId: string;
  readonly executionKind?: ExecutionKind | undefined;
  readonly activeWorkKind?: ActiveWorkCategory | undefined;
  readonly status: Exclude<ExecutionRunStatus, "running">;
  readonly errorMessage?: string | null | undefined;
  readonly finishedAtMs?: number | undefined;
}

interface UnifiedExecutionRow {
  readonly execution_id: string;
  readonly execution_kind: ExecutionKind;
  readonly active_work_kind: ActiveWorkCategory;
  readonly thread_id: string;
  readonly project_id: string | null;
  readonly parent_run_id: string | null;
  readonly summary: string;
  readonly status: ExecutionRunStatus;
  readonly provider: string | null;
  readonly model: string | null;
  readonly error_message: string | null;
  readonly started_at_ms: number;
  readonly updated_at_ms: number;
  readonly finished_at_ms: number | null;
}

function rowToEntry(row: UnifiedExecutionRow): ExecutionLedgerEntry {
  return {
    executionId: row.execution_id,
    executionKind: row.execution_kind,
    activeWorkKind: row.active_work_kind,
    threadId: row.thread_id,
    projectId: row.project_id,
    parentRunId: row.parent_run_id,
    summary: row.summary,
    status: row.status,
    provider: row.provider,
    model: row.model,
    errorMessage: row.error_message,
    startedAtMs: row.started_at_ms,
    updatedAtMs: row.updated_at_ms,
    finishedAtMs: row.finished_at_ms,
  };
}

export function annotateExecutionSpan(input: {
  readonly executionKind: ExecutionKind;
  readonly executionId: string;
  readonly threadId: string;
  readonly projectId?: string | null | undefined;
  readonly parentRunId?: string | null | undefined;
  readonly provider?: string | null | undefined;
  readonly model?: string | null | undefined;
}): Effect.Effect<void> {
  return Effect.annotateCurrentSpan({
    "t3.execution_kind": input.executionKind,
    "t3.execution_id": input.executionId,
    "t3.thread_id": input.threadId,
    ...(input.projectId ? { "t3.project_id": input.projectId } : {}),
    ...(input.parentRunId ? { "t3.parent_run_id": input.parentRunId } : {}),
    ...(input.provider ? { "t3.provider": input.provider } : {}),
    ...(input.model ? { "t3.model": input.model } : {}),
  });
}

function summarizeEntries(
  entries: ReadonlyArray<ExecutionLedgerEntry>,
  limit: number,
): ExecutionLedgerSummary {
  const countsMap = new Map<
    ExecutionKind,
    {
      running: number;
      completed: number;
      failed: number;
      cancelled: number;
      interruptedByRestart: number;
      total: number;
    }
  >();
  for (const kind of ALL_EXECUTION_KINDS) {
    countsMap.set(kind, {
      running: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
      interruptedByRestart: 0,
      total: 0,
    });
  }
  let activeRuns = 0;
  for (const entry of entries) {
    const bucket = countsMap.get(entry.executionKind);
    if (!bucket) continue;
    bucket.total += 1;
    switch (entry.status) {
      case "running":
        bucket.running += 1;
        activeRuns += 1;
        break;
      case "completed":
        bucket.completed += 1;
        break;
      case "failed":
        bucket.failed += 1;
        break;
      case "cancelled":
        bucket.cancelled += 1;
        break;
      case "interrupted_by_restart":
        bucket.interruptedByRestart += 1;
        break;
    }
  }
  const byKind: ExecutionKindCounts[] = ALL_EXECUTION_KINDS.map((executionKind) => {
    const bucket = countsMap.get(executionKind)!;
    return {
      executionKind,
      ...bucket,
    };
  });
  const sorted = [...entries].sort((a, b) => b.startedAtMs - a.startedAtMs).slice(0, limit);
  return {
    totalRuns: entries.length,
    activeRuns,
    byKind,
    recentRuns: sorted,
  };
}

/**
 * Process-wide Unified Execution Ledger spanning all 9 collaboration paths.
 * Keeps `activeWorkRegistry` (`active-work.json`) and SQLite `unified_execution_runs`
 * in sync without introducing circular Effect Layer dependencies across provider adapters.
 */
class UnifiedExecutionLedgerImpl {
  private readonly runs = new Map<string, ExecutionLedgerEntry>();
  private readonly pendingWrites = new Set<Promise<void>>();
  private sqlClient: SqlClient.SqlClient | null = null;

  attachSqlClient(sql: SqlClient.SqlClient): void {
    this.sqlClient = sql;
  }

  detachSqlClient(): void {
    this.sqlClient = null;
  }

  private trimInMemory(): void {
    if (this.runs.size <= MAX_IN_MEMORY_RUNS) return;
    for (const [id, entry] of this.runs) {
      if (entry.status !== "running") {
        this.runs.delete(id);
        if (this.runs.size <= MAX_IN_MEMORY_RUNS) break;
      }
    }
  }

  private schedulePersist(effect: Effect.Effect<void, unknown>): void {
    const promise = Effect.runPromise(effect.pipe(Effect.catch(() => Effect.void))).finally(() => {
      this.pendingWrites.delete(promise);
    });
    this.pendingWrites.add(promise);
  }

  private upsertSql(
    sql: SqlClient.SqlClient,
    entry: ExecutionLedgerEntry,
  ): Effect.Effect<void, unknown> {
    return sql`INSERT INTO unified_execution_runs (
      execution_id,
      execution_kind,
      active_work_kind,
      thread_id,
      project_id,
      parent_run_id,
      summary,
      status,
      provider,
      model,
      error_message,
      started_at_ms,
      updated_at_ms,
      finished_at_ms
    ) VALUES (
      ${entry.executionId},
      ${entry.executionKind},
      ${entry.activeWorkKind},
      ${entry.threadId},
      ${entry.projectId},
      ${entry.parentRunId},
      ${entry.summary},
      ${entry.status},
      ${entry.provider},
      ${entry.model},
      ${entry.errorMessage},
      ${entry.startedAtMs},
      ${entry.updatedAtMs},
      ${entry.finishedAtMs}
    )
    ON CONFLICT(execution_id) DO UPDATE SET
      execution_kind = excluded.execution_kind,
      active_work_kind = excluded.active_work_kind,
      thread_id = excluded.thread_id,
      project_id = COALESCE(excluded.project_id, unified_execution_runs.project_id),
      parent_run_id = COALESCE(excluded.parent_run_id, unified_execution_runs.parent_run_id),
      summary = excluded.summary,
      status = excluded.status,
      provider = COALESCE(excluded.provider, unified_execution_runs.provider),
      model = COALESCE(excluded.model, unified_execution_runs.model),
      error_message = excluded.error_message,
      updated_at_ms = excluded.updated_at_ms,
      finished_at_ms = excluded.finished_at_ms`.pipe(Effect.asVoid);
  }

  private settleSql(
    sql: SqlClient.SqlClient,
    input: {
      readonly executionId: string;
      readonly status: Exclude<ExecutionRunStatus, "running">;
      readonly errorMessage: string | null;
      readonly finishedAtMs: number;
    },
  ): Effect.Effect<void, unknown> {
    return sql`UPDATE unified_execution_runs
      SET status = ${input.status},
          error_message = COALESCE(${input.errorMessage}, error_message),
          updated_at_ms = ${input.finishedAtMs},
          finished_at_ms = ${input.finishedAtMs}
      WHERE execution_id = ${input.executionId}
        AND status = 'running'`.pipe(Effect.asVoid);
  }

  begin(input: BeginExecutionInput): ExecutionLedgerEntry {
    const startedAtMs = input.startedAtMs ?? Date.now();
    const activeWorkKind =
      input.activeWorkKind ?? activeWorkKindForExecutionKind(input.executionKind);
    const entry: ExecutionLedgerEntry = {
      executionId: input.executionId,
      executionKind: input.executionKind,
      activeWorkKind,
      threadId: input.threadId,
      projectId: input.projectId ?? null,
      parentRunId: input.parentRunId ?? null,
      summary: input.summary.slice(0, 240),
      status: "running",
      provider: input.provider ?? null,
      model: input.model ?? null,
      errorMessage: null,
      startedAtMs,
      updatedAtMs: startedAtMs,
      finishedAtMs: null,
    };
    this.runs.set(entry.executionId, entry);
    this.trimInMemory();
    activeWorkRegistry.register({
      kind: activeWorkKind,
      executionKind: entry.executionKind,
      id: entry.executionId,
      threadId: entry.threadId,
      summary: entry.summary,
      startedAtMs: entry.startedAtMs,
    });
    const sql = this.sqlClient;
    if (sql) {
      this.schedulePersist(this.upsertSql(sql, entry));
    }
    return entry;
  }

  finish(input: FinishExecutionInput): ExecutionLedgerEntry | null {
    const finishedAtMs = input.finishedAtMs ?? Date.now();
    const existing = this.runs.get(input.executionId);
    const activeWorkKind =
      input.activeWorkKind ??
      existing?.activeWorkKind ??
      (input.executionKind ? activeWorkKindForExecutionKind(input.executionKind) : undefined);

    if (activeWorkKind) {
      activeWorkRegistry.unregister(activeWorkKind, input.executionId);
    } else {
      activeWorkRegistry.unregister("delegation", input.executionId);
      activeWorkRegistry.unregister("collaboration", input.executionId);
    }

    const errorMessage = input.errorMessage ? input.errorMessage.slice(0, 1_000) : null;
    let updated: ExecutionLedgerEntry | null = null;
    if (existing) {
      if (existing.status === "running") {
        updated = {
          ...existing,
          status: input.status,
          errorMessage: errorMessage ?? existing.errorMessage,
          updatedAtMs: finishedAtMs,
          finishedAtMs,
        };
        this.runs.set(input.executionId, updated);
      } else {
        updated = existing;
      }
    }

    const sql = this.sqlClient;
    if (sql) {
      this.schedulePersist(
        this.settleSql(sql, {
          executionId: input.executionId,
          status: input.status,
          errorMessage,
          finishedAtMs,
        }),
      );
    }
    return updated;
  }

  beginEffect(input: BeginExecutionInput): Effect.Effect<ExecutionLedgerEntry> {
    const self = this;
    return Effect.gen(function* () {
      yield* annotateExecutionSpan(input);
      const entry = self.begin(input);
      const sql = self.sqlClient;
      if (sql) {
        yield* self.upsertSql(sql, entry).pipe(Effect.catch(() => Effect.void));
      }
      return entry;
    });
  }

  finishEffect(input: FinishExecutionInput): Effect.Effect<ExecutionLedgerEntry | null> {
    const self = this;
    return Effect.gen(function* () {
      const entry = self.finish(input);
      const sql = self.sqlClient;
      if (sql) {
        yield* self
          .settleSql(sql, {
            executionId: input.executionId,
            status: input.status,
            errorMessage: input.errorMessage ? input.errorMessage.slice(0, 1_000) : null,
            finishedAtMs: input.finishedAtMs ?? Date.now(),
          })
          .pipe(Effect.catch(() => Effect.void));
      }
      return entry;
    });
  }

  flushPendingWrites(): Effect.Effect<void> {
    return Effect.promise(async () => {
      while (this.pendingWrites.size > 0) {
        await Promise.allSettled([...this.pendingWrites]);
      }
    });
  }

  /**
   * Marks every stale `running` row across all 9 collaboration kinds as `interrupted_by_restart`.
   * Called once on server boot as soon as SQLite migrations have completed.
   */
  closeStaleRuns(nowMs = Date.now()): Effect.Effect<number, unknown> {
    const self = this;
    return Effect.gen(function* () {
      let inMemoryClosed = 0;
      for (const [id, entry] of self.runs) {
        if (entry.status === "running") {
          activeWorkRegistry.unregister(entry.activeWorkKind, id);
          self.runs.set(id, {
            ...entry,
            status: "interrupted_by_restart",
            errorMessage: entry.errorMessage ?? RESTART_INTERRUPTED_DEFAULT_MESSAGE,
            updatedAtMs: nowMs,
            finishedAtMs: nowMs,
          });
          inMemoryClosed += 1;
        }
      }

      const sql = self.sqlClient;
      if (!sql) return inMemoryClosed;

      const [countRow] = yield* sql<{ cnt: number }>`
        SELECT COUNT(*) AS cnt FROM unified_execution_runs WHERE status = 'running'`;
      const dbCount = Number(countRow?.cnt ?? 0);
      if (dbCount > 0) {
        yield* sql`UPDATE unified_execution_runs
          SET status = 'interrupted_by_restart',
              error_message = COALESCE(error_message, ${RESTART_INTERRUPTED_DEFAULT_MESSAGE}),
              updated_at_ms = ${nowMs},
              finished_at_ms = ${nowMs}
          WHERE status = 'running'`;
      }
      return Math.max(dbCount, inMemoryClosed);
    });
  }

  listRuns(options?: {
    readonly threadId?: string | undefined;
    readonly executionKind?: ExecutionKind | undefined;
    readonly status?: ExecutionRunStatus | undefined;
    readonly limit?: number | undefined;
  }): Effect.Effect<ReadonlyArray<ExecutionLedgerEntry>, unknown> {
    const self = this;
    const limit = Math.max(1, Math.min(options?.limit ?? 100, 500));
    return Effect.gen(function* () {
      const sql = self.sqlClient;
      if (sql) {
        yield* self.flushPendingWrites();
        const rows = options?.threadId
          ? yield* sql<UnifiedExecutionRow>`
              SELECT * FROM unified_execution_runs
              WHERE thread_id = ${options.threadId}
              ORDER BY started_at_ms DESC
              LIMIT ${limit}`
          : yield* sql<UnifiedExecutionRow>`
              SELECT * FROM unified_execution_runs
              ORDER BY started_at_ms DESC
              LIMIT ${limit}`;
        return rows
          .map(rowToEntry)
          .filter(
            (entry) =>
              (!options?.executionKind || entry.executionKind === options.executionKind) &&
              (!options?.status || entry.status === options.status),
          );
      }
      return [...self.runs.values()]
        .filter(
          (entry) =>
            (!options?.threadId || entry.threadId === options.threadId) &&
            (!options?.executionKind || entry.executionKind === options.executionKind) &&
            (!options?.status || entry.status === options.status),
        )
        .sort((a, b) => b.startedAtMs - a.startedAtMs)
        .slice(0, limit);
    });
  }

  querySummary(options?: {
    readonly threadId?: string | undefined;
    readonly limit?: number | undefined;
  }): Effect.Effect<ExecutionLedgerSummary, unknown> {
    const self = this;
    const limit = Math.max(1, Math.min(options?.limit ?? 50, 200));
    return Effect.gen(function* () {
      const sql = self.sqlClient;
      if (sql) {
        yield* self.flushPendingWrites();
        const rows = options?.threadId
          ? yield* sql<UnifiedExecutionRow>`
              SELECT * FROM unified_execution_runs
              WHERE thread_id = ${options.threadId}
              ORDER BY started_at_ms DESC`
          : yield* sql<UnifiedExecutionRow>`
              SELECT * FROM unified_execution_runs
              ORDER BY started_at_ms DESC`;
        return summarizeEntries(rows.map(rowToEntry), limit);
      }
      const entries = [...self.runs.values()].filter(
        (entry) => !options?.threadId || entry.threadId === options.threadId,
      );
      return summarizeEntries(entries, limit);
    });
  }

  /** Test-only reset helper. */
  resetForTests(): void {
    for (const [id, entry] of this.runs) {
      if (entry.status === "running") {
        activeWorkRegistry.unregister(entry.activeWorkKind, id);
      }
    }
    this.runs.clear();
  }
}

export const unifiedExecutionLedger = new UnifiedExecutionLedgerImpl();

/**
 * Bootstraps SQLite persistence for the Unified Execution Ledger and marks
 * any leftover `running` rows from a crashed/restarted server as `interrupted_by_restart`.
 */
export const UnifiedExecutionLedgerLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    unifiedExecutionLedger.attachSqlClient(sql);
    const closed = yield* unifiedExecutionLedger.closeStaleRuns().pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Failed to close stale unified execution runs on startup", {
          cause,
        }).pipe(Effect.as(0)),
      ),
    );
    if (closed > 0) {
      yield* Effect.logInfo("Marked stale unified execution runs as interrupted_by_restart", {
        closed,
      });
    }
    yield* Effect.addFinalizer(() =>
      unifiedExecutionLedger
        .flushPendingWrites()
        .pipe(
          Effect.andThen(Effect.sync(() => unifiedExecutionLedger.detachSqlClient())),
          Effect.ignore,
        ),
    );
  }),
);
