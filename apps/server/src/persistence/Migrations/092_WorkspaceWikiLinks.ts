import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { visibleOriginal } from "../knowledgeVisibility.ts";
import { rebuildWorkspaceWikiLinks } from "../workspaceWikiLinks.ts";

export const ensureWikiBindingTables = Effect.fn("ensureWikiBindingTables")(function* (
  sql: SqlClient.SqlClient,
) {
  // Identity decisions survive a rebuild of the occurrence/context index.
  yield* sql`CREATE TABLE IF NOT EXISTS workspace_wiki_bindings (
    project_id TEXT NOT NULL, source_item_id TEXT NOT NULL, start_offset INTEGER NOT NULL,
    end_offset INTEGER NOT NULL, target_item_id TEXT, needs_choice INTEGER NOT NULL,
    PRIMARY KEY (project_id, source_item_id, start_offset),
    FOREIGN KEY (project_id, source_item_id)
      REFERENCES projection_workspace_knowledge_items(project_id, item_id) ON DELETE CASCADE
  )`;
  yield* sql`CREATE TABLE IF NOT EXISTS workspace_wiki_backfill_cursor (sequence INTEGER PRIMARY KEY)`;
});

export const ensureWikiOccurrenceIndex = Effect.fn("ensureWikiOccurrenceIndex")(function* (
  sql: SqlClient.SqlClient,
) {
  yield* sql`CREATE TABLE IF NOT EXISTS projection_workspace_wiki_links (
    project_id TEXT NOT NULL, source_item_id TEXT NOT NULL,
    start_offset INTEGER NOT NULL, end_offset INTEGER NOT NULL,
    target_title TEXT NOT NULL, context TEXT NOT NULL,
    PRIMARY KEY (project_id, source_item_id, start_offset),
    FOREIGN KEY (project_id, source_item_id)
      REFERENCES projection_workspace_knowledge_items(project_id, item_id) ON DELETE CASCADE
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS workspace_wiki_backlinks ON workspace_wiki_bindings(project_id, target_item_id)`;
  yield* sql`CREATE INDEX IF NOT EXISTS workspace_wiki_by_title ON projection_workspace_wiki_links(project_id, target_title)`;
  yield* sql`CREATE INDEX IF NOT EXISTS workspace_wiki_titles ON projection_workspace_knowledge_items(project_id, title)`;
});

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* ensureWikiBindingTables(sql);
  yield* ensureWikiOccurrenceIndex(sql);
  yield* sql`INSERT INTO workspace_wiki_backfill_cursor SELECT last_applied_sequence FROM projection_state
    WHERE projector = 'projection.workspace-knowledge-v2' AND last_applied_sequence > 0`;
  // Forks and their source_item_id column first exist at 093.
  yield* rebuildWorkspaceWikiLinks(sql, undefined, visibleOriginal);
});
