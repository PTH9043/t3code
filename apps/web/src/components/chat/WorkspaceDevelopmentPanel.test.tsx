import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ThreadId, WorkspaceDevelopmentState } from "@t3tools/contracts";
import type { DevelopmentGoal } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import {
  WorkspaceDevelopmentPanel,
  DEFAULT_DEVELOPMENT_INPUT_TARGET,
} from "./WorkspaceDevelopmentPanel";

vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => async () => ({ _tag: "Success" }),
}));
vi.mock("../../state/orchestration", () => ({
  orchestrationEnvironment: { configureDevelopment: {}, returnDevelopmentControl: {} },
}));

const state = Schema.decodeUnknownSync(WorkspaceDevelopmentState)({
  projectId: "project",
  conversationId: "main",
  enabled: true,
  revision: 4,
  policyRevision: 1,
  mainObservedRevision: 3,
  mainActedRevision: 0,
  pendingMainNotification: false,
  ownerModels: [{ instanceId: "codex", model: "selected" }],
  runtimeMode: "approval-required",
  maxParallelOwners: 3,
  verificationCommands: [],
  bindings: [],
  tasks: [],
  verifications: [],
  integrations: [],
  workspaces: [
    {
      id: "inventory",
      name: "Inventory",
      scope: ["inventory"],
      bindingId: "binding",
      worktreePath: "/repo/owner",
      branch: "owner",
      baseSha: "a",
      observedFingerprint: "initial",
      generation: 1,
      definitionRevision: 1,
      stateRevision: 4,
      requirementRevision: 2,
      control: "human",
      takeover: true,
      externalUnmanaged: false,
      summaryPending: true,
      status: "ready",
      error: null,
      lastSummary: "maxStack=30",
    },
  ],
});
const render = (conversationId = state.conversationId, direct = false) =>
  renderToStaticMarkup(
    <WorkspaceDevelopmentPanel
      environmentId={EnvironmentId.make("environment")}
      projectId={state.projectId}
      conversationId={conversationId}
      mainModel={state.ownerModels[0]!}
      runtimeMode={state.runtimeMode}
      state={state}
      target={{
        ...DEFAULT_DEVELOPMENT_INPUT_TARGET,
        workspaceId: direct ? state.workspaces[0]!.id : null,
      }}
      onTargetChange={() => {}}
    />,
  );
it("keeps Main and persistent Owner selection inside the existing composer without taking control on viewing", () => {
  const markup = render();
  expect(markup).toContain("Main · 전체 프로젝트");
  expect(markup).toContain("@Inventory · 직접 조율");
  expect(markup).not.toContain("직접 지시 방식");
  expect(markup).toContain('aria-expanded="false"');
});
it("makes takeover and confirmed requirement change separate choices for direct input", () => {
  const markup = render(state.conversationId, true);
  expect(markup).toContain("보충 / 후속");
  expect(markup).toContain("대기열 추가");
  expect(markup).toContain("중단 후 교체");
  expect(markup).toContain("직접 인수");
  expect(markup).toContain("확정 요구 변경");
});
it("does not turn a different conversation into another Main", () => {
  const markup = render(ThreadId.make("other"));
  expect(markup).not.toContain("지속 작업실 입력 대상");
});

const renderGoal = (status: DevelopmentGoal["status"], otherConversation = false) =>
  renderToStaticMarkup(
    <WorkspaceDevelopmentPanel
      environmentId={EnvironmentId.make("environment")}
      projectId={state.projectId}
      conversationId={otherConversation ? ThreadId.make("other") : state.conversationId}
      mainModel={state.ownerModels[0]!}
      runtimeMode={state.runtimeMode}
      state={{
        ...state,
        goal: {
          id: "goal",
          revision: 1,
          objective: "기존 기능을 개발하고 검증한다",
          acceptanceCriteria: ["테스트 통과"],
          status,
          phase: "waiting",
          steps: 2,
          maxSteps: 12,
          maxMinutes: 60,
          activeMilliseconds: 0,
          activatedAt: null,
          pendingMessageId: null,
          runSeen: false,
          progressReported: true,
          progressFingerprint: "",
          noProgressSteps: 0,
          lastSummary: "Owner 테스트 결과 대기",
          integrationId: null,
          initialIntegrationIds: [],
          startedAt: "2026-09-30T00:00:00Z",
        },
      }}
      target={DEFAULT_DEVELOPMENT_INPUT_TARGET}
      onTargetChange={() => {}}
    />,
  );
it("shows autonomous goal progress and pause/cancel in the same composer", () => {
  const markup = renderGoal("active");
  expect(markup).toContain("개발 목표 · 자동 진행");
  expect(markup).toContain("Owner 결과 대기");
  expect(markup).toContain("목표 일시정지");
  expect(markup).toContain("목표 종료");
  expect(markup).not.toContain("목표 재개");
});
it("provides explicit resume for paused or blocked goals and no controls for a completed goal", () => {
  expect(renderGoal("paused")).toContain("목표 재개");
  expect(renderGoal("blocked")).toContain("목표 재개");
  expect(renderGoal("complete")).toContain("검증 완료");
  expect(renderGoal("complete")).not.toContain("목표 종료");
  expect(renderGoal("complete")).not.toContain("목표 재개");
});
it("does not expose another conversation's autonomous goal controls", () => {
  expect(renderGoal("active", true)).not.toContain("목표 일시정지");
});

it("explains setup inside the model picker and accepts commands without requiring JSON", () => {
  const markup = renderToStaticMarkup(
    <WorkspaceDevelopmentPanel
      environmentId={EnvironmentId.make("environment")}
      projectId={state.projectId}
      conversationId={state.conversationId}
      mainModel={state.ownerModels[0]!}
      runtimeMode={state.runtimeMode}
      state={null}
      target={DEFAULT_DEVELOPMENT_INPUT_TARGET}
      onTargetChange={() => {}}
      surface="picker"
    />,
  );
  expect(markup).toContain("Main과 담당 AI 모델을 고릅니다.");
  expect(markup).toContain("지속 작업실 사용 시작");
  expect(markup).toContain("지속 작업실 Main 모델");
  expect(markup).toContain("작업실 담당 모델 1");
  expect(markup).toContain("검증 명령 · 한 줄에 하나");
  expect(markup).not.toContain("node&quot;,&quot;args");
});

it("keeps the current input target available inside the unified work panel", () => {
  const markup = renderToStaticMarkup(
    <WorkspaceDevelopmentPanel
      environmentId={EnvironmentId.make("environment")}
      projectId={state.projectId}
      conversationId={state.conversationId}
      mainModel={state.ownerModels[0]!}
      runtimeMode={state.runtimeMode}
      state={state}
      target={{ ...DEFAULT_DEVELOPMENT_INPUT_TARGET, workspaceId: state.workspaces[0]!.id }}
      onTargetChange={() => {}}
      surface="picker"
    />,
  );
  expect(markup).toContain("지속 작업실 입력 대상");
  expect(markup).toContain("@Inventory · 직접 조율");
  expect(markup).toContain("직접 지시 방식");
  expect(markup).toContain("확정 요구 변경");
});
