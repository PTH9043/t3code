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
});
