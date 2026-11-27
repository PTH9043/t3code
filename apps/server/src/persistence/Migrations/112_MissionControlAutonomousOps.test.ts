import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vite-plus/test";
import { makeSqlitePersistenceLive } from "../Layers/Sqlite.ts";

const TestDbLayer = makeSqlitePersistenceLive(":memory:").pipe(Layer.provide(NodeServices.layer));

describe("Migration 112: MissionControlAutonomousOps", () => {
  it("신규 6개 테이블과 기존 109 테이블 확장 컬럼을 무손실로 생성한다", async () => {
    const program = Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const tables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'table'
      `;
      const tableNames = new Set(tables.map((t) => t.name));
      expect(tableNames.has("mission_runs")).toBe(true);
      expect(tableNames.has("mission_crew_roles")).toBe(true);
      expect(tableNames.has("mission_reports")).toBe(true);
      expect(tableNames.has("mission_budget_ledger")).toBe(true);
      expect(tableNames.has("mission_activity_log")).toBe(true);
      expect(tableNames.has("mission_control_state")).toBe(true);
      // 중복 테이블 금지 (기존 109/106/104 SSOT 유지)
      expect(tableNames.has("worker_tasks")).toBe(true);
      expect(tableNames.has("worker_mailbox_messages")).toBe(true);
      expect(tableNames.has("worker_decision_gates")).toBe(true);
      expect(tableNames.has("ccr_tool_outputs")).toBe(true);

      const taskCols = yield* sql<{ readonly name: string }>`PRAGMA table_info(worker_tasks)`;
      const taskColSet = new Set(taskCols.map((c) => c.name));
      expect(taskColSet.has("mission_id")).toBe(true);
      expect(taskColSet.has("dag_node_id")).toBe(true);
      expect(taskColSet.has("role_id")).toBe(true);

      const gateCols = yield* sql<{
        readonly name: string;
      }>`PRAGMA table_info(worker_decision_gates)`;
      const gateColSet = new Set(gateCols.map((c) => c.name));
      expect(gateColSet.has("mission_id")).toBe(true);
      expect(gateColSet.has("project_id")).toBe(true);
      expect(gateColSet.has("escalation_tier")).toBe(true);
      expect(gateColSet.has("trigger_reason")).toBe(true);
      expect(gateColSet.has("context_3lines_md")).toBe(true);
      expect(gateColSet.has("ai_recommendation")).toBe(true);
      expect(gateColSet.has("checkpoint_payload_json")).toBe(true);
      expect(gateColSet.has("snoozed_until_ms")).toBe(true);
    }).pipe(Effect.provide(TestDbLayer));

    await Effect.runPromise(program);
  });
});
