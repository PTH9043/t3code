import { ServerProviderUsage } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  claudeAccountUsage,
  claudeUsageResponseToRateLimits,
  readClaudeRateLimits,
  shouldReadClaudeUsage,
} from "./claudeUsageLimits.ts";

const decodeUsage = Schema.decodeUnknownSync(ServerProviderUsage);

const FIVE_HOUR_RESET = "2026-11-20T15:00:00.000Z";
const SEVEN_DAY_RESET = "2026-11-24T03:30:00+00:00";
const FIVE_HOUR_RESET_SECONDS = Date.UTC(2026, 10, 20, 15, 0, 0) / 1_000;
const SEVEN_DAY_RESET_SECONDS = Date.UTC(2026, 10, 24, 3, 30, 0) / 1_000;

/** Shaped like `SDKControlGetUsageResponse` for a claude.ai subscriber. */
const fullResponse = {
  session: {
    total_cost_usd: 0,
    total_api_duration_ms: 0,
    total_duration_ms: 12,
    total_lines_added: 0,
    total_lines_removed: 0,
    model_usage: {},
  },
  subscription_type: "max",
  rate_limits_available: true,
  rate_limits: {
    five_hour: { utilization: 37, resets_at: FIVE_HOUR_RESET },
    seven_day: { utilization: 61.5, resets_at: SEVEN_DAY_RESET },
    seven_day_oauth_apps: null,
    seven_day_opus: { utilization: 88, resets_at: SEVEN_DAY_RESET },
    seven_day_sonnet: { utilization: 12, resets_at: SEVEN_DAY_RESET },
    model_scoped: [{ display_name: "Fable", utilization: 93, resets_at: SEVEN_DAY_RESET }],
    extra_usage: { is_enabled: true, monthly_limit: 5000, used_credits: 120, utilization: 2.4 },
  },
  behaviors: null,
};

const fiveHour = {
  label: "5시간",
  usedPercent: 37,
  resetsAt: FIVE_HOUR_RESET_SECONDS,
  windowDurationMinutes: 300,
};
const sevenDay = {
  label: "7일",
  usedPercent: 61.5,
  resetsAt: SEVEN_DAY_RESET_SECONDS,
  windowDurationMinutes: 10_080,
};

describe("claudeUsageResponseToRateLimits", () => {
  it("maps the 5-hour and all-models weekly windows and ignores every other bucket", () => {
    expect(claudeUsageResponseToRateLimits(fullResponse)).toEqual({
      primary: fiveHour,
      secondary: sevenDay,
    });
  });

  it("reads utilization as a percentage, not as the 0-1 fraction rate-limit events use", () => {
    expect(
      claudeUsageResponseToRateLimits({
        rate_limits: { five_hour: { utilization: 0.5, resets_at: null } },
      }),
    ).toEqual({ primary: { label: "5시간", usedPercent: 0.5, windowDurationMinutes: 300 } });
  });

  it("keeps the session window when the weekly one is missing", () => {
    const { seven_day: _sevenDay, ...rateLimits } = fullResponse.rate_limits;
    expect(claudeUsageResponseToRateLimits({ ...fullResponse, rate_limits: rateLimits })).toEqual({
      primary: fiveHour,
    });
  });

  it("keeps the weekly window when the session one is missing or has no reading", () => {
    for (const five_hour of [undefined, null, { utilization: null, resets_at: FIVE_HOUR_RESET }]) {
      expect(
        claudeUsageResponseToRateLimits({
          ...fullResponse,
          rate_limits: { ...fullResponse.rate_limits, five_hour },
        }),
      ).toEqual({ secondary: sevenDay });
    }
  });

  it("clamps out-of-range readings and drops an unreadable reset time", () => {
    expect(
      claudeUsageResponseToRateLimits({
        rate_limits: {
          five_hour: { utilization: 140, resets_at: "soon" },
          seven_day: { utilization: -3, resets_at: 1_795_000_000 },
        },
      }),
    ).toEqual({
      primary: { label: "5시간", usedPercent: 100, windowDurationMinutes: 300 },
      secondary: { label: "7일", usedPercent: 0, windowDurationMinutes: 10_080 },
    });
  });

  it("returns no windows for accounts without plan limits and for garbage", () => {
    for (const response of [
      { ...fullResponse, rate_limits_available: false, rate_limits: null },
      { rate_limits: "nope" },
      { rate_limits: { five_hour: "37%", seven_day: [61] } },
      { rate_limits: { five_hour: { utilization: Number.NaN }, seven_day: { utilization: "61" } } },
      { rate_limits: { model_scoped: [{ display_name: "Fable", utilization: 93 }] } },
      {},
      null,
      undefined,
      "error",
      42,
      [],
    ]) {
      expect(claudeUsageResponseToRateLimits(response)).toEqual({});
    }
  });
});

describe("claudeAccountUsage", () => {
  it("builds a provider-side usage snapshot the wire contract accepts", () => {
    const usage = claudeAccountUsage({
      fetchedAt: "2026-11-20T11:00:00.000Z",
      rateLimits: claudeUsageResponseToRateLimits(fullResponse),
    });
    expect(usage).toEqual({
      source: "provider",
      updatedAt: "2026-11-20T11:00:00.000Z",
      sessionTokens: 0,
      sessionCount: 0,
      activeSessionCount: 0,
      primary: fiveHour,
      secondary: sevenDay,
    });
    expect(decodeUsage(usage)).toEqual(usage);
  });

  it("reports nothing when no window was read", () => {
    expect(
      claudeAccountUsage({ fetchedAt: "2026-11-20T11:00:00.000Z", rateLimits: {} }),
    ).toBeUndefined();
  });
});

describe("shouldReadClaudeUsage", () => {
  it("asks only where plan limits can exist", () => {
    expect(shouldReadClaudeUsage({ authMode: "subscription", apiProvider: undefined })).toBe(true);
    expect(shouldReadClaudeUsage({ authMode: undefined, apiProvider: "firstParty" })).toBe(true);
    expect(shouldReadClaudeUsage({ authMode: "api-key", apiProvider: "firstParty" })).toBe(false);
    expect(shouldReadClaudeUsage({ authMode: undefined, apiProvider: "bedrock" })).toBe(false);
  });
});

describe("readClaudeRateLimits", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("asks the control channel for limits without the local transcript scan", async () => {
    const requests: Array<unknown> = [];
    const query = {
      request(this: unknown, body: unknown) {
        requests.push({ self: this === query, body });
        return Promise.resolve({ subtype: "success", response: fullResponse });
      },
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: () => {
        throw new Error("the typed method must not be used when the control channel exists");
      },
    };
    await expect(readClaudeRateLimits(query, 4_000)).resolves.toEqual({
      status: "ok",
      rateLimits: { primary: fiveHour, secondary: sevenDay },
    });
    expect(requests).toEqual([
      { self: true, body: { subtype: "get_usage", skip_behaviors: true } },
    ]);
  });

  it("falls back to the typed SDK method and still asks to skip the scan", async () => {
    const options: Array<unknown> = [];
    const query = {
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async (option: unknown) => {
        options.push(option);
        return fullResponse;
      },
    };
    await expect(readClaudeRateLimits(query, 4_000)).resolves.toMatchObject({ status: "ok" });
    expect(options).toEqual([{ skipBehaviors: true }]);
  });

  it("reports an SDK without the usage API as unsupported", async () => {
    await expect(readClaudeRateLimits({}, 4_000)).resolves.toEqual({ status: "unsupported" });
    await expect(readClaudeRateLimits(undefined, 4_000)).resolves.toEqual({
      status: "unsupported",
    });
  });

  it("resolves instead of rejecting when the request fails or throws", async () => {
    await expect(
      readClaudeRateLimits({ request: () => Promise.reject(new Error("not logged in")) }, 4_000),
    ).resolves.toEqual({ status: "failed" });
    await expect(
      readClaudeRateLimits(
        {
          request: () => {
            throw new Error("transport closed");
          },
        },
        4_000,
      ),
    ).resolves.toEqual({ status: "failed" });
  });

  it("gives up at the deadline and swallows an answer that fails afterwards", async () => {
    vi.useFakeTimers();
    let rejectRequest: (cause: Error) => void = () => {};
    const query = {
      request: () =>
        new Promise((_resolve, reject) => {
          rejectRequest = reject;
        }),
    };
    const result = readClaudeRateLimits(query, 4_000);
    await vi.advanceTimersByTimeAsync(4_000);
    await expect(result).resolves.toEqual({ status: "timeout" });
    // The probe aborts its process next, which rejects the pending request.
    rejectRequest(new Error("Control request aborted"));
    await vi.advanceTimersByTimeAsync(0);
  });

  it("does not start a request when no time is left in the probe budget", async () => {
    const request = vi.fn();
    await expect(readClaudeRateLimits({ request }, 0)).resolves.toEqual({ status: "timeout" });
    await expect(readClaudeRateLimits({ request }, -250)).resolves.toEqual({ status: "timeout" });
    expect(request).not.toHaveBeenCalled();
  });
});
