import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Adds `council_mode` ('discussion' | 'code_patch') and `synthesis_report_md` columns
 * to `council_sessions` with idempotent PRAGMA column inspection for backward compatibility.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const cols = yield* sql<{ readonly name: string }>`PRAGMA table_info(council_sessions)`;
  const existing = new Set(cols.map((c) => c.name));

  if (!existing.has("council_mode")) {
    yield* sql`ALTER TABLE council_sessions
      ADD COLUMN council_mode TEXT NOT NULL DEFAULT 'code_patch'`;
  }

  if (!existing.has("synthesis_report_md")) {
    yield* sql`ALTER TABLE council_sessions
      ADD COLUMN synthesis_report_md TEXT`;
  }
});
