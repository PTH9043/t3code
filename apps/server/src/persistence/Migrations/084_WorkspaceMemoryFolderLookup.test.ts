import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

it.effect("indexes the latest prior user message without changing the result", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 83 });
    yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at)
      VALUES ('p','Project','/project','[]','2026-01-01','2026-01-01')`;
    yield* sql`INSERT INTO projection_threads(thread_id,project_id,title,created_at,updated_at)
      VALUES ('t','p','Thread','2026-01-01','2026-01-01')`;
    yield* sql`INSERT INTO projection_thread_messages(message_id,thread_id,role,text,is_streaming,created_at,updated_at)
      VALUES ('u1','t','user','one',0,'2026-01-01','2026-01-01'),
             ('a1','t','assistant','reply',0,'2026-01-01','2026-01-01'),
             ('u2','t','user','two',0,'2026-01-01','2026-01-01'),
             ('a2','t','assistant','reply',0,'2026-01-01','2026-01-01')`;
    const lookup = () => sql`SELECT u.message_id FROM projection_thread_messages u
      WHERE u.thread_id='t' AND u.role='user'
        AND u.rowid <= (SELECT rowid FROM projection_thread_messages WHERE message_id='a2')
      ORDER BY u.rowid DESC LIMIT 1`;
    const before = yield* lookup();
    expect(before).toEqual([{ message_id: "u2" }]);
    expect(yield* runMigrations()).toContainEqual([84, "WorkspaceMemoryFolderLookup"]);
    expect(yield* lookup()).toEqual(before);
    const plan = yield* sql<{ detail: string }>`EXPLAIN QUERY PLAN
      SELECT u.message_id FROM projection_thread_messages u
      WHERE u.thread_id='t' AND u.role='user' AND u.rowid<=4
      ORDER BY u.rowid DESC LIMIT 1`;
    expect(plan.some((row) => row.detail.includes("idx_projection_messages_thread_role"))).toBe(
      true,
    );
    expect(plan.some((row) => row.detail.includes("TEMP B-TREE"))).toBe(false);
    expect(yield* runMigrations()).toEqual([]);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
