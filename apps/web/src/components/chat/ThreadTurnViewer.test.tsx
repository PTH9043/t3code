import {
  ApprovalRequestId,
  CheckpointRef,
  EnvironmentId,
  EventId,
  MessageId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  WorkspaceOrchestraBlock,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { deriveAgentPanelModel } from "@t3tools/client-runtime/state/subagentRuntime";
import { orchestraBlocksByMessage } from "@t3tools/client-runtime/state/presentation";
import * as Schema from "effect/Schema";
import { type ComponentProps, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vite-plus/test";
import { selectActiveRightPanel, useRightPanelStore } from "../../rightPanelStore";
import { AgentsPanel } from "../AgentsPanel";
import { ThreadTurnViewer } from "./ThreadTurnViewer";
import { deriveThreadTimelineWork } from "./threadTimelineWork";

vi.mock("~/components/ui/scroll-area", () => ({
  ScrollArea: ({ children }: { children: ReactNode }) => children,
}));

const now = "2026-01-01T12:00:00Z";
const id = ThreadId.make("room"),
  current = TurnId.make("current"),
  old = TurnId.make("old");
const next = { instanceId: ProviderInstanceId.make("answering-account"), model: "next-model" };
const base: ComponentProps<typeof ThreadTurnViewer> = {
  thread: {
    id,
    latestTurn: {
      turnId: current,
      state: "completed",
      requestedAt: now,
      startedAt: now,
      completedAt: now,
      assistantMessageId: MessageId.make("answer"),
    },
    session: null,
    activities: [],
    messages: [],
  },
  nextModel: next,
  checkpoints: [],
  blocks: new Map(),
  workLog: [],
  pendingApprovals: [],
};
const event = (
  kind: string,
  payload: unknown,
  turnId: TurnId | null,
  summary = kind,
): OrchestrationThreadActivity => ({
  id: EventId.make(summary),
  kind,
  payload,
  turnId,
  summary,
  tone: "info",
  createdAt: now,
});
const render = (props: Partial<typeof base>) =>
  renderToStaticMarkup(<ThreadTurnViewer {...base} {...props} />);
const message = (key: string, text: string) => ({
  id: MessageId.make(key),
  role: "assistant" as const,
  text,
  turnId: current,
  streaming: false,
  createdAt: now,
  updatedAt: now,
});

it("separates this turn's provider-reported model from next-turn selection, stale usage, and request-side accounting", () => {
  const usage = (provider: string, model: string, turn: TurnId) =>
    event("context-window.updated", { consumption: [{ provider, model }] }, turn);
  const activities = [
    usage("opencode", "stale-model", old),
    usage("cursor", "requested-only", current),
    usage("grok", "observed-model", current),
  ];
  const html = render({ thread: { ...base.thread, activities } });
  expect(html).toContain("observed-model");
  expect(html).toContain("answering-account · next-model");
  expect(html).not.toContain("stale-model");
  expect(html).not.toContain("requested-only");
  expect(render({})).toContain("제공자 보고 없음");
});

it("shows the latest handoff outcome and distinguishes provider acceptance from historical preparation", () => {
  const unavailable = event(
    "conversation.handoff.unavailable",
    { reason: "prepare" },
    null,
    "인계 준비 실패",
  );
  const report = {
    version: 1,
    status: "fallback",
    reason: "insufficient-savings",
    originalChars: 42,
    sentChars: 42,
    savedChars: 0,
    sourceHash: null,
    sourceMessageCount: 2,
  };
  const prepared = event("conversation.handoff.prepared", report, null, "기존 인계 유지");
  const view = (...activities: (typeof base.thread.activities)[number][]) =>
    render({ thread: { ...base.thread, activities } });
  expect(view(prepared)).toContain("준비한 문맥 42자");
  const delivered = event(
    "conversation.handoff.delivered",
    {
      backend: "workspace-memory",
      requestedMode: "standard",
      chars: 51,
    },
    current,
    "인계 문맥을 포함한 요청을 모델 제공자가 접수했습니다.",
  );
  const html = view(prepared, unavailable, delivered);
  expect(html).toContain("작업공간 기억");
  expect(html).toContain("접수된 인계 문맥 51자");
  expect(html).not.toContain("인계 준비 실패");
  expect(view(delivered, unavailable)).toContain("인계 준비 실패");
  for (const [archiveAttached, label] of [
    [true, "원문 스냅샷 포함"],
    [false, "원문 스냅샷 없이 발췌본 전달"],
  ] as const) {
    expect(
      view(
        event(
          "conversation.handoff.delivered",
          {
            backend: "workspace-memory",
            requestedMode: "compact",
            archiveAttached,
            chars: 51,
          },
          current,
        ),
      ),
    ).toContain(label);
  }
  const fallback = event(
    "conversation.handoff.delivered",
    {
      backend: "projection",
      requestedMode: "compact",
      chars: 44,
      compactReport: report,
    },
    current,
  );
  expect(view(fallback)).toContain("대화 기록 · 기본 인계로 대체");
  expect(view(fallback)).toContain("접수된 인계 문맥 44자");
});

it("shows the confirmed assignment with or without a provider report, independently of the next selection", () => {
  const assignment = event(
    "conversation.turn-assigned",
    { instanceId: "current-account", model: "assigned-model" },
    current,
  );
  const report = event(
    "context-window.updated",
    { consumption: [{ provider: "grok", model: "reported-model" }] },
    current,
  );
  for (const activities of [[assignment], [assignment, report]]) {
    const html = render({ thread: { ...base.thread, activities } });
    expect(html).toContain(
      "<dt>이번 요청에 지정한 모델</dt><dd>current-account · assigned-model</dd>",
    );
    expect(html).toContain("<dt>다음 턴 선택</dt><dd>answering-account · next-model</dd>");
    expect(html).toContain(
      activities.includes(report)
        ? "<dt>실행 모델</dt><dd>reported-model</dd>"
        : "<dt>실행 모델</dt><dd>제공자 보고 없음</dd>",
    );
  }
});

it("leaves the assignment unknown for old turns, unscoped events, worker activity and incomplete payloads", () => {
  const selection = { instanceId: "other-account", model: "other-model" };
  const activities = [
    event("conversation.turn-assigned", selection, old),
    event("conversation.turn-assigned", selection, null),
    event("task.started", selection, current),
    event("conversation.turn-assigned", { model: "unattributed" }, current),
    event("conversation.turn-assigned", { ...selection, executionId: "worker" }, current),
    event(
      "context-window.updated",
      { messageId: "worker", consumption: [{ provider: "opencode", model: "child-report" }] },
      current,
    ),
  ];
  for (const evidence of [[], activities]) {
    const html = render({ thread: { ...base.thread, activities: evidence } });
    expect(html).toContain("<dt>이번 요청에 지정한 모델</dt><dd>지정 기록 없음</dd>");
    expect(html).not.toContain("child-report");
  }
});

it("shows this turn's recorded tool, test command, changes, approval and result while omitting child and older turn tools", () => {
  const activities = [
    event(
      "tool.started",
      {
        itemId: "test",
        reportedModel: "tester",
        data: { toolName: "Bash", input: { command: "node --test" } },
      },
      current,
      "Starting shell",
    ),
    event(
      "tool.completed",
      {
        itemId: "test",
        reportedModel: "tester",
        status: "failed",
        data: { toolName: "Bash", input: { command: "node --test" } },
      },
      current,
      "Command run",
    ),
    event(
      "tool.started",
      { agentId: "child", reportedModel: "child-model" },
      current,
      "Child tool",
    ),
    event("tool.started", { reportedModel: "older-model" }, old, "Earlier unrelated test"),
  ];
  const html = render({
    thread: {
      ...base.thread,
      activities,
      messages: [message("answer", "Final verification report")],
    },
    pendingApprovals: [
      {
        requestId: ApprovalRequestId.make("request"),
        createdAt: now,
        requestKind: "command",
        detail: "Waiting for permission",
      },
    ],
    workLog: deriveThreadTimelineWork(activities),
    checkpoints: [
      {
        turnId: current,
        checkpointTurnCount: 1,
        checkpointRef: CheckpointRef.make("fixture"),
        status: "ready",
        files: [{ path: "app/feature.ts", kind: "modified", additions: 1, deletions: 0 }],
        assistantMessageId: null,
        completedAt: now,
      },
    ],
    onOpenTurnDiff: vi.fn(),
  });
  for (const text of [
    "tester",
    "테스트",
    "차이 보기",
    "실패",
    "app/feature.ts",
    "Waiting for permission",
    "Final verification report",
  ])
    expect(html).toContain(text);
  expect(html).not.toContain("Earlier unrelated test");
  expect(html).not.toContain("child-model");
  expect(html).not.toContain("older-model");
  expect(html).not.toContain("Command run");
  expect(html).not.toContain("node --test");
});

it("keeps a delegate assignment and its returned report separate from the main turn", () => {
  const block = Schema.decodeUnknownSync(WorkspaceOrchestraBlock)({
    executionId: "execution",
    ownerThreadId: id,
    runId: "run",
    nodeId: "delegate-advisor",
    attempt: 1,
    messageId: "delegate",
    title: "Review",
    instruction: "Check the patch",
    displayName: "Advisor",
    role: "reviewer",
    kind: "validation",
    modelSelection: next,
    status: "completed",
  });
  const blocks = orchestraBlocksByMessage([event("orchestra.block", block, null)]);
  const html = render({
    blocks,
    thread: {
      ...base.thread,
      messages: [message("answer", "Main answer"), message("delegate", "Review report")],
      activities: [
        event(
          "conversation.handoff.unavailable",
          { reason: "folder" },
          null,
          "Folder handoff unavailable",
        ),
      ],
    },
  });
  for (const text of [
    "Main answer",
    "Check the patch",
    "Review report",
    "Advisor",
    "Folder handoff unavailable",
    "제공자 보고 없음",
  ])
    expect(html).toContain(text);
  expect(html.match(/Review report/g)).toHaveLength(1);
});

it("keeps handoff visible in an existing conversation with messages and no receipt", () => {
  const html = render({
    thread: { ...base.thread, messages: [message("answer", "Saved answer")] },
  });
  expect(html).toContain("Saved answer");
  expect(html).toContain('<section aria-label="최근 대화 인계">');
  expect(html).toContain("아직 표시할 인계 기록이 없습니다");
  expect(html.indexOf('aria-label="최근 대화 인계"')).toBeLessThan(html.indexOf("Saved answer"));
  expect(html).not.toContain("첫 요청 대기");
});

it("shows pre-send selection in a draft and distinguishes an unloaded saved conversation", () => {
  const thread = { ...base.thread, latestTurn: null };
  const draft = renderToStaticMarkup(
    <ThreadTurnViewer {...base} thread={thread} historyState="draft" onEditTeam={() => {}} />,
  );
  expect(draft).toContain("첫 요청 대기");
  expect(draft).toContain("next-model");
  expect(draft).toContain("첫 요청을 보내기 전에 대화 상단에서 하위 모델 팀을 설정");
  expect(draft).toContain("상단 하위 모델 편집");
  const loading = render({ thread, historyState: "loading" });
  expect(loading).toContain("저장된 대화 기록을 불러오는 중");
  expect(loading).not.toContain("아직 표시할 인계 기록이 없습니다");
});

it("links to the top team editor even with an empty native worker roster", () => {
  const html = renderToStaticMarkup(
    <AgentsPanel model={deriveAgentPanelModel({ agents: [] })}>
      <ThreadTurnViewer {...base} onEditTeam={() => {}} />
    </AgentsPanel>,
  );
  expect(html).toContain("최근 턴");
  expect(html.match(/상단 하위 모델 편집/g)).toHaveLength(1);
  expect(html).toContain("기록된 하위 에이전트가 없습니다");
  expect(render({ nextModel: null })).not.toContain("상단 하위 모델 편집");
});

it("drops the previous turn's evidence as soon as a new running turn is observed", () => {
  const html = render({
    thread: {
      ...base.thread,
      session: {
        threadId: id,
        status: "running",
        activeTurnId: TurnId.make("new-turn"),
        providerName: "codex",
        runtimeMode: "full-access",
        lastError: null,
        updatedAt: now,
      },
      messages: [message("answer", "Old result")],
      activities: [
        event(
          "context-window.updated",
          { consumption: [{ provider: "grok", model: "old-reported" }] },
          current,
        ),
      ],
    },
  });
  expect(html).toContain("실행 중");
  expect(html).not.toContain("Old result");
  expect(html).not.toContain("old-reported");
});

it("toggles the singleton Viewer independently for the same thread ID on different environments", () => {
  const a = scopeThreadRef(EnvironmentId.make("first"), id),
    b = scopeThreadRef(EnvironmentId.make("second"), id);
  const store = useRightPanelStore;
  store.setState({ byThreadKey: {} });
  try {
    store.getState().toggle(a, "agents");
    store.getState().open(b, "diff");
    store.getState().toggle(b, "agents");
    store.getState().toggle(a, "agents");
    expect(selectActiveRightPanel(store.getState().byThreadKey, a)).toBeNull();
    expect(selectActiveRightPanel(store.getState().byThreadKey, b)).toBe("agents");
    const otherRoom = scopeThreadRef(a.environmentId, ThreadId.make("draft-preview"));
    store.getState().toggle(otherRoom, "agents");
    expect(selectActiveRightPanel(store.getState().byThreadKey, a)).toBeNull();
    store.getState().toggleVisibility(a);
    expect(selectActiveRightPanel(store.getState().byThreadKey, a)).toBe("agents");
    store.getState().activateSurface(b, "diff");
    expect(selectActiveRightPanel(store.getState().byThreadKey, b)).toBe("diff");
    expect(selectActiveRightPanel(store.getState().byThreadKey, otherRoom)).toBe("agents");
  } finally {
    store.setState({ byThreadKey: {} });
  }
});
