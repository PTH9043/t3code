import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { WorkspaceKnowledgeItem, WorkspacePromptComposeInput } from "@t3tools/contracts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { ProjectionWorkspaceRagRepositoryLive } from "../persistence/Layers/ProjectionWorkspaceRag.ts";
import { ProjectionWorkspaceKnowledgeRepositoryLive } from "../persistence/Layers/ProjectionWorkspaceKnowledge.ts";
import { evaluateKnowledge } from "./knowledgeEvaluation.ts";
import { knowledgeCases } from "./knowledgeDataset.ts";
const decodeRequest = Schema.decodeUnknownSync(WorkspacePromptComposeInput);
const decodeItem = Schema.decodeUnknownSync(WorkspaceKnowledgeItem);

it("versions 120 unique Korean cases with separate reserved cases and valid wire data", () => {
  expect(knowledgeCases).toHaveLength(120);
  expect(new Set(knowledgeCases.map((entry) => entry.id)).size).toBe(120);
  expect(new Set(knowledgeCases.map((entry) => entry.request.task)).size).toBe(120);
  const counts = Object.fromEntries(
    ["semantic", "correction", "temporal", "scope", "exclusion", "history", "code"].map(
      (category) => [
        category,
        knowledgeCases.filter((entry) => entry.category === category).length,
      ],
    ),
  );
  expect(counts).toEqual({
    semantic: 30,
    correction: 20,
    temporal: 20,
    scope: 20,
    exclusion: 10,
    history: 10,
    code: 10,
  });
  for (const entry of knowledgeCases) {
    decodeRequest(entry.request);
    entry.items.forEach((item) => decodeItem(item));
  }
  expect(knowledgeCases.some((entry) => entry.split === "holdout")).toBe(true);
});
it.effect(
  "measures the actual SQLite retrieval and final evidence path without using a live database or generating answers",
  () =>
    Effect.gen(function* () {
      const cases = knowledgeCases.filter((entry) => entry.category !== "semantic");
      const result = yield* evaluateKnowledge(cases, (text) => text.length);
      expect(result.warm.cases).toBe(90);
      expect(result.warm.passed).toBe(90);
      expect(result.warm.boundaryViolations).toBe(0);
      expect(result.warm.provenanceFailures).toBe(0);
      expect(result.answerGenerationEvaluated).toBe(false);
      expect(result.modelInvocationsForAnswers).toBe(0);
    }).pipe(
      Effect.provide(
        Layer.merge(
          ProjectionWorkspaceRagRepositoryLive,
          ProjectionWorkspaceKnowledgeRepositoryLive,
        ).pipe(Layer.provideMerge(SqlitePersistenceMemory)),
      ),
    ),
);
