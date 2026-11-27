import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS workspace_conversation_rag_sources (
    project_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    source_kind TEXT NOT NULL,
    source_id TEXT NOT NULL,
    PRIMARY KEY (project_id, item_id, source_kind, source_id)
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_conversation_rag_sources_thread
    ON workspace_conversation_rag_sources(project_id, thread_id)`;
});
