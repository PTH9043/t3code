import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Model-Agnostic Multi-Model Council, Shared Code Evidence Ledger & PinnedSpec Persistence:
 * 1) `council_sessions`: 7-stage deterministic FSM state & dynamic 1+N subordinate roster snapshot.
 * 2) `council_evidence_ledger`: Append-only disk SHA-256 + AST verified code evidence entries.
 * 3) `council_claims`: Claim-Evidence DAG nodes, anonymized handles, flip-blocked records & Subjective Logic scores.
 * 4) `council_pinned_specs`: Immutable consensus execution contract linked 1:1 with `pinned_task_specs` & `workspace_delegations`.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`CREATE TABLE IF NOT EXISTS council_sessions (
    council_id           TEXT PRIMARY KEY,
    thread_id            TEXT NOT NULL,
    project_id           TEXT NOT NULL,
    user_prompt          TEXT NOT NULL,
    chair_ref_json       TEXT NOT NULL,
    dynamic_roster_json  TEXT NOT NULL,
    state                TEXT NOT NULL CHECK (state IN (
      'IDLE', 'AUTO_SEATING', 'BLIND_ROUND_1', 'LEDGER_COMMIT_B1',
      'ANON_CRITIQUE_ROUND_2', 'LEDGER_COMMIT_B2', 'ARBITER_SYNTHESIS_B3',
      'AWAITING_OVERRIDE', 'PINNED_READY', 'DELEGATED_RUNNING',
      'VERIFYING', 'COMPLETED', 'ABORTED', 'INTERRUPTED_BY_RESTART'
    )),
    triage_score         REAL NOT NULL DEFAULT 0.0,
    flip_blocked_count   INTEGER NOT NULL DEFAULT 0,
    research_retry_count INTEGER NOT NULL DEFAULT 0,
    error_message        TEXT,
    created_at_ms        INTEGER NOT NULL,
    updated_at_ms        INTEGER NOT NULL
  )`;

  yield* sql`CREATE INDEX IF NOT EXISTS idx_council_sessions_thread_updated
    ON council_sessions(thread_id, updated_at_ms DESC)`;

  yield* sql`CREATE TABLE IF NOT EXISTS council_evidence_ledger (
    evidence_id          TEXT PRIMARY KEY,
    council_id           TEXT NOT NULL REFERENCES council_sessions(council_id) ON DELETE CASCADE,
    submitted_by_seat_id TEXT NOT NULL,
    round_num            INTEGER NOT NULL CHECK (round_num IN (1, 2, 3)),
    file_path            TEXT NOT NULL,
    start_line           INTEGER NOT NULL,
    end_line             INTEGER NOT NULL,
    ast_symbol           TEXT,
    resolved_symbol_line INTEGER,
    excerpt_sha256       TEXT NOT NULL,
    file_head_sha256     TEXT NOT NULL,
    verification_status  TEXT NOT NULL CHECK (verification_status IN (
      'VERIFIED_EXACT', 'VERIFIED_SHIFTED', 'REJECTED_FILE_MISSING',
      'REJECTED_HASH_MISMATCH', 'REJECTED_SYMBOL_NOT_FOUND'
    )),
    verified_at_ms       INTEGER NOT NULL
  )`;

  yield* sql`CREATE INDEX IF NOT EXISTS idx_council_evidence_council_round
    ON council_evidence_ledger(council_id, round_num, verification_status)`;

  yield* sql`CREATE TABLE IF NOT EXISTS council_claims (
    claim_id             TEXT PRIMARY KEY,
    council_id           TEXT NOT NULL REFERENCES council_sessions(council_id) ON DELETE CASCADE,
    author_seat_id       TEXT NOT NULL,
    anon_handle          TEXT NOT NULL,
    round_num            INTEGER NOT NULL CHECK (round_num IN (1, 2, 3)),
    claim_kind           TEXT NOT NULL CHECK (claim_kind IN (
      'ROOT_DIAGNOSIS', 'PATCH_PROPOSAL', 'CONTRARIAN_CHALLENGE', 'REBUTTAL_DEFENSE'
    )),
    severity             TEXT CHECK (severity IS NULL OR severity IN ('P0', 'P1', 'P2')),
    target_claim_id      TEXT,
    response_taxonomy    TEXT NOT NULL CHECK (response_taxonomy IN (
      'INITIAL', 'NEW_EVIDENCE_ADDED', 'SCOPE_NARROWED', 'CONFIDENCE_REDUCED', 'DEFERRED_ACCEPTED'
    )),
    stance_hash          TEXT NOT NULL,
    statement_ko         TEXT NOT NULL,
    proposed_diff_sketch TEXT,
    evidence_ids_json    TEXT NOT NULL,
    sl_belief            REAL NOT NULL DEFAULT 0.0,
    sl_disbelief         REAL NOT NULL DEFAULT 0.0,
    sl_uncertainty       REAL NOT NULL DEFAULT 1.0,
    sl_base_rate         REAL NOT NULL DEFAULT 0.5,
    status               TEXT NOT NULL CHECK (status IN (
      'ACTIVE', 'SUPERSEDED', 'REJECTED_NO_EVIDENCE', 'FLIP_BLOCKED', 'ACCEPTED'
    ))
  )`;

  yield* sql`CREATE INDEX IF NOT EXISTS idx_council_claims_council_round
    ON council_claims(council_id, round_num, status)`;

  yield* sql`CREATE TABLE IF NOT EXISTS council_pinned_specs (
    pinned_spec_id             TEXT PRIMARY KEY,
    council_id                 TEXT NOT NULL UNIQUE REFERENCES council_sessions(council_id) ON DELETE CASCADE,
    thread_id                  TEXT NOT NULL,
    project_id                 TEXT NOT NULL,
    title_ko                   TEXT NOT NULL,
    executive_summary_ko       TEXT NOT NULL,
    accepted_claim_ids_json    TEXT NOT NULL,
    verified_evidence_ids_json TEXT NOT NULL,
    target_files_lock_json     TEXT NOT NULL,
    acceptance_checks_json     TEXT NOT NULL,
    unresolved_p0_json         TEXT NOT NULL,
    unique_findings_json       TEXT NOT NULL,
    recommended_worker_json    TEXT NOT NULL,
    worker_candidates_json     TEXT NOT NULL,
    spec_hash_sha256           TEXT NOT NULL,
    delegated_task_id          TEXT,
    idempotency_key            TEXT UNIQUE,
    worktree_path              TEXT,
    worktree_branch            TEXT,
    spec_gate_outcome          TEXT,
    spec_proof_summary_json    TEXT,
    created_at_ms              INTEGER NOT NULL
  )`;

  yield* sql`CREATE INDEX IF NOT EXISTS idx_council_pinned_thread
    ON council_pinned_specs(thread_id, created_at_ms DESC)`;
});
