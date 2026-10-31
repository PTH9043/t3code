import type { TokenUsageObservation } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { addTokenCounts, advanceTokenUsage, emptyTokenCounts } from "./tokenUsage.ts";

const observation = (
  total: number,
  mode: TokenUsageObservation["mode"] = "cumulative",
): TokenUsageObservation => ({
  sourceId: "native",
  mode,
  provider: "codex",
  model: null,
  counts: { total, input: total - 10, output: 10, cacheRead: 0, cacheWrite: null, reasoning: null },
});
describe("token counter accounting", () => {
  it("counts the first request when the adapter proves the native session is new", () => {
    const first = advanceTokenUsage(null, { ...observation(1000), startsAtZero: true });
    expect(first.delta.total).toBe(1000);
    expect(first.issue).toBeNull();
  });
  it("establishes an unknown baseline without charging past history", () => {
    const first = advanceTokenUsage(null, observation(1000));
    expect(first.delta.total).toBeNull();
    expect(first.issue).toBe("baseline-required");
    const second = advanceTokenUsage(first.cursor, observation(1250));
    expect(second.delta.total).toBe(250);
    expect(advanceTokenUsage(second.cursor, observation(1250)).delta.total).toBe(0);
  });
  it("retains the high-water mark on out-of-order or reset counters", () => {
    const regression = advanceTokenUsage(observation(1000).counts, observation(800));
    expect(regression.delta.total).toBeNull();
    expect(regression.cursor.total).toBe(1000);
    expect(regression.issue).toBe("counter-regressed");
    expect(advanceTokenUsage(regression.cursor, observation(1100)).delta.total).toBe(100);
  });
  it("counts independent equal-size executions and suppresses a repeated result", () => {
    const first = advanceTokenUsage(null, observation(100, "execution-total"));
    const otherExecution = advanceTokenUsage(null, {
      ...observation(100, "execution-total"),
      sourceId: "other",
    });
    const replay = advanceTokenUsage(first.cursor, observation(100, "execution-total"));
    expect(
      addTokenCounts(addTokenCounts(first.delta, otherExecution.delta), replay.delta).total,
    ).toBe(200);
  });
  it("keeps unknown separate from zero", () => {
    expect(addTokenCounts(emptyTokenCounts(), emptyTokenCounts()).total).toBeNull();
    expect(
      advanceTokenUsage(null, {
        ...observation(10, "execution-total"),
        counts: { ...emptyTokenCounts(), total: 0 },
      }).delta.total,
    ).toBe(0);
  });

  it("keeps known field baselines when an intermediate snapshot omits them", () => {
    const initial = {
      ...observation(100),
      startsAtZero: true,
      counts: { total: 100, input: 80, output: 20, cacheRead: 30, cacheWrite: 5, reasoning: 10 },
    } satisfies TokenUsageObservation;
    const first = advanceTokenUsage(null, initial);
    const partial = advanceTokenUsage(first.cursor, {
      ...initial,
      counts: { ...emptyTokenCounts(), total: 120 },
    });
    expect(partial.delta).toEqual({ ...emptyTokenCounts(), total: 20 });
    expect(partial.cursor).toEqual({ ...initial.counts, total: 120 });
    const final = advanceTokenUsage(partial.cursor, {
      ...initial,
      counts: { total: 150, input: 120, output: 30, cacheRead: 40, cacheWrite: 8, reasoning: 15 },
    });
    expect(addTokenCounts(addTokenCounts(first.delta, partial.delta), final.delta)).toEqual({
      total: 150,
      input: 120,
      output: 30,
      cacheRead: 40,
      cacheWrite: 8,
      reasoning: 15,
    });
    expect(final.issue).toBeNull();
    expect(advanceTokenUsage(final.cursor, { ...initial, counts: final.cursor }).delta.total).toBe(
      0,
    );
  });

  it("detects a counter regression after an omitted field without charging it again", () => {
    const partial = advanceTokenUsage(observation(100).counts, {
      ...observation(120),
      counts: { ...emptyTokenCounts(), total: 120 },
    });
    const stale = advanceTokenUsage(partial.cursor, {
      ...observation(130),
      counts: { ...observation(130).counts, input: 80 },
    });
    expect(stale.issue).toBe("counter-regressed");
    expect(stale.cursor).toEqual(partial.cursor);
    expect(stale.delta.total).toBeNull();
    const recovered = advanceTokenUsage(stale.cursor, observation(140));
    expect(recovered.delta).toMatchObject({ total: 20, input: 40 });
  });
});
