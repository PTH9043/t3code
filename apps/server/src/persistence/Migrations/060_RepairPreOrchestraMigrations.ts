import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import tokenUsage from "./057_TokenUsage.ts";
import conversationHandoff from "./058_ConversationHandoffMode.ts";

/** 059 shipped without 057/058; the migrator skips IDs below its high-water mark. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const applied = yield* sql<{ readonly migrationId: number }>`
    SELECT migration_id AS "migrationId" FROM effect_sql_migrations
    WHERE migration_id IN (57, 58)
  `;
  for (const [id, name, migration] of [
    [57, "TokenUsage", tokenUsage],
    [58, "ConversationHandoffMode", conversationHandoff],
  ] as const) {
    if (applied.some((entry) => entry.migrationId === id)) continue;
    yield* migration;
    yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (${id}, ${name})`;
  }
});
