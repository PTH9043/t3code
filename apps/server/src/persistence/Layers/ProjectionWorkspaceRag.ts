import {
  WorkspaceRagMatch,
  WorkspaceResearchRecord,
  designReferenceText,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import { visibleKnowledge } from "../knowledgeVisibility.ts";
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
  scoreQueryDocumentInteraction,
  termCoverage,
} from "../searchText.ts";
import {
  ProjectionWorkspaceRagRepository,
  type ProjectionWorkspaceRagRepositoryShape,
} from "../Services/ProjectionWorkspaceRag.ts";
import { labelPdfRevisionHits } from "../../documents/pdfRevisionStore.ts";
import { chunkAttachmentDocument } from "../../documents/extractDocument.ts";
import {
  buildRagSemanticEnvelope,
  formatProviderEmbeddingEndpoint,
  getEmbeddingModelMultilingualAdvisory,
  makeSemanticSearch,
  normalizeSemanticEndpoint,
  reciprocalRankFusion,
} from "../../documents/semanticSearch.ts";
import { buildTemporalIndexTail } from "../../orchestration/koreanTemporalParser.ts";
import { extractMemoryEntities } from "../../orchestration/memoryConsolidatorV3.ts";
import {
  ROUTING_NODE_KIND,
  indexTextArtifactIntoRoutingGraph,
  removeRoutingNodeByCanonicalKey,
} from "../../orchestration/workspaceRoutingGraph.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { makeSemanticIndexJobs } from "../../documents/SemanticIndexJobs.ts";
import {
  makeOllamaEmbeddings,
  semanticSearchFailureMessage,
} from "../../documents/OllamaEmbeddings.ts";
import {
  SEMANTIC_RERANK_MAX_CANDIDATES,
  makeSemanticLlmReranker,
} from "../../documents/RegisteredSemanticModels.ts";

/** Candidates read per requested match, so RRF fusion and Cross-Interaction reranking have an over-retrieved pool. */
const CANDIDATE_FACTOR = 10;
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
  const readSettings = Option.isSome(settings)
    ? () => settings.value.getSettings.pipe(Effect.orElseSucceed(() => null))
    : () => Effect.succeed(null);
  const resolveSemanticTarget = (aiSearch: {
    readonly embeddingEndpoint: string;
    readonly embeddingInstanceId?: string | null | undefined;
    readonly embeddingMode?: "embedding" | "rerank" | undefined;
    readonly embeddingModel: string;
  }) => {
    const mode = aiSearch.embeddingMode ?? "embedding";
    const instanceId = aiSearch.embeddingInstanceId ?? null;
    const endpoint = instanceId
      ? formatProviderEmbeddingEndpoint(instanceId)
      : aiSearch.embeddingEndpoint;
    return { mode, instanceId, endpoint, model: aiSearch.embeddingModel };
  };
  const embed = Option.isSome(http)
    ? yield* makeOllamaEmbeddings(http.value, readSettings)
    : undefined;
  const rerank = Option.isSome(http)
    ? yield* makeSemanticLlmReranker(http.value, readSettings)
    : undefined;
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
            if (current?.aiSearch.semanticEnabled !== true) return false;
            const target = resolveSemanticTarget(current.aiSearch);
            if (target.mode !== "embedding") return false;
            try {
              return (
                normalizeSemanticEndpoint(target.endpoint) === job.endpoint &&
                target.model === job.model
              );
            } catch {
              return false;
            }
          }),
        })
      : undefined;
  const enqueueIndex = Effect.fn("ProjectionWorkspaceRag.enqueueIndex")(function* (
    projectId: string,
    changed = false,
  ) {
    if (!indexJobs || Option.isNone(settings)) return;
    const current = yield* settings.value.getSettings.pipe(Effect.orElseSucceed(() => null));
    if (!current?.aiSearch.semanticEnabled) return;
    const target = resolveSemanticTarget(current.aiSearch);
    if (target.mode !== "embedding") return;
    yield* indexJobs.enqueue(
      {
        projectId,
        endpoint: target.endpoint,
        model: target.model,
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
          AND NOT EXISTS (
            SELECT 1 FROM projection_workspace_knowledge_items
            WHERE project_id=projection_workspace_rag_chunks.project_id AND item_id=projection_workspace_rag_chunks.item_id
              AND source_item_id IS NOT NULL AND NOT ${visibleKnowledge(sql)}
          )
          AND NOT EXISTS (
            SELECT 1 FROM projection_workspace_knowledge_items AS merged
            WHERE merged.project_id = projection_workspace_rag_chunks.project_id
              AND merged.item_id = projection_workspace_rag_chunks.item_id AND merged.superseded_by IS NOT NULL
          )
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
          AND (
            item_id NOT LIKE 'conversation-%' OR instr(tags_text, 'auto-conversation') = 0
            OR NOT EXISTS (
              SELECT 1 FROM workspace_memory_v2 forgotten
              WHERE forgotten.project_id = projection_workspace_rag_chunks.project_id
                AND forgotten.status = 'forgotten'
                AND CASE WHEN json_valid(forgotten.source_json)
                  THEN json_extract(forgotten.source_json, '$.kind') END = 'message'
            )
            OR EXISTS (
              SELECT 1 FROM workspace_conversation_rag_sources source
              WHERE source.project_id = projection_workspace_rag_chunks.project_id
                AND source.item_id = projection_workspace_rag_chunks.item_id
                AND (source.source_kind <> 'message' OR (
                  EXISTS (SELECT 1 FROM projection_thread_messages message
                    JOIN projection_threads thread ON thread.thread_id = message.thread_id
                    WHERE message.message_id = source.source_id AND message.thread_id = source.thread_id
                      AND thread.project_id = source.project_id AND thread.deleted_at IS NULL)
                  AND NOT EXISTS (
                    SELECT 1 FROM workspace_memory_v2 forgotten
                    WHERE forgotten.project_id = source.project_id AND forgotten.status = 'forgotten'
                      AND CASE WHEN json_valid(forgotten.source_json)
                        AND json_extract(forgotten.source_json, '$.kind') = 'message'
                        THEN json_extract(forgotten.source_json, '$.id') END = source.source_id
                  )
                ))
            )
          )
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
      Effect.tap(() =>
        removeRoutingNodeByCanonicalKey(sql, {
          projectId: input.projectId,
          canonicalKey: `knowledge:${input.itemId}`,
        }).pipe(Effect.ignore),
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
      const pdfBatch = item.tags.includes("pdf-page-batch");
      const updatedMs = Date.parse(item.updatedAt);
      const temporalTail = buildTemporalIndexTail(
        content,
        Number.isFinite(updatedMs) ? updatedMs : clock.currentTimeMillisUnsafe(),
      );
      const entityTail = extractMemoryEntities(content, item.title).join(" ");
      const folderLabel = item.appliesToFolder ?? item.relativeFolder ?? "";
      const deterministicContextSummary = [
        folderLabel ? `폴더:${folderLabel}` : "",
        `출처:${item.origin}`,
        temporalTail,
        entityTail,
      ]
        .filter(Boolean)
        .join(" ");
      const chunks = analyzeChunks({
        title: item.title,
        content,
        tags: pdfBatch ? [] : item.tags,
        contextSummary: deterministicContextSummary,
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
              ${chunk.content}, ${item.updatedAt}, ${pdfBatch ? item.tags.join(" ") : chunk.tagsText}, ${chunk.searchTitle},
              ${chunk.searchTags}, ${chunk.searchBody}
              , ${item.scope ?? "project"}, ${item.appliesToFolder ?? null}
            )
          `,
        { concurrency: 1, discard: true },
      );
      yield* indexTextArtifactIntoRoutingGraph(sql, {
        projectId: item.projectId,
        nodeKind: ROUTING_NODE_KIND.MEMORY_FACT,
        canonicalKey: `knowledge:${item.id}`,
        title: item.title || item.id,
        summaryMoc: content.slice(0, 220),
        bodyMarkdown: content.slice(0, 4_000),
        bodyRefKind: "knowledge",
        bodyRefId: item.id,
        epistemicState: "fact",
        keywords: item.tags,
        updatedAtMs: Number.isFinite(updatedMs) ? updatedMs : clock.currentTimeMillisUnsafe(),
      }).pipe(Effect.ignore);
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
    const rankedResult = searchRows(request).pipe(
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
              const interaction = scoreQueryDocumentInteraction({
                query: input.query,
                terms: query.terms,
                title: row.title,
                tagsText: row.tagsText,
                content: row.content,
              });
              const rank = row.score * (1 + coverage + interaction);
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
            const semanticTarget = resolveSemanticTarget(preferences.aiSearch);
            const [boundary] = yield* sql<{
              last: number | null;
            }>`SELECT max(rowid) AS last FROM projection_workspace_rag_chunks`;
            const rowKey = (row: typeof RagCandidateRow.Type) =>
              JSON.stringify([row.projectId, row.itemId, row.chunkId]);

            if (semanticTarget.mode === "rerank" && rerank) {
              const poolByKey = new Map<string, typeof RagCandidateRow.Type>();
              for (const entry of ranked.slice(0, SEMANTIC_RERANK_MAX_CANDIDATES)) {
                poolByKey.set(rowKey(entry.row), entry.row);
              }
              if (poolByKey.size < SEMANTIC_RERANK_MAX_CANDIDATES) {
                const supplemental = yield* searchRows({
                  ...request,
                  match: null,
                  limit: SEMANTIC_RERANK_MAX_CANDIDATES * 2,
                  afterRowId: 0,
                  throughRowId: boundary?.last ?? 0,
                });
                for (const row of supplemental) {
                  if (poolByKey.size >= SEMANTIC_RERANK_MAX_CANDIDATES) break;
                  const key = rowKey(row);
                  if (!poolByKey.has(key)) poolByKey.set(key, row);
                }
              }
              const rerankPool = [...poolByKey.entries()].map(([id, row]) => ({
                id,
                title: row.title,
                content: row.content,
              }));
              if (rerankPool.length === 0) {
                retrieval = {
                  method: "keyword",
                  indexedChunks: 0,
                  totalChunks: 0,
                  message: null,
                };
              } else {
                const reranked = yield* rerank({
                  instanceId: preferences.aiSearch.embeddingInstanceId ?? null,
                  endpoint: preferences.aiSearch.embeddingEndpoint,
                  model: semanticTarget.model,
                  query: input.query,
                  candidates: rerankPool,
                }).pipe(Effect.result);
                if (reranked._tag === "Success") {
                  for (const entry of reranked.success) {
                    semanticSimilarities.set(entry.id, entry.similarity);
                  }
                  const byKey = new Map(
                    [...poolByKey.values(), ...rows].map((row) => [rowKey(row), row]),
                  );
                  ranked = reciprocalRankFusion(
                    ranked.map(({ row }) => rowKey(row)),
                    reranked.success,
                  )
                    .map(([key, rrfScore]) => {
                      const row = byKey.get(key)!;
                      const interaction = scoreQueryDocumentInteraction({
                        query: input.query,
                        terms: query.terms,
                        title: row.title,
                        tagsText: row.tagsText,
                        content: row.content,
                      });
                      const rank = rrfScore * (1 + 0.35 * interaction) + 0.005 * interaction;
                      return { row, rank };
                    })
                    .toSorted(
                      (left, right) =>
                        right.rank - left.rank ||
                        right.row.updatedAt.localeCompare(left.row.updatedAt) ||
                        left.row.itemId.localeCompare(right.row.itemId) ||
                        Number(left.row.chunkId) - Number(right.row.chunkId),
                    );
                  retrieval = {
                    method: "hybrid",
                    indexedChunks: rerankPool.length,
                    totalChunks: rerankPool.length,
                    message: null,
                  };
                } else {
                  retrieval = {
                    method: "keyword",
                    indexedChunks: 0,
                    totalChunks: 0,
                    message: semanticSearchFailureMessage(reranked.failure),
                  };
                }
              }
            } else {
              const runReadPage = Effect.runPromiseWith(yield* Effect.context<never>());
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
                  yield page.map((row) => ({
                    ...row,
                    ...buildRagSemanticEnvelope(row),
                    id: rowKey(row),
                  }));
                  afterRowId = page.at(-1)!.rowId;
                }
              };
              const semantic = yield* Effect.tryPromise({
                try: (signal) =>
                  semanticSearch({
                    stateDir: config.value.stateDir,
                    projectId: input.projectId,
                    endpoint: semanticTarget.endpoint,
                    model: semanticTarget.model,
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
                )
                  .map(([key, rrfScore]) => {
                    const row = byKey.get(key)!;
                    const interaction = scoreQueryDocumentInteraction({
                      query: input.query,
                      terms: query.terms,
                      title: row.title,
                      tagsText: row.tagsText,
                      content: row.content,
                    });
                    const rank = rrfScore * (1 + 0.35 * interaction) + 0.005 * interaction;
                    return { row, rank };
                  })
                  .toSorted(
                    (left, right) =>
                      right.rank - left.rank ||
                      right.row.updatedAt.localeCompare(left.row.updatedAt) ||
                      left.row.itemId.localeCompare(right.row.itemId) ||
                      Number(left.row.chunkId) - Number(right.row.chunkId),
                  );
                retrieval = {
                  method: semantic.success.indexed > 0 ? "hybrid" : "keyword",
                  indexedChunks: semantic.success.indexed,
                  totalChunks: semantic.success.total,
                  message: semantic.success.interrupted
                    ? "일부 의미 색인을 준비하지 못했습니다. 기존 색인과 키워드 검색을 사용합니다."
                    : semantic.success.indexed < semantic.success.total
                      ? "일부 의미 색인을 준비 중입니다. 키워드 검색을 함께 사용합니다."
                      : getEmbeddingModelMultilingualAdvisory(semanticTarget.model),
                };
                if (indexJobs && semantic.success.indexed < semantic.success.total) {
                  const indexing = yield* indexJobs.status({
                    projectId: input.projectId,
                    endpoint: semanticTarget.endpoint,
                    model: semanticTarget.model,
                  });
                  if (indexing.failures > 0)
                    retrieval.message =
                      indexing.failureMessage ??
                      "임베딩 작업이 실패해 재시도를 기다립니다. 기존 색인과 키워드 검색을 사용합니다. 선택한 제공자와 모델을 확인하세요.";
                }
              } else
                retrieval = {
                  method: "keyword",
                  indexedChunks: 0,
                  totalChunks: 0,
                  message: semantic.failure,
                };
            }
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
    // Keyword and semantic candidates are read separately. An explicit PDF
    // publication between those reads must never combine two editions.
    const generation = sql<{
      generation: number;
    }>`SELECT generation FROM pdf_revision_epoch WHERE id=1`.pipe(
      Effect.map((rows) => rows[0]!.generation),
      Effect.mapError(toPersistenceSqlError("ProjectionWorkspaceRag.publicationGeneration")),
    );
    const recordRetrievedUsage = (matches: ReadonlyArray<WorkspaceRagMatch>) => {
      if (matches.length === 0) return Effect.void;
      const byProject = new Map<string, Set<string>>();
      for (const match of matches) {
        let ids = byProject.get(match.projectId);
        if (!ids) {
          ids = new Set<string>();
          byProject.set(match.projectId, ids);
        }
        ids.add(match.itemId);
      }
      const usedAt = DateTime.formatIso(DateTime.makeUnsafe(clock.currentTimeMillisUnsafe()));
      return Effect.forEach(
        Array.from(byProject.entries()),
        ([projectId, itemIdSet]) => {
          const itemIds = Array.from(itemIdSet);
          if (itemIds.length === 0) return Effect.void;
          return sql`
            UPDATE projection_workspace_knowledge_items
            SET
              prompt_uses = prompt_uses + 1,
              last_used_at = CASE
                WHEN last_used_at IS NULL OR last_used_at < ${usedAt} THEN ${usedAt}
                ELSE last_used_at
              END
            WHERE project_id = ${projectId}
              AND item_id IN ${sql.in(itemIds)}
          `.pipe(Effect.asVoid);
        },
        { concurrency: 1, discard: true },
      ).pipe(
        // Best-effort telemetry: usage tracking must never break RAG retrieval.
        Effect.catchCause((cause) =>
          Effect.logWarning("ProjectionWorkspaceRag.recordRetrievedUsage failed", { cause }),
        ),
      );
    };
    return Effect.gen(function* () {
      let before = yield* generation;
      while (true) {
        const result = yield* rankedResult;
        const hasAttachment = result.matches.some((match) => match.research?.attachment);
        if (!hasAttachment && result.retrieval?.method !== "hybrid") {
          yield* recordRetrievedUsage(result.matches);
          return result;
        }
        const matches = hasAttachment
          ? yield* labelPdfRevisionHits(sql, result.matches).pipe(
              Effect.mapError(toPersistenceSqlError("ProjectionWorkspaceRag.pdfRevision")),
            )
          : result.matches;
        const after = yield* generation;
        if (after === before) {
          yield* recordRetrievedUsage(matches);
          return { ...result, matches };
        }
        before = after;
      }
    });
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
