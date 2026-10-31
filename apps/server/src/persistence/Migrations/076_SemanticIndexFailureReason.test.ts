import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

it.layer(NodeSqliteClient.layerMemory())("076_SemanticIndexFailureReason", (it) => {
  it.effect("upgrades existing pending work once without changing its retry or source data", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 75 });
      yield* sql`INSERT INTO workspace_semantic_index_jobs(scope_key,project_id,endpoint,model,failures,retry_at,updated_at)
        VALUES('existing','project','http://127.0.0.1:11434','bge-m3:latest',2,12345,100)`;
      yield* runMigrations({ toMigrationInclusive: 76 });
      yield* runMigrations({ toMigrationInclusive: 76 });
      const jobs =
        yield* sql`SELECT scope_key,model,failures,retry_at,failure_reason FROM workspace_semantic_index_jobs`;
      expect(jobs).toEqual([
        {
          scope_key: "existing",
          model: "bge-m3:latest",
          failures: 2,
          retry_at: 12345,
          failure_reason: null,
        },
      ]);
    }),
  );
});
