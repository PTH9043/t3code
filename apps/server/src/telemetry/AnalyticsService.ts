/**
 * Analytics telemetry service (permanently disabled).
 *
 * Outbound product telemetry (PostHog / ingest.t3.codes), credential-derived
 * identifiers, and background telemetry flushing are hard-disabled in this
 * fork regardless of environment variables.
 *
 * @module AnalyticsService
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export const ANALYTICS_SEND_TIMEOUT_MS = 3_000;
export const ANALYTICS_BACKOFF_INITIAL_MS = 30_000;
export const ANALYTICS_BACKOFF_MAX_MS = 600_000;

export function computeAnalyticsBackoffMs(failureStreak: number): number {
  if (failureStreak <= 0) {
    return 0;
  }
  const exponent = Math.min(failureStreak - 1, 10);
  return Math.min(ANALYTICS_BACKOFF_MAX_MS, ANALYTICS_BACKOFF_INITIAL_MS * 2 ** exponent);
}

const NOOP_ANALYTICS_SERVICE = {
  record: () => Effect.void,
  flush: Effect.void,
} as const;

export class AnalyticsService extends Context.Service<
  AnalyticsService,
  {
    /** No-op: outbound analytics telemetry is permanently disabled. */
    readonly record: (
      event: string,
      properties?: Readonly<Record<string, unknown>>,
    ) => Effect.Effect<void>;

    /** No-op: outbound analytics telemetry is permanently disabled. */
    readonly flush: Effect.Effect<void>;
  }
>()("t3/telemetry/AnalyticsService") {
  /** No-op layer for callers that intentionally disable telemetry. */
  static readonly layerTest = Layer.succeed(AnalyticsService, NOOP_ANALYTICS_SERVICE);
}

export const make: Effect.Effect<AnalyticsService["Service"]> = Effect.succeed(
  AnalyticsService.of(NOOP_ANALYTICS_SERVICE),
);

export const layer = Layer.effect(AnalyticsService, make);

export const layerTest = AnalyticsService.layerTest;
