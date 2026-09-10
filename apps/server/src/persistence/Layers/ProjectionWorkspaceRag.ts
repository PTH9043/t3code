import { WorkspaceRagMatch } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceDecodeError, toPersistenceSqlError } from "../Errors.ts";
import {
  analyzeChunks,
  buildSearchQuery,
  chunkSearchableContent,
  makeSnippet,
  termCoverage,
} from "../searchText.ts";
import {
  ProjectionWorkspaceRagRepository,
  type ProjectionWorkspaceRagRepositoryShape,
} from "../Services/ProjectionWorkspaceRag.ts";

/** Candidates read per requested match, so coverage re-ranking has room to work. */
const CANDIDATE_FACTOR = 5;
const MAX_CANDIDATES = 100;

const RagSearchRequest = Schema.Struct({
  projectId: Schema.String,
  match: Schema.String,
  includeLongTermMemory: Schema.Boolean,
  limit: Schema.Int,
});
const RagCandidateRow = Schema.Struct({
  projectId: WorkspaceRagMatch.fields.projectId,
  itemId: WorkspaceRagMatch.fields.itemId,
  kind: WorkspaceRagMatch.fields.kind,
  title: WorkspaceRagMatch.fields.title,
  content: Schema.String,
  tagsText: Schema.String,
  score: Schema.Number,
  updatedAt: WorkspaceRagMatch.fields.updatedAt,
});

/** Kept for existing callers; the chunker now lives beside the analyzer. */
export const chunkWorkspaceKnowledgeContent = chunkSearchableContent;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Only the analyzed search_* columns are indexed (see searchText.ts); the
  // weights favour a hit in the title over the tags over the body.
  const searchRows = SqlSchema.findAll({
    Request: RagSearchRequest,
    Result: RagCandidateRow,
    execute: ({ projectId, match, includeLongTermMemory, limit }) =>
      sql`
        SELECT
          project_id AS "projectId",
          item_id AS "itemId",
          kind,
          title,
          content,
          tags_text AS "tagsText",
          -bm25(
            projection_workspace_rag_chunks,
            0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 3.0, 2.0, 1.0
          ) AS score,
          updated_at AS "updatedAt"
        FROM projection_workspace_rag_chunks
        WHERE projection_workspace_rag_chunks MATCH ${match}
          AND project_id = ${projectId}
          AND (${includeLongTermMemory ? 1 : 0} = 1 OR kind = 'rag-source')
        ORDER BY bm25(
            projection_workspace_rag_chunks,
            0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 3.0, 2.0, 1.0
          ) ASC,
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
      const chunks = analyzeChunks({ title: item.title, content: item.content, tags: item.tags });
      yield* Effect.forEach(
        chunks,
        (chunk) =>
          sql`
            INSERT INTO projection_workspace_rag_chunks (
              project_id, item_id, kind, chunk_index, title, content, updated_at,
              tags_text, search_title, search_tags, search_body
            ) VALUES (
              ${item.projectId}, ${item.id}, ${item.kind}, ${chunk.chunkIndex}, ${item.title},
              ${chunk.content}, ${item.updatedAt}, ${chunk.tagsText}, ${chunk.searchTitle},
              ${chunk.searchTags}, ${chunk.searchBody}
            )
          `,
        { concurrency: 1, discard: true },
      );
    }).pipe(Effect.mapError(toPersistenceSqlError("ProjectionWorkspaceRag.replaceItem")));

  const search: ProjectionWorkspaceRagRepositoryShape["search"] = (input) => {
    const query = buildSearchQuery(input.query);
    if (query === null) return Effect.succeed({ matches: [] });
    const limit = input.limit ?? 8;
    return searchRows({
      projectId: input.projectId,
      match: query.match,
      includeLongTermMemory: input.includeLongTermMemory !== false,
      limit: Math.min(limit * CANDIDATE_FACTOR, MAX_CANDIDATES),
    }).pipe(
      Effect.map((rows) => {
        // One match per item — its best chunk — ranked by BM25 scaled by how
        // many distinct query terms the chunk covers.
        const best = new Map<
          string,
          { readonly row: (typeof rows)[number]; readonly rank: number }
        >();
        for (const row of rows) {
          const coverage = termCoverage(query.terms, `${row.title} ${row.tagsText} ${row.content}`);
          const rank = row.score * (1 + coverage);
          const current = best.get(row.itemId);
          if (current === undefined || rank > current.rank) best.set(row.itemId, { row, rank });
        }
        return {
          matches: [...best.values()]
            .toSorted(
              (left, right) =>
                right.rank - left.rank || right.row.updatedAt.localeCompare(left.row.updatedAt),
            )
            .slice(0, limit)
            .map(({ row, rank }) => ({
              projectId: row.projectId,
              itemId: row.itemId,
              kind: row.kind,
              title: row.title,
              snippet: makeSnippet(row.content, query.terms),
              content: row.content,
              score: rank,
              updatedAt: row.updatedAt,
            })),
        };
      }),
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
