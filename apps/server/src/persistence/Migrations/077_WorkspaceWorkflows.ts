import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE projection_workspace_collaboration_runs ADD COLUMN workflow_json TEXT`;
  yield* sql`CREATE TABLE projection_workspace_workflow_versions (
    project_id TEXT NOT NULL, definition_id TEXT NOT NULL, revision INTEGER NOT NULL,
    definition_json TEXT NOT NULL, PRIMARY KEY(project_id,definition_id,revision)
  )`;
  yield* sql`CREATE TABLE projection_workspace_workflow_deliveries (
    execution_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, run_id TEXT NOT NULL, node_id TEXT NOT NULL,
    phase TEXT NOT NULL, stop_confirmed INTEGER NOT NULL, intent_sequence INTEGER NOT NULL, updated_at TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX projection_workspace_workflow_deliveries_node ON projection_workspace_workflow_deliveries(run_id,node_id)`;
});
