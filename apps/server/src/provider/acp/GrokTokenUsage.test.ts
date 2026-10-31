import { TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { advanceTokenUsage } from "../../orchestration/tokenUsage.ts";
import { grokTokenConsumption, makeGrokTokenUsageTracker } from "./GrokTokenUsage.ts";

// Captured from Grok 1.0.4 ACP, 2026-09-12. Identifiers are replaced.
const nativeCounts = {
  inputTokens: 18876,
  outputTokens: 42,
  totalTokens: 18918,
  cachedReadTokens: 2944,
  cacheCreationTokens: 0,
  reasoningTokens: 37,
};
const fixture = {
  stopReason: "end_turn",
  _meta: {
    sessionId: "native-session",
    promptId: "native-prompt",
    modelId: "grok-4.6",
    usage: { ...nativeCounts, modelUsage: { "grok-4.6-build": nativeCounts } },
  },
};
const first = TurnId.make("first");
const second = TurnId.make("second");
const sent = {
  direction: "outgoing" as const,
  stage: "decoded" as const,
  payload: {
    _tag: "Request",
    id: "5",
    tag: "session/prompt",
    payload: { sessionId: "native-session", _meta: { promptId: "native-prompt" } },
  },
};
const received = (value: unknown = fixture) => ({
  direction: "incoming" as const,
  stage: "decoded" as const,
  payload: [{ _tag: "Exit", requestId: "5", exit: { _tag: "Success", value } }],
});

describe("Grok native consumption", () => {
  it("accepts Grok 1.0.46 turn_completed notifications once, even after a usage-free fallback", () => {
    const tracker = makeGrokTokenUsageTracker();
    tracker(sent, first);
    expect(
      tracker(
        received({
          stopReason: "end_turn",
          _meta: { sessionId: "native-session", promptId: "native-prompt" },
        }),
        second,
      ),
    ).toEqual([]);
    const notification = {
      sessionId: "native-session",
      update: {
        sessionUpdate: "turn_completed",
        prompt_id: "native-prompt",
        stop_reason: "end_turn",
        usage: { ...nativeCounts, modelUsage: { "grok-4.7-build": nativeCounts } },
      },
    };
    expect(tracker.completion(notification)).toMatchObject([
      {
        turnId: first,
        consumption: [{ model: "grok-4.7-build", counts: { cacheRead: 2944, total: 18918 } }],
      },
    ]);
    expect(tracker.completion(notification)).toEqual([]);
    expect(
      tracker.completion({ sessionId: "native-session", update: { sessionUpdate: "other" } }),
    ).toEqual([]);
  });
  it("uses the actual model breakdown and preserves cache and reasoning subsets", () => {
    const [observation] = grokTokenConsumption(fixture);
    expect(observation).toMatchObject({
      provider: "grok",
      model: "grok-4.6-build",
      mode: "execution-total",
      isFinal: true,
      counts: {
        total: 18918,
        input: 18876,
        output: 42,
        cacheRead: 2944,
        cacheWrite: 0,
        reasoning: 37,
      },
    });
    expect(advanceTokenUsage(null, observation!).delta.total).toBe(18918);
    expect(advanceTokenUsage(observation!.counts, observation!).delta.total).toBe(0);
  });
  it("keeps cancellation evidence partial and absent usage unknown", () => {
    expect(grokTokenConsumption({ ...fixture, stopReason: "cancelled" })[0]?.isFinal).toBe(false);
    expect(grokTokenConsumption({ stopReason: "end_turn", _meta: { agentResult: null } })).toEqual(
      [],
    );
    expect(
      grokTokenConsumption({ ...fixture, _meta: { ...fixture._meta, usage: undefined } }),
    ).toEqual([]);
  });
  it.each([
    { totalTokens: 4 },
    { cachedReadTokens: 18877 },
    { reasoningTokens: 43 },
    { inputTokens: -1 },
    { totalTokens: Number.MAX_SAFE_INTEGER + 1 },
  ])("rejects malformed or inconsistent counts %j", (bad) => {
    expect(
      grokTokenConsumption({
        ...fixture,
        _meta: { ...fixture._meta, usage: { ...nativeCounts, ...bad } },
      }),
    ).toEqual([]);
  });
  it("does not add modelUsage on top of the aggregate or trust a partial breakdown", () => {
    const partial = {
      ...fixture,
      _meta: {
        ...fixture._meta,
        usage: {
          ...nativeCounts,
          modelUsage: { other: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
        },
      },
    };
    expect(grokTokenConsumption(partial)).toHaveLength(1);
    expect(grokTokenConsumption(partial)[0]).toMatchObject({
      model: "grok-4.6",
      counts: { total: 18918 },
    });
  });
  it("attributes a late response to its original turn even after another starts", () => {
    const tracker = makeGrokTokenUsageTracker();
    expect(tracker(sent, first)).toEqual([]);
    const observed = tracker(received(), second);
    expect(observed).toHaveLength(1);
    expect(observed[0]?.turnId).toBe(first);
    expect(tracker(received(), second)).toEqual([]);
  });
  it("handles numeric request identifiers used by the actual ACP transport", () => {
    const tracker = makeGrokTokenUsageTracker();
    tracker({ ...sent, payload: { ...sent.payload, id: 4294967299 } }, first);
    const response = received();
    const events = tracker(
      {
        ...response,
        payload: response.payload.map((message) => ({ ...message, requestId: 4294967299 })),
      },
      second,
    );
    expect(events[0]?.turnId).toBe(first);
    expect(events[0]?.consumption[0]?.counts.total).toBe(18918);
  });
  it("never counts foreign sessions, unowned requests, raw logging, or child responses", () => {
    const tracker = makeGrokTokenUsageTracker();
    expect(tracker(received(), first)).toEqual([]);
    tracker(sent, first);
    expect(tracker({ ...received(), stage: "raw" }, second)).toEqual([]);
    expect(
      tracker(received({ ...fixture, _meta: { ...fixture._meta, sessionId: "child" } }), second),
    ).toEqual([]);
  });
  it("does not attach a missing-owner request to a later turn", () => {
    const tracker = makeGrokTokenUsageTracker();
    tracker(sent, undefined);
    expect(tracker(received(), second)).toEqual([]);
  });
});
