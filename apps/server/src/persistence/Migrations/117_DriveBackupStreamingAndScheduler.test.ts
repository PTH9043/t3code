import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vite-plus/test";

import { SqlitePersistenceMemory } from "../Layers/Sqlite.ts";
import { runMigrations } from "../Migrations.ts";

describe("Migration 117 DriveBackupStreamingAndScheduler", () => {
  it("upgrades schema cleanly with userdata/paused/exchange_sync constraints and checkpoint/manifest/exchange tables", async () => {
    const layer = SqlitePersistenceMemory.pipe(Layer.provide(NodeServices.layer));
    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations();

        const tables = yield* sql<{ readonly name: string }>`
          SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'drive_%' ORDER BY name
        `;
        const tableNames = tables.map((r) => r.name);
        expect(tableNames).toContain("drive_backup_checkpoints");
        expect(tableNames).toContain("drive_backup_manifests");
        expect(tableNames).toContain("drive_exchange_state");

        // Verify userdata target kind and paused run status are allowed
        const now = 1_795_755_000_000;
        yield* sql`
          INSERT INTO drive_backup_targets (
            id, kind, project_id, display_name, root_path, enabled,
            sync_files, sync_t3_scope, sync_drive_to_local_rag,
            exclude_globs_json, last_backed_up_at_ms, updated_at_ms
          ) VALUES (
            'ud:memory-v2', 'userdata', NULL, 'memory-v2', '/tmp/userdata/memory-v2', 0,
            1, 0, 0, '[]', NULL, ${now}
          )
        `;
        yield* sql`
          INSERT INTO drive_backup_runs (
            run_id, kind, status, transport_mode, target_ids_json,
            file_count, raw_bytes, archive_bytes,
            skipped_secrets_count, skipped_secrets_sample_json,
            started_at_ms, wal_growth_bytes, paused_count, resumed_from_checkpoint
          ) VALUES (
            'run-paused-1', 'exchange_sync', 'paused', 'gdrive_api', '[]',
            0, 0, 0, 0, '[]', ${now}, 4096, 1, 1
          )
        `;

        // Idempotent re-run must not fail
        const secondRun = yield* runMigrations();
        expect(secondRun).toEqual([]);
      }).pipe(Effect.provide(layer)),
    );
  });
});
