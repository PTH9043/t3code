import {
  EventId,
  ThreadId,
  ToolActivitySummaryFact,
  WsServerSummarizeToolActivityRpc,
  WS_METHODS,
  type DesktopDirectRpcInput,
  type DesktopDirectRpcOutput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import * as RpcServer from "effect/unstable/rpc/RpcServer";
import { makeDirectRpcProtocol } from "./direct/DirectRpcProtocol.ts";
import { describe, expect, it, vi } from "vite-plus/test";
import { factualToolActivitySummary, makeToolActivitySummarizer } from "./toolActivitySummary.ts";

const local = {
  capabilities: ["completion"],
  details: { format: "gguf" },
  model_info: { "general.parameter_count": 42 },
};
const input = {
  threadId: ThreadId.make("private-room"),
  activityId: EventId.make("private-call"),
  fact: {
    action: "read",
    phase: "completed",
    evidence: "observed",
    targetCount: 0,
    confirmedDiffCount: 0,
  } as const,
};
const completed = "파일 읽기 작업이 끝났습니다.";
const decodeFormat = Schema.decodeUnknownSync(
  Schema.Struct({
    properties: Schema.Struct({ summary: Schema.Struct({ enum: Schema.Array(Schema.String) }) }),
  }),
);
function decodeChoices(format: unknown) {
  return decodeFormat(format).properties.summary.enum;
}
const result = (model: unknown, summary: string) => ({
  model,
  done: true,
  done_reason: "stop",
  response: JSON.stringify({ summary }),
});

describe("local tool activity summary", () => {
  it("accepts the exact shared subject vocabulary and rejects arbitrary subjects", () => {
    const valid = Schema.is(ToolActivitySummaryFact);
    for (const subject of [
      "diff",
      "test",
      "history-fetch",
      "history-read",
      "history-fetch-read",
      "read-search",
      "database-read",
      "repository-status",
    ]) {
      expect(valid({ ...input.fact, subject })).toBe(true);
    }
    expect(valid({ ...input.fact, subject: "raw shell text" })).toBe(false);
  });

  it("decodes a typed test activity and its local summary over the desktop direct RPC protocol", () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const incoming = yield* Queue.unbounded<DesktopDirectRpcInput>();
          const outgoing = yield* Queue.unbounded<DesktopDirectRpcOutput>();
          const protocol = yield* makeDirectRpcProtocol({
            incoming: Stream.fromQueue(incoming),
            send: (frame) => Queue.offer(outgoing, frame).pipe(Effect.asVoid),
          });
          const group = RpcGroup.make(WsServerSummarizeToolActivityRpc);
          const summarize = makeToolActivitySummarizer(async (path, body) =>
            path === "/api/show"
              ? local
              : result(body.model, "테스트로 동작을 확인하는 명령이 끝났습니다."),
          );
          const handlers = yield* Layer.build(
            group.toLayer(
              Effect.succeed(
                group.of({
                  [WS_METHODS.serverSummarizeToolActivity]: (payload) =>
                    Effect.promise(() => summarize(payload)),
                }),
              ),
            ),
          );
          yield* RpcServer.make(group).pipe(
            Effect.provide(handlers),
            Effect.provideService(RpcServer.Protocol, protocol),
            Effect.forkScoped,
          );
          yield* Queue.offer(incoming, { type: "open", clientId: 1 });
          expect(yield* Queue.take(outgoing)).toEqual({ type: "opened", clientId: 1 });
          yield* Queue.offer(incoming, {
            type: "data",
            clientId: 1,
            data: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
              _tag: "Request",
              id: "request",
              tag: WS_METHODS.serverSummarizeToolActivity,
              payload: { ...input, fact: { ...input.fact, subject: "test" } },
              headers: [],
            }),
          });
          const frame = yield* Queue.take(outgoing);
          expect(frame.type).toBe("data");
          if (frame.type === "data")
            expect(
              yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(frame.data),
            ).toMatchObject({
              requestId: "request",
              exit: {
                _tag: "Success",
                value: {
                  model: "granite4.1:8b",
                  summary: "테스트로 동작을 확인하는 명령이 끝났습니다.",
                },
              },
            });
        }),
      ),
    ));

  it("deduplicates concurrent opens and retries, sends only sanitized facts, and returns the actual summarizer", async () => {
    const post = vi.fn(async (path: string, body: Record<string, unknown>) =>
      path === "/api/show" ? local : result(body.model, completed),
    );
    const summarize = makeToolActivitySummarizer(post);
    const dirty = {
      ...input,
      fact: { ...input.fact, raw: "sensitive", path: "sensitive", token: "sensitive" },
    };
    const expected = { summary: completed, model: "granite4.1:8b" };
    expect(await Promise.all([summarize(dirty), summarize(input)])).toEqual([expected, expected]);
    expect(await summarize(input)).toEqual(expected);
    expect(post.mock.calls.map(([path]) => path)).toEqual(["/api/show", "/api/generate"]);
    expect(JSON.parse(String(post.mock.calls[1]![1].prompt))).toEqual(input.fact);
    expect(JSON.stringify(post.mock.calls)).not.toMatch(/private-room|private-call|sensitive/);
  });

  it("reevaluates the same activity after a phase change and never reuses the earlier result", async () => {
    const post = vi.fn(async (path: string, body: Record<string, unknown>) =>
      path === "/api/show"
        ? local
        : result(
            body.model,
            body.model === "qwen2.5-coder:14b" ? "파일 읽기 작업이 실패했습니다." : completed,
          ),
    );
    const summarize = makeToolActivitySummarizer(post);
    await summarize(input);
    const failure = { ...input, fact: { ...input.fact, phase: "failed" as const } };
    expect(await summarize(failure)).toEqual({
      model: "qwen2.5-coder:14b",
      summary: "파일 읽기 작업이 실패했습니다.",
    });
    expect(await summarize(input)).toEqual({ model: "granite4.1:8b", summary: completed });
    expect(post).toHaveBeenCalledTimes(4);
  });

  it("keeps an older in-flight result out of the completed failure cache", async () => {
    const releaseStarted = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const post = vi.fn(async (path: string, body: Record<string, unknown>) => {
      if (path === "/api/show") return local;
      if (body.model === "granite4.1:8b") {
        started.resolve();
        await releaseStarted.promise;
        return result(body.model, "파일 읽기 작업이 시작됐습니다.");
      }
      return result(body.model, "파일 읽기 작업이 실패했습니다.");
    });
    const summarize = makeToolActivitySummarizer(post);
    const old = summarize({ ...input, fact: { ...input.fact, phase: "started" } });
    await started.promise;
    const current = { ...input, fact: { ...input.fact, phase: "failed" as const } };
    const failure = { model: "qwen2.5-coder:14b", summary: "파일 읽기 작업이 실패했습니다." };
    try {
      expect(await summarize(current)).toEqual(failure);
    } finally {
      releaseStarted.resolve();
    }
    expect((await old).model).toBe("granite4.1:8b");
    expect(await summarize(current)).toEqual(failure);
    expect(post).toHaveBeenCalledTimes(4);
  });

  it("recovers on the next explicit open after local failure without calling an alternate model", async () => {
    const post = vi.fn(async (path: string, body: Record<string, unknown>) =>
      path === "/api/show" ? local : result(body.model, completed),
    );
    post.mockRejectedValueOnce(new Error("offline"));
    const summarize = makeToolActivitySummarizer(post);
    expect(await summarize(input)).toEqual(factualToolActivitySummary);
    expect(post).toHaveBeenCalledTimes(1);
    expect(await summarize(input)).toEqual({ summary: completed, model: "granite4.1:8b" });
    expect(new Set(post.mock.calls.map(([, body]) => body.model))).toEqual(
      new Set(["granite4.1:8b"]),
    );
  });

  it.each([
    ["cloud tag", { ...local, remote_model: "remote" }],
    ["remote host", { ...local, remote_host: "remote" }],
    ["embedding", { ...local, capabilities: ["embedding"] }],
    ["missing local weights", { ...local, model_info: {} }],
  ])("skips generation for %s", async (_, metadata) => {
    const post = vi.fn(async () => metadata);
    expect(await makeToolActivitySummarizer(post)(input)).toEqual(factualToolActivitySummary);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ action: "read" }, "파일을 수정했습니다."],
    [{ action: "read", subject: "diff" }, "변경 사항을 적용했습니다."],
    [{ action: "edit", phase: "started", evidence: "planned" }, "편집에 성공했습니다."],
    [
      { action: "command", subject: "history-fetch-read", compound: true },
      "이력을 성공적으로 가져왔습니다.",
    ],
    [{}, "파일 읽기 작업이 끝났습니다. token=secret"],
  ] as const)("drops unsupported claims or unexpected text for %o", async (partial, text) => {
    const fact: ToolActivitySummaryFact = { ...input.fact, ...partial };
    const summarize = makeToolActivitySummarizer(async (path, body) =>
      path === "/api/show" ? local : result(body.model, text),
    );
    expect(await summarize({ ...input, fact })).toEqual(factualToolActivitySummary);
  });

  it.each([
    ["list", "대상 2개에 대해 목록에 포함된 항목을 살펴보는 작업이 끝났습니다."],
    ["read", "대상 2개에 대해 파일에 어떤 내용이 있는지 살펴보는 작업이 끝났습니다."],
  ] as const)(
    "constrains completed %s generation to several supported Korean phrases",
    async (action, selected) => {
      const fact = { ...input.fact, action, targetCount: 2 };
      const post = vi.fn(async (path: string, body: Record<string, unknown>) => {
        if (path === "/api/show") return local;
        const choices = decodeChoices(body.format);
        expect(new Set(choices).size).toBeGreaterThan(1);
        expect(choices).toContain(selected);
        expect(choices.some((text) => text.includes("대상 2개"))).toBe(true);
        expect(choices.join(" ")).not.toMatch(/성공|편집|수정|변경 적용/);
        expect(body.system).toContain(selected);
        return result(body.model, selected);
      });
      expect(await makeToolActivitySummarizer(post)({ ...input, fact })).toEqual({
        model: "granite4.1:8b",
        summary: selected,
      });
      expect(post.mock.calls.map(([path]) => path)).toEqual(["/api/show", "/api/generate"]);
    },
  );

  it("does not attribute a local phrase when the generator returns no selection or a sentence outside this fact's choices", async () => {
    for (const response of [
      null,
      result("granite4.1:8b", ""),
      result("granite4.1:8b", "자료 검색이 종료됐습니다."),
    ]) {
      const summarize = makeToolActivitySummarizer(async (path) =>
        path === "/api/show" ? local : response,
      );
      expect(await summarize(input)).toEqual(factualToolActivitySummary);
    }
  });

  it.each([
    [
      { action: "edit", phase: "started", evidence: "planned" },
      "변경 적용 여부는 확인되지 않았습니다.",
    ],
    [{ action: "edit", evidence: "tool-reported" }, "보고"],
    [
      { action: "edit", evidence: "confirmed-diff", confirmedDiffCount: 1 },
      "변경 차이가 확인된 대상은 1개입니다.",
    ],
    [{ action: "command", subject: "history-fetch-read", compound: true }, "포함한 복합 명령"],
  ] as const)(
    "retains the evidence qualification in every choice for %o",
    async (partial, required) => {
      const fact: ToolActivitySummaryFact = { ...input.fact, ...partial };
      let offered: readonly string[] = [];
      const summarize = makeToolActivitySummarizer(async (path, body) => {
        if (path === "/api/show") return local;
        offered = decodeChoices(body.format);
        return result(body.model, offered[1]!);
      });
      const answer = await summarize({ ...input, fact });
      expect(answer.summary).toBe(offered[1]);
      expect(offered.length).toBeGreaterThan(1);
      expect(offered.every((text) => text.includes(required))).toBe(true);
    },
  );

  it.each([
    ["history-fetch-read", "원격 변경 이력 가져오기와 최근 기록 조회를 시도하는"],
    ["database-read", "저장된 자료를 읽기 전용으로 조회하는"],
    ["read-search", "문서나 소스의 내용을 읽고 필요한 문구를 찾는"],
    ["diff", "기존 내용과 변경 내용을 비교하는"],
  ] as const)(
    "offers a grounded purpose for %s without claiming individual steps succeeded",
    async (subject, purpose) => {
      const fact: ToolActivitySummaryFact = { ...input.fact, subject, compound: true };
      const summarize = makeToolActivitySummarizer(async (path, body) => {
        if (path === "/api/show") return local;
        const choices = decodeChoices(body.format);
        expect(choices.every((text) => text.includes("포함한 복합 명령"))).toBe(true);
        expect(choices.join(" ")).not.toMatch(/성공|수정했습니다|가져왔습니다/);
        return result(body.model, choices.find((text) => text.includes(purpose))!);
      });
      expect((await summarize({ ...input, fact })).summary).toContain(purpose);
    },
  );

  it("requires the exact selected model and a complete response", async () => {
    for (const invalid of [
      result("another", completed),
      { ...result("granite4.1:8b", completed), done_reason: "length" },
      { ...result("granite4.1:8b", completed), done: false },
    ]) {
      const summarize = makeToolActivitySummarizer(async (path) =>
        path === "/api/show" ? local : invalid,
      );
      expect(await summarize(input)).toEqual(factualToolActivitySummary);
    }
  });
});
