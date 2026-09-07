import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Persist the boundary once. Replays must never turn pre-instrumentation data into zero spend.
  yield* sql`CREATE TABLE IF NOT EXISTS token_usage_collection (
    id INTEGER PRIMARY KEY CHECK (id = 1), after_sequence INTEGER NOT NULL, started_at TEXT NOT NULL
  )`;
  yield* sql`INSERT OR IGNORE INTO token_usage_collection
    SELECT 1, COALESCE(MAX(sequence), 0), strftime('%Y-%m-%dT%H:%M:%fZ','now')
    FROM orchestration_events`;
  yield* sql`CREATE TABLE IF NOT EXISTS projection_token_usage_requests (
    request_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, work_id TEXT NOT NULL,
    requested_sequence INTEGER NOT NULL, requested_at TEXT NOT NULL, turn_id TEXT,
    model TEXT NOT NULL, instance_id TEXT NOT NULL, phase TEXT NOT NULL,
    attempt INTEGER NOT NULL, node_id TEXT, status TEXT NOT NULL, has_native_children INTEGER NOT NULL DEFAULT 0
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_usage_requests_thread
    ON projection_token_usage_requests(thread_id, requested_sequence DESC)`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_usage_requests_work ON projection_token_usage_requests(work_id)`;
  yield* sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_requests_turn
    ON projection_token_usage_requests(thread_id, turn_id) WHERE turn_id IS NOT NULL`;
  yield* sql`CREATE TABLE IF NOT EXISTS projection_token_usage_cursors (
    source_id TEXT PRIMARY KEY, counts_json TEXT NOT NULL, last_sequence INTEGER NOT NULL
  )`;
  yield* sql`CREATE TABLE IF NOT EXISTS projection_token_usage_samples (
    request_id TEXT NOT NULL, source_id TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL,
    counts_json TEXT NOT NULL, issues_json TEXT NOT NULL, PRIMARY KEY (request_id, source_id)
  )`;
  // Avoid an expensive full event-history replay just to skip it.
  yield* sql`INSERT OR IGNORE INTO projection_state (projector, last_applied_sequence, updated_at)
    SELECT 'projection.token-usage-v1', after_sequence, started_at FROM token_usage_collection`;
});
