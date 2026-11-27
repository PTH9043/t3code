import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Host Control-Plane Security & Zero Self-Approval Persistence:
 * 1) `host_approvals`: digest-bound HITL approval state machine (prevents post-approval
 *    tampering, self-approval, and automatic retries after `outcome_unknown`)
 * 2) `host_audit_chain`: hash-chained append-only audit ledger (`prev_hash` -> `entry_hash`)
 * 3) `pinned_task_specs` & `pinned_spec_verdicts`: hash-pinned spec.json contracts and
 *    independent checker verdicts (Zero Self-Approval completion gate)
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`CREATE TABLE IF NOT EXISTS host_approvals (
    approval_id        TEXT PRIMARY KEY,
    thread_id          TEXT,
    requester_actor_id TEXT NOT NULL,
    requester_role     TEXT NOT NULL CHECK (requester_role IN ('agent', 'workflow', 'routine')),
    target_json        TEXT NOT NULL,
    target_digest      TEXT NOT NULL,
    status             TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'invalidated', 'executed', 'outcome_unknown')),
    decided_by         TEXT,
    decided_role       TEXT CHECK (decided_role IS NULL OR decided_role IN ('human', 'agent', 'system')),
    reason             TEXT,
    created_at         TEXT NOT NULL,
    updated_at         TEXT NOT NULL
  )`;

  yield* sql`CREATE INDEX IF NOT EXISTS idx_host_approvals_status
    ON host_approvals(status, updated_at DESC)`;

  yield* sql`CREATE TABLE IF NOT EXISTS host_audit_chain (
    seq          INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_id     TEXT NOT NULL UNIQUE,
    kind         TEXT NOT NULL,
    actor_id     TEXT NOT NULL,
    actor_kind   TEXT NOT NULL CHECK (actor_kind IN ('human', 'agent', 'host')),
    resource     TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    prev_hash    TEXT NOT NULL,
    entry_hash   TEXT NOT NULL,
    created_at   TEXT NOT NULL
  )`;

  yield* sql`CREATE TABLE IF NOT EXISTS pinned_task_specs (
    spec_id             TEXT PRIMARY KEY,
    thread_id           TEXT,
    producer_actor_id   TEXT NOT NULL,
    producer_session_id TEXT,
    body_json           TEXT NOT NULL,
    spec_hash           TEXT NOT NULL,
    prerequisites_met   INTEGER NOT NULL DEFAULT 0,
    executed_run_id     TEXT,
    waived              INTEGER NOT NULL DEFAULT 0,
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL
  )`;

  yield* sql`CREATE TABLE IF NOT EXISTS pinned_spec_verdicts (
    verdict_id         TEXT PRIMARY KEY,
    spec_id            TEXT NOT NULL,
    spec_hash          TEXT NOT NULL,
    checker_actor_id   TEXT NOT NULL,
    checker_session_id TEXT,
    decision           TEXT NOT NULL CHECK (decision IN ('approve', 'block', 'hold')),
    evidence           TEXT NOT NULL,
    checked_at         TEXT NOT NULL
  )`;

  yield* sql`CREATE INDEX IF NOT EXISTS idx_pinned_spec_verdicts_spec
    ON pinned_spec_verdicts(spec_id, checked_at DESC)`;
});
