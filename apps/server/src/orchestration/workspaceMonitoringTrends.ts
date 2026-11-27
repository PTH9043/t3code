import type { WorkspaceMonitoringMetric } from "@t3tools/contracts";

/**
 * Trend math for 프로그램 모니터링 모드. Plain numbers in, a verdict out — no
 * Effect, no clock — so the reactor stays a thin sequencer and these rules are
 * testable by hand.
 */

export interface TrendSample {
  /** Epoch milliseconds. */
  readonly at: number;
  readonly value: number;
}

/** Fixed-capacity sample window; oldest sample falls off. */
export class SampleRing {
  readonly #samples: TrendSample[] = [];
  readonly #capacity: number;
  constructor(capacity: number) {
    this.#capacity = capacity;
  }

  push(sample: TrendSample): void {
    this.#samples.push(sample);
    if (this.#samples.length > this.#capacity) this.#samples.shift();
  }

  /** Samples at or after `sinceMs`, oldest first. */
  since(sinceMs: number): ReadonlyArray<TrendSample> {
    return this.#samples.filter((sample) => sample.at >= sinceMs);
  }

  get size(): number {
    return this.#samples.length;
  }
}

export interface TrendVerdict {
  readonly anomalous: boolean;
  /** Short human text of what was measured, used verbatim in the AI prompt. */
  readonly observed: string;
  /** "up" | "down" | "over" — part of the dedupe fingerprint. */
  readonly direction: "up" | "down" | "over";
}

/** Least-squares slope in value-units per minute; null with fewer than 3 points. */
export function slopePerMinute(samples: ReadonlyArray<TrendSample>): number | null {
  if (samples.length < 3) return null;
  const t0 = samples[0]!.at;
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;
  for (const sample of samples) {
    const x = (sample.at - t0) / 60_000;
    sumX += x;
    sumY += sample.value;
    sumXY += x * sample.value;
    sumXX += x * x;
  }
  const n = samples.length;
  const denominator = n * sumXX - sumX * sumX;
  if (denominator === 0) return null;
  return (n * sumXY - sumX * sumY) / denominator;
}

export function percentile(values: ReadonlyArray<number>, p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index]!;
}

const MIN_SAMPLES = 3;

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

/**
 * Judge one metric over its window. `nowMs` bounds the window; samples older
 * than two windows are ignored even if the ring still holds them, so a long
 * quiet period cannot resurrect an old baseline.
 */
export function evaluateTrend(
  metric: WorkspaceMonitoringMetric,
  ring: SampleRing,
  nowMs: number,
): TrendVerdict | null {
  const windowMs = metric.windowMin * 60_000;
  const current = ring.since(nowMs - windowMs);
  switch (metric.trend) {
    case "threshold": {
      if (current.length === 0) return null;
      // Count metrics and span rates already summarize their own window; using
      // their latest value avoids averaging the same window a second time.
      const spanRate = metric.metric === "slow-spans" || metric.metric === "failed-spans";
      const counting =
        metric.metric === "health" ||
        metric.metric === "regression" ||
        metric.metric === "log-matches" ||
        spanRate;
      const value = counting
        ? current.at(-1)!.value
        : current.reduce((sum, sample) => sum + sample.value, 0) / current.length;
      return {
        anomalous: value >= metric.limit,
        observed: counting
          ? metric.metric === "log-matches"
            ? `창 안 ${formatNumber(value)}줄 (한도 ${formatNumber(metric.limit)})`
            : spanRate
              ? `분당 ${formatNumber(value)}건 (한도 ${formatNumber(metric.limit)})`
              : `${formatNumber(value)}회 (한도 ${formatNumber(metric.limit)})`
          : `창 평균 ${formatNumber(value)} (한도 ${formatNumber(metric.limit)})`,
        direction: "over",
      };
    }
    case "slope": {
      if (current.length < MIN_SAMPLES) return null;
      const slope = slopePerMinute(current);
      if (slope === null) return null;
      return {
        anomalous: slope >= metric.limit,
        observed: `분당 ${formatNumber(slope)} 증가 (한도 ${formatNumber(metric.limit)})`,
        direction: slope >= 0 ? "up" : "down",
      };
    }
    case "p95-vs-baseline": {
      const baseline = ring
        .since(nowMs - 2 * windowMs)
        .filter((sample) => sample.at < nowMs - windowMs);
      if (current.length < MIN_SAMPLES || baseline.length < MIN_SAMPLES) return null;
      const currentP95 = percentile(
        current.map((sample) => sample.value),
        0.95,
      );
      const baselineP95 = percentile(
        baseline.map((sample) => sample.value),
        0.95,
      );
      if (currentP95 === null || baselineP95 === null || baselineP95 <= 0) return null;
      const ratio = currentP95 / baselineP95;
      return {
        anomalous: ratio >= metric.limit,
        observed: `p95 ${formatNumber(currentP95)} vs 직전 ${formatNumber(baselineP95)} (${formatNumber(ratio)}배, 한도 ${formatNumber(metric.limit)}배)`,
        direction: ratio >= 1 ? "up" : "down",
      };
    }
  }
}
