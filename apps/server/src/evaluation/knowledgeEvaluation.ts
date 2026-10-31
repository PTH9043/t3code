import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ProjectionWorkspaceKnowledgeRepository } from "../persistence/Services/ProjectionWorkspaceKnowledge.ts";
import { ProjectionWorkspaceRagRepository } from "../persistence/Services/ProjectionWorkspaceRag.ts";
import { composeWorkspacePrompt } from "../orchestration/workspacePrompt.ts";
import { excludedRagSourceKeys } from "../orchestration/workspaceKnowledgeSelection.ts";
import { workspaceRetrievalQuery } from "../orchestration/workspaceSearchVocabulary.ts";
import type { WorkspaceTokenCounter } from "../orchestration/workspacePromptTokens.ts";
import {
  EVALUATION_NOW,
  KNOWLEDGE_DATASET_VERSION,
  type KnowledgeCase,
} from "./knowledgeDataset.ts";

const percentile = (values: readonly number[], fraction: number) => {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
};
export const evaluateKnowledge = Effect.fn("evaluateKnowledge")(function* (
  cases: readonly KnowledgeCase[],
  counter: WorkspaceTokenCounter,
  implementation: {
    readonly compose: typeof composeWorkspacePrompt;
    readonly exclusions: typeof excludedRagSourceKeys;
    readonly retrievalQuery: typeof workspaceRetrievalQuery;
  } = {
    compose: composeWorkspacePrompt,
    exclusions: excludedRagSourceKeys,
    retrievalQuery: workspaceRetrievalQuery,
  },
) {
  const knowledge = yield* ProjectionWorkspaceKnowledgeRepository;
  const rag = yield* ProjectionWorkspaceRagRepository;
  const sql = yield* SqlClient.SqlClient;
  const now = Date.parse(EVALUATION_NOW);
  for (const projectId of new Set(
    cases.flatMap((entry) => entry.items.map((item) => item.projectId)),
  )) {
    yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,default_model_selection_json,scripts_json,workspace_control_json,created_at,updated_at,deleted_at)
      VALUES (${projectId},${projectId},'fixture-only',NULL,'[]','{"isolationMode":"strict","longTermMemoryRoot":null}',${EVALUATION_NOW},${EVALUATION_NOW},NULL)`;
  }
  for (const entry of cases)
    for (const item of entry.items) {
      yield* knowledge.upsert(item);
      yield* rag.replaceItem(item);
    }
  // Worker completion, not a timed sleep, establishes the same indexed starting state.
  if (rag.drainSemanticIndex) yield* rag.drainSemanticIndex;
  const evaluateCase = Effect.fn("evaluateKnowledge.case")(function* (entry: KnowledgeCase) {
    const started = performance.now();
    const retrieved = yield* rag.search({
      projectId: entry.request.projectId,
      query: implementation.retrievalQuery(entry.request.task),
      limit: 5,
      includeShared: entry.request.includeShared ?? false,
      contextPaths: entry.request.contextPaths ?? [],
      maxChunksPerItem: entry.request.maxChunksPerItem ?? 1,
      excludedSourceKeys: implementation.exclusions(entry.items, entry.request, now),
    });
    const composed = implementation.compose({
      now,
      request: entry.request,
      items: entry.items,
      ragMatches: retrieved.matches,
      tokenCounter: counter,
    });
    const elapsedMs = performance.now() - started;
    const retrievedIds = [...new Set(retrieved.matches.map((match) => String(match.itemId)))];
    const selectedIds = composed.sourceItemIds.map(String);
    const missing = entry.expected.filter((id) => !selectedIds.includes(id));
    const forbidden = entry.forbidden.filter(
      (id) => retrievedIds.includes(id) || selectedIds.includes(id),
    );
    const missingEvidence = (entry.evidenceText ?? []).filter(
      (text) => !composed.prompt.includes(text),
    );
    const sourceIds = new Set(entry.items.map((item) => JSON.stringify([item.projectId, item.id])));
    const orphanReferences = (composed.sourceReferences ?? []).filter(
      (ref) => !sourceIds.has(JSON.stringify([ref.projectId, ref.itemId])),
    ).length;
    const rank = retrievedIds.findIndex((id) => entry.expected.includes(id));
    return {
      id: entry.id,
      category: entry.category,
      split: entry.split,
      method: retrieved.retrieval?.method ?? "keyword",
      indexedChunks: retrieved.retrieval?.indexedChunks ?? 0,
      totalChunks: retrieved.retrieval?.totalChunks ?? 0,
      retrieved: retrievedIds,
      selected: selectedIds,
      missing,
      forbidden,
      missingEvidence,
      orphanReferences,
      pass:
        missing.length === 0 &&
        forbidden.length === 0 &&
        missingEvidence.length === 0 &&
        orphanReferences === 0,
      recallAt5: entry.expected.length
        ? entry.expected.filter((id) => retrievedIds.includes(id)).length / entry.expected.length
        : 1,
      reciprocalRank: rank < 0 ? 0 : 1 / (rank + 1),
      elapsedMs,
      inputTokens: composed.tokenEstimate?.total ?? counter(composed.prompt),
    };
  });
  const cold = yield* Effect.forEach(cases, evaluateCase, { concurrency: 1 });
  const warm = yield* Effect.forEach(cases, evaluateCase, { concurrency: 1 });
  const summarize = (rows: typeof warm) => ({
    cases: rows.length,
    passed: rows.filter((row) => row.pass).length,
    evidencePassRate: rows.length ? rows.filter((row) => row.pass).length / rows.length : 0,
    recallAt5: rows.reduce((sum, row) => sum + row.recallAt5, 0) / Math.max(1, rows.length),
    mrr: rows.reduce((sum, row) => sum + row.reciprocalRank, 0) / Math.max(1, rows.length),
    boundaryViolations: rows
      .filter((row) => row.category === "scope")
      .reduce((sum, row) => sum + row.forbidden.length, 0),
    provenanceFailures: rows.reduce(
      (sum, row) => sum + row.missingEvidence.length + row.orphanReferences,
      0,
    ),
    p50Ms: percentile(
      rows.map((row) => row.elapsedMs),
      0.5,
    ),
    p95Ms: percentile(
      rows.map((row) => row.elapsedMs),
      0.95,
    ),
    medianInputTokens: percentile(
      rows.map((row) => row.inputTokens),
      0.5,
    ),
    hybridCases: rows.filter((row) => row.method === "hybrid").length,
  });
  return {
    version: KNOWLEDGE_DATASET_VERSION,
    clock: EVALUATION_NOW,
    kind: "synthetic-retrieval-and-context-regression",
    answerGenerationEvaluated: false,
    modelInvocationsForAnswers: 0,
    tokenEncoding: "o200k_base",
    cold: summarize(cold),
    warm: summarize(warm),
    development: summarize(warm.filter((row) => row.split === "development")),
    holdout: summarize(warm.filter((row) => row.split === "holdout")),
    categories: Object.fromEntries(
      [...new Set(cases.map((entry) => entry.category))].map((category) => [
        category,
        summarize(warm.filter((row) => row.category === category)),
      ]),
    ),
    results: warm,
  };
});
