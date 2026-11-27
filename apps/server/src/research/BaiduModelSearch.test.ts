import * as NodeUtil from "node:util";
import { OPENCODE_API_KEY_ENV, ProviderInstanceConfig } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { FetchHttpClient } from "effect/unstable/http";
import { expect, it } from "@effect/vitest";
import { afterEach, beforeEach, vi } from "vite-plus/test";
import {
  type BaiduModelSearchInput,
  isBaiduModelSearchAccount,
  runBaiduModelSearch,
} from "./BaiduModelSearch.ts";

const baseUrl = "https://qianfan.baidubce.com/v2";
const model = "ERNIE-Fixture/Exact";
const key = "fixture-only/selected-key";
const connection = {
  providerId: "t3_qianfan",
  baseUrl,
  protocol: "chat-completions",
  models: ["other-model", model],
};
const environment = [{ name: OPENCODE_API_KEY_ENV, value: key, sensitive: true }];
const decodeInstance = Schema.decodeUnknownSync(ProviderInstanceConfig);
const account = (overrides: Record<string, unknown> = {}) =>
  decodeInstance({
    driver: "opencode",
    displayName: "Shared display name",
    enabled: true,
    config: { apiConnection: connection },
    environment,
    ...overrides,
  });
const apiInstanceId = "qianfan_selected";
const other = account({ environment: [{ ...environment[0], value: "fixture-only/other-key" }] });
const input: BaiduModelSearchInput = {
  providerInstances: { qianfan_other: other, [apiInstanceId]: account() },
  apiInstanceId,
  model,
  query: "합성 검색어",
};
const article = "https://news.example.test/primary";
const choice = {
  finish_reason: "stop",
  message: { role: "assistant", content: "Search evidence [1]." },
};
const payload = { choices: [choice], is_safe: true, references: [{ id: 1, url: article }] };

beforeEach(() =>
  vi.stubGlobal("fetch", () => {
    throw new Error("Network disabled in this test");
  }),
);
afterEach(() => vi.unstubAllGlobals());

// Exercise the server's actual fetch transport with an in-process replacement for its only I/O.
function fixture(respond: () => Response, selected: BaiduModelSearchInput = input) {
  const requests: Request[] = [];
  const fetchMock = Object.assign(
    async (...[url, init]: Parameters<typeof globalThis.fetch>) => {
      if (!(url instanceof URL)) throw new Error("Expected a fetch transport URL");
      requests.push(new Request(url.href, init));
      return respond();
    },
    { preconnect: vi.fn() },
  );
  const operation = runBaiduModelSearch(selected).pipe(
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
  "uses the selected account key and exact model in one forced search and returns only structured evidence",
  () =>
    Effect.gen(function* () {
      const test = fixture(
        () =>
          Response.json({
            ...payload,
            model,
            references: [...payload.references, { url: article }, { url: "http://example.test" }],
            request_id: "fixture-response",
            usage: { prompt_tokens: 12, completion_tokens: 4 },
          }),
        { ...input, allowedDomains: ["example.test"], instructions: "Return a short answer." },
      );
      expect(yield* test.success).toEqual({
        text: choice.message.content,
        sources: [article, "http://example.test/"],
        citations: [],
        responseId: "fixture-response",
        inputTokens: 12,
        outputTokens: 4,
      });
      expect(test.requests).toHaveLength(1);
      const request = test.requests[0]!;
      expect(request.url).toBe(baseUrl + "/ai_search/chat/completions");
      expect(request.method).toBe("POST");
      expect(request.redirect).toBe("manual");
      expect(request.headers.get("authorization")).toBe("Bearer " + key);
      expect(yield* Effect.promise(() => request.json())).toEqual({
        model,
        messages: [{ role: "user", content: input.query }],
        stream: false,
        search_mode: "required",
        search_source: "baidu_search_v2",
        search_filter: { match: { site: ["example.test"] } },
        instruction: "Return a short answer.",
      });
    }),
);

it.effect("accepts the saved trailing slash and reports omitted usage and ID as unknown", () =>
  Effect.gen(function* () {
    const saved = account({
      config: { apiConnection: { ...connection, providerId: "qianfan", baseUrl: baseUrl + "/" } },
    });
    const test = fixture(() => Response.json(payload), {
      ...input,
      providerInstances: { [apiInstanceId]: saved },
    });
    expect(yield* test.success).toMatchObject({
      sources: [article],
      responseId: null,
      inputTokens: null,
      outputTokens: null,
    });
    expect(yield* Effect.promise(() => test.requests[0]!.json())).not.toHaveProperty(
      "search_filter",
    );
  }),
);

it("recognizes saved Qianfan identities even if their connection is damaged", () => {
  const broken = account({
    config: { apiConnection: { providerId: "qianfan", baseUrl: "https://wrong.invalid/v2" } },
  });
  expect(isBaiduModelSearchAccount("manual", broken)).toBe(true);
  expect(isBaiduModelSearchAccount(apiInstanceId, undefined)).toBe(true);
  expect(isBaiduModelSearchAccount("manual", account())).toBe(true);
  expect(
    isBaiduModelSearchAccount(
      "manual",
      account({
        config: {
          apiConnection: {
            ...connection,
            providerId: "other",
            baseUrl: "https://other.invalid/v2",
          },
        },
      }),
    ),
  ).toBe(false);
});

it.effect.each([
  "https://qianfan.baidubce.com.attacker.invalid/v2",
  "https://qianfan.baidubce.com@attacker.invalid/v2",
  "http://qianfan.baidubce.com/v2",
  "https://qianfan.baidubce.com:8443/v2",
  baseUrl + "/custom",
  baseUrl + "?target=other",
  baseUrl + "#alt",
])("rejects modified base %s before any request", (baseUrl) =>
  Effect.gen(function* () {
    const selected = account({ config: { apiConnection: { ...connection, baseUrl } } });
    const test = fixture(() => Response.json(payload), {
      ...input,
      providerInstances: { [apiInstanceId]: selected },
    });
    expect(yield* test.error).toMatchObject({ code: "configuration", retryable: false });
    expect(test.requests).toHaveLength(0);
  }),
);

it.effect.each([
  ["disabled instance", account({ enabled: false })],
  ["disabled driver config", account({ config: { enabled: false, apiConnection: connection } })],
  ["another driver", account({ driver: "codex" })],
  ["redacted key", account({ environment: [{ ...environment[0], valueRedacted: true }] })],
  ["missing key", account({ environment: [] })],
  [
    "wrong protocol",
    account({ config: { apiConnection: { ...connection, protocol: "responses" } } }),
  ],
  [
    "model only in the other account",
    account({ config: { apiConnection: { ...connection, models: [model.toLowerCase()] } } }),
  ],
] as const)("never borrows another account for %s", ([_label, selected]) =>
  Effect.gen(function* () {
    const test = fixture(() => Response.json(payload), {
      ...input,
      providerInstances: { ...input.providerInstances, [apiInstanceId]: selected },
    });
    expect(yield* test.error).toMatchObject({ code: "configuration", retryable: false });
    expect(test.requests).toHaveLength(0);
  }),
);

it.effect.each([
  ["missing ID", { ...input, apiInstanceId: "unknown" }, "configuration"],
  ["inherited ID", { ...input, apiInstanceId: "constructor" }, "configuration"],
  ["empty query", { ...input, query: "  " }, "request"],
] as const)("rejects %s locally", ([_label, selected, code]) =>
  Effect.gen(function* () {
    const test = fixture(() => Response.json(payload), selected);
    expect(yield* test.error).toMatchObject({ code, retryable: false });
    expect(test.requests).toHaveLength(0);
  }),
);

it.effect("never follows a redirect carrying the selected credential", () =>
  Effect.gen(function* () {
    const test = fixture(() =>
      Response.redirect("https://another.invalid/" + encodeURIComponent(key), 307),
    );
    const error = yield* test.error;
    expect(error).toMatchObject({ code: "redirect", httpStatus: 307, retryable: false });
    expect(test.requests.map((r) => [r.url, r.redirect])).toEqual([
      [baseUrl + "/ai_search/chat/completions", "manual"],
    ]);
    expect(NodeUtil.inspect(error)).not.toContain("another.invalid");
  }),
);

it.effect.each([
  ["prose URL only", { choices: [{ ...choice, message: { content: "See " + article } }] }],
  ["no references", { ...payload, references: [] }],
  [
    "media URLs and metadata only",
    { ...payload, references: [{ icon: article, image: { url: article }, title: article }] },
  ],
  [
    "invalid links",
    {
      ...payload,
      references: [
        null,
        { url: "/relative" },
        { url: "file:///path" },
        { url: "javascript:void(0)" },
        { url: "https://user:pass@example.test" },
      ],
    },
  ],
])("returns missing_sources for %s", ([_label, result]) =>
  Effect.gen(function* () {
    const test = fixture(() => Response.json(result));
    expect(yield* test.error).toMatchObject({ code: "missing_sources", httpStatus: 200 });
    expect(test.requests).toHaveLength(1);
  }),
);

it.effect(
  "rejects an answer citing outside the requested domains even if it also cites an allowed URL",
  () =>
    Effect.gen(function* () {
      const test = fixture(
        () =>
          Response.json({
            ...payload,
            references: [...payload.references, { url: "https://badexample.test/report" }],
          }),
        { ...input, allowedDomains: ["example.test"] },
      );
      expect(yield* test.error).toMatchObject({ code: "missing_sources", retryable: false });
    }),
);

it.effect.each([
  [
    "empty content",
    { ...payload, choices: [{ ...choice, message: { content: " " } }] },
    "insufficient",
  ],
  [
    "truncated result",
    { ...payload, choices: [{ ...choice, finish_reason: "length" }] },
    "insufficient",
  ],
  [
    "filtered empty result",
    { ...payload, choices: [{ finish_reason: "content_filter", message: { content: "" } }] },
    "policy",
  ],
  ["unsafe input", { ...payload, is_safe: false }, "policy"],
  ["different model", { ...payload, model: "other-model" }, "invalid_response"],
  ["malformed error code", { ...payload, code: { bad: true } }, "invalid_response"],
] as const)("distinguishes %s from grounded success", ([_label, result, code]) =>
  Effect.gen(function* () {
    const test = fixture(() => Response.json(result));
    const error = yield* test.error;
    expect(error.code).toBe(code);
    if (code === "policy") expect(error.retryable).toBe(false);
  }),
);

it.effect.each([
  [200, "InternalError", "upstream", true],
  [200, "InvalidArgument", "request", false],
  [200, 216003, "authentication", false],
  [401, "", "authentication", false],
  [403, "", "authentication", false],
  [429, "RATE_LIMIT_SEARCH_QPS", "rate_limit", true],
  [429, "QUOTA_USER_DAILY_FREE", "quota", false],
  [429, "BILLING_INSUFFICIENT_BALANCE", "quota", false],
  [503, "", "upstream", true],
] as const)(
  "classifies HTTP %s code %s without retrying or exposing the provider message",
  ([status, providerCode, code, retryable]) =>
    Effect.gen(function* () {
      const test = fixture(() =>
        Response.json({ ...payload, code: providerCode, message: "raw " + key }, { status }),
      );
      const error = yield* test.error;
      expect(error).toMatchObject({ code, retryable, httpStatus: status });
      expect(NodeUtil.inspect(error)).not.toContain(key);
      expect(test.requests).toHaveLength(1);
    }),
);

it.effect("sanitizes fetch exceptions and invalid upstream bodies", () =>
  Effect.gen(function* () {
    const unavailable = fixture(() => {
      throw new Error(key);
    });
    const error = yield* unavailable.error;
    expect(error).toMatchObject({ code: "transport", retryable: true, httpStatus: null });
    expect(NodeUtil.inspect(error)).not.toContain(key);
    expect(unavailable.requests).toHaveLength(1);
    const unreadable = fixture(() => new Response(key, { status: 502 }));
    expect(yield* unreadable.error).toMatchObject({ code: "upstream", httpStatus: 502 });
  }),
);

it.effect.each([
  { choices: [{ ...choice, message: { content: key } }] },
  { references: [{ url: article + "?value=" + encodeURIComponent(key) }] },
  { request_id: key },
])("withholds any returned field echoing the credential", (fields) =>
  Effect.gen(function* () {
    const test = fixture(() => Response.json({ ...payload, ...fields }));
    const error = yield* test.error;
    expect(error.code).toBe("invalid_response");
    expect(NodeUtil.inspect(error)).not.toContain(key);
  }),
);
