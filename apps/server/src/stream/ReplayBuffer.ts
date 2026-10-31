import * as NodeBuffer from "node:buffer";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

/** Estimate retained payload size without serializing a second copy of large events. */
export function retainedPayloadBytes(input: unknown, limit: number): number {
  let total = 0;
  let nodes = 0;
  const seen = new Set<object>();
  const visit = (value: unknown, depth: number): void => {
    if (total > limit) return;
    if (++nodes > 8192 || depth > 32) {
      total = limit + 1;
      return;
    }
    if (typeof value === "string") {
      total += 32 + Math.max(value.length * 2, NodeBuffer.Buffer.byteLength(value));
    } else if (value !== null && typeof value === "object") {
      if (seen.has(value)) return;
      seen.add(value);
      total += 64;
      for (const key in value) {
        if (!Object.hasOwn(value, key)) continue;
        total += 16 + key.length * 2;
        visit((value as Record<string, unknown>)[key], depth + 1);
        if (total > limit) break;
      }
    } else {
      total += 8;
    }
  };
  visit(input, 0);
  return total;
}

/** A failed subscription resumes from durable sequence state instead of retaining a slow tail. */
export const makeReplayBuffer = Effect.fn("makeReplayBuffer")(function* <A, E>(options: {
  readonly maxItems: number;
  readonly maxBytes: number;
  readonly overflow: (stats: {
    queuedItems: number;
    queuedBytes: number;
    peakItems: number;
    peakBytes: number;
    maxWaitMs: number;
  }) => E;
}) {
  const clock = yield* Clock.Clock;
  const queue = yield* Queue.dropping<{ value: A; bytes: number; enqueuedAt: number }, E>(
    options.maxItems,
  );
  let queuedItems = 0;
  let queuedBytes = 0;
  let peakItems = 0;
  let peakBytes = 0;
  let maxWaitMs = 0;
  let failed = false;
  const stats = () => ({ queuedItems, queuedBytes, peakItems, peakBytes, maxWaitMs });
  const release = (entry: { bytes: number; enqueuedAt: number }) => {
    queuedItems--;
    queuedBytes -= entry.bytes;
    maxWaitMs = Math.max(maxWaitMs, clock.currentTimeMillisUnsafe() - entry.enqueuedAt);
  };
  yield* Effect.addFinalizer(() =>
    Queue.shutdown(queue).pipe(
      Effect.andThen(
        Effect.sync(() => {
          queuedItems = 0;
          queuedBytes = 0;
        }),
      ),
    ),
  );
  const offer = Effect.fn("ReplayBuffer.offer")(function* (value: A) {
    if (failed) return yield* Effect.fail(options.overflow(stats()));
    const bytes = retainedPayloadBytes(value, options.maxBytes);
    if (queuedItems >= options.maxItems || queuedBytes + bytes > options.maxBytes) {
      failed = true;
      const error = options.overflow(stats());
      let discarded = Queue.takeUnsafe(queue);
      while (discarded?._tag === "Success") {
        release(discarded.value);
        discarded = Queue.takeUnsafe(queue);
      }
      yield* Queue.fail(queue, error);
      return yield* Effect.fail(error);
    }
    queuedItems++;
    queuedBytes += bytes;
    peakItems = Math.max(peakItems, queuedItems);
    peakBytes = Math.max(peakBytes, queuedBytes);
    Queue.offerUnsafe(queue, { value, bytes, enqueuedAt: clock.currentTimeMillisUnsafe() });
  });
  const takeAll = Queue.takeAll(queue).pipe(
    Effect.map((entries) =>
      entries.map((entry) => {
        release(entry);
        return entry.value;
      }),
    ),
  );
  const stream = Stream.fromEffectRepeat(
    Queue.take(queue).pipe(
      Effect.map((entry) => {
        release(entry);
        return entry.value;
      }),
    ),
  );
  return { offer, stream, takeAll, stats };
});
