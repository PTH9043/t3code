import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_workspace_knowledge_items (
      project_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (
        kind IN (
          'directive',
          'goal',
          'rag-source',
          'run-memory',
          'working-memory',
          'long-term-memory',
          'prompt'
        )
      ),
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('candidate', 'active', 'superseded', 'archived')),
      origin TEXT NOT NULL CHECK (origin IN ('user', 'agent', 'imported')),
      relative_folder TEXT,
      tags_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (project_id, item_id),
      FOREIGN KEY (project_id) REFERENCES projection_projects(project_id)
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_workspace_knowledge_lookup
    ON projection_workspace_knowledge_items(project_id, kind, status, updated_at DESC)
  `;
});
