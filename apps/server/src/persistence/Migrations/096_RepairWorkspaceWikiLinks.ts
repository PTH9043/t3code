import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { visibleKnowledge } from "../knowledgeVisibility.ts";
import { rebuildWorkspaceWikiLinks, resolveWorkspaceWikiTitle } from "../workspaceWikiLinks.ts";
import { ensureWikiBindingTables, ensureWikiOccurrenceIndex } from "./092_WorkspaceWikiLinks.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ name: string }>`PRAGMA table_info(projection_workspace_wiki_links)`;
  const inline = columns.some((c) => c.name === "target_item_id");
  const [bindings] =
    yield* sql`SELECT 1 FROM sqlite_schema WHERE type='table' AND name='workspace_wiki_bindings'`;

  // A recorded 092 is never rerun. Preserve its actual decisions before rebuilding its derived index.
  yield* ensureWikiBindingTables(sql);
  if (inline) {
    const choice = columns.some((c) => c.name === "needs_choice") ? sql`needs_choice` : sql`0`;
    yield* sql`INSERT INTO workspace_wiki_bindings
      (project_id,source_item_id,start_offset,end_offset,target_item_id,needs_choice)
      SELECT project_id,source_item_id,start_offset,end_offset,target_item_id,${choice}
      FROM projection_workspace_wiki_links WHERE target_item_id IS NOT NULL OR ${choice} = 1
      ON CONFLICT(project_id,source_item_id,start_offset) DO NOTHING`;
    yield* sql`DROP TABLE projection_workspace_wiki_links`;
  }
  yield* ensureWikiOccurrenceIndex(sql);
  if (inline || !bindings || !columns.length) yield* rebuildWorkspaceWikiLinks(sql);

  // A split index with a missing decision table can still recover a chosen ID from the
  // latest matching revision. Explicit IDs in the body have already been restored by the parser.
  if (!bindings && !inline) {
    yield* sql`INSERT INTO workspace_wiki_bindings
        (project_id,source_item_id,start_offset,end_offset,target_item_id,needs_choice)
      SELECT l.project_id,l.source_item_id,l.start_offset,l.end_offset,
        stamp.value->>'$.targetItemId', coalesce(stamp.value->>'$.needsChoice',0)
      FROM projection_workspace_knowledge_items k
      JOIN orchestration_events e ON e.sequence=(
        SELECT prior.sequence FROM orchestration_events prior
        WHERE prior.aggregate_kind='project' AND prior.stream_id=k.project_id
          AND prior.event_type IN ('project.knowledge-item-upserted','project.knowledge-item-archived')
          AND prior.event_type='project.knowledge-item-upserted' AND json_extract(prior.payload_json,'$.itemId')=k.item_id
        ORDER BY prior.sequence DESC LIMIT 1)
      JOIN json_each(e.payload_json,'$.wikiLinkBindings') stamp
      JOIN projection_workspace_wiki_links l ON l.project_id=k.project_id AND l.source_item_id=k.item_id
        AND l.start_offset=stamp.value->>'$.start'
      WHERE instr(k.content,'[[')>0 AND e.payload_json->>'$.content'=k.content
        AND substr(l.target_title,1,3)<>'id:'
        AND (stamp.value->>'$.targetItemId' IS NOT NULL OR stamp.value->>'$.needsChoice'=1)
      ON CONFLICT(project_id,source_item_id,start_offset) DO UPDATE SET
        target_item_id=excluded.target_item_id,needs_choice=excluded.needs_choice`;
  }

  // Revisit only unresolved choices whose title included an invisible candidate.
  // Genuine ambiguity without such a candidate stays sticky when a namesake disappears.
  const affected = yield* sql<{ projectId: string; title: string }>`
    SELECT DISTINCT l.project_id AS projectId, l.target_title AS title
    FROM workspace_wiki_bindings b JOIN projection_workspace_wiki_links l
      USING(project_id,source_item_id,start_offset)
    WHERE b.target_item_id IS NULL AND b.needs_choice=1 AND EXISTS (
      SELECT 1 FROM projection_workspace_knowledge_items
      WHERE project_id=l.project_id AND title=l.target_title AND status<>'archived'
        AND NOT ${visibleKnowledge(sql)})`;
  for (const { projectId, title } of affected) {
    yield* sql`DELETE FROM workspace_wiki_bindings WHERE project_id=${projectId}
      AND target_item_id IS NULL AND needs_choice=1 AND (source_item_id,start_offset) IN (
        SELECT source_item_id,start_offset FROM projection_workspace_wiki_links
        WHERE project_id=${projectId} AND target_title=${title})`;
    yield* resolveWorkspaceWikiTitle(sql, projectId, title);
  }
});
