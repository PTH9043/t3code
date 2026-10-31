import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vite-plus/test";
import type { TokenUsageSummary } from "@t3tools/contracts";
import { DevelopmentTokenUsage } from "./DevelopmentTokenUsage";

const unknown: TokenUsageSummary = {
  counts: {
    total: null,
    input: null,
    output: null,
    cacheRead: null,
    cacheWrite: null,
    reasoning: null,
  },
  coverage: "unavailable",
  inProgress: true,
  requestCount: 1,
  reportedRequestCount: 0,
  issues: ["unreported"],
  breakdown: [],
};
const render = (summary: TokenUsageSummary) =>
  renderToStaticMarkup(
    <DevelopmentTokenUsage
      usage={{ goal: summary, daily: summary, dailySince: "2026-10-12T00:00:00Z" }}
      maxTokens={1000}
      maxDailyTokens={1000}
      hasGoal
    />,
  );
it("shows missing usage as unknown and identifies incomplete provider coverage", () => {
  const html = render(unknown);
  expect(html).toContain("미집계");
  expect(html).toContain("0/1개");
  expect(html).toContain("일부 사용량 미확정");
  expect(html).not.toContain("예산 도달");
});
it("warns at eighty percent and at the cap using total without adding cached input", () => {
  const reported = {
    ...unknown,
    coverage: "reported" as const,
    inProgress: false,
    reportedRequestCount: 1,
    counts: { ...unknown.counts, total: 800, input: 700, output: 100, cacheRead: 600 },
  };
  expect(render(reported)).toContain("예산 80% 이상");
  expect(render(reported)).not.toContain("예산 도달");
  expect(render({ ...reported, counts: { ...reported.counts, total: 1000 } })).toContain(
    "예산 도달",
  );
});
