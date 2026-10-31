import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import { ServerConfig } from "../config.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { makeSemanticSearch, semanticContentKey } from "./semanticSearch.ts";
import { makeSemanticIndexJobs } from "./SemanticIndexJobs.ts";
import { OllamaEmbeddingError } from "./OllamaEmbeddings.ts";

const layer = Layer.mergeAll(
  SqlitePersistenceMemory,
  ServerConfig.layerTest(process.cwd(), { prefix: "semantic-jobs-" }),
).pipe(Layer.provide(NodeServices.layer));
const request = { projectId: "p", endpoint: "http://127.0.0.1:11434", model: "m" };
const insert = Effect.fn("SemanticIndexJobsTest.insert")(function* (content: string) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO projection_workspace_rag_chunks(project_id,item_id,kind,chunk_index,title,content,updated_at,tags_text,search_title,search_tags,search_body,scope)
    VALUES('p','one','rag-source','0','Policy',${content},'2026-10-20','','','','','project')`;
});

it.effect(
  "coalesces repeated requests on disk and resumes pending work in a new service scope",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const config = yield* ServerConfig;
      yield* insert("first source");
      let embedded = 0;
      const vectors = makeSemanticSearch({
        now: () => 0,
        embed: async ({ texts }) => {
          embedded += texts.length;
          return texts.map(() => [1, 0]);
        },
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const jobs = yield* makeSemanticIndexJobs({
            stateDir: config.stateDir,
            vectors,
            enabled: () => Effect.succeed(true),
            startWorker: false,
          });
          for (let n = 0; n < 100; n++) yield* jobs.enqueue(request);
          const [row] = yield* sql<{
            total: number;
          }>`SELECT count(*) AS total FROM workspace_semantic_index_jobs`;
          expect(row!.total).toBe(1);
          expect(embedded).toBe(0);
        }),
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          const jobs = yield* makeSemanticIndexJobs({
            stateDir: config.stateDir,
            vectors,
            enabled: () => Effect.succeed(true),
            startWorker: false,
          });
          yield* jobs.drain;
          expect(embedded).toBe(1);
          expect(yield* sql`SELECT * FROM workspace_semantic_index_jobs`).toHaveLength(0);
          expect(yield* sql`SELECT * FROM workspace_semantic_vector_refs`).toHaveLength(1);
        }),
      );
    }).pipe(Effect.provide(layer)),
);

it.effect("reports disabled jobs without spinning retries", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const config = yield* ServerConfig;
      yield* insert("disabled policy");
      const vectors = makeSemanticSearch({
        now: () => 0,
        embed: async ({ texts }) => texts.map(() => [1, 0]),
      });
      const jobs = yield* makeSemanticIndexJobs({
        stateDir: config.stateDir,
        vectors,
        enabled: () => Effect.succeed(false),
        startWorker: false,
      });
      yield* jobs.enqueue(request);
      const status = yield* jobs.status(request);
      expect(status.state).toBe("disabled");
      expect(status.pending).toBe(true);
      yield* jobs.drain;
      const [row] = yield* sql<{
        retry_at: number;
      }>`SELECT retry_at FROM workspace_semantic_index_jobs`;
      expect(row!.retry_at).toBeGreaterThan(0);
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect("persists failed work with backoff and retries without changing source content", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const config = yield* ServerConfig;
      yield* insert("unaltered original policy");
      let fail = true;
      const vectors = makeSemanticSearch({
        now: () => 0,
        embed: async ({ texts }) => {
          if (fail)
            throw new OllamaEmbeddingError({ model: request.model, reason: "model-missing" });
          return texts.map(() => [1, 0]);
        },
      });
      const jobs = yield* makeSemanticIndexJobs({
        stateDir: config.stateDir,
        vectors,
        enabled: () => Effect.succeed(true),
        startWorker: false,
      });
      yield* jobs.enqueue(request);
      yield* jobs.drain;
      const [pending] = yield* sql<{
        failures: number;
        after_rowid: number;
      }>`SELECT * FROM workspace_semantic_index_jobs`;
      expect(pending).toMatchObject({ failures: 1, after_rowid: 0 });
      expect((yield* jobs.status(request)).failureMessage).toContain("설치되어 있지 않습니다");
      const restarted = yield* makeSemanticIndexJobs({
        stateDir: config.stateDir,
        vectors,
        enabled: () => Effect.succeed(true),
        startWorker: false,
      });
      expect((yield* restarted.status(request)).failureMessage).toBe(
        (yield* jobs.status(request)).failureMessage,
      );
      fail = false;
      expect((yield* jobs.drain).pages).toBe(0);
      yield* TestClock.adjust("30 seconds");
      yield* jobs.drain;
      expect(yield* sql`SELECT * FROM workspace_semantic_index_jobs`).toHaveLength(0);
      expect((yield* restarted.status(request)).failureMessage).toBeNull();
      const [source] = yield* sql<{
        content: string;
      }>`SELECT content FROM projection_workspace_rag_chunks`;
      expect(source!.content).toBe("unaltered original policy");
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect(
  "a source changed during embedding cannot publish a stale reference or skip the new revision",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const config = yield* ServerConfig;
        yield* insert("old policy");
        let release!: () => void;
        let announce!: () => void;
        const blocked = new Promise<void>((resolve) => {
          release = resolve;
        });
        const started = new Promise<void>((resolve) => {
          announce = resolve;
        });
        let first = true;
        const vectors = makeSemanticSearch({
          now: () => 0,
          embed: async ({ texts }) => {
            if (first) {
              first = false;
              announce();
              await blocked;
            }
            return texts.map(() => [1, 0]);
          },
        });
        const jobs = yield* makeSemanticIndexJobs({
          stateDir: config.stateDir,
          vectors,
          enabled: () => Effect.succeed(true),
          startWorker: false,
        });
        yield* jobs.enqueue(request);
        const worker = yield* Effect.forkScoped(jobs.drain);
        yield* Effect.promise(() => started);
        yield* sql`UPDATE projection_workspace_rag_chunks SET content='new policy' WHERE project_id='p'`;
        yield* jobs.enqueue(request, true);
        release();
        yield* Fiber.join(worker);
        const [reference] = yield* sql<{
          content_key: string;
        }>`SELECT content_key FROM workspace_semantic_vector_refs`;
        expect(reference!.content_key).toBe(
          semanticContentKey({ title: "Policy", content: "new policy" }),
        );
        expect(yield* sql`SELECT * FROM workspace_semantic_index_jobs`).toHaveLength(0);
      }),
    ).pipe(Effect.provide(layer)),
);
