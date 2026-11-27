import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { knowledgeContentHash } from "../knowledgeContentHash.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE projection_workspace_knowledge_items ADD COLUMN content_hash TEXT`;
  yield* sql`ALTER TABLE projection_workspace_knowledge_items ADD COLUMN superseded_by TEXT`;
  let after: number | null = null;
  while (true) {
    const rows: readonly { rowid: number; content: string }[] = yield* sql<{
      rowid: number;
      content: string;
    }>`
      SELECT rowid, content FROM projection_workspace_knowledge_items
      WHERE ${after === null ? sql`1` : sql`rowid > ${after}`} ORDER BY rowid LIMIT 64`;
    if (rows.length === 0) break;
    for (const row of rows) {
      yield* sql`UPDATE projection_workspace_knowledge_items SET content_hash = ${knowledgeContentHash(row.content)}
        WHERE rowid = ${row.rowid}`;
    }
    after = rows[rows.length - 1]!.rowid;
  }
  yield* sql`CREATE INDEX knowledge_project_hash ON projection_workspace_knowledge_items(project_id, content_hash)`;
});
