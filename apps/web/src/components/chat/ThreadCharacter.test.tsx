import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, expect, it, vi } from "vite-plus/test";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";
import { visitElements } from "../../test/reactElementTree";

const state = vi.hoisted(() => ({ selected: "off", save: vi.fn() }));
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { ...actual, useState: reactHookHarness.useState };
});
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});
vi.mock("~/hooks/useSettings", () => ({
  useEnvironmentSettings: (_id: unknown, selector: (value: unknown) => unknown) =>
    selector({ threadCharacters: { "thread-a": state.selected } }),
}));
vi.mock("~/state/server", () => ({ serverEnvironment: { updateSettings: "update" } }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => state.save }));
vi.mock("../control-center/controlCenterShared", () => ({ notifyCommandFailure: () => false }));

import { ThreadCharacter } from "./ThreadCharacter";

beforeEach(() => {
  hooks.reset();
  state.selected = "off";
  state.save.mockReset().mockResolvedValue({ _tag: "Success" });
});

const props = {
  environmentId: EnvironmentId.make("environment-a"),
  threadId: ThreadId.make("thread-a"),
  isWorking: false,
};

it("saves the selection for only the current conversation", () => {
  hooks.beginRender();
  const tree = ThreadCharacter(props);
  const select = visitElements(tree, (element) => element.type === "select");
  (select!.props.onChange as (event: unknown) => void)({ currentTarget: { value: "vrm" } });
  expect(state.save).toHaveBeenCalledWith({
    environmentId: props.environmentId,
    input: { patch: { threadCharacters: { "thread-a": "vrm" } } },
  });
});

it("saves the GitHub character for the current conversation", () => {
  hooks.beginRender();
  const tree = ThreadCharacter(props);
  const select = visitElements(tree, (element) => element.type === "select");
  (select!.props.onChange as (event: unknown) => void)({ currentTarget: { value: "agustina" } });
  expect(state.save).toHaveBeenCalledWith({
    environmentId: props.environmentId,
    input: { patch: { threadCharacters: { "thread-a": "agustina" } } },
  });
});

it.each([
  ["type95", "95type_405"],
  ["k2", "k2_3301"],
  ["ots14", "ots14_3001"],
] as const)("saves and displays character %s", (character, folder) => {
  hooks.beginRender();
  const tree = ThreadCharacter(props);
  const select = visitElements(tree, (element) => element.type === "select");
  (select!.props.onChange as (event: unknown) => void)({ currentTarget: { value: character } });
  expect(state.save).toHaveBeenCalledWith({
    environmentId: props.environmentId,
    input: { patch: { threadCharacters: { "thread-a": character } } },
  });
  state.selected = character;
  hooks.reset();
  hooks.beginRender();
  const selectedTree = ThreadCharacter(props);
  expect(visitElements(selectedTree, (element) => element.type === "img")?.props.src).toBe(
    `/agent-characters/live2d-models/${folder}/preview.png`,
  );
});

it("falls back to the still image when the selected Live2D model fails", () => {
  state.selected = "k2";
  hooks.beginRender();
  const initial = ThreadCharacter(props);
  const model = visitElements(
    initial,
    (element) => element.props.character === "k2" && typeof element.props.onError === "function",
  );
  expect(model).not.toBeNull();
  (model!.props.onError as () => void)();
  hooks.beginRender();
  const fallback = ThreadCharacter(props);
  expect(visitElements(fallback, (element) => element.type === "img")?.props.src).toContain(
    "k2_3301",
  );
  expect(
    visitElements(
      fallback,
      (element) => element.props.children === "Live2D 연결 실패 · 정지 이미지",
    ),
  ).not.toBeNull();
});

it("uses the walking image only while work is active and honors reduced motion", () => {
  state.selected = "pixel";
  hooks.beginRender();
  const idle = ThreadCharacter(props);
  expect(visitElements(idle, (element) => element.type === "img")?.props.src).toContain(
    "pixel-idle.png",
  );
  hooks.beginRender();
  const working = ThreadCharacter({ ...props, isWorking: true });
  expect(visitElements(working, (element) => element.type === "img")?.props.src).toContain(
    "pixel-working.gif",
  );
  expect(visitElements(working, (element) => element.type === "source")?.props.media).toContain(
    "prefers-reduced-motion",
  );
});
