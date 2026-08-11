import { WorkspaceRagMatch } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceDecodeError, toPersistenceSqlError } from "../Errors.ts";
import {
  ProjectionWorkspaceRagRepository,
  type ProjectionWorkspaceRagRepositoryShape,
} from "../Services/ProjectionWorkspaceRag.ts";

const CHUNK_SIZE = 1_200;
const CHUNK_OVERLAP = 200;

const RagSearchRequest = Schema.Struct({
  projectId: Schema.String,
  ftsQuery: Schema.String,
  includeLongTermMemory: Schema.Boolean,
  limit: Schema.Int,
});
const RagSearchRow = WorkspaceRagMatch;

export function chunkWorkspaceKnowledgeContent(content: string): ReadonlyArray<string> {
  const normalized = content.replaceAll("\r\n", "\n").trim();
  if (normalized.length === 0) return [];
  if (normalized.length <= CHUNK_SIZE) return [normalized];

  const chunks: string[] = [];
  let start = 0;
  while (start < normalized.length) {
    const hardEnd = Math.min(normalized.length, start + CHUNK_SIZE);
    let end = hardEnd;
    if (hardEnd < normalized.length) {
      const candidate = normalized.slice(start + Math.floor(CHUNK_SIZE / 2), hardEnd);
      const newline = candidate.lastIndexOf("\n");
      const space = candidate.lastIndexOf(" ");
      const boundary = Math.max(newline, space);
      if (boundary >= 0) end = start + Math.floor(CHUNK_SIZE / 2) + boundary + 1;
    }
    const chunk = normalized.slice(start, end).trim();
    if (chunk.length > 0) chunks.push(chunk);
    if (end >= normalized.length) break;
    start = Math.max(start + 1, end - CHUNK_OVERLAP);
  }
  return chunks;
}

export function toWorkspaceFtsQuery(query: string): string | null {
  const tokens = query
    .normalize("NFKC")
    .match(/[\p{L}\p{N}_-]+/gu)
    ?.map((token) => token.trim())
    .filter((token) => token.length > 0);
  if (!tokens || tokens.length === 0) return null;
  return [...new Set(tokens)]
    .slice(0, 12)
    .map((token) => `"${token.replaceAll('"', '""')}"`)
    .join(" OR ");
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const searchRows = SqlSchema.findAll({
    Request: RagSearchRequest,
    Result: RagSearchRow,
    execute: ({ projectId, ftsQuery, includeLongTermMemory, limit }) =>
      sql`
        SELECT
          project_id AS "projectId",
          item_id AS "itemId",
          kind,
          title,
          snippet(projection_workspace_rag_chunks, 5, '[', ']', '…', 32) AS snippet,
          -bm25(projection_workspace_rag_chunks, 0.0, 0.0, 0.0, 0.0, 2.0, 1.0, 0.0) AS score,
          updated_at AS "updatedAt"
        FROM projection_workspace_rag_chunks
        WHERE projection_workspace_rag_chunks MATCH ${ftsQuery}
          AND project_id = ${projectId}
          AND (${includeLongTermMemory ? 1 : 0} = 1 OR kind = 'rag-source')
        ORDER BY bm25(projection_workspace_rag_chunks, 0.0, 0.0, 0.0, 0.0, 2.0, 1.0, 0.0) ASC,
          updated_at DESC,
          item_id ASC,
          CAST(chunk_index AS INTEGER) ASC
        LIMIT ${limit}
      `,
  });

  const removeItem: ProjectionWorkspaceRagRepositoryShape["removeItem"] = (input) =>
    sql`
      DELETE FROM projection_workspace_rag_chunks
      WHERE project_id = ${input.projectId} AND item_id = ${input.itemId}
    `.pipe(
      Effect.asVoid,
      Effect.mapError(toPersistenceSqlError("ProjectionWorkspaceRag.removeItem")),
    );

  const removeConversationInputs: ProjectionWorkspaceRagRepositoryShape["removeConversationInputs"] =
    (input) =>
      sql`
        DELETE FROM projection_workspace_rag_chunks
        WHERE project_id = ${input.projectId}
          AND item_id LIKE ${(input.itemPrefix ?? "conversation-") + "%"}
          AND EXISTS (
            SELECT 1
            FROM projection_workspace_knowledge_items AS knowledge
            WHERE knowledge.project_id = projection_workspace_rag_chunks.project_id
              AND knowledge.item_id = projection_workspace_rag_chunks.item_id
              AND knowledge.tags_json LIKE '%"auto-conversation"%'
          )
      `.pipe(
        Effect.asVoid,
        Effect.mapError(toPersistenceSqlError("ProjectionWorkspaceRag.removeConversationInputs")),
      );

  const replaceItem: ProjectionWorkspaceRagRepositoryShape["replaceItem"] = (item) =>
    Effect.gen(function* () {
      yield* removeItem({ projectId: item.projectId, itemId: item.id });
      if (
        item.status !== "active" ||
        (item.kind !== "rag-source" && item.kind !== "long-term-memory")
      ) {
        return;
      }
      const chunks = chunkWorkspaceKnowledgeContent(item.content);
      yield* Effect.forEach(
        chunks,
        (content, chunkIndex) =>
          sql`
            INSERT INTO projection_workspace_rag_chunks (
              project_id, item_id, kind, chunk_index, title, content, updated_at
            ) VALUES (
              ${item.projectId}, ${item.id}, ${item.kind}, ${chunkIndex},
              ${item.title}, ${content}, ${item.updatedAt}
            )
          `,
        { concurrency: 1, discard: true },
      );
    }).pipe(Effect.mapError(toPersistenceSqlError("ProjectionWorkspaceRag.replaceItem")));

  const search: ProjectionWorkspaceRagRepositoryShape["search"] = (input) => {
    const ftsQuery = toWorkspaceFtsQuery(input.query);
    if (ftsQuery === null) return Effect.succeed({ matches: [] });
    return searchRows({
      projectId: input.projectId,
      ftsQuery,
      includeLongTermMemory: input.includeLongTermMemory !== false,
      limit: input.limit ?? 8,
    }).pipe(
      Effect.map((matches) => ({ matches })),
      Effect.mapError((cause) =>
        cause._tag === "SqlError"
          ? toPersistenceSqlError("ProjectionWorkspaceRag.search:query")(cause)
          : toPersistenceDecodeError("ProjectionWorkspaceRag.search:decodeRows")(cause),
      ),
    );
  };

  return ProjectionWorkspaceRagRepository.of({
    replaceItem,
    removeItem,
    removeConversationInputs,
    search,
  });
});

export const ProjectionWorkspaceRagRepositoryLive = Layer.effect(
  ProjectionWorkspaceRagRepository,
  make,
);
