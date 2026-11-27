import { Children, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vite-plus/test";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  WorkflowStart,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { DEFAULT_MEETING_COMPOSER_CONFIG } from "../../meetingComposerStore";
import { ChatWorkflowLauncher } from "./ChatWorkflowLauncher";
import type { WorkspaceDevelopmentPanelProps } from "./WorkspaceDevelopmentPanel";

const state = vi.hoisted(() => ({
  buttons: [] as Array<{ label: string; disabled: boolean; onClick: (() => void) | undefined }>,
  queries: [] as Array<string | null>,
  selectMode: vi.fn(async () => true),
  updateMeeting: vi.fn(),
  start: vi.fn(async (_input: unknown) => ({ _tag: "Success", value: { id: "run" } })),
  runs: [] as Array<Record<string, unknown>>,
}));

vi.mock("../ui/button", () => ({
  Button: (props: { children?: ReactNode; disabled?: boolean; onClick?: () => void }) => {
    const label = Children.toArray(props.children)
      .filter((child): child is string => typeof child === "string")
      .join("")
      .trim();
    state.buttons.push({ label, disabled: props.disabled === true, onClick: props.onClick });
    return <button disabled={props.disabled}>{props.children}</button>;
  },
}));
vi.mock("../ui/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  PopoverPopup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  PopoverTitle: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}));
vi.mock("../../askFirstStore", () => ({
  useComposerRequestModeStore: (
    selector: (state: { modeByFolder: Record<string, never> }) => unknown,
  ) => selector({ modeByFolder: {} }),
}));
vi.mock("../../meetingComposerStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../meetingComposerStore")>()),
  updateMeetingComposerConfig: state.updateMeeting,
}));
vi.mock("~/state/orchestration", () => ({
  orchestrationEnvironment: {
    workspaceWorkflows: () => "workflows",
    workspaceAgentRoles: () => "roles",
    workspaceRuntime: () => "runtime",
    workflowRun: () => "run",
    saveWorkflow: "save",
    startWorkflow: "start",
    controlWorkflow: "control",
  },
}));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: (query: string | null) => {
    state.queries.push(query);
    return {
      data:
        query === "workflows"
          ? { definitions: [], defaults: [], runs: [], allRuns: state.runs }
          : query === "roles"
            ? { roles: [] }
            : null,
      error: null,
      refresh: () => {},
    };
  },
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: string) =>
    command === "start" ? state.start : async () => ({ _tag: "Success" }),
}));
vi.mock("../control-center/controlCenterShared", () => ({
  runStatusLabel: (status: string) => status,
  useOperationsRevisionRefresh: () => {},
}));
vi.mock("./MeetingModePanel", () => ({ MeetingModePanel: () => <div>공통 참가자 설정</div> }));
vi.mock("./WorkspaceDevelopmentPanel", () => ({
  WorkspaceDevelopmentPanel: () => <div>공통 지속 진행 설정</div>,
}));
vi.mock("./WorkflowModelSelector", () => ({
  WorkflowModelSelector: () => <div>역할 모델 설정</div>,
}));
vi.mock("./useComposerWorkMode", () => ({
  useComposerWorkMode: () => ({
    changingMode: false,
    modeError: null,
    selectMode: state.selectMode,
  }),
}));

const project = {
  id: ProjectId.make("project"),
  environmentId: EnvironmentId.make("environment"),
} as EnvironmentProject;
const seats = ["a", "b"].map((id) => ({
  id,
  displayName: id,
  instanceId: ProviderInstanceId.make("codex"),
  model: id,
}));
const base = {
  project,
  contextKey: "thread",
  threadId: ThreadId.make("thread"),
  prompt: "현재 목표",
  attachmentCount: 0,
  startBlocked: false,
  runtimeMode: "full-access" as const,
  interactionMode: "plan" as const,
  currentModel: { instanceId: ProviderInstanceId.make("codex"), model: "selected" },
  unavailableReason: null,
  open: true,
  onOpenChange: vi.fn(),
  instanceEntries: [],
  modelOptionsByInstance: new Map(),
  development: null,
};

function click(label: string) {
  const button = state.buttons.find((entry) => entry.label === label);
  expect(button, label).toBeDefined();
  expect(button!.disabled).toBe(false);
  button!.onClick?.();
}

beforeEach(() => {
  state.buttons.length = 0;
  state.queries.length = 0;
  state.selectMode.mockClear();
  state.updateMeeting.mockClear();
  base.onOpenChange.mockClear();
  state.start.mockClear();
  state.runs.length = 0;
});

it("starts an AI-planned task with the selected model and preserves the selected permissions", async () => {
  const markup = renderToStaticMarkup(
    <ChatWorkflowLauncher {...base} meetingConfig={DEFAULT_MEETING_COMPOSER_CONFIG} />,
  );
  expect(markup).toContain("작업 단계 구성");
  expect(markup).toContain("AI가 작업 단계 계획");
  expect(markup).toContain("역할 모델 설정");
  expect(markup).toContain("전체 실행 이력");
  expect(markup).toContain("전체 권한");
  expect(markup).toContain("계획");
  expect(state.selectMode).not.toHaveBeenCalled();
  click("AI 작업 시작");
  await vi.waitFor(() => expect(state.start).toHaveBeenCalledOnce());
  expect(state.start.mock.calls[0]![0]).toMatchObject({
    input: {
      task: "현재 목표",
      runtimeMode: "full-access",
      interactionMode: "plan",
      roleModels: {
        coordinator: base.currentModel,
        implementer: base.currentModel,
        researcher: base.currentModel,
      },
    },
  });
  expect(state.selectMode).not.toHaveBeenCalled();
});

it("starts from the same panel with the selected orchestra participants", async () => {
  const markup = renderToStaticMarkup(
    <ChatWorkflowLauncher
      {...base}
      meetingConfig={{ ...DEFAULT_MEETING_COMPOSER_CONFIG, enabled: true, seats, chairSeatId: "a" }}
    />,
  );
  expect(markup).toContain("작업 단계 구성");
  expect(markup).toContain("공통 참가자 설정");
  expect(markup).toContain("전체 실행 이력");
  click("AI 작업 시작");
  await vi.waitFor(() => expect(state.start).toHaveBeenCalledOnce());
  expect(state.start.mock.calls[0]![0]).toMatchObject({
    input: {
      task: "현재 목표",
      meeting: {
        chairParticipantId: "a",
        participants: [
          expect.objectContaining({ displayName: "a" }),
          expect.objectContaining({ displayName: "b" }),
        ],
      },
    },
  });
  expect((state.start.mock.calls[0]![0] as { input: object }).input).not.toHaveProperty(
    "roleModels",
  );
  expect(state.selectMode).not.toHaveBeenCalled();
});

it("sends the explicit persistent choice with the selected supervisor and permission mode", async () => {
  renderToStaticMarkup(
    <ChatWorkflowLauncher
      {...base}
      meetingConfig={{
        ...DEFAULT_MEETING_COMPOSER_CONFIG,
        enabled: true,
        executionMode: "persistent",
        seats,
        chairSeatId: "a",
      }}
    />,
  );
  click("AI 작업 시작");
  await vi.waitFor(() => expect(state.start).toHaveBeenCalledOnce());
  expect(state.start.mock.calls[0]![0]).toMatchObject({
    input: {
      meeting: { chairParticipantId: "a" },
      orchestra: { executionMode: "persistent" },
      runtimeMode: "full-access",
      interactionMode: "plan",
    },
  });
});

const decodeWorkflowStart = Schema.decodeUnknownSync(WorkflowStart);

it("starts integrated work in the draft conversation with its selected chat model", async () => {
  const threadId = ThreadId.make("draft-thread");
  const onDraftStarting = vi.fn();
  const modelTeams = [
    {
      threadId,
      answeringInstanceId: base.currentModel.instanceId,
      forModel: base.currentModel.model,
      members: [],
    },
  ];
  const getBootstrap = vi.fn((model: typeof base.currentModel) => ({
    createThread: {
      projectId: project.id,
      title: "draft",
      modelSelection: model,
      modelTeams,
      runtimeMode: "full-access" as const,
      interactionMode: "plan" as const,
      branch: null,
      worktreePath: null,
      createdAt: "2026-11-01T00:00:00.000Z",
    },
  }));
  renderToStaticMarkup(
    <ChatWorkflowLauncher
      {...base}
      threadId={threadId}
      getBootstrap={getBootstrap}
      onDraftStarting={onDraftStarting}
      meetingConfig={{ ...DEFAULT_MEETING_COMPOSER_CONFIG, enabled: true, seats, chairSeatId: "a" }}
    />,
  );
  click("AI 작업 시작");
  await vi.waitFor(() => expect(state.start).toHaveBeenCalledOnce());
  const submitted = state.start.mock.calls[0]![0] as { input: unknown };
  expect(decodeWorkflowStart(submitted.input).bootstrap?.createThread?.modelTeams).toEqual(
    modelTeams,
  );
  expect(onDraftStarting.mock.calls).toEqual([[true], [false]]);
  expect(state.start.mock.calls[0]![0]).toMatchObject({
    input: {
      threadId,
      userMessage: "현재 목표",
      bootstrap: { createThread: { modelSelection: base.currentModel, modelTeams } },
      meeting: { chairParticipantId: "a" },
    },
  });
});

it("keeps ordinary workflow starts available without an orchestra conversation", async () => {
  const getBootstrap = vi.fn((model: typeof base.currentModel) => ({
    createThread: {
      projectId: project.id,
      title: "draft",
      modelSelection: model,
      runtimeMode: "full-access" as const,
      interactionMode: "plan" as const,
      branch: null,
      worktreePath: null,
      createdAt: "2026-11-01T00:00:00.000Z",
    },
  }));
  renderToStaticMarkup(
    <ChatWorkflowLauncher
      {...base}
      threadId={null}
      getBootstrap={getBootstrap}
      meetingConfig={DEFAULT_MEETING_COMPOSER_CONFIG}
    />,
  );
  click("AI 작업 시작");
  await vi.waitFor(() => expect(state.start).toHaveBeenCalledOnce());
  expect(state.start.mock.calls[0]![0]).toMatchObject({
    input: {
      runtimeMode: "full-access",
      interactionMode: "plan",
    },
  });
  expect(getBootstrap).not.toHaveBeenCalled();
  expect((state.start.mock.calls[0]![0] as { input: object }).input).not.toHaveProperty("threadId");
});

it("does not start an orchestra without a selected conversation", () => {
  const markup = renderToStaticMarkup(
    <ChatWorkflowLauncher
      {...base}
      threadId={null}
      meetingConfig={{ ...DEFAULT_MEETING_COMPOSER_CONFIG, enabled: true, seats, chairSeatId: "a" }}
    />,
  );
  expect(markup).toContain("현재 프로젝트의 대화를 선택");
  expect(state.buttons.find((button) => button.label === "AI 작업 시작")?.disabled).toBe(true);
  expect(state.start).not.toHaveBeenCalled();
});

it("uses the unified orchestra settings instead of reviving the old persistent workspace", () => {
  const development = {
    environmentId: project.environmentId,
    projectId: project.id,
    conversationId: "thread",
    mainModel: base.currentModel,
    runtimeMode: base.runtimeMode,
    state: { enabled: true, conversationId: "thread", workspaces: [] },
    target: { workspaceId: null, mode: "followup", requirementChange: false },
    onTargetChange: () => {},
  } as unknown as WorkspaceDevelopmentPanelProps;
  const markup = renderToStaticMarkup(
    <ChatWorkflowLauncher
      {...base}
      development={development}
      meetingConfig={{ ...DEFAULT_MEETING_COMPOSER_CONFIG, enabled: true, seats }}
    />,
  );
  expect(markup).not.toContain("공통 지속 진행 설정");
  expect(markup).toContain("공통 참가자 설정");
  expect(markup).toContain("작업 단계 구성");
  expect(markup).not.toContain("보낼 대상 · Main");
  expect(state.selectMode).not.toHaveBeenCalled();
});

it("does not route a normal conversation to a legacy workspace", () => {
  const development = {
    environmentId: project.environmentId,
    projectId: project.id,
    conversationId: "thread",
    mainModel: base.currentModel,
    runtimeMode: base.runtimeMode,
    state: { enabled: true, conversationId: "thread", workspaces: [] },
    target: { workspaceId: "missing", mode: "followup", requirementChange: false },
    onTargetChange: () => {},
  } as unknown as WorkspaceDevelopmentPanelProps;
  const markup = renderToStaticMarkup(
    <ChatWorkflowLauncher
      {...base}
      development={development}
      meetingConfig={DEFAULT_MEETING_COMPOSER_CONFIG}
    />,
  );
  expect(markup).not.toContain("보낼 대상 · 선택한 작업실 (사용 불가)");
  expect(markup).not.toContain("보낼 대상 · Main");
});

it("only enables orchestra for a workflow when the user explicitly requests it", () => {
  renderToStaticMarkup(
    <ChatWorkflowLauncher {...base} meetingConfig={DEFAULT_MEETING_COMPOSER_CONFIG} />,
  );
  expect(state.selectMode).not.toHaveBeenCalled();
  click("오케스트라 참가자 함께 사용");
  expect(state.selectMode).toHaveBeenCalledWith("meeting");
  expect(state.start).not.toHaveBeenCalled();
});

it("turns off only the orchestra selection when requested from a workflow", () => {
  renderToStaticMarkup(
    <ChatWorkflowLauncher
      {...base}
      meetingConfig={{ ...DEFAULT_MEETING_COMPOSER_CONFIG, enabled: true, seats }}
    />,
  );
  click("오케스트라 참가자 사용 끄기");
  const update = state.updateMeeting.mock.calls[0]![0] as (
    value: typeof DEFAULT_MEETING_COMPOSER_CONFIG,
  ) => typeof DEFAULT_MEETING_COMPOSER_CONFIG;
  const config = { ...DEFAULT_MEETING_COMPOSER_CONFIG, enabled: true, seats };
  expect(update(config)).toEqual({ ...config, enabled: false });
  expect(state.selectMode).not.toHaveBeenCalled();
});

it("shows the existing participant requirement before starting a workflow with orchestra", () => {
  const markup = renderToStaticMarkup(
    <ChatWorkflowLauncher
      {...base}
      meetingConfig={{ ...DEFAULT_MEETING_COMPOSER_CONFIG, enabled: true }}
    />,
  );
  expect(markup).toContain("감독 AI를 한 명 이상 선택하세요.");
  expect(state.buttons.find((entry) => entry.label === "AI 작업 시작")?.disabled).toBe(true);
});

it("allows an explicitly selected supervisor without other participants", async () => {
  renderToStaticMarkup(
    <ChatWorkflowLauncher
      {...base}
      meetingConfig={{
        ...DEFAULT_MEETING_COMPOSER_CONFIG,
        enabled: true,
        seats: [seats[0]!],
        chairSeatId: "a",
      }}
    />,
  );
  click("AI 작업 시작");
  await vi.waitFor(() => expect(state.start).toHaveBeenCalledOnce());
  expect(state.start.mock.calls[0]![0]).toMatchObject({
    input: {
      meeting: { chairParticipantId: "a", participants: [expect.objectContaining({ id: "a" })] },
    },
  });
});

it("shows AI-planned and saved-flow runs in the same history", () => {
  const common = {
    status: "completed",
    counts: { total: 1, completed: 1, running: 0, failed: 0 },
    control: "active",
    controlRevision: 0,
  };
  state.runs.push(
    { ...common, id: "auto", title: "직접 계획한 작업", workflowRevision: null },
    { ...common, id: "saved", title: "저장한 단계", workflowRevision: 2 },
  );
  const markup = renderToStaticMarkup(
    <ChatWorkflowLauncher {...base} meetingConfig={DEFAULT_MEETING_COMPOSER_CONFIG} />,
  );
  expect(markup).toContain("직접 계획한 작업");
  expect(markup).toContain("저장한 단계");
});

it("does not silently drop a chat attachment or skip a pending answer", () => {
  const markup = renderToStaticMarkup(
    <ChatWorkflowLauncher
      {...base}
      attachmentCount={1}
      startBlocked
      meetingConfig={DEFAULT_MEETING_COMPOSER_CONFIG}
    />,
  );
  expect(markup).toContain("첨부 파일");
  expect(markup).toContain("대기 중인 질문");
  expect(state.buttons.find((entry) => entry.label === "AI 작업 시작")?.disabled).toBe(true);
  expect(state.start).not.toHaveBeenCalled();
});
