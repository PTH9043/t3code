import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("045_ProjectionWorkspaceCollaborationScheduleSource", (it) => {
  it.effect("upgrades the earlier user-only collaboration table without losing runs", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 42 });
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
        CREATE TABLE projection_workspace_collaboration_runs (
          run_id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          source TEXT NOT NULL CHECK (source IN ('user')),
          task TEXT NOT NULL,
          status TEXT NOT NULL CHECK (
            status IN ('queued', 'running', 'cancel-requested', 'cancelled', 'completed', 'failed')
          ),
          steps_json TEXT NOT NULL DEFAULT '[]',
          final_output TEXT,
          error TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY (project_id) REFERENCES projection_projects(project_id)
        )
      `;
      yield* sql`
        INSERT INTO projection_workspace_collaboration_runs (
          run_id, project_id, source, task, status, steps_json,
          final_output, error, created_at, updated_at
        ) VALUES (
          'existing-user-run', 'workspace-a', 'user', 'Existing task', 'completed', '[]',
          'done', NULL, '2026-08-08T01:00:00.000Z', '2026-08-08T02:00:00.000Z'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 45 });

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_workspace_collaboration_runs)
      `;
      assert.isTrue(columns.some((column) => column.name === "schedule_id"));
      const existing = yield* sql<{
        readonly source: string;
        readonly scheduleId: string | null;
        readonly finalOutput: string | null;
      }>`
        SELECT source, schedule_id AS "scheduleId", final_output AS "finalOutput"
        FROM projection_workspace_collaboration_runs
        WHERE run_id = 'existing-user-run'
      `;
      assert.deepStrictEqual(existing[0], {
        source: "user",
        scheduleId: null,
        finalOutput: "done",
      });

      yield* sql`
        INSERT INTO projection_workspace_collaboration_runs (
          run_id, project_id, source, schedule_id, task, status, steps_json,
          final_output, error, created_at, updated_at
        ) VALUES (
          'scheduled-run', 'workspace-a', 'schedule', 'schedule-a', 'Scheduled task',
          'queued', '[]', NULL, NULL,
          '2026-08-08T03:00:00.000Z', '2026-08-08T03:00:00.000Z'
        )
      `;
    }),
  );
});
