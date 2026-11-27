import { expect, it, vi } from "vite-plus/test";
import {
  createLocalGenerator,
  normalizePage,
  summarizeAll,
  validateAnswer,
  type PageRequest,
} from "./summary.ts";
import { createTelegramCli, generateWithClaude } from "./cli.ts";
import { ProviderInstanceId, ServerSettings } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import type { query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

const source = "모임은 12월 7일에 열린다.";
const req = { prompt: JSON.stringify([{ number: 1, text: source }]), count: 1 };
const answer = JSON.stringify({
  summary: "12월 7일 모임이 예정돼 있습니다.",
  evidence: [{ number: 1, quote: "12월 7일" }],
});
const signal = new AbortController().signal;
const decodeSettings = Schema.decodeUnknownSync(ServerSettings);

it("routes to the chosen registered CLI and explains unavailable drivers while keeping Max 5x/20x custom models", async () => {
  const instances = ["Max 5x", "Max 20x", "Other"].map((account, index) => ({
    enabled: true,
    instanceId: ProviderInstanceId.make("sub" + index),
    displayName: account,
    driverKind: index === 2 ? "grok" : "claudeAgent",
    snapshot: {
      getSnapshot: Effect.succeed({
        enabled: true,
        installed: true,
        auth: { status: "authenticated", type: account },
        models: [{ slug: "custom-official-id", isCustom: true }],
      }),
    },
  }));
  const services = {
    registry: { listInstances: Effect.succeed(instances as unknown as ProviderInstance[]) },
    settings: {
      getSettings: Effect.succeed(
        decodeSettings({
          providerInstances: Object.fromEntries(
            instances.map((i) => [
              i.instanceId,
              { driver: i.driverKind, enabled: true, config: {} },
            ]),
          ),
        }),
      ),
    },
  };
  const extraId = ProviderInstanceId.make("registered-codex");
  const generate = vi.fn(async () => answer);
  const adapter = createTelegramCli(services, [
    {
      listModels: async () => [
        { instanceId: extraId, accountLabel: "로그인 계정", modelId: "exact" },
      ],
      generate,
    },
  ]);
  const choices = await adapter.listModels();
  expect(choices.map((m) => m.accountLabel)).toEqual(["Max 5x", "Max 20x", "로그인 계정"]);
  expect((await adapter.unsupported!(choices)).map((row) => row.driver)).toEqual(["grok"]);
  await expect(
    adapter.generate(
      { instanceId: extraId, modelId: "other", allowExternalTransfer: true },
      req,
      signal,
    ),
  ).rejects.toThrow();
  expect(generate).not.toHaveBeenCalled();
  await adapter.generate(
    { instanceId: extraId, modelId: "exact", allowExternalTransfer: true },
    req,
    signal,
  );
  expect(generate).toHaveBeenCalledOnce();
});

it("requires an actual source quotation and a valid input ID", () => {
  expect(validateAnswer(answer, req).evidence[0]?.quote).toBe("12월 7일");
  expect(() => validateAnswer(answer.replace('12월 7일"}', '다른 날짜"}'), req)).toThrow();
  expect(() => validateAnswer(answer.replace('"number":1', '"number":9'), req)).toThrow();
});
it("excludes standalone English claims while keeping technical names in Korean sentences and all exact evidence", () => {
  const evidence = [{ number: 1, quote: source }];
  const summary = "English heading | API 모임입니다. unrelated lowercase claim. SDK를 소개합니다.";
  expect(validateAnswer(JSON.stringify({ summary, evidence }), req)).toEqual({
    summary: "API 모임입니다. SDK를 소개합니다.",
    evidence,
  });
});
it("reduces every part of oversized messages, verifies both levels and keeps original provenance", async () => {
  const seen: string[] = [];
  const note = await summarizeAll(
    [
      { source: "42", text: "공개 ".repeat(5000) + "마지막 본문" },
      { source: "43", text: "다음 자료" },
    ],
    async (r) => {
      expect(Buffer.byteLength(r.prompt)).toBeLessThanOrEqual(8000);
      const entries = JSON.parse(r.prompt) as { text: string; number: number }[];
      seen.push(...entries.map((i) => i.text));
      return validateAnswer(
        JSON.stringify({
          summary: "공개 자료의 일정을 요약했습니다.",
          evidence: entries.map((i) => ({ number: i.number, quote: i.text.trim().slice(0, 12) })),
        }),
        r,
      );
    },
  );
  expect(seen.join("")).toContain("마지막 본문");
  expect(seen).toContain("다음 자료");
  expect(seen).toContain("공개 자료의 일정을 요약했습니다.");
  expect(note.refs).toEqual(["42", "43"]);
  expect(note.evidence.filter((e) => e.source === "42").length).toBeGreaterThan(1);
  expect(note.evidence).toContainEqual({ source: "43", quote: "다음 자료" });
  expect(note.evidence.some((e) => e.quote.includes("일정을 요약"))).toBe(false);
});
it("validates the installed model family and completes on the second local family before considering a CLI", async () => {
  const posts: Array<[string, Record<string, unknown>]> = [];
  const gen = createLocalGenerator(async (path, payload) => {
    const body = payload as Record<string, unknown>;
    posts.push([path, body]);
    if (path === "/api/show")
      return {
        details: { family: body.model === "granite4.1:8b" ? "wrong" : "qwen2", format: "gguf" },
        model_info: { "general.parameter_count": 100 },
        capabilities: ["completion"],
      };
    return { done: true, done_reason: "stop", model: body.model, response: answer };
  });
  expect(await gen(req, signal)).toBe(answer);
  expect(posts.map(([path, b]) => [path, b.model])).toEqual([
    ["/api/show", "granite4.1:8b"],
    ["/api/show", "qwen2.5-coder:14b"],
    ["/api/generate", "qwen2.5-coder:14b"],
  ]);
  expect(JSON.parse(String(posts[2]![1].prompt))).toEqual([{ id: "S1", text: source }]);
});

it("binds each selected passage to its exact message and preserves previously verified quotes", async () => {
  const text = "가".repeat(159) + "😀 다음 모임은 토요일입니다.";
  const request = {
    prompt: JSON.stringify([
      { number: 1, text: source },
      { number: 2, text },
    ]),
    count: 2,
  };
  const gen = createLocalGenerator(async (path, payload) => {
    const body = payload as {
      model: string;
      prompt: string;
      format: { properties: { evidence: { items: { enum: string[] } } } };
    };
    if (path === "/api/show")
      return {
        details: { family: "granite", format: "gguf" },
        model_info: { "general.parameter_count": 100 },
        capabilities: ["completion"],
      };
    const spans = JSON.parse(body.prompt) as { id: string; text: string }[];
    expect(body.format.properties.evidence.items.enum).toEqual(spans.map((s) => s.id));
    expect(spans.map((s) => s.text)).toEqual([
      source,
      "가".repeat(159),
      "😀 다음 모임은 토요일입니다.",
    ]);
    return {
      done: true,
      done_reason: "stop",
      model: body.model,
      response: JSON.stringify({
        summary: "모임은 토요일입니다. An unrelated English claim.",
        evidence: [spans[2]!.id, { number: 1, quote: "12월 7일" }, spans[0]!.id],
      }),
    };
  });
  expect(validateAnswer(await gen(request, signal), request)).toEqual({
    summary: "모임은 토요일입니다.",
    evidence: [
      { number: 2, quote: "😀 다음 모임은 토요일입니다." },
      { number: 1, quote: "12월 7일" },
      { number: 1, quote: source },
    ],
  });
});

it.each([
  { summary: "모임이 있습니다.", evidence: ["S9"] },
  { summary: "모임이 있습니다.", evidence: [{ number: 1, quote: "원문에 없는 구절" }] },
  { summary: "Only an English claim.", evidence: ["S1"] },
  { summary: "모임이 있습니다. https://example.test", evidence: ["S1"] },
  { summary: "모임이 있습니다. " + "English ".repeat(120), evidence: ["S1"] },
])(
  "rejects unsupported local answers with the canonical citation and summary checks",
  async (reply) => {
    const gen = createLocalGenerator(async (path, payload) => {
      const { model } = payload as { model: string };
      if (path === "/api/show")
        return {
          details: { family: model === "granite4.1:8b" ? "granite" : "qwen2", format: "gguf" },
          model_info: { "general.parameter_count": 100 },
          capabilities: ["completion"],
        };
      return { model, done: true, done_reason: "stop", response: JSON.stringify(reply) };
    });
    await expect(gen(req, signal)).rejects.toThrow("근거 있는 한국어 요약");
  },
);
it("canonicalizes links from marked peer and message IDs, and accepts a verified public handle", () => {
  const pageReq: PageRequest = {
    channel: "@public",
    peerId: "-1010000000321",
    afterId: 0,
    limit: 100,
    signal,
  };
  const m = {
    id: 3,
    date: "2026-11-01T05:00:00+02:00",
    text: "안녕",
    link: "https://t.me/evil/3?x=y",
  };
  const p = {
    peerId: pageReq.peerId,
    messages: [m],
    unavailableIds: [],
    endReached: true,
    continuation: 3,
  };
  expect(normalizePage(p, pageReq).messages[0]).toMatchObject({
    date: "2026-11-01T03:00:00.000Z",
    link: "https://t.me/c/10000000321/3",
  });
  expect(
    normalizePage({ ...p, messages: [{ ...m, link: "https://t.me/public/3" }] }, pageReq)
      .messages[0]?.link,
  ).toBe("https://t.me/public/3");
  expect(() => normalizePage({ ...p, continuation: 12 }, pageReq)).toThrow();
});

it("checks the launched CLI account and exact model before releasing any Telegram input and disables tools", async () => {
  const launch = {
    env: {},
    binary: "synthetic-cli",
    cwd: ".",
    model: "custom-9",
    accountEmail: "local@example.test",
  };
  let auth = "firstParty",
    actualModel = "custom-9";
  const received: string[] = [];
  const fake = vi.fn((options: Parameters<typeof query>[0]) => {
    const input = options.prompt as AsyncIterable<SDKUserMessage>;
    const read = (async () => {
      for await (const m of input) received.push(String(m.message.content));
    })();
    return {
      initializationResult: async () => ({
        account: { apiProvider: auth, subscriptionType: "Max 20x", email: launch.accountEmail },
        models: [{ value: "custom", resolvedModel: actualModel }],
      }),
      async *[Symbol.asyncIterator]() {
        await read;
        yield { type: "assistant", message: { model: actualModel, content: [{ type: "text" }] } };
        yield { type: "result", subtype: "success", is_error: false, result: answer };
      },
      close: () => {},
    };
  });
  const create = fake as unknown as typeof query;
  auth = "gateway";
  await expect(generateWithClaude(launch, req, signal, create)).rejects.toThrow();
  expect(received).toEqual([]);
  auth = "firstParty";
  actualModel = "other";
  await expect(generateWithClaude(launch, req, signal, create)).rejects.toThrow();
  expect(received).toEqual([]);
  actualModel = "custom-9";
  expect(await generateWithClaude(launch, req, signal, create)).toBe(answer);
  expect(received).toEqual([req.prompt]);
  expect(fake.mock.calls.at(-1)![0].options).toMatchObject({
    tools: [],
    strictMcpConfig: true,
    mcpServers: {},
    persistSession: false,
    model: "custom-9",
  });
});
