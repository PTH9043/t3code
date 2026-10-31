import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  WorkspaceDevelopmentState,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { ModelPickerContent } from "./ModelPickerContent";
import { ProviderModelPicker } from "./ProviderModelPicker";
import {
  DEFAULT_DEVELOPMENT_INPUT_TARGET,
  type WorkspaceDevelopmentPanelProps,
} from "./WorkspaceDevelopmentPanel";

const mode = vi.hoisted(() => ({ meetingEnabled: false }));
vi.mock("../../meetingComposerStore", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../meetingComposerStore")>();
  return {
    ...original,
    useMeetingComposerConfig: () => ({
      ...original.DEFAULT_MEETING_COMPOSER_CONFIG,
      enabled: mode.meetingEnabled,
    }),
  };
});
vi.mock("~/hooks/useSettings", () => ({
  useClientSettings: () => [],
  useUpdateClientSettings: () => () => {},
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => async () => ({ _tag: "Success" }),
}));
vi.mock("./MeetingModePanel", () => ({ MeetingModePanel: () => <p>참가자 설정</p> }));

const target = { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("thread") };
const selection = { instanceId: ProviderInstanceId.make("codex"), model: "selected" };
const state = Schema.decodeUnknownSync(WorkspaceDevelopmentState)({
  projectId: "project",
  conversationId: target.threadId,
  enabled: true,
  revision: 1,
  policyRevision: 1,
  mainObservedRevision: 0,
  mainActedRevision: 0,
  pendingMainNotification: false,
  ownerModels: [selection],
  runtimeMode: "approval-required",
  maxParallelOwners: 3,
  verificationCommands: [],
  bindings: [],
  tasks: [],
  verifications: [],
  integrations: [],
  workspaces: [],
});
const development: WorkspaceDevelopmentPanelProps = {
  environmentId: target.environmentId,
  projectId: ProjectId.make("project"),
  conversationId: target.threadId,
  mainModel: selection,
  runtimeMode: "approval-required",
  state,
  target: DEFAULT_DEVELOPMENT_INPUT_TARGET,
  onTargetChange: () => {},
};
const baseProps = {
  activeInstanceId: selection.instanceId,
  model: selection.model,
  lockedProvider: null,
  instanceEntries: [],
  modelOptionsByInstance: new Map(),
  terminalOpen: false,
  onInstanceModelChange: () => {},
};

it("keeps the model list and opens the single AI work panel", () => {
  mode.meetingEnabled = false;
  const markup = renderToStaticMarkup(
    <ModelPickerContent
      {...baseProps}
      meetingTarget={target}
      development={{ ...development, state: null }}
      onOpenAiTask={() => {}}
    />,
  );
  expect(markup).toContain("AI 작업 설정 열기");
  expect(markup).toContain("모델 검색");
  expect(markup).not.toContain('aria-label="작업 모드 선택"');
  expect(markup).not.toContain("Main과 담당 AI 모델을 고릅니다.");
});

it("keeps the selected model visible while persistent work and orchestra are active", () => {
  mode.meetingEnabled = true;
  const content = renderToStaticMarkup(
    <ModelPickerContent
      {...baseProps}
      meetingTarget={target}
      development={development}
      onOpenAiTask={() => {}}
    />,
  );
  expect(content).toContain("AI 작업 설정 열기");
  expect(content).toContain("모델 검색");
  expect(content).not.toContain("참가자 설정");
  const trigger = renderToStaticMarkup(
    <ProviderModelPicker {...baseProps} meetingTarget={target} development={development} />,
  );
  expect(trigger).toContain("selected");
  expect(trigger).not.toContain("지속 작업실");
  expect(trigger).not.toContain("오케스트라 · 바로 실행");
});

it("does not open a separate mode when a draft has no shared AI work action", () => {
  mode.meetingEnabled = true;
  const markup = renderToStaticMarkup(
    <ModelPickerContent
      {...baseProps}
      meetingTarget={target}
      developmentUnavailableReason="먼저 대화를 만드세요."
    />,
  );
  expect(markup).not.toContain("참가자 설정");
  expect(markup).not.toContain("지속 작업실");
  expect(markup).toContain("모델 검색");
});

it("routes orchestra settings to the shared AI task panel when the composer provides it", () => {
  mode.meetingEnabled = true;
  const markup = renderToStaticMarkup(
    <ModelPickerContent {...baseProps} meetingTarget={target} onOpenAiTask={() => {}} />,
  );
  expect(markup).toContain("AI 작업 설정 열기");
  expect(markup).not.toContain("참가자 설정</p>");
});

it("keeps composer modes out of settings and message-edit model pickers", () => {
  mode.meetingEnabled = false;
  const markup = renderToStaticMarkup(<ModelPickerContent {...baseProps} />);
  expect(markup).not.toContain("작업 모드 선택");
  expect(markup).not.toContain("지속 작업실");
});
