import {
  DEFAULT_UNIFIED_SETTINGS,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderModel,
  type SubordinateAssignment,
  type UnifiedSettings,
} from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { visitElements } from "../../test/reactElementTree";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";

const state = vi.hoisted(() => ({
  providers: [] as ReadonlyArray<ServerProvider>,
  settings: null as UnifiedSettings | null,
  updateSettings: vi.fn(),
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { ...actual, useMemo: reactHookHarness.useMemo, useState: reactHookHarness.useState };
});
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => state.providers }));
vi.mock("../../state/server", () => ({
  EMPTY_SERVER_PROVIDERS: [],
  serverEnvironment: { providersValueAtom: () => Symbol("providers") },
}));
vi.mock("../../hooks/useSettings", () => ({
  useEnvironmentSettings: () => state.settings,
  useUpdateEnvironmentSettings: () => state.updateSettings,
}));

import { ProviderSubordinatesSection } from "./ProviderSubordinatesSection";
import { subordinateKey } from "./ProviderSubordinatesSection.logic";

const environmentId = EnvironmentId.make("test-env");
const claudeId = ProviderInstanceId.make("claudeAgent");
const codexId = ProviderInstanceId.make("codex");

const model = (slug: string, name: string): ServerProviderModel => ({
  slug,
  name,
  isCustom: false,
  capabilities: null,
});
const claudeModels = [model("claude-opus-5-5", "Claude Opus 5.5")];
const codexModels = [model("gpt-6-sol", "GPT-6 Sol"), model("gpt-6-luna", "GPT-6 Luna")];

const provider = (
  instanceId: ProviderInstanceId,
  models: ReadonlyArray<ServerProviderModel>,
): ServerProvider => ({
  instanceId,
  driver: ProviderDriverKind.make(instanceId),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-07-24T12:00:00.000Z",
  models: [...models],
  slashCommands: [],
  skills: [],
});

const onConfigChange = vi.fn();
const render = (config: unknown) => {
  hooks.beginRender();
  return ProviderSubordinatesSection({
    instanceId: claudeId,
    driver: "claudeAgent",
    config,
    models: claudeModels,
    environmentId,
    onConfigChange,
  });
};
const pick = (tree: unknown, label: string, value: string) => {
  const picker = visitElements(tree, (element) => element.props.label === label);
  expect(picker, label).not.toBeNull();
  (picker!.props.onChange as (value: string) => void)(value);
};
const button = (tree: unknown, text: string) =>
  visitElements(
    tree,
    (element) => element.props.children === text && typeof element.props.onClick === "function",
  );
const click = (tree: unknown, text: string) => {
  const found = button(tree, text);
  expect(found, text).not.toBeNull();
  (found!.props.onClick as () => void)();
};

describe("ProviderSubordinatesSection interactions", () => {
  beforeEach(() => {
    hooks.reset();
    onConfigChange.mockReset();
    state.updateSettings.mockReset();
    state.providers = [provider(claudeId, claudeModels), provider(codexId, codexModels)];
    state.settings = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: {
        [ProviderInstanceId.make("opencode_baidu")]: {
          driver: ProviderDriverKind.make("opencode"),
          displayName: "Baidu",
          config: { apiConnection: { protocol: "chat-completions", models: ["ernie-5.1"] } },
        },
      },
    };
  });

  it("collects config edits in a draft and writes them once on 저장", () => {
    const config = { binaryPath: "claude", conductorWorkerModel: "haiku" };
    let tree = render(config);
    expect(button(tree, "저장")?.props.disabled).toBe(true);

    pick(tree, "지휘자 모드 일꾼", "sonnet");
    tree = render(config);
    pick(tree, "잡일용 하위 API 계정·모델", "opencode_baidu:ernie-5.1");
    tree = render(config);
    pick(tree, "하위 API에 보낼 수 있는 내용", "project");
    tree = render(config);
    expect(onConfigChange).not.toHaveBeenCalled();
    expect(button(tree, "저장")?.props.disabled).toBe(false);
    expect(button(tree, "되돌리기")).not.toBeNull();

    click(tree, "저장");
    const saved = {
      binaryPath: "claude",
      conductorWorkerModel: "sonnet",
      helperAccount: "opencode_baidu:ernie-5.1",
      helperScope: "project",
    };
    expect(onConfigChange).toHaveBeenCalledTimes(1);
    expect(onConfigChange).toHaveBeenCalledWith(saved);
    expect(state.updateSettings).not.toHaveBeenCalled();

    // 서버 응답 전: 초안은 화면에 남고 저장은 다시 누를 수 없다.
    tree = render(config);
    expect(button(tree, "저장 중")?.props.disabled).toBe(true);

    // 서버 응답 후: 초안이 비워지고 저장할 것이 없다.
    render(saved);
    tree = render(saved);
    expect(button(tree, "저장")?.props.disabled).toBe(true);
    expect(button(tree, "되돌리기")).toBeNull();
    expect(onConfigChange).toHaveBeenCalledTimes(1);
  });

  it("does not count picking the saved value again as a change, and reverts on 되돌리기", () => {
    const config = { conductorWorkerModel: "haiku" };
    let tree = render(config);
    pick(tree, "지휘자 모드 일꾼", "sonnet");
    tree = render(config);
    pick(tree, "지휘자 모드 일꾼", "haiku");
    tree = render(config);
    expect(button(tree, "저장")?.props.disabled).toBe(true);

    pick(tree, "지휘자 모드 일꾼", "off");
    tree = render(config);
    click(tree, "되돌리기");
    tree = render(config);
    expect(button(tree, "저장")?.props.disabled).toBe(true);
    expect(onConfigChange).not.toHaveBeenCalled();
  });

  it("saves the cross-account list at once without touching the account config", () => {
    const other: SubordinateAssignment = {
      answeringInstanceId: codexId,
      instanceId: claudeId,
      model: "claude-opus-5-5",
      role: "advisor",
    };
    const mine: SubordinateAssignment = {
      answeringInstanceId: claudeId,
      instanceId: codexId,
      model: "gpt-6-luna",
      role: "worker",
    };
    state.settings = { ...state.settings!, subordinateModels: [other, mine] };

    let tree = render(undefined);
    pick(tree, "역할", "scout");
    expect(state.updateSettings).toHaveBeenLastCalledWith({
      subordinateModels: [other, { ...mine, role: "scout" }],
    });

    // 서버 응답 전의 다음 변경은 방금 보낸 목록 위에 쌓인다.
    tree = render(undefined);
    pick(tree, "답변 모델", "claude-opus-5-5");
    expect(state.updateSettings).toHaveBeenLastCalledWith({
      subordinateModels: [other, { ...mine, role: "scout", forModel: "claude-opus-5-5" }],
    });

    tree = render(undefined);
    const remove = visitElements(
      tree,
      (element) => element.props.label === "하위 모델 gpt-6-luna 제거",
    );
    (remove!.props.onClick as () => void)();
    expect(state.updateSettings).toHaveBeenLastCalledWith({ subordinateModels: [other] });
    expect(onConfigChange).not.toHaveBeenCalled();
  });

  it("adds a row for this account only after 목록에 추가", () => {
    let tree = render(undefined);
    const add = visitElements(
      tree,
      (element) =>
        typeof element.props.onClick === "function" &&
        element.props.disabled === false &&
        element.props.children === undefined &&
        element.props.label === undefined,
    );
    (add!.props.onClick as () => void)();

    tree = render(undefined);
    pick(tree, "새 하위 모델", subordinateKey(codexId, "gpt-6-sol"));
    tree = render(undefined);
    pick(tree, "새 하위 모델의 역할", "advisor");
    expect(state.updateSettings).not.toHaveBeenCalled();

    tree = render(undefined);
    click(tree, "목록에 추가");
    expect(state.updateSettings).toHaveBeenCalledTimes(1);
    expect(state.updateSettings).toHaveBeenCalledWith({
      subordinateModels: [
        { answeringInstanceId: claudeId, instanceId: codexId, model: "gpt-6-sol", role: "advisor" },
      ],
    });
    expect(onConfigChange).not.toHaveBeenCalled();
  });
});
