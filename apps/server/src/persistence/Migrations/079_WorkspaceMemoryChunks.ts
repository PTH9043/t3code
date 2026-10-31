import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE VIRTUAL TABLE IF NOT EXISTS workspace_memory_v2_chunks USING fts5(
    memory_id UNINDEXED, project_id UNINDEXED, chunk_text UNINDEXED, content
  )`;
  yield* sql`CREATE TABLE IF NOT EXISTS workspace_memory_v2_chunk_state (
    memory_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, source_kind TEXT NOT NULL,
    source_id TEXT NOT NULL, source_version TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS workspace_memory_v2_chunk_source
    ON workspace_memory_v2_chunk_state(project_id, source_kind, source_id)`;
});
