import { describe, expect, it } from "@effect/vitest";
import {
  buildKoreanBigramFtsMatchExpr,
  buildKoreanBigramIndexFields,
  expandKoreanTermVariants,
  hasStrippableKoreanParticle,
  normalizeKoreanKeywordToken,
} from "./koreanTextNormalization.ts";
import { evaluateRoutingReindexIdleGate } from "./routingGraphReindexWorker.ts";

describe("Korean normalization & unobtrusive reindex gate (Wave 4-A2)", () => {
  it("strips Korean particles/endings while preserving 2-syllable nouns and protected stems", () => {
    expect(normalizeKoreanKeywordToken("토큰을")).toBe("토큰");
    expect(normalizeKoreanKeywordToken("수익률에서는")).toBe("수익률");
    expect(normalizeKoreanKeywordToken("대시보드를")).toBe("대시보드");
    expect(normalizeKoreanKeywordToken("백업으로")).toBe("백업");
    expect(normalizeKoreanKeywordToken("rag에서")).toBe("rag");
    // Protected 2-syllable / stem nouns stay intact
    expect(normalizeKoreanKeywordToken("결과")).toBe("결과");
    expect(normalizeKoreanKeywordToken("추가")).toBe("추가");
    expect(normalizeKoreanKeywordToken("토큰")).toBe("토큰");
    expect(normalizeKoreanKeywordToken("게이지")).toBe("게이지");
    expect(normalizeKoreanKeywordToken("메모리")).toBe("메모리");
    expect(hasStrippableKoreanParticle("토큰을")).toBe(true);
    expect(hasStrippableKoreanParticle("토큰")).toBe(false);
  });

  it("expands parallel [normalized, original] variants and builds 2-char Korean bigram FTS MATCH", () => {
    expect(expandKoreanTermVariants("토큰을")).toEqual(["토큰", "토큰을"]);
    expect(expandKoreanTermVariants("토큰")).toEqual(["토큰"]);

    const fields = buildKoreanBigramIndexFields({
      title: "토큰 게이지 수정",
      summaryMoc: "수익률을 점검한다",
      bodyMarkdown: "백업 압축",
    });
    expect(fields.titleKo).toContain("토큰");
    expect(fields.bodyKo).toContain("수익");
    expect(fields.bodyKo).toContain("익률");

    const expr = buildKoreanBigramFtsMatchExpr(["토큰을", "수익률은"]);
    expect(expr).toContain('"토큰"');
    expect(expr).toContain('"수익 익률"');
  });

  it("blocks background reindex whenever active work > 0, user is present, or power monitor is stale", () => {
    const awayPower = {
      idle: true,
      idleSeconds: 600,
      locked: false,
      suspended: false,
      onBattery: false,
      lowPowerMode: false,
      thermalState: "nominal",
      stale: false,
    };
    expect(evaluateRoutingReindexIdleGate(awayPower, { activeWorkCount: 0 }).allowed).toBe(true);
    expect(evaluateRoutingReindexIdleGate(awayPower, { activeWorkCount: 1 }).reason).toBe(
      "active_work_running",
    );
    expect(
      evaluateRoutingReindexIdleGate(
        { ...awayPower, idle: false, idleSeconds: 12 },
        { activeWorkCount: 0 },
      ).reason,
    ).toBe("user_present");
    expect(
      evaluateRoutingReindexIdleGate(
        { ...awayPower, locked: true, idle: false, idleSeconds: 0 },
        { activeWorkCount: 0 },
      ).allowed,
    ).toBe(true);
    expect(
      evaluateRoutingReindexIdleGate({ ...awayPower, stale: true }, { activeWorkCount: 0 }).reason,
    ).toBe("power_monitor_stale");
  });
});
