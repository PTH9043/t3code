import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerSettings,
} from "@t3tools/contracts";
import { beforeEach, expect, it, vi } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";

import { visitElements } from "~/test/reactElementTree";
import { reactHookHarness as hooks } from "~/test/reactHookHarness";
import { OpenRouterConnectionDialog } from "./OpenRouterConnectionDialog";
import { QianfanConnectionDialog } from "./QianfanConnectionDialog";
import { searchSettings } from "./settingsSearch";
import { SearchModelsEditor, SearchModelsSettingsSection } from "./SearchModelsSettings";

const env = EnvironmentId.make("fixture-environment");
const state = vi.hoisted(() => ({ settings: null as ServerSettings | null, save: vi.fn() }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => state.settings }));
vi.mock("~/state/environments", () => ({
  usePrimaryEnvironmentId: () => EnvironmentId.make("fixture-environment"),
}));
vi.mock("~/state/server", () => ({
  serverEnvironment: { settingsValueAtom: vi.fn(), updateSettings: "update" },
}));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => state.save }));
vi.mock("react", async (original) => {
  const real = await original<typeof import("react")>();
  const { reactHookHarness: harness } = await import("~/test/reactHookHarness");
  return { ...real, useState: harness.useState, useRef: harness.useRef, useMemo: harness.useMemo };
});
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness: harness } = await import("~/test/reactHookHarness");
  return { c: harness.useMemoCache };
});

function account(displayName: string, models: string[], baseUrl: string, enabled = true) {
  return {
    displayName,
    enabled,
    driver: ProviderDriverKind.make("opencode"),
    config: {
      apiConnection: { providerId: "t3_api", baseUrl, models, protocol: "chat-completions" },
    },
    environment: [{ name: "fixture", value: "private-fixture-marker", sensitive: true }],
  };
}

beforeEach(() => {
  hooks.reset();
  state.save.mockReset().mockImplementation(async ({ input }) => {
    state.settings = { ...state.settings!, ...input.patch };
    return { _tag: "Success", value: state.settings };
  });
  state.settings = {
    ...DEFAULT_SERVER_SETTINGS,
    searchModels: [],
    providerInstances: {
      [ProviderInstanceId.make("first")]: account(
        "등록 계정 1",
        ["shared-model", "first-model"],
        "https://qianfan.baidubce.com/v2",
      ),
      [ProviderInstanceId.make("second")]: account(
        "등록 계정 2",
        ["shared-model", "second-model"],
        "https://qianfan.baidubce.com/v2/",
      ),
      [ProviderInstanceId.make("custom")]: account(
        "다른 API",
        ["custom-model"],
        "https://example.test/v1",
      ),
      [ProviderInstanceId.make("disabled")]: account(
        "비활성 계정",
        ["disabled-model"],
        "https://qianfan.baidubce.com/v2",
        false,
      ),
    },
  };
});

function render() {
  hooks.beginRender();
  return SearchModelsEditor({ environmentId: env });
}
function control(name: string) {
  const element = visitElements(
    render(),
    ({ props }) =>
      props["aria-label"] === name ||
      props.children === name ||
      (Array.isArray(props.children) && props.children.includes(name)),
  );
  if (!element) throw new Error("Missing control: " + name);
  return element.props;
}
function click(label: string) {
  const props = control(label);
  expect(props.disabled).not.toBe(true);
  (props.onClick as () => void)();
}
function select(label: string, value: string) {
  (control(label).onChange as (event: { currentTarget: { value: string } }) => void)({
    currentTarget: { value },
  });
}
function options(name: string) {
  const options: string[] = [];
  visitElements(control(name).children, (el) => {
    if (el.type === "option") options.push(String(el.props.value));
    return false;
  });
  return options;
}

it("opens from General settings search and does not present unloaded settings as an empty list", () => {
  expect(searchSettings("검색용 모델")[0]).toMatchObject({
    id: "search-models",
    to: "/settings/general",
  });
  hooks.beginRender();
  const section = SearchModelsSettingsSection();
  expect(section.props.id).toBe("search-models");
  expect(visitElements(section, (el) => el.type === SearchModelsEditor)?.props.environmentId).toBe(
    env,
  );
  state.settings = null;
  expect(renderToStaticMarkup(render())).toContain("불러오는 중");
  expect(state.save).not.toHaveBeenCalled();
});

it("hides Baidu-only guidance by default and reveals the Qianfan registration dialog conditionally when Baidu is selected", () => {
  state.settings = { ...DEFAULT_SERVER_SETTINGS, providerInstances: {}, searchModels: [] };
  const initial = renderToStaticMarkup(render());
  const buttonLabel = "바이두(Baidu) Qianfan 계정 연결";
  expect(initial).not.toContain("Qianfan 계정을 연결한 뒤");
  expect(initial).not.toContain(`>${buttonLabel}</button>`);

  // Selecting Baidu in the multi-provider quick-add selector conditionally surfaces Qianfan controls.
  select("검색 모델 제공자 선택", "baidu");
  const baiduView = renderToStaticMarkup(render());
  expect(baiduView).toContain(`>${buttonLabel}</button>`);
  expect(searchSettings("바이두")).toContainEqual({
    id: "baidu-search-account",
    title: buttonLabel,
    to: "/settings/general",
    targetId: "search-models",
  });
  expect(baiduView).toContain("Qianfan 계정을 연결한 뒤");
  const dialog = () => visitElements(render(), (el) => el.type === QianfanConnectionDialog);
  expect(dialog()).toBeNull();
  click(buttonLabel);
  expect(dialog()?.props).toMatchObject({ open: true, environmentId: env });
  (dialog()!.props.onOpenChange as (open: boolean) => void)(false);
  expect(dialog()).toBeNull();
  expect(state.save).not.toHaveBeenCalled();

  click("모델 추가");
  select("1번째 검색 모델 공급자", "baidu");
  expect(options("1번째 검색 모델 계정")).toEqual([""]);
  expect(control("검색용 모델 저장").disabled).toBe(true);
  click(buttonLabel);
  // The existing dialog registers an account in this environment. Simulate its settings update.
  const id = ProviderInstanceId.make("qianfan_fixture");
  state.settings = {
    ...state.settings,
    providerInstances: {
      [id]: account("새 Qianfan 계정", ["registered-model"], "https://qianfan.baidubce.com/v2"),
    },
  };
  (dialog()!.props.onOpenChange as (open: boolean) => void)(false);
  expect(options("1번째 검색 모델 계정")).toEqual(["", id]);
  expect(control("1번째 검색 모델 계정").value).toBe("");
  select("1번째 검색 모델 계정", id);
  select("1번째 검색 모델 ID", "registered-model");
  expect(control("검색용 모델 저장").disabled).toBe(false);
  expect(state.save).not.toHaveBeenCalled();
});

it("explains Gemini’s display-only Google report and analysis of another API’s sources before adding rows", () => {
  state.settings = { ...DEFAULT_SERVER_SETTINGS, providerInstances: {}, searchModels: [] };
  const markup = renderToStaticMarkup(render());
  expect(markup).toContain("Google 검색 보고서는 화면에만 표시");
  expect(markup).toContain("다른 API가 찾은 출처를 Gemini로 분석");
  expect(markup).toContain("자동 검색 순서에는 포함되지 않습니다");
  click("모델 추가");
  expect(
    visitElements(control("1번째 검색 모델 공급자").children, (el) => el.props.value === "gemini")
      ?.props.disabled,
  ).toBe(true);
});

it("saves only the ordered search patch and the exact registered Baidu and custom account/model pairs", async () => {
  click("모델 추가");
  expect(control("검색용 모델 저장").disabled).toBe(true);
  select("1번째 검색 모델 ID", " search-one ");
  click("모델 추가");
  select("2번째 검색 모델 공급자", "baidu");
  expect(options("2번째 검색 모델 계정")).toEqual(["", "first", "second"]);
  select("2번째 검색 모델 계정", "first");
  select("2번째 검색 모델 ID", "first-model");
  select("2번째 검색 모델 계정", "second");
  expect(control("2번째 검색 모델 ID").value).toBe("");
  expect(options("2번째 검색 모델 ID")).toEqual(["", "shared-model", "second-model"]);
  select("2번째 검색 모델 ID", "shared-model");
  click("모델 추가");
  select("3번째 검색 모델 공급자", "custom");
  select("3번째 검색 모델 계정", "custom");
  select("3번째 검색 모델 ID", "custom-model");
  click("2번째 검색 모델 위로");
  click("2번째 검색 모델 아래로");
  expect(control("1번째 검색 모델 위로").disabled).toBe(true);
  expect(control("3번째 검색 모델 아래로").disabled).toBe(true);
  const markup = renderToStaticMarkup(render());
  expect(
    visitElements(control("1번째 검색 모델 공급자").children, (el) => el.props.value === "baidu")
      ?.props.children,
  ).toBe("바이두(Baidu) Qianfan");
  expect(markup).not.toContain("private-fixture-marker");
  expect(state.save).not.toHaveBeenCalled();
  click("검색용 모델 저장");
  const searchModels = [
    { provider: "baidu", model: "shared-model", apiInstanceId: "second" },
    { provider: "custom", model: "custom-model", apiInstanceId: "custom" },
    { provider: "xai", model: "search-one" },
  ];
  await vi.waitFor(() =>
    expect(state.save).toHaveBeenCalledExactlyOnceWith({
      environmentId: env,
      input: { patch: { searchModels } },
    }),
  );
  hooks.reset();
  expect(control("1번째 검색 모델 계정").value).toBe("second");
  expect(control("3번째 검색 모델 ID").value).toBe("search-one");
  for (let i = 0; i < 3; i++) click("1번째 검색 모델 삭제");
  click("검색용 모델 저장");
  expect(state.save).toHaveBeenLastCalledWith({
    environmentId: env,
    input: { patch: { searchModels: [] } },
  });
});

it("lists exact registered account/model pairs per selected provider and saves only the chosen order", () => {
  const quickPick = "검색 순서에 추가할 모델 선택";
  const pair = (id: string, model: string) => JSON.stringify([id, model]);
  const originalOrder = [{ provider: "xai" as const, model: "existing" }];
  const originalInstances = state.settings!.providerInstances;
  state.settings = { ...state.settings!, searchModels: originalOrder };
  select("검색 모델 제공자 선택", "baidu");
  expect(options(quickPick)).toEqual([
    "",
    pair("first", "shared-model"),
    pair("first", "first-model"),
    pair("second", "shared-model"),
    pair("second", "second-model"),
    pair("disabled", "disabled-model"),
    "manual-entry",
  ]);
  const option = (id: string, model: string) =>
    visitElements(
      control(quickPick).children,
      (el) => el.type === "option" && el.props.value === pair(id, model),
    )!.props;
  expect(option("disabled", "disabled-model").disabled).toBe(true);
  select(quickPick, pair("disabled", "disabled-model"));
  expect(control("검색용 모델 저장").disabled).toBe(true);
  select(quickPick, pair("second", "shared-model"));
  expect(control("2번째 검색 모델 계정").value).toBe("second");
  expect(option("second", "shared-model").disabled).toBe(true);
  expect(option("first", "shared-model").disabled).toBe(false);
  expect(state.settings.searchModels).toBe(originalOrder);
  expect(state.save).not.toHaveBeenCalled();
  click("검색용 모델 저장");
  expect(state.save).toHaveBeenCalledExactlyOnceWith({
    environmentId: env,
    input: {
      patch: {
        searchModels: [
          ...originalOrder,
          { provider: "baidu", apiInstanceId: "second", model: "shared-model" },
        ],
      },
    },
  });
  expect(state.settings.providerInstances).toBe(originalInstances);
});

it("keeps Baidu selectable with no account and makes no runnable model from the documented example", () => {
  state.settings = { ...DEFAULT_SERVER_SETTINGS, providerInstances: {}, searchModels: [] };
  const quickPick = "검색 순서에 추가할 모델 선택";
  select("검색 모델 제공자 선택", "baidu");
  expect(options(quickPick)).toEqual(["", "manual-entry"]);
  expect(renderToStaticMarkup(render())).toContain("모델 ID 입력 예: ernie-5.1");
  select(quickPick, "manual-entry");
  expect(control("1번째 검색 모델 공급자").value).toBe("baidu");
  expect(control("1번째 검색 모델 계정").value).toBe("");
  expect(control("1번째 검색 모델 ID").value).toBe("");
  expect(control("검색용 모델 저장").disabled).toBe(true);
  expect(state.save).not.toHaveBeenCalled();
});

it("offers Qianfan only under Baidu and keeps misconfigured Qianfan accounts out of custom", () => {
  const broken = account("잘못된 연결", ["model"], "https://example.test/v1");
  state.settings = {
    ...state.settings!,
    providerInstances: {
      ...state.settings!.providerInstances,
      [ProviderInstanceId.make("qianfan_broken")]: broken,
      [ProviderInstanceId.make("named")]: {
        ...broken,
        config: { apiConnection: { ...broken.config.apiConnection, providerId: "t3_qianfan" } },
      },
    },
  };
  click("모델 추가");
  select("1번째 검색 모델 공급자", "custom");
  expect(options("1번째 검색 모델 계정")).toEqual(["", "custom"]);
  select("1번째 검색 모델 공급자", "baidu");
  expect(options("1번째 검색 모델 계정")).toEqual(["", "first", "second"]);
});

it("preserves a legacy Qianfan row and blocks its duplicate until a different account is selected", () => {
  const native = { provider: "openai", model: "native-model" } as const;
  const legacy = { provider: "custom", apiInstanceId: "first", model: "shared-model" } as const;
  const baidu = { ...legacy, provider: "baidu" } as const;
  const custom = { provider: "custom", apiInstanceId: "custom", model: "custom-model" } as const;
  const saved = [native, legacy, custom, baidu];
  state.settings = { ...state.settings!, searchModels: saved };
  expect(control("2번째 검색 모델 공급자").value).toBe("baidu");
  expect(control("2번째 검색 모델 계정").value).toBe("first");
  expect(control("2번째 검색 모델 ID").value).toBe("shared-model");
  expect(state.settings.searchModels).toBe(saved);
  expect(saved[1]?.provider).toBe("custom");
  expect(state.save).not.toHaveBeenCalled();
  click("4번째 검색 모델 위로");
  expect(renderToStaticMarkup(render())).toContain("2번째와 3번째 검색 모델이 중복됩니다");
  expect(control("검색용 모델 저장").disabled).toBe(true);
  (control("검색용 모델 저장").onClick as () => void)();
  expect(state.save).not.toHaveBeenCalled();
  select("3번째 검색 모델 ID", "first-model");
  expect(control("검색용 모델 저장").disabled).toBe(false);
  select("3번째 검색 모델 계정", "second");
  select("3번째 검색 모델 ID", "shared-model");
  click("검색용 모델 저장");
  expect(state.save).toHaveBeenCalledExactlyOnceWith({
    environmentId: env,
    input: {
      patch: { searchModels: [native, baidu, { ...baidu, apiInstanceId: "second" }, custom] },
    },
  });
});

it("validates newly entered duplicates after trimming the model ID", () => {
  click("모델 추가");
  select("1번째 검색 모델 ID", "test-model");
  click("모델 추가");
  select("2번째 검색 모델 ID", " test-model ");
  expect(control("검색용 모델 저장").disabled).toBe(true);
  expect(renderToStaticMarkup(render())).toContain("1번째와 2번째 검색 모델이 중복됩니다");
  select("2번째 검색 모델 공급자", "openai");
  select("2번째 검색 모델 ID", "test-model");
  expect(control("검색용 모델 저장").disabled).toBe(false);
  expect(state.save).not.toHaveBeenCalled();
});

it("keeps unknown accounts explicit and preserves a draft on failure or a concurrent edit", async () => {
  state.settings = {
    ...state.settings!,
    searchModels: [{ provider: "baidu", model: "old", apiInstanceId: "removed" }],
  };
  expect(renderToStaticMarkup(render())).toContain("사용할 수 없는 계정");
  expect(control("1번째 검색 모델 계정").value).toBe("removed");
  select("1번째 검색 모델 공급자", "openai");
  select("1번째 검색 모델 ID", "replacement");
  expect(
    visitElements(control("1번째 검색 모델 공급자").children, (el) => el.props.value === "gemini")
      ?.props.disabled,
  ).toBe(true);
  state.save.mockResolvedValueOnce({ _tag: "Failure" });
  click("검색용 모델 저장");
  await vi.waitFor(() => expect(renderToStaticMarkup(render())).toContain("저장하지 못했습니다"));
  expect(control("1번째 검색 모델 ID").value).toBe("replacement");
  state.settings = {
    ...state.settings,
    searchModels: [{ provider: "anthropic", model: "other-device" }],
  };
  expect(control("검색용 모델 저장").disabled).toBe(true);
  click("다시 불러오기");
  expect(control("1번째 검색 모델 ID").value).toBe("other-device");
  expect(state.save).toHaveBeenCalledTimes(1);
});

it("supports connecting and editing OpenRouter accounts and freely editing OpenRouter search model IDs", async () => {
  state.settings = { ...DEFAULT_SERVER_SETTINGS, providerInstances: {}, searchModels: [] };
  expect(searchSettings("OpenRouter")).toContainEqual({
    id: "openrouter-search-account",
    title: "OpenRouter 계정 연결",
    to: "/settings/general",
    targetId: "search-models",
  });
  const dialog = () => visitElements(render(), (el) => el.type === OpenRouterConnectionDialog);
  expect(dialog()).toBeNull();
  click("OpenRouter 계정 연결");
  expect(dialog()?.props).toMatchObject({ open: true, environmentId: env });
  const orId = ProviderInstanceId.make("openrouter_fixture");
  state.settings = {
    ...state.settings,
    providerInstances: {
      [orId]: account("내 OpenRouter", ["perplexity/sonar"], "https://openrouter.ai/api/v1"),
    },
  };
  (dialog()!.props.onOpenChange as (open: boolean) => void)(false);
  expect(dialog()).toBeNull();

  // Clicking "모델 추가" defaults to the connected OpenRouter account and lets the user enter any model ID.
  click("모델 추가");
  expect(control("1번째 검색 모델 공급자").value).toBe("openrouter");
  expect(control("1번째 검색 모델 계정").value).toBe(orId);
  select("1번째 검색 모델 ID", "baidu/ernie-4.5-300b-a47b:online");
  expect(control("검색용 모델 저장").disabled).toBe(false);

  // Clicking inline "계정 수정" opens OpenRouterConnectionDialog in edit mode.
  click("1번째 검색 모델 계정 수정");
  expect(dialog()?.props).toMatchObject({
    open: true,
    environmentId: env,
    existingInstanceId: orId,
  });
  (dialog()!.props.onOpenChange as (open: boolean) => void)(false);

  click("검색용 모델 저장");
  expect(state.save).toHaveBeenCalledExactlyOnceWith({
    environmentId: env,
    input: {
      patch: {
        searchModels: [
          {
            provider: "openrouter",
            apiInstanceId: orId,
            model: "baidu/ernie-4.5-300b-a47b:online",
          },
        ],
      },
    },
  });
});
