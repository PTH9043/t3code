import {
  WorkspaceKnowledgeItem,
  WorkspaceKnowledgeOrigin,
  WorkspaceKnowledgeStatus,
  WorkspaceKnowledgeKind,
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
  type ProjectionWorkspaceKnowledgeRepositoryShape,
} from "../Services/ProjectionWorkspaceKnowledge.ts";

const ProjectionWorkspaceKnowledgeDbRow = WorkspaceKnowledgeItem.mapFields(
  Struct.assign({
    kind: WorkspaceKnowledgeKind,
    status: WorkspaceKnowledgeStatus,
    origin: WorkspaceKnowledgeOrigin,
    tags: Schema.fromJsonString(Schema.Array(Schema.String)),
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
        status,
        origin,
        relative_folder,
        tags_json,
        created_at,
        updated_at
      ) VALUES (
        ${item.projectId},
        ${item.id},
        ${item.kind},
        ${item.title},
        ${item.content},
        ${item.status},
        ${item.origin},
        ${item.relativeFolder},
        ${JSON.stringify(item.tags)},
        ${item.createdAt},
        ${item.updatedAt}
      )
      ON CONFLICT (project_id, item_id)
      DO UPDATE SET
        kind = excluded.kind,
        title = excluded.title,
        content = excluded.content,
        status = excluded.status,
        origin = excluded.origin,
        relative_folder = excluded.relative_folder,
        tags_json = excluded.tags_json,
        updated_at = excluded.updated_at
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
        project_id AS "projectId",
        kind,
        title,
        content,
        status,
        origin,
        relative_folder AS "relativeFolder",
        tags_json AS "tags",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM projection_workspace_knowledge_items
      WHERE project_id = ${projectId}
      ORDER BY updated_at DESC, item_id ASC
    `,
  });

  const upsert: ProjectionWorkspaceKnowledgeRepositoryShape["upsert"] = (item) =>
    upsertRow(item).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionWorkspaceKnowledge.upsert:query")),
    );
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

  return {
    upsert,
    archive,
    removeConversationInputs,
    listByProjectId,
  } satisfies ProjectionWorkspaceKnowledgeRepositoryShape;
});

export const ProjectionWorkspaceKnowledgeRepositoryLive = Layer.effect(
  ProjectionWorkspaceKnowledgeRepository,
  makeProjectionWorkspaceKnowledgeRepository,
);
