import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_workspace_forgotten_message
    ON workspace_memory_v2(project_id,
      CASE WHEN json_valid(source_json) AND json_extract(source_json, '$.kind') = 'message'
        THEN json_extract(source_json, '$.id') END)
    WHERE status = 'forgotten'`;
});
