import {
  WorkspaceRagMatch,
  WorkspaceResearchRecord,
  designReferenceText,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import * as HttpClient from "effect/unstable/http/HttpClient";

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
import { chunkAttachmentDocument } from "../../documents/extractDocument.ts";
import { makeSemanticSearch, reciprocalRankFusion } from "../../documents/semanticSearch.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { makeSemanticIndexJobs } from "../../documents/SemanticIndexJobs.ts";
import {
  makeOllamaEmbeddings,
  semanticSearchFailureMessage,
} from "../../documents/OllamaEmbeddings.ts";

/** Candidates read per requested match, so coverage re-ranking has room to work. */
const CANDIDATE_FACTOR = 5;
const MAX_CANDIDATES = 100;

const RagSearchRequest = Schema.Struct({
  projectId: Schema.String,
  match: Schema.NullOr(Schema.String),
  includeLongTermMemory: Schema.Boolean,
  includeShared: Schema.Boolean,
  attachmentsOnly: Schema.Boolean,
  contextPathsJson: Schema.String,
  excludedSourceKeysJson: Schema.String,
  limit: Schema.Int,
  afterRowId: Schema.Int,
  throughRowId: Schema.Int,
});
const RagCandidateRow = Schema.Struct({
  rowId: Schema.Int,
  scope: WorkspaceRagMatch.fields.scope,
  appliesToFolder: WorkspaceRagMatch.fields.appliesToFolder,
  projectId: WorkspaceRagMatch.fields.projectId,
  itemId: WorkspaceRagMatch.fields.itemId,
  kind: WorkspaceRagMatch.fields.kind,
  title: WorkspaceRagMatch.fields.title,
  content: Schema.String,
  tagsText: Schema.String,
  score: Schema.Number,
  updatedAt: WorkspaceRagMatch.fields.updatedAt,
  chunkId: Schema.String,
  research: Schema.NullOr(Schema.fromJsonString(WorkspaceResearchRecord)),
});

/** Kept for existing callers; the chunker now lives beside the analyzer. */
export const chunkWorkspaceKnowledgeContent = chunkSearchableContent;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const config = yield* Effect.serviceOption(ServerConfig);
  const settings = yield* Effect.serviceOption(ServerSettingsService);
  const http = yield* Effect.serviceOption(HttpClient.HttpClient);
  const clock = yield* Clock.Clock;
  const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
  const embed = Option.isSome(http) ? yield* makeOllamaEmbeddings(http.value) : undefined;
  const semanticSearch = makeSemanticSearch({
    now: () => clock.currentTimeMillisUnsafe(),
    embed: async ({ signal, ...input }) => {
      if (!embed) throw new Error("HTTP client unavailable");
      const result = await runPromise(embed(input).pipe(Effect.result), { signal });
      if (result._tag === "Failure") throw result.failure;
      return result.success;
    },
  });
  const indexJobs =
    Option.isSome(config) && Option.isSome(settings) && Option.isSome(http)
      ? yield* makeSemanticIndexJobs({
          stateDir: config.value.stateDir,
          vectors: semanticSearch,
          enabled: Effect.fn("ProjectionWorkspaceRag.indexingEnabled")(function* (job) {
            const current = yield* settings.value.getSettings.pipe(
              Effect.orElseSucceed(() => null),
            );
            return (
              current?.aiSearch.semanticEnabled === true &&
              new URL(current.aiSearch.embeddingEndpoint).origin === job.endpoint &&
              current.aiSearch.embeddingModel === job.model
            );
          }),
        })
      : undefined;
  const enqueueIndex = Effect.fn("ProjectionWorkspaceRag.enqueueIndex")(function* (
    projectId: string,
    changed = false,
  ) {
    if (!indexJobs || Option.isNone(settings)) return;
    const current = yield* settings.value.getSettings.pipe(Effect.orElseSucceed(() => null));
    if (current?.aiSearch.semanticEnabled)
      yield* indexJobs.enqueue(
        {
          projectId,
          endpoint: current.aiSearch.embeddingEndpoint,
          model: current.aiSearch.embeddingModel,
        },
        changed,
      );
  });

  // Only the analyzed search_* columns are indexed (see searchText.ts); the
  // weights favour a hit in the title over the tags over the body.
  const searchRows = SqlSchema.findAll({
    Request: RagSearchRequest,
    Result: RagCandidateRow,
    execute: ({
      projectId,
      match,
      includeLongTermMemory,
      includeShared,
      attachmentsOnly,
      contextPathsJson,
      excludedSourceKeysJson,
      limit,
      afterRowId,
      throughRowId,
    }) =>
      sql`
        SELECT
          rowid AS "rowId",
          project_id AS "projectId",
          scope,
          applies_to_folder AS "appliesToFolder",
          item_id AS "itemId",
          kind,
          title,
          content,
          tags_text AS "tagsText",
          ${
            match === null
              ? sql`0`
              : sql`-bm25(
            projection_workspace_rag_chunks,
            0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 3.0, 2.0, 1.0
          )`
          } AS score,
          updated_at AS "updatedAt",
          CAST(CAST(chunk_index AS INTEGER) AS TEXT) AS "chunkId",
          (SELECT knowledge.research_json FROM projection_workspace_knowledge_items AS knowledge
            WHERE knowledge.project_id = projection_workspace_rag_chunks.project_id
              AND knowledge.item_id = projection_workspace_rag_chunks.item_id) AS research
        FROM projection_workspace_rag_chunks
        WHERE ${match === null ? sql`1 = 1` : sql`projection_workspace_rag_chunks MATCH ${match}`}
          AND rowid > ${afterRowId} AND rowid <= ${throughRowId}
          AND (
            (scope = 'environment' AND (${includeShared ? 1 : 0} = 1 OR project_id = ${projectId}))
            OR (project_id = ${projectId} AND scope = 'project' AND json_array_length(${contextPathsJson}) = 0)
            OR (project_id = ${projectId} AND scope = 'folder' AND EXISTS (
              SELECT 1 FROM json_each(${contextPathsJson}) AS context
              WHERE context.value = applies_to_folder
                OR substr(context.value, 1, length(applies_to_folder) + 1) = applies_to_folder || '/'
            ))
          )
          AND (${includeLongTermMemory ? 1 : 0} = 1 OR kind = 'rag-source')
          AND (${attachmentsOnly ? 1 : 0} = 0 OR instr(tags_text, 'attachment-document') > 0)
          AND json_array(project_id,item_id) NOT IN (SELECT value FROM json_each(${excludedSourceKeysJson}))
        ORDER BY ${
          match === null
            ? sql`rowid ASC`
            : sql`bm25(
            projection_workspace_rag_chunks,
            0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 3.0, 2.0, 1.0
          ) ASC`
        },
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
      Effect.tap(
        () =>
          sql`DELETE FROM workspace_semantic_vector_refs WHERE project_id=${input.projectId} AND item_id=${input.itemId}`,
      ),
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
        Effect.tap(
          () => sql`DELETE FROM workspace_semantic_vector_refs WHERE project_id=${input.projectId}
          AND NOT EXISTS(SELECT 1 FROM projection_workspace_rag_chunks c WHERE c.project_id=${input.projectId}
            AND c.rowid=source_rowid AND c.item_id=workspace_semantic_vector_refs.item_id)`,
        ),
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
      const content = item.research?.design
        ? `${item.content}\n\n${designReferenceText(item.research.design)}`
        : item.content;
      const locations = item.research?.attachment?.locations;
      const chunks = analyzeChunks({
        title: item.title,
        content,
        tags: item.tags,
        ...(locations ? { chunks: chunkAttachmentDocument(content, locations) } : {}),
      });
      yield* Effect.forEach(
        chunks,
        (chunk) =>
          sql`
            INSERT INTO projection_workspace_rag_chunks (
              project_id, item_id, kind, chunk_index, title, content, updated_at,
              tags_text, search_title, search_tags, search_body
              , scope, applies_to_folder
            ) VALUES (
              ${item.projectId}, ${item.id}, ${item.kind}, ${chunk.chunkIndex}, ${item.title},
              ${chunk.content}, ${item.updatedAt}, ${chunk.tagsText}, ${chunk.searchTitle},
              ${chunk.searchTags}, ${chunk.searchBody}
              , ${item.scope ?? "project"}, ${item.appliesToFolder ?? null}
            )
          `,
        { concurrency: 1, discard: true },
      );
      yield* enqueueIndex(item.projectId, true);
    }).pipe(Effect.mapError(toPersistenceSqlError("ProjectionWorkspaceRag.replaceItem")));

  const search: ProjectionWorkspaceRagRepositoryShape["search"] = (input) => {
    const query = buildSearchQuery(input.query);
    if (query === null) return Effect.succeed({ matches: [] });
    const limit = input.limit ?? 8;
    const request = {
      projectId: input.projectId,
      match: query.match,
      includeLongTermMemory: input.includeLongTermMemory !== false,
      includeShared: input.includeShared === true,
      attachmentsOnly: input.attachmentsOnly === true,
      contextPathsJson: JSON.stringify(
        (input.contextPaths ?? []).map((path) => path.replaceAll("\\", "/")),
      ),
      excludedSourceKeysJson: JSON.stringify(input.excludedSourceKeys ?? []),
      limit: Math.min(limit * CANDIDATE_FACTOR, MAX_CANDIDATES),
      afterRowId: 0,
      throughRowId: Number.MAX_SAFE_INTEGER,
    };
    return searchRows(request).pipe(
      Effect.flatMap(
        Effect.fn("ProjectionWorkspaceRag.rank")(function* (rows) {
          // Preserve the legacy one-chunk default. Explicit multi-chunk callers
          // retain distinct evidence from one source within the same total cap.
          let ranked = rows
            .map((row) => {
              const coverage = termCoverage(
                query.terms,
                `${row.title} ${row.tagsText} ${row.content}`,
              );
              const rank = row.score * (1 + coverage);
              return { row, rank };
            })
            .toSorted(
              (left, right) =>
                right.rank - left.rank ||
                right.row.updatedAt.localeCompare(left.row.updatedAt) ||
                left.row.itemId.localeCompare(right.row.itemId) ||
                Number(left.row.chunkId) - Number(right.row.chunkId),
            );
          let retrieval:
            | {
                method: "keyword" | "hybrid";
                indexedChunks: number;
                totalChunks: number;
                message: string | null;
              }
            | undefined;
          const semanticSimilarities = new Map<string, number>();
          const preferences = Option.isSome(settings)
            ? yield* settings.value.getSettings.pipe(Effect.orElseSucceed(() => null))
            : null;
          if (
            preferences?.aiSearch.semanticEnabled &&
            Option.isSome(config) &&
            Option.isSome(http)
          ) {
            const [boundary] = yield* sql<{
              last: number | null;
            }>`SELECT max(rowid) AS last FROM projection_workspace_rag_chunks`;
            const runReadPage = Effect.runPromiseWith(yield* Effect.context<never>());
            const rowKey = (row: typeof RagCandidateRow.Type) =>
              JSON.stringify([row.projectId, row.itemId, row.chunkId]);
            const candidatePages = async function* (signal: AbortSignal) {
              let afterRowId = 0;
              while (true) {
                const page = await runReadPage(
                  searchRows({
                    ...request,
                    match: null,
                    limit: 64,
                    afterRowId,
                    throughRowId: boundary?.last ?? 0,
                  }),
                  { signal },
                );
                if (!page.length) break;
                yield page.map((row) => ({ ...row, id: rowKey(row) }));
                afterRowId = page.at(-1)!.rowId;
              }
            };
            const semantic = yield* Effect.tryPromise({
              try: (signal) =>
                semanticSearch({
                  stateDir: config.value.stateDir,
                  projectId: input.projectId,
                  endpoint: preferences.aiSearch.embeddingEndpoint,
                  model: preferences.aiSearch.embeddingModel,
                  query: input.query,
                  candidatePages,
                  maxChunksPerItem: input.maxChunksPerItem ?? 1,
                  missing: async (projects) => {
                    for (const projectId of projects)
                      await runReadPage(enqueueIndex(projectId), { signal });
                  },
                  signal,
                }),
              catch: semanticSearchFailureMessage,
            }).pipe(Effect.result);
            if (semantic._tag === "Success") {
              for (const entry of semantic.success.ranked)
                semanticSimilarities.set(entry.id, entry.similarity);
              const byKey = new Map(
                [...semantic.success.candidates, ...rows].map((row) => [rowKey(row), row]),
              );
              ranked = reciprocalRankFusion(
                ranked.map(({ row }) => rowKey(row)),
                semantic.success.ranked,
              ).map(([key, rank]) => ({ row: byKey.get(key)!, rank }));
              retrieval = {
                method: semantic.success.indexed > 0 ? "hybrid" : "keyword",
                indexedChunks: semantic.success.indexed,
                totalChunks: semantic.success.total,
                message: semantic.success.interrupted
                  ? "일부 의미 색인을 준비하지 못했습니다. 기존 색인과 키워드 검색을 사용합니다."
                  : semantic.success.indexed < semantic.success.total
                    ? "일부 의미 색인을 준비 중입니다. 키워드 검색을 함께 사용합니다."
                    : null,
              };
              if (indexJobs && semantic.success.indexed < semantic.success.total) {
                const indexing = yield* indexJobs.status({
                  projectId: input.projectId,
                  endpoint: preferences.aiSearch.embeddingEndpoint,
                  model: preferences.aiSearch.embeddingModel,
                });
                if (indexing.failures > 0)
                  retrieval.message =
                    indexing.failureMessage ??
                    "로컬 임베딩 작업이 실패해 재시도를 기다립니다. 기존 색인과 키워드 검색을 사용합니다. Ollama와 임베딩 모델을 확인하세요.";
              }
            } else
              retrieval = {
                method: "keyword",
                indexedChunks: 0,
                totalChunks: 0,
                message: semantic.failure,
              };
          }
          const counts = new Map<string, number>();
          const selected = ranked.filter(({ row }) => {
            const key = JSON.stringify([row.projectId, row.itemId]);
            const count = counts.get(key) ?? 0;
            if (count >= (input.maxChunksPerItem ?? 1)) return false;
            counts.set(key, count + 1);
            return true;
          });
          return {
            ...(retrieval ? { retrieval } : {}),
            matches: selected.slice(0, limit).map(({ row, rank }) => ({
              projectId: row.projectId,
              scope: row.scope ?? "project",
              appliesToFolder: row.appliesToFolder ?? null,
              itemId: row.itemId,
              kind: row.kind,
              title: row.title,
              snippet: makeSnippet(row.content, query.terms),
              content: row.content,
              score: rank,
              ...(semanticSimilarities.has(JSON.stringify([row.projectId, row.itemId, row.chunkId]))
                ? {
                    semanticSimilarity: semanticSimilarities.get(
                      JSON.stringify([row.projectId, row.itemId, row.chunkId]),
                    )!,
                  }
                : {}),
              updatedAt: row.updatedAt,
              chunkId: row.chunkId,
              research: row.research?.attachment
                ? {
                    ...row.research,
                    attachment: (() => {
                      const { locations: _locations, ...attachment } = row.research!.attachment!;
                      return {
                        ...attachment,
                        location: row.content.split("\n")[0]?.replace(/^\[|\]$/g, "") ?? "",
                      };
                    })(),
                  }
                : row.research,
            })),
          };
        }),
      ),
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
    ...(indexJobs
      ? {
          drainSemanticIndex: indexJobs.drain.pipe(
            Effect.mapError(toPersistenceSqlError("ProjectionWorkspaceRag.drainSemanticIndex")),
          ),
        }
      : {}),
  });
});

export const ProjectionWorkspaceRagRepositoryLive = Layer.effect(
  ProjectionWorkspaceRagRepository,
  make,
);
