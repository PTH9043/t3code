import * as NodeServices from "@effect/platform-node/NodeServices";
import { CommandId, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { layerTest as configLayer } from "../config.ts";
import { OrchestrationEngineLive } from "../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import * as ThreadBackgroundLiveness from "../orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../orchestration/ThreadPlanProgress.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as ServerSettings from "../serverSettings.ts";
import { GrokResearch, GrokResearchLive } from "./GrokResearch.ts";

it.effect(
  "persists non-Google research through the real engine and excludes Google display-only results",
  () => {
    const keys = new Map<string, Uint8Array>();
    const responses = [
      {
        id: "xai-source",
        status: "completed",
        output: [
          {
            type: "message",
            content: [
              {
                type: "output_text",
                text: "INTEGRATION_SOURCE",
                annotations: [{ type: "url_citation", url: "https://example.org/source" }],
              },
            ],
          },
        ],
      },
      {
        responseId: "gemini-analysis",
        candidates: [
          { finishReason: "STOP", content: { parts: [{ text: "INTEGRATION_ANALYSIS" }] } },
        ],
      },
      {
        responseId: "gemini-google",
        candidates: [
          {
            finishReason: "STOP",
            content: { parts: [{ text: "INTEGRATION_GOOGLE_ONLY" }] },
            groundingMetadata: {
              searchEntryPoint: {
                renderedContent: '<a href="https://www.google.com/search?q=test">search</a>',
              },
              groundingChunks: [{ web: { uri: "https://example.org/google-source" } }],
            },
          },
        ],
      },
    ];
    let nextResponse = 0;
    const engineLayer = Layer.mergeAll(
      OrchestrationEngineLive.pipe(
        Layer.provide(OrchestrationProjectionSnapshotQueryLive),
        Layer.provide(OrchestrationProjectionPipelineLive),
      ),
      OrchestrationProjectionSnapshotQueryLive,
    ).pipe(
      Layer.provide(ThreadBackgroundLiveness.layer),
      Layer.provide(ThreadPlanProgress.layer),
      Layer.provide(OrchestrationEventStoreLive),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
      Layer.provide(RepositoryIdentityResolver.layer),
      Layer.provideMerge(SqlitePersistenceMemory),
      Layer.provideMerge(configLayer(process.cwd(), { prefix: "t3-research-integration-" })),
      Layer.provideMerge(NodeServices.layer),
    );
    const layer = GrokResearchLive.pipe(
      Layer.provide(
        Layer.succeed(ServerSecretStore, {
          get: (name) => Effect.succeed(Option.fromNullishOr(keys.get(name))),
          set: (name, value) =>
            Effect.sync(() => {
              keys.set(name, value);
            }),
          remove: (name) =>
            Effect.sync(() => {
              keys.delete(name);
            }),
          create: () => Effect.die("unused"),
          getOrCreateRandom: () => Effect.die("unused"),
        }),
      ),
      Layer.provide(ServerSettings.layerTest({ aiSearch: { researchDailyUsd: null } })),
      Layer.provide(
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.sync(() =>
              HttpClientResponse.fromWeb(request, Response.json(responses[nextResponse++])),
            ),
          ),
        ),
      ),
      Layer.provideMerge(engineLayer),
    );
    return Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const sql = yield* SqlClient.SqlClient;
      const research = yield* GrokResearch;
      const projectId = ProjectId.make("research-integration");
      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("create-research-project"),
        projectId,
        title: "Research",
        workspaceRoot: "D:/research-integration",
        defaultModelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test" },
        createdAt: "2026-11-02T00:00:00.000Z",
      });
      yield* research.configureKey("test-xai", "xai");
      yield* research.configureKey("test-gemini", "gemini");
      const source = yield* research.run({
        projectId,
        requestId: "source",
        query: "source",
        source: "web",
      });
      const analysis = yield* research.run({
        projectId,
        requestId: "analysis",
        query: "analysis",
        source: "web",
        provider: "gemini",
        model: "gemini-test",
        geminiMode: "analysis",
        followUpId: "source",
      });
      const google = yield* research.run({
        projectId,
        requestId: "google",
        query: "google",
        source: "web",
        provider: "gemini",
        model: "gemini-test",
        geminiMode: "google",
      });
      expect(google.text).toBe("INTEGRATION_GOOGLE_ONLY");
      expect(google.itemId).toBeNull();
      const rows = yield* sql<{
        item_id: string;
        content: string;
        research_json: string;
      }>`SELECT item_id,content,research_json FROM projection_workspace_knowledge_items WHERE project_id=${projectId}`;
      expect(rows).toHaveLength(2);
      expect(rows.find((row) => row.item_id === source.itemId)?.content).toContain(
        "INTEGRATION_SOURCE",
      );
      expect(rows.find((row) => row.item_id === analysis.itemId)?.content).toContain(
        "INTEGRATION_ANALYSIS",
      );
      expect(
        rows.some((row) =>
          Object.values(row).some((value) => value.includes("INTEGRATION_GOOGLE_ONLY")),
        ),
      ).toBe(false);
      expect(
        rows.some((row) => Object.values(row).some((value) => value.includes("google-source"))),
      ).toBe(false);
      const chunks = yield* sql<{
        item_id: string;
        content: string;
      }>`SELECT item_id,content FROM projection_workspace_rag_chunks WHERE project_id=${projectId}`;
      expect(
        chunks.some(
          (chunk) =>
            chunk.item_id === source.itemId && chunk.content.includes("INTEGRATION_SOURCE"),
        ),
      ).toBe(true);
      expect(
        chunks.some(
          (chunk) =>
            chunk.item_id === analysis.itemId && chunk.content.includes("INTEGRATION_ANALYSIS"),
        ),
      ).toBe(true);
      expect(chunks.some((chunk) => chunk.content.includes("INTEGRATION_GOOGLE_ONLY"))).toBe(false);
      const matches = yield* sql<{
        item_id: string;
      }>`SELECT item_id FROM projection_workspace_rag_chunks WHERE projection_workspace_rag_chunks MATCH 'integration' AND project_id=${projectId}`;
      expect(matches.map((row) => row.item_id)).toContain(analysis.itemId);
    }).pipe(Effect.provide(layer));
  },
);
