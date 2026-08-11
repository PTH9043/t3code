import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Upgrade databases that applied migration 043 before scheduled runs existed. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tableRows = yield* sql<{ readonly sql: string | null }>`
    SELECT sql FROM sqlite_master
    WHERE type = 'table' AND name = 'projection_workspace_collaboration_runs'
  `;
  const definition = tableRows[0]?.sql ?? "";
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_workspace_collaboration_runs)
  `;
  const alreadySupportsSchedules =
    columns.some((column) => column.name === "schedule_id") && definition.includes("'schedule'");
  if (alreadySupportsSchedules) return;

  yield* sql`DROP INDEX IF EXISTS idx_projection_workspace_collaboration_runs_queue`;
  yield* sql`DROP INDEX IF EXISTS idx_projection_workspace_collaboration_runs_one_active`;
  yield* sql`
    ALTER TABLE projection_workspace_collaboration_runs
    RENAME TO projection_workspace_collaboration_runs_legacy
  `;
  yield* sql`
    CREATE TABLE projection_workspace_collaboration_runs (
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
    INSERT INTO projection_workspace_collaboration_runs (
      run_id, project_id, source, schedule_id, task, status, steps_json,
      final_output, error, created_at, updated_at
    )
    SELECT
      run_id, project_id, source, NULL, task, status, steps_json,
      final_output, error, created_at, updated_at
    FROM projection_workspace_collaboration_runs_legacy
  `;
  yield* sql`DROP TABLE projection_workspace_collaboration_runs_legacy`;
  yield* sql`
    CREATE INDEX idx_projection_workspace_collaboration_runs_queue
    ON projection_workspace_collaboration_runs(project_id, status, created_at ASC, run_id ASC)
  `;
  yield* sql`
    CREATE UNIQUE INDEX idx_projection_workspace_collaboration_runs_one_active
    ON projection_workspace_collaboration_runs(project_id)
    WHERE status IN ('running', 'cancel-requested')
  `;
});
