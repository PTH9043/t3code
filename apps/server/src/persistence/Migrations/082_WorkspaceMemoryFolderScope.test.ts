import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { ProjectId, ThreadId } from "@t3tools/contracts";
import { WorkspaceMemory } from "../../orchestration/WorkspaceMemory.ts";
import { ServerConfig } from "../../config.ts";
import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const decode = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

it.effect(
  "upgrades and reopens an isolated database without classifying or changing old messages",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "memory-folder-migration-" });
      const layer = NodeSqliteClient.layer({ filename: `${dir}/state.sqlite` });
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 81 });
        yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES ('p','P','/tmp','[]','2026-01-01','2026-01-01')`;
        yield* sql`INSERT INTO projection_threads(thread_id,project_id,title,created_at,updated_at) VALUES ('t','p','T','2026-01-01','2026-01-01')`;
        yield* sql`INSERT INTO projection_thread_messages(message_id,thread_id,role,text,is_streaming,created_at,updated_at) VALUES ('old','t','user','ORIGINAL',0,'2026-01-01','2026-01-01')`;
      }).pipe(Effect.provide(layer), Effect.scoped);
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 82 });
        assert.deepStrictEqual(
          yield* sql`SELECT message_id FROM workspace_memory_v2_message_folders`,
          [],
        );
        yield* sql`INSERT INTO workspace_memory_v2_message_folders(message_id,project_id,thread_id,folder) VALUES ('new','p','t','apps/web')`;
      }).pipe(Effect.provide(layer), Effect.scoped);
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations();
        assert.deepStrictEqual(
          yield* sql`SELECT message_id,folder FROM workspace_memory_v2_message_folders`,
          [{ message_id: "new", folder: "apps/web" }],
        );
        assert.deepStrictEqual(yield* sql`SELECT message_id,text FROM projection_thread_messages`, [
          { message_id: "old", text: "ORIGINAL" },
        ]);
      }).pipe(Effect.provide(layer), Effect.scoped);
      const memoryLayer = WorkspaceMemory.layer.pipe(
        Layer.provideMerge(layer),
        Layer.provideMerge(ServerConfig.layerTest(dir, dir)),
        Layer.provideMerge(NodeServices.layer),
      );
      const projectId = ProjectId.make("p");
      const web = ThreadId.make("web");
      const server = ThreadId.make("server");
      let savedId = "";
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const memory = yield* WorkspaceMemory;
        yield* sql`INSERT INTO projection_threads(thread_id,project_id,title,created_at,updated_at) VALUES ('web','p','Web','2026-01-01','2026-01-01'),('server','p','Server','2026-01-01','2026-01-01')`;
        yield* sql`INSERT INTO projection_thread_messages(message_id,thread_id,role,text,is_streaming,created_at,updated_at) VALUES ('web-current','web','user','web task',0,'2026-01-01','2026-01-01'),('server-current','server','user','server task',0,'2026-01-01','2026-01-01')`;
        yield* sql`INSERT INTO workspace_memory_v2_message_folders(message_id,project_id,thread_id,folder) VALUES ('web-current','p','web','apps/web'),('server-current','p','server','apps/server')`;
        const saved = decode(
          yield* memory.invoke(
            {
              projectId,
              action: "remember",
              requestId: "persisted-web",
              topic: "folder",
              text: "PERSISTED_WEB_SCOPE",
            },
            { threadId: web },
          ),
        );
        savedId = (yield* Schema.decodeUnknownEffect(Schema.Struct({ id: Schema.String }))(saved))
          .id;
      }).pipe(Effect.provide(memoryLayer), Effect.scoped);
      yield* Effect.gen(function* () {
        const memory = yield* WorkspaceMemory;
        const webMatches = decode(
          yield* memory.invoke(
            { projectId, action: "search", query: "PERSISTED_WEB_SCOPE" },
            { threadId: web },
          ),
        );
        const serverMatches = decode(
          yield* memory.invoke(
            { projectId, action: "search", query: "PERSISTED_WEB_SCOPE" },
            { threadId: server },
          ),
        );
        assert.include(encode(webMatches), "PERSISTED_WEB_SCOPE");
        assert.notInclude(encode(serverMatches), "PERSISTED_WEB_SCOPE");
        const denied = yield* memory
          .invoke({ projectId, action: "read", id: savedId }, { threadId: server })
          .pipe(Effect.flip);
        assert.include(denied.message, "폴더 범위");
        const allowed = decode(
          yield* memory.invoke({ projectId, action: "read", id: savedId }, { threadId: web }),
        );
        assert.include(encode(allowed), "PERSISTED_WEB_SCOPE");
      }).pipe(Effect.provide(memoryLayer), Effect.scoped);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
