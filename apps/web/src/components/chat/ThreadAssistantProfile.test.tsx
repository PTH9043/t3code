import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, expect, it, vi } from "vite-plus/test";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";
import { visitElements } from "../../test/reactElementTree";

const state = vi.hoisted(() => ({
  globalProfile: { name: "공용", instructions: "공용 역할" },
  profiles: {
    "thread-a": { name: "현재", instructions: "현재 역할" },
    "thread-b": { name: "비서", instructions: "친절하게 설명" },
  },
  save: vi.fn(),
}));
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { ...actual, useState: reactHookHarness.useState, useEffect: () => {} };
});
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});
vi.mock("~/hooks/useSettings", () => ({
  useEnvironmentSettings: (_id: unknown, selector: (value: unknown) => unknown) =>
    selector({
      threadAssistantProfiles: state.profiles,
      globalAssistantProfile: state.globalProfile,
    }),
}));
vi.mock("~/state/environments", () => ({ usePrimaryEnvironmentId: () => null }));
vi.mock("~/state/server", () => ({ serverEnvironment: { updateSettings: "update" } }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => state.save }));
vi.mock("../control-center/controlCenterShared", () => ({ notifyCommandFailure: () => false }));
import { ThreadAssistantProfile } from "./ThreadAssistantProfile";

const props = {
  environmentId: EnvironmentId.make("environment-a"),
  threadId: ThreadId.make("thread-a"),
  computerAvailable: false,
};

beforeEach(() => {
  hooks.reset();
  state.save.mockReset().mockResolvedValue({ _tag: "Success" });
});

it("opens a new conversation in inherited mode without saving any role or model", () => {
  hooks.beginRender();
  const tree = ThreadAssistantProfile({ ...props, threadId: ThreadId.make("new-thread") });
  const scope = visitElements(tree, (e) => e.props["aria-label"] === "역할 적용 범위");
  expect(scope?.props.value).toBe("global");
  expect(visitElements(tree, (e) => e.type === "textarea")).toBeNull();
  expect(state.save).not.toHaveBeenCalled();
});

it("copies a chosen profile only after saving and only to the current conversation", async () => {
  const render = () => {
    hooks.beginRender();
    return ThreadAssistantProfile(props);
  };
  const select = visitElements(
    render(),
    (element) => element.props["aria-label"] === "다른 대화의 역할 가져오기",
  );
  expect(select).not.toBeNull();
  (select!.props.onChange as (event: unknown) => void)({ currentTarget: { value: "thread-b" } });
  expect(state.save).not.toHaveBeenCalled();
  const tree = render();
  expect(visitElements(tree, (element) => element.type === "input")?.props.value).toBe("비서");
  expect(visitElements(tree, (element) => element.type === "textarea")?.props.value).toBe(
    "친절하게 설명",
  );
  const form = visitElements(tree, (element) => element.type === "form");
  (form!.props.onSubmit as (event: unknown) => void)({ preventDefault() {} });
  expect(state.save).toHaveBeenCalledWith({
    environmentId: props.environmentId,
    input: {
      patch: {
        threadAssistantProfiles: {
          "thread-a": { mode: "custom", name: "비서", instructions: "친절하게 설명" },
        },
      },
    },
  });
  expect(state.profiles["thread-b"]).toEqual({ name: "비서", instructions: "친절하게 설명" });
});

it("can inherit the global role without dropping the custom role or touching a model selection", async () => {
  const render = () => {
    hooks.beginRender();
    return ThreadAssistantProfile(props);
  };
  const mode = visitElements(render(), (e) => e.props["aria-label"] === "역할 적용 범위")!;
  (mode.props.onChange as (e: unknown) => void)({ currentTarget: { value: "global" } });
  const tree = render();
  expect(visitElements(tree, (e) => e.type === "textarea")).toBeNull();
  (visitElements(tree, (e) => e.type === "form")!.props.onSubmit as (e: unknown) => void)({
    preventDefault() {},
  });
  expect(state.save).toHaveBeenCalledWith({
    environmentId: props.environmentId,
    input: {
      patch: {
        threadAssistantProfiles: {
          "thread-a": { mode: "global", name: "현재", instructions: "현재 역할" },
        },
      },
    },
  });
});
