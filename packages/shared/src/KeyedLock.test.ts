import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import { makeKeyedLock } from "./KeyedLock.ts";

describe("KeyedLock", () => {
  it.effect(
    "serializes holders and waiters while other keys progress, then releases all keys",
    () =>
      Effect.gen(function* () {
        const lock = makeKeyedLock();
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const order: string[] = [];
        const first = yield* lock
          .withKey(
            "a",
            Effect.gen(function* () {
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
              order.push("first");
            }),
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        const second = yield* lock
          .withKey(
            "a",
            Effect.sync(() => order.push("second")),
          )
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* lock.withKey(
          "b",
          Effect.sync(() => order.push("other")),
        );
        assert.deepEqual(order, ["other"]);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(first);
        yield* Fiber.join(second);
        assert.deepEqual(order, ["other", "first", "second"]);
        assert.equal(yield* lock.activeKeyCount, 0);
        yield* Effect.forEach(
          Array.from({ length: 2_000 }, (_, i) => String(i)),
          (key) => lock.withKey(key, Effect.void),
          { concurrency: 16, discard: true },
        );
        assert.equal(yield* lock.activeKeyCount, 0);
      }),
  );

  it.effect("releases keys on failure and interruption, including a cancelled waiter", () =>
    Effect.gen(function* () {
      const lock = makeKeyedLock();
      yield* lock.withKey("failed", Effect.fail("expected")).pipe(Effect.ignore);
      const held = yield* Deferred.make<void>();
      const holder = yield* lock
        .withKey("cancelled", Deferred.succeed(held, undefined).pipe(Effect.andThen(Effect.never)))
        .pipe(Effect.forkChild);
      yield* Deferred.await(held);
      const waiter = yield* lock
        .withKey("cancelled", Effect.never)
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Fiber.interrupt(waiter);
      assert.equal(yield* lock.activeKeyCount, 1);
      yield* Fiber.interrupt(holder);
      assert.equal(yield* lock.activeKeyCount, 0);
      yield* lock.withKey("cancelled", Effect.void);
      assert.equal(yield* lock.activeKeyCount, 0);
    }),
  );
});
