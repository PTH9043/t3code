import { expect, it } from "vite-plus/test";
import type { TokenUsageSummary } from "@t3tools/contracts";
import {
  developmentTokenBudgetLimit,
  developmentTokenBudgetStatus,
  developmentUsageDay,
} from "./workspaceDevelopmentUsage.ts";
const usage = (total: number | null, requestCount = 1): TokenUsageSummary => ({
  counts: { total, input: total, output: null, cacheRead: null, cacheWrite: null, reasoning: null },
  coverage: total === null ? "unavailable" : "partial",
  issues: ["unreported"],
  breakdown: [],
  inProgress: false,
  requestCount,
  reportedRequestCount: total === null ? 0 : 1,
});
it("warns at 80 percent and stops new work at the reported budget without treating unknown usage as zero", () => {
  expect(developmentTokenBudgetStatus(usage(799), 1000)).toBe("within");
  expect(developmentTokenBudgetStatus(usage(800), 1000)).toBe("warning");
  expect(developmentTokenBudgetStatus(usage(null), 1000)).toBe("unreported");
  expect(developmentTokenBudgetStatus(usage(null, 0), 1000)).toBe("within");
  expect(developmentTokenBudgetLimit({ goal: usage(1000), maxTokens: 1000 })).toContain("목표");
  expect(
    developmentTokenBudgetLimit({
      goal: usage(1),
      maxTokens: 1000,
      daily: usage(2000),
      maxDailyTokens: 2000,
    }),
  ).toContain("일일");
  expect(developmentTokenBudgetLimit({ goal: usage(3000) })).toBeNull();
});
it("resets on the server's local day and handles daylight saving boundaries", () => {
  expect(developmentUsageDay("2026-10-12T15:30:00.000Z", "Asia/Seoul")).toBe(
    "2026-10-12T15:00:00.000Z",
  );
  expect(developmentUsageDay("2026-03-08T20:00:00.000Z", "America/New_York")).toBe(
    "2026-03-08T05:00:00.000Z",
  );
});
