import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, expect, it, vi } from "vite-plus/test";
import { reactHookHarness as hooks } from "../../../../web/src/test/reactHookHarness";
import { visitElements } from "../../../../web/src/test/reactElementTree";

const state = vi.hoisted(() => ({
  settings: null as null | {
    globalResponseStyle?: null | Record<
      "preset" | "tone" | "length" | "explanation" | "instructions",
      string
    >;
    threadResponseStyles: Record<
      string,
      {
        preset: string;
        tone: string;
        length: string;
        explanation: string;
        instructions: string;
      }
    >;
  },
  update: vi.fn(),
}));
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  const { reactHookHarness } = await import("../../../../web/src/test/reactHookHarness");
  return { ...actual, useState: reactHookHarness.useState, useEffect: () => {} };
});
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../../../web/src/test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});
vi.mock("react-native", () => ({
  Modal: "Modal",
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  TextInput: "TextInput",
  View: "View",
}));
vi.mock("react-native-safe-area-context", () => ({
  SafeAreaView: "SafeAreaView",
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 24, left: 0 }),
}));
vi.mock("../../components/AppText", () => ({ AppText: "Text" }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => state.settings }));
vi.mock("../../state/server", () => ({
  serverEnvironment: { settingsValueAtom: () => "settings", updateSettings: "update" },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.update }));
import { ThreadResponseStyleSettings } from "./ThreadResponseStyleSettings";

const environmentId = EnvironmentId.make("environment-a");
const threadId = ThreadId.make("thread-a");
const render = () => {
  hooks.beginRender();
  return ThreadResponseStyleSettings({ environmentId, threadId });
};
const element = (label: string) =>
  visitElements(render(), (item) => item.props.accessibilityLabel === label);
const press = (label: string) => (element(label)!.props.onPress as () => void)();
const type = (label: string, value: string) =>
  (element(label)!.props.onChangeText as (value: string) => void)(value);

beforeEach(() => {
  hooks.reset();
  state.settings = {
    threadResponseStyles: {
      "thread-b": {
        preset: "friendly",
        tone: "친구",
        length: "",
        explanation: "",
        instructions: "다른 대화",
      },
    },
  };
  state.update.mockReset();
});

it("offers five presets and defaults a new conversation", () => {
  expect(element("기본")?.props.accessibilityState).toMatchObject({ selected: true });
  for (const label of ["간결", "상세", "친근", "전문"]) {
    expect(element(label)?.props.accessibilityState).toMatchObject({ selected: false });
  }
});

it("saves the selected style to the current environment and conversation", async () => {
  const style = {
    preset: "detailed",
    tone: "존댓말",
    length: "길게",
    explanation: "단계별",
    instructions: "표 사용",
  };
  state.update.mockResolvedValue({
    _tag: "Success",
    value: { threadResponseStyles: { "thread-a": style } },
  });
  press("이 대화의 답변 스타일 설정");
  press("상세");
  type("말투", style.tone);
  type("답변 길이", style.length);
  type("설명 방식", style.explanation);
  type("자유 지시", style.instructions);
  expect(state.update).not.toHaveBeenCalled();
  press("답변 스타일 저장");
  await Promise.resolve();
  expect(state.update).toHaveBeenCalledWith({
    environmentId,
    input: { patch: { threadResponseStyles: { "thread-a": style } } },
  });
  expect(state.settings?.threadResponseStyles["thread-b"]?.instructions).toBe("다른 대화");
  expect(element("상세")?.props.accessibilityState).toMatchObject({ selected: true });
  expect(
    visitElements(
      render(),
      (item) => item.props.children === "저장했습니다. 다음 요청부터 적용됩니다.",
    ),
  ).not.toBeNull();
  press("답변 스타일 닫기");
  press("이 대화의 답변 스타일 설정");
  expect(element("말투")?.props.value).toBe("존댓말");
});

it("loads saved custom fields and retains them when the preset changes", () => {
  state.settings!.threadResponseStyles["thread-a"] = {
    preset: "concise",
    tone: "존댓말",
    length: "",
    explanation: "",
    instructions: "요점",
  };
  expect(element("간결")?.props.accessibilityState).toMatchObject({ selected: true });
  press("전문");
  expect(element("말투")?.props.value).toBe("존댓말");
  expect(element("자유 지시")?.props.value).toBe("요점");
});

it("retains edits and reports errors if the server rejects or drops the setting", async () => {
  state.update.mockResolvedValue({ _tag: "Success", value: { threadResponseStyles: {} } });
  type("말투", "존댓말");
  press("답변 스타일 저장");
  await Promise.resolve();
  expect(element("말투")?.props.value).toBe("존댓말");
  expect(
    visitElements(render(), (item) => item.props.accessibilityRole === "alert"),
  ).not.toBeNull();
  expect(element("답변 스타일 저장")?.props.disabled).toBe(false);
});

it("keeps the form editable after a failed save", async () => {
  state.update.mockResolvedValue({ _tag: "Failure" });
  type("자유 지시", "항목별로 설명");
  press("답변 스타일 저장");
  await Promise.resolve();
  expect(element("자유 지시")?.props.value).toBe("항목별로 설명");
  expect(element("답변 스타일 저장")?.props.disabled).toBe(false);
  expect(
    visitElements(render(), (item) => item.props.accessibilityRole === "alert"),
  ).not.toBeNull();
});

it("prevents editing and duplicate saves while a request is pending", async () => {
  let finish!: (value: unknown) => void;
  state.update.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  type("말투", "정중하게");
  press("답변 스타일 저장");
  expect(element("말투")?.props.editable).toBe(false);
  expect(element("답변 스타일 저장")?.props.disabled).toBe(true);
  press("답변 스타일 저장");
  expect(state.update).toHaveBeenCalledTimes(1);
  finish({ _tag: "Failure" });
  await Promise.resolve();
});

it("does not save while environment settings are unavailable", () => {
  state.settings = null;
  expect(element("답변 스타일 저장")?.props.disabled).toBe(true);
  press("답변 스타일 저장");
  expect(state.update).not.toHaveBeenCalled();
});

const blank = { preset: "default", tone: "", length: "", explanation: "", instructions: "" };

it("shows that a conversation follows the global style and returns to it on request", async () => {
  expect(JSON.stringify(render())).toContain("전역 스타일 사용 중");
  expect(element("전역 스타일 사용")).toBeNull();
  state.settings!.threadResponseStyles["thread-a"] = {
    ...blank,
    preset: "concise",
    instructions: "요점",
  };
  hooks.reset();
  expect(JSON.stringify(render())).not.toContain("전역 스타일 사용 중");
  state.update.mockResolvedValue({
    _tag: "Success",
    value: { threadResponseStyles: { "thread-a": blank } },
  });
  press("전역 스타일 사용");
  await Promise.resolve();
  expect(state.update).toHaveBeenCalledExactlyOnceWith({
    environmentId,
    input: { patch: { threadResponseStyles: { "thread-a": blank } } },
  });
  expect(
    visitElements(
      render(),
      (item) => item.props.children === "이 대화는 전역 답변 스타일을 따릅니다.",
    ),
  ).not.toBeNull();
});

it("edits the global style outside a conversation and clears it", async () => {
  const renderGlobal = () => {
    hooks.beginRender();
    return ThreadResponseStyleSettings({ environmentId });
  };
  const tap = (pick: Parameters<typeof visitElements>[1]) =>
    (visitElements(renderGlobal(), pick)!.props.onPress as () => void)();
  const labelled = (label: string) => (item: { props: Record<string, unknown> }) =>
    item.props.accessibilityLabel === label;
  expect(JSON.stringify(renderGlobal())).toContain("미설정");
  tap(labelled("전역 답변 스타일 설정"));
  tap(labelled("전문"));
  const style = { ...blank, preset: "professional" };
  state.update.mockResolvedValue({
    _tag: "Success",
    value: { globalResponseStyle: style, threadResponseStyles: {} },
  });
  tap(labelled("답변 스타일 저장"));
  await Promise.resolve();
  expect(state.update).toHaveBeenLastCalledWith({
    environmentId,
    input: { patch: { globalResponseStyle: style } },
  });
  state.settings = { ...state.settings!, globalResponseStyle: style };
  hooks.reset();
  expect(JSON.stringify(renderGlobal())).not.toContain("미설정");
  state.update.mockResolvedValue({
    _tag: "Success",
    value: { globalResponseStyle: null, threadResponseStyles: {} },
  });
  tap(
    (item) =>
      item.type === "Pressable" &&
      (item.props.children as { props?: { children?: unknown } } | undefined)?.props?.children ===
        "전역 스타일 해제",
  );
  await Promise.resolve();
  expect(state.update).toHaveBeenLastCalledWith({
    environmentId,
    input: { patch: { globalResponseStyle: null } },
  });
});
