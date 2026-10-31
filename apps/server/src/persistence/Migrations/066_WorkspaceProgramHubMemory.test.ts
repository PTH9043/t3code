import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

it.effect("gives existing programs an empty hub memory budget and survives a rerun", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 65 });
    yield* sql`INSERT INTO projection_projects (project_id,title,workspace_root,scripts_json,created_at,updated_at)
    VALUES ('hub-project','Hub','D:/hub','[]','2026-09-12','2026-09-12')`;
    yield* sql`INSERT INTO projection_workspace_programs
    (program_id,project_id,name,command,relative_directory,environment_variable_names_json,start_policy,
     health_check_json,error_patterns_json,enabled,created_at,updated_at)
    VALUES ('research','hub-project','연구','python run.py','memescan','[]','manual',NULL,'[]',1,'2026-09-12','2026-09-12')`;
    yield* runMigrations({ toMigrationInclusive: 66 });
    yield* runMigrations({ toMigrationInclusive: 66 });
    const rows =
      yield* sql`SELECT hub_memory_json FROM projection_workspace_programs WHERE program_id = 'research'`;
    assert.deepStrictEqual(rows, [
      {
        hub_memory_json:
          '{"commitLimitMb":null,"concurrencyGroup":null,"concurrencySlots":null,"sharedDatasets":[]}',
      },
    ]);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
