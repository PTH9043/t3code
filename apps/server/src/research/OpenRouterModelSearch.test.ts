import { OPENCODE_API_KEY_ENV, ProviderInstanceConfig } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { FetchHttpClient } from "effect/unstable/http";
import { expect, it } from "@effect/vitest";
import { afterEach, beforeEach, vi } from "vite-plus/test";
import {
  OPENROUTER_BASE_URL,
  type OpenRouterModelSearchInput,
  isOpenRouterModelSearchAccount,
  modelHasNativeWebSearch,
  runOpenRouterModelSearch,
} from "./OpenRouterModelSearch.ts";

const key = "sk-or-v1-fixture-selected-key";
const apiInstanceId = "openrouter_selected";
const decodeInstance = Schema.decodeUnknownSync(ProviderInstanceConfig);
const account = (overrides: Record<string, unknown> = {}) =>
  decodeInstance({
    driver: "opencode",
    displayName: "OpenRouter",
    enabled: true,
    config: {
      apiConnection: {
        providerId: "t3_openrouter",
        baseUrl: OPENROUTER_BASE_URL,
        protocol: "chat-completions",
        models: ["perplexity/sonar"],
      },
    },
    environment: [{ name: OPENCODE_API_KEY_ENV, value: key, sensitive: true }],
    ...overrides,
  });

const baseInput: OpenRouterModelSearchInput = {
  providerInstances: { [apiInstanceId]: account() },
  apiInstanceId,
  model: "openai/gpt-4o-mini",
  query: "최신 뉴스 검색",
};

const article = "https://docs.example.test/release";

beforeEach(() =>
  vi.stubGlobal("fetch", () => {
    throw new Error("Network disabled in this test");
  }),
);
afterEach(() => vi.unstubAllGlobals());

function fixture(respond: () => Response, selected: OpenRouterModelSearchInput = baseInput) {
  const requests: Request[] = [];
  const fetchMock = Object.assign(
    async (...[url, init]: Parameters<typeof globalThis.fetch>) => {
      if (!(url instanceof URL)) throw new Error("Expected a fetch transport URL");
      requests.push(new Request(url.href, init));
      return respond();
    },
    { preconnect: vi.fn() },
  );
  const operation = runOpenRouterModelSearch(selected).pipe(
    Effect.provide(FetchHttpClient.layer),
    Effect.provideService(FetchHttpClient.Fetch, fetchMock),
  );
  return {
    requests,
    success: operation,
    error: Effect.flip(operation),
  };
}

it.effect(
  "attaches OpenRouter web plugin for standard models, parses nested url_citation and usage.cost",
  () =>
    Effect.gen(function* () {
      const test = fixture(
        () =>
          Response.json({
            id: "gen-openrouter-1",
            choices: [
              {
                finish_reason: "stop",
                message: {
                  content: "확인된 최신 릴리스 정보입니다.",
                  annotations: [
                    {
                      type: "url_citation",
                      url_citation: { url: article, start_index: 0, end_index: 12 },
                    },
                  ],
                },
              },
            ],
            usage: {
              prompt_tokens: 100,
              completion_tokens: 50,
              cost: 0.00125,
              prompt_tokens_details: { cached_tokens: 20 },
            },
          }),
        { ...baseInput, allowedDomains: ["example.test"], instructions: "간결히 답하세요." },
      );
      expect(yield* test.success).toEqual({
        text: "확인된 최신 릴리스 정보입니다.",
        sources: [article],
        citations: [{ start: 0, end: 12, url: article }],
        responseId: "gen-openrouter-1",
        costTicks: 12_500_000,
        inputTokens: 100,
        outputTokens: 50,
        cachedTokens: 20,
      });
      expect(test.requests).toHaveLength(1);
      const req = test.requests[0]!;
      expect(req.url).toBe(OPENROUTER_BASE_URL + "/chat/completions");
      expect(req.headers.get("authorization")).toBe("Bearer " + key);
      expect(req.headers.get("x-title")).toBe("T3 Code");
      const body = (yield* Effect.promise(() => req.json())) as {
        model?: string;
        plugins?: unknown;
      };
      expect(body.model).toBe("openai/gpt-4o-mini");
      expect(body.plugins).toEqual([{ id: "web", max_results: 5 }]);
    }),
);

it.effect(
  "omits redundant web plugin for native search models like perplexity/sonar and :online",
  () =>
    Effect.gen(function* () {
      expect(modelHasNativeWebSearch("perplexity/sonar")).toBe(true);
      expect(modelHasNativeWebSearch("baidu/ernie-4.5-300b-a47b:online")).toBe(true);
      expect(modelHasNativeWebSearch("openai/gpt-4o-mini")).toBe(false);

      const test = fixture(
        () =>
          Response.json({
            id: "gen-sonar-1",
            choices: [{ finish_reason: "stop", message: { content: "Sonar 검색 결과입니다." } }],
            citations: [article],
          }),
        { ...baseInput, model: "perplexity/sonar" },
      );
      const result = yield* test.success;
      expect(result.sources).toEqual([article]);
      const body = yield* Effect.promise(() => test.requests[0]!.json());
      expect(body).not.toHaveProperty("plugins");
    }),
);

it.effect("maps HTTP 402 to quota failure and 401 to authentication failure", () =>
  Effect.gen(function* () {
    const quota = fixture(() => Response.json({ error: { code: 402 } }, { status: 402 }));
    expect(yield* quota.error).toMatchObject({ code: "quota", httpStatus: 402, retryable: false });

    const auth = fixture(() => Response.json({ error: { code: 401 } }, { status: 401 }));
    expect(yield* auth.error).toMatchObject({
      code: "authentication",
      httpStatus: 401,
      retryable: false,
    });
  }),
);

it("recognizes OpenRouter accounts by id prefix, providerId, or official baseUrl", () => {
  expect(isOpenRouterModelSearchAccount("openrouter_abc", undefined)).toBe(true);
  expect(isOpenRouterModelSearchAccount("manual", account())).toBe(true);
  expect(
    isOpenRouterModelSearchAccount(
      "manual",
      account({
        config: {
          apiConnection: {
            providerId: "t3_api",
            baseUrl: OPENROUTER_BASE_URL + "/",
            protocol: "chat-completions",
            models: ["perplexity/sonar"],
          },
        },
      }),
    ),
  ).toBe(true);
});
