import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Prompt-usage counters for knowledge items.
 *
 * Automatic capture (conversation compaction, agent run outputs) makes items
 * cheap to accumulate, so a project needs to see which of them ever reached a
 * model. Existing rows start at zero rather than being backfilled: the events
 * that composed past prompts never recorded which items they used, so any
 * backfilled number would be invented.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{
    readonly name: string;
  }>`SELECT name FROM pragma_table_info('projection_workspace_knowledge_items')`;
  const existing = new Set(columns.map((column) => column.name));

  if (!existing.has("prompt_uses")) {
    yield* sql`
      ALTER TABLE projection_workspace_knowledge_items
      ADD COLUMN prompt_uses INTEGER NOT NULL DEFAULT 0
    `;
  }
  if (!existing.has("last_used_at")) {
    yield* sql`
      ALTER TABLE projection_workspace_knowledge_items
      ADD COLUMN last_used_at TEXT
    `;
  }

  // The dashboard's "never used" and "most used" reads both sort on this.
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_workspace_knowledge_usage
    ON projection_workspace_knowledge_items(project_id, prompt_uses DESC, last_used_at DESC)
  `;
});
