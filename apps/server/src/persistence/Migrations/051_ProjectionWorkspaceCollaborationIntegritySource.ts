import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Admit `integrity` as a collaboration run source.
 *
 * The program integrity loop used to request its runs as if a person had asked, which made
 * every cycle cancel the project's queued scheduled runs. Distinguishing the source fixes
 * that, but the column carries a CHECK constraint, and SQLite can only widen one by
 * rebuilding the table.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`DROP INDEX IF EXISTS idx_projection_workspace_collaboration_runs_queue`;
  yield* sql`DROP INDEX IF EXISTS idx_projection_workspace_collaboration_runs_one_active`;
  yield* sql`
    ALTER TABLE projection_workspace_collaboration_runs
    RENAME TO projection_workspace_collaboration_runs_pre_051
  `;
  yield* sql`
    CREATE TABLE projection_workspace_collaboration_runs (
      run_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('user', 'schedule', 'incident', 'integrity')),
      schedule_id TEXT,
      incident_id TEXT,
      task TEXT NOT NULL,
      status TEXT NOT NULL CHECK (
        status IN ('queued', 'running', 'cancel-requested', 'cancelled', 'completed', 'failed')
      ),
      steps_json TEXT NOT NULL DEFAULT '[]',
      graph_json TEXT,
      final_output TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projection_projects(project_id)
    )
  `;
  yield* sql`
    INSERT INTO projection_workspace_collaboration_runs (
      run_id, project_id, source, schedule_id, incident_id, task, status, steps_json,
      graph_json, final_output, error, created_at, updated_at
    )
    SELECT
      run_id, project_id, source, schedule_id, incident_id, task, status, steps_json,
      graph_json, final_output, error, created_at, updated_at
    FROM projection_workspace_collaboration_runs_pre_051
  `;
  yield* sql`DROP TABLE projection_workspace_collaboration_runs_pre_051`;
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
