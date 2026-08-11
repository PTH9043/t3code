import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE VIRTUAL TABLE IF NOT EXISTS projection_workspace_rag_chunks USING fts5(
      project_id UNINDEXED,
      item_id UNINDEXED,
      kind UNINDEXED,
      chunk_index UNINDEXED,
      title,
      content,
      updated_at UNINDEXED,
      tokenize = 'unicode61 remove_diacritics 2'
    )
  `;
});
