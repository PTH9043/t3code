import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS workspace_monitoring_journal (
    project_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    occurrence_id TEXT NOT NULL,
    metric_index INTEGER NOT NULL CHECK (metric_index >= 0),
    finding_json TEXT NOT NULL,
    PRIMARY KEY (project_id, occurrence_id)
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS workspace_monitoring_journal_fingerprint
    ON workspace_monitoring_journal(project_id, fingerprint)`;
  yield* sql`CREATE TABLE IF NOT EXISTS workspace_monitoring_cooldowns (
    project_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    fired_at REAL NOT NULL,
    PRIMARY KEY (project_id, fingerprint)
  )`;
});
