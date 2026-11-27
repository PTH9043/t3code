import {
  DEFAULT_UNIFIED_SETTINGS,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderModel,
  type UnifiedSettings,
} from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  providers: [] as ReadonlyArray<ServerProvider>,
  settings: null as UnifiedSettings | null,
  updateSettings: vi.fn(),
}));

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => state.providers }));
vi.mock("../../state/server", () => ({
  EMPTY_SERVER_PROVIDERS: [],
  serverEnvironment: { providersValueAtom: () => Symbol("providers") },
}));
vi.mock("../../hooks/useSettings", () => ({
  useEnvironmentSettings: () => state.settings,
  useUpdateEnvironmentSettings: () => state.updateSettings,
}));

import { ProviderSubordinatesSection } from "./ProviderSubordinatesSection";

const environmentId = EnvironmentId.make("test-env");
const claudeId = ProviderInstanceId.make("claudeAgent");
const codexId = ProviderInstanceId.make("codex");

const model = (slug: string, name: string): ServerProviderModel => ({
  slug,
  name,
  isCustom: false,
  capabilities: null,
});
const claudeModels = [
  model("claude-opus-5-5", "Claude Opus 5.5"),
  model("claude-sonnet-5", "Claude Sonnet 5"),
];
const codexModels = [model("gpt-6-sol", "GPT-6 Sol"), model("gpt-6-luna", "GPT-6 Luna")];

const provider = (
  instanceId: ProviderInstanceId,
  models: ReadonlyArray<ServerProviderModel>,
): ServerProvider => ({
  instanceId,
  driver: ProviderDriverKind.make(instanceId),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-07-24T12:00:00.000Z",
  models: [...models],
  slashCommands: [],
  skills: [],
});

describe("ProviderSubordinatesSection", () => {
  beforeEach(() => {
    state.providers = [provider(claudeId, claudeModels), provider(codexId, codexModels)];
    state.settings = DEFAULT_UNIFIED_SETTINGS;
    state.updateSettings.mockReset();
  });

  it("shows a Claude account's saved settings, including what it cannot map", () => {
    state.settings = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: {
        [ProviderInstanceId.make("opencode_baidu")]: {
          driver: ProviderDriverKind.make("opencode"),
          displayName: "Baidu",
          config: { apiConnection: { protocol: "chat-completions", models: ["ernie-5.1"] } },
        },
      },
      subordinateModels: [
        {
          answeringInstanceId: claudeId,
          instanceId: ProviderInstanceId.make("codex_gone"),
          model: "gpt-retired",
          role: "advisor",
        },
        { answeringInstanceId: claudeId, instanceId: codexId, model: "gpt-6-luna", role: "scout" },
        {
          answeringInstanceId: codexId,
          instanceId: claudeId,
          model: "other-account-row",
          role: "worker",
        },
      ],
    };
    const onConfigChange = vi.fn();
    const html = renderToStaticMarkup(
      <ProviderSubordinatesSection
        instanceId={claudeId}
        driver="claudeAgent"
        config={{
          conductorWorkerModel: "haiku",
          conductorWorkerByModel: "opus=sonnet",
          helperAccount: "Baidu:ernie-5.1",
          helperForModels: "sonnet, retired",
        }}
        models={claudeModels}
        environmentId={environmentId}
        onConfigChange={onConfigChange}
      />,
    );

    expect(html).toContain('aria-label="하위 모델"');
    expect(html).toContain('<option value="haiku" selected="">Haiku</option>');
    expect(html).toContain("이름에 &quot;opus&quot;이(가) 들어간 모델");
    expect(html).toContain("적용되는 답변 모델: Claude Opus 5.5");
    // 다른 계정의 모델, 사라진 계정의 줄, 다른 답변 계정의 줄
    expect(html).toContain("Codex · GPT-6 Luna");
    expect(html).toContain("codex_gone · gpt-retired (사용 불가)");
    expect(html).not.toContain("other-account-row");
    // 표시 이름으로 저장된 하위 API가 계정 id 선택지로 풀린다
    expect(html).toContain(
      '<option value="opencode_baidu:ernie-5.1" selected="">Baidu · ernie-5.1</option>',
    );
    expect(html).toContain("이 계정 목록에 없는 이름");
    expect(html).not.toContain("저장하면 이 계정에서 진행 중인 대화가 중단될 수 있습니다");
    expect(onConfigChange).not.toHaveBeenCalled();
    expect(state.updateSettings).not.toHaveBeenCalled();
  });

  it("shows a Codex account with no API account registered", () => {
    const html = renderToStaticMarkup(
      <ProviderSubordinatesSection
        instanceId={codexId}
        driver="codex"
        config={undefined}
        models={codexModels}
        environmentId={environmentId}
        onConfigChange={vi.fn()}
      />,
    );

    expect(html).toContain("하위 에이전트 모델");
    expect(html).toContain('<option value="" selected="">답변 모델과 같음 (기본)</option>');
    expect(html).not.toContain("지휘자 모드 일꾼");
    expect(html).toContain("등록된 API 계정이 없습니다");
    expect(html).not.toContain("잡일용 하위 API 계정·모델");
  });
});
