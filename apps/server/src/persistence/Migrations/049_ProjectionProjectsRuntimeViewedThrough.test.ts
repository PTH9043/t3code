import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("049_ProjectionProjectsRuntimeViewedThrough", (it) => {
  it.effect("adds the project attention receipt without changing existing projects", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 48 });
      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, default_model_selection_json,
          scripts_json, workspace_control_json, created_at, updated_at, deleted_at
        ) VALUES (
          'project-a', 'Project A', 'D:/project-a', NULL, '[]',
          '{"isolationMode":"strict","longTermMemoryRoot":null}',
          '2026-08-10T00:00:00.000Z', '2026-08-10T00:00:00.000Z', NULL
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 49 });

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_projects)
      `;
      assert.isTrue(columns.some((column) => column.name === "runtime_viewed_through"));
      const rows = yield* sql<{
        readonly id: string;
        readonly title: string;
        readonly runtimeViewedThrough: string | null;
      }>`
        SELECT
          project_id AS id,
          title,
          runtime_viewed_through AS "runtimeViewedThrough"
        FROM projection_projects
      `;
      assert.deepStrictEqual(rows, [
        { id: "project-a", title: "Project A", runtimeViewedThrough: null },
      ]);
    }),
  );
});
