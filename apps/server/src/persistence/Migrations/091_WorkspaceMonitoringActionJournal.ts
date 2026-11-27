import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS workspace_monitoring_action_journal (
    project_id TEXT NOT NULL,
    occurrence_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending', 'publishing', 'completed')),
    fired_at REAL,
    CHECK ((state = 'completed' AND fired_at IS NOT NULL)
      OR (state IN ('pending', 'publishing') AND fired_at IS NULL)),
    PRIMARY KEY (project_id, occurrence_id)
  )`;
});
