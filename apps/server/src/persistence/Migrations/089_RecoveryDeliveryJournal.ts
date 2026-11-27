import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS recovery_delivery_journal (
    event_id TEXT PRIMARY KEY REFERENCES orchestration_events(event_id),
    thread_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    event_sequence INTEGER NOT NULL UNIQUE REFERENCES orchestration_events(sequence),
    state TEXT NOT NULL CHECK (state IN ('queued', 'sending', 'accepted', 'unknown', 'cancelled')),
    updated_at TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS recovery_delivery_state_sequence
    ON recovery_delivery_journal(state, event_sequence)`;
});
