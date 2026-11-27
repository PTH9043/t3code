import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Unified Execution Ledger (`unified_execution_runs`):
 * Shared persistence & restart-recovery table spanning all 9 multi-agent / collaboration paths:
 * orchestra, meeting, workflow_v2, workspace_delegate, council,
 * workspace_helper, upgrade_room, claude_subagent, codex_subagent.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`CREATE TABLE IF NOT EXISTS unified_execution_runs (
    execution_id     TEXT PRIMARY KEY,
    execution_kind   TEXT NOT NULL CHECK (execution_kind IN (
      'orchestra',
      'meeting',
      'workflow_v2',
      'workspace_delegate',
      'council',
      'workspace_helper',
      'upgrade_room',
      'claude_subagent',
      'codex_subagent'
    )),
    active_work_kind TEXT NOT NULL CHECK (active_work_kind IN ('delegation', 'collaboration')),
    thread_id        TEXT NOT NULL,
    project_id       TEXT,
    parent_run_id    TEXT,
    summary          TEXT NOT NULL,
    status           TEXT NOT NULL CHECK (status IN (
      'running',
      'completed',
      'failed',
      'cancelled',
      'interrupted_by_restart'
    )),
    provider         TEXT,
    model            TEXT,
    error_message    TEXT,
    started_at_ms    INTEGER NOT NULL,
    updated_at_ms    INTEGER NOT NULL,
    finished_at_ms   INTEGER
  )`;

  yield* sql`CREATE INDEX IF NOT EXISTS idx_unified_execution_runs_status
    ON unified_execution_runs(status, updated_at_ms DESC)`;

  yield* sql`CREATE INDEX IF NOT EXISTS idx_unified_execution_runs_thread
    ON unified_execution_runs(thread_id, started_at_ms DESC)`;

  yield* sql`CREATE INDEX IF NOT EXISTS idx_unified_execution_runs_kind_started
    ON unified_execution_runs(execution_kind, started_at_ms DESC)`;
});
