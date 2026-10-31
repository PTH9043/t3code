import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS workspace_memory_v2 (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, scope TEXT NOT NULL,
    topic TEXT NOT NULL, text TEXT NOT NULL, source_json TEXT NOT NULL,
    source_hash TEXT NOT NULL, origin TEXT NOT NULL, verification TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS workspace_memory_v2_scope ON workspace_memory_v2(project_id, status, topic, updated_at, id)`;
  yield* sql`CREATE VIRTUAL TABLE IF NOT EXISTS workspace_memory_v2_fts USING fts5(id UNINDEXED, project_id UNINDEXED, scope UNINDEXED, content)`;
  yield* sql`CREATE TABLE IF NOT EXISTS workspace_memory_v2_progress (
    stream_key TEXT PRIMARY KEY, position INTEGER NOT NULL, updated_at TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_projection_messages_thread_turn ON projection_thread_messages(thread_id, turn_id, created_at, message_id)`;
  yield* sql`CREATE TABLE IF NOT EXISTS workspace_memory_v2_pending (message_id TEXT PRIMARY KEY, project_id TEXT NOT NULL)`;
  yield* sql`CREATE TABLE IF NOT EXISTS workspace_memory_v2_dirty (project_id TEXT NOT NULL, scope TEXT NOT NULL, topic TEXT NOT NULL, PRIMARY KEY(project_id,scope,topic))`;
  yield* sql`CREATE TABLE IF NOT EXISTS workspace_memory_source_archives (
    sha256 TEXT PRIMARY KEY, project_id TEXT NOT NULL, thread_id TEXT NOT NULL, path TEXT NOT NULL,
    records INTEGER NOT NULL, original_bytes INTEGER NOT NULL, compressed_bytes INTEGER NOT NULL,
    created_at TEXT NOT NULL
  )`;
});
