import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * The person's interjections into a live meeting, one row per remark.
 *
 * A separate table rather than a field inside `meeting_json` on purpose: the
 * reactor persists the run by writing that JSON wholesale from its own (often
 * seconds-old) snapshot, so anything the person appended there mid-turn would
 * be silently overwritten. Rows here are only ever inserted by the projection
 * and read back at decode time, which makes the write race structurally
 * impossible instead of merely unlikely.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_workspace_collaboration_interjections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      text TEXT NOT NULL,
      round_index INTEGER NOT NULL,
      after_statements INTEGER NOT NULL,
      said_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_workspace_collaboration_interjections_run
    ON projection_workspace_collaboration_interjections (project_id, run_id, id)
  `;
});
