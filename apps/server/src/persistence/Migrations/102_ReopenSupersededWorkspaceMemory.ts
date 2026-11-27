import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * The slot supersession that shipped with 101 closed ordinary conversation memories because a
 * keyword appeared inside a longer token. Every closure recorded so far came from that code, so
 * all of them are reopened and the next dream judges them again with the corrected rules. The
 * previous values stay in workspace_memory_v2_supersede_backup_102. The migrator runs this
 * inside its transaction.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`CREATE TABLE IF NOT EXISTS workspace_memory_v2_supersede_backup_102 (
    id TEXT PRIMARY KEY,
    valid_to INTEGER,
    expired_at INTEGER,
    superseded_by_id TEXT,
    supersedes_ids TEXT NOT NULL,
    memory_tier TEXT NOT NULL,
    entity_key TEXT,
    predicate_slot TEXT
  )`;

  yield* sql`INSERT OR IGNORE INTO workspace_memory_v2_supersede_backup_102
      (id, valid_to, expired_at, superseded_by_id, supersedes_ids, memory_tier, entity_key, predicate_slot)
    SELECT id, valid_to, expired_at, superseded_by_id, supersedes_ids, memory_tier, entity_key, predicate_slot
    FROM workspace_memory_v2
    WHERE superseded_by_id IS NOT NULL OR expired_at IS NOT NULL OR valid_to IS NOT NULL
      OR supersedes_ids <> '[]'`;

  // A closed memory was forced to 'cold'; 'warm' is the neutral tier until dream recomputes it.
  yield* sql`UPDATE workspace_memory_v2
    SET memory_tier = CASE
          WHEN superseded_by_id IS NOT NULL OR expired_at IS NOT NULL OR valid_to IS NOT NULL
          THEN 'warm' ELSE memory_tier END,
        valid_to = NULL,
        expired_at = NULL,
        superseded_by_id = NULL,
        supersedes_ids = '[]'
    WHERE superseded_by_id IS NOT NULL OR expired_at IS NOT NULL OR valid_to IS NOT NULL
      OR supersedes_ids <> '[]'`;
});
