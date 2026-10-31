import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE workspace_semantic_index_jobs (
    scope_key TEXT PRIMARY KEY, project_id TEXT NOT NULL, endpoint TEXT NOT NULL,
    model TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0,
    after_rowid INTEGER NOT NULL DEFAULT 0, through_rowid INTEGER,
    failures INTEGER NOT NULL DEFAULT 0, retry_at INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  )`;
  yield* sql`CREATE TABLE workspace_semantic_vector_refs (
    scope_key TEXT NOT NULL, source_rowid INTEGER NOT NULL,
    project_id TEXT NOT NULL, item_id TEXT NOT NULL, chunk_index TEXT NOT NULL,
    content_key TEXT NOT NULL, PRIMARY KEY(scope_key, source_rowid)
  )`;
  yield* sql`CREATE INDEX workspace_semantic_refs_content ON workspace_semantic_vector_refs(scope_key, content_key)`;
  yield* sql`CREATE INDEX workspace_semantic_refs_source ON workspace_semantic_vector_refs(project_id, item_id)`;
  yield* sql`CREATE TABLE workspace_semantic_scope_state (
    scope_key TEXT PRIMARY KEY, indexed_at INTEGER NOT NULL,
    cleanup_at INTEGER NOT NULL DEFAULT 0, reclaimed_bytes INTEGER NOT NULL DEFAULT 0
  )`;
});
