import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Existing knowledge remains project-local; sharing is an explicit change. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE projection_workspace_knowledge_items ADD COLUMN scope TEXT NOT NULL DEFAULT 'project'`;
  yield* sql`ALTER TABLE projection_workspace_knowledge_items ADD COLUMN applies_to_folder TEXT`;
  yield* sql`ALTER TABLE projection_workspace_knowledge_items ADD COLUMN research_json TEXT`;
  yield* sql`CREATE INDEX idx_workspace_knowledge_scope ON projection_workspace_knowledge_items(scope, project_id)`;

  yield* sql`CREATE TEMP TABLE workspace_rag_scope_backfill AS SELECT * FROM projection_workspace_rag_chunks`;
  yield* sql`DROP TABLE projection_workspace_rag_chunks`;
  yield* sql`
    CREATE VIRTUAL TABLE projection_workspace_rag_chunks USING fts5(
      project_id UNINDEXED, item_id UNINDEXED, kind UNINDEXED, chunk_index UNINDEXED,
      title UNINDEXED, content UNINDEXED, updated_at UNINDEXED, tags_text UNINDEXED,
      search_title, search_tags, search_body, scope UNINDEXED, applies_to_folder UNINDEXED,
      tokenize = 'unicode61 remove_diacritics 2'
    )
  `;
  yield* sql`
    INSERT INTO projection_workspace_rag_chunks
    SELECT project_id, item_id, kind, chunk_index, title, content, updated_at,
      tags_text, search_title, search_tags, search_body, 'project', NULL
    FROM workspace_rag_scope_backfill
  `;
  yield* sql`DROP TABLE workspace_rag_scope_backfill`;
});
