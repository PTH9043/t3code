import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

it.effect(
  "preserves existing knowledge and searchable chunks as project-local across repeated startup",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 64 });
      yield* sql`INSERT INTO projection_projects (project_id,title,workspace_root,scripts_json,created_at,updated_at)
    VALUES ('scope-project','Scope','D:/scope','[]','2026-09-11','2026-09-11')`;
      yield* sql`INSERT INTO projection_workspace_knowledge_items
    (project_id,item_id,kind,title,content,status,origin,created_at,updated_at)
    VALUES ('scope-project','old-memory','long-term-memory','Existing memory','Preserved content','active','user','2026-09-11','2026-09-11')`;
      yield* sql`INSERT INTO projection_workspace_rag_chunks
    (project_id,item_id,kind,chunk_index,title,content,updated_at,tags_text,search_title,search_tags,search_body)
    VALUES ('scope-project','old-memory','long-term-memory',0,'Existing memory','Preserved content','2026-09-11','','existing memory','','preserved content')`;
      yield* runMigrations({ toMigrationInclusive: 65 });
      yield* runMigrations({ toMigrationInclusive: 65 });
      const items =
        yield* sql`SELECT content, scope, applies_to_folder FROM projection_workspace_knowledge_items WHERE item_id = 'old-memory'`;
      assert.deepStrictEqual(items, [
        { content: "Preserved content", scope: "project", applies_to_folder: null },
      ]);
      const chunks =
        yield* sql`SELECT item_id, content, scope, applies_to_folder FROM projection_workspace_rag_chunks WHERE projection_workspace_rag_chunks MATCH 'preserved'`;
      assert.deepStrictEqual(chunks, [
        {
          item_id: "old-memory",
          content: "Preserved content",
          scope: "project",
          applies_to_folder: null,
        },
      ]);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
