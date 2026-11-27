import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { agentKnowledgeItemId } from "../../orchestration/workspaceAgentKnowledge.ts";
import { knowledgeContentDigest } from "../../orchestration/workspaceConversationRag.ts";
import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

it.layer(NodeSqliteClient.layerMemory())("093 knowledge provenance", (it) => {
  it.effect(
    "verifies raw run, node, thread and project and leaves mismatching evidence unknown",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 92 });
        for (const project of ["a", "b"])
          yield* sql`INSERT INTO projection_projects
      (project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES (${project},${project},'fixture','[]','2026','2026')`;
        const run = "actual-run",
          node = "actual-node";
        const id = agentKnowledgeItemId({ runId: run, nodeId: node });
        yield* sql`INSERT INTO projection_workspace_collaboration_runs(run_id,project_id,source,task,status,steps_json,graph_json,created_at,updated_at)
      VALUES(${run},'a','user','fixture','completed','[]','{"nodes":[{"id":"actual-node","threadId":"actual-thread"}]}','2026','2026')`;
        const tags = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)))(
          ["auto-agent-output", "run-" + knowledgeContentDigest(run, 16), "node-" + node],
        );
        for (const [project, key, label] of [
          ["a", id, tags],
          ["b", id, tags],
          ["a", "wrong-item", tags],
          ["a", "broken", "bad-json"],
        ] as const) {
          yield* sql`INSERT INTO projection_workspace_knowledge_items(project_id,item_id,kind,title,content,status,origin,tags_json,created_at,updated_at)
        VALUES(${project},${key},'rag-source','same title','fixture','active','agent',${label},'2026','2026')`;
        }
        const cases = [
          {
            node: "exact",
            tags: ["agent-grok", "confidence-medium"],
            actor: "grok",
            confidence: "medium",
          },
          {
            node: "same",
            tags: ["agent-codex", "agent-codex", "confidence-high"],
            actor: "codex",
            confidence: "high",
          },
          {
            node: "conflict",
            tags: ["agent-grok", "agent-fable", "confidence-low"],
            actor: null,
            confidence: "low",
          },
          {
            node: "invalid",
            tags: ["agent-unknown", "confidence-0.99"],
            actor: null,
            confidence: null,
          },
          {
            node: "mixed",
            tags: ["agent-fable", "confidence-high", "confidence-other"],
            actor: "fable",
            confidence: null,
          },
          {
            node: "conflicting-confidence",
            tags: ["agent-fable", "confidence-medium", "confidence-low"],
            actor: "fable",
            confidence: null,
          },
          { node: "missing", tags: [], actor: null, confidence: null },
          { node: "foreign-thread", tags: [], actor: null, confidence: null },
        ] as const;
        const capturedAt = "2026-01-02T00:00:00Z";
        const attemptAt = "2026-01-01T00:00:00Z";
        const receipt = {
          status: "completed",
          threadId: "recorded-thread",
          completedAt: attemptAt,
          output: "actual output",
          modelSelection: { instanceId: "actual-account", model: "actual-model" },
        };
        yield* sql`INSERT INTO projection_threads(thread_id,project_id,title,created_at,updated_at)
          VALUES ('foreign-thread','b','Another project',${attemptAt},${attemptAt})`;
        const tagRun = "tag-run";
        const graph = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
          nodes: cases.map((c) => ({
            id: c.node,
            threadId: c.node === "foreign-thread" ? c.node : receipt.threadId,
            output: receipt.output,
            agent: "codex",
            confidence: "high",
            attempts: [
              { ...receipt, threadId: c.node === "foreign-thread" ? c.node : receipt.threadId },
            ],
          })),
        });
        yield* sql`INSERT INTO projection_workspace_collaboration_runs
          (run_id,project_id,source,task,status,steps_json,graph_json,created_at,updated_at)
          VALUES(${tagRun},'a','user','fixture','completed','[]',${graph},${attemptAt},${attemptAt})`;
        for (const c of cases) {
          const labels = yield* Schema.encodeEffect(
            Schema.fromJsonString(Schema.Array(Schema.String)),
          )([
            "auto-agent-output",
            "run-" + knowledgeContentDigest(tagRun, 16),
            "node-" + c.node,
            ...c.tags,
          ]);
          const key = agentKnowledgeItemId({ runId: tagRun, nodeId: c.node });
          const content =
            c.node === "exact" || c.node === "foreign-thread"
              ? "TASK: task\n\nOUTPUT:\nactual output"
              : "older saved output";
          yield* sql`INSERT INTO projection_workspace_knowledge_items
            (project_id,item_id,kind,title,content,status,origin,tags_json,created_at,updated_at)
            VALUES('a',${key},'rag-source','same title',${content},'active','agent',${labels},${capturedAt},${capturedAt})`;
        }
        yield* runMigrations({ toMigrationInclusive: 93 });
        for (const c of cases) {
          const key = agentKnowledgeItemId({ runId: tagRun, nodeId: c.node });
          const [stored] = yield* sql`SELECT provenance_json ->> '$.actor' AS actor,
            provenance_json ->> '$.confidence' AS confidence, provenance_json ->> '$.modelSelection.model' AS model,
            provenance_json ->> '$.modelSelection.instanceId' AS account, provenance_json ->> '$.threadId' AS thread,
            json_type(provenance_json, '$.confidence') AS confidenceType
            FROM projection_workspace_knowledge_items WHERE project_id='a' AND item_id=${key}`;
          assert.deepEqual(stored, {
            actor: c.actor,
            thread: c.node === "foreign-thread" ? null : receipt.threadId,
            confidence: c.confidence,
            confidenceType: c.confidence ? "text" : null,
            model: c.node === "exact" ? "actual-model" : null,
            account: c.node === "exact" ? "actual-account" : null,
          });
        }
        const verified =
          yield* sql`SELECT project_id AS project, provenance_json ->> '$.runId' AS run,
      provenance_json ->> '$.nodeId' AS node,provenance_json ->> '$.threadId' AS thread
      FROM projection_workspace_knowledge_items WHERE provenance_json IS NOT NULL
        AND provenance_json ->> '$.runId' != ${tagRun}`;
        assert.deepEqual(verified, [{ project: "a", run, node, thread: "actual-thread" }]);
      }),
  );
});
