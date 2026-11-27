import {
  ThreadId,
  WorkspaceCollaborationRunId,
  WorkspaceTaskNodeId,
  WorkspaceKnowledgeProvenance,
  WorkspaceOrchestrationAgent,
  WorkspaceValidationConfidence,
  WorkspaceKnowledgeSourceModel,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Schema from "effect/Schema";
import { agentKnowledgeItemId } from "../../orchestration/workspaceAgentKnowledge.ts";
import { knowledgeContentDigest } from "../../orchestration/workspaceConversationRag.ts";

const Tags = Schema.fromJsonString(Schema.Array(Schema.String));
const tupleKey = Schema.encodeSync(Tags);
const decodeTags = Schema.decodeUnknownOption(Tags);
const decodeModel = Schema.decodeUnknownOption(
  Schema.fromJsonString(WorkspaceKnowledgeSourceModel),
);

function uniqueCaptureTag<A extends string>(
  tags: readonly string[],
  prefix: string,
  valid: (value: unknown) => value is A,
): A | undefined {
  const values = new Set(
    tags.filter((tag) => tag.startsWith(prefix)).map((tag) => tag.slice(prefix.length)),
  );
  const [value] = values;
  return values.size === 1 && valid(value) ? value : undefined;
}

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE projection_workspace_knowledge_items ADD COLUMN provenance_json TEXT`;
  yield* sql`ALTER TABLE projection_workspace_knowledge_items ADD COLUMN source_item_id TEXT`;
  yield* sql`CREATE UNIQUE INDEX workspace_knowledge_user_fork
    ON projection_workspace_knowledge_items(project_id, source_item_id) WHERE source_item_id IS NOT NULL`;
  yield* sql`CREATE INDEX workspace_knowledge_origin_run ON projection_workspace_knowledge_items
    (project_id, json_extract(provenance_json, '$.runId'))`;
  yield* sql`CREATE INDEX workspace_knowledge_document_events ON orchestration_events
    (stream_id, json_extract(payload_json,'$.itemId'), sequence DESC)
    WHERE event_type IN ('project.knowledge-item-upserted','project.knowledge-item-archived')`;

  // A digest is only a lookup key. Require one raw run in the owning project,
  // its actual node, the full deterministic item ID, and the original capture tags.
  const nodes = yield* sql<{
    project: string;
    run: string;
    node: string;
    nodeIndex: number;
    thread: string | null;
  }>`
    SELECT r.project_id AS project, r.run_id AS run, n.key AS nodeIndex, n.value ->> '$.id' AS node,
      coalesce(n.value ->> '$.threadId',
        CASE WHEN r.orchestra_json IS NULL AND json_valid(r.meeting_json)
          THEN r.meeting_json ->> '$.threadId' END) AS thread
    FROM projection_workspace_collaboration_runs r, json_each(CASE WHEN json_valid(r.graph_json) THEN r.graph_json END, '$.nodes') n
    WHERE json_type(CASE WHEN json_valid(r.graph_json) THEN r.graph_json END,'$.nodes')='array'
      AND n.type='object' AND json_type(n.value,'$.id')='text'
      AND EXISTS (SELECT 1 FROM projection_workspace_knowledge_items k
        WHERE k.project_id=r.project_id AND k.item_id LIKE 'agent-output-%')`;
  const runs = yield* sql<{ project: string; run: string }>`
    SELECT project_id AS project,run_id AS run FROM projection_workspace_collaboration_runs`;
  const byHash = new Map<string, number>();
  for (const row of runs) {
    const key = tupleKey([row.project, knowledgeContentDigest(row.run, 16)]);
    byHash.set(key, (byHash.get(key) ?? 0) + 1);
  }
  const nodeMatches = new Map<string, number>();
  for (const row of nodes) {
    const key = tupleKey([row.project, row.run, row.node]);
    nodeMatches.set(key, (nodeMatches.get(key) ?? 0) + 1);
  }
  for (const row of nodes) {
    if (
      !Schema.is(WorkspaceCollaborationRunId)(row.run) ||
      !Schema.is(WorkspaceTaskNodeId)(row.node)
    )
      continue;
    if (nodeMatches.get(tupleKey([row.project, row.run, row.node])) !== 1) continue;
    const hash = knowledgeContentDigest(row.run, 16);
    if (byHash.get(tupleKey([row.project, hash])) !== 1) continue;
    const itemId = agentKnowledgeItemId({ runId: row.run, nodeId: row.node });
    const [item] = yield* sql<{ tags: string; model: string | null; thread: string | null }>`
      WITH source AS (
        SELECT json_extract(graph_json, ${"$.nodes[" + row.nodeIndex + "]"}) AS node, updated_at
        FROM projection_workspace_collaboration_runs WHERE project_id=${row.project} AND run_id=${row.run}
      ), receipt AS (
        SELECT node ->> '$.output' AS output, node ->> '$.threadId' AS thread,
          node -> '$.attempts[#-1]' AS attempt, updated_at FROM source
      )
      SELECT k.tags_json AS tags,
        CASE WHEN NOT EXISTS (SELECT 1 FROM projection_threads t
          WHERE t.thread_id=${row.thread} AND t.project_id<>k.project_id) THEN ${row.thread} END AS thread,
        CASE WHEN julianday(r.updated_at) <= julianday(k.updated_at)
          AND julianday(r.attempt ->> '$.completedAt') <= julianday(k.updated_at)
          AND r.attempt ->> '$.status' = 'completed'
          AND (r.thread IS NULL OR r.thread = r.attempt ->> '$.threadId')
          AND length(r.output)>0 AND r.attempt ->> '$.output'=substr(r.output,1,8000)
          AND substr(k.content,-(length(r.output)+8))='OUTPUT:' || char(10) || r.output
          THEN r.attempt -> '$.modelSelection' END AS model
      FROM projection_workspace_knowledge_items k, receipt r
      WHERE k.project_id=${row.project} AND k.item_id=${itemId}
        AND k.kind='rag-source' AND k.origin='agent'`;
    if (!item) continue;
    const tags = Option.getOrUndefined(decodeTags(item.tags));
    if (
      !tags?.includes("auto-agent-output") ||
      !tags.includes("run-" + hash) ||
      !tags.includes("node-" + row.node)
    )
      continue;
    // Role and confidence belong to this capture, even if the graph has since changed.
    const actor = uniqueCaptureTag(tags, "agent-", Schema.is(WorkspaceOrchestrationAgent));
    const confidence = uniqueCaptureTag(
      tags,
      "confidence-",
      Schema.is(WorkspaceValidationConfidence),
    );
    const selection =
      item.thread === row.thread ? Option.getOrUndefined(decodeModel(item.model)) : undefined;
    const provenance = yield* Schema.encodeEffect(
      Schema.fromJsonString(WorkspaceKnowledgeProvenance),
    )({
      runId: row.run,
      nodeId: row.node,
      ...(Schema.is(ThreadId)(item.thread) ? { threadId: item.thread } : {}),
      ...(actor ? { actor } : {}),
      ...(confidence ? { confidence } : {}),
      ...(selection
        ? { modelSelection: { instanceId: selection.instanceId, model: selection.model } }
        : {}),
    });
    yield* sql`UPDATE projection_workspace_knowledge_items SET provenance_json=${provenance}
      WHERE project_id=${row.project} AND item_id=${itemId}`;
  }
  yield* sql`UPDATE projection_workspace_knowledge_items AS k
    SET provenance_json=json_object('runId',r.run_id)
    FROM projection_workspace_collaboration_runs AS r
    WHERE k.project_id=r.project_id AND k.item_id='collaboration-run-' || r.run_id
      AND k.origin='agent' AND k.kind='run-memory' AND k.provenance_json IS NULL`;
  yield* sql`UPDATE projection_workspace_knowledge_items AS k
    SET provenance_json=json_object('threadId',t.thread_id) FROM projection_threads AS t
    WHERE k.project_id=t.project_id AND k.provenance_json IS NULL AND k.origin='imported'
      AND t.thread_id=CASE WHEN json_valid(k.research_json) THEN json_extract(k.research_json,'$.attachment.threadId') END`;
  yield* sql`UPDATE projection_workspace_knowledge_items AS k
    SET provenance_json=(SELECT json_object('threadId',min(s.thread_id))
      FROM workspace_conversation_rag_sources s WHERE s.project_id=k.project_id AND s.item_id=k.item_id)
    WHERE k.provenance_json IS NULL AND EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(k.tags_json) THEN k.tags_json END) WHERE value='auto-conversation')
    AND (SELECT count(DISTINCT s.thread_id) FROM workspace_conversation_rag_sources s
         WHERE s.project_id=k.project_id AND s.item_id=k.item_id)=1`;
});
