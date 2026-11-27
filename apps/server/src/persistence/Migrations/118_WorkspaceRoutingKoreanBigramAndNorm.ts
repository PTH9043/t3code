import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Migration 118: Korean Bigram Auxiliary FTS5 Index & Incremental Reindex Cursor
 * for `WorkspaceRoutingGraph` (Wave 4-A2).
 *
 * SQLite FTS5 `trigram` cannot match 2-character Korean nouns (e.g. "토큰", "캐시").
 * `workspace_routing_fts_ko` stores `searchText.ts` bigram-analyzed tokens keyed by
 * `workspace_routing_nodes.node_id` (rowid), enabling 2-syllable Korean substring and
 * stem retrieval without touching the legacy `workspace_routing_fts` index.
 *
 * `workspace_routing_reindex_state` tracks per-project incremental background
 * normalization & bigram backfill progress so reindexing can pause/resume cleanly
 * whenever the user returns.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE VIRTUAL TABLE IF NOT EXISTS workspace_routing_fts_ko USING fts5(
      title_ko,
      body_ko,
      tokenize='unicode61 remove_diacritics 2'
    )
  `;

  yield* sql`
    CREATE TRIGGER IF NOT EXISTS trg_workspace_routing_fts_ko_del
    AFTER DELETE ON workspace_routing_nodes
    BEGIN
      DELETE FROM workspace_routing_fts_ko WHERE rowid = old.node_id;
    END
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS workspace_routing_reindex_state (
      project_id TEXT PRIMARY KEY,
      last_node_id INTEGER NOT NULL DEFAULT 0,
      normalized_docs INTEGER NOT NULL DEFAULT 0,
      merged_kw_nodes INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'idle',
      updated_at_ms INTEGER NOT NULL
    )
  `;
});
