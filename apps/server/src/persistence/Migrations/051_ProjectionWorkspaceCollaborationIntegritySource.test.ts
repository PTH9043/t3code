import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

const project = (id: string) => `
  INSERT INTO projection_projects (
    project_id, title, workspace_root, default_model_selection_json,
    scripts_json, workspace_control_json, created_at, updated_at, deleted_at
  ) VALUES (
    '${id}', 'Integrity Source', 'D:/${id}', NULL, '[]',
    '{"isolationMode":"strict","longTermMemoryRoot":null}',
    '2026-08-11T00:00:00.000Z', '2026-08-11T00:00:00.000Z', NULL
  )
`;

layer("051_ProjectionWorkspaceCollaborationIntegritySource", (it) => {
  it.effect("admits integrity runs while preserving the rows written before it", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 50 });
      yield* sql.unsafe(project("integrity-source"));
      yield* sql`
        INSERT INTO projection_workspace_collaboration_runs (
          run_id, project_id, source, schedule_id, incident_id, task, status,
          steps_json, graph_json, final_output, error, created_at, updated_at
        ) VALUES (
          'run-existing', 'integrity-source', 'schedule', 'schedule-1', NULL, '예약 작업',
          'queued', '[]', '{"revision":1}', NULL, NULL,
          '2026-08-11T00:00:00.000Z', '2026-08-11T00:00:00.000Z'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 51 });

      // The rebuild has to carry every column across, graph snapshot included.
      const rows = yield* sql<{
        readonly source: string;
        readonly scheduleId: string | null;
        readonly graphJson: string | null;
      }>`
        SELECT source, schedule_id AS "scheduleId", graph_json AS "graphJson"
        FROM projection_workspace_collaboration_runs
        WHERE run_id = 'run-existing'
      `;
      assert.deepStrictEqual(rows[0], {
        source: "schedule",
        scheduleId: "schedule-1",
        graphJson: '{"revision":1}',
      });

      yield* sql`
        INSERT INTO projection_workspace_collaboration_runs (
          run_id, project_id, source, schedule_id, incident_id, task, status,
          steps_json, graph_json, final_output, error, created_at, updated_at
        ) VALUES (
          'run-integrity', 'integrity-source', 'integrity', NULL, NULL, '무결성 수렴',
          'queued', '[]', NULL, NULL, NULL,
          '2026-08-11T00:00:01.000Z', '2026-08-11T00:00:01.000Z'
        )
      `;
      const sources = yield* sql<{ readonly source: string }>`
        SELECT source FROM projection_workspace_collaboration_runs ORDER BY run_id
      `;
      assert.deepStrictEqual(
        sources.map((row) => row.source),
        ["schedule", "integrity"],
      );

      const indexes = yield* sql<{ readonly name: string }>`
        PRAGMA index_list(projection_workspace_collaboration_runs)
      `;
      const names = indexes.map((index) => index.name);
      assert.isTrue(names.includes("idx_projection_workspace_collaboration_runs_queue"));
      assert.isTrue(names.includes("idx_projection_workspace_collaboration_runs_one_active"));
    }),
  );
});
