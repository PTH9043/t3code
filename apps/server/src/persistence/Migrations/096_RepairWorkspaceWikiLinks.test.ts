import { ProjectId, WorkspaceKnowledgeItemId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ProjectionWorkspaceKnowledgeRepositoryLive } from "../Layers/ProjectionWorkspaceKnowledge.ts";
import { SqlitePersistenceMemory } from "../Layers/Sqlite.ts";
import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import { ProjectionWorkspaceKnowledgeRepository } from "../Services/ProjectionWorkspaceKnowledge.ts";
import { readWorkspaceWikiLinks } from "../workspaceWikiLinks.ts";

const projectId = ProjectId.make("wiki-repair");
const seedProject = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at)
    VALUES (${projectId},'Wiki','/wiki','[]','t','t')`;
  yield* sql`INSERT INTO workspace_memory_v2(id,project_id,scope,topic,text,source_json,source_hash,origin,verification,status,created_at,updated_at)
    VALUES ('forgotten',${projectId},'project','test','','{"kind":"message","id":"private"}','x','user','user-statement','forgotten','t','t')`;
});
const seedItem = (sql: SqlClient.SqlClient, id: string, title: string, body = "") => sql`
  INSERT INTO projection_workspace_knowledge_items(project_id,item_id,kind,title,content,status,origin,tags_json,created_at,updated_at)
  VALUES (${projectId},${id},'rag-source',${title},${body},'active','user',
    ${id === "conversation-hidden" ? '["auto-conversation"]' : "[]"},'t','t')`;
const links = (sql: SqlClient.SqlClient, id: string) =>
  readWorkspaceWikiLinks(sql, { projectId, itemId: WorkspaceKnowledgeItemId.make(id) });
const bindingIds = (sql: SqlClient.SqlClient) =>
  sql<{ target: string | null }>`SELECT target_item_id AS target
  FROM workspace_wiki_bindings WHERE project_id=${projectId} AND source_item_id='source' ORDER BY start_offset`.pipe(
    Effect.map((rows) => rows.map((row) => row.target)),
  );

it.effect(
  "resolves the only visible original in 092 before the fork column exists and through latest",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 91 });
      yield* seedProject;
      yield* seedItem(sql, "conversation-hidden", "Shared");
      yield* seedItem(sql, "public", "Shared");
      yield* seedItem(
        sql,
        "source",
        "Source",
        "[[Shared]] [[id:conversation-hidden|Earlier choice]]",
      );
      yield* runMigrations({ toMigrationInclusive: 92 });
      expect(yield* bindingIds(sql)).toEqual(["public", "conversation-hidden"]);
      yield* runMigrations();
      expect((yield* links(sql, "source")).outgoing.map((link) => link.targetItemId)).toEqual([
        "public",
        null,
      ]);
      expect(yield* bindingIds(sql)).toEqual(["public", "conversation-hidden"]);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect(
  "projects normal upserts against visible originals and visible forks before counting namesakes",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const repo = yield* ProjectionWorkspaceKnowledgeRepository;
      yield* seedProject;
      const put = (id: string, title: string, content = "", sourceItemId?: string) =>
        repo.upsert({
          projectId,
          id: WorkspaceKnowledgeItemId.make(id),
          title,
          content,
          origin: "user",
          kind: "rag-source",
          status: "active",
          tags: id === "conversation-hidden" ? ["auto-conversation"] : [],
          ...(sourceItemId ? { sourceItemId: WorkspaceKnowledgeItemId.make(sourceItemId) } : {}),
          relativeFolder: null,
          promptUses: 0,
          originalChars: null,
          storedChars: null,
          lastUsedAt: null,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        });
      yield* put("conversation-hidden", "Shared");
      yield* put("private-fork", "Shared", "", "conversation-hidden");
      yield* put("public", "Shared");
      yield* put("source", "Source", "[[Shared]]");
      expect((yield* links(sql, "source")).outgoing[0]?.targetItemId).toBe("public");
      yield* put("other", "Shared");
      yield* put("source", "Source", "[[Shared]]; new [[Shared]]");
      expect((yield* links(sql, "source")).outgoing.map((link) => link.targetItemId)).toEqual([
        "public",
        null,
      ]);
      yield* put("waiting", "Waiting", "[[Future]]");
      yield* put("conversation-hidden", "Future");
      yield* put("future-public", "Future");
      expect((yield* links(sql, "waiting")).outgoing[0]?.targetItemId).toBe("future-public");
    }).pipe(
      Effect.provide(
        ProjectionWorkspaceKnowledgeRepositoryLive.pipe(
          Layer.provideMerge(SqlitePersistenceMemory),
        ),
      ),
    ),
);

it.effect(
  "repairs an already recorded draft 092 with inline choices and no bindings or cursor table",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA foreign_keys=ON`;
      yield* runMigrations({ toMigrationInclusive: 91 });
      yield* seedProject;
      yield* seedItem(sql, "conversation-hidden", "Shared");
      yield* seedItem(sql, "public", "Shared");
      yield* seedItem(sql, "aa", "Dup");
      yield* seedItem(sql, "zz", "Dup");
      const body = "[[Dup]] [[Shared]] [[id:aa|chosen]]";
      yield* seedItem(sql, "source", "Source", body);
      yield* sql`CREATE TABLE projection_workspace_wiki_links (
      project_id TEXT NOT NULL,source_item_id TEXT NOT NULL,start_offset INTEGER NOT NULL,end_offset INTEGER NOT NULL,
      target_title TEXT NOT NULL,target_item_id TEXT,context TEXT NOT NULL,needs_choice INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(project_id,source_item_id,start_offset),
      FOREIGN KEY(project_id,source_item_id) REFERENCES projection_workspace_knowledge_items(project_id,item_id) ON DELETE CASCADE)`;
      yield* sql`CREATE INDEX workspace_wiki_backlinks ON projection_workspace_wiki_links(project_id,target_item_id)`;
      yield* sql`INSERT INTO projection_workspace_wiki_links VALUES
      (${projectId},'source',0,7,'Dup','zz',${body},0),
      (${projectId},'source',8,18,'Shared',NULL,${body},1)`;
      yield* sql`INSERT INTO effect_sql_migrations(migration_id,name) VALUES(92,'WorkspaceWikiLinks')`;
      yield* runMigrations({ toMigrationInclusive: 95 });
      expect(
        yield* sql`SELECT name FROM sqlite_master WHERE name='workspace_wiki_bindings'`,
      ).toHaveLength(0);
      expect(yield* runMigrations()).toContainEqual([96, "RepairWorkspaceWikiLinks"]);
      expect((yield* links(sql, "source")).outgoing.map((link) => link.targetItemId)).toEqual([
        "zz",
        "public",
        "aa",
      ]);
      expect((yield* links(sql, "zz")).backlinks[0]?.sourceItemId).toBe("source");
      expect(
        yield* sql`SELECT content FROM projection_workspace_knowledge_items WHERE project_id=${projectId} AND item_id='source'`,
      ).toEqual([{ content: body }]);
      expect(
        yield* sql`SELECT name FROM sqlite_master WHERE name='workspace_wiki_backfill_cursor'`,
      ).toHaveLength(1);
      expect(yield* runMigrations()).toEqual([]);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect(
  "recovers durable choices from matching revisions if a split index lost its bindings table",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 91 });
      yield* seedProject;
      yield* seedItem(sql, "left", "Same");
      yield* seedItem(sql, "right", "Same");
      yield* seedItem(sql, "source", "Source", "[[Same]] and [[id:left|Same]]");
      yield* seedItem(sql, "stale", "Stale", "[[Same]] changed");
      yield* runMigrations({ toMigrationInclusive: 95 });
      yield* sql`DROP TABLE workspace_wiki_bindings`;
      for (const [id, body] of [
        ["source", "[[Same]] and [[id:left|Same]]"],
        ["stale", "[[Same]] old"],
      ] as const) {
        yield* sql`INSERT INTO orchestration_events(event_id,aggregate_kind,stream_id,stream_version,event_type,
        occurred_at,actor_kind,payload_json,metadata_json) VALUES (${id},'project',${projectId},
        ${id === "source" ? 1 : 2},'project.knowledge-item-upserted','t','server',
        json_object('itemId',${id},'content',${body},'wikiLinkBindings',json_array(
          json_object('start',0,'targetItemId','right','needsChoice',0),
          json_object('start',13,'targetItemId','right','needsChoice',0))),'{}')`;
      }
      yield* runMigrations();
      expect((yield* links(sql, "source")).outgoing.map((link) => link.targetItemId)).toEqual([
        "right",
        "left",
      ]);
      expect((yield* links(sql, "stale")).outgoing[0]?.targetItemId).toBeNull();
      expect(yield* sql`SELECT count(*) AS n FROM orchestration_events`).toEqual([{ n: 2 }]);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect(
  "repairs false ambiguity in a split 095 index while preserving chosen IDs and genuine ambiguity",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 91 });
      yield* seedProject;
      yield* seedItem(sql, "conversation-hidden", "Shared");
      yield* seedItem(sql, "public", "Shared");
      yield* seedItem(sql, "first", "Dup");
      yield* seedItem(sql, "second", "Dup");
      yield* seedItem(sql, "source", "Source", "[[Shared]] [[Shared]] [[Dup]]");
      yield* runMigrations({ toMigrationInclusive: 95 });
      yield* sql`UPDATE workspace_wiki_bindings SET target_item_id=NULL,needs_choice=1
      WHERE source_item_id='source' AND start_offset=0`;
      yield* sql`UPDATE workspace_wiki_bindings SET target_item_id='conversation-hidden',needs_choice=0
      WHERE source_item_id='source' AND start_offset=11`;
      yield* sql`UPDATE projection_workspace_knowledge_items SET status='archived' WHERE item_id='second'`;
      yield* runMigrations();
      expect(yield* bindingIds(sql)).toEqual(["public", "conversation-hidden", null]);
      expect((yield* links(sql, "source")).outgoing.map((link) => link.targetItemId)).toEqual([
        "public",
        null,
        null,
      ]);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
