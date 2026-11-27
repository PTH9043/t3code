import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Durable thread-scoped ledger for `workspace_delegate` subordinate runs:
 * - Persists delegation metadata, mandate boundary, activity timestamps, and outcomes across turns & restarts.
 * - Supports deduplication by (thread_id, target_instance_id, target_model, task_hash).
 * - Enables clean `interrupted_by_restart` attribution and push delivery deduplication (`delivered_at`).
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`CREATE TABLE IF NOT EXISTS workspace_delegations (
    delegation_id          TEXT PRIMARY KEY,
    thread_id              TEXT NOT NULL,
    owner_turn_id          TEXT NOT NULL,
    answering_instance_id  TEXT NOT NULL,
    role                   TEXT NOT NULL,
    target_instance_id     TEXT NOT NULL,
    target_model           TEXT NOT NULL,
    task_text              TEXT NOT NULL,
    task_hash              TEXT NOT NULL,
    status                 TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'cancelled', 'stalled', 'interrupted_by_restart')),
    result_text            TEXT,
    error_message          TEXT,
    mandate_json           TEXT,
    last_activity_at       TEXT NOT NULL,
    last_tool_summary      TEXT,
    started_at             TEXT NOT NULL,
    finished_at            TEXT,
    delivered_at           TEXT
  )`;

  yield* sql`CREATE INDEX IF NOT EXISTS idx_workspace_delegations_thread_status
    ON workspace_delegations(thread_id, status, started_at DESC)`;

  yield* sql`CREATE INDEX IF NOT EXISTS idx_workspace_delegations_dedup
    ON workspace_delegations(thread_id, target_instance_id, target_model, task_hash, status)`;
});
