import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vite-plus/test";
import Migration0106 from "../persistence/Migrations/106_CcrToolOutputs.ts";
import Migration0113 from "../persistence/Migrations/113_WorkspaceRoutingGraphAndAdaptiveHandoff.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import {
  ROUTING_NODE_KIND,
  indexTextArtifactIntoRoutingGraph,
  propagateFileHashStaleness,
  queryRoutingGraphMoc,
  readRoutingNodesBatch,
  removeRoutingNodeByCanonicalKey,
  syncMissingKnowledgeToRoutingGraph,
} from "./workspaceRoutingGraph.ts";
import { runDreamCrystallizationCycle, shouldRunDreamCycle } from "./workspaceDreamCompiler.ts";

describe("Phase 4 — Disk-Resident SQLite WITHOUT ROWID Routing Graph & Dream Compiler", () => {
  it("runs Migration 113, executes 2-Hop PPR <t3_routing_moc>, propagates SHA-256 staleness + self-heal, and synthesizes Dream Master Reports", async () => {
    const program = Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* Migration0106;
      // Minimal stub tables needed by audit views & Dream ingestion test.
      yield* sql`CREATE TABLE IF NOT EXISTS projection_thread_activities (
        thread_id TEXT, kind TEXT, created_at TEXT
      )`;
      yield* sql`CREATE TABLE IF NOT EXISTS projection_workspace_knowledge_items (
        project_id TEXT, item_id TEXT, title TEXT, content TEXT, status TEXT, updated_at TEXT
      )`;
      yield* sql`CREATE TABLE IF NOT EXISTS workspace_memory_v2 (
        id TEXT, project_id TEXT, topic TEXT, text TEXT, memory_layer TEXT, rationale TEXT,
        entity_key TEXT, entities_json TEXT, valid_to INTEGER, status TEXT, created_at TEXT
      )`;
      yield* Migration0113;

      const projectId = "proj-routing-test";
      const targetFile = "apps/server/src/orchestration/contextAssemblyGate.ts";

      // Seed 3 distinct facts touching the same file -> triggers Dream Master Report synthesis.
      for (let i = 1; i <= 3; i += 1) {
        yield* sql`
          INSERT INTO workspace_memory_v2 (id, project_id, topic, text, memory_layer, rationale, entity_key, entities_json, valid_to, status, created_at)
          VALUES (
            ${`mem-${i}`},
            ${projectId},
            ${`Context Gate Decision ${i}`},
            ${`In ${targetFile}, \`planContextAssembly\` enforces mutual exclusion #${i} to stop 96KB prompt duplication.`},
            ${i === 1 ? "observation" : "fact"},
            ${`Cost reduction reason #${i}`},
            'context-gate',
            '["token-budget","context-gate"]',
            NULL,
            ${i === 1 ? "consolidated" : "observed"},
            '2026-11-26T10:00:00.000Z'
          )
        `;
      }

      // Verify Triple-Idle Gate
      expect(
        shouldRunDreamCycle({ activeWorkCount: 1, idleMs: 900_000, dailySynthesizedReports: 0 }),
      ).toBe(false);
      expect(
        shouldRunDreamCycle({ activeWorkCount: 0, idleMs: 60_000, dailySynthesizedReports: 0 }),
      ).toBe(false);
      expect(
        shouldRunDreamCycle({ activeWorkCount: 0, idleMs: 700_000, dailySynthesizedReports: 0 }),
      ).toBe(true);

      // Run Dream crystallization (0 LLM tokens deterministic mode).
      const dream = yield* runDreamCrystallizationCycle(sql, { projectId });
      expect(dream.indexedMemoryCount).toBe(3);
      expect(dream.reportsSynthesized).toBe(1);
      expect(dream.edgesCreated).toBeGreaterThanOrEqual(8);

      // Verify audit view `v_t3_audit_graph_health`
      const [health] = yield* sql<{
        total_nodes: number;
        master_reports: number;
        total_edges: number;
      }>`SELECT total_nodes, master_reports, total_edges FROM v_t3_audit_graph_health WHERE project_id = ${projectId}`;
      expect(health?.master_reports).toBe(1);
      expect(health?.total_edges).toBeGreaterThanOrEqual(8);

      // Query 2-Hop PPR Routing MoC
      const moc = yield* queryRoutingGraphMoc(sql, {
        projectId,
        query:
          "How does `planContextAssembly` stop prompt duplication in apps/server/src/orchestration/contextAssemblyGate.ts?",
      });
      expect(moc.primaryNode).not.toBeNull();
      expect(moc.primaryNode?.nodeKind).toBe(ROUTING_NODE_KIND.MASTER_REPORT);
      expect(moc.renderedMoc).toContain("<t3_routing_moc>");
      expect(moc.renderedMoc).toContain("[VALID]");
      expect(moc.renderedMoc.length).toBeLessThan(2_000);

      // Stamp initial blob hash -> mutate hash -> verify STALE propagation -> restore hash -> verify self-heal!
      const stamp = yield* propagateFileHashStaleness(sql, {
        projectId,
        filePath: targetFile,
        newBlobSha256: "aaa11111",
      });
      expect(stamp.newStaleStatus).toBe(0);

      const mutated = yield* propagateFileHashStaleness(sql, {
        projectId,
        filePath: targetFile,
        newBlobSha256: "bbb22222",
      });
      expect(mutated.changed).toBe(true);
      expect(mutated.newStaleStatus).toBe(2);
      expect(mutated.affectedNodes).toBeGreaterThanOrEqual(4);

      const staleMoc = yield* queryRoutingGraphMoc(sql, {
        projectId,
        query: "`planContextAssembly` duplication",
      });
      expect(staleMoc.renderedMoc).toContain("[STALE:파일변경]");

      const healed = yield* propagateFileHashStaleness(sql, {
        projectId,
        filePath: targetFile,
        newBlobSha256: "aaa11111",
      });
      expect(healed.changed).toBe(false);
      expect(healed.newStaleStatus).toBe(0);

      // Batch read up to 5 nodes
      const batch = yield* readRoutingNodesBatch(sql, {
        projectId,
        nodeIds: [moc.primaryNode!.nodeId],
      });
      expect(batch).toHaveLength(1);
      expect(batch[0]?.bodyMarkdown).toContain("Master Report:");
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory()));

    await Effect.runPromise(program);
  });

  it("indexes single artifacts deterministically with symbol and file backlinks", async () => {
    const program = Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* Migration0106;
      yield* sql`CREATE TABLE IF NOT EXISTS projection_thread_activities (thread_id TEXT, kind TEXT, created_at TEXT)`;
      yield* Migration0113;

      const res = yield* indexTextArtifactIntoRoutingGraph(sql, {
        projectId: "proj-2",
        nodeKind: ROUTING_NODE_KIND.MEMORY_FACT,
        canonicalKey: "note:ccr-1",
        title: "CCR t0 compression",
        summaryMoc: "Uses compressCodingToolOutputAtT0 in apps/server/src/mcp/ccr/CcrCompressor.ts",
        bodyMarkdown: "Calls `compressCodingToolOutputAtT0` and `formatCompactEditReceipt`.",
      });
      expect(res.filesLinked).toBe(1);
      expect(res.symbolsLinked).toBe(2);
      expect(res.keywordsLinked).toBeGreaterThanOrEqual(2);
      expect(res.edgesCreated).toBe(res.filesLinked + res.symbolsLinked + res.keywordsLinked);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory()));

    await Effect.runPromise(program);
  });

  it("syncs RAG knowledge incrementally onto SQLite disk with compressed index bodies (<=480 chars), routes Korean keywords, and removes archived nodes cleanly", async () => {
    const program = Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* Migration0106;
      yield* sql`CREATE TABLE IF NOT EXISTS projection_thread_activities (thread_id TEXT, kind TEXT, created_at TEXT)`;
      yield* sql`CREATE TABLE IF NOT EXISTS projection_workspace_knowledge_items (
        project_id TEXT, item_id TEXT, title TEXT, content TEXT, tags_json TEXT, status TEXT, updated_at TEXT
      )`;
      yield* Migration0113;

      const projectId = "proj-rag-kw";
      const longContent =
        "==================\n크라임 코인 백테스팅 전수조사 전략 보고서\n" +
        "변동성 돌파와 거래량 급증 필터를 적용해 1년 복리 수익률 10배(100→1000달러)와 승률 54%를 검증했습니다. ".repeat(
          30,
        );

      yield* sql`
        INSERT INTO projection_workspace_knowledge_items (project_id, item_id, title, content, tags_json, status, updated_at)
        VALUES (${projectId}, 'rag-crime-1', '크라임 코인 백테스팅 전략', ${longContent}, '["크라임코인","백테스팅","복리전략"]', 'active', '2026-11-26T10:00:00.000Z')
      `;

      // 1. First incremental sync indexes the RAG item on disk
      const sync1 = yield* syncMissingKnowledgeToRoutingGraph(sql, { projectId });
      expect(sync1.indexedCount).toBe(1);
      expect(sync1.edgesCreated).toBeGreaterThanOrEqual(3);

      // 2. Stored body_markdown is compressed (<= 480 chars), NOT duplicating the 2KB+ raw text
      const [stored] = yield* sql<{ body_markdown: string; body_ref_id: string | null }>`
        SELECT body_markdown, body_ref_id FROM workspace_routing_nodes
        WHERE project_id = ${projectId} AND canonical_key = 'knowledge:rag-crime-1'
      `;
      expect(stored?.body_ref_id).toBe("rag-crime-1");
      expect((stored?.body_markdown ?? "").length).toBeLessThanOrEqual(480);

      // 3. Second sync is a 0-work no-op when nothing changed
      const sync2 = yield* syncMissingKnowledgeToRoutingGraph(sql, { projectId });
      expect(sync2.indexedCount).toBe(0);

      // 4. Korean keyword query hits via kw:* phrase anchor & returns compact <t3_routing_moc>
      const moc = yield* queryRoutingGraphMoc(sql, {
        projectId,
        query: "크라임코인 백테스팅 복리전략 정리",
      });
      expect(moc.primaryNode?.bodyRefId).toBe("rag-crime-1");
      expect(moc.renderedMoc).toContain("<t3_routing_moc>");

      // 5. Removing canonical key deletes node and incident edges cleanly
      const removed = yield* removeRoutingNodeByCanonicalKey(sql, {
        projectId,
        canonicalKey: "knowledge:rag-crime-1",
      });
      expect(removed).toBe(1);
      const afterMoc = yield* queryRoutingGraphMoc(sql, {
        projectId,
        query: "크라임코인 백테스팅",
      });
      expect(afterMoc.primaryNode).toBeNull();
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory()));

    await Effect.runPromise(program);
  });
});
