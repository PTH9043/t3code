import { beforeEach, expect, it, vi } from "vite-plus/test";
import {
  DEFAULT_UNIFIED_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ServerProvider,
  type ServerSettings,
  type ModelSelection,
} from "@t3tools/contracts";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";
import { visitElements } from "../../test/reactElementTree";
import { DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { buildDraftThreadCreateBootstrap } from "../ChatView.logic";
import { GlobalAssistantStudio } from "./GlobalAssistantStudio";
import { RoomModelSettings } from "./RoomModelSettings";
import { ThreadResponseStyle } from "./ThreadResponseStyle";
import { GlobalSubordinateTeamEditor, ThreadModelTeamSettings } from "./ThreadModelTeamSettings";

const state = vi.hoisted(() => ({
  settings: null as ServerSettings | null,
  providers: null as ServerProvider[] | null,
  connected: true,
  metadata: vi.fn(),
  update: vi.fn(),
  list: vi.fn(),
  effects: [] as Array<() => void | (() => void)>,
}));
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  const { reactHookHarness: h } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useState: h.useState,
    useMemo: h.useMemo,
    useRef: h.useRef,
    useEffect: (effect: () => void) => {
      state.effects.push(effect);
    },
  };
});
vi.mock("react/compiler-runtime", async () => ({
  c: (await import("../../test/reactHookHarness")).reactHookHarness.useMemoCache,
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (key: string) => (key === "providers" ? state.providers : state.settings),
}));
vi.mock("~/state/environments", () => ({
  useEnvironment: () => ({ connection: { phase: state.connected ? "connected" : "disconnected" } }),
}));
vi.mock("~/hooks/useSettings", () => ({
  useEnvironmentSettings: (_env: EnvironmentId, select?: (settings: ServerSettings) => unknown) =>
    select && state.settings ? select(state.settings) : state.settings,
}));
vi.mock("~/composerDraftStore", async (original) => {
  const actual = await original<typeof import("~/composerDraftStore")>();
  const store = actual.useComposerDraftStore;
  return {
    ...actual,
    useComposerDraftStore: Object.assign(
      <T,>(select: (s: ReturnType<typeof store.getState>) => T) => select(store.getState()),
      store,
    ),
  };
});
vi.mock("~/state/server", () => ({
  serverEnvironment: {
    settingsValueAtom: () => "settings",
    providersValueAtom: () => "providers",
    updateSettings: "update",
    listThreadSettingsLibrary: "list",
  },
}));
vi.mock("~/state/threads", () => ({
  threadEnvironment: { updateMetadata: "metadata" },
  environmentThreadDetails: {},
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (name: "metadata" | "update" | "list") => state[name],
}));

const environmentId = EnvironmentId.make("host"),
  target = ThreadId.make("target"),
  source = ThreadId.make("source");
const a = ProviderInstanceId.make("account_a"),
  b = ProviderInstanceId.make("account_b");
const sourceModel: ModelSelection = {
  instanceId: a,
  model: "same",
  options: [{ id: "reasoning", value: "high" }],
};
const targetModel: ModelSelection = { instanceId: b, model: "same" };
const style = {
  preset: "detailed",
  tone: "formal",
  length: "long",
  explanation: "steps",
  instructions: "fixture",
} as const;
const member = { instanceId: a, model: "same", role: "advisor", instructions: "review" } as const;
const projectId = ProjectId.make("project");
const blank = {
  preset: "default",
  tone: "",
  length: "",
  explanation: "",
  instructions: "",
} as const;

beforeEach(() => {
  hooks.reset();
  vi.clearAllMocks();
  state.settings = {
    ...DEFAULT_UNIFIED_SETTINGS,
    providerInstances: Object.fromEntries(
      [a, b].map((id) => [id, { driver: ProviderDriverKind.make("codex") }]),
    ),
    threadResponseStyles: { [source]: style },
    threadSubordinateTeams: { [source]: [member] },
  };
  state.providers = [a, b].map((instanceId) => ({
    instanceId,
    driver: ProviderDriverKind.make("codex"),
    displayName: "same account",
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-11-19T00:00:00Z",
    models: [{ slug: "same", name: "same", capabilities: null, isCustom: false }],
    slashCommands: [],
    skills: [],
  }));
  state.effects = [];
  state.list.mockResolvedValue({ _tag: "Success", value: [] });
  state.metadata.mockResolvedValue({ _tag: "Success" });
  state.update.mockImplementation(async ({ input: { patch } }) => ({
    _tag: "Success",
    value: {
      ...state.settings,
      ...("globalResponseStyle" in patch ? { globalResponseStyle: patch.globalResponseStyle } : {}),
      threadResponseStyles: {
        ...state.settings?.threadResponseStyles,
        ...patch.threadResponseStyles,
      },
    },
  }));
});

it("shows a legacy server style until the draft has an explicit local style", () => {
  state.settings = { ...state.settings!, threadResponseStyles: { [target]: style } };
  const local = { ...style, instructions: "local" };
  for (const value of [undefined, local]) {
    hooks.reset();
    hooks.beginRender();
    const editor = ThreadResponseStyle({
      environmentId,
      threadId: target,
      localDraft: { style: value, save: vi.fn() },
    });
    expect(visitElements(editor, (e) => e.type === "textarea")?.props.value).toBe(
      (value ?? style).instructions,
    );
  }
});

it("mounts the unified global studio and global subordinate team in settings without per-room overrides", () => {
  hooks.beginRender();
  const panel = RoomModelSettings({ environmentId, showMonitorControls: true });
  const studio = visitElements(panel, (e) => e.type === GlobalAssistantStudio);
  expect(studio?.props).toMatchObject({
    environmentId,
    compact: false,
    showMonitorControls: true,
  });
  expect(
    visitElements(panel, (e) => e.type === GlobalSubordinateTeamEditor)?.props.environmentId,
  ).toBe(environmentId);
  expect(visitElements(panel, (e) => e.type === ThreadModelTeamSettings)).toBeNull();
  expect(state.list).not.toHaveBeenCalled();
});

it("switches GlobalAssistantStudio into compact mode when rendered inside a conversation", () => {
  hooks.beginRender();
  const panel = RoomModelSettings({
    environmentId,
    room: { threadId: target, modelSelection: targetModel, draftId: null },
  });
  const studio = visitElements(panel, (e) => e.type === GlobalAssistantStudio);
  expect(studio?.props).toMatchObject({
    environmentId,
    compact: true,
    showMonitorControls: false,
  });
  expect(visitElements(panel, (e) => e.type === GlobalSubordinateTeamEditor)).not.toBeNull();
  expect(visitElements(panel, (e) => e.type === ThreadModelTeamSettings)).toBeNull();
  expect(state.list).not.toHaveBeenCalled();
});

it("keeps an unsent conversation's own style on this device and sends it with the first request", () => {
  const draftId = DraftId.make("room-style-draft"),
    store = useComposerDraftStore.getState();
  store.setProjectDraftThreadId({ environmentId, projectId }, draftId, { threadId: target });
  try {
    store.setDraftResponseStyle(draftId, { environmentId, threadId: target }, style);
    const draft = store.getDraftSession(draftId)!;
    const created = buildDraftThreadCreateBootstrap(draft, draftId, {
      title: "new",
      modelSelection: sourceModel,
      runtimeMode: draft.runtimeMode,
      interactionMode: draft.interactionMode,
    }).createThread!;
    expect(created).toHaveProperty("responseStyle", style);
    expect(state.update).not.toHaveBeenCalled();
  } finally {
    store.clearDraftThread(draftId);
  }
});

it("shows whether a conversation follows the global style, saves its own and returns to global", async () => {
  state.settings = {
    ...state.settings!,
    globalResponseStyle: { ...style, instructions: "global" },
  };
  const editor = () => {
    hooks.beginRender();
    return ThreadResponseStyle({ environmentId, threadId: target });
  };
  const summary = () =>
    visitElements(editor(), (e) => e.type === "summary")!.props.children as unknown[];
  expect(summary().join("")).toBe("이 방 답변 스타일 · 전역 스타일 사용 중");
  expect(visitElements(editor(), (e) => e.props.children === "전역 스타일 사용")).toBeNull();
  // The form starts blank: a conversation never silently copies the global style.
  const field = visitElements(editor(), (e) => e.type === "textarea")!;
  expect(field.props.value).toBe("");
  (field.props.onChange as (e: unknown) => void)({ currentTarget: { value: "room only" } });
  const form = visitElements(editor(), (e) => e.type === "form")!;
  await (form.props.onSubmit as (e: unknown) => Promise<void>)({ preventDefault: vi.fn() });
  const own = { ...blank, instructions: "room only" };
  expect(state.update).toHaveBeenLastCalledWith({
    environmentId,
    input: { patch: { threadResponseStyles: { [target]: own } } },
  });
  state.settings = {
    ...state.settings!,
    threadResponseStyles: { ...state.settings!.threadResponseStyles, [target]: own },
  };
  hooks.reset();
  expect(summary().join("")).toBe("이 방 답변 스타일 · 기본");
  const back = visitElements(editor(), (e) => e.props.children === "전역 스타일 사용")!;
  (back.props.onClick as () => void)();
  await Promise.resolve();
  expect(state.update).toHaveBeenLastCalledWith({
    environmentId,
    input: { patch: { threadResponseStyles: { [target]: blank } } },
  });
  expect(
    state.update.mock.calls.every(([call]) => !("globalResponseStyle" in call.input.patch)),
  ).toBe(true);
});

it("shows the global style form directly and disables saving until settings load", () => {
  state.settings = null;
  hooks.beginRender();
  const editor = ThreadResponseStyle({ environmentId });
  expect(editor.type).toBe("section");
  expect(visitElements(editor, (e) => e.type === "fieldset")?.props.disabled).toBe(true);
  expect(visitElements(editor, (e) => e.type === "details")).toBeNull();
});

it("saves the global style without writing a room style", async () => {
  state.settings = { ...state.settings!, globalResponseStyle: style };
  const editor = () => {
    hooks.beginRender();
    return ThreadResponseStyle({ environmentId });
  };
  const field = visitElements(editor(), (e) => e.type === "textarea")!;
  expect(field.props.value).toBe(style.instructions);
  const next = { ...style, instructions: "global only" };
  (field.props.onChange as (e: unknown) => void)({ currentTarget: { value: next.instructions } });
  state.update.mockResolvedValueOnce({
    _tag: "Success",
    value: { ...state.settings, globalResponseStyle: next },
  });
  const form = visitElements(editor(), (e) => e.type === "form")!;
  await (form.props.onSubmit as (e: unknown) => Promise<void>)({ preventDefault: vi.fn() });
  expect(state.update).toHaveBeenCalledExactlyOnceWith({
    environmentId,
    input: { patch: { globalResponseStyle: next } },
  });
});
