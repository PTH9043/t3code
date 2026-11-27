import {
  DEFAULT_UNIFIED_SETTINGS,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type AiSearchProviderOption,
  type OllamaEmbeddingModelInfo,
} from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { visitElements } from "../../test/reactElementTree";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";

const atoms = vi.hoisted(() => ({
  listOllamaEmbeddingModels: Symbol("listOllamaEmbeddingModels"),
}));

const mocks = vi.hoisted(() => ({
  environmentId: "local" as EnvironmentId,
  settings: null as typeof DEFAULT_UNIFIED_SETTINGS | null,
  updateSettings: vi.fn(),
  listModels: vi.fn(),
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useCallback: reactHookHarness.useCallback,
    useEffect: vi.fn(),
    useMemo: reactHookHarness.useMemo,
    useRef: reactHookHarness.useRef,
    useState: reactHookHarness.useState,
  };
});

vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});

vi.mock("~/state/environments", () => ({
  usePrimaryEnvironmentId: () => mocks.environmentId,
}));

vi.mock("~/hooks/useSettings", () => ({
  usePrimarySettings: () => mocks.settings ?? DEFAULT_UNIFIED_SETTINGS,
  useUpdatePrimarySettings: () => mocks.updateSettings,
}));

vi.mock("~/state/server", () => ({
  serverEnvironment: {
    listOllamaEmbeddingModels: atoms.listOllamaEmbeddingModels,
  },
}));

vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: () => mocks.listModels,
}));

import {
  AiSearchSettingsSection,
  formatEmbeddingModelSize,
  resolveSelectedEmbeddingModelValue,
} from "./AiSearchSettings";
import { Select } from "../ui/select";

const sampleModels: ReadonlyArray<OllamaEmbeddingModelInfo> = [
  {
    name: "bge-m3:latest",
    sizeBytes: 1_157_000_000,
    parameterSize: "567M",
    quantizationLevel: "F16",
    family: "bert",
    multilingualRecommended: true,
  },
  {
    name: "nomic-embed-text-v2-moe:latest",
    sizeBytes: 957_000_000,
    parameterSize: "475M",
    quantizationLevel: "F16",
    family: "nomic-bert-moe",
    multilingualRecommended: true,
  },
  {
    name: "embeddinggemma:300m-qat-q4_0",
    sizeBytes: 238_000_000,
    parameterSize: "308M",
    quantizationLevel: "Q4_0",
    family: "gemma3",
    multilingualRecommended: true,
  },
];

const openAiInstanceId = ProviderInstanceId.make("openai_api_1");
const deepSeekInstanceId = ProviderInstanceId.make("deepseek_1");

const sampleProviders: ReadonlyArray<AiSearchProviderOption> = [
  {
    source: "ollama",
    displayName: "로컬 Ollama",
    baseUrl: "http://127.0.0.1:11434",
    isLocal: true,
    apiKeyReady: true,
    supportsEmbeddingsApi: true,
    supportsRerankApi: true,
    models: sampleModels.map((model) => ({
      ...model,
      mode: "embedding" as const,
      recommended: model.multilingualRecommended,
      sourceHint: "installed" as const,
    })),
  },
  {
    source: "provider-instance",
    instanceId: openAiInstanceId,
    driver: ProviderDriverKind.make("opencode"),
    displayName: "OpenAI API",
    baseUrl: "https://api.openai.com/v1",
    isLocal: false,
    apiKeyReady: true,
    supportsEmbeddingsApi: true,
    supportsRerankApi: true,
    models: [
      {
        name: "text-embedding-3-small",
        mode: "embedding",
        recommended: true,
        multilingualRecommended: true,
        sourceHint: "discovered",
      },
      {
        name: "gpt-5-mini",
        mode: "rerank",
        recommended: true,
        multilingualRecommended: false,
        sourceHint: "registered",
      },
    ],
  },
  {
    source: "provider-instance",
    instanceId: deepSeekInstanceId,
    driver: ProviderDriverKind.make("opencode"),
    displayName: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    isLocal: false,
    apiKeyReady: true,
    supportsEmbeddingsApi: false,
    supportsRerankApi: true,
    models: [
      {
        name: "deepseek-flash",
        mode: "rerank",
        recommended: true,
        multilingualRecommended: false,
        sourceHint: "registered",
      },
    ],
  },
];

function findSelectByTriggerAriaLabel(tree: unknown, ariaLabel: string) {
  let matched: { props: Record<string, unknown> } | null = null;
  visitElements(tree as never, (el) => {
    if (el.type !== Select) return false;
    const trigger = visitElements(el, (child) => child.props["aria-label"] === ariaLabel);
    if (trigger) {
      matched = el as unknown as { props: Record<string, unknown> };
      return true;
    }
    return false;
  });
  return matched as { props: Record<string, unknown> } | null;
}

describe("AiSearchSettingsSection registered model & Ollama selector", () => {
  beforeEach(() => {
    hooks.reset();
    mocks.environmentId = EnvironmentId.make("local");
    mocks.settings = {
      ...DEFAULT_UNIFIED_SETTINGS,
      aiSearch: {
        ...DEFAULT_UNIFIED_SETTINGS.aiSearch,
        embeddingModel: "nomic-embed-text-v2-moe",
      },
    };
    mocks.updateSettings.mockReset();
    mocks.listModels.mockReset();
  });

  it("matches tagless persisted model names against :latest entries and formats sizes", () => {
    expect(resolveSelectedEmbeddingModelValue("nomic-embed-text-v2-moe", sampleModels)).toBe(
      "nomic-embed-text-v2-moe:latest",
    );
    expect(resolveSelectedEmbeddingModelValue("bge-m3:latest", sampleModels)).toBe("bge-m3:latest");
    expect(resolveSelectedEmbeddingModelValue("custom-model:v1", sampleModels)).toBeUndefined();
    expect(formatEmbeddingModelSize(1_157_000_000)).toBe("1.1 GB");
    expect(formatEmbeddingModelSize(238_551_040)).toBe("228 MB");
  });

  it("loads installed Ollama embedding models, allows selecting another model, and persists it on save", async () => {
    mocks.listModels.mockResolvedValue({
      _tag: "Success",
      value: {
        endpoint: "http://127.0.0.1:11434",
        reachable: true,
        models: sampleModels,
        providers: sampleProviders,
      },
    });

    hooks.beginRender();
    const initialTree = AiSearchSettingsSection();
    const refreshButton = visitElements(
      initialTree,
      (el) => el.props["aria-label"] === "Ollama 임베딩 모델 목록 새로고침",
    );
    expect(refreshButton).toBeDefined();
    await (refreshButton!.props.onClick as () => Promise<void>)();

    expect(mocks.listModels).toHaveBeenCalledWith({
      environmentId: mocks.environmentId,
      input: { endpoint: "http://127.0.0.1:11434" },
    });

    hooks.beginRender();
    const loadedTree = AiSearchSettingsSection();
    const modelSelect = findSelectByTriggerAriaLabel(loadedTree, "임베딩 모델 선택");
    expect(modelSelect).not.toBeNull();
    expect(modelSelect!.props.value).toBe("nomic-embed-text-v2-moe:latest");

    (modelSelect!.props.onValueChange as (value: string) => void)("bge-m3:latest");

    hooks.beginRender();
    const updatedTree = AiSearchSettingsSection();
    const saveButton = visitElements(
      updatedTree,
      (el) => el.props.children === "AI 검색 설정 저장",
    );
    expect(saveButton).toBeDefined();
    (saveButton!.props.onClick as () => void)();

    expect(mocks.updateSettings).toHaveBeenCalledWith({
      aiSearch: expect.objectContaining({
        embeddingInstanceId: null,
        embeddingMode: "embedding",
        embeddingModel: "bge-m3:latest",
      }),
    });
  });

  it("allows switching to a registered API account (OpenAI embedding & DeepSeek rerank) without local Ollama", async () => {
    mocks.listModels.mockResolvedValue({
      _tag: "Success",
      value: {
        endpoint: "http://127.0.0.1:11434",
        reachable: false,
        models: [],
        providers: sampleProviders,
        errorMessage: "서버의 Ollama에 연결할 수 없습니다.",
      },
    });

    hooks.beginRender();
    const initialTree = AiSearchSettingsSection();
    const refreshButton = visitElements(
      initialTree,
      (el) => el.props["aria-label"] === "Ollama 임베딩 모델 목록 새로고침",
    );
    await (refreshButton!.props.onClick as () => Promise<void>)();

    hooks.beginRender();
    const loadedTree = AiSearchSettingsSection();
    const providerSelect = findSelectByTriggerAriaLabel(loadedTree, "의미 검색 제공자 선택");
    expect(providerSelect).not.toBeNull();

    // Switch to registered OpenAI API account -> selects text-embedding-3-small (embedding mode)
    (providerSelect!.props.onValueChange as (value: string) => void)(openAiInstanceId);

    hooks.beginRender();
    const openAiTree = AiSearchSettingsSection();
    expect(
      visitElements(openAiTree, (el) => el.props["aria-label"] === "로컬 임베딩 주소"),
    ).toBeNull();
    const openAiModelSelect = findSelectByTriggerAriaLabel(openAiTree, "임베딩 모델 선택");
    expect(openAiModelSelect!.props.value).toBe("text-embedding-3-small");

    // Switch to registered DeepSeek account -> auto-selects deepseek-flash in rerank mode
    const providerSelect2 = findSelectByTriggerAriaLabel(openAiTree, "의미 검색 제공자 선택");
    (providerSelect2!.props.onValueChange as (value: string) => void)(deepSeekInstanceId);

    hooks.beginRender();
    const deepSeekTree = AiSearchSettingsSection();
    const saveButton = visitElements(
      deepSeekTree,
      (el) => el.props.children === "AI 검색 설정 저장",
    );
    (saveButton!.props.onClick as () => void)();

    expect(mocks.updateSettings).toHaveBeenCalledWith({
      aiSearch: expect.objectContaining({
        embeddingInstanceId: deepSeekInstanceId,
        embeddingMode: "rerank",
        embeddingModel: "deepseek-flash",
      }),
    });
  });

  it("falls back to manual text input when Ollama is unreachable and selected", async () => {
    mocks.listModels.mockResolvedValue({
      _tag: "Success",
      value: {
        endpoint: "http://127.0.0.1:11434",
        reachable: false,
        models: [],
        errorMessage: "서버의 Ollama에 연결할 수 없습니다.",
      },
    });

    hooks.beginRender();
    const initialTree = AiSearchSettingsSection();
    const refreshButton = visitElements(
      initialTree,
      (el) => el.props["aria-label"] === "Ollama 임베딩 모델 목록 새로고침",
    );
    await (refreshButton!.props.onClick as () => Promise<void>)();

    hooks.beginRender();
    const offlineTree = AiSearchSettingsSection();
    expect(findSelectByTriggerAriaLabel(offlineTree, "임베딩 모델 선택")).toBeNull();
    const manualInput = visitElements(
      offlineTree,
      (el) => el.props["aria-label"] === "임베딩 모델",
    );
    expect(manualInput).toBeDefined();
    expect(manualInput!.props.value).toBe("nomic-embed-text-v2-moe");
  });
});
