import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("048_ProjectionWorkspaceCollaborationTaskGraph", (it) => {
  it.effect("adds graph storage without losing existing collaboration runs", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 47 });
      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, default_model_selection_json,
          scripts_json, workspace_control_json, created_at, updated_at, deleted_at
        ) VALUES (
          'workspace-a', 'Workspace A', 'D:/workspace-a', NULL, '[]',
          '{"isolationMode":"strict","longTermMemoryRoot":null}',
          '2026-08-08T00:00:00.000Z', '2026-08-08T00:00:00.000Z', NULL
        )
      `;
      yield* sql`
        INSERT INTO projection_workspace_collaboration_runs (
          run_id, project_id, source, schedule_id, incident_id, task, status,
          steps_json, final_output, error, created_at, updated_at
        ) VALUES (
          'existing-run', 'workspace-a', 'user', NULL, NULL, 'Existing task',
          'completed', '[]', 'done', NULL,
          '2026-08-08T01:00:00.000Z', '2026-08-08T02:00:00.000Z'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 48 });

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_workspace_collaboration_runs)
      `;
      assert.isTrue(columns.some((column) => column.name === "graph_json"));
      const rows = yield* sql<{
        readonly id: string;
        readonly finalOutput: string | null;
        readonly graphJson: string | null;
      }>`
        SELECT
          run_id AS id,
          final_output AS "finalOutput",
          graph_json AS "graphJson"
        FROM projection_workspace_collaboration_runs
      `;
      assert.deepStrictEqual(rows, [{ id: "existing-run", finalOutput: "done", graphJson: null }]);
    }),
  );
});
