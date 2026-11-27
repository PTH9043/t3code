import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  EventId,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
  type OrchestrationThreadShell,
  type ServerConfig,
  type ThreadSubordinateTeamUpdate,
  type ThreadTeamMember,
} from "@t3tools/contracts";
import { beforeEach, expect, it, vi } from "vite-plus/test";
import { reactHookHarness as hooks } from "../../../../web/src/test/reactHookHarness";
import { visitElements } from "../../../../web/src/test/reactElementTree";
import {
  confirmsRoomTeam,
  readRoomTeam,
  turnEvidence,
  recordedAgents,
} from "./ThreadTeamViewer.logic";

const mocks = vi.hoisted(() => ({ update: vi.fn() }));
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  const { reactHookHarness: h } = await import("../../../../web/src/test/reactHookHarness");
  return {
    ...actual,
    useState: h.useState,
    useEffect: () => {},
    useMemo: h.useMemo,
    useRef: h.useRef,
  };
});
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness: h } = await import("../../../../web/src/test/reactHookHarness");
  return { c: h.useMemoCache };
});
vi.mock("react-native", () => ({
  Modal: "Modal",
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  TextInput: "TextInput",
  View: "View",
}));
vi.mock("./MobileToolActivity", () => ({
  MobileToolActivityProvider: "SummaryProvider",
  MobileToolActivityDetail: "ActivityDetail",
}));
vi.mock("react-native-safe-area-context", () => ({ SafeAreaView: "SafeAreaView" }));
vi.mock("../../components/AppText", () => ({ AppText: "Text" }));
vi.mock("../../components/ControlPill", () => ({ ControlPillMenu: "Menu" }));
vi.mock("../../components/StatusPill", () => ({ StatusPill: "Status" }));
vi.mock("./git/gitSheetComponents", () => ({ SheetActionButton: "Button" }));
vi.mock("../../state/server", () => ({ serverEnvironment: { updateSettings: "update" } }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => mocks.update }));
import { ThreadTeamViewer } from "./ThreadTeamViewer";

const environmentId = EnvironmentId.make("env");
const threadId = ThreadId.make("room-a");
const account = ProviderInstanceId.make("answer");
const worker = ProviderInstanceId.make("worker");
const scope = { threadId, answeringInstanceId: account, forModel: "next" };
const current = TurnId.make("turn-1");
const thread = {
  id: threadId,
  modelSelection: { instanceId: account, model: "next" },
  session: { activeTurnId: current, status: "running", providerInstanceId: account },
  latestTurn: { turnId: current, state: "running" },
} as OrchestrationThreadShell;
const member: ThreadTeamMember = { instanceId: worker, model: "custom-worker", role: "scout" };
const provider = {
  driver: "codex",
  instanceId: worker,
  displayName: "Worker account",
  enabled: true,
  installed: true,
  auth: { status: "authenticated" },
  models: [{ slug: member.model, name: "Custom worker", isCustom: true, capabilities: null }],
};
const defaults = [
  { ...member, answeringInstanceId: account },
  { ...member, answeringInstanceId: account, forModel: "another", model: "another" },
];
const config = (teams: ThreadSubordinateTeamUpdate[] = []) =>
  ({
    providers: [provider, { ...provider, instanceId: "off", enabled: false }],
    settings: {
      globalSubordinateTeam: [member],
      threadSubordinateTeams: Object.fromEntries(teams.map((row) => [row.threadId, row.members])),
      subordinateModels: defaults,
    },
  }) as unknown as ServerConfig;
function activity(
  id: string,
  kind: string,
  payload: unknown,
  turnId: TurnId | null = current,
): OrchestrationThreadActivity {
  return {
    id: EventId.make(id),
    createdAt: "2026-09-01T00:00:00Z",
    turnId,
    kind,
    payload,
    summary: id,
    tone: "info",
  };
}
function detail(activities: OrchestrationThreadActivity[]) {
  return { ...thread, activities, checkpoints: [], messages: [] } as unknown as OrchestrationThread;
}

it("uses call identities in the saved mobile Viewer and keeps unknown intermediate records inside a single closed-turn section", () => {
  const signals = Array.from({ length: 16 }, (_, i) =>
    activity("start" + i, "tool.started", { itemType: "command_execution" }),
  );
  const calls = ["first", "second"].flatMap((id) =>
    ["tool.updated", "tool.completed"].map((kind) =>
      activity(kind + id, kind, {
        reportedModel: "actual-mobile-worker",
        data: {
          toolName: "Bash",
          input: { command: "git log --oneline" },
          result: { type: "tool_result", tool_use_id: id, is_error: false },
        },
      }),
    ),
  );
  const history = detail([...signals, ...calls]);
  const closed = {
    ...history,
    session: null,
    latestTurn: { ...history.latestTurn!, state: "interrupted" as const },
  };
  const actions = turnEvidence(
    { ...thread, session: null, latestTurn: closed.latestTurn },
    closed,
  )!.actions;
  expect(actions.filter((a) => a.presented?.unlinkedToolSignals)).toHaveLength(1);
  expect(
    actions
      .filter((a) => a.presented?.toolActivity)
      .map((a) => a.presented!.toolActivity!.events.length),
  ).toEqual([2, 2]);
  expect(actions.map((a) => a.title).join(" ")).toContain("actual-mobile-worker");
  expect(
    turnEvidence(thread, history)!.actions.filter((a) => a.presented?.toolActivity),
  ).toHaveLength(18);
});
function render(serverConfig = config(), connected = true, threadDetail = detail([])) {
  hooks.beginRender();
  return ThreadTeamViewer({
    environmentId,
    thread,
    detail: threadDetail,
    serverConfig,
    connected,
    live: connected,
    onClose: vi.fn(),
  });
}
const element = (tree: unknown, label: string) =>
  visitElements(
    tree,
    (e) =>
      e.props.accessibilityLabel === label ||
      e.props.label === label ||
      e.props.title === label ||
      e.props.children === label,
  );
function press(tree: unknown, label: string) {
  const hit = element(tree, label);
  expect(hit).toBeTruthy();
  const button = hit?.props.onPress
    ? hit
    : visitElements(tree, (e) => Boolean(e.props.onPress) && !!element(e.props.children, label));
  return (button!.props.onPress as () => void)();
}
beforeEach(() => {
  hooks.reset();
  mocks.update.mockReset();
});

it("opens the grouped work detail from the saved-room mobile Viewer", () => {
  const payload = {
    itemType: "command_execution",
    toolCallId: "same",
    reportedModel: "worker",
    data: { toolName: "Bash", input: { command: "node --test" } },
  };
  const history = detail([
    activity("one", "tool.updated", payload),
    activity("two", "tool.completed", payload),
  ]);
  const title = turnEvidence(thread, history)!.actions[0]!.title;
  expect(title).toContain("테스트");
  const show = () => render(config(), true, history);
  const detailRow = (tree: unknown) =>
    visitElements(tree, (e) => String(e.type) === "ActivityDetail");
  expect(detailRow(show())).toBeNull();
  press(show(), title);
  expect(detailRow(show())?.props.row).toMatchObject({
    toolActivity: { callId: "same", eventIds: ["one", "two"] },
  });
  press(show(), title);
  expect(detailRow(show())).toBeNull();
});

it("keeps the turn receipt, provider usage and next selection independent after a model switch", () => {
  const observation = {
    sourceId: "native",
    mode: "execution-total",
    provider: "grok",
    model: "reported",
    counts: {
      total: 1,
      input: null,
      output: null,
      cacheRead: null,
      cacheWrite: null,
      reasoning: null,
    },
  };
  const evidence = turnEvidence(
    thread,
    detail([
      activity("assigned", "conversation.turn-assigned", {
        instanceId: "old-account",
        model: "assigned",
      }),
      activity(
        "other",
        "conversation.turn-assigned",
        { instanceId: "other", model: "wrong" },
        TurnId.make("other"),
      ),
      activity(
        "unlinked",
        "conversation.turn-assigned",
        { instanceId: "wrong", model: "wrong" },
        null,
      ),
      activity("child", "conversation.turn-assigned", {
        instanceId: "wrong",
        model: "wrong",
        executionId: "child",
      }),
      activity("usage", "context-window.updated", { consumption: [observation] }),
      activity("child-assignment", "conversation.turn-assigned", {
        instanceId: "child-account",
        model: "child-only",
        taskId: "task",
      }),
      activity("child-message", "context-window.updated", {
        messageId: "child-message",
        consumption: [{ ...observation, model: "another-child" }],
      }),
      activity("child-usage", "context-window.updated", {
        executionId: "child",
        consumption: [{ ...observation, model: "child-model" }],
      }),
      activity("fallback", "context-window.updated", {
        consumption: [{ ...observation, provider: "claude", model: "requested-only" }],
      }),
      activity("test command", "tool.started", {
        itemType: "command_execution",
        data: { command: "node --test" },
      }),
      activity("approval", "approval.requested", {
        requestKind: "command",
        requestId: "approve",
        detail: "confirm command",
      }),
      activity("handoff unavailable", "conversation.handoff.unavailable", {}, null),
    ]),
  );
  expect(evidence?.assigned).toEqual({ instanceId: "old-account", model: "assigned" });
  expect(evidence?.models).toEqual(["grok · reported"]);
  expect(
    evidence?.actions.some((action) => action.presented?.toolActivity?.subject === "test"),
  ).toBe(true);
  expect(evidence?.approvals[0]?.detail).toBe("confirm command");
  expect(evidence?.handoff?.text).toBe("handoff unavailable");
  expect(thread.modelSelection.model).toBe("next");
  expect(turnEvidence(thread, detail([]))?.assigned).toBeNull();
  expect(turnEvidence(thread, detail([]))?.models).toEqual([]);
  expect(turnEvidence(thread, { ...detail([]), id: ThreadId.make("different") })).toBeNull();
});

it("shows the assigned model even when the provider has no model report", () => {
  const tree = render(
    config(),
    true,
    detail([
      activity("assignment", "conversation.turn-assigned", {
        instanceId: "old-account",
        model: "assigned",
      }),
    ]),
  );
  for (const row of [
    "이번 요청에 지정한 모델 · old-account · assigned",
    "제공자 보고 모델 · 보고 없음",
    "답변 모델 · answer · next",
  ]) {
    expect(
      visitElements(
        tree,
        (e) =>
          Array.isArray(e.props.children) &&
          e.props.children.every((c: unknown) => typeof c === "string") &&
          e.props.children.join("") === row,
      ),
    ).toBeTruthy();
  }
});

it("shows the latest handoff delivery or failure in event order", () => {
  const failure = activity("인계 준비 실패", "conversation.handoff.unavailable", {}, null);
  const delivered = activity("제공자 접수", "conversation.handoff.delivered", {
    backend: "workspace-memory",
    requestedMode: "compact",
    chars: 51,
    archiveAttached: false,
  });
  function handoffLine(activities: OrchestrationThreadActivity[]) {
    const row = visitElements(
      render(config(), true, detail(activities)),
      (e) =>
        Array.isArray(e.props.children) &&
        typeof e.props.children[0] === "string" &&
        e.props.children[0].startsWith("최근 인계"),
    );
    return (row?.props.children as string[] | undefined)?.join("");
  }
  const received = handoffLine([failure, delivered]);
  expect(received).toContain(
    "제공자 접수 · 작업공간 기억 · 원문 스냅샷 없이 발췌본 전달 · 접수된 인계 문맥 51자",
  );
  expect(received).not.toContain("인계 준비 실패");
  expect(received).not.toContain("이전 메시지");
  expect(handoffLine([delivered, failure])).toContain("인계 준비 실패");
});

it("uses native agent lifecycle records, including terminal updates", () => {
  const start = activity("start", "task.started", {
    taskId: "child",
    agentKind: "agent",
    title: "Scout",
    role: "scout",
    model: "observed-child",
  });
  const end = activity("finish", "task.completed", {
    taskId: "child",
    agentKind: "agent",
    status: "completed",
  });
  expect(recordedAgents(thread, [start])[0]).toMatchObject({ active: true, title: "Scout" });
  expect(recordedAgents(thread, [start, end])[0]).toMatchObject({ active: false });
});

it("labels the recorded task account and model as an assignment in the mobile team viewer", () => {
  const block = activity(
    "block",
    "orchestra.block",
    {
      executionId: "child",
      messageId: "child-result",
      attempt: 1,
      ownerThreadId: thread.id,
      runId: "run",
      nodeId: "researcher",
      title: "자료 확인",
      displayName: "조사 담당",
      role: "researcher",
      kind: "research",
      modelSelection: { instanceId: worker, model: "DeepSeek" },
      status: "completed",
    },
    null,
  );
  expect(recordedAgents(thread, [block])[0]?.detail).toBe(
    "배정 모델 · worker · DeepSeek · 자료 확인",
  );
});

it("reads the explicit thread team and requires its own acknowledgement even when the global roster matches", () => {
  const other = ThreadId.make("other");
  const settings = {
    globalSubordinateTeam: [member],
    threadSubordinateTeams: { [threadId]: [], [other]: null },
    threadModelTeams: [{ ...scope, members: [member] }],
  };
  expect(readRoomTeam(settings, threadId)).toEqual([]);
  expect(readRoomTeam(settings, other)).toBeNull();
  expect(confirmsRoomTeam(settings, { threadId, members: [] })).toBe(true);
  expect(confirmsRoomTeam(settings, { threadId: other, members: [member] })).toBe(false);
  expect(confirmsRoomTeam(settings, { threadId: ThreadId.make("missing"), members: null })).toBe(
    false,
  );
});

it("shows the global team until the conversation saves its own, with every role offered", () => {
  const show = () => render(config());
  expect(element(show(), "전역 스타일 사용 중")).toBeFalsy();
  expect(JSON.stringify(show())).toContain("전역 팀 사용 중");
  press(show(), "하위 AI 설정");
  for (const label of ["작업", "검토", "조사", "설계", "검증", "문서화"])
    expect(element(show(), "1번 " + label)).toBeTruthy();
  expect(element(show(), "이 대화의 팀 저장")!.props.disabled).toBe(true);
  expect(JSON.stringify(render(config([{ threadId, members: [] }])))).toContain("이 대화의 팀");
  const roomStyle = visitElements(
    show(),
    (e) => typeof e.type === "function" && e.type.name === "ThreadResponseStyleSettings",
  );
  expect(roomStyle?.props).toMatchObject({ environmentId, threadId });
});

it("edits through the catalogue, writes one scoped patch, preserves other settings and trims instructions", async () => {
  const base = config([{ ...scope, members: [] }]);
  const show = () => render(base);
  press(show(), "하위 AI 설정");
  const menu = element(show(), "하위 모델 추가")!;
  expect(JSON.stringify(menu.props.actions)).toContain("custom-worker");
  expect(JSON.stringify(menu.props.actions)).not.toContain("model:off:");
  (menu.props.onPressAction as (e: unknown) => void)({
    nativeEvent: { event: "model:worker:custom-worker" },
  });
  press(show(), "1번 검토");
  (element(show(), "1번 하위 모델 지시")!.props.onChangeText as (s: string) => void)(
    " review only ",
  );
  const next: ThreadTeamMember = { ...member, role: "advisor", instructions: "review only" };
  mocks.update.mockResolvedValue({
    _tag: "Success",
    value: config([{ ...scope, members: [next] }]).settings,
  });
  press(show(), "이 대화의 팀 저장");
  await Promise.resolve();
  expect(mocks.update).toHaveBeenCalledWith({
    environmentId,
    input: { patch: { threadSubordinateTeamUpdate: { threadId, members: [next] } } },
  });
  expect(element(show(), "다음 요청에 적용할 팀을 저장했습니다.")).toBeTruthy();
});

it("edits an unsent team locally with the same roles, explicit empty and a return to the global team", async () => {
  let stored: readonly ThreadTeamMember[] | null = [];
  const save = vi.fn(async (members: readonly ThreadTeamMember[] | null) => {
    stored = members;
  });
  const show = () => {
    hooks.beginRender();
    return ThreadTeamViewer({
      selection: thread.modelSelection,
      members: stored,
      serverConfig: config(),
      onSaveDraft: save,
      onClose: vi.fn(),
    });
  };
  expect(element(show(), "현재 실행")).toBeFalsy();
  const menu = element(show(), "하위 모델 추가")!;
  (menu.props.onPressAction as (e: unknown) => void)({
    nativeEvent: { event: "model:worker:custom-worker" },
  });
  press(show(), "1번 조사");
  (element(show(), "1번 하위 모델 지시")!.props.onChangeText as (s: string) => void)(" inspect ");
  press(show(), "초안에 팀 저장");
  await Promise.resolve();
  expect(save).toHaveBeenLastCalledWith([{ ...member, instructions: "inspect" }]);
  for (const [label, expected] of [
    ["하위 모델 없음", []],
    ["전역 팀 사용", null],
  ] as const) {
    press(show(), label);
    press(show(), "초안에 팀 저장");
    await Promise.resolve();
    expect(save).toHaveBeenLastCalledWith(expected);
  }
  expect(mocks.update).not.toHaveBeenCalled();
});

it("retains the rest of a large team when its last member is removed", async () => {
  const members = Array.from({ length: 65 }, (_, i) => ({ ...member, model: "worker-" + i }));
  const base = config([{ ...scope, members }]);
  const show = () => render(base);
  press(show(), "하위 AI 설정");
  press(show(), "65번 하위 모델 제거");
  const remaining = members.slice(0, -1);
  mocks.update.mockResolvedValue({
    _tag: "Success",
    value: config([{ ...scope, members: remaining }]).settings,
  });
  press(show(), "이 대화의 팀 저장");
  await Promise.resolve();
  expect(mocks.update).toHaveBeenCalledWith({
    environmentId,
    input: { patch: { threadSubordinateTeamUpdate: { threadId, members: remaining } } },
  });
});

it.each([
  ["하위 모델 없음", []],
  ["전역 팀 사용", null],
] as const)(
  "sends the distinct %s operation and retains a rejected draft",
  async (label, members) => {
    const base = config([{ ...scope, members: [member] }]);
    const show = () => render(base);
    press(show(), "하위 AI 설정");
    press(show(), label);
    mocks.update.mockResolvedValue({ _tag: "Failure" });
    press(show(), "이 대화의 팀 저장");
    await Promise.resolve();
    expect(mocks.update).toHaveBeenCalledWith({
      environmentId,
      input: { patch: { threadSubordinateTeamUpdate: { threadId, members } } },
    });
    expect(element(show(), "이 대화의 팀 저장")!.props.disabled).toBe(false);
    expect(element(render(base, false), "이 대화의 팀 저장")!.props.disabled).toBe(true);
  },
);
