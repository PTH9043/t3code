import {
  CLAUDE_API_KEY_ENV,
  DEFAULT_SERVER_SETTINGS,
  OPENAI_API_CONNECTION,
  OPENAI_API_CREDENTIAL_ENV,
  OPENCODE_API_KEY_ENV,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerSettings,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { ServerSettingsService } from "../serverSettings.ts";
import { listLocalOllamaEmbeddingModels, makeOllamaEmbeddings } from "./OllamaEmbeddings.ts";
import { makeSemanticLlmReranker, parseLlmRerankScores } from "./RegisteredSemanticModels.ts";
import {
  formatProviderEmbeddingEndpoint,
  normalizeSemanticEndpoint,
  semanticScopeKey,
} from "./semanticSearch.ts";

const encodeUnknownJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const openAiId = ProviderInstanceId.make("openai_api_test");
const deepSeekId = ProviderInstanceId.make("deepseek_test");
const antseedId = ProviderInstanceId.make("antseed_local");
const claudeApiId = ProviderInstanceId.make("claude_api_test");

const sampleSettings: ServerSettings = {
  ...DEFAULT_SERVER_SETTINGS,
  providerInstances: {
    [openAiId]: {
      driver: ProviderDriverKind.make("opencode"),
      displayName: "OpenAI API",
      enabled: true,
      config: {
        apiConnection: {
          ...OPENAI_API_CONNECTION,
          models: ["gpt-5.4", "gpt-5-mini"],
        },
      },
      environment: [{ name: OPENAI_API_CREDENTIAL_ENV, value: "sk-test-openai", sensitive: true }],
    },
    [deepSeekId]: {
      driver: ProviderDriverKind.make("opencode"),
      displayName: "DeepSeek",
      enabled: true,
      config: {
        apiConnection: {
          providerId: "t3_deepseek",
          baseUrl: "https://api.deepseek.com",
          protocol: "chat-completions",
          models: ["deepseek-flash", "deepseek-v4-pro"],
        },
      },
      environment: [{ name: OPENCODE_API_KEY_ENV, value: "sk-test-deepseek", sensitive: true }],
    },
    [antseedId]: {
      driver: ProviderDriverKind.make("opencode"),
      displayName: "Antseed Gateway",
      enabled: true,
      config: {
        apiConnection: {
          providerId: "t3_antseed",
          baseUrl: "http://127.0.0.1:8379",
          protocol: "chat-completions",
          models: ["glm-5.3", "kimi-k3"],
        },
      },
      environment: [{ name: OPENCODE_API_KEY_ENV, value: "antseed-key", sensitive: true }],
    },
    [claudeApiId]: {
      driver: ProviderDriverKind.make("claudeAgent"),
      displayName: "Claude API",
      enabled: true,
      config: {
        authMode: "api-key",
        customModels: ["claude-sonnet-4-5"],
      },
      environment: [{ name: CLAUDE_API_KEY_ENV, value: "sk-ant-test", sensitive: true }],
    },
  },
};

it("accepts provider:// registered scope endpoints while continuing to reject arbitrary remote URLs", () => {
  expect(normalizeSemanticEndpoint("provider://openai_api_test")).toBe(
    "provider://openai_api_test",
  );
  expect(
    semanticScopeKey({
      projectId: "proj-1",
      endpoint: formatProviderEmbeddingEndpoint("openai_api_test"),
      model: "text-embedding-3-small",
    }),
  ).toMatch(/^[a-f0-9]{64}$/);
  expect(() => normalizeSemanticEndpoint("https://example.com")).toThrow("localhost");
  expect(() => normalizeSemanticEndpoint("provider://bad/slash")).toThrow("localhost");
});

it("parses JSON and fenced JSON rerank scores and clamps out-of-range values", () => {
  const candidates = [
    { id: "doc-a", title: "Refund Policy", content: "Cancel within 7 days" },
    { id: "doc-b", title: "Shipping", content: "Express delivery" },
  ];
  const parsed = parseLlmRerankScores(
    '```json\n{"scores":[{"id":2,"score":0.42},{"id":"1","score":1.25},{"id":99,"score":0.9}]}\n```',
    candidates,
  );
  expect(parsed).toEqual([
    { id: "doc-a", similarity: 1 },
    { id: "doc-b", similarity: 0.42 },
  ]);
});

it.effect(
  "discovers Ollama + all registered API providers (OpenAI, DeepSeek, Antseed, Claude API) without exposing keys",
  () =>
    Effect.gen(function* () {
      const result = yield* listLocalOllamaEmbeddingModels({}).pipe(
        Effect.provide(
          Layer.mergeAll(
            ServerSettingsService.layerTest({
              providerInstances: sampleSettings.providerInstances,
            }),
            Layer.succeed(
              HttpClient.HttpClient,
              HttpClient.make((request) =>
                Effect.sync(() => {
                  if (request.url.endsWith("/api/tags")) {
                    return HttpClientResponse.fromWeb(
                      request,
                      Response.json({
                        models: [
                          { name: "bge-m3:latest", size: 1_000_000_000 },
                          { name: "qwen2.5-coder:14b", size: 9_000_000_000 },
                        ],
                      }),
                    );
                  }
                  if (request.url.endsWith("/api/show")) {
                    const rawBody =
                      request.body._tag === "Uint8Array"
                        ? new TextDecoder().decode(request.body.body)
                        : "";
                    const isEmbed = rawBody.includes("bge-m3");
                    return HttpClientResponse.fromWeb(
                      request,
                      Response.json({
                        capabilities: isEmbed ? ["embedding"] : ["completion"],
                      }),
                    );
                  }
                  if (request.url === "https://api.openai.com/v1/models") {
                    return HttpClientResponse.fromWeb(
                      request,
                      Response.json({
                        data: [
                          { id: "text-embedding-3-small" },
                          { id: "text-embedding-3-large" },
                          { id: "gpt-5.4" },
                        ],
                      }),
                    );
                  }
                  return HttpClientResponse.fromWeb(
                    request,
                    new Response("Not Found", { status: 404 }),
                  );
                }),
              ),
            ),
          ),
        ),
      );

      expect(result.reachable).toBe(true);
      expect(result.models.map((m) => m.name)).toEqual(["bge-m3:latest"]);
      const providerNames = (result.providers ?? []).map((p) => p.displayName);
      expect(providerNames).toContain("로컬 Ollama");
      expect(providerNames).toContain("OpenAI API");
      expect(providerNames).toContain("DeepSeek");
      expect(providerNames).toContain("Antseed Gateway");
      expect(providerNames).toContain("Claude API");

      const ollama = result.providers!.find((p) => p.source === "ollama")!;
      expect(ollama.models.map((m) => [m.name, m.mode])).toEqual([
        ["bge-m3:latest", "embedding"],
        ["qwen2.5-coder:14b", "rerank"],
      ]);

      const openAi = result.providers!.find((p) => p.instanceId === openAiId)!;
      expect(openAi.supportsEmbeddingsApi).toBe(true);
      expect(
        openAi.models.some((m) => m.name === "text-embedding-3-small" && m.mode === "embedding"),
      ).toBe(true);
      expect(openAi.models.some((m) => m.name === "gpt-5-mini" && m.mode === "rerank")).toBe(true);

      const deepSeek = result.providers!.find((p) => p.instanceId === deepSeekId)!;
      expect(deepSeek.supportsEmbeddingsApi).toBe(false);
      expect(deepSeek.models.map((m) => [m.name, m.mode])).toEqual([
        ["deepseek-flash", "rerank"],
        ["deepseek-v4-pro", "rerank"],
      ]);

      // Ensure no secret value leaks into the RPC response.
      const serialized = encodeUnknownJson(result);
      expect(serialized).not.toContain("sk-test-openai");
      expect(serialized).not.toContain("sk-test-deepseek");
      expect(serialized).not.toContain("sk-ant-test");
    }),
);

it.effect(
  "routes provider://<instanceId> embedding requests to registered OpenAI-compatible /embeddings with stored API key",
  () =>
    Effect.gen(function* () {
      const seen: Array<{ url: string; auth: string | undefined }> = [];
      const embed = yield* makeOllamaEmbeddings(
        HttpClient.make((request) =>
          Effect.sync(() => {
            seen.push({
              url: request.url,
              auth: request.headers.authorization,
            });
            return HttpClientResponse.fromWeb(
              request,
              Response.json({
                data: [
                  { index: 1, embedding: [0, 1] },
                  { index: 0, embedding: [1, 0] },
                ],
              }),
            );
          }),
        ),
        () => Effect.succeed(sampleSettings),
      );

      const vectors = yield* embed({
        endpoint: formatProviderEmbeddingEndpoint(openAiId),
        model: "text-embedding-3-small",
        texts: ["first", "second"],
        purpose: "index",
      });

      expect(seen).toEqual([
        { url: "https://api.openai.com/v1/embeddings", auth: "Bearer sk-test-openai" },
      ]);
      expect(vectors).toEqual([
        [1, 0],
        [0, 1],
      ]);
    }),
);

it.effect(
  "reranks document candidates using OpenAI Responses, Chat Completions (DeepSeek/Antseed), and Anthropic Messages APIs with caching",
  () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const rerank = yield* makeSemanticLlmReranker(
        HttpClient.make((request) =>
          Effect.sync(() => {
            calls.push(request.url);
            if (request.url === "https://api.openai.com/v1/responses") {
              return HttpClientResponse.fromWeb(
                request,
                Response.json({ output_text: '{"scores":[{"id":1,"score":0.88}]}' }),
              );
            }
            if (request.url === "https://api.deepseek.com/chat/completions") {
              return HttpClientResponse.fromWeb(
                request,
                Response.json({
                  choices: [{ message: { content: '{"scores":[{"id":1,"score":0.91}]}' } }],
                }),
              );
            }
            if (request.url === "http://127.0.0.1:8379/v1/chat/completions") {
              return HttpClientResponse.fromWeb(
                request,
                Response.json({
                  choices: [{ message: { content: '{"scores":[{"id":1,"score":0.79}]}' } }],
                }),
              );
            }
            if (request.url === "https://api.anthropic.com/v1/messages") {
              return HttpClientResponse.fromWeb(
                request,
                Response.json({
                  content: [{ type: "text", text: '{"scores":[{"id":1,"score":0.84}]}' }],
                }),
              );
            }
            return HttpClientResponse.fromWeb(request, new Response("Not Found", { status: 404 }));
          }),
        ),
        () => Effect.succeed(sampleSettings),
      );

      const candidates = [{ id: "c1", title: "Cancellation", content: "Refund within 7 days" }];
      const rOpenAi = yield* rerank({
        instanceId: openAiId,
        endpoint: "http://127.0.0.1:11434",
        model: "gpt-5-mini",
        query: "withdraw trip",
        candidates,
      });
      expect(rOpenAi).toEqual([{ id: "c1", similarity: 0.88 }]);

      // Cached repeat should not make a second HTTP call.
      const rOpenAiCached = yield* rerank({
        instanceId: openAiId,
        endpoint: "http://127.0.0.1:11434",
        model: "gpt-5-mini",
        query: "withdraw trip",
        candidates,
      });
      expect(rOpenAiCached).toEqual([{ id: "c1", similarity: 0.88 }]);

      const rDeepSeek = yield* rerank({
        instanceId: deepSeekId,
        endpoint: "http://127.0.0.1:11434",
        model: "deepseek-flash",
        query: "withdraw trip",
        candidates,
      });
      expect(rDeepSeek).toEqual([{ id: "c1", similarity: 0.91 }]);

      const rAntseed = yield* rerank({
        instanceId: antseedId,
        endpoint: "http://127.0.0.1:11434",
        model: "kimi-k3",
        query: "withdraw trip",
        candidates,
      });
      expect(rAntseed).toEqual([{ id: "c1", similarity: 0.79 }]);

      const rClaude = yield* rerank({
        instanceId: claudeApiId,
        endpoint: "http://127.0.0.1:11434",
        model: "claude-haiku-4-5",
        query: "withdraw trip",
        candidates,
      });
      expect(rClaude).toEqual([{ id: "c1", similarity: 0.84 }]);

      expect(calls).toEqual([
        "https://api.openai.com/v1/responses",
        "https://api.deepseek.com/chat/completions",
        "http://127.0.0.1:8379/v1/chat/completions",
        "https://api.anthropic.com/v1/messages",
      ]);
    }),
);
