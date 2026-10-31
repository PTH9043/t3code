import { describe, expect, it } from "vite-plus/test";
import { formatTokenCount, tokenUsageSummary, tokenUsageDiagnostics } from "./tokenUsage.ts";
import type { TokenCounts, TokenUsageBreakdown } from "@t3tools/contracts";

describe("token usage presentation", () => {
  it("does not invent cache ratios or zero verification for unreported rows", () => {
    const counts: TokenCounts = {
      total: 120,
      input: 100,
      output: 20,
      cacheRead: 80,
      cacheWrite: null,
      reasoning: null,
    };
    const row: TokenUsageBreakdown = {
      provider: "codex",
      model: "model",
      phase: "implementation",
      attempt: 1,
      counts,
      issues: [],
    };
    expect(tokenUsageDiagnostics({ counts, breakdown: [row] })).toEqual({
      cacheReadShare: 0.8,
      verificationTokens: null,
      retryTokens: null,
      formatRepairTokens: null,
    });
    expect(
      tokenUsageDiagnostics({
        counts,
        breakdown: [row, { ...row, provider: "other", counts: { ...counts, cacheRead: null } }],
      }).cacheReadShare,
    ).toBeNull();
    expect(
      tokenUsageDiagnostics({ counts, breakdown: [{ ...row, phase: "verification", attempt: 2 }] })
        .verificationTokens,
    ).toBe(120);
    expect(
      tokenUsageDiagnostics({ counts, breakdown: [{ ...row, phase: "verification", attempt: 2 }] })
        .retryTokens,
    ).toBe(120);
    expect(
      tokenUsageDiagnostics({ counts: { ...counts, input: 0 }, breakdown: [row] }).cacheReadShare,
    ).toBeNull();
  });
  it("uses Korean abbreviated summaries and exact detail integers", () => {
    expect(formatTokenCount(125068, true)).toBe("12.5만");
    expect(formatTokenCount(125068)).toBe("125,068");
  });
  it("never turns missing usage into zero", () => {
    expect(formatTokenCount(null)).toBe("—");
    expect(formatTokenCount(0)).toBe("0");
    expect(tokenUsageSummary(null)).toBe("사용량 조회 중");
  });
});
