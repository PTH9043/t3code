import { ProjectId, WorkspaceKnowledgeItemId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { makeRuntimeSqliteLayer, SqlitePersistenceMemory } from "./Layers/Sqlite.ts";
import { runMigrations } from "./Migrations.ts";
import {
  readWorkspaceWikiLinks,
  rebuildWorkspaceWikiLinks,
  updateWorkspaceWikiIndex,
} from "./workspaceWikiLinks.ts";

it.effect(
  "backfills existing project bodies with unique, missing, and ambiguous targets in migration 92",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA foreign_keys = ON`;
      yield* runMigrations({ toMigrationInclusive: 91 });
      for (const project of ["wiki-primary", "wiki-other"]) {
        yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at)
        VALUES (${project},'Project',${project},'[]','t','t')`;
      }
      for (const [project, id, title, body] of [
        ["wiki-primary", "s", "Source", "See [[Unique]], [[Missing]], [[Same]] and `[[Code]]`."],
        ["wiki-primary", "one", "Unique", ""],
        ["wiki-primary", "two", "Same", ""],
        ["wiki-primary", "three", "Same", ""],
        ["wiki-other", "one", "Missing", "foreign [[Unique]]"],
      ] as const) {
        yield* sql`INSERT INTO projection_workspace_knowledge_items(project_id,item_id,kind,title,content,status,origin,created_at,updated_at)
        VALUES (${project},${id},'rag-source',${title},${body},'active','user','t','t')`;
      }
      yield* sql`INSERT OR REPLACE INTO projection_state(projector,last_applied_sequence,updated_at)
        VALUES (\'projection.workspace-knowledge-v2\',12,\'t\')`;
      expect(yield* runMigrations({ toMigrationInclusive: 92 })).toEqual([
        [92, "WorkspaceWikiLinks"],
      ]);
      expect(yield* sql`SELECT sequence FROM workspace_wiki_backfill_cursor`).toEqual([
        { sequence: 12 },
      ]);
      // Read through the final schema (the shared visibility policy also follows stage 2 forks).
      yield* runMigrations();
      const projectId = ProjectId.make("wiki-primary");
      const read = (id: string) =>
        readWorkspaceWikiLinks(sql, { projectId, itemId: WorkspaceKnowledgeItemId.make(id) });
      const first = yield* read("s");
      expect(first.outgoing.map((link) => link.targetItemId)).toEqual(["one", null, null]);
      expect(first.unresolved.map((link) => link.targetTitle)).toEqual(["Missing", "Same"]);
      expect((yield* read("one")).backlinks).toEqual([first.outgoing[0]]);
      expect(first.outgoing[0]?.context).toContain("See [[Unique]]");
      yield* sql`INSERT INTO projection_workspace_knowledge_items(project_id,item_id,kind,title,content,status,origin,created_at,updated_at)
      VALUES (${projectId},\'another\',\'rag-source\',\'Unique\',\'\',\'active\',\'user\',\'t\',\'t\')`;
      yield* sql`DELETE FROM projection_workspace_wiki_links WHERE project_id=${projectId}`;
      yield* rebuildWorkspaceWikiLinks(sql, projectId);
      expect(yield* read("s")).toEqual(first);
      expect(yield* runMigrations()).toEqual([]);
      yield* sql`DELETE FROM projection_workspace_knowledge_items WHERE project_id=${projectId} AND item_id='s'`;
      expect((yield* read("one")).backlinks).toEqual([]);
    }).pipe(Effect.provide(makeRuntimeSqliteLayer({ filename: ":memory:" }))),
);

it.effect("resolves late targets and filters forgotten source, fork, and backlink context", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const projectId = ProjectId.make("wiki-private");
    yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at)
      VALUES (${projectId},'Wiki','/wiki','[]','t','t')`;
    const add = (id: string, title: string, content: string, source: string | null = null) =>
      Effect.gen(function* () {
        const tags = id === "conversation-hidden" ? '["auto-conversation"]' : "[]";
        yield* sql`INSERT INTO projection_workspace_knowledge_items(project_id,item_id,kind,title,content,status,origin,source_item_id,tags_json,created_at,updated_at)
        VALUES (${projectId},${id},'rag-source',${title},${content},'active','user',${source},${tags},'t','t')`;
        yield* updateWorkspaceWikiIndex(sql, { projectId, id, title, content, status: "active" });
      });
    const read = (id: string) =>
      readWorkspaceWikiLinks(sql, { projectId, itemId: WorkspaceKnowledgeItemId.make(id) });
    yield* add("note", "Note", "[[Target]] [[id:conversation-hidden|source]]");
    expect((yield* read("note")).unresolved).toHaveLength(2);
    yield* add("target", "Target", "");
    yield* add("conversation-hidden", "Original", "sensitive context [[Target]]");
    yield* add("edited", "User fork", "sensitive fork context [[Target]]", "conversation-hidden");
    expect((yield* read("target")).backlinks).toHaveLength(3);
    yield* sql`INSERT INTO workspace_memory_v2(id,project_id,scope,topic,text,source_json,source_hash,origin,verification,status,created_at,updated_at)
      VALUES ('hidden-memory',${projectId},'project','test','','{"kind":"message","id":"hidden"}','x','user','user-statement','forgotten','t','t')`;
    expect((yield* read("target")).backlinks.map((link) => link.sourceItemId)).toEqual(["note"]);
    expect((yield* read("note")).outgoing.map((link) => link.targetItemId)).toEqual([
      "target",
      null,
    ]);
    for (const id of ["conversation-hidden", "edited"]) {
      expect(yield* read(id)).toEqual({ outgoing: [], backlinks: [], unresolved: [] });
    }
    // A deleted target cannot cause a previously chosen link to bind its namesake.
    yield* sql`DELETE FROM projection_workspace_knowledge_items WHERE project_id=${projectId} AND item_id='target'`;
    yield* add("namesake", "Target", "");
    expect((yield* read("note")).outgoing[0]?.targetItemId).toBeNull();
    expect((yield* read("namesake")).backlinks).toEqual([]);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);
