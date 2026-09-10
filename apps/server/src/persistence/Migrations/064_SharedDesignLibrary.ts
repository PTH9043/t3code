import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * The shared library: external public references every project may read — the
 * one deliberate exception to per-project knowledge isolation.
 *
 * It lives outside the orchestration event log on purpose. The rows are a
 * cache of a public website that a sync can rebuild at any time, not a record
 * of anything a person or agent decided, so replaying thousands of scraped
 * pages through project events would cost history without buying any.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS shared_library_items (
      library_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      source TEXT NOT NULL,
      source_ref TEXT NOT NULL,
      source_url TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      tags_json TEXT NOT NULL,
      category TEXT,
      author TEXT,
      published_at TEXT,
      fetched_at TEXT NOT NULL,
      PRIMARY KEY (library_id, item_id)
    )
  `;
  yield* sql`
    CREATE VIRTUAL TABLE IF NOT EXISTS shared_library_search USING fts5(
      library_id UNINDEXED,
      item_id UNINDEXED,
      search_title,
      search_tags,
      search_body,
      tokenize = 'unicode61 remove_diacritics 2'
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS shared_library_sync_state (
      source TEXT PRIMARY KEY,
      library_id TEXT NOT NULL,
      max_ref INTEGER NOT NULL DEFAULT 0,
      scan_cursor INTEGER NOT NULL DEFAULT 0,
      full_scan_completed_at TEXT,
      last_sync_at TEXT,
      last_error TEXT,
      updated_at TEXT NOT NULL
    )
  `;
});
