import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Reversible tool-output compression store (CCR — Content Reversible Compression).
 * Stores secret-scrubbed, gzip-compressed originals keyed by deterministic hash
 * and scoped to `thread_id` so models receive compact summaries while retaining
 * lossless on-demand retrieval via `workspace_retrieve_output`.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`CREATE TABLE IF NOT EXISTS ccr_tool_outputs (
    output_hash       TEXT NOT NULL,
    thread_id         TEXT NOT NULL,
    tool_name         TEXT NOT NULL,
    mime_kind         TEXT NOT NULL,
    raw_bytes         INTEGER NOT NULL,
    compressed_bytes  INTEGER NOT NULL,
    payload_gzip      BLOB NOT NULL,
    created_at        TEXT NOT NULL,
    expires_at        TEXT NOT NULL,
    PRIMARY KEY (thread_id, output_hash)
  )`;

  yield* sql`CREATE INDEX IF NOT EXISTS idx_ccr_tool_outputs_expires
    ON ccr_tool_outputs(expires_at)`;
});
