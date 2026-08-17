import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Persist the meeting snapshot — roster, mode, transcript and the question the
 * run is parked on — beside the task graph it produces.
 *
 * Left NULL on every existing row, which is the correct value rather than a
 * placeholder: those runs were assigned through the project's role bindings and
 * have no roster to reconstruct. The decoder reads NULL as "role-bound path",
 * so they keep executing exactly as before.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{
    readonly name: string;
  }>`SELECT name FROM pragma_table_info('projection_workspace_collaboration_runs')`;

  if (!new Set(columns.map((column) => column.name)).has("meeting_json")) {
    yield* sql`
      ALTER TABLE projection_workspace_collaboration_runs
      ADD COLUMN meeting_json TEXT
    `;
  }
});
