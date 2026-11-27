import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_PROACTIVE_COMPACT_THRESHOLD_TOKENS,
  evaluateProactiveCompactionDecision,
  extractCompactBoundaryTokens,
  formatCompactionSummaryLine,
  prepareCompactionMemoryCheckpoint,
  resolveClaudeAutoCompactSdkSettings,
} from "./ProactiveContextCompactor.ts";

describe("ProactiveContextCompactor (Wave 3-B2)", () => {
  it("triggers only at a completed turn boundary when actual inputTokens >= threshold", () => {
    // Mid-turn / interrupted / failed must NEVER trigger
    expect(
      evaluateProactiveCompactionDecision({
        turnId: "t1",
        turnStatus: "running",
        actualInputTokens: 320_000,
        enabled: true,
        threadDisabled: false,
        thresholdTokens: 250_000,
      }).shouldCompact,
    ).toBe(false);

    expect(
      evaluateProactiveCompactionDecision({
        turnId: "t1",
        turnStatus: "interrupted",
        actualInputTokens: 320_000,
        enabled: true,
        threadDisabled: false,
        thresholdTokens: 250_000,
      }).shouldCompact,
    ).toBe(false);

    // Below threshold must NOT trigger
    expect(
      evaluateProactiveCompactionDecision({
        turnId: "t1",
        turnStatus: "completed",
        actualInputTokens: 249_999,
        enabled: true,
        threadDisabled: false,
        thresholdTokens: 250_000,
      }).reason,
    ).toBe("below_threshold");

    // Per-thread OFF must disable compaction cleanly
    expect(
      evaluateProactiveCompactionDecision({
        turnId: "t1",
        turnStatus: "completed",
        actualInputTokens: 400_000,
        enabled: true,
        threadDisabled: true,
        thresholdTokens: 250_000,
      }).reason,
    ).toBe("disabled_for_thread");

    // Completed turn >= 250k triggers cleanly
    const hit = evaluateProactiveCompactionDecision({
      turnId: "t1",
      turnStatus: "completed",
      actualInputTokens: 285_400,
      enabled: true,
      threadDisabled: false,
      thresholdTokens: DEFAULT_PROACTIVE_COMPACT_THRESHOLD_TOKENS,
    });
    expect(hit.shouldCompact).toBe(true);
    expect(hit.reason).toBe("trigger");

    // Same turnId cannot trigger twice
    expect(
      evaluateProactiveCompactionDecision({
        turnId: "t1",
        turnStatus: "completed",
        actualInputTokens: 285_400,
        enabled: true,
        threadDisabled: false,
        thresholdTokens: 250_000,
        lastCompactedTurnId: "t1",
      }).reason,
    ).toBe("already_compacted_turn");
  });

  it("formats single-line Korean compaction record and extracts compact_boundary tokens", () => {
    expect(formatCompactionSummaryLine(389_675, 68_420)).toBe(
      "문맥 압축됨 (389,675 → 68,420 토큰)",
    );
    expect(formatCompactionSummaryLine(undefined, 54_000)).toBe("문맥 압축됨 (현재 54,000 토큰)");
    expect(formatCompactionSummaryLine(undefined, undefined)).toBe("문맥 압축됨");

    const extracted = extractCompactBoundaryTokens({
      compact_metadata: { pre_tokens: 312_000, post_tokens: 71_500 },
    });
    expect(extracted).toEqual({ preTokens: 312_000, postTokens: 71_500 });
  });

  it("maps global + per-thread settings to Claude SDK autoCompactWindow and builds memory checkpoint", () => {
    expect(
      resolveClaudeAutoCompactSdkSettings({
        proactiveCompactEnabled: true,
        proactiveCompactThresholdTokens: 250_000,
        threadDisabled: false,
      }),
    ).toEqual({ autoCompactEnabled: true, autoCompactWindow: 250_000 });

    expect(
      resolveClaudeAutoCompactSdkSettings({
        proactiveCompactEnabled: true,
        proactiveCompactThresholdTokens: 250_000,
        threadDisabled: true,
      }),
    ).toEqual({ autoCompactEnabled: false });

    const cp = prepareCompactionMemoryCheckpoint({
      threadId: "thr-1",
      actualInputTokens: 340_000,
      turns: [
        {
          role: "user",
          text: "캐시 TTL은 메인 1시간 유지하기로 결정했다. PowerShell은 절대 금지.",
        },
        { role: "assistant", text: "확인했습니다. 다음 단계는 한국어 바이그램 색인 적용입니다." },
      ],
    });
    expect(cp.summaryText).toContain("확정 결정 및 이유");
    expect(cp.summaryText).toContain("기각된 대안 및 제약 조건");
    expect(cp.estimatedPostTokens).toBeLessThan(340_000);
    expect(cp.memoryNote).toContain("문맥 사전 압축 체크포인트");
  });
});
