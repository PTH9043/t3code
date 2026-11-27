// @effect-diagnostics anyUnknownInErrorContext:off
import { ALL_EXECUTION_KINDS } from "@t3tools/contracts";
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Tracer from "effect/Tracer";

import { activeWorkRegistry } from "../../orchestration/ActiveWorkTracker.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import {
  activeWorkKindForExecutionKind,
  annotateExecutionSpan,
  unifiedExecutionLedger,
  UnifiedExecutionLedgerLive,
} from "./UnifiedExecutionLedger.ts";

describe("UnifiedExecutionLedger (9종 협업 공통 실행 원장)", () => {
  afterEach(() => {
    unifiedExecutionLedger.resetForTests();
    unifiedExecutionLedger.detachSqlClient();
    activeWorkRegistry.clearAll();
  });

  it.effect(
    "registers all 9 execution kinds into ActiveWorkTracker and SQLite Migration 108, and settles cleanly",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        unifiedExecutionLedger.attachSqlClient(sql);

        // 1. Start all 9 kinds simultaneously
        for (const kind of ALL_EXECUTION_KINDS) {
          yield* unifiedExecutionLedger.beginEffect({
            executionId: `exec-${kind}-1`,
            executionKind: kind,
            threadId: `thread-${kind}`,
            projectId: "proj-1",
            summary: `test ${kind}`,
            provider: "test-provider",
            model: "test-model",
            startedAtMs: 1_700_000_000_000,
          });
        }

        // Verify ActiveWorkTracker mirrors all 9 active runs with exact executionKind
        const snap = activeWorkRegistry.snapshot(1_700_000_005_000);
        expect(snap.totalActive).toBe(9);
        const mirroredKinds = new Set(snap.items.map((item) => item.executionKind));
        for (const kind of ALL_EXECUTION_KINDS) {
          expect(mirroredKinds.has(kind)).toBe(true);
        }

        // Verify SQLite persistence
        const runningSummary = yield* unifiedExecutionLedger.querySummary();
        expect(runningSummary.totalRuns).toBe(9);
        expect(runningSummary.activeRuns).toBe(9);
        expect(runningSummary.byKind).toHaveLength(9);

        // 2. Finish 3 runs with different terminal statuses (completed / failed / cancelled)
        yield* unifiedExecutionLedger.finishEffect({
          executionId: "exec-orchestra-1",
          executionKind: "orchestra",
          status: "completed",
        });
        yield* unifiedExecutionLedger.finishEffect({
          executionId: "exec-workspace_helper-1",
          executionKind: "workspace_helper",
          status: "failed",
          errorMessage: "HTTP 500",
        });
        yield* unifiedExecutionLedger.finishEffect({
          executionId: "exec-codex_subagent-1",
          executionKind: "codex_subagent",
          status: "cancelled",
          errorMessage: "Session stopped",
        });

        // Idempotency check: second finish on already-failed run must NOT overwrite status
        yield* unifiedExecutionLedger.finishEffect({
          executionId: "exec-workspace_helper-1",
          executionKind: "workspace_helper",
          status: "completed",
        });

        expect(activeWorkRegistry.snapshot().totalActive).toBe(6);

        // 3. Simulate server restart: closeStaleRuns marks all remaining 6 running entries as interrupted_by_restart
        const closedCount = yield* unifiedExecutionLedger.closeStaleRuns(1_700_000_010_000);
        expect(closedCount).toBe(6);
        expect(activeWorkRegistry.snapshot().totalActive).toBe(0);

        const afterRestart = yield* unifiedExecutionLedger.querySummary();
        expect(afterRestart.activeRuns).toBe(0);
        expect(afterRestart.totalRuns).toBe(9);

        const helperEntry = afterRestart.recentRuns.find(
          (e) => e.executionId === "exec-workspace_helper-1",
        );
        expect(helperEntry?.status).toBe("failed");
        expect(helperEntry?.errorMessage).toBe("HTTP 500");

        const councilEntry = afterRestart.recentRuns.find(
          (e) => e.executionId === "exec-council-1",
        );
        expect(councilEntry?.status).toBe("interrupted_by_restart");
        expect(councilEntry?.finishedAtMs).toBe(1_700_000_010_000);
      }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect(
    "UnifiedExecutionLedgerLive boots cleanly and auto-closes leftover running rows on startup",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO unified_execution_runs (
          execution_id, execution_kind, active_work_kind, thread_id, project_id, parent_run_id,
          summary, status, provider, model, error_message, started_at_ms, updated_at_ms, finished_at_ms
        ) VALUES (
          'stale-upgrade-1', 'upgrade_room', 'collaboration', 'autousage-upgrade-room', NULL, 'upgrade-room',
          '업그레이드 방 미종료', 'running', 'claudeAgent', 'claude-opus-4-6', NULL, 1000, 1000, NULL
        )`;

        yield* Effect.scoped(
          Effect.gen(function* () {
            const rows = yield* sql<{ status: string; finished_at_ms: number | null }>`
              SELECT status, finished_at_ms FROM unified_execution_runs WHERE execution_id = 'stale-upgrade-1'`;
            expect(rows).toHaveLength(1);
            expect(rows[0]?.status).toBe("interrupted_by_restart");
            expect(rows[0]?.finished_at_ms).not.toBeNull();
          }).pipe(Effect.provide(UnifiedExecutionLedgerLive)),
        );
      }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect(
    "attaches t3.execution_kind, t3.execution_id, and t3.thread_id to active Effect spans",
    () =>
      Effect.gen(function* () {
        const capturedSpans: Array<{
          readonly name: string;
          readonly attrs: ReadonlyMap<string, unknown>;
        }> = [];
        const captureTracer = Tracer.make({
          span: (options) => {
            const span = new Tracer.NativeSpan(options);
            const end = span.end.bind(span);
            span.end = (endTime, exit) => {
              end(endTime, exit);
              capturedSpans.push({ name: span.name, attrs: new Map(span.attributes) });
            };
            return span;
          },
        });

        yield* Effect.gen(function* () {
          yield* annotateExecutionSpan({
            executionKind: "claude_subagent",
            executionId: "claude-task:t1:sub1",
            threadId: "t1",
            provider: "claudeAgent",
            model: "claude-sonnet-4-6",
          });
        }).pipe(
          Effect.withSpan("UnifiedExecutionLedger.testSpan"),
          Effect.withTracer(captureTracer),
        );

        const span = capturedSpans.find((s) => s.name === "UnifiedExecutionLedger.testSpan");
        expect(span?.attrs.get("t3.execution_kind")).toBe("claude_subagent");
        expect(span?.attrs.get("t3.execution_id")).toBe("claude-task:t1:sub1");
        expect(span?.attrs.get("t3.thread_id")).toBe("t1");
        expect(activeWorkKindForExecutionKind("claude_subagent")).toBe("delegation");
        expect(activeWorkKindForExecutionKind("council")).toBe("collaboration");
      }),
  );
});
