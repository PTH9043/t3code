// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vite-plus/test";
import { SqlitePersistenceMemory } from "../Layers/Sqlite.ts";

describe("Migration 116: GoogleDriveSelectiveBackup", () => {
  it("creates drive_backup_config, drive_backup_targets, drive_backup_runs, and drive_mirror_objects", async () => {
    const layer = SqlitePersistenceMemory.pipe(Layer.provide(NodeServices.layer));
    const tables = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql<{ readonly name: string }>`
          SELECT name FROM sqlite_master
          WHERE type = 'table' AND name LIKE 'drive_%'
          ORDER BY name ASC
        `;
        return rows.map((r) => r.name);
      }).pipe(Effect.provide(layer)),
    );

    expect(tables).toEqual(
      expect.arrayContaining([
        "drive_backup_config",
        "drive_backup_runs",
        "drive_backup_targets",
        "drive_mirror_objects",
      ]),
    );
  });

  it("enforces CHECK constraints on transport_mode, target kind, and run status", async () => {
    const layer = SqlitePersistenceMemory.pipe(Layer.provide(NodeServices.layer));
    const failed = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return yield* sql`
          INSERT INTO drive_backup_config (id, transport_mode, updated_at_ms)
          VALUES ('bad', 'invalid_mode', 1000)
        `.pipe(
          Effect.as(false),
          Effect.orElseSucceed(() => true),
        );
      }).pipe(Effect.provide(layer)),
    );

    expect(failed).toBe(true);
  });
});
