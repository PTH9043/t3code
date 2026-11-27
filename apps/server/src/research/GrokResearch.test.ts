import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/unstable/http";
import {
  OrchestrationProjectShell,
  ProjectId,
  ProviderInstanceId,
  ProviderDriverKind,
  OPENCODE_API_KEY_ENV,
  type ServerSettings as ServerSettingsType,
  type OrchestrationCommand,
  type WorkspaceResearchInput,
} from "@t3tools/contracts";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  GrokResearch,
  GrokResearchLive,
  researchCostSummary,
  researchResponseText,
} from "./GrokResearch.ts";
import { geminiResearchResponse } from "./ResearchApiAdapters.ts";

const encodeJsonFixture = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const projectId = ProjectId.make("research-project");
const query: WorkspaceResearchInput = {
  projectId,
  requestId: "request-one",
  query: "최근 개발 방법 조사",
  source: "both",
  allowedDomains: ["docs.x.ai"],
  allowedHandles: ["xai"],
  fromDate: "2026-10-01",
  toDate: "2026-10-13",
};
const answer = (id: string, cost: number | undefined, inputTokens = 100) => ({
  id,
  status: "completed",
  usage: {
    cost_in_usd_ticks: cost,
    input_tokens: inputTokens,
    output_tokens: 45,
    input_tokens_details: { cached_tokens: 80 },
  },
  output: [
    {
      type: "message",
      content: [
        {
          type: "output_text",
          text: "공식 문서에서 확인한 결과",
          annotations: [
            { type: "url_citation", url: "https://docs.x.ai/developers/tools/web-search" },
            { type: "url_citation", url: "javascript:alert(1)" },
          ],
        },
      ],
    },
  ],
});
const unexpected = () => Effect.die("Unexpected projection query");

it("does not expose incomplete, oversized, or ungrounded Google reports", () => {
  const response = (text: string, sources: string[], suggestions = "<div>suggestion</div>") => ({
    candidates: [
      {
        finishReason: "STOP",
        content: { parts: [{ text }] },
        groundingMetadata: {
          searchEntryPoint: { renderedContent: suggestions },
          groundingChunks: sources.map((uri) => ({ web: { uri } })),
        },
      },
    ],
  });
  expect(
    geminiResearchResponse(response("report", ["https://example.org"]), "id", true).status,
  ).toBe("completed");
  expect(
    geminiResearchResponse(response("x".repeat(60_001), ["https://example.org"]), "id", true)
      .status,
  ).toBe("incomplete");
  expect(geminiResearchResponse(response("report", []), "id", true).status).toBe("incomplete");
  expect(
    geminiResearchResponse(response("report", ["https://example.org"], ""), "id", true).status,
  ).toBe("incomplete");
});

it("maps Gemini UTF-8 grounding offsets to the correct visible Korean and emoji parts", () => {
  const first = "한글😀 첫 문장";
  const second = "두 번째 문장";
  const response = geminiResearchResponse(
    {
      candidates: [
        {
          finishReason: "STOP",
          content: {
            parts: [{ thought: true, text: "private thought" }, { text: first }, { text: second }],
          },
          groundingMetadata: {
            searchEntryPoint: { renderedContent: "suggestions" },
            groundingChunks: [
              { web: { uri: "https://example.org/one" } },
              { web: { uri: "https://example.org/two" } },
            ],
            groundingSupports: [
              {
                segment: {
                  partIndex: 1,
                  endIndex: new TextEncoder().encode(first).length,
                  text: first,
                },
                groundingChunkIndices: [0, 1],
              },
              {
                segment: {
                  partIndex: 2,
                  endIndex: new TextEncoder().encode(second).length,
                  text: second,
                },
                groundingChunkIndices: [1],
              },
              { segment: { partIndex: 1, startIndex: 1, endIndex: 2 }, groundingChunkIndices: [0] },
              {
                segment: {
                  partIndex: 1,
                  endIndex: new TextEncoder().encode(first).length,
                  text: "mismatch",
                },
                groundingChunkIndices: [0],
              },
              { segment: { partIndex: 0, endIndex: 1 }, groundingChunkIndices: [0] },
            ],
          },
        },
      ],
    },
    "fallback",
    true,
  );
  const parsed = researchResponseText(response);
  expect(parsed.text).toBe(first + second);
  expect(parsed.citations).toEqual([
    { start: 0, end: first.length, url: "https://example.org/one" },
    { start: 0, end: first.length, url: "https://example.org/two" },
    { start: first.length, end: first.length + second.length, url: "https://example.org/two" },
  ]);
});

it.effect("does not save unsourced OpenAI or Claude answers as web research", () => {
  const commands: OrchestrationCommand[] = [];
  const requests: { url: string; body: Readonly<Record<string, unknown>> }[] = [];
  const openai = {
    id: "no-source-openai",
    status: "completed",
    output: [{ type: "message", content: [{ type: "output_text", text: "unsourced" }] }],
  };
  const claude = {
    id: "no-source-claude",
    stop_reason: "end_turn",
    content: [{ type: "text", text: "unsourced" }],
  };
  return Effect.gen(function* () {
    const service = yield* GrokResearch;
    yield* service.configureKey("openai-test", "openai");
    yield* service.configureKey("anthropic-test", "anthropic");
    for (const provider of ["openai", "anthropic"] as const) {
      const result = yield* service
        .run({
          projectId,
          requestId: `unsourced-${provider}`,
          query: "search",
          source: "web",
          provider,
          model: "test-model",
        })
        .pipe(Effect.result);
      expect(result._tag).toBe("Failure");
    }
    expect(commands).toHaveLength(0);
    expect(requests).toHaveLength(2);
  }).pipe(Effect.provide(harness([openai, claude], commands, requests)));
});
const project = Schema.decodeUnknownSync(OrchestrationProjectShell)({
  id: projectId,
  title: "Research",
  workspaceRoot: "D:/test",
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-10-12T00:00:00Z",
  updatedAt: "2026-10-12T00:00:00Z",
});
const queryLayer = Layer.succeed(ProjectionSnapshotQuery, {
  getProjectShellById: (id) =>
    Effect.succeed(id === projectId ? Option.some(project) : Option.none()),
  getCommandReadModel: unexpected,
  getSnapshot: unexpected,
  getShellSnapshot: unexpected,
  getArchivedShellSnapshot: unexpected,
  searchThreads: unexpected,
  getSnapshotSequence: unexpected,
  getCounts: unexpected,
  getActiveProjectByWorkspaceRoot: unexpected,
  getFirstActiveThreadIdByProjectId: unexpected,
  getThreadCheckpointContext: unexpected,
  getFullThreadDiffContext: unexpected,
  getThreadShellById: unexpected,
  getThreadRuntimeContext: () => Effect.die("unused runtime context"),
  getThreadDetailById: unexpected,
  getThreadDetailSnapshot: unexpected,
});
const decodeBody = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
function harness(
  responses: readonly unknown[],
  commands: OrchestrationCommand[],
  requests: { url: string; body: Readonly<Record<string, unknown>> }[],
  limit: number | null = null,
  providerInstances?: ServerSettingsType["providerInstances"],
  capturedHeaders?: Array<Readonly<Record<string, string>>>,
  searchModels: ServerSettingsType["searchModels"] = [],
  transport?: Layer.Layer<HttpClient.HttpClient>,
) {
  const keys = new Map<string, Uint8Array>();
  let index = 0;
  return GrokResearchLive.pipe(
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
    Layer.provide(
      Layer.succeed(OrchestrationEngineService, {
        dispatch: (command) =>
          Effect.sync(() => {
            commands.push(command);
            return { sequence: commands.length };
          }),
        readEvents: () => Stream.empty,
        streamDomainEvents: Stream.empty,
        latestSequence: Effect.succeed(0),
      }),
    ),
    Layer.provide(queryLayer),
    Layer.provideMerge(
      ServerSettings.layerTest({
        aiSearch: { researchDailyUsd: limit },
        searchModels,
        ...(providerInstances ? { providerInstances } : {}),
      }),
    ),
    Layer.provide(
      transport ??
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.sync(() => {
              if (request.body._tag !== "Uint8Array") throw new Error("Expected JSON request");
              requests.push({
                url: request.url,
                body: decodeBody(new TextDecoder().decode(request.body.body)),
              });
              capturedHeaders?.push(request.headers);
              const body = responses[index++];
              return HttpClientResponse.fromWeb(
                request,
                body === "failure"
                  ? new Response("Unavailable", { status: 503 })
                  : body instanceof Response
                    ? body
                    : Response.json(body),
              );
            }),
          ),
        ),
    ),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-grok-research-" })),
    Layer.provideMerge(NodeServices.layer),
  );
}

it.effect(
  "shows Google-grounded Gemini results only in the response and never in RAG or the journal",
  () => {
    const commands: OrchestrationCommand[] = [];
    const requests: { url: string; body: Readonly<Record<string, unknown>> }[] = [];
    const google = {
      responseId: "gemini-google-response",
      candidates: [
        {
          finishReason: "STOP",
          content: { parts: [{ text: "GOOGLE_GROUNDED_RESULT" }] },
          groundingMetadata: {
            searchEntryPoint: {
              renderedContent:
                '<div><a href="https://www.google.com/search?q=example">GOOGLE_SUGGESTION</a></div>',
            },
            groundingChunks: [{ web: { uri: "https://example.com/GOOGLE_SOURCE" } }],
            groundingSupports: [
              {
                segment: { endIndex: 22, text: "GOOGLE_GROUNDED_RESULT" },
                groundingChunkIndices: [0],
              },
            ],
          },
        },
      ],
      usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 4 },
    };
    return Effect.gen(function* () {
      const service = yield* GrokResearch;
      yield* service.configureKey("gemini-secret", "gemini");
      const input: WorkspaceResearchInput = {
        projectId,
        requestId: "google-report",
        query: "질문",
        source: "web",
        provider: "gemini",
        model: "selected-gemini",
        geminiMode: "google",
      };
      const result = yield* service.run(input);
      expect(result).toMatchObject({
        displayOnly: true,
        text: "GOOGLE_GROUNDED_RESULT",
        sources: ["https://example.com/GOOGLE_SOURCE"],
        citations: [{ start: 0, end: 22, url: "https://example.com/GOOGLE_SOURCE" }],
        searchSuggestionsHtml: expect.stringContaining("GOOGLE_SUGGESTION"),
        itemId: null,
      });
      expect(commands).toHaveLength(0);
      expect(requests[0]).toMatchObject({
        url: expect.stringContaining("selected-gemini:generateContent"),
        body: { tools: [{ google_search: {} }] },
      });
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const journal = yield* fs.readFileString(`${config.stateDir}/grok-research/journal.json`);
      expect(journal).not.toContain("GOOGLE_GROUNDED_RESULT");
      expect(journal).not.toContain("GOOGLE_SOURCE");
      expect(journal).not.toContain("GOOGLE_SUGGESTION");
      expect(
        (yield* service
          .run({
            ...input,
            requestId: "illegal-google-source",
            geminiMode: "analysis",
            followUpId: input.requestId,
          })
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
      expect((yield* service.run(input).pipe(Effect.result))._tag).toBe("Failure");
      expect(requests).toHaveLength(1);
    }).pipe(Effect.provide(harness([google], commands, requests)));
  },
);

it.effect("analyzes a selected non-Google search with Gemini without calling Google Search", () => {
  const commands: OrchestrationCommand[] = [];
  const requests: { url: string; body: Readonly<Record<string, unknown>> }[] = [];
  const gemini = {
    responseId: "gemini-analysis",
    candidates: [
      { finishReason: "STOP", content: { parts: [{ text: "자료에 대한 Gemini 분석" }] } },
    ],
  };
  return Effect.gen(function* () {
    const service = yield* GrokResearch;
    yield* service.configureKey("xai-test", "xai");
    yield* service.configureKey("gemini-test", "gemini");
    yield* service.run(query);
    const result = yield* service.run({
      projectId,
      requestId: "gemini-analysis",
      query: "분석해",
      source: "web",
      provider: "gemini",
      model: "chosen-gemini",
      geminiMode: "analysis",
      followUpId: query.requestId,
    });
    expect(result).toMatchObject({
      provider: "gemini",
      text: "자료에 대한 Gemini 분석",
      sources: ["https://docs.x.ai/developers/tools/web-search"],
    });
    expect(requests[1]?.body).not.toHaveProperty("tools");
    expect(yield* encodeJsonFixture(requests[1]?.body)).toContain("공식 문서에서 확인한 결과");
    expect(commands).toHaveLength(2);
  }).pipe(Effect.provide(harness([answer("source-response", 100), gemini], commands, requests)));
});

it.effect("uses custom API web search only when it returns source URLs", () => {
  const commands: OrchestrationCommand[] = [];
  const requests: { url: string; body: Readonly<Record<string, unknown>> }[] = [];
  const customId = ProviderInstanceId.make("custom_search_test");
  const accounts = {
    [customId]: {
      driver: ProviderDriverKind.make("opencode"),
      enabled: true,
      config: {
        apiConnection: {
          providerId: "search_api",
          baseUrl: "https://example.com/v1",
          protocol: "chat-completions",
          models: ["search-model"],
        },
      },
    },
  };
  const response = (id: string, citations: string[]) => ({
    id,
    choices: [{ finish_reason: "stop", message: { content: "조사 결과" } }],
    citations,
  });
  return Effect.gen(function* () {
    const service = yield* GrokResearch;
    const input: WorkspaceResearchInput = {
      projectId,
      requestId: "custom-search-1",
      query: "검색",
      source: "web",
      provider: "custom",
      model: "search-model",
      apiInstanceId: customId,
      customMode: "search",
    };
    const result = yield* service.run(input);
    expect(result.sources).toEqual(["https://example.org/source"]);
    expect(requests[0]?.body).toHaveProperty("web_search_options");
    expect(commands).toHaveLength(1);
    expect(
      (yield* service.run({ ...input, requestId: "custom-search-no-sources" }).pipe(Effect.result))
        ._tag,
    ).toBe("Failure");
    expect(commands).toHaveLength(1);
  }).pipe(
    Effect.provide(
      harness(
        [response("search-ok", ["https://example.org/source"]), response("search-no-source", [])],
        commands,
        requests,
        null,
        accounts,
      ),
    ),
  );
});

it.effect(
  "uses the configured Responses-compatible custom endpoint for sourced web research",
  () => {
    const commands: OrchestrationCommand[] = [];
    const requests: { url: string; body: Readonly<Record<string, unknown>> }[] = [];
    const customId = ProviderInstanceId.make("custom_responses_test");
    const accounts = {
      [customId]: {
        driver: ProviderDriverKind.make("opencode"),
        enabled: true,
        config: {
          apiConnection: {
            providerId: "responses_api",
            baseUrl: "https://example.com/v1",
            protocol: "responses",
            models: ["search-model"],
          },
        },
      },
    };
    return Effect.gen(function* () {
      const service = yield* GrokResearch;
      const result = yield* service.run({
        projectId,
        requestId: "custom-responses-search",
        query: "검색",
        source: "web",
        provider: "custom",
        model: "search-model",
        apiInstanceId: customId,
        customMode: "search",
      });
      expect(result.sources).toEqual(["https://docs.x.ai/developers/tools/web-search"]);
      expect(requests[0]).toMatchObject({
        url: "https://example.com/v1/responses",
        body: { model: "search-model", tools: [{ type: "web_search" }] },
      });
      expect(commands).toHaveLength(1);
    }).pipe(
      Effect.provide(
        harness([answer("custom-response", undefined)], commands, requests, null, accounts),
      ),
    );
  },
);

it.effect("analyzes selected research using a configured OpenAI-compatible account", () => {
  const commands: OrchestrationCommand[] = [];
  const requests: { url: string; body: Readonly<Record<string, unknown>> }[] = [];
  const customId = ProviderInstanceId.make("custom_test");
  const customAccounts = {
    [customId]: {
      driver: ProviderDriverKind.make("opencode"),
      enabled: true,
      displayName: "Local API",
      config: {
        apiConnection: {
          providerId: "local_test",
          baseUrl: "http://127.0.0.1:11434/v1",
          protocol: "chat-completions",
          models: ["local-model"],
        },
      },
      environment: [{ name: "T3_OPENCODE_API_KEY", value: "custom-secret", sensitive: true }],
    },
  };
  const response = {
    id: "custom-response",
    choices: [{ finish_reason: "stop", message: { content: "로컬 분석" } }],
    usage: { prompt_tokens: 100, completion_tokens: 30 },
  };
  return Effect.gen(function* () {
    const service = yield* GrokResearch;
    yield* service.configureKey("xai-test", "xai");
    yield* service.run(query);
    const result = yield* service.run({
      projectId,
      requestId: "custom-analysis",
      query: "분석해",
      source: "web",
      provider: "custom",
      model: "local-model",
      apiInstanceId: customId,
      followUpId: query.requestId,
    });
    expect(result).toMatchObject({
      provider: "custom",
      apiInstanceId: customId,
      text: "로컬 분석",
      sources: ["https://docs.x.ai/developers/tools/web-search"],
    });
    expect(requests[1]?.url).toBe("http://127.0.0.1:11434/v1/chat/completions");
    expect(yield* encodeJsonFixture(requests[1]?.body)).toContain("공식 문서에서 확인한 결과");
    expect(commands).toHaveLength(2);
  }).pipe(
    Effect.provide(
      harness([answer("source-response", 100), response], commands, requests, null, customAccounts),
    ),
  );
});

it.effect(
  "runs OpenAI and Claude web research with separate keys and records unreported cost",
  () => {
    const commands: OrchestrationCommand[] = [];
    const requests: { url: string; body: Readonly<Record<string, unknown>> }[] = [];
    const headers: Array<Readonly<Record<string, string>>> = [];
    const claude = {
      id: "claude-response",
      stop_reason: "end_turn",
      usage: { input_tokens: 20, output_tokens: 10 },
      content: [
        {
          type: "text",
          text: "확인한 결과",
          citations: [{ type: "web_search_result_location", url: "https://example.org/source" }],
        },
      ],
    };
    return Effect.gen(function* () {
      const service = yield* GrokResearch;
      yield* service.configureKey("openai-test-key", "openai");
      yield* service.configureKey("claude-test-key", "anthropic");
      const status = yield* service.status(projectId);
      expect(status.apiKeyReady).toBe(false);
      expect(status.providerKeys).toMatchObject({ xai: false, openai: true, anthropic: true });
      const openai = yield* service.run({
        projectId,
        requestId: "openai-request",
        query: "웹 조사",
        source: "web",
        provider: "openai",
        model: "chosen-openai",
        allowedDomains: ["docs.x.ai"],
      });
      expect(openai).toMatchObject({
        provider: "openai",
        researchModel: "chosen-openai",
        costTicks: null,
      });
      expect(requests[0]).toMatchObject({
        url: "https://api.openai.com/v1/responses",
        body: {
          model: "chosen-openai",
          tools: [{ type: "web_search", filters: { allowed_domains: ["docs.x.ai"] } }],
        },
      });
      const anthropic = yield* service.run({
        projectId,
        requestId: "claude-request",
        query: "웹 조사",
        source: "web",
        provider: "anthropic",
        model: "chosen-claude",
        allowedDomains: ["example.org"],
      });
      expect(anthropic.sources).toEqual(["https://example.org/source"]);
      expect(anthropic.costTicks).toBeNull();
      expect(requests[1]).toMatchObject({
        url: "https://api.anthropic.com/v1/messages",
        body: {
          model: "chosen-claude",
          tools: [
            { type: "web_search_20250305", name: "web_search", allowed_domains: ["example.org"] },
          ],
        },
      });
      expect(headers[0]?.authorization).toBe("Bearer openai-test-key");
      expect(headers[1]?.["x-api-key"]).toBe("claude-test-key");
      expect(headers[1]?.authorization).toBeUndefined();
      expect(commands).toHaveLength(2);
      expect((yield* service.status(projectId)).unreportedCalls).toBe(2);
      expect(
        (yield* service
          .run({
            projectId,
            requestId: "invalid-x",
            query: "X",
            source: "x",
            provider: "anthropic",
            model: "chosen-claude",
          })
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
      expect(requests).toHaveLength(2);
    }).pipe(
      Effect.provide(
        harness(
          [answer("openai-response", undefined), claude],
          commands,
          requests,
          null,
          undefined,
          headers,
        ),
      ),
    );
  },
);

it.effect(
  "saves cited research, deduplicates repeated requests and persists cost without credentials",
  () => {
    const commands: OrchestrationCommand[] = [];
    const requests: { url: string; body: Readonly<Record<string, unknown>> }[] = [];
    return Effect.gen(function* () {
      const service = yield* GrokResearch;
      expect((yield* service.status(projectId)).apiKeyReady).toBe(false);
      yield* service.configureKey("test-research-key-never-log");
      const first = yield* service.run(query);
      expect(first.sources).toEqual(["https://docs.x.ai/developers/tools/web-search"]);
      expect(first.costTicks).toBe(100_000_000);
      yield* service.run(query);
      expect(requests).toHaveLength(1);
      expect(commands[0]).toMatchObject({
        type: "project.knowledge.item.upsert",
        projectId,
        kind: "rag-source",
        research: { verification: "unverified", query: query.query },
      });
      const result = yield* service.status(projectId);
      expect(result.reportedTodayUsd).toBe(0.01);
      expect(result.unreportedCalls).toBe(0);
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const journal = yield* fs.readFileString(`${config.stateDir}/grok-research/journal.json`);
      expect(journal).not.toContain("test-research-key-never-log");
      expect(requests[0]?.body).toMatchObject({
        store: false,
        tools: [
          { type: "web_search", filters: { allowed_domains: ["docs.x.ai"] } },
          {
            type: "x_search",
            allowed_x_handles: ["xai"],
            from_date: query.fromDate,
            to_date: query.toDate,
          },
        ],
      });
      expect((yield* service.run({ ...query, query: "changed" }).pipe(Effect.result))._tag).toBe(
        "Failure",
      );
      expect((yield* service.status(ProjectId.make("other")).pipe(Effect.result))._tag).toBe(
        "Failure",
      );
    }).pipe(Effect.provide(harness([answer("response-one", 100_000_000)], commands, requests)));
  },
);
it.effect(
  "compacts long follow-up state verbatim, accounts for its cost and stops after the daily limit",
  () => {
    const commands: OrchestrationCommand[] = [];
    const requests: { url: string; body: Readonly<Record<string, unknown>> }[] = [];
    const compacted = {
      id: "compact-one",
      output: [
        {
          type: "compaction",
          encrypted_content: "opaque-DONT-CHANGE",
          extra_metadata: { original: true },
        },
      ],
      usage: { cost_in_usd_ticks: 50_000_000 },
    };
    return Effect.gen(function* () {
      const service = yield* GrokResearch;
      yield* service.configureKey("test-key");
      yield* service.run(query);
      yield* service.run({
        ...query,
        requestId: "follow-up",
        followUpId: query.requestId,
        query: "후속 조사",
      });
      expect(requests).toHaveLength(3);
      expect(requests[1]?.url).toContain("/compact");
      expect(requests[2]?.body.input).toEqual([
        compacted.output[0],
        expect.objectContaining({ role: "user" }),
      ]);
      expect(requests[0]?.body.prompt_cache_key).toBe(requests[2]?.body.prompt_cache_key);
      const result = yield* service.status(projectId);
      expect(result.reportedTodayUsd).toBe(0.018);
      expect(result.calls.filter((call) => call.kind === "compaction")).toHaveLength(1);
      expect(
        (yield* service.run({ ...query, requestId: "over-limit" }).pipe(Effect.result))._tag,
      ).toBe("Failure");
      expect(requests).toHaveLength(3);
    }).pipe(
      Effect.provide(
        harness(
          [answer("r1", 100_000_000, 20_000), compacted, answer("r2", 30_000_000)],
          commands,
          requests,
          0.016,
        ),
      ),
    );
  },
);
it.effect("never resends uncertain calls and keeps missing reported costs unknown", () => {
  const commands: OrchestrationCommand[] = [];
  const requests: { url: string; body: Readonly<Record<string, unknown>> }[] = [];
  return Effect.gen(function* () {
    const service = yield* GrokResearch;
    yield* service.configureKey("test-key");
    expect((yield* service.run(query).pipe(Effect.result))._tag).toBe("Failure");
    expect((yield* service.run(query).pipe(Effect.result))._tag).toBe("Failure");
    expect(requests).toHaveLength(1);
    expect((yield* service.status(projectId)).unreportedCalls).toBe(1);
    expect((yield* service.status(projectId)).calls[0]?.status).toBe("uncertain");
    expect((yield* service.run({ ...query, requestId: "new-call" }).pipe(Effect.result))._tag).toBe(
      "Failure",
    );
    expect(commands).toHaveLength(0);
  }).pipe(Effect.provide(harness(["failure"], commands, requests, 1)));
});

it.effect(
  "preserves HTTP and response diagnostics without retrying or saving provider bodies",
  () => {
    const commands: OrchestrationCommand[] = [];
    const requests: { url: string; body: Readonly<Record<string, unknown>> }[] = [];
    return Effect.gen(function* () {
      const service = yield* GrokResearch;
      yield* service.configureKey("test-key");
      for (const status of [401, 429, 503]) {
        const input = { ...query, requestId: `http-${status}` };
        const failure = yield* service.run(input).pipe(Effect.flip);
        expect(failure.message).toContain(`HTTP ${status}`);
        expect(failure.message).not.toContain("SECRET_PROVIDER_BODY");
        if (status === 429) expect(failure.message).not.toContain("소진");
        const saved = (yield* service.status(projectId)).calls.find(
          (call) => call.requestId === input.requestId,
        );
        expect(saved?.status).toBe("uncertain");
        expect(saved?.message).toContain(`HTTP ${status}`);
        yield* service.run(input).pipe(Effect.flip);
      }
      const malformed = yield* service.run({ ...query, requestId: "malformed" }).pipe(Effect.flip);
      expect(malformed.message).toContain("응답 형식이 올바르지 않습니다");
      expect(requests).toHaveLength(4);
      expect(commands).toHaveLength(0);
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const journal = yield* fs.readFileString(`${config.stateDir}/grok-research/journal.json`);
      expect(journal).not.toContain("SECRET_PROVIDER_BODY");
    }).pipe(
      Effect.provide(
        harness(
          [
            new Response("SECRET_PROVIDER_BODY", { status: 401 }),
            new Response("SECRET_PROVIDER_BODY", { status: 429 }),
            new Response("SECRET_PROVIDER_BODY", { status: 503 }),
            { invalid: "SECRET_PROVIDER_BODY" },
          ],
          commands,
          requests,
        ),
      ),
    );
  },
);
it.effect(
  "keeps successful calls with unreported cost unknown and prevents the next capped call",
  () => {
    const commands: OrchestrationCommand[] = [];
    const requests: { url: string; body: Readonly<Record<string, unknown>> }[] = [];
    return Effect.gen(function* () {
      const service = yield* GrokResearch;
      yield* service.configureKey("test-key");
      const result = yield* service.run(query);
      expect(result.costTicks).toBeNull();
      expect(result.status).toBe("complete");
      expect(result.itemId).not.toBeNull();
      expect((yield* service.status(projectId)).unreportedCalls).toBe(1);
      expect((yield* service.run({ ...query, requestId: "next" }).pipe(Effect.result))._tag).toBe(
        "Failure",
      );
      expect(requests).toHaveLength(1);
    }).pipe(Effect.provide(harness([answer("no-cost", undefined)], commands, requests, 1)));
  },
);
it.effect(
  "records incomplete response cost without saving unfinished research or repeating the call",
  () => {
    const commands: OrchestrationCommand[] = [];
    const requests: { url: string; body: Readonly<Record<string, unknown>> }[] = [];
    return Effect.gen(function* () {
      const service = yield* GrokResearch;
      yield* service.configureKey("test-key");
      expect((yield* service.run(query).pipe(Effect.result))._tag).toBe("Failure");
      expect((yield* service.run(query).pipe(Effect.result))._tag).toBe("Failure");
      const status = yield* service.status(projectId);
      expect(status.reportedTodayUsd).toBe(0.01);
      expect(status.calls[0]?.status).toBe("uncertain");
      expect(commands).toHaveLength(0);
      expect(requests).toHaveLength(1);
    }).pipe(
      Effect.provide(
        harness(
          [{ ...answer("incomplete", 100_000_000), status: "incomplete" }],
          commands,
          requests,
        ),
      ),
    );
  },
);
it("does not invent missing cost and ignores unsafe citation URLs", () => {
  const response = answer("r", undefined);
  expect(researchResponseText(response).sources).toHaveLength(1);
  expect(researchCostSummary([], "2026-10-12", projectId)).toEqual({
    reportedTodayUsd: 0,
    projectTodayUsd: 0,
    unreportedCalls: 0,
  });
});

it.effect("serializes concurrent research and deduplicates the same request", () => {
  const commands: OrchestrationCommand[] = [];
  const requests: { url: string; body: Readonly<Record<string, unknown>> }[] = [];
  return Effect.gen(function* () {
    const service = yield* GrokResearch;
    yield* service.configureKey("test-key");
    const other = { ...query, requestId: "concurrent-other" };
    const results = yield* Effect.all(
      [service.run(query), service.run(query), service.run(other)],
      {
        concurrency: "unbounded",
      },
    );
    expect(results[0]?.itemId).toBe(results[1]?.itemId);
    expect(requests).toHaveLength(2);
    const status = yield* service.status(projectId);
    expect(status.calls).toHaveLength(2);
    expect(status.calls.every((call) => call.status === "complete")).toBe(true);
    expect(status.reportedTodayUsd).toBe(0.03);
  }).pipe(
    Effect.provide(
      harness(
        [answer("concurrent-one", 100_000_000), answer("concurrent-two", 200_000_000)],
        commands,
        requests,
      ),
    ),
  );
});

it("preserves valid source offsets across multiple response text blocks", () => {
  const parsed = researchResponseText({
    id: "citation-response",
    output: [
      {
        type: "message",
        content: [
          { type: "output_text", text: "first", annotations: [] },
          {
            type: "output_text",
            text: "source text",
            annotations: [
              {
                type: "url_citation",
                url: "https://example.org/source",
                start_index: 0,
                end_index: 6,
              },
              { type: "url_citation", url: "javascript:alert(1)", start_index: 0, end_index: 3 },
            ],
          },
        ],
      },
    ],
  });
  expect(parsed.text).toBe("first\nsource text");
  expect(parsed.citations).toEqual([{ start: 6, end: 12, url: "https://example.org/source" }]);
});

const orderedInput: WorkspaceResearchInput = {
  projectId,
  requestId: "chain-1",
  query: "When did Beacon launch?",
  source: "web",
};
const sourceUrl = "https://example.org/launch";
const models = [
  { provider: "openai", model: "first" },
  { provider: "xai", model: "second" },
] as const;
type Requests = Array<{ url: string; body: Readonly<Record<string, unknown>> }>;
const report = (id: string, text: string, cost: number | undefined = 50) => ({
  id,
  status: "completed",
  usage: { cost_in_usd_ticks: cost },
  output: [
    {
      type: "message",
      content: [
        { type: "output_text", text, annotations: [{ type: "url_citation", url: sourceUrl }] },
      ],
    },
  ],
});
const grounded = "Beacon launched on May 9. " + sourceUrl;

const qianfanBase = "https://qianfan.baidubce.com/v2";
const restoredId = ProviderInstanceId.make("restored_account");
function searchAccount(baseUrl: string, providerId: string) {
  return {
    driver: ProviderDriverKind.make("opencode"),
    enabled: true,
    environment: [
      { name: OPENCODE_API_KEY_ENV, value: "fixture-research-account", sensitive: true },
    ],
    config: {
      apiConnection: { providerId, baseUrl, protocol: "chat-completions", models: ["same-name"] },
    },
  };
}
const manualInput = {
  ...orderedInput,
  model: "same-name",
  provider: "custom",
  apiInstanceId: restoredId,
} as const;

it.effect(
  "reuses a pre-normalization custom alias reservation after restoring Qianfan settings",
  () => {
    const requests: Requests = [];
    const legacy = { provider: "custom", model: "same-name", apiInstanceId: restoredId } as const;
    const digest = (value: string) =>
      Effect.promise(async () =>
        Buffer.from(
          await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
        ).toString("hex"),
      );
    return Effect.gen(function* () {
      const oldId =
        "ordered-" +
        (yield* digest(
          yield* encodeJsonFixture([orderedInput.requestId, "custom", "same-name", restoredId]),
        ));
      const request = {
        projectId,
        query: orderedInput.query,
        requestId: oldId,
        source: "web",
        ...legacy,
        customMode: "search",
      };
      const fingerprint = yield* digest(
        yield* encodeJsonFixture({
          ...request,
          searchProvider: "custom",
          endpoint: qianfanBase,
          protocol: "chat-completions",
        }),
      );
      const dir = (yield* ServerConfig.ServerConfig).stateDir + "/grok-research";
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(dir, { recursive: true });
      yield* fs.writeFileString(
        dir + "/journal.json",
        yield* encodeJsonFixture({
          version: 1,
          records: [
            {
              ...request,
              kind: "research",
              createdAt: "2026-11-01T00:00:00Z",
              day: "2026-11-01",
              status: "uncertain",
              responseId: null,
              costTicks: null,
              inputTokens: null,
              outputTokens: null,
              cachedTokens: null,
              itemId: null,
              text: "",
              sources: [],
              message: "기존 호출",
              orderedFailure: "insufficient",
              fingerprint,
              history: [],
              keyFingerprint: "fixture",
            },
          ],
        }),
      );
      const result = yield* (yield* GrokResearch).runOrdered(orderedInput);
      expect(result.attempts).toMatchObject([
        { provider: "baidu", result: "insufficient", message: "기존 호출" },
      ]);
      expect(requests).toHaveLength(0);
    }).pipe(
      Effect.provide(
        harness(
          [],
          [],
          requests,
          null,
          { [restoredId]: searchAccount(qianfanBase, "legacy_custom") },
          undefined,
          [legacy],
        ),
      ),
    );
  },
);

it.effect(
  "keeps manual Qianfan search and source analysis on the official host with redirect following disabled",
  () => {
    const requests: Request[] = [];
    const fetch = Object.assign(
      async (...[url, init]: Parameters<typeof globalThis.fetch>) => {
        if (!(url instanceof URL)) throw new Error("Expected a URL from FetchHttpClient");
        requests.push(new Request(url.href, init));
        if (requests.length === 3)
          return Response.redirect("https://elsewhere.example/search", 307);
        return Response.json({
          id: "chat-" + requests.length,
          choices: [{ finish_reason: "stop", message: { content: grounded } }],
          citations: [sourceUrl],
        });
      },
      { preconnect: () => {} },
    );
    const transport = FetchHttpClient.layer.pipe(
      Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)),
    );
    return Effect.gen(function* () {
      const service = yield* GrokResearch;
      const first = yield* service.run({ ...manualInput, customMode: "search" });
      const second = yield* service.run({
        ...manualInput,
        requestId: "analysis",
        customMode: "analysis",
        followUpId: first.requestId,
      });
      expect(second.sources).toEqual(first.sources);
      const redirect = yield* service
        .run({ ...manualInput, customMode: "search", requestId: "redirect" })
        .pipe(Effect.result);
      expect(redirect._tag).toBe("Failure");
      expect(requests.map((req) => [req.url, req.redirect])).toEqual(
        Array(3).fill([qianfanBase + "/chat/completions", "error"]),
      );
      const [search, analysis] = yield* Effect.promise(() =>
        Promise.all(requests.slice(0, 2).map((req) => req.text())),
      );
      expect(search).toContain("web_search_options");
      expect(analysis).not.toContain("web_search_options");
      expect(analysis).toContain(grounded);
    }).pipe(
      Effect.provide(
        harness(
          [],
          [],
          [],
          null,
          { [restoredId]: searchAccount(qianfanBase + "/", "t3_qianfan") },
          undefined,
          [],
          transport,
        ),
      ),
    );
  },
);

it.effect(
  "rejects a restored Qianfan account with a foreign host before manual search or analysis transport",
  () => {
    const requests: Requests = [];
    return Effect.gen(function* () {
      const service = yield* GrokResearch;
      yield* service.configureKey("fixture-source");
      const prior = yield* service.run({ ...orderedInput, requestId: "source" });
      for (const customMode of ["analysis", "search"] as const) {
        const result = yield* service
          .run({
            ...manualInput,
            customMode,
            requestId: customMode,
            ...(customMode === "analysis" ? { followUpId: prior.requestId } : {}),
          })
          .pipe(Effect.result);
        expect(result._tag).toBe("Failure");
      }
      expect(requests.map((r) => r.url)).toEqual(["https://api.x.ai/v1/responses"]);
      expect((yield* service.status(projectId)).calls).toHaveLength(1);
    }).pipe(
      Effect.provide(
        harness(
          [
            report("source", grounded),
            new Response(null, { status: 403 }),
            new Response(null, { status: 403 }),
          ],
          [],
          requests,
          null,
          {
            [restoredId]: searchAccount("https://different.example/v2", "t3_qianfan"),
          },
        ),
      ),
    );
  },
);

it.effect(
  "deduplicates Qianfan aliases by selected instance after a direct settings patch and replays its ledger ID",
  () => {
    const requests: Requests = [];
    const other = ProviderInstanceId.make("another_restored_account");
    const legacy = { provider: "custom", model: "same-name", apiInstanceId: restoredId } as const;
    const baidu = { ...legacy, provider: "baidu" } as const;
    const payload = (id: string) => ({
      request_id: id,
      model: "same-name",
      is_safe: true,
      choices: [{ finish_reason: "stop", message: { role: "assistant", content: "unrelated" } }],
      references: [{ url: sourceUrl }],
    });
    return Effect.gen(function* () {
      const service = yield* GrokResearch;
      const settings = yield* ServerSettings.ServerSettingsService;
      const first = yield* service.runOrdered(orderedInput);
      expect(first.attempts.map((a) => [a.provider, a.result])).toEqual([
        ["baidu", "insufficient"],
      ]);
      yield* settings.updateSettings({
        searchModels: [baidu, legacy, { ...baidu, apiInstanceId: other }],
      });
      const second = yield* service.runOrdered(orderedInput);
      expect(second.attempts.map((a) => a.provider)).toEqual(["baidu", "baidu"]);
      expect(requests.map((r) => r.url)).toEqual(
        Array(2).fill(qianfanBase + "/ai_search/chat/completions"),
      );
      expect((yield* service.status(projectId)).calls.map((c) => c.apiInstanceId)).toEqual([
        other,
        restoredId,
      ]);
    }).pipe(
      Effect.provide(
        harness(
          [payload("one"), payload("two")],
          [],
          requests,
          null,
          {
            [restoredId]: searchAccount(qianfanBase + "/", "legacy_custom"),
            [other]: searchAccount(qianfanBase, "qianfan"),
          },
          undefined,
          [legacy, baidu],
        ),
      ),
    );
  },
);

it.effect(
  "omits the uncited price after a cited launch sentence from the answer and project knowledge",
  () => {
    const commands: OrchestrationCommand[] = [];
    return Effect.gen(function* () {
      const service = yield* GrokResearch;
      yield* service.configureKey("fixture", "openai");
      const result = yield* service.runOrdered(orderedInput);
      expect(result).toMatchObject({
        status: "search-directly",
        text: grounded,
        sources: [sourceUrl],
      });
      expect(commands).toHaveLength(0);
    }).pipe(
      Effect.provide(
        harness(
          [report("mixed", grounded + " It costs $99.")],
          commands,
          [],
          null,
          undefined,
          undefined,
          [models[0]],
        ),
      ),
    );
  },
);

it.effect(
  "advances after an empty success and preserves citations from a truncated response on replay",
  () => {
    const requests: Requests = [];
    const commands: OrchestrationCommand[] = [];
    return Effect.gen(function* () {
      const service = yield* GrokResearch;
      yield* service.configureKey("one", "openai");
      yield* service.configureKey("two", "xai");
      const result = yield* service.runOrdered(orderedInput);
      expect(result.attempts.map((a) => a.result)).toEqual(["insufficient", "insufficient"]);
      expect(result).toMatchObject({
        status: "search-directly",
        text: grounded,
        sources: [sourceUrl],
      });
      expect(yield* service.runOrdered(orderedInput)).toEqual(result);
      expect(requests).toHaveLength(2);
      expect(commands).toHaveLength(0);
    }).pipe(
      Effect.provide(
        harness(
          [
            new Response(null, { status: 204 }),
            {
              ...report("truncated", grounded),
              status: "incomplete",
              incomplete_details: { reason: "max_output_tokens" },
            },
          ],
          commands,
          requests,
          null,
          undefined,
          undefined,
          models,
        ),
      ),
    );
  },
);

it.effect(
  "replays individual attempts, skips display-only and missing accounts, and stops at a supported answer",
  () => {
    const requests: Requests = [];
    const commands: OrchestrationCommand[] = [];
    return Effect.gen(function* () {
      const service = yield* GrokResearch;
      yield* service.configureKey("fixture-one", "openai");
      yield* service.configureKey("fixture-two", "xai");
      const first = yield* service.runOrdered(orderedInput);
      expect(first.status).toBe("answered");
      expect(first.sources).toEqual([sourceUrl]);
      expect(first.attempts.map((a) => a.result)).toEqual([
        "unavailable",
        "unavailable",
        "unavailable",
        "answered",
      ]);
      expect(first.text).toBe(grounded);
      expect(yield* service.runOrdered(orderedInput)).toEqual(first);
      expect(requests.map((r) => r.body.model)).toEqual(["first", "second"]);
      expect((yield* service.status(projectId)).calls.map((r) => r.status)).toEqual([
        "complete",
        "uncertain",
      ]);
      expect(commands.every((c) => c.type === "project.knowledge.item.upsert")).toBe(true);
      expect(new Set(commands.map((c) => c.commandId)).size).toBe(1);
    }).pipe(
      Effect.provide(
        harness(
          ["failure", report("grounded", grounded)],
          commands,
          requests,
          null,
          undefined,
          undefined,
          [
            { provider: "gemini", model: "display" },
            { provider: "custom", model: "second", apiInstanceId: "absent" },
            ...models,
            { provider: "openai", model: "should-not-run" },
          ],
        ),
      ),
    );
  },
);

it.effect(
  "keeps cited partial evidence across exhausted candidates, omitting unrelated material and raw unverified claims",
  () => {
    const requests: Requests = [];
    const commands: OrchestrationCommand[] = [];
    return Effect.gen(function* () {
      const service = yield* GrokResearch;
      yield* service.configureKey("fixture-one", "openai");
      yield* service.configureKey("fixture-two", "xai");
      const result = yield* service.runOrdered(orderedInput);
      expect(result.status).toBe("search-directly");
      expect(result.text).toBe(grounded);
      expect(result.sources).toEqual([sourceUrl]);
      expect(result.attempts.map((a) => a.result)).toEqual(["insufficient", "insufficient"]);
      expect(yield* service.runOrdered(orderedInput)).toEqual(result);
      expect(requests).toHaveLength(2);
      expect(commands).toHaveLength(0);
    }).pipe(
      Effect.provide(
        harness(
          [
            report(
              "partial",
              grounded + "\nSEARCH_INSUFFICIENT\nThere are additional unsupported claims.",
            ),
            report("unrelated", "Saturn has rings. " + sourceUrl),
          ],
          commands,
          requests,
          null,
          undefined,
          undefined,
          models,
        ),
      ),
    );
  },
);

for (const [name, response] of [
  ["permission denied", new Response(null, { status: 403 })],
  [
    "provider safety refusal",
    {
      id: "denied",
      output: [{ type: "message", content: [{ type: "refusal", refusal: "declined" }] }],
    },
  ],
  ["unreported cost with daily cap", { ...report("unknown", ""), usage: {} }],
  ["reached daily cap", report("at-limit", "", 1e10)],
] as const) {
  it.effect("stops on " + name + " and cannot route around it on replay", () => {
    const requests: Requests = [];
    return Effect.gen(function* () {
      const service = yield* GrokResearch;
      yield* service.configureKey("one", "openai");
      yield* service.configureKey("two", "xai");
      for (const _ of [1, 2])
        expect((yield* service.runOrdered(orderedInput).pipe(Effect.result))._tag).toBe("Failure");
      expect(requests).toHaveLength(1);
    }).pipe(Effect.provide(harness([response], [], requests, 1, undefined, undefined, models)));
  });
}

it.effect("keeps native source restrictions and checks project scope before an empty chain", () => {
  const requests: Requests = [];
  return Effect.gen(function* () {
    const service = yield* GrokResearch;
    const result = yield* service.runOrdered({ ...query, source: "x" });
    expect(result.attempts.map((a) => a.result)).toEqual(["unavailable"]);
    expect(
      (yield* service
        .runOrdered({ ...orderedInput, projectId: ProjectId.make("absent") })
        .pipe(Effect.result))._tag,
    ).toBe("Failure");
    expect(requests).toHaveLength(0);
  }).pipe(Effect.provide(harness([], [], requests, null, undefined, undefined, [models[0]])));
});

it.effect(
  "uses only the selected Qianfan account and records native search in the ordinary ledger",
  () => {
    const requests: Requests = [];
    const headers: Array<Readonly<Record<string, string>>> = [];
    const account = (key: string) => ({
      driver: ProviderDriverKind.make("opencode"),
      enabled: true,
      environment: [{ name: OPENCODE_API_KEY_ENV, value: key, sensitive: true }],
      config: {
        apiConnection: {
          providerId: "t3_qianfan",
          baseUrl: "https://qianfan.baidubce.com/v2",
          protocol: "chat-completions",
          models: ["same-name"],
        },
      },
    });
    return Effect.gen(function* () {
      const service = yield* GrokResearch;
      const input = { ...orderedInput, allowedDomains: ["example.org"] };
      const result = yield* service.runOrdered(input);
      expect(result.attempts.map((a) => [a.provider, a.result])).toEqual([
        ["baidu", "unavailable"],
        ["baidu", "answered"],
      ]);
      expect(yield* service.runOrdered(input)).toEqual(result);
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        url: "https://qianfan.baidubce.com/v2/ai_search/chat/completions",
        body: {
          model: "same-name",
          search_mode: "required",
          search_filter: { match: { site: ["example.org"] } },
        },
      });
      expect(headers[0]?.authorization).toBe("Bearer fixture-selected-account");
      expect((yield* service.status(projectId)).calls).toMatchObject([
        {
          provider: "custom",
          apiInstanceId: "qianfan_selected",
          researchModel: "same-name",
          responseId: "baidu-id",
          costTicks: null,
          inputTokens: 20,
        },
      ]);
    }).pipe(
      Effect.provide(
        harness(
          [
            {
              request_id: "baidu-id",
              model: "same-name",
              is_safe: true,
              choices: [
                { finish_reason: "stop", message: { role: "assistant", content: grounded } },
              ],
              references: [{ url: sourceUrl }],
              usage: { prompt_tokens: 20, completion_tokens: 6 },
            },
          ],
          [],
          requests,
          null,
          {
            [ProviderInstanceId.make("qianfan_other")]: account("fixture-other-account"),
            [ProviderInstanceId.make("qianfan_selected")]: account("fixture-selected-account"),
          },
          headers,
          [
            { provider: "baidu", model: "same-name", apiInstanceId: "qianfan_missing" },
            { provider: "baidu", model: "same-name", apiInstanceId: "qianfan_selected" },
          ],
        ),
      ),
    );
  },
);
