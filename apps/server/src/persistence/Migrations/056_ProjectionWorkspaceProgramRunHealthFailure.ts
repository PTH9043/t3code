import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Why the latest health check of a program run failed (reason, detail, wall
 * time), so a diagnosis can tell a refused connection from a timeout — and a
 * timeout measured while the watching server itself was stalled from a real
 * one. Null while healthy or before the first failed check.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    ALTER TABLE projection_workspace_program_runs
    ADD COLUMN last_health_failure_json TEXT
  `;
});
