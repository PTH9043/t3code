import type { TraceRecord } from "@t3tools/shared/observability";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as NodePerfHooks from "node:perf_hooks";

/**
 * The server's own vital signs for 프로그램 모니터링 모드's `self-server` target:
 * event-loop lag and the rate of slow / failed effect spans.
 *
 * Everything here is O(1) per span and a fixed 60-slot minute ring, installed
 * at boot regardless of whether self-monitoring is on — the cost of *having*
 * it is a couple of integer increments per finished span. Reading is pull:
 * the monitoring reactor asks once per check interval.
 */

const RING_MINUTES = 60;
/** Same bar TraceDiagnostics uses for "slow". */
export const SELF_SIGNAL_SLOW_SPAN_MS = 1_000;

interface MinuteBucket {
  minute: number;
  slow: number;
  failed: number;
}

export interface ServerSelfSignalsReading {
  /** Event-loop delay p99 over the sampling period since the last read, in ms. */
  readonly eventLoopP99Ms: number;
  /** Spans slower than {@link SELF_SIGNAL_SLOW_SPAN_MS} per minute, averaged over the window. */
  readonly slowSpansPerMin: number;
  /** Spans that ended in Failure per minute, averaged over the window. */
  readonly failedSpansPerMin: number;
}

export interface ServerSelfSignalsShape {
  /** Fed by the trace sink; must stay cheap. */
  readonly recordSpan: (record: TraceRecord) => void;
  readonly read: (windowMin: number, nowMs: number) => ServerSelfSignalsReading;
}

export class ServerSelfSignals extends Context.Service<ServerSelfSignals, ServerSelfSignalsShape>()(
  "t3/diagnostics/ServerSelfSignals",
) {}

export function makeServerSelfSignals(options?: {
  readonly histogram?: NodePerfHooks.IntervalHistogram;
}): ServerSelfSignalsShape {
  const buckets: MinuteBucket[] = Array.from({ length: RING_MINUTES }, () => ({
    minute: -1,
    slow: 0,
    failed: 0,
  }));
  const bucketFor = (atMs: number): MinuteBucket => {
    const minute = Math.floor(atMs / 60_000);
    const slot = buckets[minute % RING_MINUTES]!;
    if (slot.minute !== minute) {
      slot.minute = minute;
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

  return {
    recordSpan: (record) => {
      if (record.type !== "effect-span") return;
      const slow = record.durationMs >= SELF_SIGNAL_SLOW_SPAN_MS;
      const failed = record.exit._tag === "Failure";
      if (!slow && !failed) return;
      const endedAtMs = Number(record.endTimeUnixNano) / 1_000_000;
      if (!Number.isFinite(endedAtMs)) return;
      const bucket = bucketFor(endedAtMs);
      if (slow) bucket.slow += 1;
      if (failed) bucket.failed += 1;
    },
    read: (windowMin, nowMs) => {
      const minutes = Math.max(1, Math.min(RING_MINUTES, Math.floor(windowMin)));
      const currentMinute = Math.floor(nowMs / 60_000);
      let slow = 0;
      let failed = 0;
      for (let offset = 0; offset < minutes; offset += 1) {
        const minute = currentMinute - offset;
        const slot = buckets[((minute % RING_MINUTES) + RING_MINUTES) % RING_MINUTES]!;
        if (slot.minute !== minute) continue;
        slow += slot.slow;
        failed += slot.failed;
      }
      let eventLoopP99Ms = 0;
      if (histogram !== null) {
        // Histogram values are nanoseconds; reset so each read covers only
        // the interval since the previous one.
        eventLoopP99Ms = histogram.percentile(99) / 1_000_000;
        histogram.reset();
      }
      return {
        eventLoopP99Ms,
        slowSpansPerMin: slow / minutes,
        failedSpansPerMin: failed / minutes,
      };
    },
  };
}

/** One process-wide instance: the trace sink writes into it, the reactor reads from it. */
export const serverSelfSignals = makeServerSelfSignals();

export const layer = Layer.succeed(ServerSelfSignals, serverSelfSignals);
