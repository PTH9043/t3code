import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS workspace_memory_v2_message_folders (
    message_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    folder TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS workspace_memory_v2_message_folders_thread
    ON workspace_memory_v2_message_folders(project_id,thread_id)`;
});
