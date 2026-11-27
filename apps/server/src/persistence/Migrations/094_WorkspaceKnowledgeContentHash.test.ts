import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ProjectId } from "@t3tools/contracts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import { runMigrations } from "../Migrations.ts";
import { knowledgeContentHash } from "../knowledgeContentHash.ts";
import { readKnowledgeDashboard } from "../../orchestration/knowledgeDashboard.ts";
import migrateHash from "./094_WorkspaceKnowledgeContentHash.ts";
import migrateSearch from "./095_WorkspaceKnowledgeSavedSearch.ts";

it.layer(NodeSqliteClient.layerMemory())("094/095 knowledge management migrations", (it) => {
  it.effect(
    "hashes older rows from exact UTF-8 bodies across batches and pages visible project records",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 93 });
        yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at)
        VALUES ('project','Primary','/primary','[]','2026-01-01','2026-01-01'),
          ('other','Other','/other','[]','2026-01-01','2026-01-01')`;
        yield* sql`WITH RECURSIVE numbers(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM numbers WHERE i<66)
        INSERT INTO projection_workspace_knowledge_items(project_id,item_id,kind,title,content,status,origin,created_at,updated_at)
        SELECT 'project', 'hash-looking-' || i, 'prompt','제목', CASE WHEN i=66 THEN '본문 ' ELSE '본문' END,
          'active','user','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z' FROM numbers`;
        yield* sql`INSERT INTO projection_workspace_knowledge_items(project_id,item_id,kind,title,content,status,origin,created_at,updated_at)
        VALUES ('other','hash-looking-1','prompt','title','본문','active','user','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`;
        yield* sql`INSERT INTO projection_workspace_knowledge_items(project_id,item_id,kind,title,content,status,origin,tags_json,created_at,updated_at)
        VALUES ('project','conversation-hidden','prompt','title','본문','active','agent','["auto-conversation"]','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`;
        yield* sql`INSERT INTO workspace_memory_v2(id,project_id,scope,topic,text,source_json,source_hash,origin,verification,status,created_at,updated_at)
        VALUES ('forgotten','project','project','topic','','{"kind":"message","id":"hidden"}','x','user','user-statement','forgotten','t','t')`;
        yield* migrateHash;
        yield* migrateSearch;
        const dashboard = yield* readKnowledgeDashboard(sql, {
          projectId: ProjectId.make("project"),
          limit: 2,
          offset: 2,
        });
        assert.strictEqual(dashboard.matching.items.length, 2);
        assert.strictEqual(dashboard.matching.total, 66);
        assert.strictEqual(dashboard.duplicates.total, 1);
        assert.deepEqual(dashboard.duplicates.items, []);
        assert.strictEqual(dashboard.compaction.reductionRatio, null);
        const first = yield* readKnowledgeDashboard(sql, {
          projectId: ProjectId.make("project"),
          query: "본문 ",
        });
        assert.deepEqual(first.duplicates.items, [
          { contentHash: knowledgeContentHash("본문"), count: 65 },
        ]);
        const different = yield* readKnowledgeDashboard(sql, {
          projectId: ProjectId.make("project"),
          contentHash: knowledgeContentHash("본문 "),
        });
        assert.deepEqual(
          different.matching.items.map((item) => item.id),
          ["hash-looking-66"],
        );
        yield* sql`UPDATE projection_workspace_knowledge_items SET created_at='unknown'
          WHERE project_id='project' AND item_id='hash-looking-66'`;
        const undated = yield* readKnowledgeDashboard(sql, {
          projectId: ProjectId.make("project"),
        });
        assert.strictEqual(undated.total, 66);
        assert.deepEqual(undated.growth, [{ day: "2026-01-01", count: 65 }]);
      }),
  );
});
