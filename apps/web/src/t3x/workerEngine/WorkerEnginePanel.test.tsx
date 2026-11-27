import {
  ThreadId,
  type WorkerDecisionGateRecord,
  type WorkerStatusResult,
} from "@t3tools/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { ChatWorkerEngineToggle } from "../../components/chat/ChatHeader";
import { RightPanelTabs } from "../../components/RightPanelTabs";
import {
  ackWorkerDelivery,
  checkWorkerMailbox,
  discardWorkerWorktree,
  dispatchWorker,
  getWorkerStatus,
  getWorkerWorktreeDiff,
  listWorkerGates,
  mergeWorkerWorktree,
  resolveWorkerGate,
  stopWorkerDispatch,
} from "./workerEngineClient";
import { WorkerEnginePanel } from "./WorkerEnginePanel";

vi.mock("~/state/environments", () => ({
  usePrimaryEnvironmentId: () => null,
}));

vi.mock("~/state/server", () => ({
  primaryServerProvidersAtom: {
    _tag: "Atom",
  },
}));

vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => [],
}));

vi.mock("~/environments/primary/target", () => ({
  isDesktopDirectPrimary: () => false,
  resolvePrimaryEnvironmentHttpUrl: (pathname: string, search?: Record<string, string>) => {
    const query = search ? `?${new URLSearchParams(search).toString()}` : "";
    return `http://127.0.0.1:13773${pathname}${query}`;
  },
}));

vi.mock("~/environments/primary/desktopAuth", () => ({
  readDesktopPrimaryBearerToken: async () => "test-desktop-bearer",
}));

vi.mock("~/state/session", () => ({
  readPreparedConnection: () => null,
}));

function jsonResponse(result: unknown): Response {
  return new Response(JSON.stringify({ ok: true, result }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("WorkerEnginePanel & surface wiring", () => {
  it("renders WorkerEnginePanel shell with KPI strip, 4 orchestration tabs, scope toggle, and dispatch button", () => {
    const html = renderToStaticMarkup(
      createElement(WorkerEnginePanel, {
        mode: "panel",
        threadId: ThreadId.make("thread_1"),
        defaultCwd: "D:/repo",
      }),
    );

    expect(html).toContain("작업자 엔진");
    expect(html).toContain("현재 방");
    expect(html).toContain("전체");
    expect(html).toContain("작업자 파견");
    expect(html).toContain("실행 중");
    expect(html).toContain("승인 대기");
    expect(html).toContain("Worktree 검토");
    expect(html).toContain("미확인 메일");
    expect(html).toContain('role="tablist"');
    expect(html).toContain("작업자");
    expect(html).toContain("메일박스");
    expect(html).toContain("승인 게이트");
    expect(html).toContain("Worktree");
  });

  it("renders diagnostics mode cleanly without thread-only scope switcher", () => {
    const html = renderToStaticMarkup(
      createElement(WorkerEnginePanel, {
        mode: "diagnostics",
      }),
    );

    expect(html).toContain("작업자 엔진");
    expect(html).toContain("전체");
    expect(html).not.toContain("현재 방");
  });

  it("renders ChatWorkerEngineToggle with attention/active indicator states", () => {
    const attentionHtml = renderToStaticMarkup(
      createElement(ChatWorkerEngineToggle, {
        open: false,
        activeCount: 2,
        attentionCount: 1,
        unreadCount: 3,
        onToggle: vi.fn(),
      }),
    );
    expect(attentionHtml).toContain('aria-label="작업자 엔진"');
    expect(attentionHtml).toContain('aria-pressed="false"');
    expect(attentionHtml).toContain("bg-warning");
    expect(attentionHtml).toContain("실행 2 · 확인 필요 1 · 메일 3");

    const openHtml = renderToStaticMarkup(
      createElement(ChatWorkerEngineToggle, {
        open: true,
        activeCount: 0,
        attentionCount: 0,
        unreadCount: 0,
        onToggle: vi.fn(),
      }),
    );
    expect(openHtml).toContain('aria-pressed="true"');
    expect(openHtml).toContain("작업자 엔진 닫기");
  });

  it("exposes 작업자 엔진 surface in RightPanelTabs tab bar and empty state", () => {
    const emptyHtml = renderToStaticMarkup(
      createElement(RightPanelTabs, {
        mode: "inline",
        surfaces: [],
        activeSurfaceId: null,
        pendingSurfaceIds: new Set<string>(),
        terminalLabelsById: new Map<string, string>(),
        previewSessions: {},
        onActivate: vi.fn(),
        onCloseSurface: vi.fn(),
        onCloseOtherSurfaces: vi.fn(),
        onCloseSurfacesToRight: vi.fn(),
        onCloseAllSurfaces: vi.fn(),
        onCopyFilePath: vi.fn(),
        onAddBrowser: vi.fn(),
        onAddTerminal: vi.fn(),
        onAddDiff: vi.fn(),
        onAddFiles: vi.fn(),
        onAddAgents: vi.fn(),
        onAddWorkers: vi.fn(),
        browserAvailable: false,
        diffAvailable: true,
        filesAvailable: true,
        children: null,
      }),
    );
    expect(emptyHtml).toContain("작업자 엔진");
    expect(emptyHtml).toContain("Worktree Diff");

    const activeTabHtml = renderToStaticMarkup(
      createElement(RightPanelTabs, {
        mode: "inline",
        surfaces: [{ id: "workers", kind: "workers" }],
        activeSurfaceId: "workers",
        pendingSurfaceIds: new Set<string>(["workers"]),
        terminalLabelsById: new Map<string, string>(),
        previewSessions: {},
        onActivate: vi.fn(),
        onCloseSurface: vi.fn(),
        onCloseOtherSurfaces: vi.fn(),
        onCloseSurfacesToRight: vi.fn(),
        onCloseAllSurfaces: vi.fn(),
        onCopyFilePath: vi.fn(),
        onAddBrowser: vi.fn(),
        onAddTerminal: vi.fn(),
        onAddDiff: vi.fn(),
        onAddFiles: vi.fn(),
        onAddAgents: vi.fn(),
        onAddWorkers: vi.fn(),
        browserAvailable: false,
        diffAvailable: true,
        filesAvailable: true,
        children: "worker-body",
      }),
    );
    expect(activeTabHtml).toContain("작업자 엔진");
    expect(activeTabHtml).toContain("worker-body");
  });

  it("calls all WorkerEngine HTTP endpoints with desktop bearer auth and expected payloads", async () => {
    const calls: Array<{
      url: string;
      method: string;
      authorization: string | null;
      body?: unknown;
    }> = [];

    const fetchMock: typeof globalThis.fetch = async (input, init) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";
      const headers = new Headers(init?.headers);
      const body =
        typeof init?.body === "string" && init.body.length > 0 ? JSON.parse(init.body) : undefined;
      calls.push({ url, method, authorization: headers.get("authorization"), body });

      if (url.includes("/status")) {
        const result: WorkerStatusResult = {
          tasks: [],
          activeDispatches: [],
          openGates: [],
          unreadMailboxCount: 0,
        };
        return jsonResponse(result);
      }
      if (url.includes("/dispatch")) {
        return jsonResponse({
          taskId: "task_1",
          dispatchId: "disp_1",
          runId: "run_1",
          fencingToken: 1,
          deduplicated: false,
          reusedIdempotency: false,
          status: "dispatched",
          dispatchStatus: "running",
          worktreeMode: "isolated",
          worktreePath: "D:/repo/.wt",
          worktreeBranch: "t3code/worker-task_1",
          worktreeState: "active",
        });
      }
      if (url.includes("/check")) {
        return jsonResponse({
          deliveryId: "del_1",
          replayed: false,
          messages: [],
          hasMore: false,
          activeDispatches: [],
          clampedTimeoutSec: 60,
        });
      }
      if (url.includes("/ack")) {
        return jsonResponse({
          deliveryId: "del_1",
          acknowledged: true,
          acknowledgedMessageCount: 1,
        });
      }
      if (url.includes("/stop")) {
        return jsonResponse({
          dispatchId: "disp_1",
          taskId: "task_1",
          stopped: true,
          status: "cancelled",
        });
      }
      if (url.includes("/gates/resolve")) {
        const gate: WorkerDecisionGateRecord = {
          gateId: "gate_1",
          taskId: "task_1",
          dispatchId: "disp_1",
          threadId: "thread_1",
          riskLevel: "high",
          question: "진행할까요?",
          options: ["approve", "deny"],
          status: "approved",
          resolution: "확인됨",
          resolvedBy: "user:ui",
          createdAtMs: 1_000,
          resolvedAtMs: 2_000,
        };
        return jsonResponse({ gate });
      }
      if (url.includes("/gates")) {
        return jsonResponse({ gates: [] });
      }
      if (url.includes("/worktree/diff")) {
        return jsonResponse({
          taskId: "task_1",
          worktreePath: "D:/repo/.wt",
          worktreeBranch: "t3code/worker-task_1",
          worktreeBaseRef: "main",
          worktreeState: "review_ready",
          statusShort: "M a.ts",
          diffStat: " a.ts | 1 +",
          diffPatch: "+hello",
          filesModified: ["a.ts"],
        });
      }
      if (url.includes("/worktree/merge")) {
        return jsonResponse({
          taskId: "task_1",
          action: "merge",
          worktreeState: "merged",
          mergedCommit: "abc123",
          message: "merged",
        });
      }
      if (url.includes("/worktree/discard")) {
        return jsonResponse({
          taskId: "task_1",
          action: "discard",
          worktreeState: "discarded",
          message: "discarded",
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const ctx = { fetchFn: fetchMock };
    await getWorkerStatus({ threadId: "thread_1" }, ctx);
    await dispatchWorker(
      {
        threadId: "thread_1",
        role: "coder",
        targetInstanceId: "codex",
        specText: "test",
        cwd: "D:/repo",
        worktreeMode: "isolated",
      },
      ctx,
    );
    await checkWorkerMailbox({ threadId: "thread_1", peek: true }, ctx);
    await ackWorkerDelivery({ deliveryId: "del_1" }, ctx);
    await stopWorkerDispatch({ dispatchId: "disp_1", reason: "stop" }, ctx);
    await listWorkerGates({ threadId: "thread_1" }, ctx);
    await resolveWorkerGate(
      { gateId: "gate_1", decision: "approve", resolution: "확인됨", resolvedBy: "user:ui" },
      ctx,
    );
    await getWorkerWorktreeDiff("task_1", ctx);
    await mergeWorkerWorktree("task_1", ctx);
    await discardWorkerWorktree("task_1", ctx);

    expect(calls).toHaveLength(10);
    expect(calls.every((call) => call.authorization === "Bearer test-desktop-bearer")).toBe(true);
    expect(calls[0]?.url).toBe("http://127.0.0.1:13773/api/worker-engine/status?threadId=thread_1");
    expect(calls[7]?.url).toBe(
      "http://127.0.0.1:13773/api/worker-engine/worktree/diff?taskId=task_1",
    );
    expect(calls[8]?.body).toEqual({ taskId: "task_1" });
    expect(calls[9]?.body).toEqual({ taskId: "task_1" });
  });
});
