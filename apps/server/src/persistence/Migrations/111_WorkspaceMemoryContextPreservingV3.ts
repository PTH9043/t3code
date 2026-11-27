import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Migration 111 — Context-Preserving Memory v3:
 * Separates immutable episodic `fact` rows from consolidated `observation` rows,
 * preserves decision `rationale` + `proof_fact_ids` lineage, and stores
 * deterministic `context_prefix` + extracted `entities_json` for 4-arm RRF recall.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const existingCols = new Set(
    (yield* sql<{ name: string }>`PRAGMA table_info(workspace_memory_v2)`).map((col) => col.name),
  );

  if (!existingCols.has("memory_layer")) {
    yield* sql`ALTER TABLE workspace_memory_v2 ADD COLUMN memory_layer TEXT NOT NULL DEFAULT 'fact' CHECK (memory_layer IN ('fact', 'observation'))`;
  }
  if (!existingCols.has("context_prefix")) {
    yield* sql`ALTER TABLE workspace_memory_v2 ADD COLUMN context_prefix TEXT`;
  }
  if (!existingCols.has("rationale")) {
    yield* sql`ALTER TABLE workspace_memory_v2 ADD COLUMN rationale TEXT`;
  }
  if (!existingCols.has("entities_json")) {
    yield* sql`ALTER TABLE workspace_memory_v2 ADD COLUMN entities_json TEXT NOT NULL DEFAULT '[]'`;
  }
  if (!existingCols.has("proof_fact_ids")) {
    yield* sql`ALTER TABLE workspace_memory_v2 ADD COLUMN proof_fact_ids TEXT NOT NULL DEFAULT '[]'`;
  }

  yield* sql`CREATE INDEX IF NOT EXISTS idx_memory_v2_layer_valid
    ON workspace_memory_v2 (project_id, memory_layer, valid_from DESC)
    WHERE expired_at IS NULL AND status NOT IN ('forgotten', 'archived')`;
});
