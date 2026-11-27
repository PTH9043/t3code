import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, expect, it, vi } from "vite-plus/test";
import { reactHookHarness as hooks } from "../../../../web/src/test/reactHookHarness";
import { visitElements } from "../../../../web/src/test/reactElementTree";
import { ThreadBackgroundWatch } from "./ThreadBackgroundWatch";

const state = vi.hoisted(() => ({
  connected: true,
  settings: null as { backgroundWatchThreadIds?: readonly ThreadId[] } | null,
  settingsAtom: vi.fn(),
  update: vi.fn(),
}));
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  const { reactHookHarness } = await import("../../../../web/src/test/reactHookHarness");
  return { ...actual, useState: reactHookHarness.useState, useRef: reactHookHarness.useRef };
});
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../../../web/src/test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => state.settings }));
vi.mock("../../state/server", () => ({
  serverEnvironment: { settingsValueAtom: state.settingsAtom, updateSettings: "update" },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.update }));
vi.mock("react-native", () => ({
  Modal: "Modal",
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  Switch: "Switch",
  View: "View",
}));
vi.mock("react-native-safe-area-context", () => ({ SafeAreaView: "SafeAreaView" }));
vi.mock("../../components/AppText", () => ({ AppText: "Text" }));
const environmentId = EnvironmentId.make("remote-env");
const threadId = ThreadId.make("current-room");
const other = ThreadId.make("other-room");

function render() {
  hooks.beginRender();
  return ThreadBackgroundWatch({ environmentId, threadId, connected: state.connected });
}
const toggle = () =>
  visitElements(render(), (item) => item.props.accessibilityLabel === "이 대화의 백그라운드 감시");
const change = (value: boolean) =>
  (toggle()!.props.onValueChange as (value: boolean) => Promise<void>)(value);
const error = () => visitElements(render(), (item) => item.props.accessibilityRole === "alert");

beforeEach(() => {
  hooks.reset();
  state.connected = true;
  state.settings = { backgroundWatchThreadIds: [other] };
  state.update.mockReset();
  state.settingsAtom.mockClear();
});

it("opens the Korean settings sheet from the composer control without making a change", () => {
  const trigger = visitElements(
    render(),
    (item) => item.props.accessibilityLabel === "이 대화의 백그라운드 감시 · 꺼짐",
  );
  (trigger!.props.onPress as () => void)();
  expect(visitElements(render(), (item) => item.props.visible === true)).not.toBeNull();
  expect(
    visitElements(
      render(),
      (item) =>
        typeof item.props.children === "string" &&
        item.props.children.includes("진행 중인 답변은 계속됩니다"),
    ),
  ).not.toBeNull();
  expect(state.update).not.toHaveBeenCalled();
});

it("sends only the current room patch and displays the acknowledged state, then follows remote changes", async () => {
  expect(toggle()!.props.value).toBe(false);
  expect(state.settingsAtom).toHaveBeenCalledWith(environmentId);
  expect(state.update).not.toHaveBeenCalled();
  state.update.mockResolvedValueOnce({
    _tag: "Success",
    value: { backgroundWatchThreadIds: [other, threadId] },
  });
  await change(true);
  expect(toggle()!.props.value).toBe(true);
  state.settings = { backgroundWatchThreadIds: [other, threadId] };
  state.update.mockResolvedValueOnce({
    _tag: "Success",
    value: { backgroundWatchThreadIds: [other] },
  });
  await change(false);
  expect(toggle()!.props.value).toBe(false);
  expect(state.update.mock.calls).toEqual(
    [true, false].map((enabled) => [
      {
        environmentId,
        input: { patch: { backgroundWatchThreadUpdate: { threadId, enabled } } },
      },
    ]),
  );
  state.settings = { backgroundWatchThreadIds: [other, threadId] };
  expect(toggle()!.props.value).toBe(true);
});

it("blocks a second tap while pending and reports a rejected or unacknowledged change", async () => {
  let reject!: () => void;
  state.update.mockImplementationOnce(
    () =>
      new Promise((_, fail) => {
        reject = () => fail(new Error("disconnected"));
      }),
  );
  const first = change(true);
  expect(toggle()!.props.disabled).toBe(true);
  await change(true);
  expect(state.update).toHaveBeenCalledTimes(1);
  reject();
  await first;
  expect(error()).not.toBeNull();
  expect(toggle()!.props.value).toBe(false);
  state.update.mockResolvedValueOnce({
    _tag: "Success",
    value: { backgroundWatchThreadIds: [other] },
  });
  await change(true);
  expect(error()).not.toBeNull();
  expect(toggle()!.props.disabled).toBe(false);
});

it("offers no change while disconnected or without the room setting", () => {
  state.connected = false;
  expect(toggle()).toBeNull();
  state.connected = true;
  state.settings = null;
  expect(toggle()).toBeNull();
  state.settings = {};
  expect(toggle()).toBeNull();
  expect(state.update).not.toHaveBeenCalled();
});
