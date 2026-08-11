import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Persist the current task-graph snapshot while the event log retains every revision. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    ALTER TABLE projection_workspace_collaboration_runs
    ADD COLUMN graph_json TEXT
  `;
});
