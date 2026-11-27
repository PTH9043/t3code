import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS pending_thread_model_team_seeds (
    thread_id TEXT PRIMARY KEY,
    event_sequence INTEGER NOT NULL UNIQUE
  )`;
});
