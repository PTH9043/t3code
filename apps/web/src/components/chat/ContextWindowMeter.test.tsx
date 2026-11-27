import type { ServerProviderUsage } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ContextWindowMeter } from "./ContextWindowMeter";
import { ProviderQuotaPill } from "./TokenUsageButton";

describe("composer usage indicators", () => {
  it("renders the context window percentage visibly next to the ring", () => {
    const html = renderToStaticMarkup(
      <ContextWindowMeter
        providerDisplayName="Antigravity CLI"
        usage={{
          usedTokens: 42_000,
          totalProcessedTokens: 120_000,
          maxTokens: 100_000,
          remainingTokens: 58_000,
          usedPercentage: 42,
          remainingPercentage: 58,
          inputTokens: 30_000,
          cachedInputTokens: 10_000,
          outputTokens: 2_000,
          reasoningOutputTokens: null,
          lastUsedTokens: null,
          lastInputTokens: null,
          lastCachedInputTokens: null,
          lastOutputTokens: null,
          lastReasoningOutputTokens: null,
          toolUses: null,
          durationMs: null,
          compactsAutomatically: true,
          updatedAt: "2026-11-20T10:00:00.000Z",
        }}
      />,
    );
    expect(html).toContain('data-context-window-percent="true"');
    expect(html).toContain("42%");
  });

  it("renders model-matched bucket windows in the composer pill for Antigravity", () => {
    const usage: ServerProviderUsage = {
      source: "provider",
      updatedAt: "2026-11-20T10:00:00.000Z",
      sessionTokens: 0,
      sessionCount: 0,
      activeSessionCount: 0,
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
    const geminiHtml = renderToStaticMarkup(
      <ProviderQuotaPill
        usage={usage}
        providerDisplayName="Antigravity CLI"
        selectedModel="gemini-4-neon"
      />,
    );
    expect(geminiHtml).toContain('data-composer-quota-windows="true"');
    expect(geminiHtml).toContain("Gemini 5시간");
    expect(geminiHtml).toContain("9%");
    expect(geminiHtml).toContain("Gemini 7일");
    expect(geminiHtml).toContain("3%");

    const claudeOnAgyHtml = renderToStaticMarkup(
      <ProviderQuotaPill
        usage={usage}
        providerDisplayName="Antigravity CLI"
        selectedModel="claude-opus-5-5"
      />,
    );
    expect(claudeOnAgyHtml).toContain("Claude·GPT 5시간");
    expect(claudeOnAgyHtml).toContain("100%");
    expect(claudeOnAgyHtml).toContain("Claude·GPT 7일");
    expect(claudeOnAgyHtml).toContain("53%");
  });
});
