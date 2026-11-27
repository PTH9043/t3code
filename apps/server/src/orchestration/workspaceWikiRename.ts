import {
  EventId,
  ProjectKnowledgeItemUpsertedPayload,
  WorkspaceKnowledgeItemId,
  type OrchestrationEvent,
  type WorkspaceKnowledgeItem,
} from "@t3tools/contracts";
import {
  formatWorkspaceWikiIdLink,
  parseWorkspaceWikiLinks,
} from "@t3tools/shared/workspaceWikiLinks";
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  readWikiOccurrences,
  retainedWikiBindings,
  type WikiBinding,
} from "../persistence/workspaceWikiLinks.ts";

import type { ProjectionSnapshotQueryShape } from "./Services/ProjectionSnapshotQuery.ts";
import { visibleKnowledge } from "../persistence/knowledgeVisibility.ts";
import { toPersistenceSqlError } from "../persistence/Errors.ts";

type Draft = Omit<OrchestrationEvent, "sequence">;
type Payload = typeof ProjectKnowledgeItemUpsertedPayload.Type;
type List = NonNullable<ProjectionSnapshotQueryShape["listWorkspaceKnowledge"]>;
const isItemId = Schema.is(WorkspaceKnowledgeItemId);

function rewriteBody(
  content: string,
  known: ReadonlyMap<number, WikiBinding>,
  target: Payload,
  previousTitle: string,
) {
  let offset = 0;
  let rewritten = "";
  const bindings: NonNullable<Payload["wikiLinkBindings"]>[number][] = [];
  for (const link of parseWorkspaceWikiLinks(content)) {
    rewritten += content.slice(offset, link.start);
    const binding = known.get(link.start);
    if (binding && (binding.targetItemId === null || isItemId(binding.targetItemId))) {
      bindings.push({ ...binding, start: rewritten.length, targetItemId: binding.targetItemId });
    }
    if ((binding?.targetItemId ?? link.explicitItemId) === target.itemId) {
      const label = link.alias === previousTitle || link.alias === null ? target.title : link.alias;
      if (
        link.explicitItemId ||
        /[[\]|\\\r\n]/u.test(target.title) ||
        target.title.startsWith("id:")
      ) {
        rewritten += formatWorkspaceWikiIdLink(target.itemId, label);
      } else {
        rewritten +=
          content.slice(link.start, link.targetStart) +
          target.title +
          content.slice(link.targetEnd, link.end);
      }
    } else {
      rewritten += content.slice(link.start, link.end);
    }
    offset = link.end;
  }
  return { content: rewritten + content.slice(offset), wikiLinkBindings: bindings };
}

function sourcePayload(item: WorkspaceKnowledgeItem, updatedAt: string): Payload {
  return {
    projectId: item.projectId,
    itemId: item.id,
    title: item.title,
    content: item.content,
    kind: item.kind,
    origin: item.origin,
    status: item.status,
    relativeFolder: item.relativeFolder,
    scope: item.scope ?? "project",
    appliesToFolder: item.appliesToFolder ?? null,
    tags: item.tags,
    research: item.research ?? null,
    sourceItemId: item.sourceItemId ?? null,
    provenance: item.provenance ?? null,
    supersededBy: item.supersededBy ?? null,
    originalChars: item.originalChars,
    storedChars: item.storedChars,
    updatedAt,
  };
}

/** Invoked inside the command transaction. Replay only projects these persisted events. */
export const planWorkspaceWikiEvents = Effect.fn("planWorkspaceWikiEvents")(function* (
  sql: SqlClient.SqlClient,
  list: List | undefined,
  event: Draft,
  canonicalized = false,
) {
  if (event.type !== "project.knowledge-item-upserted") return [event];
  // The event-store draft type omits sequence from the union and loses its discriminant.
  const target = event.payload as Payload;
  const { projectId, itemId } = target;
  const [prior] = yield* sql<{ title: string; content: string }>`SELECT title, content
    FROM projection_workspace_knowledge_items WHERE project_id = ${projectId} AND item_id = ${itemId}
      AND ${visibleKnowledge(sql)}`;
  const renamed = prior !== undefined && prior.title !== target.title;
  const readBindings = (sourceId: string, before: string, after: string) =>
    readWikiOccurrences(sql, projectId, sourceId).pipe(
      Effect.map((rows) => retainedWikiBindings(before, after, rows)),
    );

  const inheritedId = prior ? itemId : target.sourceItemId;
  let previous = prior;
  if (!prior && inheritedId && target.content.includes("[[")) {
    [previous] = yield* sql<{ title: string; content: string }>`SELECT title, content
      FROM projection_workspace_knowledge_items WHERE project_id = ${projectId} AND item_id = ${inheritedId}
        AND ${visibleKnowledge(sql)}`;
  }
  let original = event;
  if (previous && inheritedId && target.content.includes("[[")) {
    const known = yield* readBindings(inheritedId, previous.content, target.content);
    if (canonicalized) {
      for (const [start, binding] of known) if (binding.targetItemId !== null) known.delete(start);
    }
    if (known.size || canonicalized || renamed) {
      const adjusted = renamed
        ? rewriteBody(target.content, known, target, previous.title)
        : {
            content: target.content,
            wikiLinkBindings: [...known.values()].filter(
              (binding) => binding.targetItemId === null || isItemId(binding.targetItemId),
            ),
          };
      original = { ...event, payload: { ...target, ...adjusted } as Payload };
    }
  }
  if (!renamed) return [original];
  const sources = yield* sql<{ id: WorkspaceKnowledgeItemId }>`SELECT DISTINCT source_item_id AS id
    FROM workspace_wiki_bindings WHERE project_id = ${projectId} AND target_item_id = ${itemId}
      AND source_item_id <> ${itemId} ORDER BY source_item_id`;
  const drafts: Draft[] = [];
  for (const { id } of sources) {
    if (!list)
      return yield* toPersistenceSqlError("WorkspaceWiki.rename:sourceQueryUnavailable")(null);
    const { items } = yield* list({ projectId, itemId: id });
    const source = items.find((item) => item.id === id && item.projectId === projectId);
    if (!source) continue;
    const known = yield* readBindings(id, source.content, source.content);
    const edit = rewriteBody(source.content, known, target, prior.title);
    if (edit.content === source.content) continue;
    const payload = sourcePayload(source, target.updatedAt);
    drafts.push({
      ...event,
      eventId: EventId.make(NodeCrypto.randomUUID()),
      commandId: null,
      metadata: {},
      correlationId: event.commandId ?? event.correlationId,
      causationEventId: null,
      payload: { ...payload, ...edit },
    });
  }
  // The write receipt's sequence identifies the document requested by the caller.
  return [...drafts, original];
});
