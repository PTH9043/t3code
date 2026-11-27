import { assert, describe, it } from "@effect/vitest";
import type { EffectTraceRecord, TraceRecord } from "@t3tools/shared/observability";

import { ROUTINE_SPAN_MAX_DURATION_MS, shouldPersistTraceRecord } from "./traceRetention.ts";

const span = (overrides: Partial<EffectTraceRecord>): EffectTraceRecord => ({
  type: "effect-span",
  name: "sql.execute",
  kind: "internal",
  traceId: "trace-1",
  spanId: "span-1",
  sampled: true,
  startTimeUnixNano: "0",
  endTimeUnixNano: "1000000",
  durationMs: 1,
  attributes: {},
  events: [],
  links: [],
  exit: { _tag: "Success" },
  ...overrides,
});

describe("shouldPersistTraceRecord", () => {
  it("drops fast, successful, event-less spans", () => {
    assert.strictEqual(shouldPersistTraceRecord(span({})), false);
    assert.strictEqual(
      shouldPersistTraceRecord(span({ durationMs: ROUTINE_SPAN_MAX_DURATION_MS - 0.001 })),
      false,
    );
  });

  it("keeps spans that are slow, failed, interrupted or logged something", () => {
    assert.strictEqual(
      shouldPersistTraceRecord(span({ durationMs: ROUTINE_SPAN_MAX_DURATION_MS })),
      true,
    );
    assert.strictEqual(
      shouldPersistTraceRecord(span({ exit: { _tag: "Failure", cause: "boom" } })),
      true,
    );
    assert.strictEqual(
      shouldPersistTraceRecord(span({ exit: { _tag: "Interrupted", cause: "stop" } })),
      true,
    );
    assert.strictEqual(
      shouldPersistTraceRecord(
        span({ events: [{ name: "warning", timeUnixNano: "1", attributes: {} }] }),
      ),
      true,
    );
    // A duration that cannot be compared is kept rather than silently lost.
    assert.strictEqual(shouldPersistTraceRecord(span({ durationMs: Number.NaN })), true);
  });

  it("keeps spans that did not come from this process", () => {
    const browser: TraceRecord = {
      ...span({}),
      type: "otlp-span",
      resourceAttributes: {},
      scope: { attributes: {} },
    };
    assert.strictEqual(shouldPersistTraceRecord(browser), true);
  });
});
