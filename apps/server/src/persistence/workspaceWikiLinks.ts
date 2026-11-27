import type {
  WorkspaceWikiLink,
  WorkspaceWikiLinksInput,
  WorkspaceWikiLinksResult,
} from "@t3tools/contracts";
import { parseWorkspaceWikiLinks } from "@t3tools/shared/workspaceWikiLinks";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { visibleKnowledge } from "./knowledgeVisibility.ts";

type Sql = SqlClient.SqlClient;

export interface WikiBinding {
  start: number;
  targetItemId: string | null;
  needsChoice: boolean;
}

interface Occurrence {
  start: number;
  end: number;
  targetItemId: string | null;
  needsChoice: number;
}

// Keep bindings on unchanged text when an edit shifts a range. Do not guess between
// identical new and removed occurrences inside the replacement range.
export function retainedWikiBindings(
  previous: string,
  content: string,
  occurrences: readonly Occurrence[],
) {
  let prefix = 0;
  const common = Math.min(previous.length, content.length);
  while (prefix < common && previous[prefix] === content[prefix]) prefix++;
  let suffix = 0;
  while (suffix < common - prefix && previous.at(-1 - suffix) === content.at(-1 - suffix)) suffix++;
  const delta = content.length - previous.length;
  const bindings = new Map<number, WikiBinding>();
  for (const occurrence of occurrences) {
    const start =
      occurrence.end <= prefix
        ? occurrence.start
        : occurrence.start >= previous.length - suffix
          ? occurrence.start + delta
          : null;
    if (start !== null)
      bindings.set(start, {
        start,
        targetItemId: occurrence.targetItemId,
        needsChoice: Boolean(occurrence.needsChoice),
      });
  }
  if (bindings.size < occurrences.length && content.includes("[[")) {
    // A uniquely matching surviving token can move when a user edits both ends of a paragraph.
    const byText = new Map<string, Occurrence | null>();
    for (const old of occurrences) {
      const text = previous.slice(old.start, old.end);
      byText.set(text, byText.has(text) ? null : old);
    }
    const newStarts = new Map<string, number | null>();
    for (const link of parseWorkspaceWikiLinks(content)) {
      const text = content.slice(link.start, link.end);
      newStarts.set(text, newStarts.has(text) ? null : link.start);
    }
    for (const [text, start] of newStarts) {
      const old = byText.get(text);
      if (old && start !== null && !bindings.has(start)) {
        bindings.set(start, {
          start,
          targetItemId: old.targetItemId,
          needsChoice: Boolean(old.needsChoice),
        });
      }
    }
  }
  return bindings;
}

export const readWikiOccurrences = (sql: Sql, projectId: string, itemId: string) =>
  sql<Occurrence>`SELECT start_offset AS start, end_offset AS end,
    target_item_id AS targetItemId, needs_choice AS needsChoice
    FROM workspace_wiki_bindings WHERE project_id = ${projectId} AND source_item_id = ${itemId}
    ORDER BY start_offset`;

export const resolveWorkspaceWikiTitle = (
  sql: Sql,
  projectId: string,
  title: string,
  sourceId?: string,
  isVisible = visibleKnowledge,
) =>
  sql`INSERT INTO workspace_wiki_bindings (project_id, source_item_id, start_offset, end_offset, target_item_id, needs_choice)
    SELECT l.project_id, l.source_item_id, l.start_offset, l.end_offset, candidates.id, candidates.n > 1
    FROM projection_workspace_wiki_links l
    CROSS JOIN (SELECT count(*) AS n, CASE WHEN count(*) = 1 THEN min(item_id) END AS id FROM (
      SELECT item_id FROM projection_workspace_knowledge_items
      WHERE project_id = ${projectId} AND title = ${title} AND status <> 'archived'
        AND ${isVisible(sql)} LIMIT 2
    )) candidates
    WHERE l.project_id = ${projectId} AND l.target_title = ${title} AND candidates.n > 0
      ${sourceId === undefined ? sql`` : sql`AND l.source_item_id = ${sourceId}`}
      AND NOT EXISTS (SELECT 1 FROM workspace_wiki_bindings b WHERE b.project_id = l.project_id
        AND b.source_item_id = l.source_item_id AND b.start_offset = l.start_offset)`;

export const reindexWorkspaceWikiItem = Effect.fn("reindexWorkspaceWikiItem")(function* (
  sql: Sql,
  projectId: string,
  itemId: string,
  content: string,
  retained: ReadonlyMap<number, WikiBinding>,
  isVisible = visibleKnowledge,
) {
  const occurrences = parseWorkspaceWikiLinks(content);
  const rows = occurrences.map((link) => {
    const binding = retained.get(link.start);
    return {
      project_id: projectId,
      source_item_id: itemId,
      target_title: link.targetTitle,
      start_offset: link.start,
      end_offset: link.end,
      context: link.context,
      target_item_id: link.explicitItemId ?? binding?.targetItemId ?? null,
      needs_choice: Number(binding?.needsChoice ?? false),
    };
  });
  yield* sql`DELETE FROM projection_workspace_wiki_links WHERE project_id = ${projectId} AND source_item_id = ${itemId}`;
  yield* sql`DELETE FROM workspace_wiki_bindings WHERE project_id = ${projectId} AND source_item_id = ${itemId}`;
  // Bound variables stay below SQLite's limit even for generated documents.
  for (let i = 0; i < rows.length; i += 80) {
    const batch = rows.slice(i, i + 80);
    const links = batch.map(
      ({ target_item_id: _target, needs_choice: _choice, ...occurrence }) => occurrence,
    );
    yield* sql`INSERT INTO projection_workspace_wiki_links ${sql.insert(links)}`;
    const decisions = batch
      .filter((row) => row.target_item_id !== null || row.needs_choice)
      .map(({ target_title: _title, context: _context, ...decision }) => decision);
    if (decisions.length) yield* sql`INSERT INTO workspace_wiki_bindings ${sql.insert(decisions)}`;
  }
  for (const title of new Set(
    rows.filter((row) => !row.target_item_id && !row.needs_choice).map((row) => row.target_title),
  )) {
    yield* resolveWorkspaceWikiTitle(sql, projectId, title, itemId, isVisible);
  }
});

export const updateWorkspaceWikiIndex = Effect.fn("updateWorkspaceWikiIndex")(function* (
  sql: Sql,
  item: { projectId: string; id: string; title: string; content: string; status: string },
  previous?: { title: string; content: string; status: string },
  stamped?: readonly WikiBinding[],
) {
  if (previous?.content !== item.content || stamped !== undefined) {
    const retained =
      stamped !== undefined
        ? new Map(stamped.map((binding) => [binding.start, binding]))
        : previous?.content.includes("[[")
          ? retainedWikiBindings(
              previous.content,
              item.content,
              yield* readWikiOccurrences(sql, item.projectId, item.id),
            )
          : new Map<number, WikiBinding>();
    if (item.content.includes("[[") || previous?.content.includes("[[")) {
      yield* reindexWorkspaceWikiItem(sql, item.projectId, item.id, item.content, retained);
    }
  }
  if (
    item.status !== "archived" &&
    (previous?.title !== item.title || previous.status === "archived")
  ) {
    yield* resolveWorkspaceWikiTitle(sql, item.projectId, item.title);
  }
});

const rebuildIndex = Effect.fn("rebuildWorkspaceWikiLinks")(function* (
  sql: Sql,
  projectId?: string,
  isVisible = visibleKnowledge,
) {
  type Document = { rowid: number; project_id: string; item_id: string; content: string };
  let after: number | null = null;
  for (;;) {
    const rows: readonly Document[] = yield* sql<Document>`
      SELECT rowid, project_id, item_id, content FROM projection_workspace_knowledge_items
      WHERE ${after === null ? sql`1` : sql`rowid > ${after}`}
        AND ${projectId === undefined ? sql`1` : sql`project_id = ${projectId}`}
        AND instr(content, '[[') > 0 ORDER BY rowid LIMIT 64`;
    if (!rows.length) break;
    for (const row of rows) {
      const known = yield* readWikiOccurrences(sql, row.project_id, row.item_id);
      yield* reindexWorkspaceWikiItem(
        sql,
        row.project_id,
        row.item_id,
        row.content,
        retainedWikiBindings(row.content, row.content, known),
        isVisible,
      );
    }
    after = rows[rows.length - 1]!.rowid;
  }
});

export const rebuildWorkspaceWikiLinks = (
  sql: Sql,
  projectId?: string,
  isVisible = visibleKnowledge,
) => sql.withTransaction(rebuildIndex(sql, projectId, isVisible));

export const readWorkspaceWikiLinks = Effect.fn("readWorkspaceWikiLinks")(function* (
  sql: Sql,
  { projectId, itemId }: WorkspaceWikiLinksInput,
): Effect.fn.Return<WorkspaceWikiLinksResult, import("effect/unstable/sql/SqlError").SqlError> {
  const query = (incoming: boolean) => sql<WorkspaceWikiLink>`
    WITH visible AS NOT MATERIALIZED (
      SELECT item_id, title FROM projection_workspace_knowledge_items
      WHERE project_id = ${projectId} AND ${visibleKnowledge(sql)}
        AND EXISTS (SELECT 1 FROM projection_projects WHERE project_id = ${projectId} AND deleted_at IS NULL)
    )
    SELECT source.item_id AS sourceItemId, source.title AS sourceTitle,
      coalesce(target.title, link.target_title) AS targetTitle, target.item_id AS targetItemId,
      link.context, link.start_offset AS start, link.end_offset AS end
    FROM projection_workspace_wiki_links link
    JOIN visible source ON source.item_id = link.source_item_id
    LEFT JOIN workspace_wiki_bindings binding USING (project_id, source_item_id, start_offset)
    LEFT JOIN visible target ON target.item_id = binding.target_item_id
    WHERE link.project_id = ${projectId} AND ${
      incoming
        ? sql`binding.target_item_id = ${itemId} AND target.item_id IS NOT NULL`
        : sql`link.source_item_id = ${itemId}`
    }
    ORDER BY source.item_id, link.start_offset`;
  const outgoing = yield* query(false);
  const backlinks = yield* query(true);
  return { outgoing, backlinks, unresolved: outgoing.filter((link) => link.targetItemId === null) };
});
