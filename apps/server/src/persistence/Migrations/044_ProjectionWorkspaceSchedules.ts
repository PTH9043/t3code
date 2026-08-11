import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_workspace_schedules (
      schedule_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      task TEXT NOT NULL,
      enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
      timing_json TEXT NOT NULL,
      next_trigger_at TEXT,
      last_triggered_at TEXT,
      last_run_id TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projection_projects(project_id)
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_workspace_schedules_project
    ON projection_workspace_schedules(project_id, title ASC, schedule_id ASC)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_workspace_schedules_due
    ON projection_workspace_schedules(enabled, next_trigger_at ASC, schedule_id ASC)
  `;
});
