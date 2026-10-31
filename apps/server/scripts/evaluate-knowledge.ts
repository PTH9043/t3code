// oxlint-disable t3code/no-global-process-runtime -- Standalone evaluation CLI records its own host metadata.
import * as NodeCrypto from "node:crypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SchemaGetter from "effect/SchemaGetter";
import { FetchHttpClient } from "effect/unstable/http";
import { ServerConfig } from "../src/config.ts";
import { ServerSettingsService } from "../src/serverSettings.ts";
import { SqlitePersistenceMemory } from "../src/persistence/Layers/Sqlite.ts";
import { ProjectionWorkspaceRagRepositoryLive } from "../src/persistence/Layers/ProjectionWorkspaceRag.ts";
import { ProjectionWorkspaceKnowledgeRepositoryLive } from "../src/persistence/Layers/ProjectionWorkspaceKnowledge.ts";
import { loadWorkspaceTokenCounter } from "../src/orchestration/workspacePromptTokens.ts";
import { knowledgeCases } from "../src/evaluation/knowledgeDataset.ts";
import { evaluateKnowledge } from "../src/evaluation/knowledgeEvaluation.ts";

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const encodeReport = Schema.encodeEffect(
  Schema.String.pipe(
    Schema.decodeTo(Schema.Unknown, {
      decode: SchemaGetter.parseJson(),
      encode: SchemaGetter.stringifyJson({ space: 2 }),
    }),
  ),
);

const args = process.argv.slice(2);
const semantic = args.includes("--semantic");
const output = args[args.indexOf("--output") + 1];
if (!args.includes("--output") || !output)
  throw new Error(
    "Use --output <report.json> [--semantic]. Only disposable in-memory state is used.",
  );
await Effect.runPromise(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = path.resolve(import.meta.dirname, "../../..");
    const files = [
      "apps/server/src/evaluation/knowledgeDataset.ts",
      "apps/server/src/orchestration/workspaceKnowledgeSelection.ts",
      "apps/server/src/orchestration/workspacePromptRelevant.ts",
      "apps/server/src/persistence/Layers/ProjectionWorkspaceRag.ts",
      "packages/contracts/src/orchestration.ts",
    ];
    const sourceHashes = Object.fromEntries(
      yield* Effect.forEach(
        files,
        (file) =>
          fs
            .readFile(path.join(root, file))
            .pipe(
              Effect.map(
                (content) =>
                  [file, NodeCrypto.createHash("sha256").update(content).digest("hex")] as const,
              ),
            ),
        { concurrency: "unbounded" },
      ),
    );
    const layer = Layer.merge(
      ProjectionWorkspaceRagRepositoryLive,
      ProjectionWorkspaceKnowledgeRepositoryLive,
    ).pipe(
      Layer.provideMerge(SqlitePersistenceMemory),
      Layer.provide(
        ServerSettingsService.layerTest({
          aiSearch: {
            semanticEnabled: semantic,
            embeddingModel: "bge-m3:latest",
            embeddingEndpoint: "http://127.0.0.1:11434",
          },
        }),
      ),
      Layer.provide(
        ServerConfig.layerTest(root, path.join(root, ".t3/knowledge-evaluation-cache-v1")),
      ),
      Layer.provide(FetchHttpClient.layer),
      Layer.provide(NodeServices.layer),
    );
    yield* encodeJson({ stage: "started", semantic, cases: knowledgeCases.length }).pipe(
      Effect.flatMap(Console.log),
    );
    const counter = yield* Effect.promise(() => loadWorkspaceTokenCounter());
    const result = yield* evaluateKnowledge(knowledgeCases, counter).pipe(
      Effect.provide(layer),
      Effect.scoped,
    );
    const report = {
      ...result,
      measuredAt: DateTime.formatIso(yield* DateTime.now),
      environment: {
        node: process.version,
        platform: process.platform,
        architecture: process.arch,
        requestedMode: semantic ? "hybrid" : "keyword",
        embeddingModel: semantic ? "bge-m3:latest" : null,
        vectorCache: "worktree-local-derived-vectors",
      },
      sourceHashes,
      datasetHash: NodeCrypto.createHash("sha256")
        .update(yield* encodeJson(knowledgeCases))
        .digest("hex"),
    };
    yield* fs.makeDirectory(path.dirname(path.resolve(output)), { recursive: true });
    yield* fs.writeFileString(output, (yield* encodeReport(report)) + "\n");
    yield* encodeJson({ output, warm: report.warm, categories: report.categories }).pipe(
      Effect.flatMap(Console.log),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);
