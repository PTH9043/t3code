import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import orchestra from "./059_WorkspaceCollaborationRunOrchestra.ts";

// Bounded to the window this repair owns, so a later migration joining the
// ledger does not read as a regression in 057-060.
const appliedIds = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly id: number }>`
    SELECT migration_id AS id FROM effect_sql_migrations
    WHERE migration_id BETWEEN 57 AND 60 ORDER BY migration_id
  `;
  return rows.map((row) => row.id);
});

it.effect("installs a fresh database and has nothing to redo on restart", () =>
  Effect.gen(function* () {
    yield* runMigrations();
    expect(yield* appliedIds).toEqual([57, 58, 59, 60]);
    expect(yield* runMigrations()).toEqual([]);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("repairs 059-only databases while retaining the original migration numbers", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 56 });
    yield* orchestra;
    yield* sql`INSERT INTO effect_sql_migrations (migration_id, name)
      VALUES (59, 'WorkspaceCollaborationRunOrchestra')`;
    expect(yield* runMigrations()).toContainEqual([60, "RepairPreOrchestraMigrations"]);
    expect(yield* appliedIds).toEqual([57, 58, 59, 60]);
    const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_threads)`;
    expect(columns.some((column) => column.name === "handoff_mode")).toBe(true);
    expect(yield* sql`SELECT id FROM token_usage_collection`).toHaveLength(1);
    expect(yield* runMigrations()).toEqual([]);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("preserves recorded usage and collection boundaries in already migrated databases", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 59 });
    yield* sql`UPDATE token_usage_collection SET after_sequence = 123, started_at = '2026-09-01T00:00:00Z'`;
    yield* sql`UPDATE projection_state SET last_applied_sequence = 456 WHERE projector = 'projection.token-usage-v1'`;
    yield* sql`INSERT INTO projection_token_usage_cursors VALUES ('native-source', '{"inputTokens":42}', 456)`;
    yield* sql`INSERT INTO projection_token_usage_samples VALUES ('request', 'native-source', 'codex', 'test', '{"inputTokens":42}', '[]')`;
    const before = yield* sql`SELECT * FROM token_usage_collection`;
    yield* runMigrations();
    expect(yield* sql`SELECT * FROM token_usage_collection`).toEqual(before);
    expect(
      yield* sql`SELECT last_applied_sequence FROM projection_state WHERE projector = 'projection.token-usage-v1'`,
    ).toEqual([{ last_applied_sequence: 456 }]);
    expect(yield* sql`SELECT * FROM projection_token_usage_samples`).toHaveLength(1);
    expect(yield* sql`SELECT * FROM projection_token_usage_cursors`).toHaveLength(1);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("repairs a missing ledger entry without resetting an existing collection boundary", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 59 });
    yield* sql`UPDATE token_usage_collection SET after_sequence = 123`;
    yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id IN (57, 58)`;
    yield* runMigrations();
    expect(yield* appliedIds).toEqual([57, 58, 59, 60]);
    expect(yield* sql`SELECT after_sequence FROM token_usage_collection`).toEqual([
      { after_sequence: 123 },
    ]);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
