import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, expect, it, vi } from "vite-plus/test";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";
import { visitElements } from "../../test/reactElementTree";
import { ThreadBackgroundWatch } from "./ThreadBackgroundWatch";

const state = vi.hoisted(() => ({
  connected: true,
  settings: null as { backgroundWatchThreadIds?: readonly ThreadId[] } | null,
  settingsAtom: vi.fn(),
  update: vi.fn(),
}));
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { ...actual, useState: reactHookHarness.useState, useRef: reactHookHarness.useRef };
});
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => state.settings }));
vi.mock("../../state/server", () => ({
  serverEnvironment: { settingsValueAtom: state.settingsAtom, updateSettings: "update" },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.update }));
vi.mock("../../state/environments", () => ({
  useEnvironment: () => ({ connection: { phase: state.connected ? "connected" : "reconnecting" } }),
}));
const environmentId = EnvironmentId.make("remote-env");
const threadId = ThreadId.make("current-room");
const other = ThreadId.make("other-room");

function render() {
  hooks.beginRender();
  return ThreadBackgroundWatch({ environmentId, threadId });
}
const toggle = () =>
  visitElements(render(), (item) => item.props["aria-label"] === "이 대화의 백그라운드 감시");
const change = (value: boolean) =>
  (toggle()!.props.onCheckedChange as (value: boolean) => Promise<void>)(value);
const error = () => visitElements(render(), (item) => item.props.role === "alert");

beforeEach(() => {
  hooks.reset();
  state.connected = true;
  state.settings = { backgroundWatchThreadIds: [other] };
  state.update.mockReset();
  state.settingsAtom.mockClear();
});

it("sends only the current room patch and displays the acknowledged state, then follows remote changes", async () => {
  expect(toggle()!.props.checked).toBe(false);
  expect(state.settingsAtom).toHaveBeenCalledWith(environmentId);
  expect(state.update).not.toHaveBeenCalled();
  state.update.mockResolvedValueOnce({
    _tag: "Success",
    value: { backgroundWatchThreadIds: [other, threadId] },
  });
  await change(true);
  expect(toggle()!.props.checked).toBe(true);
  state.settings = { backgroundWatchThreadIds: [other, threadId] };
  state.update.mockResolvedValueOnce({
    _tag: "Success",
    value: { backgroundWatchThreadIds: [other] },
  });
  await change(false);
  expect(toggle()!.props.checked).toBe(false);
  expect(state.update.mock.calls).toEqual(
    [true, false].map((enabled) => [
      {
        environmentId,
        input: { patch: { backgroundWatchThreadUpdate: { threadId, enabled } } },
      },
    ]),
  );
  state.settings = { backgroundWatchThreadIds: [other, threadId] };
  expect(toggle()!.props.checked).toBe(true);
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
  expect(toggle()!.props.checked).toBe(false);
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
