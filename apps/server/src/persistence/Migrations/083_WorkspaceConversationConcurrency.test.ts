import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

it.effect("preserves existing runs and enforces active work separately per conversation", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 82 });
    yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at)
      VALUES ('p','Project','/project','[]','2026-01-01','2026-01-01')`;
    const insert = (id: string, meeting: string | null, status = "running") =>
      sql`INSERT INTO projection_workspace_collaboration_runs
        (run_id,project_id,source,task,status,steps_json,meeting_json,created_at,updated_at)
        VALUES (${id},'p','user',${id},${status},'[]',${meeting},'2026-01-01','2026-01-01')`;
    yield* insert("legacy", null);
    yield* insert("old-invalid-metadata", "{invalid", "completed");
    const before = yield* sql`SELECT * FROM projection_workspace_collaboration_runs`;
    expect(yield* runMigrations()).toContainEqual([83, "WorkspaceConversationConcurrency"]);
    expect(yield* sql`SELECT * FROM projection_workspace_collaboration_runs`).toEqual(before);

    yield* insert("chat-a", '{"threadId":"a"}');
    yield* insert("chat-b", '{"threadId":"b"}', "cancel-requested");
    expect(Exit.isFailure(yield* Effect.exit(insert("same-a", '{"threadId":"a"}')))).toBe(true);
    expect(Exit.isFailure(yield* Effect.exit(insert("same-b", '{"threadId":"b"}')))).toBe(true);
    expect(Exit.isFailure(yield* Effect.exit(insert("legacy-duplicate", null)))).toBe(true);

    yield* sql`UPDATE projection_workspace_collaboration_runs SET status='completed' WHERE run_id='chat-a'`;
    yield* insert("new-chat-a", '{"threadId":"a"}');
    expect(
      yield* sql`SELECT run_id FROM projection_workspace_collaboration_runs ORDER BY run_id`,
    ).toEqual([
      { run_id: "chat-a" },
      { run_id: "chat-b" },
      { run_id: "legacy" },
      { run_id: "new-chat-a" },
      { run_id: "old-invalid-metadata" },
    ]);
    expect(yield* runMigrations()).toEqual([]);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("retains independent active conversations when the database is reopened", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "conversation-concurrency-" });
    const layer = NodeSqliteClient.layer({ filename: `${dir}/state.sqlite` });
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at)
        VALUES ('p','Project','/project','[]','2026-01-01','2026-01-01')`;
      yield* sql`INSERT INTO projection_workspace_collaboration_runs
        (run_id,project_id,source,task,status,steps_json,meeting_json,created_at,updated_at)
        VALUES ('a','p','user','Task A','running','[]','{"threadId":"a"}','2026-01-01','2026-01-01'),
               ('b','p','user','Task B','running','[]','{"threadId":"b"}','2026-01-01','2026-01-01')`;
    }).pipe(Effect.provide(layer), Effect.scoped);
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      expect(yield* runMigrations()).toEqual([]);
      expect(
        yield* sql`SELECT run_id,status FROM projection_workspace_collaboration_runs ORDER BY run_id`,
      ).toEqual([
        { run_id: "a", status: "running" },
        { run_id: "b", status: "running" },
      ]);
      const duplicate = sql`INSERT INTO projection_workspace_collaboration_runs
        (run_id,project_id,source,task,status,steps_json,meeting_json,created_at,updated_at)
        VALUES ('duplicate','p','user','Duplicate','running','[]','{"threadId":"a"}','2026-01-01','2026-01-01')`;
      expect(Exit.isFailure(yield* Effect.exit(duplicate))).toBe(true);
    }).pipe(Effect.provide(layer), Effect.scoped);
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
