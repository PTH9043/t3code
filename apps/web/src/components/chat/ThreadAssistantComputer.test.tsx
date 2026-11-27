import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, expect, it, vi } from "vite-plus/test";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";
import { visitElements } from "../../test/reactElementTree";

const state = vi.hoisted(() => ({
  settings: { threadAssistantComputers: {}, threadCreatorModes: { "other-chat": true } },
  update: vi.fn(),
}));
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
    selector(state.settings),
  useUpdateEnvironmentSettings: () => state.update,
}));
vi.mock("~/state/server", () => ({ serverEnvironment: { assistantComputerControl: "control" } }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../control-center/controlCenterShared", () => ({ notifyCommandFailure: () => false }));
import { ThreadAssistantComputer } from "./ThreadAssistantComputer";

beforeEach(() => {
  hooks.reset();
  state.update.mockReset();
});

it("enables Creator only for the selected conversation and explains restart behavior", () => {
  hooks.beginRender();
  const tree = ThreadAssistantComputer({
    environmentId: EnvironmentId.make("environment-a"),
    threadId: ThreadId.make("current-chat"),
  });
  const checkbox = visitElements(
    tree,
    (element) => element.type === "input" && element.props.type === "checkbox",
  );
  expect(checkbox?.props.checked).toBe(false);
  (checkbox!.props.onChange as (event: unknown) => void)({ currentTarget: { checked: true } });
  expect(state.update).toHaveBeenCalledWith({ threadCreatorModes: { "current-chat": true } });
  expect(state.settings.threadCreatorModes["other-chat"]).toBe(true);
  expect(
    visitElements(
      tree,
      (element) =>
        element.type === "p" &&
        String(element.props.children).includes("자동으로 실행되지 않습니다"),
    ),
  ).not.toBeNull();
});
