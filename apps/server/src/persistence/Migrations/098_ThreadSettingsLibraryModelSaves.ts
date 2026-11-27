import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// Opening the settings library should only scan user model saves, even on large event histories.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE INDEX thread_settings_library_model_saves
    ON orchestration_events(stream_id, sequence DESC)
    WHERE aggregate_kind='thread' AND event_type='thread.meta-updated' AND actor_kind='client'
      AND json_type(payload_json, '$.modelSelection')='object'`;
});
