import { visibleKnowledge } from "../knowledgeVisibility.ts";
import { updateWorkspaceWikiIndex } from "../workspaceWikiLinks.ts";
import { knowledgeContentHash } from "../knowledgeContentHash.ts";
import {
  WorkspaceKnowledgeItem,
  WorkspaceKnowledgeOrigin,
  WorkspaceKnowledgeStatus,
  WorkspaceKnowledgeKind,
  WorkspaceResearchRecord,
  WorkspaceKnowledgeProvenance,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  ArchiveProjectionWorkspaceKnowledgeInput,
  ListProjectionWorkspaceKnowledgeInput,
  ProjectionWorkspaceKnowledgeItem,
  ProjectionWorkspaceKnowledgeRepository,
  RecordProjectionWorkspaceKnowledgeUsageInput,
  type ProjectionWorkspaceKnowledgeRepositoryShape,
} from "../Services/ProjectionWorkspaceKnowledge.ts";

const encodeMessageIds = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)));

export const ProjectionWorkspaceKnowledgeDbRow = WorkspaceKnowledgeItem.mapFields(
  Struct.assign({
    kind: WorkspaceKnowledgeKind,
    status: WorkspaceKnowledgeStatus,
    origin: WorkspaceKnowledgeOrigin,
    tags: Schema.fromJsonString(Schema.Array(Schema.String)),
    research: Schema.NullOr(Schema.fromJsonString(WorkspaceResearchRecord)),
    provenance: Schema.NullOr(Schema.fromJsonString(WorkspaceKnowledgeProvenance)),
  }),
);

const makeProjectionWorkspaceKnowledgeRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertRow = SqlSchema.void({
    Request: ProjectionWorkspaceKnowledgeItem,
    execute: (item) => sql`
      INSERT INTO projection_workspace_knowledge_items (
        project_id,
        item_id,
        kind,
        title,
        content,
        content_hash,
        superseded_by,
        status,
        origin,
        relative_folder,
        scope,
        applies_to_folder,
        research_json,
        tags_json,
        provenance_json,
        source_item_id,
        original_chars,
        stored_chars,
        created_at,
        updated_at
      ) VALUES (
        ${item.projectId},
        ${item.id},
        ${item.kind},
        ${item.title},
        ${item.content},
        ${knowledgeContentHash(item.content)},
        ${item.supersededBy ?? null},
        ${item.status},
        ${item.origin},
        ${item.relativeFolder},
        ${item.scope ?? "project"},
        ${item.appliesToFolder ?? null},
        ${item.research == null ? null : JSON.stringify(item.research)},
        ${JSON.stringify(item.tags)},
        ${item.provenance ? JSON.stringify(item.provenance) : null},
        ${item.sourceItemId ?? null},
        ${item.originalChars},
        ${item.storedChars},
        ${item.createdAt},
        ${item.updatedAt}
      )
      ON CONFLICT (project_id, item_id)
      DO UPDATE SET
        kind = excluded.kind,
        title = excluded.title,
        content = excluded.content,
        content_hash = excluded.content_hash,
        superseded_by = COALESCE(excluded.superseded_by, projection_workspace_knowledge_items.superseded_by),
        status = CASE WHEN projection_workspace_knowledge_items.superseded_by IS NOT NULL
          AND excluded.status IN ('candidate','active') THEN 'superseded' ELSE excluded.status END,
        origin = excluded.origin,
        relative_folder = excluded.relative_folder,
        scope = excluded.scope,
        applies_to_folder = excluded.applies_to_folder,
        research_json = excluded.research_json,
        tags_json = excluded.tags_json,
        provenance_json = coalesce(excluded.provenance_json, provenance_json),
        source_item_id = coalesce(excluded.source_item_id, source_item_id),
        original_chars = excluded.original_chars,
        stored_chars = excluded.stored_chars,
        updated_at = excluded.updated_at
    `,
  });

  // Counted per event rather than per item id so a composition that pulled the
  // same item through two paths still counts once. `last_used_at` only moves
  // forward, keeping a replay of older events from rewriting a newer timestamp.
  const recordUsageRows = SqlSchema.void({
    Request: RecordProjectionWorkspaceKnowledgeUsageInput,
    execute: ({ projectId, itemIds, usedAt }) => sql`
      UPDATE projection_workspace_knowledge_items
      SET
        prompt_uses = prompt_uses + 1,
        last_used_at = CASE
          WHEN last_used_at IS NULL OR last_used_at < ${usedAt} THEN ${usedAt}
          ELSE last_used_at
        END
      WHERE project_id = ${projectId}
        AND item_id IN ${sql.in(itemIds)}
    `,
  });

  const archiveRow = SqlSchema.void({
    Request: ArchiveProjectionWorkspaceKnowledgeInput,
    execute: ({ projectId, itemId, archivedAt }) => sql`
      UPDATE projection_workspace_knowledge_items
      SET status = 'archived', updated_at = ${archivedAt}
      WHERE project_id = ${projectId} AND item_id = ${itemId}
    `,
  });

  const listRows = SqlSchema.findAll({
    Request: ListProjectionWorkspaceKnowledgeInput,
    Result: ProjectionWorkspaceKnowledgeDbRow,
    execute: ({ projectId }) => sql`
      SELECT
        item_id AS "id",
        superseded_by AS "supersededBy",
        project_id AS "projectId",
        kind,
        title,
        content,
        status,
        origin,
        relative_folder AS "relativeFolder",
        scope,
        applies_to_folder AS "appliesToFolder",
        research_json AS "research",
        tags_json AS "tags",
        provenance_json AS "provenance",
        source_item_id AS "sourceItemId",
        original_chars AS "originalChars",
        stored_chars AS "storedChars",
        prompt_uses AS "promptUses",
        last_used_at AS "lastUsedAt",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM projection_workspace_knowledge_items
      WHERE project_id = ${projectId}
        AND ${visibleKnowledge(sql)}
      ORDER BY updated_at DESC, item_id ASC
    `,
  });

  const upsert: ProjectionWorkspaceKnowledgeRepositoryShape["upsert"] = (item, bindings) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const [previous] = yield* sql<{ title: string; content: string; status: string }>`
        SELECT title, content, status FROM projection_workspace_knowledge_items
        WHERE project_id = ${item.projectId} AND item_id = ${item.id}`;
          yield* upsertRow(item);
          yield* updateWorkspaceWikiIndex(sql, item, previous, bindings);
        }),
      )
      .pipe(Effect.mapError(toPersistenceSqlError("ProjectionWorkspaceKnowledge.upsert:query")));
  const recordUsage: ProjectionWorkspaceKnowledgeRepositoryShape["recordUsage"] = (input) => {
    const uniqueItemIds = Array.from(new Set(input.itemIds));
    return uniqueItemIds.length === 0
      ? Effect.void
      : recordUsageRows({ ...input, itemIds: uniqueItemIds }).pipe(
          Effect.mapError(toPersistenceSqlError("ProjectionWorkspaceKnowledge.recordUsage:query")),
        );
  };

  const archive: ProjectionWorkspaceKnowledgeRepositoryShape["archive"] = (input) =>
    archiveRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionWorkspaceKnowledge.archive:query")),
    );
  const removeConversationInputs: ProjectionWorkspaceKnowledgeRepositoryShape["removeConversationInputs"] =
    (input) =>
      Effect.gen(function* () {
        const itemPattern = (input.itemPrefix ?? "conversation-") + "%";
        yield* sql`
          DELETE FROM projection_workspace_rag_chunks
          WHERE project_id = ${input.projectId}
            AND item_id LIKE ${itemPattern}
            AND EXISTS (
              SELECT 1
              FROM projection_workspace_knowledge_items AS knowledge
              WHERE knowledge.project_id = projection_workspace_rag_chunks.project_id
                AND knowledge.item_id = projection_workspace_rag_chunks.item_id
                AND knowledge.tags_json LIKE '%"auto-conversation"%'
            )
        `;
        yield* sql`
          DELETE FROM projection_workspace_knowledge_items
          WHERE project_id = ${input.projectId}
            AND item_id LIKE ${itemPattern}
            AND tags_json LIKE '%"auto-conversation"%'
        `;
      }).pipe(
        Effect.mapError(
          toPersistenceSqlError("ProjectionWorkspaceKnowledge.removeConversationInputs:query"),
        ),
      );
  const listByProjectId: ProjectionWorkspaceKnowledgeRepositoryShape["listByProjectId"] = (input) =>
    listRows(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionWorkspaceKnowledge.listByProjectId:query")),
    );

  const removeAttachmentDocuments: ProjectionWorkspaceKnowledgeRepositoryShape["removeAttachmentDocuments"] =
    (input) =>
      Effect.gen(function* () {
        const retainedIdsJson = yield* encodeMessageIds(input.retainedMessageIds ?? []);
        yield* sql`DELETE FROM pdf_revision_documents WHERE project_id = ${input.projectId}
          AND (${input.threadId ?? null} IS NULL OR thread_id = ${input.threadId ?? null})
          AND (${input.retainedMessageIds ? 1 : 0} = 0 OR message_id NOT IN (SELECT value FROM json_each(${retainedIdsJson})))`;
        yield* sql`DELETE FROM projection_workspace_rag_chunks WHERE project_id = ${input.projectId}
        AND item_id IN (SELECT item_id FROM projection_workspace_knowledge_items
          WHERE project_id = ${input.projectId} AND json_extract(research_json, '$.attachment.attachmentId') IS NOT NULL
          AND (${input.threadId ?? null} IS NULL OR json_extract(research_json, '$.attachment.threadId') = ${input.threadId ?? null})
          AND (${input.retainedMessageIds ? 1 : 0} = 0 OR json_extract(research_json, '$.attachment.messageId') NOT IN (SELECT value FROM json_each(${retainedIdsJson}))))`;
        yield* sql`DELETE FROM projection_workspace_knowledge_items WHERE project_id = ${input.projectId}
        AND json_extract(research_json, '$.attachment.attachmentId') IS NOT NULL
        AND (${input.threadId ?? null} IS NULL OR json_extract(research_json, '$.attachment.threadId') = ${input.threadId ?? null})
        AND (${input.retainedMessageIds ? 1 : 0} = 0 OR json_extract(research_json, '$.attachment.messageId') NOT IN (SELECT value FROM json_each(${retainedIdsJson})))`;
      }).pipe(
        Effect.mapError(
          toPersistenceSqlError("ProjectionWorkspaceKnowledge.removeAttachmentDocuments"),
        ),
      );
  return {
    upsert,
    archive,
    recordUsage,
    removeConversationInputs,
    removeAttachmentDocuments,
    listByProjectId,
  } satisfies ProjectionWorkspaceKnowledgeRepositoryShape;
});

export const ProjectionWorkspaceKnowledgeRepositoryLive = Layer.effect(
  ProjectionWorkspaceKnowledgeRepository,
  makeProjectionWorkspaceKnowledgeRepository,
);
