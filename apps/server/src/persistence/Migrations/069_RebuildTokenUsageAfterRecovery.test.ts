import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

it.effect(
  "rebuilds derived usage once while preserving event history and the original collection boundary",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 68 });
      yield* sql`UPDATE token_usage_collection SET after_sequence=123, started_at='2026-09-01T00:00:00Z'`;
      yield* sql`UPDATE projection_state SET last_applied_sequence=456 WHERE projector='projection.token-usage-v1'`;
      yield* sql`INSERT INTO projection_token_usage_cursors VALUES ('old','{}',456)`;
      yield* sql`INSERT INTO projection_token_usage_samples VALUES ('request','old','codex','test','{}','[]')`;
      const eventsBefore = yield* sql`SELECT * FROM orchestration_events`;
      const boundaryBefore = yield* sql`SELECT * FROM token_usage_collection`;
      expect(yield* runMigrations()).toEqual([[69, "RebuildTokenUsageAfterRecovery"]]);
      expect(yield* sql`SELECT * FROM orchestration_events`).toEqual(eventsBefore);
      expect(yield* sql`SELECT * FROM token_usage_collection`).toEqual(boundaryBefore);
      expect(
        yield* sql`SELECT last_applied_sequence FROM projection_state WHERE projector='projection.token-usage-v1'`,
      ).toEqual([{ last_applied_sequence: 123 }]);
      expect(yield* sql`SELECT * FROM projection_token_usage_samples`).toEqual([]);
      expect(yield* sql`SELECT * FROM projection_token_usage_cursors`).toEqual([]);
      yield* sql`INSERT INTO projection_token_usage_samples VALUES ('new-request','new','codex','test','{}','[]')`;
      expect(yield* runMigrations()).toEqual([]);
      expect(yield* sql`SELECT * FROM projection_token_usage_samples`).toHaveLength(1);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
