import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/unstable/http";
import {
  discoverOllamaEmbeddingModelsAtEndpoint,
  makeOllamaEmbeddings,
  semanticSearchFailureMessage,
} from "./OllamaEmbeddings.ts";

const input = {
  endpoint: "http://127.0.0.1:11434",
  model: "local-embedding",
  texts: ["Document evidence"],
} as const;

it.effect("allows a CPU document batch to take longer than five seconds", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const embed = yield* makeOllamaEmbeddings(
      HttpClient.make((request) =>
        Effect.gen(function* () {
          yield* Deferred.succeed(started, undefined);
          yield* Effect.sleep("6 seconds");
          return HttpClientResponse.fromWeb(request, Response.json({ embeddings: [[1, 0]] }));
        }),
      ),
    );
    const batch = yield* Effect.forkChild(embed({ ...input, purpose: "index" }));
    yield* Deferred.await(started);
    yield* TestClock.adjust("6 seconds");
    expect(yield* Fiber.join(batch)).toEqual([[1, 0]]);
  }),
);

it.effect("includes queue time in the query deadline without interrupting the document batch", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let requests = 0;
    const embed = yield* makeOllamaEmbeddings(
      HttpClient.make((request) =>
        Effect.gen(function* () {
          requests++;
          if (requests === 1) {
            yield* Deferred.succeed(started, undefined);
            yield* Deferred.await(release);
          }
          return HttpClientResponse.fromWeb(request, Response.json({ embeddings: [[1, 0]] }));
        }),
      ),
    );
    const batch = yield* Effect.forkChild(embed({ ...input, purpose: "index" }));
    yield* Deferred.await(started);
    const query = yield* Effect.forkChild(
      embed({ ...input, purpose: "query" }).pipe(Effect.result),
    );
    yield* TestClock.adjust("5 seconds");
    expect(yield* Fiber.join(query)).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "OllamaEmbeddingError", reason: "timeout" },
    });
    expect(requests).toBe(1);
    yield* Deferred.succeed(release, undefined);
    expect(yield* Fiber.join(batch)).toEqual([[1, 0]]);
    expect(yield* embed({ ...input, purpose: "query" })).toEqual([[1, 0]]);
    expect(requests).toBe(2);
  }),
);

it.effect(
  "distinguishes a missing model from an unavailable API route without exposing response text",
  () =>
    Effect.gen(function* () {
      for (const [response, reason] of [
        [
          Response.json(
            { error: "model 'local-embedding' not found; private diagnostic" },
            { status: 404 },
          ),
          "model-missing",
        ],
        [new Response("<html>private diagnostic</html>", { status: 404 }), "request"],
        [Response.json({ error: "private diagnostic" }, { status: 500 }), "request"],
        [Response.json({ embeddings: [["invalid"]] }), "response"],
        [new Response("invalid json"), "response"],
      ] as const) {
        const embed = yield* makeOllamaEmbeddings(
          HttpClient.make((request) =>
            Effect.succeed(HttpClientResponse.fromWeb(request, response)),
          ),
        );
        const result = yield* embed({ ...input, purpose: "query" }).pipe(Effect.result);
        expect(result).toMatchObject({ _tag: "Failure", failure: { reason } });
        if (result._tag !== "Failure") throw new Error("Expected a recoverable embedding failure");
        const message = semanticSearchFailureMessage(result.failure);
        expect(message).toContain("키워드 검색을 유지합니다");
        expect(message).not.toContain("private diagnostic");
        if (reason === "model-missing") expect(message).toContain(input.model);
      }
    }),
);

it.effect("reports an Ollama connection failure and allows the next request to recover", () =>
  Effect.gen(function* () {
    let requests = 0;
    const embed = yield* makeOllamaEmbeddings(
      HttpClient.make((request) => {
        if (requests++ === 0)
          return Effect.fail(
            new HttpClientError.HttpClientError({
              reason: new HttpClientError.TransportError({ request }),
            }),
          );
        return Effect.succeed(
          HttpClientResponse.fromWeb(request, Response.json({ embeddings: [[1, 0]] })),
        );
      }),
    );
    expect(yield* embed({ ...input, purpose: "query" }).pipe(Effect.result)).toMatchObject({
      _tag: "Failure",
      failure: { reason: "connection" },
    });
    expect(yield* embed({ ...input, purpose: "query" })).toEqual([[1, 0]]);
    expect(requests).toBe(2);
  }),
);

it.effect(
  "sends truncate: true so 512-token models truncate long chunks instead of returning HTTP 400",
  () =>
    Effect.gen(function* () {
      const decodeEmbedPayload = Schema.decodeUnknownEffect(
        Schema.fromJsonString(Schema.Struct({ truncate: Schema.Boolean })),
      );
      let capturedBodyText: string | undefined;
      const embed = yield* makeOllamaEmbeddings(
        HttpClient.make((request) =>
          Effect.sync(() => {
            if (request.body._tag === "Uint8Array") {
              capturedBodyText = new TextDecoder().decode(request.body.body);
            }
            return HttpClientResponse.fromWeb(request, Response.json({ embeddings: [[0.5, 0.5]] }));
          }),
        ),
      );
      expect(yield* embed({ ...input, purpose: "index" })).toEqual([[0.5, 0.5]]);
      const payload = yield* decodeEmbedPayload(capturedBodyText ?? "{}");
      expect(payload.truncate).toBe(true);
    }),
);

const decodeShowBody = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ model: Schema.String })),
);

it.effect(
  "discovers only locally installed Ollama embedding models and ranks multilingual ones first",
  () =>
    Effect.gen(function* () {
      const mockHttp = HttpClient.make((request) =>
        Effect.sync(() => {
          if (request.url.endsWith("/api/tags")) {
            return HttpClientResponse.fromWeb(
              request,
              Response.json({
                models: [
                  {
                    name: "personal-orchestrator-4b:latest",
                    size: 2_800_000_000,
                    details: {
                      family: "qwen3",
                      parameter_size: "4.0B",
                      quantization_level: "Q5_K_M",
                    },
                  },
                  {
                    name: "mxbai-embed-large:latest",
                    size: 670_000_000,
                    details: { family: "bert", parameter_size: "334M", quantization_level: "F16" },
                  },
                  {
                    name: "bge-m3:latest",
                    size: 1_157_000_000,
                    details: { family: "bert", parameter_size: "567M", quantization_level: "F16" },
                  },
                  {
                    name: "nomic-embed-text-v2-moe:latest",
                    size: 957_000_000,
                    details: {
                      family: "nomic-bert-moe",
                      parameter_size: "475M",
                      quantization_level: "F16",
                    },
                  },
                  {
                    name: "remote-embed:cloud",
                    remote_host: "https://remote.example",
                  },
                ],
              }),
            );
          }
          const rawBody =
            request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "{}";
          const { model } = decodeShowBody(rawBody);
          const capabilities =
            model === "personal-orchestrator-4b:latest" ? ["completion", "tools"] : ["embedding"];
          return HttpClientResponse.fromWeb(request, Response.json({ capabilities }));
        }),
      );

      const res = yield* discoverOllamaEmbeddingModelsAtEndpoint(
        mockHttp,
        "http://127.0.0.1:11434",
      );
      expect(res.reachable).toBe(true);
      expect(res.models.map((m) => m.name)).toEqual([
        "bge-m3:latest",
        "nomic-embed-text-v2-moe:latest",
        "mxbai-embed-large:latest",
      ]);
      expect(res.models[0]?.multilingualRecommended).toBe(true);
      expect(res.models[1]?.multilingualRecommended).toBe(true);
      expect(res.models[2]?.multilingualRecommended).toBe(false);
      expect(res.models[2]?.englishOnlyWarning).toContain("영어 전용");
    }),
);

it.effect("rejects non-loopback endpoints and degrades cleanly when Ollama is unreachable", () =>
  Effect.gen(function* () {
    const offlineHttp = HttpClient.make((request) =>
      Effect.fail(
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({ request }),
        }),
      ),
    );
    const nonLoopback = yield* discoverOllamaEmbeddingModelsAtEndpoint(
      offlineHttp,
      "https://evil.example:11434",
    );
    expect(nonLoopback.reachable).toBe(false);
    expect(nonLoopback.models).toEqual([]);
    expect(nonLoopback.errorMessage).toContain("localhost");

    const offline = yield* discoverOllamaEmbeddingModelsAtEndpoint(
      offlineHttp,
      "http://127.0.0.1:11434",
    );
    expect(offline.reachable).toBe(false);
    expect(offline.models).toEqual([]);
    expect(offline.errorMessage).toContain("키워드 검색");
  }),
);
