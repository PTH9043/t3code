import { describe, expect, it } from "vite-plus/test";
import { BackgroundAutoCompactor } from "./BackgroundAutoCompactor.ts";

describe("BackgroundAutoCompactor", () => {
  it("skips precompute below thresholds, caches summary on threshold, and serves instant consume", async () => {
    const compactor = new BackgroundAutoCompactor();

    expect(
      compactor.shouldPrecompute({
        threadId: "t-1",
        turnCount: 4,
        estimatedContextRatio: 0.2,
      }),
    ).toBe(false);

    const snapshot = await compactor.schedulePrecompute({
      threadId: "t-1",
      turnCount: 14,
      estimatedContextRatio: 0.72,
      recentTurns: [
        { role: "user", text: "동시성 버그를 조사해줘" },
        { role: "assistant", text: "DB 락 경합이 원인이며 패치를 완료했습니다." },
      ],
    });
    expect(snapshot).not.toBeNull();
    expect(snapshot?.coveredTurnCount).toBe(14);
    expect(snapshot?.summaryText).toContain("DB 락 경합");

    // Same turn count is already cached -> does not recompute
    expect(
      compactor.shouldPrecompute({
        threadId: "t-1",
        turnCount: 14,
        estimatedContextRatio: 0.72,
      }),
    ).toBe(false);

    const consumed = compactor.consumeSnapshot("t-1");
    expect(consumed?.summaryText).toContain("사전 압축 맥락 요약");
    expect(compactor.getCachedSnapshot("t-1")).toBeUndefined();
  });

  it("triggers precompute when absolute context tokens exceed 260k even on 1M context window", async () => {
    const compactor = new BackgroundAutoCompactor();

    expect(
      compactor.shouldPrecompute({
        threadId: "t-big-ctx",
        turnCount: 6,
        estimatedContextRatio: 0.28,
        usedTokens: 280_000,
      }),
    ).toBe(true);

    const snapshot = await compactor.schedulePrecompute({
      threadId: "t-big-ctx",
      turnCount: 6,
      estimatedContextRatio: 0.28,
      usedTokens: 280_000,
      recentTurns: [{ role: "user", text: "장기 세션 최적화 진행" }],
    });
    expect(snapshot?.usedTokens).toBe(280_000);
    expect(snapshot?.summaryText).toContain("장기 세션 최적화 진행");
  });
});
