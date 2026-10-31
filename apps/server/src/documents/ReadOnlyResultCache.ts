import * as NodeCrypto from "node:crypto";
import { Context, DateTime, Deferred, Effect, Layer, Option, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export class CacheComputationError extends Schema.TaggedErrorClass<CacheComputationError>()(
  "CacheComputationError",
  { message: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}
export interface ReadOnlyCacheResult {
  readonly value: string;
  readonly status: "computed" | "hit" | "joined" | "bypassed";
}
interface CacheInput {
  readonly scope: string;
  readonly key: string;
  readonly ttlMs: number;
  readonly bypass?: boolean;
  readonly validate: (value: string) => boolean;
  readonly compute: Effect.Effect<string, CacheComputationError>;
}
const hash = (value: string) => NodeCrypto.createHash("sha256").update(value).digest("hex");
const Row = Schema.Struct({ value_json: Schema.String, value_hash: Schema.String });
const decodeRow = Schema.decodeUnknownOption(Row);
const encodeKey = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));
const MAX_ENTRY_BYTES = 1_000_000;
const MAX_ENTRIES = 128;
const MAX_BYTES = 32_000_000;

/** Exact immutable reads only. The caller validates dependencies before lookup and the value on every hit. */
export class ReadOnlyResultCache extends Context.Service<
  ReadOnlyResultCache,
  {
    readonly getOrCompute: (
      input: CacheInput,
    ) => Effect.Effect<ReadOnlyCacheResult, CacheComputationError>;
  }
>()("t3/documents/ReadOnlyResultCache") {
  static readonly layer = Layer.effect(
    ReadOnlyResultCache,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const pending = new Map<
        string,
        Deferred.Deferred<ReadOnlyCacheResult, CacheComputationError>
      >();
      const now = DateTime.now.pipe(Effect.map(DateTime.toEpochMillis));
      const getOrCompute = Effect.fn("ReadOnlyResultCache.getOrCompute")(function* (
        input: CacheInput,
      ) {
        if (input.bypass) return { value: yield* input.compute, status: "bypassed" as const };
        const scope = hash(input.scope);
        const key = hash(encodeKey([scope, input.key]));
        return yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const existing = pending.get(key);
            if (existing) {
              const result = yield* restore(Deferred.await(existing));
              return { ...result, status: "joined" as const };
            }
            const done = yield* Deferred.make<ReadOnlyCacheResult, CacheComputationError>();
            pending.set(key, done);
            return yield* restore(
              Effect.gen(function* () {
                const at = yield* now;
                const rows = yield* sql`SELECT value_json,value_hash FROM read_only_result_cache
          WHERE cache_key=${key} AND scope_hash=${scope} AND expires_at>${at}`.pipe(
                  Effect.orElseSucceed(() => []),
                );
                const row = decodeRow(rows[0]);
                if (
                  Option.isSome(row) &&
                  hash(row.value.value_json) === row.value.value_hash &&
                  input.validate(row.value.value_json)
                ) {
                  yield* sql`UPDATE read_only_result_cache SET accessed_at=${at} WHERE cache_key=${key}`.pipe(
                    Effect.ignore,
                  );
                  return { value: row.value.value_json, status: "hit" as const };
                }
                const value = yield* input.compute;
                const size = Buffer.byteLength(value, "utf8");
                if (size <= MAX_ENTRY_BYTES && input.validate(value)) {
                  const completedAt = yield* now;
                  const expiresAt =
                    completedAt + Math.min(Math.max(0, input.ttlMs), 7 * 24 * 60 * 60 * 1000);
                  yield* sql
                    .withTransaction(
                      Effect.gen(function* () {
                        yield* sql`DELETE FROM read_only_result_cache WHERE expires_at<=${completedAt}`;
                        yield* sql`INSERT OR REPLACE INTO read_only_result_cache
              (cache_key,scope_hash,value_json,value_hash,byte_size,expires_at,accessed_at)
              VALUES (${key},${scope},${value},${hash(value)},${size},${expiresAt},${completedAt})`;
                        yield* sql`DELETE FROM read_only_result_cache WHERE cache_key IN (
              SELECT cache_key FROM (
                SELECT cache_key, ROW_NUMBER() OVER (ORDER BY accessed_at DESC,cache_key) AS row_number,
                  SUM(byte_size) OVER (ORDER BY accessed_at DESC,cache_key) AS total_bytes
                FROM read_only_result_cache
              ) WHERE row_number>${MAX_ENTRIES} OR total_bytes>${MAX_BYTES}
            )`;
                      }),
                    )
                    .pipe(Effect.ignore);
                }
                return { value, status: "computed" as const };
              }),
            ).pipe(
              Effect.onExit((exit) => Deferred.done(done, exit)),
              Effect.ensuring(
                Effect.sync(() => {
                  pending.delete(key);
                }),
              ),
            );
          }),
        );
      });
      return { getOrCompute };
    }),
  );
}
