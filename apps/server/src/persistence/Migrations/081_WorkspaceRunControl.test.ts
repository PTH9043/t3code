import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

it.effect("adds unified run state without changing existing collaboration records", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 80 });
    yield* sql`PRAGMA foreign_keys = OFF`;
    yield* sql`INSERT INTO projection_workspace_collaboration_runs
      (run_id, project_id, source, task, status, steps_json, graph_json, workflow_json, created_at, updated_at)
      VALUES ('old-run', 'old-project', 'user', 'Preserve this task', 'completed', '[]', NULL, NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`;
    const before =
      yield* sql`SELECT run_id,project_id,task,status,steps_json,graph_json,workflow_json FROM projection_workspace_collaboration_runs`;
    expect(yield* runMigrations()).toContainEqual([81, "WorkspaceRunControl"]);
    expect(
      yield* sql`SELECT run_id,project_id,task,status,steps_json,graph_json,workflow_json FROM projection_workspace_collaboration_runs`,
    ).toEqual(before);
    expect(
      yield* sql`SELECT run_control_json,run_context_json FROM projection_workspace_collaboration_runs`,
    ).toEqual([{ run_control_json: null, run_context_json: null }]);
    expect(yield* runMigrations()).toEqual([]);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
