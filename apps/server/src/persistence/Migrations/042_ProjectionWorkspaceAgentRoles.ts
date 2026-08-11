import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_workspace_agent_roles (
      project_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK (
        role IN ('coordinator', 'planner', 'researcher', 'implementer', 'reviewer', 'verifier')
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
    CREATE INDEX IF NOT EXISTS idx_projection_workspace_agent_roles_enabled
    ON projection_workspace_agent_roles(project_id, enabled, role)
  `;
});
