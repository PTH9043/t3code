import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Migration 115: Allow `'limit_exceeded'` in `workspace_delegations.status` CHECK constraint.
 *
 * Migration 105 originally defined:
 *   CHECK (status IN ('running', 'completed', 'failed', 'cancelled', 'stalled', 'interrupted_by_restart'))
 * while `workspaceDelegate.ts` settles wall-time / idle / wait-round limit hits with
 * `status = 'limit_exceeded'`, causing SQLite CHECK constraint failures that left
 * timed-out delegations stuck in `running`.
 *
 * SQLite cannot ALTER a CHECK constraint in place, so we rebuild the table losslessly
 * inside a transaction with all existing rows and indexes preserved.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`CREATE TABLE IF NOT EXISTS workspace_delegations_v115 (
    delegation_id          TEXT PRIMARY KEY,
    thread_id              TEXT NOT NULL,
    owner_turn_id          TEXT NOT NULL,
    answering_instance_id  TEXT NOT NULL,
    role                   TEXT NOT NULL,
    target_instance_id     TEXT NOT NULL,
    target_model           TEXT NOT NULL,
    task_text              TEXT NOT NULL,
    task_hash              TEXT NOT NULL,
    status                 TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'cancelled', 'stalled', 'limit_exceeded', 'interrupted_by_restart')),
    result_text            TEXT,
    error_message          TEXT,
    mandate_json           TEXT,
    last_activity_at       TEXT NOT NULL,
    last_tool_summary      TEXT,
    started_at             TEXT NOT NULL,
    finished_at            TEXT,
    delivered_at           TEXT
  )`;

  yield* sql`INSERT OR REPLACE INTO workspace_delegations_v115 (
    delegation_id, thread_id, owner_turn_id, answering_instance_id, role,
    target_instance_id, target_model, task_text, task_hash, status,
    result_text, error_message, mandate_json, last_activity_at, last_tool_summary,
    started_at, finished_at, delivered_at
  )
  SELECT
    delegation_id, thread_id, owner_turn_id, answering_instance_id, role,
    target_instance_id, target_model, task_text, task_hash, status,
    result_text, error_message, mandate_json, last_activity_at, last_tool_summary,
    started_at, finished_at, delivered_at
  FROM workspace_delegations`;

  yield* sql`DROP TABLE workspace_delegations`;
  yield* sql`ALTER TABLE workspace_delegations_v115 RENAME TO workspace_delegations`;

  yield* sql`CREATE INDEX IF NOT EXISTS idx_workspace_delegations_thread_status
    ON workspace_delegations(thread_id, status, started_at DESC)`;

  yield* sql`CREATE INDEX IF NOT EXISTS idx_workspace_delegations_dedup
    ON workspace_delegations(thread_id, target_instance_id, target_model, task_hash, status)`;
});
