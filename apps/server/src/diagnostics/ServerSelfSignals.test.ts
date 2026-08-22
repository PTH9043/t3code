import type { TraceRecord } from "@t3tools/shared/observability";
import { expect, it } from "vite-plus/test";

import { SELF_SIGNAL_SLOW_SPAN_MS, makeServerSelfSignals } from "./ServerSelfSignals.ts";

const T0 = Date.parse("2026-08-21T12:00:30.000Z");

function span(input: {
  readonly atMs: number;
  readonly durationMs: number;
  readonly failed?: boolean;
}): TraceRecord {
  return {
    type: "effect-span",
    name: "x",
    traceId: "t",
    spanId: "s",
    sampled: true,
    kind: "internal",
    startTimeUnixNano: String(BigInt(input.atMs - input.durationMs) * 1_000_000n),
    endTimeUnixNano: String(BigInt(input.atMs) * 1_000_000n),
    durationMs: input.durationMs,
    attributes: {},
    events: [],
    links: [],
    exit: input.failed ? { _tag: "Failure", cause: "boom" } : { _tag: "Success" },
  } as unknown as TraceRecord;
}

function fakeHistogram(p99Ns: number) {
  let value = p99Ns;
  return {
    percentile: () => value,
    reset: () => {
      value = 0;
    },
  } as never;
}

it("counts slow and failed spans per minute over the requested window and ignores the rest", () => {
  const signals = makeServerSelfSignals({ histogram: fakeHistogram(0) });
  signals.recordSpan(span({ atMs: T0 - 10_000, durationMs: SELF_SIGNAL_SLOW_SPAN_MS + 1 }));
  signals.recordSpan(span({ atMs: T0 - 10_000, durationMs: 5, failed: true }));
  signals.recordSpan(span({ atMs: T0 - 10_000, durationMs: 5 }));
  signals.recordSpan(span({ atMs: T0 - 4 * 60_000, durationMs: 2_000 }));
  signals.recordSpan(span({ atMs: T0 - 70 * 60_000, durationMs: 2_000 })); // outside the ring

  const oneMinute = signals.read(1, T0);
  expect(oneMinute.slowSpansPerMin).toBe(1);
  expect(oneMinute.failedSpansPerMin).toBe(1);

  const fiveMinutes = signals.read(5, T0);
  expect(fiveMinutes.slowSpansPerMin).toBeCloseTo(2 / 5);
  expect(fiveMinutes.failedSpansPerMin).toBeCloseTo(1 / 5);
});

it("reports event-loop p99 in milliseconds and resets the histogram on read", () => {
  const signals = makeServerSelfSignals({ histogram: fakeHistogram(250_000_000) });
  expect(signals.read(1, T0).eventLoopP99Ms).toBe(250);
  expect(signals.read(1, T0).eventLoopP99Ms).toBe(0);
});
