import { beforeEach, expect, it, vi } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  WorkspaceKnowledgeItemId,
  type TelegramChannelRegistration,
  type TelegramChannelsManageInput,
  type TelegramChannelsStatusResult,
} from "@t3tools/contracts";
import { visitElements } from "~/test/reactElementTree";
import { reactHookHarness as hooks } from "~/test/reactHookHarness";
import { KnowledgeDocLink } from "../knowledge/KnowledgeDocLink";
import { Input } from "../ui/input";
import {
  TelegramChannelRegistrationForm,
  TelegramChannelRow,
  TelegramChannelsSection,
  TelegramCliFallback,
  TelegramProjectChannels,
} from "./TelegramChannelsSection";

const mocks = vi.hoisted(() => ({ run: vi.fn(), query: vi.fn(), refresh: vi.fn() }));
const id = ProjectId.make("example");
const project = { environmentId: EnvironmentId.make("remote"), projectId: id };
const instanceA = ProviderInstanceId.make("cli_a");
const instanceB = ProviderInstanceId.make("cli_b");
const models = [
  { instanceId: instanceA, accountLabel: "Account A", modelId: "one" },
  { instanceId: instanceB, accountLabel: "Account B", modelId: "one" },
];
const snapshot: TelegramChannelsStatusResult = { registrations: [], cliModels: models };

vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  const { reactHookHarness } = await import("~/test/reactHookHarness");
  return {
    ...react,
    useState: reactHookHarness.useState,
    useRef: reactHookHarness.useRef,
    useEffect: vi.fn(),
  };
});
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("~/test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});
vi.mock("~/connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("@t3tools/client-runtime/state/runtime", async (original) => ({
  ...(await original<typeof import("@t3tools/client-runtime/state/runtime")>()),
  createEnvironmentRpcQueryAtomFamily: () => mocks.query,
  createEnvironmentRpcCommand: () => ({}),
}));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => mocks.run }));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: () => ({
    data: snapshot,
    error: null,
    isPending: false,
    refresh: mocks.refresh,
  }),
}));
vi.mock("~/state/entities", () => ({
  useProjects: () =>
    ["local", "remote"].map((environmentId) => ({ id, environmentId, title: "Project" })),
}));
vi.mock("~/state/environments", () => ({
  useEnvironments: () => ({ environments: [] }),
}));

beforeEach(() => {
  hooks.reset();
  vi.clearAllMocks();
});

type ElementProps = {
  value?: string;
  disabled?: boolean;
  checked?: boolean;
  onChange: (event: { target: { value?: string; checked?: boolean } }) => void;
  onSubmit: (event: { preventDefault: () => void }) => Promise<void> | void;
  onClick: () => Promise<void> | void;
};
function render(component: () => unknown) {
  hooks.beginRender();
  return component();
}
function find(tree: unknown, test: Parameters<typeof visitElements>[1]) {
  const result = visitElements(tree, test);
  if (!result) throw new Error("Expected control is missing");
  return result.props as ElementProps;
}
function submit(tree: unknown) {
  return find(tree, (el) => el.type === "form").onSubmit({ preventDefault: () => {} });
}

it("requires explicit project selection and scopes requests to the selected server even with equal project IDs", async () => {
  const section = () => render(TelegramChannelsSection);
  expect(visitElements(section(), (el) => el.type === TelegramProjectChannels)).toBeNull();
  find(section(), (el) => el.type === "select").onChange({ target: { value: "remote:example" } });
  expect(
    visitElements(section(), (el) => el.type === TelegramProjectChannels)?.props.project,
  ).toEqual(project);
  hooks.reset();
  const tree = render(() => TelegramProjectChannels({ project }));
  expect(mocks.query).toHaveBeenCalledWith({
    environmentId: project.environmentId,
    input: { projectId: id },
  });
  const manage = visitElements(tree, (el) => el.type === TelegramChannelRegistrationForm)?.props
    .onManage as (input: TelegramChannelsManageInput) => Promise<unknown>;
  expect(mocks.run).not.toHaveBeenCalled();
  await manage({ action: "lookup", projectId: ProjectId.make("other"), title: "Example" });
  expect(mocks.run).not.toHaveBeenCalled();
  mocks.run.mockResolvedValue({ _tag: "Success", value: snapshot });
  const input = { action: "lookup", projectId: id, title: "Example" } as const;
  await manage(input);
  expect(mocks.run).toHaveBeenCalledWith({ environmentId: project.environmentId, input });
});

it("registers only a submitted known channel and rejects invite links", async () => {
  const onManage = vi.fn().mockResolvedValue(snapshot);
  const form = () =>
    render(() => TelegramChannelRegistrationForm({ projectId: id, disabled: false, onManage }));
  const type = (value: string) =>
    find(form(), (el) => el.type === Input).onChange({ target: { value } });
  type("https://t.me/+fixture");
  await submit(form());
  expect(onManage).not.toHaveBeenCalled();
  type("https://t.me/example_channel");
  expect(onManage).not.toHaveBeenCalled();
  await submit(form());
  expect(onManage).toHaveBeenCalledExactlyOnceWith({
    action: "register",
    projectId: id,
    channel: "https://t.me/example_channel",
  });
});

it("looks up an exact title only on submit, requires choosing a match, and clears matches on edit", async () => {
  const matches = ["-1000000000001", "-1010000000002"].map((registrationId) => ({
    registrationId,
    title: "Same title",
  }));
  const onManage = vi.fn().mockResolvedValue({ ...snapshot, matches });
  const form = () =>
    render(() => TelegramChannelRegistrationForm({ projectId: id, disabled: false, onManage }));
  find(form(), (el) => el.type === "select").onChange({ target: { value: "title" } });
  find(form(), (el) => el.type === Input).onChange({ target: { value: "Same title" } });
  expect(onManage).not.toHaveBeenCalled();
  await submit(form());
  expect(onManage).toHaveBeenCalledExactlyOnceWith({
    action: "lookup",
    projectId: id,
    title: "Same title",
  });
  const register = () => find(form(), (el) => el.props.children === "선택한 채널 등록 및 수집");
  expect(register().disabled).toBe(true);
  find(form(), (el) => el.type === "select" && el.props.value === "").onChange({
    target: { value: "-1010000000002" },
  });
  expect(register().disabled).toBe(false);
  await register().onClick();
  expect(onManage).toHaveBeenLastCalledWith({
    action: "register",
    projectId: id,
    channel: "-1010000000002",
  });
  expect(
    visitElements(form(), (el) => el.props.children === "선택한 채널 등록 및 수집"),
  ).toBeNull();
  find(form(), (el) => el.type === Input).onChange({ target: { value: "Same title" } });
  await submit(form());
  find(form(), (el) => el.type === Input).onChange({ target: { value: "Different title" } });
  expect(
    visitElements(form(), (el) => el.props.children === "선택한 채널 등록 및 수집"),
  ).toBeNull();
});

it("requires transfer consent for the exact CLI account and model, resetting consent when either changes", () => {
  const onSave = vi.fn();
  const form = () =>
    render(() => TelegramCliFallback({ policy: null, models, onSave, disabled: false }));
  const choose = (instance: string) =>
    find(form(), (el) => el.type === "select").onChange({
      target: { value: JSON.stringify([instance, "one"]) },
    });
  const check = () =>
    find(form(), (el) => el.props.type === "checkbox").onChange({ target: { checked: true } });
  void submit(form());
  choose(instanceA);
  void submit(form());
  expect(onSave).not.toHaveBeenCalled();
  check();
  choose(instanceB);
  void submit(form());
  expect(onSave).not.toHaveBeenCalled();
  check();
  void submit(form());
  expect(onSave).toHaveBeenCalledExactlyOnceWith({
    instanceId: instanceB,
    modelId: "one",
    allowExternalTransfer: true,
  });
});

it("allows revoking an unavailable saved model and never substitutes another one", () => {
  const onSave = vi.fn();
  const tree = render(() =>
    TelegramCliFallback({
      policy: { instanceId: instanceA, modelId: "retired", allowExternalTransfer: true },
      models,
      disabled: false,
      onSave,
    }),
  );
  expect(find(tree, (el) => el.type === "select").value).toBe("");
  expect(find(tree, (el) => el.props.type === "submit").disabled).toBe(true);
  find(tree, (el) => el.props.children === "승인 해제 · 로컬에서만 재시도").onClick();
  expect(onSave).toHaveBeenCalledExactlyOnceWith(null);
});

it("keeps RAG links and all lifecycle actions on the channel's project", async () => {
  const onManage = vi.fn().mockResolvedValue(snapshot);
  const channel: TelegramChannelRegistration = {
    registrationId: "-1000000000001",
    channel: "Example",
    phase: "incremental",
    fetchedCount: 75,
    readThroughId: 160,
    processedCount: 38,
    missingTextCount: 0,
    unavailableCount: 0,
    sourceDocumentIds: [WorkspaceKnowledgeItemId.make("source")],
    policy: null,
  };
  const row = (phase: TelegramChannelRegistration["phase"]) =>
    render(() =>
      TelegramChannelRow({
        project,
        channel: { ...channel, phase },
        models,
        disabled: false,
        onManage,
      }),
    );
  const target = { projectId: id, registrationId: channel.registrationId };
  const progress = visitElements(row("incremental"), (el) => el.type === "p");
  const statusText = renderToStaticMarkup(progress);
  expect(statusText).toContain("4시간마다 새 글 전부 수집");
  expect(statusText).toContain("수집 75건");
  expect(statusText).toContain("RAG 문서에 반영 38건");
  expect(
    visitElements(row("incremental"), (el) => el.type === KnowledgeDocLink)?.props,
  ).toMatchObject({ ...project, itemId: "source" });
  for (const [phase, label, action] of [
    ["incremental", "일시정지", "pause"],
    ["paused", "재개", "resume"],
    ["incremental", "지금 동기화", "sync"],
    ["partial", "재시도", "retry"],
  ] as const) {
    await find(row(phase), (el) => el.props.children === label).onClick();
    expect(onManage).toHaveBeenLastCalledWith({ ...target, action });
  }
  await find(row("paused"), (el) => el.props.children === "등록 해제").onClick();
  expect(onManage).toHaveBeenCalledTimes(4);
  await find(row("paused"), (el) => el.props.children === "이 채널 등록 해제").onClick();
  expect(onManage).toHaveBeenLastCalledWith({ ...target, action: "remove" });
});
