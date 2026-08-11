import { DEFAULT_WORKSPACE_PROGRAM_INTEGRITY, WorkspaceProgramIntegrity } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("050_ProjectionWorkspaceProgramIntegrity", (it) => {
  it.effect("adds a resumable integrity state without activating existing programs", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 49 });
      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, default_model_selection_json,
          scripts_json, workspace_control_json, created_at, updated_at, deleted_at
        ) VALUES (
          'integrity-project', 'Integrity Project', 'D:/integrity-project', NULL, '[]',
          '{"isolationMode":"strict","longTermMemoryRoot":null}',
          '2026-08-10T00:00:00.000Z', '2026-08-10T00:00:00.000Z', NULL
        )
      `;
      yield* sql`
        INSERT INTO projection_workspace_programs (
          program_id, project_id, name, command, relative_directory,
          environment_variable_names_json, start_policy, health_check_json,
          error_patterns_json, enabled, created_at, updated_at
        ) VALUES (
          'web', 'integrity-project', 'Web', 'vp run dev', '', '[]', 'manual', NULL,
          '[]', 1, '2026-08-10T00:00:00.000Z', '2026-08-10T00:00:00.000Z'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 50 });

      const rows = yield* sql<{ readonly integrityJson: string }>`
        SELECT integrity_json AS "integrityJson"
        FROM projection_workspace_programs
        WHERE project_id = 'integrity-project' AND program_id = 'web'
      `;
      const integrity = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(WorkspaceProgramIntegrity),
      )(rows[0]?.integrityJson).pipe(Effect.orDie);
      assert.deepStrictEqual(integrity, DEFAULT_WORKSPACE_PROGRAM_INTEGRITY);
      const indexes = yield* sql<{ readonly name: string }>`
        PRAGMA index_list(projection_workspace_programs)
      `;
      assert.isTrue(
        indexes.some((index) => index.name === "idx_projection_workspace_programs_integrity"),
      );
    }),
  );
});
