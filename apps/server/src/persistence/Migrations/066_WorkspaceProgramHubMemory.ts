import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Existing programs get no budget and no shared datasets; both are explicit choices. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    ALTER TABLE projection_workspace_programs
    ADD COLUMN hub_memory_json TEXT NOT NULL
      DEFAULT '{"commitLimitMb":null,"concurrencyGroup":null,"concurrencySlots":null,"sharedDatasets":[]}'
    CHECK (json_valid(hub_memory_json))
  `;
});
