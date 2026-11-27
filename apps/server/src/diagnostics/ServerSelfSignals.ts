import type { TraceRecord } from "@t3tools/shared/observability";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as NodePerfHooks from "node:perf_hooks";

import { classifySpanCategory } from "./TraceDiagnostics.ts";

/**
 * The server's own vital signs for 프로그램 모니터링 모드's `self-server` target:
 * event-loop lag and the rate of slow / failed effect spans.
 *
 * Everything here is O(1) per span and a fixed one-hour ring of second buckets, installed
 * at boot regardless of whether self-monitoring is on — the cost of *having*
 * it is a couple of integer increments per finished span. Reading is pull:
 * the monitoring reactor asks once per check interval.
 */

const RING_MINUTES = 60;
const RING_SECONDS = RING_MINUTES * 60 + 1;
/** Same bar TraceDiagnostics uses for "slow". */
export const SELF_SIGNAL_SLOW_SPAN_MS = 1_000;

interface SecondBucket {
  second: number;
  slow: number;
  failed: number;
}

export interface ServerDelegationCounters {
  readonly delegationLimitsHit: number;
  readonly delegationsDeduplicated: number;
  readonly delegationsLost: number;
}

export type ServerDelegationCounterKind = "limit_hit" | "deduplicated" | "lost";

export interface ServerSelfSignalsReading {
  /** Event-loop delay p99 over the sampling period since the last read, in ms. */
  readonly eventLoopP99Ms: number;
  /** Spans slower than {@link SELF_SIGNAL_SLOW_SPAN_MS} per minute, averaged over the window. */
  readonly slowSpansPerMin: number;
  /** Spans that ended in Failure per minute, averaged over the window. */
  readonly failedSpansPerMin: number;
  /** Cumulative process-lifetime delegation health counters. */
  readonly delegationCounters?: ServerDelegationCounters;
}

export type ServerSelfSpanRates = Pick<
  ServerSelfSignalsReading,
  "slowSpansPerMin" | "failedSpansPerMin"
>;

export interface ServerSelfSignalsShape {
  /** Fed by the trace sink; must stay cheap. */
  readonly recordSpan: (record: TraceRecord) => void;
  /** Increment delegation loop health counters (limit hits, deduplications, lost runs). */
  readonly recordDelegationEvent?: (kind: ServerDelegationCounterKind) => void;
  /** Read current cumulative delegation health counters. */
  readonly readDelegationCounters?: () => ServerDelegationCounters;
  readonly read: (windowMin: number, nowMs: number) => ServerSelfSignalsReading;
  /** Read a span window without resetting the event-loop histogram. */
  readonly readRates: (windowMin: number, nowMs: number) => ServerSelfSpanRates;
}

export class ServerSelfSignals extends Context.Service<ServerSelfSignals, ServerSelfSignalsShape>()(
  "t3/diagnostics/ServerSelfSignals",
) {}

export function makeServerSelfSignals(options?: {
  readonly histogram?: NodePerfHooks.IntervalHistogram;
}): ServerSelfSignalsShape & {
  readonly recordDelegationEvent: (kind: ServerDelegationCounterKind) => void;
  readonly readDelegationCounters: () => ServerDelegationCounters;
} {
  const buckets: SecondBucket[] = Array.from({ length: RING_SECONDS }, () => ({
    second: Number.NEGATIVE_INFINITY,
    slow: 0,
    failed: 0,
  }));
  const bucketFor = (atMs: number): SecondBucket | null => {
    const second = Math.floor(atMs / 1_000);
    const slot = buckets[((second % RING_SECONDS) + RING_SECONDS) % RING_SECONDS]!;
    // A late record must not evict a newer second that wraps to the same slot.
    if (slot.second > second) return null;
    if (slot.second !== second) {
      slot.second = second;
      slot.slow = 0;
      slot.failed = 0;
    }
    return slot;
  };

  let histogram: NodePerfHooks.IntervalHistogram | null = options?.histogram ?? null;
  if (histogram === null) {
    try {
      histogram = NodePerfHooks.monitorEventLoopDelay({ resolution: 20 });
      histogram.enable();
    } catch {
      histogram = null;
    }
  }

  const readRates = (windowMin: number, nowMs: number): ServerSelfSpanRates => {
    const minutes = Math.max(1, Math.min(RING_MINUTES, Math.floor(windowMin)));
    const currentSecond = Math.floor(nowMs / 1_000);
    // Include the entire oldest second so a failure near a minute boundary is
    // not dropped early. This can include less than one extra second.
    const oldestSecond = Math.floor((nowMs - minutes * 60_000) / 1_000);
    let slow = 0;
    let failed = 0;
    for (let second = currentSecond; second >= oldestSecond; second -= 1) {
      const slot = buckets[((second % RING_SECONDS) + RING_SECONDS) % RING_SECONDS]!;
      if (slot.second !== second) continue;
      slow += slot.slow;
      failed += slot.failed;
    }
    return { slowSpansPerMin: slow / minutes, failedSpansPerMin: failed / minutes };
  };

  let delegationLimitsHit = 0;
  let delegationsDeduplicated = 0;
  let delegationsLost = 0;

  const readDelegationCounters = (): ServerDelegationCounters => ({
    delegationLimitsHit,
    delegationsDeduplicated,
    delegationsLost,
  });

  return {
    readRates,
    recordDelegationEvent: (kind) => {
      if (kind === "limit_hit") delegationLimitsHit += 1;
      else if (kind === "deduplicated") delegationsDeduplicated += 1;
      else if (kind === "lost") delegationsLost += 1;
    },
    readDelegationCounters,
    recordSpan: (record) => {
      if (record.type !== "effect-span") return;
      const category = classifySpanCategory(record.name, record.attributes);
      const slow = category === "operation" && record.durationMs >= SELF_SIGNAL_SLOW_SPAN_MS;
      const failed = record.exit._tag === "Failure";
      if (!slow && !failed) return;
      const endedAtMs = Number(record.endTimeUnixNano) / 1_000_000;
      if (!Number.isFinite(endedAtMs)) return;
      const bucket = bucketFor(endedAtMs);
      if (bucket === null) return;
      if (slow) bucket.slow += 1;
      if (failed) bucket.failed += 1;
    },
    read: (windowMin, nowMs) => {
      const rates = readRates(windowMin, nowMs);
      let eventLoopP99Ms = 0;
      if (histogram !== null) {
        // Histogram values are nanoseconds; reset so each read covers only
        // the interval since the previous one.
        eventLoopP99Ms = histogram.percentile(99) / 1_000_000;
        histogram.reset();
      }
      return {
        eventLoopP99Ms,
        ...rates,
        delegationCounters: readDelegationCounters(),
      };
    },
  };
}

/** One process-wide instance: the trace sink writes into it, the reactor reads from it. */
export const serverSelfSignals = makeServerSelfSignals();

export const layer = Layer.succeed(ServerSelfSignals, serverSelfSignals);
