import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * The run-level orchestra settings (parallel width, worktree isolation). NULL
 * is a run recorded before the orchestra existed, or one that never opted in —
 * both decode to the pre-orchestra behaviour.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{
    readonly name: string;
  }>`PRAGMA table_info(projection_workspace_collaboration_runs)`;
  if (!columns.some((column) => column.name === "orchestra_json")) {
    yield* sql`ALTER TABLE projection_workspace_collaboration_runs ADD COLUMN orchestra_json TEXT`;
  }
});
