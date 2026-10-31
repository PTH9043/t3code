import { ProviderDriverKind, type ServerProviderUsage } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { ProviderAccountUsage } from "./ProviderAccountUsage";

describe("account quota display", () => {
  const usage: ServerProviderUsage = {
    source: "provider",
    updatedAt: "2026-09-30T00:00:00Z",
    sessionTokens: 0,
    sessionCount: 1,
    activeSessionCount: 0,
    primary: { usedPercent: 40, windowDurationMinutes: 300 },
    secondary: { usedPercent: 95, windowDurationMinutes: 10_080 },
    credits: { hasCredits: true, balance: "62500" },
  };
  it("shows Codex weekly allowance and formatted credits without the 5h window", () => {
    const html = renderToStaticMarkup(
      <ProviderAccountUsage driver={ProviderDriverKind.make("codex")} usage={usage} />,
    );
    expect(html).toContain("7일");
    expect(html).toContain("62,500");
    expect(html).not.toContain("5시간");
  });
  it("keeps Claude's 5h and weekly windows", () => {
    const html = renderToStaticMarkup(
      <ProviderAccountUsage driver={ProviderDriverKind.make("claudeAgent")} usage={usage} />,
    );
    expect(html).toContain("5시간");
    expect(html).toContain("7일");
  });
  it("hides credit cells when absent, exhausted or explicitly unavailable", () => {
    for (const credits of [
      undefined,
      { balance: "0", hasCredits: true },
      { balance: "62500", hasCredits: false },
    ]) {
      const withoutCredits: ServerProviderUsage = {
        source: usage.source,
        updatedAt: usage.updatedAt,
        sessionTokens: usage.sessionTokens,
        sessionCount: usage.sessionCount,
        activeSessionCount: usage.activeSessionCount,
      };
      expect(
        renderToStaticMarkup(
          <ProviderAccountUsage usage={{ ...withoutCredits, ...(credits ? { credits } : {}) }} />,
        ),
      ).not.toContain("크레딧");
    }
  });
  it("shows unlimited credits when supplied by the provider", () => {
    expect(
      renderToStaticMarkup(
        <ProviderAccountUsage usage={{ ...usage, credits: { unlimited: true } }} />,
      ),
    ).toContain("무제한");
  });
  it("distinguishes unavailable runtime usage from an actual zero", () => {
    const html = renderToStaticMarkup(<ProviderAccountUsage usage={undefined} />);
    expect(html).toContain("정보 없음");
    expect(html).not.toContain("0 토큰");
    expect(html).not.toContain("0개");
  });
});
