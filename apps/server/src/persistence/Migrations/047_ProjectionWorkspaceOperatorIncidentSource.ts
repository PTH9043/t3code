import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Keep Workspace role and collaboration projections aligned with their contracts. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`DROP INDEX IF EXISTS idx_projection_workspace_agent_roles_enabled`;
  yield* sql`
    ALTER TABLE projection_workspace_agent_roles
    RENAME TO projection_workspace_agent_roles_pre_047
  `;
  yield* sql`
    CREATE TABLE projection_workspace_agent_roles (
      project_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK (
        role IN (
          'coordinator',
          'operator',
          'planner',
          'researcher',
          'implementer',
          'reviewer',
          'verifier'
        )
      ),
      display_name TEXT NOT NULL,
      model_selection_json TEXT NOT NULL,
      runtime_mode TEXT NOT NULL CHECK (
        runtime_mode IN ('approval-required', 'auto-accept-edits', 'auto', 'full-access')
      ),
      interaction_mode TEXT NOT NULL CHECK (interaction_mode IN ('default', 'plan')),
      instructions TEXT NOT NULL,
      enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
      updated_at TEXT NOT NULL,
      PRIMARY KEY (project_id, role),
      FOREIGN KEY (project_id) REFERENCES projection_projects(project_id)
    )
  `;
  yield* sql`
    INSERT INTO projection_workspace_agent_roles (
      project_id, role, display_name, model_selection_json, runtime_mode,
      interaction_mode, instructions, enabled, updated_at
    )
    SELECT
      project_id, role, display_name, model_selection_json, runtime_mode,
      interaction_mode, instructions, enabled, updated_at
    FROM projection_workspace_agent_roles_pre_047
  `;
  yield* sql`DROP TABLE projection_workspace_agent_roles_pre_047`;
  yield* sql`
    CREATE INDEX idx_projection_workspace_agent_roles_enabled
    ON projection_workspace_agent_roles(project_id, enabled, role)
  `;

  yield* sql`DROP INDEX IF EXISTS idx_projection_workspace_collaboration_runs_queue`;
  yield* sql`DROP INDEX IF EXISTS idx_projection_workspace_collaboration_runs_one_active`;
  yield* sql`
    ALTER TABLE projection_workspace_collaboration_runs
    RENAME TO projection_workspace_collaboration_runs_pre_047
  `;
  yield* sql`
    CREATE TABLE projection_workspace_collaboration_runs (
      run_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('user', 'schedule', 'incident')),
      schedule_id TEXT,
      incident_id TEXT,
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
      run_id, project_id, source, schedule_id, incident_id, task, status, steps_json,
      final_output, error, created_at, updated_at
    )
    SELECT
      run_id, project_id, source, schedule_id, NULL, task, status, steps_json,
      final_output, error, created_at, updated_at
    FROM projection_workspace_collaboration_runs_pre_047
  `;
  yield* sql`DROP TABLE projection_workspace_collaboration_runs_pre_047`;
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
