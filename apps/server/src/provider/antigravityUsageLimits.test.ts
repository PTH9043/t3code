import { ServerProviderUsage } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { antigravityAccountUsage, parseAntigravityUsageOutput } from "./antigravityUsageLimits.ts";

const decodeUsage = Schema.decodeUnknownSync(ServerProviderUsage);

describe("antigravityUsageLimits", () => {
  it("parses Gemini into primary/secondary and preserves Claude·GPT bucket in extraWindows", () => {
    const stdout = [
      "Claude and GPT models\tWeekly Limit Remaining\t47%\t2026-11-27T09:39:04Z",
      "Claude and GPT models\tFive Hour Limit Remaining\t0%\t2026-11-20T14:39:04Z",
      "Gemini Models\tWeekly Limit Remaining\t97%\t2026-11-27T09:36:45Z",
      "Gemini Models\tFive Hour Limit Remaining\t91%\t2026-11-20T14:36:45Z",
    ].join("\n");

    const parsed = parseAntigravityUsageOutput(stdout);
    expect(parsed).toEqual({
      primary: {
        label: "Gemini 5시간",
        bucket: "gemini",
        usedPercent: 9,
        resetsAt: Date.UTC(2026, 10, 20, 14, 36, 45) / 1_000,
        windowDurationMinutes: 300,
      },
      secondary: {
        label: "Gemini 7일",
        bucket: "gemini",
        usedPercent: 3,
        resetsAt: Date.UTC(2026, 10, 27, 9, 36, 45) / 1_000,
        windowDurationMinutes: 10_080,
      },
      extraWindows: [
        {
          label: "Claude·GPT 5시간",
          bucket: "claude-gpt",
          usedPercent: 100,
          resetsAt: Date.UTC(2026, 10, 20, 14, 39, 4) / 1_000,
          windowDurationMinutes: 300,
        },
        {
          label: "Claude·GPT 7일",
          bucket: "claude-gpt",
          usedPercent: 53,
          resetsAt: Date.UTC(2026, 10, 27, 9, 39, 4) / 1_000,
          windowDurationMinutes: 10_080,
        },
      ],
    });

    const usage = antigravityAccountUsage({
      fetchedAt: "2026-11-20T10:15:00.000Z",
      rateLimits: parsed,
    });
    expect(decodeUsage(usage)).toEqual({
      source: "provider",
      updatedAt: "2026-11-20T10:15:00.000Z",
      sessionTokens: 0,
      sessionCount: 0,
      activeSessionCount: 0,
      primary: parsed.primary,
      secondary: parsed.secondary,
      extraWindows: parsed.extraWindows,
    });
  });

  it("falls back to non-Gemini buckets as primary/secondary when no Gemini row is present", () => {
    const stdout = [
      "Claude and GPT models\tWeekly Limit Remaining\t47%\t2026-11-27T09:39:04Z",
      "Claude and GPT models\tFive Hour Limit Remaining\t0%\t2026-11-20T14:39:04Z",
    ].join("\n");
    expect(parseAntigravityUsageOutput(stdout)).toEqual({
      primary: {
        label: "Claude·GPT 5시간",
        bucket: "claude-gpt",
        usedPercent: 100,
        resetsAt: Date.UTC(2026, 10, 20, 14, 39, 4) / 1_000,
        windowDurationMinutes: 300,
      },
      secondary: {
        label: "Claude·GPT 7일",
        bucket: "claude-gpt",
        usedPercent: 53,
        resetsAt: Date.UTC(2026, 10, 27, 9, 39, 4) / 1_000,
        windowDurationMinutes: 10_080,
      },
    });
  });

  it("tolerates missing reset timestamps, used percentages, and unparseable output", () => {
    expect(parseAntigravityUsageOutput("Gemini Models\tFive Hour Used\t25.5%\tnot-a-date")).toEqual(
      {
        primary: {
          label: "Gemini 5시간",
          bucket: "gemini",
          usedPercent: 25.5,
          windowDurationMinutes: 300,
        },
      },
    );
    expect(parseAntigravityUsageOutput("")).toEqual({});
    expect(parseAntigravityUsageOutput("not signed in\nerror: authentication required")).toEqual(
      {},
    );
    expect(
      antigravityAccountUsage({ fetchedAt: "2026-11-20T10:15:00.000Z", rateLimits: {} }),
    ).toBeUndefined();
  });

  it("drops epoch-zero sentinel reset timestamps (1970-01-01T00:00:00Z)", () => {
    const parsed = parseAntigravityUsageOutput(
      "Claude and GPT models	Five Hour Limit Remaining	100%	1970-01-01T00:00:00Z",
    );
    expect(parsed).toEqual({
      primary: {
        label: "Claude·GPT 5시간",
        bucket: "claude-gpt",
        usedPercent: 0,
        windowDurationMinutes: 300,
      },
    });
  });
});
