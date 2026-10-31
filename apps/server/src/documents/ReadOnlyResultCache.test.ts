import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer } from "effect";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { CacheComputationError, ReadOnlyResultCache } from "./ReadOnlyResultCache.ts";

it.layer(ReadOnlyResultCache.layer.pipe(Layer.provideMerge(SqlitePersistenceMemory)))(
  "read-only result cache",
  (it) => {
    it.effect(
      "reuses exact valid results but separates project, dependency revision and forced refresh",
      () =>
        Effect.gen(function* () {
          const cache = yield* ReadOnlyResultCache;
          let calls = 0;
          const input = {
            scope: "project-a",
            key: "parser-v1:content-a",
            ttlMs: 1000,
            validate: (value: string) => value.startsWith("result"),
            compute: Effect.sync(() => `result-${++calls}`),
          };
          expect((yield* cache.getOrCompute(input)).status).toBe("computed");
          expect((yield* cache.getOrCompute(input)).value).toBe("result-1");
          expect((yield* cache.getOrCompute({ ...input, scope: "project-b" })).status).toBe(
            "computed",
          );
          expect((yield* cache.getOrCompute({ ...input, key: "parser-v2:content-a" })).status).toBe(
            "computed",
          );
          expect((yield* cache.getOrCompute({ ...input, bypass: true })).status).toBe("bypassed");
          yield* TestClock.adjust("1001 millis");
          expect((yield* cache.getOrCompute(input)).status).toBe("computed");
          expect(calls).toBe(5);
        }),
    );
    it.effect("rejects tampered, failed and partial results", () =>
      Effect.gen(function* () {
        const cache = yield* ReadOnlyResultCache;
        const sql = yield* SqlClient.SqlClient;
        let calls = 0;
        const input = {
          scope: "integrity",
          key: "content",
          ttlMs: 1000,
          validate: (value: string) => value === "complete",
          compute: Effect.sync(() => {
            calls++;
            return "complete";
          }),
        };
        yield* cache.getOrCompute(input);
        yield* sql`UPDATE read_only_result_cache SET value_json='tampered'`;
        expect((yield* cache.getOrCompute(input)).value).toBe("complete");
        expect(calls).toBe(2);
        const failed = yield* cache
          .getOrCompute({
            ...input,
            key: "failure",
            compute: Effect.fail(new CacheComputationError({ message: "failed" })),
          })
          .pipe(Effect.result);
        expect(failed._tag).toBe("Failure");
        expect((yield* cache.getOrCompute({ ...input, key: "failure" })).status).toBe("computed");
        yield* cache.getOrCompute({ ...input, key: "partial", compute: Effect.succeed("partial") });
        expect((yield* cache.getOrCompute({ ...input, key: "partial" })).status).toBe("computed");
      }),
    );
    it.effect(
      "coalesces simultaneous reads and releases cancelled computations without caching them",
      () =>
        Effect.gen(function* () {
          const cache = yield* ReadOnlyResultCache;
          let calls = 0;
          const input = {
            scope: "concurrent",
            key: "one",
            ttlMs: 1000,
            validate: () => true,
            compute: Effect.sync(() => {
              calls++;
              return "one result";
            }),
          };
          const results = yield* Effect.all(
            Array.from({ length: 10 }, () => cache.getOrCompute(input)),
            { concurrency: "unbounded" },
          );
          expect(calls).toBe(1);
          expect(results.every((result) => result.value === "one result")).toBe(true);
          const entered = yield* Deferred.make<void>();
          const owner = yield* cache
            .getOrCompute({
              ...input,
              key: "cancelled",
              compute: Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
            })
            .pipe(Effect.forkScoped);
          yield* Deferred.await(entered);
          yield* Fiber.interrupt(owner);
          expect((yield* cache.getOrCompute({ ...input, key: "cancelled" })).status).toBe(
            "computed",
          );
        }),
    );
    it.effect("bounds storage while leaving evidence tables untouched", () =>
      Effect.gen(function* () {
        const cache = yield* ReadOnlyResultCache;
        const sql = yield* SqlClient.SqlClient;
        for (let index = 0; index < 140; index++)
          yield* cache.getOrCompute({
            scope: "bounded",
            key: String(index),
            ttlMs: 1000,
            validate: () => true,
            compute: Effect.succeed("result"),
          });
        const rows = yield* sql<{
          count: number;
        }>`SELECT COUNT(*) AS count FROM read_only_result_cache`;
        expect(rows[0]?.count).toBeLessThanOrEqual(128);
        expect(
          (yield* cache.getOrCompute({
            scope: "large",
            key: "large",
            ttlMs: 1000,
            validate: () => true,
            compute: Effect.succeed("x".repeat(1_000_001)),
          })).status,
        ).toBe("computed");
        const large = yield* sql<{
          count: number;
        }>`SELECT COUNT(*) AS count FROM read_only_result_cache WHERE byte_size>1000000`;
        expect(large[0]?.count).toBe(0);
      }),
    );
  },
);
