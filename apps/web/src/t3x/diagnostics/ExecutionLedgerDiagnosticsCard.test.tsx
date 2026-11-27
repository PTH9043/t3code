import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { ALL_EXECUTION_KINDS, type ExecutionLedgerSummary } from "@t3tools/contracts";

import { ExecutionLedgerDiagnosticsCard } from "./ExecutionLedgerDiagnosticsCard";

describe("ExecutionLedgerDiagnosticsCard", () => {
  it("renders all 9 collaboration execution kinds and recent runs", () => {
    const summary: ExecutionLedgerSummary = {
      totalRuns: 4,
      activeRuns: 1,
      byKind: ALL_EXECUTION_KINDS.map((executionKind) => ({
        executionKind,
        running: executionKind === "council" ? 1 : 0,
        completed: executionKind === "orchestra" ? 1 : 0,
        failed: executionKind === "workspace_helper" ? 1 : 0,
        cancelled: 0,
        interruptedByRestart: executionKind === "upgrade_room" ? 1 : 0,
        total:
          executionKind === "council" ||
          executionKind === "orchestra" ||
          executionKind === "workspace_helper" ||
          executionKind === "upgrade_room"
            ? 1
            : 0,
      })),
      recentRuns: [
        {
          executionId: "cnc_1",
          executionKind: "council",
          activeWorkKind: "collaboration",
          threadId: "thr_1",
          projectId: "prj_1",
          parentRunId: null,
          summary: "다자간 위원회 (3석): 아키텍처 검토",
          status: "running",
          provider: "claudeAgent",
          model: "claude-opus-4-6",
          errorMessage: null,
          startedAtMs: 1_700_000_000_000,
          updatedAtMs: 1_700_000_005_000,
          finishedAtMs: null,
        },
        {
          executionId: "upg_1",
          executionKind: "upgrade_room",
          activeWorkKind: "collaboration",
          threadId: "autousage-upgrade-room",
          projectId: null,
          parentRunId: "upgrade-room",
          summary: "업그레이드 방: 진단 개선",
          status: "interrupted_by_restart",
          provider: "claudeAgent",
          model: "claude-opus-4-6",
          errorMessage: "서버 재시작으로 인해 실행이 중단되었습니다.",
          startedAtMs: 1_700_000_000_000,
          updatedAtMs: 1_700_000_010_000,
          finishedAtMs: 1_700_000_010_000,
        },
      ],
    };

    const html = renderToStaticMarkup(
      <ExecutionLedgerDiagnosticsCard summary={summary} isInitialLoading={false} />,
    );

    expect(html).toContain("9종 협업 통합 실행 원장");
    expect(html).toContain("다자간 위원회");
    expect(html).toContain("오케스트라");
    expect(html).toContain("회의 모드");
    expect(html).toContain("워크플로 v2");
    expect(html).toContain("하위 팀 위임");
    expect(html).toContain("하위 API");
    expect(html).toContain("업그레이드 방");
    expect(html).toContain("Claude 서브에이전트");
    expect(html).toContain("Codex 서브에이전트");
    expect(html).toContain("재시작 중단");
    expect(html).toContain("다자간 위원회 (3석): 아키텍처 검토");
  });

  it("renders empty state cleanly when summary has no runs", () => {
    const empty: ExecutionLedgerSummary = {
      totalRuns: 0,
      activeRuns: 0,
      byKind: ALL_EXECUTION_KINDS.map((executionKind) => ({
        executionKind,
        running: 0,
        completed: 0,
        failed: 0,
        cancelled: 0,
        interruptedByRestart: 0,
        total: 0,
      })),
      recentRuns: [],
    };

    const html = renderToStaticMarkup(
      <ExecutionLedgerDiagnosticsCard summary={empty} isInitialLoading={false} />,
    );

    expect(html).toContain("기록된 협업 실행 이력이 없습니다.");
  });
});
