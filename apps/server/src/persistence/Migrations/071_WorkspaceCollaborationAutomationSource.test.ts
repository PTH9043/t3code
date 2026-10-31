import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../Layers/Sqlite.ts";
import migration from "./071_WorkspaceCollaborationAutomationSource.ts";

const suite = it.layer(SqlitePersistenceMemory);
suite("automation source migration", (it) => {
  it.effect(
    "preserves every collaboration column and admits automation while retaining the active-run constraint",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const at = "2026-10-15T00:00:00.000Z";
        yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at)
      VALUES('migration-inbox','Migration','D:/repo','[]',${at},${at})`;
        yield* sql`INSERT INTO projection_workspace_collaboration_runs(run_id,project_id,source,task,status,steps_json,graph_json,final_output,error,created_at,updated_at,meeting_json,orchestra_json)
      VALUES('preserved-run','migration-inbox','integrity','preserve','completed','[{"record":"step"}]','{"record":"graph"}','한글 결과','old error',${at},${at},'{"record":"meeting"}','{"maxParallel":2}')`;
        const before =
          yield* sql`SELECT * FROM projection_workspace_collaboration_runs WHERE run_id='preserved-run'`;
        yield* sql.withTransaction(migration);
        expect(
          yield* sql`SELECT * FROM projection_workspace_collaboration_runs WHERE run_id='preserved-run'`,
        ).toEqual(before);
        yield* sql`INSERT INTO projection_workspace_collaboration_runs(run_id,project_id,source,task,status,created_at,updated_at)
      VALUES('new-automation','migration-inbox','automation','new task','running',${at},${at})`;
        expect(
          (yield* Effect.exit(sql`INSERT INTO projection_workspace_collaboration_runs(run_id,project_id,source,task,status,created_at,updated_at)
      VALUES('duplicate-active','migration-inbox','automation','second','running',${at},${at})`))
            ._tag,
        ).toBe("Failure");
        expect(yield* sql`PRAGMA foreign_key_check`).toEqual([]);
      }),
  );
});
