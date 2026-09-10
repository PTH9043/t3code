import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { analyzeChunks } from "../searchText.ts";

/**
 * Rebuild the Workspace RAG index with Korean-aware analyzed columns.
 *
 * The 041 index tokenized with plain `unicode61`, which keeps a Korean
 * particle glued to its word ("수익률을" is one token), so a search for "수익"
 * missed up to 71% of the chunks that contained it on the live corpus. The
 * rebuilt table keeps the display columns every caller reads and adds the
 * analyzed `search_*` columns from `searchText.ts`, which alone are indexed.
 *
 * The index is derived: every chunk is reproduced from the active rag-source
 * and long-term-memory knowledge rows (checked 1:1 against the live database
 * before this shipped), so dropping and refilling it loses nothing.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DROP TABLE IF EXISTS projection_workspace_rag_chunks`;
  yield* sql`
    CREATE VIRTUAL TABLE projection_workspace_rag_chunks USING fts5(
      project_id UNINDEXED,
      item_id UNINDEXED,
      kind UNINDEXED,
      chunk_index UNINDEXED,
      title UNINDEXED,
      content UNINDEXED,
      updated_at UNINDEXED,
      tags_text UNINDEXED,
      search_title,
      search_tags,
      search_body,
      tokenize = 'unicode61 remove_diacritics 2'
    )
  `;

  const rows = yield* sql<{
    readonly projectId: string;
    readonly itemId: string;
    readonly kind: string;
    readonly title: string;
    readonly content: string;
    readonly tagsJson: string;
    readonly updatedAt: string;
  }>`
    SELECT
      project_id AS "projectId",
      item_id AS "itemId",
      kind,
      title,
      content,
      tags_json AS "tagsJson",
      updated_at AS "updatedAt"
    FROM projection_workspace_knowledge_items
    WHERE status = 'active' AND kind IN ('rag-source', 'long-term-memory')
  `;

  const decodeTags = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(Schema.String)));
  for (const row of rows) {
    // Unreadable tags only cost the tag column its weight, never the chunk.
    const tags = yield* decodeTags(row.tagsJson).pipe(
      Effect.orElseSucceed((): ReadonlyArray<string> => []),
    );
    for (const chunk of analyzeChunks({ title: row.title, content: row.content, tags })) {
      yield* sql`
        INSERT INTO projection_workspace_rag_chunks (
          project_id, item_id, kind, chunk_index, title, content, updated_at,
          tags_text, search_title, search_tags, search_body
        ) VALUES (
          ${row.projectId}, ${row.itemId}, ${row.kind}, ${chunk.chunkIndex}, ${row.title},
          ${chunk.content}, ${row.updatedAt}, ${chunk.tagsText}, ${chunk.searchTitle},
          ${chunk.searchTags}, ${chunk.searchBody}
        )
      `;
    }
  }
});
