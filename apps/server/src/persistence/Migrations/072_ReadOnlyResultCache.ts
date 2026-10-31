import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS read_only_result_cache (
    cache_key TEXT PRIMARY KEY, scope_hash TEXT NOT NULL, value_json TEXT NOT NULL,
    value_hash TEXT NOT NULL, byte_size INTEGER NOT NULL,
    expires_at INTEGER NOT NULL, accessed_at INTEGER NOT NULL
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS read_only_result_cache_expiry ON read_only_result_cache(expires_at)`;
});
