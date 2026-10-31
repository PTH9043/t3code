import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// Reconstruct only derived accounting from durable events. Preserve the original
// collection boundary so pre-instrumentation spend remains explicitly unknown.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM projection_token_usage_samples`;
  yield* sql`DELETE FROM projection_token_usage_cursors`;
  yield* sql`DELETE FROM projection_token_usage_requests`;
  yield* sql`UPDATE projection_state SET last_applied_sequence =
    (SELECT after_sequence FROM token_usage_collection WHERE id = 1)
    WHERE projector = 'projection.token-usage-v1'`;
});
