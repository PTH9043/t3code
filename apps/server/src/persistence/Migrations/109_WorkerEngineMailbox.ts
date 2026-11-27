import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * T3 Worker Engine persistent tables (Orca-inspired durable mailbox, task/dispatch
 * fencing, heartbeat tracking, worktree review lifecycle, and decision gates).
 *
 * 5 tables:
 *   1. worker_tasks
 *   2. worker_dispatches
 *   3. worker_mailbox_messages
 *   4. worker_mailbox_deliveries
 *   5. worker_decision_gates
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`CREATE TABLE IF NOT EXISTS worker_tasks (
    task_id           TEXT PRIMARY KEY,
    run_id            TEXT NOT NULL,
    thread_id         TEXT NOT NULL,
    owner_turn_id     TEXT,
    caller_kind       TEXT NOT NULL CHECK (caller_kind IN (
      't3_supervisor', 'personal_ai', 'council', 'orchestra', 'cli'
    )),
    dedup_key         TEXT NOT NULL,
    idempotency_key   TEXT UNIQUE,
    role              TEXT NOT NULL,
    target_instance_id TEXT NOT NULL,
    target_model      TEXT,
    spec_text         TEXT NOT NULL,
    rag_facts_json    TEXT,
    status            TEXT NOT NULL CHECK (status IN (
      'pending', 'ready', 'dispatched', 'blocked', 'completed', 'failed', 'cancelled'
    )),
    active_dispatch_id TEXT,
    fencing_epoch     INTEGER NOT NULL DEFAULT 0,
    failure_count     INTEGER NOT NULL DEFAULT 0,
    worktree_mode     TEXT NOT NULL DEFAULT 'current' CHECK (worktree_mode IN ('isolated', 'current')),
    worktree_path     TEXT,
    worktree_branch   TEXT,
    worktree_base_ref TEXT,
    worktree_state    TEXT NOT NULL DEFAULT 'none' CHECK (worktree_state IN (
      'none', 'active', 'review_ready', 'merged', 'discarded'
    )),
    cwd               TEXT NOT NULL,
    outcome_json      TEXT,
    created_at_ms     INTEGER NOT NULL,
    updated_at_ms     INTEGER NOT NULL,
    finished_at_ms    INTEGER
  )`;

  yield* sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_worker_tasks_dedup_active
    ON worker_tasks(thread_id, dedup_key)
    WHERE status IN ('pending', 'ready', 'dispatched', 'blocked')`;

  yield* sql`CREATE INDEX IF NOT EXISTS idx_worker_tasks_run_status
    ON worker_tasks(run_id, status, updated_at_ms DESC)`;

  yield* sql`CREATE INDEX IF NOT EXISTS idx_worker_tasks_thread_updated
    ON worker_tasks(thread_id, updated_at_ms DESC)`;

  yield* sql`CREATE TABLE IF NOT EXISTS worker_dispatches (
    dispatch_id          TEXT PRIMARY KEY,
    task_id              TEXT NOT NULL REFERENCES worker_tasks(task_id) ON DELETE CASCADE,
    run_id               TEXT NOT NULL,
    thread_id            TEXT NOT NULL,
    attempt              INTEGER NOT NULL DEFAULT 1,
    fencing_token        INTEGER NOT NULL,
    retry_of_dispatch_id TEXT,
    execution_id         TEXT,
    provider_instance_id TEXT NOT NULL,
    model                TEXT,
    role                 TEXT NOT NULL,
    status               TEXT NOT NULL CHECK (status IN (
      'starting', 'running', 'stalled', 'completed', 'failed',
      'cancelled', 'interrupted_by_restart', 'abandoned'
    )),
    last_heartbeat_at_ms INTEGER NOT NULL,
    heartbeat_timeout_ms INTEGER NOT NULL DEFAULT 300000,
    last_tool_summary    TEXT,
    result_text          TEXT,
    error_message        TEXT,
    started_at_ms        INTEGER NOT NULL,
    finished_at_ms       INTEGER
  )`;

  yield* sql`CREATE INDEX IF NOT EXISTS idx_worker_dispatches_task
    ON worker_dispatches(task_id, attempt DESC)`;

  yield* sql`CREATE INDEX IF NOT EXISTS idx_worker_dispatches_active
    ON worker_dispatches(status, last_heartbeat_at_ms)`;

  yield* sql`CREATE INDEX IF NOT EXISTS idx_worker_dispatches_thread_status
    ON worker_dispatches(thread_id, status)`;

  yield* sql`CREATE TABLE IF NOT EXISTS worker_mailbox_messages (
    sequence           INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id         TEXT NOT NULL UNIQUE,
    run_id             TEXT NOT NULL,
    thread_id          TEXT NOT NULL,
    task_id            TEXT,
    dispatch_id        TEXT,
    fencing_token      INTEGER,
    from_actor         TEXT NOT NULL,
    to_actor           TEXT NOT NULL,
    type               TEXT NOT NULL CHECK (type IN (
      'dispatch', 'worker_done', 'question', 'answer',
      'escalation', 'decision_gate', 'heartbeat', 'merge_ready', 'status'
    )),
    outcome            TEXT CHECK (outcome IS NULL OR outcome IN ('succeeded', 'failed', 'blocked')),
    subject            TEXT NOT NULL,
    body               TEXT NOT NULL DEFAULT '',
    payload_json       TEXT,
    delivery_id        TEXT,
    created_at_ms      INTEGER NOT NULL,
    delivered_at_ms    INTEGER,
    acknowledged_at_ms INTEGER
  )`;

  yield* sql`CREATE INDEX IF NOT EXISTS idx_worker_mailbox_unread
    ON worker_mailbox_messages(to_actor, acknowledged_at_ms, sequence)`;

  yield* sql`CREATE INDEX IF NOT EXISTS idx_worker_mailbox_run_unread
    ON worker_mailbox_messages(run_id, acknowledged_at_ms, sequence)`;

  yield* sql`CREATE INDEX IF NOT EXISTS idx_worker_mailbox_thread_unread
    ON worker_mailbox_messages(thread_id, acknowledged_at_ms, sequence)`;

  yield* sql`CREATE INDEX IF NOT EXISTS idx_worker_mailbox_delivery
    ON worker_mailbox_messages(delivery_id)`;

  yield* sql`CREATE TABLE IF NOT EXISTS worker_mailbox_deliveries (
    delivery_id         TEXT PRIMARY KEY,
    run_id              TEXT NOT NULL,
    mailbox_handle      TEXT NOT NULL,
    consumer_generation INTEGER NOT NULL DEFAULT 0,
    message_ids_json    TEXT NOT NULL,
    status              TEXT NOT NULL DEFAULT 'outstanding' CHECK (status IN (
      'outstanding', 'acknowledged', 'fenced'
    )),
    created_at_ms       INTEGER NOT NULL,
    acknowledged_at_ms  INTEGER
  )`;

  yield* sql`CREATE INDEX IF NOT EXISTS idx_worker_deliveries_outstanding
    ON worker_mailbox_deliveries(mailbox_handle, status, created_at_ms)`;

  yield* sql`CREATE TABLE IF NOT EXISTS worker_decision_gates (
    gate_id        TEXT PRIMARY KEY,
    task_id        TEXT NOT NULL REFERENCES worker_tasks(task_id) ON DELETE CASCADE,
    dispatch_id    TEXT,
    thread_id      TEXT NOT NULL,
    risk_level     TEXT NOT NULL CHECK (risk_level IN ('medium', 'high', 'critical')),
    question       TEXT NOT NULL,
    options_json   TEXT NOT NULL DEFAULT '[]',
    status         TEXT NOT NULL DEFAULT 'open' CHECK (status IN (
      'open', 'approved', 'denied', 'expired'
    )),
    resolution     TEXT,
    resolved_by    TEXT,
    created_at_ms  INTEGER NOT NULL,
    resolved_at_ms INTEGER
  )`;

  yield* sql`CREATE INDEX IF NOT EXISTS idx_worker_gates_task_status
    ON worker_decision_gates(task_id, status)`;

  yield* sql`CREATE INDEX IF NOT EXISTS idx_worker_gates_thread_status
    ON worker_decision_gates(thread_id, status)`;
});
