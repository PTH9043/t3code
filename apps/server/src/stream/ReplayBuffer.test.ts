import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { makeReplayBuffer, retainedPayloadBytes } from "./ReplayBuffer.ts";

it.effect("releases retained bytes as a healthy consumer drains ordered events", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const buffer = yield* makeReplayBuffer<number, string>({
        maxItems: 4,
        maxBytes: 1024,
        overflow: () => "slow consumer",
      });
      yield* buffer.offer(1);
      yield* buffer.offer(2);
      expect(buffer.stats().queuedItems).toBe(2);
      expect(yield* buffer.stream.pipe(Stream.take(1), Stream.runCollect)).toEqual([1]);
      yield* buffer.offer(3);
      expect(yield* buffer.takeAll).toEqual([2, 3]);
      expect(buffer.stats()).toMatchObject({ queuedItems: 0, queuedBytes: 0, peakItems: 2 });
    }),
  ),
);

it.effect("fails and releases a slow tail at the item limit without dropping events silently", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const buffer = yield* makeReplayBuffer<number, string>({
        maxItems: 2,
        maxBytes: 1024,
        overflow: () => "resume from durable cursor",
      });
      yield* buffer.offer(1);
      yield* buffer.offer(2);
      const offer = yield* buffer.offer(3).pipe(Effect.result);
      expect(offer).toMatchObject({ _tag: "Failure", failure: "resume from durable cursor" });
      const result = yield* buffer.stream.pipe(Stream.runCollect, Effect.result);
      expect(result).toMatchObject({ _tag: "Failure", failure: "resume from durable cursor" });
      expect(buffer.stats()).toMatchObject({ queuedItems: 0, queuedBytes: 0, peakItems: 2 });
    }),
  ),
);

it.effect("rejects one oversized payload before retaining it", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const buffer = yield* makeReplayBuffer<{ content: string }, string>({
        maxItems: 100,
        maxBytes: 1024,
        overflow: () => "byte budget exceeded",
      });
      const result = yield* buffer.offer({ content: "가".repeat(100_000) }).pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      expect(buffer.stats()).toMatchObject({ queuedItems: 0, queuedBytes: 0, peakBytes: 0 });
    }),
  ),
);

it("bounds traversal work for deeply nested and wide untrusted payloads", () => {
  expect(retainedPayloadBytes({ text: "가나다" }, 1024)).toBeGreaterThan(6);
  expect(
    retainedPayloadBytes(
      Array.from({ length: 100_000 }, () => 0),
      1024,
    ),
  ).toBeGreaterThan(1024);
});
