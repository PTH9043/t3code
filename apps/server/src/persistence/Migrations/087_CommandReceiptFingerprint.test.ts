import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

it.effect("preserves existing receipts when adding request fingerprints", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 86 });
    yield* sql`INSERT INTO orchestration_command_receipts
      (command_id, aggregate_kind, aggregate_id, accepted_at, result_sequence, status, error)
      VALUES ('legacy', 'thread', 'thread-1', '2026-01-01T00:00:00.000Z', 3, 'accepted', NULL)`;
    expect(yield* runMigrations()).toContainEqual([87, "CommandReceiptFingerprint"]);
    expect(
      yield* sql`SELECT command_id, request_fingerprint FROM orchestration_command_receipts WHERE command_id='legacy'`,
    ).toEqual([{ command_id: "legacy", request_fingerprint: null }]);
    expect(yield* runMigrations()).toEqual([]);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
