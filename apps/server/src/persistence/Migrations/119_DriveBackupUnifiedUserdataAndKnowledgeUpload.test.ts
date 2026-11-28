import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vite-plus/test";
import { SqlitePersistenceMemory } from "../Layers/Sqlite.ts";

describe("Migration 119: DriveBackupUnifiedUserdataAndKnowledgeUpload", () => {
  it("allows 'knowledge' target kind and persists sync_local_to_drive_knowledge flag", async () => {
    const sqlite = SqlitePersistenceMemory.pipe(Layer.provide(NodeServices.layer));
    const now = 1_795_800_000_000;

    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        yield* sql`
          INSERT INTO drive_backup_targets (
            id, kind, project_id, display_name, root_path,
            enabled, sync_files, sync_t3_scope, sync_drive_to_local_rag,
            sync_local_to_drive_knowledge, exclude_globs_json, last_backed_up_at_ms, updated_at_ms
          ) VALUES (
            'target:know-1', 'knowledge', NULL, 'F드라이브 지식', 'F:\\Knowledge',
            1, 1, 0, 0,
            1, '[]', NULL, ${now}
          )
        `;

        const rows = yield* sql<{
          readonly id: string;
          readonly kind: string;
          readonly sync_local_to_drive_knowledge: number;
        }>`
          SELECT id, kind, sync_local_to_drive_knowledge
          FROM drive_backup_targets
          WHERE id = 'target:know-1'
        `;
        expect(rows).toHaveLength(1);
        expect(rows[0]?.kind).toBe("knowledge");
        expect(rows[0]?.sync_local_to_drive_knowledge).toBe(1);
      }).pipe(Effect.provide(sqlite)),
    );
  });
});
