import { describe, expect, it } from "vite-plus/test";
import {
  formatQuotaResetTime,
  formatTokenCount,
  hasExpiredQuotaWindow,
  providerQuotaSummary,
  providerQuotaWindows,
  tokenUsageSummary,
  tokenUsageDiagnostics,
  tokenUsageEfficiencyDiagnostics,
} from "./tokenUsage.ts";
import type { ServerProviderUsage, TokenCounts, TokenUsageBreakdown } from "@t3tools/contracts";

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
  it("formats 5-hour and weekly quota windows for composer and mobile summaries", () => {
    const usage: ServerProviderUsage = {
      source: "provider",
      updatedAt: "2026-11-20T10:00:00.000Z",
      sessionTokens: 0,
      sessionCount: 0,
      activeSessionCount: 0,
      primary: { usedPercent: 18, windowDurationMinutes: 300, resetsAt: 1_795_099_005 },
      secondary: { usedPercent: 6.5, windowDurationMinutes: 10_080 },
    };
    expect(providerQuotaWindows(usage)).toMatchObject([
      { id: "primary", label: "5시간", shortLabel: "5시간", usedPercent: 18, percentText: "18%" },
      { id: "secondary", label: "7일", shortLabel: "7일", usedPercent: 6.5, percentText: "6.5%" },
    ]);
    expect(providerQuotaSummary(usage)).toBe("5시간 18% · 7일 6.5%");
    expect(providerQuotaSummary(undefined)).toBeNull();

    const multiBucket: ServerProviderUsage = {
      ...usage,
      primary: {
        label: "Gemini 5시간",
        bucket: "gemini",
        usedPercent: 9,
        windowDurationMinutes: 300,
      },
      secondary: {
        label: "Gemini 7일",
        bucket: "gemini",
        usedPercent: 3,
        windowDurationMinutes: 10_080,
      },
      extraWindows: [
        {
          label: "Claude·GPT 5시간",
          bucket: "claude-gpt",
          usedPercent: 100,
          windowDurationMinutes: 300,
        },
        {
          label: "Claude·GPT 7일",
          bucket: "claude-gpt",
          usedPercent: 53,
          windowDurationMinutes: 10_080,
        },
      ],
    };
    expect(providerQuotaSummary(multiBucket, { model: "gemini-4-neon" })).toBe(
      "Gemini 5시간 9% · Gemini 7일 3%",
    );
    expect(providerQuotaSummary(multiBucket, { model: "claude-opus-5-5" })).toBe(
      "Claude·GPT 5시간 100% · Claude·GPT 7일 53%",
    );
    expect(providerQuotaSummary(multiBucket, { model: "gpt-oss-120b-medium" })).toBe(
      "Claude·GPT 5시간 100% · Claude·GPT 7일 53%",
    );
    expect(providerQuotaWindows(multiBucket, { includeExtra: true })).toHaveLength(4);
  });

  it("computes weighted input tokens, reasoning share, and <50% cache prefix warnings", () => {
    const codexCounts: TokenCounts = {
      total: 12_000,
      input: 10_000,
      output: 2_000,
      cacheRead: 3_000,
      cacheWrite: 0,
      reasoning: 1_100,
    };
    const codexRow: TokenUsageBreakdown = {
      provider: "codex",
      model: "gpt-6.1-sol",
      phase: "implementation",
      attempt: 1,
      counts: codexCounts,
      issues: [],
    };
    const eff = tokenUsageEfficiencyDiagnostics({ counts: codexCounts, breakdown: [codexRow] });
    expect(eff.cacheHealth).toBe("warning");
    expect(eff.cacheWarningMessage).toContain("30.0%");
    expect(eff.reasoningOutputShare).toBeCloseTo(0.55);
    expect(eff.weightedInputTokens).toBe(7_000 + 750 + 5 * 3_100);
  });

  it("ignores epoch-zero reset timestamps and detects expired quota windows", () => {
    expect(formatQuotaResetTime(0)).toBeUndefined();
    expect(formatQuotaResetTime(-10)).toBeUndefined();
    const baseUsage: ServerProviderUsage = {
      source: "provider",
      updatedAt: "2026-11-28T06:00:00.000Z",
      sessionTokens: 0,
      sessionCount: 0,
      activeSessionCount: 0,
      primary: { usedPercent: 0, resetsAt: 0 },
      secondary: { usedPercent: 50, resetsAt: 2_000_000_000 },
    };
    expect(hasExpiredQuotaWindow(baseUsage, 1_795_849_500_000)).toBe(false);
    expect(
      hasExpiredQuotaWindow(
        {
          ...baseUsage,
          primary: { usedPercent: 28, resetsAt: 1_795_849_306 },
        },
        1_795_849_500_000,
      ),
    ).toBe(true);
  });
});
