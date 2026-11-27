import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const existingCols = new Set(
    (yield* sql<{ name: string }>`PRAGMA table_info(workspace_memory_v2)`).map((col) => col.name),
  );

  if (!existingCols.has("memory_tier")) {
    yield* sql`ALTER TABLE workspace_memory_v2 ADD COLUMN memory_tier TEXT NOT NULL DEFAULT 'warm' CHECK (memory_tier IN ('hot', 'warm', 'cold'))`;
  }
  if (!existingCols.has("cognitive_type")) {
    yield* sql`ALTER TABLE workspace_memory_v2 ADD COLUMN cognitive_type TEXT NOT NULL DEFAULT 'episodic' CHECK (cognitive_type IN ('directive', 'semantic', 'episodic', 'procedural'))`;
  }
  if (!existingCols.has("access_count")) {
    yield* sql`ALTER TABLE workspace_memory_v2 ADD COLUMN access_count INTEGER NOT NULL DEFAULT 0`;
  }
  if (!existingCols.has("last_accessed_at")) {
    yield* sql`ALTER TABLE workspace_memory_v2 ADD COLUMN last_accessed_at INTEGER`;
  }
  if (!existingCols.has("stability_days")) {
    yield* sql`ALTER TABLE workspace_memory_v2 ADD COLUMN stability_days REAL NOT NULL DEFAULT 30.0`;
  }
  if (!existingCols.has("heat_score")) {
    yield* sql`ALTER TABLE workspace_memory_v2 ADD COLUMN heat_score REAL NOT NULL DEFAULT 1.0`;
  }
  if (!existingCols.has("entity_key")) {
    yield* sql`ALTER TABLE workspace_memory_v2 ADD COLUMN entity_key TEXT`;
  }
  if (!existingCols.has("predicate_slot")) {
    yield* sql`ALTER TABLE workspace_memory_v2 ADD COLUMN predicate_slot TEXT`;
  }
  if (!existingCols.has("valid_from")) {
    yield* sql`ALTER TABLE workspace_memory_v2 ADD COLUMN valid_from INTEGER NOT NULL DEFAULT 0`;
  }
  if (!existingCols.has("valid_to")) {
    yield* sql`ALTER TABLE workspace_memory_v2 ADD COLUMN valid_to INTEGER`;
  }
  if (!existingCols.has("expired_at")) {
    yield* sql`ALTER TABLE workspace_memory_v2 ADD COLUMN expired_at INTEGER`;
  }
  if (!existingCols.has("superseded_by_id")) {
    yield* sql`ALTER TABLE workspace_memory_v2 ADD COLUMN superseded_by_id TEXT`;
  }
  if (!existingCols.has("supersedes_ids")) {
    yield* sql`ALTER TABLE workspace_memory_v2 ADD COLUMN supersedes_ids TEXT NOT NULL DEFAULT '[]'`;
  }

  yield* sql`CREATE INDEX IF NOT EXISTS idx_memory_v2_tier_heat
    ON workspace_memory_v2 (project_id, memory_tier, valid_to, heat_score DESC)`;

  yield* sql`CREATE INDEX IF NOT EXISTS idx_memory_v2_entity_slot_active
    ON workspace_memory_v2 (project_id, entity_key, predicate_slot)
    WHERE valid_to IS NULL AND expired_at IS NULL`;

  yield* sql`CREATE INDEX IF NOT EXISTS idx_memory_v2_cognitive_type
    ON workspace_memory_v2 (project_id, cognitive_type, memory_tier)`;

  yield* sql`CREATE TABLE IF NOT EXISTS workspace_shared_blackboard (
    workspace_id TEXT NOT NULL,
    key TEXT NOT NULL,
    owner_agent_id TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    category TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    lease_expires_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, key)
  )`;

  yield* sql`CREATE INDEX IF NOT EXISTS idx_blackboard_lease
    ON workspace_shared_blackboard (workspace_id, lease_expires_at)`;
});
