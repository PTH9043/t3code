import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";

import { makeDrainableWorker, makeKeyedDrainableWorker } from "./DrainableWorker.ts";

describe("makeDrainableWorker", () => {
  it.live("waits for work enqueued during active processing before draining", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const processed: string[] = [];
        const firstStarted = yield* Deferred.make<void>();
        const releaseFirst = yield* Deferred.make<void>();
        const secondStarted = yield* Deferred.make<void>();
        const releaseSecond = yield* Deferred.make<void>();

        const worker = yield* makeDrainableWorker((item: string) =>
          Effect.gen(function* () {
            if (item === "first") {
              yield* Deferred.succeed(firstStarted, undefined).pipe(Effect.orDie);
              yield* Deferred.await(releaseFirst);
            }

            if (item === "second") {
              yield* Deferred.succeed(secondStarted, undefined).pipe(Effect.orDie);
              yield* Deferred.await(releaseSecond);
            }

            processed.push(item);
          }),
        );

        yield* worker.enqueue("first");
        yield* Deferred.await(firstStarted);

        const drained = yield* Deferred.make<void>();
        yield* Effect.forkChild(
          worker.drain.pipe(
            Effect.tap(() => Deferred.succeed(drained, undefined).pipe(Effect.orDie)),
          ),
        );

        yield* worker.enqueue("second");
        yield* Deferred.succeed(releaseFirst, undefined);
        yield* Deferred.await(secondStarted);

        expect(yield* Deferred.isDone(drained)).toBe(false);

        yield* Deferred.succeed(releaseSecond, undefined);
        yield* Deferred.await(drained);

        expect(processed).toEqual(["first", "second"]);
      }),
    ),
  );
});

describe("makeKeyedDrainableWorker", () => {
  it.live("runs keys concurrently while items sharing a key stay in order", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const processed: string[] = [];
        const releaseA1 = yield* Deferred.make<void>();
        const a1Started = yield* Deferred.make<void>();
        const b1Done = yield* Deferred.make<void>();

        const worker = yield* makeKeyedDrainableWorker(
          (item: string) => item.split(":")[0] ?? item,
          (item) =>
            Effect.gen(function* () {
              if (item === "a:1") {
                yield* Deferred.succeed(a1Started, undefined).pipe(Effect.orDie);
                yield* Deferred.await(releaseA1);
              }
              processed.push(item);
              if (item === "b:1") {
                yield* Deferred.succeed(b1Done, undefined).pipe(Effect.orDie);
              }
            }),
        );

        yield* worker.enqueue("a:1");
        yield* worker.enqueue("a:2");
        yield* Deferred.await(a1Started);

        // A different key overtakes the blocked key instead of queueing
        // behind it.
        yield* worker.enqueue("b:1");
        yield* Deferred.await(b1Done);
        expect(processed).toEqual(["b:1"]);

        const drained = yield* Deferred.make<void>();
        yield* Effect.forkChild(
          worker.drain.pipe(
            Effect.tap(() => Deferred.succeed(drained, undefined).pipe(Effect.orDie)),
          ),
        );
        expect(yield* Deferred.isDone(drained)).toBe(false);

        yield* Deferred.succeed(releaseA1, undefined);
        yield* Deferred.await(drained);

        expect(processed).toEqual(["b:1", "a:1", "a:2"]);
      }),
    ),
  );

  it.live("keeps one worker per key under concurrent enqueues", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const entered: string[] = [];
        const firstEntered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();

        const worker = yield* makeKeyedDrainableWorker(
          () => "same-key",
          (item: string) =>
            Effect.gen(function* () {
              entered.push(item);
              if (entered.length === 1) {
                yield* Deferred.succeed(firstEntered, undefined).pipe(Effect.orDie);
                yield* Deferred.await(release);
              }
            }),
        );

        yield* Effect.forkChild(worker.enqueue("one"));
        yield* Effect.forkChild(worker.enqueue("two"));
        yield* Deferred.await(firstEntered);
        yield* Effect.sleep("25 millis");
        // A duplicate worker for the key would have started the second item
        // while the first is parked.
        expect(entered.length).toBe(1);

        yield* Deferred.succeed(release, undefined);
        yield* worker.drain;
        expect([...entered].sort()).toEqual(["one", "two"]);
      }),
    ),
  );

  it.live("keeps draining items enqueued for a fresh key mid-drain", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const processed: string[] = [];
        const releaseA = yield* Deferred.make<void>();
        const aStarted = yield* Deferred.make<void>();

        const worker = yield* makeKeyedDrainableWorker(
          (item: string) => item.split(":")[0] ?? item,
          (item) =>
            Effect.gen(function* () {
              if (item === "a:1") {
                yield* Deferred.succeed(aStarted, undefined).pipe(Effect.orDie);
                yield* Deferred.await(releaseA);
              }
              processed.push(item);
            }),
        );

        yield* worker.enqueue("a:1");
        yield* Deferred.await(aStarted);

        const drained = yield* Deferred.make<void>();
        yield* Effect.forkChild(
          worker.drain.pipe(
            Effect.tap(() => Deferred.succeed(drained, undefined).pipe(Effect.orDie)),
          ),
        );

        yield* worker.enqueue("c:1");
        yield* Deferred.succeed(releaseA, undefined);
        yield* Deferred.await(drained);

        expect(processed).toContain("a:1");
        expect(processed).toContain("c:1");
      }),
    ),
  );
});
