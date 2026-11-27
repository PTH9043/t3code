import { EnvironmentId } from "@t3tools/contracts";
import { beforeEach, expect, it, vi } from "vite-plus/test";
import { reactHookHarness as hooks } from "../../../../web/src/test/reactHookHarness";
import { visitElements } from "../../../../web/src/test/reactElementTree";
import { BackgroundWatchNoticeSettings } from "./BackgroundWatchNoticeSettings";

const setup = vi.hoisted(() => ({ update: vi.fn(), environmentId: "remote" }));
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  const { reactHookHarness } = await import("../../../../web/src/test/reactHookHarness");
  return { ...actual, useState: reactHookHarness.useState };
});
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../../../web/src/test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});
vi.mock("react-native", () => ({ Pressable: "Pressable", TextInput: "TextInput", View: "View" }));
vi.mock("../../components/AppText", () => ({ AppText: "Text" }));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => ({ backgroundWatchNoticeSeconds: 30 }),
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: { settingsValueAtom: vi.fn(), updateSettings: "update" },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => setup.update }));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({
    environments: [{ environmentId: setup.environmentId, label: "Remote" }],
  }),
}));

beforeEach(() => {
  hooks.reset();
  setup.update.mockReset();
});
it("shows saved seconds and saves zero only to the selected environment", async () => {
  hooks.beginRender();
  const row = BackgroundWatchNoticeSettings()[0]!;
  const render = () => {
    hooks.beginRender();
    return row.type(row.props);
  };
  hooks.reset();
  const input = () =>
    visitElements(
      render(),
      (node) => node.props.accessibilityLabel === "Remote 감시 중단 알림 표시 시간(초)",
    )!;
  const save = () =>
    visitElements(
      render(),
      (node) => node.props.accessibilityLabel === "Remote 중단 알림 시간 저장",
    )!;
  expect(input().props.value).toBe("30");
  (input().props.onChangeText as (value: string) => void)("-2");
  expect(save().props.disabled).toBe(true);
  (input().props.onChangeText as (value: string) => void)("0");
  expect(save().props.disabled).toBe(false);
  setup.update.mockResolvedValue({ _tag: "Success" });
  await (save().props.onPress as () => Promise<void>)();
  expect(setup.update).toHaveBeenCalledExactlyOnceWith({
    environmentId: EnvironmentId.make("remote"),
    input: { patch: { backgroundWatchNoticeSeconds: 0 } },
  });
});
