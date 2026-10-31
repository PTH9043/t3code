import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_recovery_activity_kind
    ON projection_thread_activities(thread_id, kind)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_recovery_completed_tool
    ON projection_thread_activities(thread_id, json_extract(payload_json, '$.data.toolName'))
    WHERE kind = 'tool.completed'
  `;
});
