import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS workspace_development_state (
    project_id TEXT PRIMARY KEY, state_json TEXT NOT NULL
  )`;
  yield* sql`CREATE TABLE IF NOT EXISTS workspace_development_events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL, command_id TEXT NOT NULL,
    kind TEXT NOT NULL, source TEXT NOT NULL,
    payload_json TEXT NOT NULL, created_at TEXT NOT NULL,
    UNIQUE(project_id, command_id)
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS workspace_development_event_project
    ON workspace_development_events(project_id, sequence)`;
});
