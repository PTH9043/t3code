import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("047_ProjectionWorkspaceOperatorIncidentSource", (it) => {
  it.effect("upgrades migration 46 without losing roles or collaboration runs", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 46 });
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
        INSERT INTO projection_workspace_agent_roles (
          project_id, role, display_name, model_selection_json, runtime_mode,
          interaction_mode, instructions, enabled, updated_at
        ) VALUES (
          'workspace-a', 'coordinator', 'Coordinator',
          '{"instanceId":"codex","model":"gpt-5.4"}', 'full-access',
          'default', 'Coordinate', 1, '2026-08-08T01:00:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO projection_workspace_collaboration_runs (
          run_id, project_id, source, schedule_id, task, status, steps_json,
          final_output, error, created_at, updated_at
        ) VALUES
          (
            'user-run', 'workspace-a', 'user', NULL, 'Existing user task', 'completed',
            '[]', 'done', NULL, '2026-08-08T01:00:00.000Z', '2026-08-08T02:00:00.000Z'
          ),
          (
            'schedule-run', 'workspace-a', 'schedule', 'schedule-a', 'Existing schedule',
            'queued', '[]', NULL, NULL,
            '2026-08-08T03:00:00.000Z', '2026-08-08T03:00:00.000Z'
          )
      `;

      yield* runMigrations({ toMigrationInclusive: 47 });

      const definitions = yield* sql<{ readonly name: string; readonly definition: string }>`
        SELECT name, sql AS definition
        FROM sqlite_master
        WHERE type = 'table'
          AND name IN (
            'projection_workspace_agent_roles',
            'projection_workspace_collaboration_runs'
          )
        ORDER BY name
      `;
      const roleDefinition =
        definitions.find((row) => row.name === "projection_workspace_agent_roles")?.definition ??
        "";
      const runDefinition =
        definitions.find((row) => row.name === "projection_workspace_collaboration_runs")
          ?.definition ?? "";
      assert.include(roleDefinition, "'operator'");
      assert.include(runDefinition, "'incident'");

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_workspace_collaboration_runs)
      `;
      assert.isTrue(columns.some((column) => column.name === "incident_id"));

      const preservedRoles = yield* sql<{ readonly role: string }>`
        SELECT role FROM projection_workspace_agent_roles WHERE project_id = 'workspace-a'
      `;
      assert.deepStrictEqual(preservedRoles, [{ role: "coordinator" }]);
      const preservedRuns = yield* sql<{
        readonly id: string;
        readonly source: string;
        readonly scheduleId: string | null;
        readonly incidentId: string | null;
      }>`
        SELECT
          run_id AS id,
          source,
          schedule_id AS "scheduleId",
          incident_id AS "incidentId"
        FROM projection_workspace_collaboration_runs
        ORDER BY run_id
      `;
      assert.deepStrictEqual(preservedRuns, [
        {
          id: "schedule-run",
          source: "schedule",
          scheduleId: "schedule-a",
          incidentId: null,
        },
        { id: "user-run", source: "user", scheduleId: null, incidentId: null },
      ]);

      yield* sql`
        INSERT INTO projection_workspace_agent_roles (
          project_id, role, display_name, model_selection_json, runtime_mode,
          interaction_mode, instructions, enabled, updated_at
        ) VALUES (
          'workspace-a', 'operator', 'Operator',
          '{"instanceId":"codex","model":"gpt-5.4"}', 'approval-required',
          'plan', 'Diagnose', 1, '2026-08-08T04:00:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO projection_workspace_collaboration_runs (
          run_id, project_id, source, schedule_id, incident_id, task, status, steps_json,
          final_output, error, created_at, updated_at
        ) VALUES (
          'incident-run', 'workspace-a', 'incident', NULL, 'incident-a', 'Repair incident',
          'queued', '[]', NULL, NULL,
          '2026-08-08T04:00:00.000Z', '2026-08-08T04:00:00.000Z'
        )
      `;
      const inserted = yield* sql<{
        readonly source: string;
        readonly incidentId: string | null;
      }>`
        SELECT source, incident_id AS "incidentId"
        FROM projection_workspace_collaboration_runs
        WHERE run_id = 'incident-run'
      `;
      assert.deepStrictEqual(inserted, [{ source: "incident", incidentId: "incident-a" }]);

      const invalidRole = yield* Effect.exit(sql`
        INSERT INTO projection_workspace_agent_roles (
          project_id, role, display_name, model_selection_json, runtime_mode,
          interaction_mode, instructions, enabled, updated_at
        ) VALUES (
          'workspace-a', 'invalid', 'Invalid',
          '{"instanceId":"codex","model":"gpt-5.4"}', 'full-access',
          'default', '', 1, '2026-08-08T05:00:00.000Z'
        )
      `);
      assert.isTrue(Exit.isFailure(invalidRole));
      const invalidSource = yield* Effect.exit(sql`
        INSERT INTO projection_workspace_collaboration_runs (
          run_id, project_id, source, schedule_id, incident_id, task, status, steps_json,
          final_output, error, created_at, updated_at
        ) VALUES (
          'invalid-run', 'workspace-a', 'invalid', NULL, NULL, 'Invalid', 'queued',
          '[]', NULL, NULL, '2026-08-08T05:00:00.000Z', '2026-08-08T05:00:00.000Z'
        )
      `);
      assert.isTrue(Exit.isFailure(invalidSource));
    }),
  );
});
