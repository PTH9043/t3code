import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    ALTER TABLE projection_workspace_programs
    ADD COLUMN integrity_json TEXT NOT NULL
      DEFAULT '{"enabled":false,"validationCommands":[],"requiredCleanPasses":2,"status":"disabled","cycle":0,"consecutiveCleanPasses":0,"activeRunId":null,"lastRunId":null,"summary":null,"startedAt":null,"convergedAt":null,"updatedAt":null}'
    CHECK (json_valid(integrity_json))
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_workspace_programs_integrity
    ON projection_workspace_programs(
      json_extract(integrity_json, '$.enabled'),
      json_extract(integrity_json, '$.status'),
      project_id,
      program_id
    )
  `;
});
