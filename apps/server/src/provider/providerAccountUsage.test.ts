import { describe, expect, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderRuntimeEvent,
  ServerProvider,
  type ServerProviderUsage,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import {
  makeEmptyProviderAccountUsageState,
  mergeProviderAccountUsage,
  normalizeProviderRateLimits,
  providerAccountUsageFromState,
  reduceProviderAccountUsage,
  trackProviderInstanceUsage,
} from "./providerAccountUsage.ts";
import type { ProviderInstance } from "./ProviderDriver.ts";

const decodeRuntimeEvent = Schema.decodeUnknownSync(ProviderRuntimeEvent);
const decodeServerProvider = Schema.decodeUnknownSync(ServerProvider);

function runtimeEvent(input: {
  readonly id: string;
  readonly type: string;
  readonly createdAt: string;
  readonly payload: unknown;
}) {
  return decodeRuntimeEvent({
    type: input.type,
    eventId: input.id,
    provider: "codex",
    providerInstanceId: "codex_work",
    threadId: "thread-work",
    createdAt: input.createdAt,
    payload: input.payload,
  });
}

describe("provider account usage", () => {
  it("preserves numeric provider credit balances without inventing missing balances", () => {
    expect(
      normalizeProviderRateLimits({ credits: { balance: 62500, hasCredits: true } })?.credits,
    ).toEqual({ balance: "62500", hasCredits: true });
    expect(
      normalizeProviderRateLimits({ credits: { balance: Number.POSITIVE_INFINITY } }),
    ).toBeUndefined();
  });
  it("does not fabricate a context or account counter from consumption-only evidence", () => {
    const state = makeEmptyProviderAccountUsageState();
    const event = runtimeEvent({
      id: "consumption-only",
      type: "thread.token-usage.updated",
      createdAt: "2026-09-12T00:00:00.000Z",
      payload: { consumption: [] },
    });
    expect(reduceProviderAccountUsage(state, event)).toBe(state);
  });
  it("normalizes Codex quota windows and credits", () => {
    expect(
      normalizeProviderRateLimits({
        rateLimits: {
          planType: "pro",
          primary: { usedPercent: 31, resetsAt: 1_775_779_200, windowDurationMins: 300 },
          secondary: { usedPercent: 64, windowDurationMins: 10_080 },
          credits: { balance: "9.50", hasCredits: true, unlimited: false },
        },
      }),
    ).toEqual({
      planType: "pro",
      primary: {
        usedPercent: 31,
        resetsAt: 1_775_779_200,
        windowDurationMinutes: 300,
      },
      secondary: { usedPercent: 64, windowDurationMinutes: 10_080 },
      credits: { balance: "9.50", hasCredits: true, unlimited: false },
    });
  });

  it("maps Claude utilization events to their matching quota window", () => {
    expect(
      normalizeProviderRateLimits({
        type: "rate_limit_event",
        rate_limit_info: {
          status: "allowed_warning",
          rateLimitType: "seven_day_sonnet",
          utilization: 0.725,
          resetsAt: 1_775_779_200,
        },
      }),
    ).toEqual({
      secondary: {
        label: "7일 · Sonnet",
        usedPercent: 72.5,
        resetsAt: 1_775_779_200,
      },
    });
  });

  it("keeps tokens and active sessions isolated in one instance accumulator", () => {
    let state = makeEmptyProviderAccountUsageState();
    state = reduceProviderAccountUsage(
      state,
      runtimeEvent({
        id: "session-started",
        type: "session.started",
        createdAt: "2026-08-09T01:00:00.000Z",
        payload: {},
      }),
    );
    state = reduceProviderAccountUsage(
      state,
      runtimeEvent({
        id: "usage-1",
        type: "thread.token-usage.updated",
        createdAt: "2026-08-09T01:01:00.000Z",
        payload: { usage: { usedTokens: 100, totalProcessedTokens: 400 } },
      }),
    );
    state = reduceProviderAccountUsage(
      state,
      runtimeEvent({
        id: "usage-2",
        type: "thread.token-usage.updated",
        createdAt: "2026-08-09T01:02:00.000Z",
        payload: { usage: { usedTokens: 150, totalProcessedTokens: 650 } },
      }),
    );
    state = reduceProviderAccountUsage(
      state,
      runtimeEvent({
        id: "rate-5h",
        type: "account.rate-limits.updated",
        createdAt: "2026-08-09T01:03:00.000Z",
        payload: {
          rateLimits: { rate_limit_info: { rateLimitType: "five_hour", utilization: 0.2 } },
        },
      }),
    );
    state = reduceProviderAccountUsage(
      state,
      runtimeEvent({
        id: "rate-7d",
        type: "account.rate-limits.updated",
        createdAt: "2026-08-09T01:04:00.000Z",
        payload: {
          rateLimits: { rate_limit_info: { rateLimitType: "seven_day", utilization: 0.6 } },
        },
      }),
    );
    state = reduceProviderAccountUsage(
      state,
      runtimeEvent({
        id: "session-exited",
        type: "session.exited",
        createdAt: "2026-08-09T01:05:00.000Z",
        payload: {},
      }),
    );

    expect(providerAccountUsageFromState(state)).toEqual({
      source: "runtime",
      updatedAt: "2026-08-09T01:05:00.000Z",
      sessionTokens: 650,
      sessionCount: 1,
      activeSessionCount: 0,
      primary: { label: "5시간", usedPercent: 20 },
      secondary: { label: "7일", usedPercent: 60 },
    });
  });

  it("preserves provider lifetime totals while adding runtime activity", () => {
    const providerUsage: ServerProviderUsage = {
      source: "provider",
      updatedAt: "2026-08-09T00:00:00.000Z",
      sessionTokens: 0,
      sessionCount: 0,
      activeSessionCount: 0,
      lifetimeTokens: 2_000_000,
      secondary: { label: "7일", usedPercent: 50 },
    };
    const runtimeState = reduceProviderAccountUsage(
      makeEmptyProviderAccountUsageState(),
      runtimeEvent({
        id: "runtime-usage",
        type: "thread.token-usage.updated",
        createdAt: "2026-08-09T02:00:00.000Z",
        payload: { usage: { usedTokens: 5_000 } },
      }),
    );

    expect(mergeProviderAccountUsage(providerUsage, runtimeState)).toMatchObject({
      source: "combined",
      updatedAt: "2026-08-09T02:00:00.000Z",
      sessionTokens: 5_000,
      sessionCount: 1,
      lifetimeTokens: 2_000_000,
      secondary: { label: "7일", usedPercent: 50 },
    });
  });

  it.effect("publishes adapter activity through the same instance snapshot", () =>
    Effect.gen(function* () {
      const event = runtimeEvent({
        id: "tracked-runtime-usage",
        type: "thread.token-usage.updated",
        createdAt: "2026-08-09T04:00:00.000Z",
        payload: { usage: { usedTokens: 250, totalProcessedTokens: 1_250 } },
      });
      const snapshot = decodeServerProvider({
        instanceId: "codex_work",
        driver: "codex",
        enabled: true,
        installed: true,
        version: "1.2.3",
        status: "ready",
        auth: { status: "authenticated" },
        checkedAt: "2026-08-09T03:59:00.000Z",
        models: [],
      });
      const instance = {
        instanceId: ProviderInstanceId.make("codex_work"),
        driverKind: ProviderDriverKind.make("codex"),
        snapshot: {
          maintenanceCapabilities: {},
          getSnapshot: Effect.succeed(snapshot),
          refresh: Effect.succeed(snapshot),
          streamChanges: Stream.empty,
        },
        adapter: { streamEvents: Stream.make(event) },
      } as unknown as ProviderInstance;

      const tracked = yield* trackProviderInstanceUsage(instance);
      yield* Stream.runDrain(tracked.adapter.streamEvents);
      const trackedSnapshot = yield* tracked.snapshot.getSnapshot;

      expect(trackedSnapshot.instanceId).toBe("codex_work");
      expect(trackedSnapshot.usage).toMatchObject({
        source: "runtime",
        sessionTokens: 1_250,
        sessionCount: 1,
      });
    }).pipe(Effect.scoped),
  );
});
