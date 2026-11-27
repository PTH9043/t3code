// @effect-diagnostics globalDate:off globalDateInEffect:off
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  ROUTING_EDGE_TYPE,
  ROUTING_NODE_KIND,
  indexTextArtifactIntoRoutingGraph,
  upsertRoutingEdge,
  upsertRoutingNode,
} from "./workspaceRoutingGraph.ts";

export const DREAM_MIN_IDLE_MS = 10 * 60 * 1000;
export const DREAM_DEFAULT_DAILY_REPORT_CAP = 12;

export interface DreamIdleGateInput {
  readonly activeWorkCount: number;
  readonly idleMs: number;
  readonly dailySynthesizedReports: number;
  readonly minIdleMs?: number | undefined;
  readonly dailyReportCap?: number | undefined;
}

/**
 * Triple-Idle Gate for background Dream crystallization:
 * runs ONLY when (1) zero active turns/delegations/orchestra runs,
 * (2) >= 10 minutes idle since last user interaction, and
 * (3) daily synthesized report cap has not been exceeded.
 */
export function shouldRunDreamCycle(input: DreamIdleGateInput): boolean {
  const minIdle = input.minIdleMs ?? DREAM_MIN_IDLE_MS;
  const cap = input.dailyReportCap ?? DREAM_DEFAULT_DAILY_REPORT_CAP;
  return (
    input.activeWorkCount === 0 && input.idleMs >= minIdle && input.dailySynthesizedReports < cap
  );
}

export interface DreamCycleResult {
  readonly indexedKnowledgeCount: number;
  readonly indexedMemoryCount: number;
  readonly edgesCreated: number;
  readonly reportsSynthesized: number;
}

/**
 * Recommended Hybrid Dream Crystallizer:
 * 1) Deterministic 0-LLM backlinking of active knowledge items & memory v3 facts
 *    into the disk-resident SQLite routing graph (`0.47% -> 90%+` link density).
 * 2) Cluster synthesis: groups >=3 related fact nodes sharing the same file anchor
 *    into a compiled Master Report (`node_kind = 4`) with `verified_by` provenance
 *    edges. Uses deterministic structured synthesis by default, and optionally
 *    delegates prose polishing to a low-cost helper callback when configured.
 */
export const runDreamCrystallizationCycle = Effect.fn("WorkspaceDreamCompiler.runCycle")(function* (
  sql: SqlClient.SqlClient,
  input: {
    readonly projectId: string;
    readonly maxItemsPerCycle?: number | undefined;
    readonly maxReportsPerCycle?: number | undefined;
    readonly synthesizeClusterWithHelper?: (cluster: {
      readonly filePath: string;
      readonly items: ReadonlyArray<{
        readonly nodeId: number;
        readonly title: string;
        readonly summary: string;
      }>;
    }) => Effect.Effect<{
      readonly title: string;
      readonly summaryMoc: string;
      readonly bodyMarkdown: string;
    } | null>;
  },
) {
  const maxItems = input.maxItemsPerCycle ?? 200;
  const maxReports = input.maxReportsPerCycle ?? 4;
  let indexedKnowledgeCount = 0;
  let indexedMemoryCount = 0;
  let edgesCreated = 0;

  // Step 1A: Deterministically index active knowledge items (if table exists).
  const knowledgeRows = yield* sql<{
    item_id: string;
    title: string;
    content: string;
    updated_at: string;
  }>`
    SELECT item_id, title, substr(content, 1, 4000) AS content, updated_at
    FROM projection_workspace_knowledge_items
    WHERE project_id = ${input.projectId} AND status = 'active'
    ORDER BY updated_at DESC
    LIMIT ${maxItems}
  `.pipe(Effect.orElseSucceed(() => []));

  for (const row of knowledgeRows) {
    const res = yield* indexTextArtifactIntoRoutingGraph(sql, {
      projectId: input.projectId,
      nodeKind: ROUTING_NODE_KIND.MEMORY_FACT,
      canonicalKey: `knowledge:${row.item_id}`,
      title: row.title || row.item_id,
      summaryMoc: row.content.slice(0, 220),
      bodyMarkdown: row.content,
      bodyRefKind: "knowledge",
      bodyRefId: row.item_id,
      epistemicState: "fact",
      updatedAtMs: Date.parse(row.updated_at) || Date.now(),
    });
    indexedKnowledgeCount += 1;
    edgesCreated += res.edgesCreated;
  }

  // Step 1B: Deterministically index active Memory v3 observations & durable facts
  // (`status` in live `workspace_memory_v2` uses `'observed'` / `'consolidated'`, excluding `'archived'` / `'forgotten'`).
  const memoryRows = yield* sql<{
    id: string;
    topic: string;
    text: string;
    memory_layer: string | null;
    rationale: string | null;
    entity_key: string | null;
    entities_json: string | null;
    created_at: string;
  }>`
    SELECT id, topic, substr(text, 1, 2000) AS text, memory_layer, rationale,
           entity_key, entities_json, created_at
    FROM workspace_memory_v2
    WHERE project_id = ${input.projectId}
      AND status NOT IN ('archived', 'forgotten')
      AND valid_to IS NULL
    ORDER BY created_at DESC
    LIMIT ${maxItems}
  `.pipe(Effect.orElseSucceed(() => []));

  for (const row of memoryRows) {
    const summary = row.rationale
      ? `${row.text.slice(0, 140)} (근거: ${row.rationale.slice(0, 80)})`
      : row.text.slice(0, 220);
    const parsedEntities: string[] = [];
    if (row.entity_key?.trim()) parsedEntities.push(row.entity_key.trim());
    if (row.topic?.trim() && !row.topic.startsWith("conversation"))
      parsedEntities.push(row.topic.trim());
    if (row.entities_json) {
      try {
        const arr = JSON.parse(row.entities_json);
        if (Array.isArray(arr)) {
          for (const item of arr) {
            if (typeof item === "string" && item.trim()) parsedEntities.push(item.trim());
          }
        }
      } catch {
        // Ignore malformed entity JSON.
      }
    }
    const res = yield* indexTextArtifactIntoRoutingGraph(sql, {
      projectId: input.projectId,
      nodeKind: ROUTING_NODE_KIND.MEMORY_FACT,
      canonicalKey: `mem:${row.id}`,
      title: `[${row.memory_layer ?? "fact"}] ${row.topic}`,
      summaryMoc: summary,
      bodyMarkdown: row.rationale ? `${row.text}\n\n[근거] ${row.rationale}` : row.text,
      bodyRefKind: "memory_v2",
      bodyRefId: row.id,
      epistemicState: row.memory_layer === "observation" ? "verified_inference" : "fact",
      keywords: parsedEntities,
      updatedAtMs: Date.parse(row.created_at) || Date.now(),
    });
    indexedMemoryCount += 1;
    edgesCreated += res.edgesCreated;
  }

  // Step 2: Synthesize dense file-anchored clusters (>=3 facts) into Master Reports (node_kind=4).
  const denseFileClusters = yield* sql<{
    file_node_id: number;
    file_path: string;
    cnt: number;
  }>`
    SELECT f.node_id AS file_node_id, f.file_path AS file_path, COUNT(DISTINCT e.src_id) AS cnt
    FROM workspace_routing_nodes f
    JOIN workspace_routing_edges_rev e
      ON e.project_id = f.project_id
     AND e.dst_id = f.node_id
     AND e.edge_type = ${ROUTING_EDGE_TYPE.TOUCHES_FILE}
     AND e.valid_to_ms IS NULL
    JOIN workspace_routing_nodes src
      ON src.node_id = e.src_id
     AND src.node_kind = ${ROUTING_NODE_KIND.MEMORY_FACT}
    WHERE f.project_id = ${input.projectId}
      AND f.node_kind = ${ROUTING_NODE_KIND.FILE}
      AND f.file_path IS NOT NULL
    GROUP BY f.node_id, f.file_path
    HAVING COUNT(DISTINCT e.src_id) >= 3
    ORDER BY cnt DESC
    LIMIT ${maxReports}
  `;

  let reportsSynthesized = 0;
  for (const cluster of denseFileClusters) {
    const members = yield* sql<{
      node_id: number;
      title: string;
      summary_moc: string;
      body_ref_id: string | null;
    }>`
      SELECT src.node_id, src.title, src.summary_moc, src.body_ref_id
      FROM workspace_routing_edges_rev e
      JOIN workspace_routing_nodes src ON src.node_id = e.src_id
      WHERE e.project_id = ${input.projectId}
        AND e.dst_id = ${cluster.file_node_id}
        AND e.edge_type = ${ROUTING_EDGE_TYPE.TOUCHES_FILE}
        AND e.valid_to_ms IS NULL
        AND src.node_kind = ${ROUTING_NODE_KIND.MEMORY_FACT}
      ORDER BY src.updated_at_ms DESC
      LIMIT 8
    `;
    if (members.length < 3) continue;

    let reportTitle = `Master Report: ${cluster.file_path}`;
    let reportSummary = `${cluster.file_path} 관련 핵심 사실 ${members.length}건 통합: ${members
      .slice(0, 2)
      .map((m) => m.summary_moc.slice(0, 75))
      .join(" / ")}`;
    let reportBody = [
      `# ${reportTitle}`,
      `- 대상 파일: ${cluster.file_path}`,
      `- 통합 근거 수: ${members.length}건`,
      "",
      "## 핵심 결정 및 사실",
      ...members.map(
        (m) =>
          `- [#${m.node_id}${m.body_ref_id ? ` / ${m.body_ref_id}` : ""}] ${m.title}: ${m.summary_moc}`,
      ),
    ].join("\n");

    if (input.synthesizeClusterWithHelper) {
      const helperResult = yield* input
        .synthesizeClusterWithHelper({
          filePath: cluster.file_path,
          items: members.map((m) => ({
            nodeId: m.node_id,
            title: m.title,
            summary: m.summary_moc,
          })),
        })
        .pipe(Effect.orElseSucceed(() => null));
      if (helperResult) {
        reportTitle = helperResult.title;
        reportSummary = helperResult.summaryMoc;
        reportBody = helperResult.bodyMarkdown;
      }
    }

    const reportNodeId = yield* upsertRoutingNode(sql, {
      projectId: input.projectId,
      nodeKind: ROUTING_NODE_KIND.MASTER_REPORT,
      canonicalKey: `report:file:${cluster.file_path}`,
      title: reportTitle,
      summaryMoc: reportSummary,
      bodyMarkdown: reportBody,
      bodyRefKind: "compiled_report",
      bodyRefId: `report:file:${cluster.file_path}`,
      epistemicState: "verified_inference",
      filePath: cluster.file_path,
    });

    yield* upsertRoutingEdge(sql, {
      projectId: input.projectId,
      srcId: reportNodeId,
      edgeType: ROUTING_EDGE_TYPE.TOUCHES_FILE,
      dstId: cluster.file_node_id,
      weight: 1.2,
    });
    for (const member of members) {
      yield* upsertRoutingEdge(sql, {
        projectId: input.projectId,
        srcId: reportNodeId,
        edgeType: ROUTING_EDGE_TYPE.VERIFIED_BY,
        dstId: member.node_id,
        weight: 1.0,
      });
    }
    reportsSynthesized += 1;
    edgesCreated += 1 + members.length;
  }

  return {
    indexedKnowledgeCount,
    indexedMemoryCount,
    edgesCreated,
    reportsSynthesized,
  } satisfies DreamCycleResult;
});
