import { useAtomValue } from "@effect/atom-react";
import {
  OpenCodeApiConnection,
  ProviderInstanceId,
  WorkspaceSearchModel,
  type EnvironmentId,
  type ProviderInstanceConfig,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ArrowDownIcon, ArrowUpIcon, PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useMemo, useRef, useState } from "react";

import { usePrimaryEnvironmentId } from "~/state/environments";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  OPENROUTER_BASE_URL,
  OPENROUTER_RECOMMENDED_SEARCH_MODELS,
  OpenRouterConnectionDialog,
} from "./OpenRouterConnectionDialog";
import { QianfanConnectionDialog, QIANFAN_BASE_URL } from "./QianfanConnectionDialog";
import { SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const providers = {
  openrouter: "OpenRouter",
  xai: "Grok (xAI)",
  openai: "OpenAI",
  anthropic: "Claude (Anthropic)",
  custom: "사용자 지정 API (OpenCode · Ollama · Antseed)",
  baidu: "바이두(Baidu) Qianfan",
  gemini: "Gemini (프로젝트 조사 전용)",
} satisfies Record<WorkspaceSearchModel["provider"], string>;

type AutoSearchProvider = Exclude<WorkspaceSearchModel["provider"], "gemini">;

const QUICK_ADD_PROVIDERS: readonly AutoSearchProvider[] = [
  "openrouter",
  "xai",
  "openai",
  "anthropic",
  "custom",
  "baidu",
];

const BUILTIN_SEARCH_MODEL_PRESETS: Record<"xai" | "openai" | "anthropic", readonly string[]> = {
  xai: ["grok-4-fast", "grok-3-mini"],
  openai: ["gpt-4o-mini", "gpt-4.1-mini"],
  anthropic: ["claude-sonnet-4-5", "claude-haiku-4-5"],
};

const decodeAccount = Schema.decodeUnknownOption(
  Schema.Struct({ apiConnection: OpenCodeApiConnection }),
);
const isSearchModel = Schema.is(WorkspaceSearchModel);
const selectClass = "h-9 w-full min-w-0 rounded-md border border-input bg-background px-2 text-sm";
const empty: readonly WorkspaceSearchModel[] = [];

function hasQianfanEndpoint(connection: OpenCodeApiConnection) {
  try {
    return new URL(connection.baseUrl).href.replace(/\/$/u, "") === QIANFAN_BASE_URL;
  } catch {
    return false;
  }
}

function hasOpenRouterEndpoint(connection: OpenCodeApiConnection) {
  try {
    return new URL(connection.baseUrl).href.replace(/\/$/u, "") === OPENROUTER_BASE_URL;
  } catch {
    return false;
  }
}

// Disabled accounts stay visible in the catalogue. Only enabled connections can enter the search order.
function registeredAccounts(instances: ServerSettings["providerInstances"]) {
  return Object.entries(instances).flatMap(([id, instance]) => {
    if (instance.driver !== "opencode") return [];
    const config = decodeAccount(instance.config);
    if (Option.isNone(config)) return [];
    const { apiConnection } = config.value;
    const officialQianfan = hasQianfanEndpoint(apiConnection);
    // The search server still routes a registered Qianfan identity to Baidu if its URL was edited.
    const baidu =
      officialQianfan ||
      id.startsWith("qianfan_") ||
      apiConnection.providerId === "t3_qianfan" ||
      apiConnection.providerId === "qianfan";
    if (baidu && (!officialQianfan || apiConnection.protocol !== "chat-completions")) return [];
    const officialOpenRouter = hasOpenRouterEndpoint(apiConnection);
    const openrouter =
      !baidu &&
      (officialOpenRouter ||
        id.startsWith("openrouter_") ||
        apiConnection.providerId === "t3_openrouter" ||
        apiConnection.providerId === "openrouter");
    if (openrouter && (!officialOpenRouter || apiConnection.protocol !== "chat-completions"))
      return [];
    return [
      {
        id,
        name: instance.displayName ?? id,
        models: apiConnection.models,
        baidu,
        openrouter,
        enabled: instance.enabled !== false,
        instance,
      },
    ];
  });
}

type Row = { key: string; entry: WorkspaceSearchModel };
type Draft = { base: readonly WorkspaceSearchModel[]; rows: readonly Row[] };
type EditingDialog =
  | { kind: "openrouter"; instanceId?: ProviderInstanceId; instance?: ProviderInstanceConfig }
  | { kind: "baidu"; instanceId?: ProviderInstanceId; instance?: ProviderInstanceConfig }
  | null;

function sameOrder(a: readonly WorkspaceSearchModel[], b: readonly WorkspaceSearchModel[]) {
  return (
    a.length === b.length &&
    a.every(
      (entry, i) =>
        entry.provider === b[i]?.provider &&
        entry.model === b[i]?.model &&
        entry.apiInstanceId === b[i]?.apiInstanceId,
    )
  );
}

function findDuplicate(models: readonly WorkspaceSearchModel[]) {
  const firstPosition = new Map<string, number>();
  for (const [i, entry] of models.entries()) {
    if (!entry.model) continue;
    const key = JSON.stringify([entry.provider, entry.apiInstanceId ?? null, entry.model]);
    const first = firstPosition.get(key);
    if (first !== undefined) return { first, repeated: i + 1 };
    firstPosition.set(key, i + 1);
  }
  return null;
}

export function SearchModelsSettingsSection() {
  const environmentId = usePrimaryEnvironmentId();
  return (
    <SettingsSection {...searchableSetting("search-models")}>
      {environmentId ? (
        <SearchModelsEditor key={environmentId} environmentId={environmentId} />
      ) : (
        <p className="px-4 text-sm text-muted-foreground">
          서버에 연결하면 검색용 모델을 설정할 수 있습니다.
        </p>
      )}
    </SettingsSection>
  );
}

export function SearchModelsEditor({ environmentId }: { environmentId: EnvironmentId }) {
  const settings = useAtomValue(serverEnvironment.settingsValueAtom(environmentId));
  const update = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const nextKey = useRef(0);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [quickProvider, setQuickProvider] = useState<AutoSearchProvider>("openrouter");
  const [dialog, setDialog] = useState<EditingDialog>(null);
  const [error, setError] = useState("");
  const instances = settings?.providerInstances;
  const accounts = useMemo(() => (instances ? registeredAccounts(instances) : []), [instances]);
  if (!settings)
    return <p className="px-4 text-sm text-muted-foreground">서버 설정을 불러오는 중…</p>;
  const saved = settings.searchModels ?? empty;
  const registeredOpenRouter = accounts.filter((account) => account.openrouter);
  const openRouterModels = registeredOpenRouter.flatMap((account) => {
    const combined = [...new Set([...account.models, ...OPENROUTER_RECOMMENDED_SEARCH_MODELS])];
    return combined.map((model) => ({
      account,
      model,
      value: JSON.stringify([account.id, model]),
    }));
  });
  const openRouterAccounts = registeredOpenRouter.filter((account) => account.enabled);
  const registeredBaidu = accounts.filter((account) => account.baidu);
  const baiduModels = registeredBaidu.flatMap((account) =>
    account.models.map((model) => ({ account, model, value: JSON.stringify([account.id, model]) })),
  );
  const baiduAccounts = registeredBaidu.filter((account) => account.enabled);
  const registeredCustom = accounts.filter((account) => !account.baidu && !account.openrouter);
  const customModels = registeredCustom.flatMap((account) =>
    account.models.map((model) => ({ account, model, value: JSON.stringify([account.id, model]) })),
  );
  const customAccounts = registeredCustom.filter((account) => account.enabled);
  const available = (provider: WorkspaceSearchModel["provider"]) =>
    provider === "baidu"
      ? baiduAccounts
      : provider === "openrouter"
        ? openRouterAccounts
        : provider === "custom"
          ? customAccounts
          : [];
  // Older settings stored Qianfan or OpenRouter with provider "custom". Keep exact account, model and position.
  const rows = (draft?.rows ?? saved.map((entry, i) => ({ key: `saved-${i}`, entry }))).map(
    (row) => {
      if (row.entry.provider !== "custom") return row;
      if (registeredBaidu.some((account) => account.id === row.entry.apiInstanceId))
        return { ...row, entry: { ...row.entry, provider: "baidu" as const } };
      if (registeredOpenRouter.some((account) => account.id === row.entry.apiInstanceId))
        return { ...row, entry: { ...row.entry, provider: "openrouter" as const } };
      return row;
    },
  );
  const conflict = draft !== null && !sameOrder(draft.base, saved);
  const change = (nextRows: readonly Row[]) => {
    setDraft({ base: draft?.base ?? saved, rows: nextRows });
    setError("");
  };
  const append = (entry: WorkspaceSearchModel) =>
    change([...rows, { key: `new-${nextKey.current++}`, entry }]);
  const edit = (key: string, entry: WorkspaceSearchModel) =>
    change(rows.map((row) => (row.key === key ? { key, entry } : row)));
  const move = (from: number, to: number) => {
    const ordered = [...rows];
    ordered.splice(to, 0, ...ordered.splice(from, 1));
    change(ordered);
  };
  const models = rows.map(({ entry }) => ({ ...entry, model: entry.model.trim() }));
  const duplicate = findDuplicate(models);
  const valid =
    !duplicate &&
    models.every(
      (entry) =>
        isSearchModel(entry) &&
        entry.provider !== "gemini" &&
        (entry.provider === "openrouter"
          ? openRouterAccounts.some((account) => account.id === entry.apiInstanceId)
          : !(entry.provider === "custom" || entry.provider === "baidu") ||
            available(entry.provider).some(
              (account) =>
                account.id === entry.apiInstanceId && account.models.includes(entry.model),
            )),
    );
  const save = async () => {
    if (saving || conflict || !valid || !draft) return;
    setSaving(true);
    try {
      const result = await update({ environmentId, input: { patch: { searchModels: models } } });
      if (result._tag === "Success") setDraft(null);
      else setError("검색용 모델을 저장하지 못했습니다. 서버 연결과 설정 권한을 확인하세요.");
    } finally {
      setSaving(false);
    }
  };

  const quickAccountModels =
    quickProvider === "openrouter"
      ? openRouterModels
      : quickProvider === "baidu"
        ? baiduModels
        : quickProvider === "custom"
          ? customModels
          : null;

  const quickPresetModels =
    quickProvider === "xai" || quickProvider === "openai" || quickProvider === "anthropic"
      ? BUILTIN_SEARCH_MODEL_PRESETS[quickProvider]
      : null;

  return (
    <div className="space-y-3 px-3 sm:px-4">
      <p className="text-sm text-muted-foreground">
        검색에 사용할 모델을 시도할 순서(Fallback)대로 추가하고 수정하세요. 대화에서 선택한 모델은
        그대로 유지됩니다.
      </p>
      <div className="flex flex-wrap items-end gap-2 rounded-md border border-border/70 bg-muted/20 p-3">
        <label className="grid min-w-44 flex-1 gap-1 text-xs font-medium text-muted-foreground">
          제공자 선택
          <select
            aria-label="검색 모델 제공자 선택"
            className={selectClass}
            disabled={saving}
            value={quickProvider}
            onChange={(event) => setQuickProvider(event.currentTarget.value as AutoSearchProvider)}
          >
            {QUICK_ADD_PROVIDERS.map((provider) => (
              <option key={provider} value={provider}>
                {providers[provider]}
              </option>
            ))}
          </select>
        </label>
        <label className="grid min-w-52 flex-[1.4] gap-1 text-xs font-medium text-muted-foreground">
          검색 순서에 추가할 모델
          <select
            aria-label="검색 순서에 추가할 모델 선택"
            className={selectClass}
            disabled={saving}
            value=""
            onChange={(event) => {
              const value = event.currentTarget.value;
              if (!value) return;
              if (value === "manual-entry") {
                const defaultAccount = available(quickProvider)[0]?.id;
                append({
                  provider: quickProvider,
                  ...(defaultAccount ? { apiInstanceId: defaultAccount } : {}),
                  model: "",
                });
                return;
              }
              if (quickAccountModels) {
                const choice = quickAccountModels.find((item) => item.value === value);
                if (choice?.account.enabled) {
                  append({
                    provider: quickProvider,
                    apiInstanceId: choice.account.id,
                    model: choice.model,
                  });
                }
                return;
              }
              append({ provider: quickProvider, model: value });
            }}
          >
            <option value="">검색 순서에 추가할 모델 선택</option>
            {quickAccountModels?.map(({ account, model, value }) => {
              const included = rows.some(
                ({ entry }) =>
                  entry.provider === quickProvider &&
                  entry.apiInstanceId === account.id &&
                  entry.model === model,
              );
              return (
                <option key={value} value={value} disabled={!account.enabled || included}>
                  {account.name}
                  {account.name !== account.id ? ` (${account.id})` : ""} · {model}
                  {!account.enabled ? " (계정 비활성)" : included ? " (검색 순서에 있음)" : ""}
                </option>
              );
            })}
            {quickPresetModels?.map((model) => {
              const included = rows.some(
                ({ entry }) => entry.provider === quickProvider && entry.model === model,
              );
              return (
                <option key={model} value={model} disabled={included}>
                  {model}
                  {included ? " (검색 순서에 있음)" : ""}
                </option>
              );
            })}
            <option value="manual-entry">모델 ID 직접 입력</option>
          </select>
        </label>
        {quickProvider === "openrouter" && (
          <>
            <Button variant="outline" onClick={() => setDialog({ kind: "openrouter" })}>
              {searchableSetting("openrouter-search-account").title}
            </Button>
            {registeredOpenRouter.length > 0 && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  setDialog({
                    kind: "openrouter",
                    instanceId: ProviderInstanceId.make(registeredOpenRouter[0]!.id),
                    instance: registeredOpenRouter[0]!.instance,
                  })
                }
              >
                <PencilIcon />
                OpenRouter 계정 수정
              </Button>
            )}
          </>
        )}
        {quickProvider === "baidu" && (
          <Button variant="outline" onClick={() => setDialog({ kind: "baidu" })}>
            {searchableSetting("baidu-search-account").title}
          </Button>
        )}
        {quickProvider === "openrouter" && registeredOpenRouter.length === 0 && (
          <p className="w-full text-xs text-muted-foreground">
            OpenRouter API 키(`sk-or-v1-...`) 하나로 `perplexity/sonar`, `baidu/ernie-4.5-8b`,
            `:online` 웹 검색 모델을 모두 Fallback 순서에 추가할 수 있습니다.
          </p>
        )}
        {quickProvider === "baidu" && registeredBaidu.length > 0 && baiduAccounts.length === 0 && (
          <p className="w-full text-xs text-muted-foreground">
            등록된 Qianfan 계정이 모두 비활성 상태입니다.
          </p>
        )}
        {quickProvider === "baidu" && registeredBaidu.length === 0 && (
          <p className="w-full text-xs text-muted-foreground">
            Qianfan 계정을 연결한 뒤 계정에 등록한 모델 ID를 선택하세요. 모델 ID 입력 예: ernie-5.1.
          </p>
        )}
        {quickProvider === "custom" && customAccounts.length === 0 && (
          <p className="w-full text-xs text-muted-foreground">
            OpenCode, Ollama, Antseed Gateway 등 OpenAI 호환 계정을 공급자 설정에서 연결하면
            여기에서 바로 선택할 수 있습니다.
          </p>
        )}
      </div>
      {dialog?.kind === "openrouter" && (
        <OpenRouterConnectionDialog
          open
          environmentId={environmentId}
          onOpenChange={(next) => {
            if (!next) setDialog(null);
          }}
          {...(dialog.instanceId && dialog.instance
            ? { existingInstanceId: dialog.instanceId, existingInstance: dialog.instance }
            : {})}
        />
      )}
      {dialog?.kind === "baidu" && (
        <QianfanConnectionDialog
          open
          environmentId={environmentId}
          onOpenChange={(next) => {
            if (!next) setDialog(null);
          }}
          {...(dialog.instanceId && dialog.instance
            ? { existingInstanceId: dialog.instanceId, existingInstance: dialog.instance }
            : {})}
        />
      )}
      <p className="text-sm text-muted-foreground">
        프로젝트 조사에서 Gemini의 Google 검색 보고서는 화면에만 표시합니다. ‘다른 API 조사 분석’은
        다른 API가 찾은 출처를 Gemini로 분석해 프로젝트 RAG에 저장합니다. 두 방식 모두 자동 검색
        순서에는 포함되지 않습니다.
      </p>
      {rows.length === 0 && <p className="text-sm">등록된 검색용 모델이 없습니다.</p>}
      {rows.map(({ key, entry }, i) => {
        const numbered = (label: string) => `${i + 1}번째 검색 모델 ${label}`;
        const needsAccount =
          entry.provider === "custom" ||
          entry.provider === "baidu" ||
          entry.provider === "openrouter";
        const choices = available(entry.provider);
        const account = choices.find((candidate) => candidate.id === entry.apiInstanceId);
        const openRouterSuggestions =
          entry.provider === "openrouter"
            ? [...new Set([...(account?.models ?? []), ...OPENROUTER_RECOMMENDED_SEARCH_MODELS])]
            : [];
        const datalistId = `openrouter-models-${key}`;
        return (
          <fieldset
            key={key}
            disabled={saving}
            className="flex flex-wrap items-end gap-2 rounded-md border p-3"
          >
            <legend className="sr-only">검색 모델 {i + 1}</legend>
            <label className="grid flex-1 gap-1 text-xs">
              공급자
              <select
                aria-label={numbered("공급자")}
                className={selectClass}
                value={entry.provider}
                onChange={(event) => {
                  const nextProvider = event.currentTarget
                    .value as WorkspaceSearchModel["provider"];
                  const defaultAccount =
                    nextProvider === "openrouter" ? openRouterAccounts[0]?.id : undefined;
                  edit(key, {
                    provider: nextProvider,
                    ...(defaultAccount ? { apiInstanceId: defaultAccount } : {}),
                    model: "",
                  });
                }}
              >
                {Object.entries(providers).map(([value, label]) => (
                  <option key={value} value={value} disabled={value === "gemini"}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            {needsAccount && (
              <label className="grid min-w-36 flex-1 gap-1 text-xs">
                등록된 API 계정
                <select
                  aria-label={numbered("계정")}
                  className={selectClass}
                  value={entry.apiInstanceId ?? ""}
                  onChange={(event) =>
                    edit(key, {
                      provider: entry.provider,
                      apiInstanceId: event.currentTarget.value,
                      model: entry.provider === "openrouter" ? entry.model : "",
                    })
                  }
                >
                  <option value="">{choices.length ? "계정 선택" : "등록된 계정 없음"}</option>
                  {entry.apiInstanceId && !account && (
                    <option value={entry.apiInstanceId} disabled>
                      {entry.apiInstanceId} (사용할 수 없는 계정)
                    </option>
                  )}
                  {choices.map((candidate) => (
                    <option key={candidate.id} value={candidate.id}>
                      {candidate.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="grid min-w-36 flex-1 gap-1 text-xs">
              모델
              {entry.provider === "openrouter" ? (
                <>
                  <Input
                    aria-label={numbered("ID")}
                    list={datalistId}
                    disabled={!account}
                    value={entry.model}
                    placeholder="예: perplexity/sonar, baidu/ernie-4.5-8b, openai/gpt-4o-mini:online"
                    spellCheck={false}
                    onChange={(event) => edit(key, { ...entry, model: event.currentTarget.value })}
                  />
                  <datalist id={datalistId}>
                    {openRouterSuggestions.map((name) => (
                      <option key={name} value={name} />
                    ))}
                  </datalist>
                </>
              ) : needsAccount ? (
                <select
                  aria-label={numbered("ID")}
                  className={selectClass}
                  disabled={!account}
                  value={entry.model}
                  onChange={(event) => edit(key, { ...entry, model: event.currentTarget.value })}
                >
                  <option value="">모델 선택</option>
                  {entry.model && !account?.models.includes(entry.model) && (
                    <option value={entry.model} disabled>
                      {entry.model} (사용 불가)
                    </option>
                  )}
                  {account?.models.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
              ) : (
                <Input
                  aria-label={numbered("ID")}
                  value={entry.model}
                  placeholder="모델 ID"
                  spellCheck={false}
                  onChange={(event) => edit(key, { ...entry, model: event.currentTarget.value })}
                />
              )}
            </label>
            <div className="flex gap-1">
              {!account && (entry.provider === "openrouter" || entry.provider === "baidu") && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    setDialog({ kind: entry.provider === "openrouter" ? "openrouter" : "baidu" })
                  }
                >
                  {entry.provider === "openrouter" ? "OpenRouter 연결" : "Qianfan 연결"}
                </Button>
              )}
              {account && (entry.provider === "openrouter" || entry.provider === "baidu") && (
                <Button
                  aria-label={numbered("계정 수정")}
                  size="icon-sm"
                  variant="outline"
                  onClick={() =>
                    setDialog({
                      kind: entry.provider === "openrouter" ? "openrouter" : "baidu",
                      instanceId: ProviderInstanceId.make(account.id),
                      instance: account.instance,
                    })
                  }
                >
                  <PencilIcon />
                </Button>
              )}
              <Button
                aria-label={numbered("위로")}
                size="icon-sm"
                variant="outline"
                disabled={i === 0}
                onClick={() => move(i, i - 1)}
              >
                <ArrowUpIcon />
              </Button>
              <Button
                aria-label={numbered("아래로")}
                size="icon-sm"
                variant="outline"
                disabled={i === rows.length - 1}
                onClick={() => move(i, i + 1)}
              >
                <ArrowDownIcon />
              </Button>
              <Button
                aria-label={numbered("삭제")}
                size="icon-sm"
                variant="outline"
                onClick={() => change(rows.filter((row) => row.key !== key))}
              >
                <Trash2Icon />
              </Button>
            </div>
          </fieldset>
        );
      })}
      {duplicate && (
        <p role="alert" className="text-sm text-destructive">
          {`${duplicate.first}번째와 ${duplicate.repeated}번째 검색 모델이 중복됩니다. 한 행을 삭제하거나 모델 또는 계정을 변경하세요.`}
        </p>
      )}
      {conflict && (
        <p role="alert" className="text-sm">
          다른 곳에서 검색용 목록을 변경했습니다. 다시 불러온 뒤 수정하세요.
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          disabled={saving}
          onClick={() =>
            append(
              openRouterAccounts[0]
                ? {
                    provider: "openrouter",
                    apiInstanceId: openRouterAccounts[0].id,
                    model: "",
                  }
                : { provider: "xai", model: "" },
            )
          }
        >
          <PlusIcon />
          모델 추가
        </Button>
        <Button
          disabled={saving || !draft || conflict || !valid || sameOrder(saved, models)}
          onClick={() => void save()}
        >
          검색용 모델 저장
        </Button>
        {draft && (
          <Button
            variant="ghost"
            disabled={saving}
            onClick={() => {
              setDraft(null);
              setError("");
            }}
          >
            {conflict ? "다시 불러오기" : "취소"}
          </Button>
        )}
      </div>
    </div>
  );
}
