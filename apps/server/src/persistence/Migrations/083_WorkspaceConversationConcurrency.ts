import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DROP INDEX IF EXISTS idx_projection_workspace_collaboration_runs_one_active`;
  yield* sql`CREATE UNIQUE INDEX idx_workspace_collaboration_legacy_one_active
    ON projection_workspace_collaboration_runs(project_id)
    WHERE status IN ('running','cancel-requested')
      AND (CASE WHEN json_valid(meeting_json) THEN json_extract(meeting_json,'$.threadId') END) IS NULL`;
  yield* sql`CREATE UNIQUE INDEX idx_workspace_collaboration_conversation_one_active
    ON projection_workspace_collaboration_runs(
      project_id,
      (CASE WHEN json_valid(meeting_json) THEN json_extract(meeting_json,'$.threadId') END)
    )
    WHERE status IN ('running','cancel-requested')
      AND (CASE WHEN json_valid(meeting_json) THEN json_extract(meeting_json,'$.threadId') END) IS NOT NULL`;
});
