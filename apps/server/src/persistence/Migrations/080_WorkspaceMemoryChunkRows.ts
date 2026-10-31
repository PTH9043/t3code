import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS workspace_memory_v2_chunk_rows (
    chunk_rowid INTEGER PRIMARY KEY, memory_id TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS workspace_memory_v2_chunk_rows_by_memory
    ON workspace_memory_v2_chunk_rows(memory_id)`;
  yield* sql`INSERT OR IGNORE INTO workspace_memory_v2_chunk_rows(chunk_rowid,memory_id)
    SELECT rowid,memory_id FROM workspace_memory_v2_chunks`;
});
