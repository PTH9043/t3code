import type { ReactElement } from "react";
import * as Schema from "effect/Schema";
import { beforeEach, expect, it, vi } from "vite-plus/test";
import {
  DEFAULT_UNIFIED_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  ThreadTurnStartBootstrap,
  type ModelSelection,
  type ServerProvider,
  type ThreadSubordinateTeamUpdate,
  type UnifiedSettings,
} from "@t3tools/contracts";
import { visitElements } from "../../test/reactElementTree";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";
import { GlobalSubordinateTeamEditor, ThreadModelTeamSettings } from "./ThreadModelTeamSettings";
import { DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { buildDraftThreadCreateBootstrap } from "../ChatView.logic";

const state = vi.hoisted(() => ({
  settings: null as UnifiedSettings | null,
  providers: [] as ServerProvider[],
  save: vi.fn(),
}));
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { ...actual, useMemo: reactHookHarness.useMemo, useState: reactHookHarness.useState };
});
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => state.providers }));
vi.mock("~/hooks/useSettings", () => ({ useEnvironmentSettings: () => state.settings }));
vi.mock("~/state/server", () => ({
  EMPTY_SERVER_PROVIDERS: [],
  serverEnvironment: {
    providersValueAtom: () => "providers",
    updateSettings: "update",
  },
}));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => state.save }));
vi.mock("~/composerDraftStore", async (original) => {
  const actual = await original<typeof import("~/composerDraftStore")>();
  const store = actual.useComposerDraftStore;
  return {
    ...actual,
    useComposerDraftStore: Object.assign(
      <T,>(select: (state: ReturnType<typeof store.getState>) => T) => select(store.getState()),
      store,
    ),
  };
});

const environmentId = EnvironmentId.make("env");
const threadId = ThreadId.make("chat-a");
const account = ProviderInstanceId.make("gemini");
const worker = ProviderInstanceId.make("codex");
const parent: ModelSelection = { instanceId: account, model: "chosen-parent" };
const props = { environmentId, threadId, modelSelection: parent };
const decodeBootstrap = Schema.decodeUnknownSync(ThreadTurnStartBootstrap);

const renderTeam = (input: typeof props & { draftId?: DraftId } = props) => {
  hooks.beginRender();
  const element = ThreadModelTeamSettings(input);
  hooks.beginRender();
  const editor = element.type as (p: typeof input) => ReactElement<Record<string, unknown>>;
  return editor(element.props);
};
const change = (
  tree: ReactElement,
  pick: (e: ReactElement<Record<string, unknown>>) => boolean,
  value: string,
) => {
  const found = visitElements(tree, pick);
  expect(found).not.toBeNull();
  (found!.props.onChange as (e: { currentTarget: { value: string } }) => void)({
    currentTarget: { value },
  });
};
const press = (tree: ReactElement, name: string) => {
  const found = visitElements(
    tree,
    (e) => e.props.children === name && typeof e.props.onClick === "function",
  );
  expect(found?.props.disabled).not.toBe(true);
  (found!.props.onClick as () => void)();
};
beforeEach(() => {
  hooks.reset();
  state.settings = { ...DEFAULT_UNIFIED_SETTINGS, threadSubordinateTeams: { [threadId]: [] } };
  state.save.mockReset();
  state.providers = [
    {
      instanceId: worker,
      driver: ProviderDriverKind.make("codex"),
      enabled: true,
      installed: true,
      version: null,
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-11-19T00:00:00Z",
      models: [
        { slug: "my-worker", name: "My worker", isCustom: false, capabilities: null },
        { slug: "second-worker", name: "Second worker", isCustom: false, capabilities: null },
      ],
      slashCommands: [],
      skills: [],
    },
  ];
});

it("distinguishes identically named accounts offering the same model in the team editor", () => {
  const first = ProviderInstanceId.make("first-account");
  const second = ProviderInstanceId.make("second-account");
  const fixture = state.providers[0]!;
  state.settings = {
    ...DEFAULT_UNIFIED_SETTINGS,
    threadSubordinateTeams: { [threadId]: [] },
    providerInstances: Object.fromEntries(
      [first, second].map((id) => [id, { driver: fixture.driver }]),
    ),
  };
  state.providers = [first, second].map((instanceId) => ({
    ...fixture,
    instanceId,
    displayName: "Matching account",
  }));
  const editor = renderTeam();
  for (const instanceId of [first, second]) {
    const option = visitElements(
      editor,
      (e) => e.type === "option" && e.props.value === JSON.stringify([instanceId, "my-worker"]),
    );
    expect(option?.props.children).toBe(`Matching account (${instanceId}) · My worker`);
  }
});

it("filters the add picker by provider without dropping a selected member from another family", () => {
  const claude = ProviderInstanceId.make("claudeAgent");
  state.providers.push({
    ...state.providers[0]!,
    instanceId: claude,
    driver: ProviderDriverKind.make("claudeAgent"),
    models: [{ slug: "sonnet", name: "Sonnet", isCustom: false, capabilities: null }],
  });
  state.settings = {
    ...state.settings!,
    threadSubordinateTeams: {
      [threadId]: [{ instanceId: claude, model: "sonnet", role: "worker" }],
    },
  };
  const filter = visitElements(
    renderTeam(),
    (element) =>
      typeof element.props.onChange === "function" &&
      Array.isArray(element.props.options) &&
      element.props.value === "all",
  );
  (filter!.props.onChange as (value: string) => void)("Codex");
  const tree = renderTeam();
  const add = visitElements(tree, (element) => element.props["aria-label"] === "하위 모델 추가")!;
  const row = visitElements(tree, (element) => element.props["aria-label"] === "1번 하위 모델")!;
  const sonnet = (element: ReactElement<Record<string, unknown>>) =>
    element.type === "option" && element.props.value === JSON.stringify([claude, "sonnet"]);
  expect(visitElements(add, sonnet)).toBeNull();
  expect(visitElements(row, sonnet)).not.toBeNull();
  expect(
    visitElements(add, (element) => element.props.value === JSON.stringify([worker, "my-worker"])),
  ).not.toBeNull();
});

it("saves a custom team for a non-Claude answering model including its role instructions", async () => {
  let saved: ThreadSubordinateTeamUpdate | undefined;
  state.save.mockImplementation(
    async ({
      input,
    }: {
      input: { patch: { threadSubordinateTeamUpdate: ThreadSubordinateTeamUpdate } };
    }) => {
      saved = input.patch.threadSubordinateTeamUpdate;
      return {
        _tag: "Success",
        value: { ...state.settings, threadSubordinateTeams: { [threadId]: saved.members } },
      };
    },
  );
  change(
    renderTeam(),
    (e) => e.type === "select" && e.props.value === "",
    JSON.stringify([worker, "my-worker"]),
  );
  change(renderTeam(), (e) => e.type === "select" && e.props.value === "worker", "advisor");
  change(renderTeam(), (e) => e.type === "textarea", "  근거를 검토해 주세요.  ");
  press(renderTeam(), "팀 저장");
  await Promise.resolve();
  expect(saved).toEqual({
    threadId,
    members: [
      {
        instanceId: worker,
        model: "my-worker",
        role: "advisor",
        instructions: "근거를 검토해 주세요.",
      },
    ],
  });
});

it("uses the global roster until a user explicitly chooses a room override", async () => {
  const member = {
    role: "worker" as const,
    instanceId: worker,
    model: "my-worker",
    instructions: "작업만 진행",
  };
  state.settings = { ...DEFAULT_UNIFIED_SETTINGS, globalSubordinateTeam: [member] };
  state.save.mockImplementation(
    async ({
      input,
    }: {
      input: { patch: { threadSubordinateTeamUpdate: ThreadSubordinateTeamUpdate } };
    }) => {
      state.settings = {
        ...state.settings!,
        threadSubordinateTeams: { [threadId]: input.patch.threadSubordinateTeamUpdate.members },
      };
      return { _tag: "Success", value: state.settings };
    },
  );
  expect(visitElements(renderTeam(), (e) => e.type === "textarea")).toBeNull();
  press(renderTeam(), "이 방에서 커스텀 사용");
  await Promise.resolve();
  expect(visitElements(renderTeam(), (e) => e.type === "textarea")?.props.value).toBe(
    "작업만 진행",
  );
  press(renderTeam(), "글로벌 팀 사용");
  await Promise.resolve();
  expect(state.settings.threadSubordinateTeams[threadId]).toBeNull();
  expect(state.settings.globalSubordinateTeam).toEqual([member]);
});

it("edits the environment global roster without sending a thread override", async () => {
  state.settings = DEFAULT_UNIFIED_SETTINGS;
  state.save.mockImplementation(async ({ input }) => ({
    _tag: "Success",
    value: { ...state.settings, ...input.patch },
  }));
  const editor = () => {
    hooks.beginRender();
    const element = GlobalSubordinateTeamEditor({ environmentId });
    const render = element.type as (input: typeof element.props) => ReactElement;
    return render(element.props);
  };
  change(
    editor(),
    (e) => e.props["aria-label"] === "하위 모델 추가",
    JSON.stringify([worker, "my-worker"]),
  );
  change(editor(), (e) => e.props["aria-label"] === "1번 역할", "diagnostician");
  press(editor(), "팀 저장");
  await Promise.resolve();
  expect(state.save).toHaveBeenCalledWith({
    environmentId,
    input: {
      patch: {
        globalSubordinateTeam: [{ role: "diagnostician", instanceId: worker, model: "my-worker" }],
      },
    },
  });
});

it("offers the design, verification and documentation roles next to the original ones", async () => {
  state.settings = {
    ...DEFAULT_UNIFIED_SETTINGS,
    globalSubordinateTeam: [{ role: "worker", instanceId: worker, model: "my-worker" }],
  };
  state.save.mockImplementation(async ({ input }) => ({
    _tag: "Success",
    value: { ...state.settings, ...input.patch },
  }));
  const editor = () => {
    hooks.beginRender();
    const element = GlobalSubordinateTeamEditor({ environmentId });
    return (element.type as (input: typeof element.props) => ReactElement)(element.props);
  };
  const select = visitElements(editor(), (e) => e.props["aria-label"] === "1번 역할")!;
  const options = (
    select.props.children as ReactElement<{ value: string; children: string }>[]
  ).map((option) => [option.props.value, option.props.children]);
  expect(options).toEqual(
    expect.arrayContaining([
      ["worker", "작업"],
      ["scout", "조사"],
      ["advisor", "검토"],
      ["planner", "설계"],
      ["tester", "검증"],
      ["writer", "문서화"],
    ]),
  );
  for (const role of ["planner", "tester", "writer"] as const) {
    change(editor(), (e) => e.props["aria-label"] === "1번 역할", role);
    press(editor(), "팀 저장");
    await Promise.resolve();
    expect(state.save).toHaveBeenLastCalledWith({
      environmentId,
      input: {
        patch: {
          globalSubordinateTeam: [{ role, instanceId: worker, model: "my-worker" }],
        },
      },
    });
    hooks.reset();
  }
});

it("keeps the room editor across parent model and account changes", () => {
  const original = ThreadModelTeamSettings(props);
  const otherRoom = ThreadModelTeamSettings({ ...props, threadId: ThreadId.make("chat-b") });
  const otherModel = ThreadModelTeamSettings({
    ...props,
    modelSelection: { ...parent, model: "other" },
  });
  const otherAccount = ThreadModelTeamSettings({
    ...props,
    modelSelection: { ...parent, instanceId: worker },
  });
  expect(original.key).toBe(otherModel.key);
  expect(original.key).toBe(otherAccount.key);
  expect(original.key).not.toBe(otherRoom.key);
});

it("adds, edits and removes multiple rows from the expanded list, changing only the opted-in room", async () => {
  state.save.mockImplementation(
    async ({
      input,
    }: {
      input: { patch: { threadSubordinateTeamUpdate: ThreadSubordinateTeamUpdate } };
    }) => {
      const { members } = input.patch.threadSubordinateTeamUpdate;
      state.settings = {
        ...DEFAULT_UNIFIED_SETTINGS,
        threadSubordinateTeams: { [threadId]: members },
      };
      return { _tag: "Success", value: state.settings };
    },
  );
  function choose(label: string, value: string) {
    change(renderTeam(), (e) => e.props["aria-label"] === label, value);
  }
  async function save(members: ThreadSubordinateTeamUpdate["members"]) {
    press(renderTeam(), "팀 저장");
    await Promise.resolve();
    expect(state.save).toHaveBeenLastCalledWith({
      environmentId,
      input: {
        patch: {
          threadSubordinateTeamUpdate: {
            threadId,
            members,
          },
        },
      },
    });
  }
  const first = JSON.stringify([worker, "my-worker"]);
  const second = JSON.stringify([worker, "second-worker"]);
  const initial = renderTeam();
  expect(initial.type).toBe("section");
  expect(initial.props["aria-label"]).toBe("하위 모델");
  expect(visitElements(initial, (e) => e.type === "details")).toBeNull();
  choose("하위 모델 추가", first);
  choose("하위 모델 추가", second);
  choose("2번 역할", "advisor");
  const member = { instanceId: worker, model: "my-worker", role: "worker" as const };
  await save([member, { instanceId: worker, model: "second-worker", role: "advisor" }]);
  choose("2번 하위 모델", first);
  choose("2번 역할", "worker");
  expect(visitElements(renderTeam(), (e) => e.props.children === "팀 저장")?.props.disabled).toBe(
    true,
  );
  choose("2번 역할", "scout");
  choose("2번 역할 세부 지시", "자료 확인");
  await save([member, { ...member, role: "scout", instructions: "자료 확인" }]);

  const remove = () => {
    const button = visitElements(
      renderTeam(),
      (e) => e.props["aria-label"] === "1번 하위 모델 제거",
    )!;
    (button.props.onClick as () => void)();
  };
  remove();
  await save([{ ...member, role: "scout", instructions: "자료 확인" }]);
  remove();
  await save([]);
  expect(state.save).toHaveBeenCalledTimes(4);
  expect(visitElements(renderTeam(), (e) => e.props.children === "하위 모델 없음")).not.toBeNull();
});

it("shows the team section without exposing writable controls before the room and general model are known", () => {
  for (const input of [
    { ...props, threadId: null },
    { ...props, modelSelection: null },
  ]) {
    const bar = ThreadModelTeamSettings(input);
    expect(bar.props["aria-label"]).toBe("하위 모델");
    expect(
      visitElements(bar, (e) => typeof e.props.onClick === "function" || e.type === "select"),
    ).toBeNull();
  }
  expect(state.save).not.toHaveBeenCalled();
});

it("keeps a single explicit draft team across parent changes and clears it on inherit or discard", () => {
  const draftId = DraftId.make("local-draft");
  const store = useComposerDraftStore.getState();
  store.setProjectDraftThreadId({ environmentId, projectId: ProjectId.make("project") }, draftId, {
    threadId,
  });
  const initial = store.getDraftSession(draftId)!;
  const fields = {
    title: "Draft",
    modelSelection: parent,
    runtimeMode: initial.runtimeMode,
    interactionMode: initial.interactionMode,
  };
  const create = () => buildDraftThreadCreateBootstrap(initial, draftId, fields).createThread!;
  const first = { ...props, draftId };
  const second = { ...first, modelSelection: { ...parent, model: "second-parent" } };
  try {
    press(renderTeam(first), "이 방에서 커스텀 사용");
    change(
      renderTeam(first),
      (e) => e.props["aria-label"] === "하위 모델 추가",
      JSON.stringify([worker, "my-worker"]),
    );
    change(renderTeam(first), (e) => e.type === "textarea", " 조사 ");
    press(renderTeam(first), "팀 저장");
    hooks.reset();
    expect(visitElements(renderTeam(second), (e) => e.type === "textarea")?.props.value).toBe(
      "조사",
    );
    expect(decodeBootstrap({ createThread: create() }).createThread).toMatchObject({
      modelSelection: parent,
      customSubordinateTeam: [
        { instanceId: worker, model: "my-worker", role: "worker", instructions: "조사" },
      ],
    });
    press(renderTeam(second), "글로벌 팀 사용");
    expect(store.getDraftSession(draftId)?.customSubordinateTeam).toBeUndefined();
    press(renderTeam(first), "이 방에서 커스텀 사용");
    store.clearDraftThread(draftId);
    expect(store.getDraftSession(draftId)?.customSubordinateTeam).toBeUndefined();
    expect(state.save).not.toHaveBeenCalled();
  } finally {
    store.clearDraftThread(draftId);
  }
});
