import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

it.effect(
  "upgrades an existing database without changing its knowledge or forgotten messages",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 85 });
      yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at)
      VALUES ('p','Project','/project','[]','t','t')`;
      yield* sql`INSERT INTO projection_workspace_knowledge_items(project_id,item_id,kind,title,content,status,origin,tags_json,created_at,updated_at)
      VALUES ('p','conversation-old','rag-source','Old','old text','active','user','["auto-conversation"]','t','t')`;
      yield* sql`INSERT INTO workspace_memory_v2(id,project_id,scope,topic,text,source_json,source_hash,origin,verification,status,created_at,updated_at)
      VALUES ('forgotten','p','project','test','','{"kind":"message","id":"m"}','x','user','user-statement','forgotten','t','t')`;
      const knowledge = yield* sql`SELECT * FROM projection_workspace_knowledge_items`;
      const memory = yield* sql`SELECT * FROM workspace_memory_v2`;
      expect(yield* runMigrations()).toContainEqual([86, "WorkspaceConversationRagSources"]);
      expect(yield* sql`SELECT * FROM projection_workspace_knowledge_items`).toEqual(knowledge);
      expect(yield* sql`SELECT * FROM workspace_memory_v2`).toEqual(memory);
      expect(yield* runMigrations()).toEqual([]);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
