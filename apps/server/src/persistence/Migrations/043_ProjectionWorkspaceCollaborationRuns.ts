import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_workspace_collaboration_runs (
      run_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('user', 'schedule')),
      schedule_id TEXT,
      task TEXT NOT NULL,
      status TEXT NOT NULL CHECK (
        status IN ('queued', 'running', 'cancel-requested', 'cancelled', 'completed', 'failed')
      ),
      steps_json TEXT NOT NULL DEFAULT '[]',
      final_output TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projection_projects(project_id)
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_workspace_collaboration_runs_queue
    ON projection_workspace_collaboration_runs(project_id, status, created_at ASC, run_id ASC)
  `;
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_projection_workspace_collaboration_runs_one_active
    ON projection_workspace_collaboration_runs(project_id)
    WHERE status IN ('running', 'cancel-requested')
  `;
});
