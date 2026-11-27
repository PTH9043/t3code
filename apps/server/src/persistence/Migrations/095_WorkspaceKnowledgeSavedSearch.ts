import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE workspace_knowledge_saved_searches (
    project_id TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL,
    filters_json TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (project_id, id)
  )`;
});
