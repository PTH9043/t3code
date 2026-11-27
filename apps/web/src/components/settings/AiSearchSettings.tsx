import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  ProviderInstanceId,
  type AiSearchEmbeddingMode,
  type AiSearchProviderOption,
  type AiSearchSelectableModel,
  type OllamaEmbeddingModelInfo,
} from "@t3tools/contracts";
import { LoaderIcon, PencilIcon, RefreshCwIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePrimarySettings, useUpdatePrimarySettings } from "~/hooks/useSettings";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { SettingsRow, SettingsSection } from "./settingsLayout";

export const LOCAL_OLLAMA_PROVIDER_SELECT_VALUE = "__local_ollama__";

export function formatEmbeddingModelSize(sizeBytes: number | undefined): string | null {
  if (typeof sizeBytes !== "number" || !Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    return null;
  }
  const gib = 1024 ** 3;
  if (sizeBytes >= gib) {
    return `${(sizeBytes / gib).toFixed(1)} GB`;
  }
  const mib = 1024 ** 2;
  if (sizeBytes >= mib) {
    return `${Math.round(sizeBytes / mib)} MB`;
  }
  return `${Math.max(1, Math.round(sizeBytes / 1024))} KB`;
}

/**
 * Match a persisted model name (e.g. `nomic-embed-text-v2-moe`) against Ollama's
 * tagged model list (e.g. `nomic-embed-text-v2-moe:latest`) or registered provider models.
 */
export function resolveSelectedEmbeddingModelValue(
  currentModel: string,
  models: ReadonlyArray<Pick<OllamaEmbeddingModelInfo, "name">>,
): string | undefined {
  const trimmed = currentModel.trim();
  if (!trimmed) return undefined;
  const exact = models.find((model) => model.name === trimmed);
  if (exact) return exact.name;
  const normalizedTarget = trimmed.replace(/:latest$/u, "");
  const tagged = models.find(
    (model) =>
      model.name === `${trimmed}:latest` ||
      model.name.replace(/:latest$/u, "") === normalizedTarget,
  );
  return tagged?.name;
}

function buildModelMetaSummary(
  model: Pick<AiSearchSelectableModel, "parameterSize" | "sizeBytes" | "quantizationLevel">,
): string | null {
  const parts = [
    model.parameterSize,
    formatEmbeddingModelSize(model.sizeBytes),
    model.quantizationLevel,
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(" · ") : null;
}

function synthesizeFallbackOllamaProvider(
  endpoint: string,
  reachable: boolean,
  models: ReadonlyArray<OllamaEmbeddingModelInfo>,
  errorMessage?: string,
): AiSearchProviderOption {
  return {
    source: "ollama",
    displayName: "로컬 Ollama",
    baseUrl: endpoint || "http://127.0.0.1:11434",
    isLocal: true,
    apiKeyReady: reachable,
    supportsEmbeddingsApi: true,
    supportsRerankApi: true,
    models: models.map((model) => ({
      name: model.name,
      mode: "embedding",
      recommended: model.multilingualRecommended,
      multilingualRecommended: model.multilingualRecommended,
      sourceHint: "installed",
      ...(model.sizeBytes !== undefined ? { sizeBytes: model.sizeBytes } : {}),
      ...(model.parameterSize ? { parameterSize: model.parameterSize } : {}),
      ...(model.quantizationLevel ? { quantizationLevel: model.quantizationLevel } : {}),
      ...(model.family ? { family: model.family } : {}),
      ...(model.englishOnlyWarning ? { englishOnlyWarning: model.englishOnlyWarning } : {}),
    })),
    ...(errorMessage ? { statusMessage: errorMessage } : {}),
  };
}

function providerCapabilityLabel(provider: AiSearchProviderOption): string {
  if (provider.supportsEmbeddingsApi && provider.supportsRerankApi) return "임베딩 · 재정렬";
  if (provider.supportsEmbeddingsApi) return "벡터 임베딩";
  return "LLM 재정렬";
}

function sourceHintLabel(hint: AiSearchSelectableModel["sourceHint"]): string {
  switch (hint) {
    case "installed":
      return "설치됨";
    case "registered":
      return "등록 모델";
    case "discovered":
      return "API 확인";
    case "preset":
      return "추천";
  }
}

export function AiSearchSettingsSection() {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const settings = usePrimarySettings();
  const update = useUpdatePrimarySettings();
  const listOllamaEmbeddingModels = useAtomCommand(serverEnvironment.listOllamaEmbeddingModels, {
    reportFailure: false,
  });

  const [draft, setDraft] = useState(settings.aiSearch);
  const [error, setError] = useState<string | null>(null);
  const [providers, setProviders] = useState<ReadonlyArray<AiSearchProviderOption>>([]);
  const [ollamaReachable, setOllamaReachable] = useState<boolean | null>(null);
  const [discoveryMessage, setDiscoveryMessage] = useState<string | null>(null);
  const [isLoadingModels, setIsLoadingModels] = useState(false);
  const [useManualModelInput, setUseManualModelInput] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => setDraft(settings.aiSearch), [settings.aiSearch]);

  const fetchSemanticModels = useCallback(
    async (endpointOverride?: string) => {
      if (!primaryEnvironmentId) return;
      setIsLoadingModels(true);
      const endpoint = (endpointOverride ?? draft.embeddingEndpoint).trim();
      const result = await listOllamaEmbeddingModels({
        environmentId: primaryEnvironmentId,
        input: endpoint ? { endpoint } : {},
      });
      if (!mountedRef.current) return;
      setIsLoadingModels(false);
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          const failure = squashAtomCommandFailure(result);
          setOllamaReachable(false);
          setProviders([]);
          setDiscoveryMessage(
            failure instanceof Error
              ? failure.message
              : "의미 검색 모델 목록을 불러오지 못했습니다. 키워드 검색은 유지됩니다.",
          );
        }
        return;
      }
      setOllamaReachable(result.value.reachable);
      const nextProviders =
        result.value.providers && result.value.providers.length > 0
          ? result.value.providers
          : [
              synthesizeFallbackOllamaProvider(
                result.value.endpoint,
                result.value.reachable,
                result.value.models,
                result.value.errorMessage,
              ),
            ];
      setProviders(nextProviders);
      setDiscoveryMessage(result.value.errorMessage ?? null);
    },
    [draft.embeddingEndpoint, listOllamaEmbeddingModels, primaryEnvironmentId],
  );

  useEffect(() => {
    mountedRef.current = true;
    void fetchSemanticModels(settings.aiSearch.embeddingEndpoint);
    return () => {
      mountedRef.current = false;
    };
    // Initial discovery for the active server environment & persisted endpoint.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [primaryEnvironmentId, settings.aiSearch.embeddingEndpoint, settings.providerInstances]);

  const activeProviderSelectValue = draft.embeddingInstanceId ?? LOCAL_OLLAMA_PROVIDER_SELECT_VALUE;
  const isLocalOllamaSelected = !draft.embeddingInstanceId;
  const selectedProvider = useMemo(() => {
    if (!draft.embeddingInstanceId) {
      return providers.find((item) => item.source === "ollama") ?? null;
    }
    return (
      providers.find(
        (item) =>
          item.source === "provider-instance" && item.instanceId === draft.embeddingInstanceId,
      ) ?? null
    );
  }, [draft.embeddingInstanceId, providers]);

  const hasMissingSavedProvider =
    Boolean(draft.embeddingInstanceId) && providers.length > 0 && selectedProvider === null;
  const availableModels = selectedProvider?.models ?? [];
  const matchedModelName = useMemo(
    () => resolveSelectedEmbeddingModelValue(draft.embeddingModel, availableModels),
    [availableModels, draft.embeddingModel],
  );
  const activeModelInfo = useMemo(
    () =>
      matchedModelName
        ? availableModels.find((model) => model.name === matchedModelName)
        : undefined,
    [availableModels, matchedModelName],
  );
  const effectiveMode: AiSearchEmbeddingMode =
    draft.embeddingMode ??
    activeModelInfo?.mode ??
    (selectedProvider?.supportsEmbeddingsApi === false ? "rerank" : "embedding");
  const showSelectDropdown = !useManualModelInput && availableModels.length > 0;
  const selectValue = matchedModelName ?? draft.embeddingModel.trim();
  const hasCustomUnlistedValue =
    showSelectDropdown && draft.embeddingModel.trim().length > 0 && matchedModelName === undefined;

  const savedInstanceId = settings.aiSearch.embeddingInstanceId ?? null;
  const draftInstanceId = draft.embeddingInstanceId ?? null;
  const savedMode = settings.aiSearch.embeddingMode ?? "embedding";
  const modelChangedFromSaved =
    draft.embeddingModel.trim() !== settings.aiSearch.embeddingModel.trim() ||
    draftInstanceId !== savedInstanceId ||
    effectiveMode !== savedMode;

  const handleProviderChange = (value: string) => {
    setError(null);
    if (value === LOCAL_OLLAMA_PROVIDER_SELECT_VALUE) {
      const ollama = providers.find((item) => item.source === "ollama");
      const firstModel = ollama?.models[0];
      setUseManualModelInput(false);
      setDraft({
        ...draft,
        embeddingInstanceId: null,
        embeddingMode: firstModel?.mode ?? "embedding",
        ...(firstModel ? { embeddingModel: firstModel.name } : {}),
      });
      return;
    }
    const target = providers.find(
      (item) => item.source === "provider-instance" && item.instanceId === value,
    );
    const firstModel = target?.models[0];
    setUseManualModelInput(false);
    setDraft({
      ...draft,
      embeddingInstanceId: ProviderInstanceId.make(value),
      embeddingMode:
        firstModel?.mode ?? (target?.supportsEmbeddingsApi === false ? "rerank" : "embedding"),
      ...(firstModel ? { embeddingModel: firstModel.name } : {}),
    });
  };

  const save = () => {
    try {
      if (isLocalOllamaSelected) {
        const endpoint = new URL(draft.embeddingEndpoint);
        if (
          !["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname) ||
          !["http:", "https:"].includes(endpoint.protocol)
        ) {
          throw new Error("로컬 Ollama 주소는 서버 환경의 localhost HTTP 주소여야 합니다.");
        }
      } else {
        if (hasMissingSavedProvider) {
          throw new Error(
            "선택한 등록 계정이 비활성화되었거나 찾을 수 없습니다. 다른 제공자를 선택하세요.",
          );
        }
        if (selectedProvider && !selectedProvider.apiKeyReady) {
          throw new Error(
            `${selectedProvider.displayName} 계정에 API 키가 없습니다. 제공자 설정에서 API 키를 먼저 저장하세요.`,
          );
        }
        if (
          selectedProvider &&
          effectiveMode === "embedding" &&
          !selectedProvider.supportsEmbeddingsApi
        ) {
          throw new Error(
            `${selectedProvider.displayName} 계정은 벡터 임베딩 API를 지원하지 않습니다. LLM 의미 재정렬 방식을 선택하세요.`,
          );
        }
      }
      if (!draft.embeddingModel.trim() || !draft.researchModel.trim()) {
        throw new Error("모델 이름을 입력하세요.");
      }
      if (
        !Number.isInteger(draft.researchMaxTurns) ||
        draft.researchMaxTurns < 1 ||
        draft.researchMaxTurns > 8
      ) {
        throw new Error("조사 호출 단계는 1–8로 설정하세요.");
      }
      const normalizedDraft = {
        ...draft,
        embeddingEndpoint: draft.embeddingEndpoint.trim(),
        embeddingInstanceId: draftInstanceId,
        embeddingMode: effectiveMode,
        embeddingModel: draft.embeddingModel.trim(),
        researchModel: draft.researchModel.trim(),
      };
      update({ aiSearch: normalizedDraft });
      setDraft(normalizedDraft);
      setError(null);
      toastManager.add({
        type: "success",
        title: "AI 검색 설정을 저장했습니다",
        description: modelChangedFromSaved
          ? effectiveMode === "rerank"
            ? `'${normalizedDraft.embeddingModel}' 모델로 검색 결과 LLM 의미 재정렬이 적용됩니다.`
            : `임베딩 모델 '${normalizedDraft.embeddingModel}' 기준으로 백그라운드 재색인이 진행됩니다.`
          : undefined,
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "설정 값을 확인하세요.");
    }
  };

  const embeddingModelCount = availableModels.filter((item) => item.mode === "embedding").length;
  const rerankModelCount = availableModels.filter((item) => item.mode === "rerank").length;

  return (
    <SettingsSection title="AI 문서 검색과 조사" id="ai-search">
      <SettingsRow
        title="키워드 + 의미 검색"
        description="로컬 Ollama 또는 현재 T3에 등록된 API 모델로 의미 검색(벡터 임베딩 또는 LLM 의미 재정렬)을 수행합니다. 연결할 수 없으면 키워드 검색을 유지합니다. 원격 연결에서도 서버가 문서를 처리합니다."
        control={
          <Switch
            checked={draft.semanticEnabled}
            onCheckedChange={(value) => setDraft({ ...draft, semanticEnabled: value })}
          />
        }
      />

      <SettingsRow
        title="의미 검색 제공자"
        description="로컬 Ollama 또는 T3에 이미 등록된 API 계정을 선택합니다. 등록 계정은 저장된 주소와 API 키를 그대로 사용합니다."
        control={
          <div className="flex w-full max-w-md flex-col gap-1.5">
            <Select
              value={activeProviderSelectValue}
              onValueChange={(value) => {
                if (typeof value === "string" && value.trim().length > 0) {
                  handleProviderChange(value);
                }
              }}
            >
              <SelectTrigger aria-label="의미 검색 제공자 선택" className="w-full">
                <SelectValue placeholder="의미 검색 제공자 선택" />
              </SelectTrigger>
              <SelectPopup>
                {hasMissingSavedProvider && draft.embeddingInstanceId ? (
                  <SelectItem value={draft.embeddingInstanceId}>
                    <span className="flex items-center justify-between gap-2">
                      <span className="truncate">{draft.embeddingInstanceId}</span>
                      <Badge variant="warning" size="sm">
                        비활성 · 미등록
                      </Badge>
                    </span>
                  </SelectItem>
                ) : null}
                {(providers.length > 0
                  ? providers
                  : [
                      synthesizeFallbackOllamaProvider(
                        draft.embeddingEndpoint,
                        ollamaReachable === true,
                        [],
                      ),
                    ]
                ).map((provider) => {
                  const value =
                    provider.source === "ollama"
                      ? LOCAL_OLLAMA_PROVIDER_SELECT_VALUE
                      : (provider.instanceId ?? LOCAL_OLLAMA_PROVIDER_SELECT_VALUE);
                  return (
                    <SelectItem key={value} value={value}>
                      <span className="flex min-w-0 items-center justify-between gap-2">
                        <span className="min-w-0 truncate">
                          <span className="font-medium">{provider.displayName}</span>
                          <span className="ml-2 text-[11px] text-muted-foreground">
                            {provider.isLocal ? "로컬" : "원격 API"}
                          </span>
                        </span>
                        <Badge
                          variant={provider.supportsEmbeddingsApi ? "success" : "outline"}
                          size="sm"
                        >
                          {providerCapabilityLabel(provider)}
                        </Badge>
                      </span>
                    </SelectItem>
                  );
                })}
              </SelectPopup>
            </Select>
            {selectedProvider && selectedProvider.source === "provider-instance" ? (
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                연결 주소: <span className="font-mono">{selectedProvider.baseUrl}</span>
                {selectedProvider.apiKeyReady ? " · 등록된 API 키 자동 사용" : " · API 키 필요"}
              </p>
            ) : null}
          </div>
        }
      />

      {isLocalOllamaSelected ? (
        <SettingsRow
          title="로컬 Ollama 주소"
          description="이 서버가 실행 중인 환경의 Ollama HTTP 주소입니다."
          control={
            <Input
              aria-label="로컬 임베딩 주소"
              value={draft.embeddingEndpoint}
              onChange={(event) =>
                setDraft({ ...draft, embeddingEndpoint: event.currentTarget.value })
              }
            />
          }
        />
      ) : null}

      <SettingsRow
        title="의미 검색 모델"
        description={
          isLocalOllamaSelected
            ? "로컬 Ollama에 설치된 임베딩 또는 채팅 모델입니다."
            : "선택한 등록 계정에서 사용할 벡터 임베딩 또는 LLM 의미 재정렬 모델입니다."
        }
        control={
          <div className="flex w-full max-w-md flex-col gap-2">
            <div className="flex items-center gap-1.5">
              {showSelectDropdown ? (
                <Select
                  value={selectValue}
                  onValueChange={(value) => {
                    if (typeof value === "string" && value.trim().length > 0) {
                      const chosen = availableModels.find((item) => item.name === value);
                      setDraft({
                        ...draft,
                        embeddingModel: value,
                        embeddingMode: chosen?.mode ?? effectiveMode,
                      });
                      setError(null);
                    }
                  }}
                >
                  <SelectTrigger aria-label="임베딩 모델 선택" className="min-w-0 flex-1">
                    <SelectValue placeholder="의미 검색 모델 선택" />
                  </SelectTrigger>
                  <SelectPopup>
                    {hasCustomUnlistedValue ? (
                      <SelectItem value={draft.embeddingModel.trim()}>
                        <span className="flex items-center justify-between gap-2">
                          <span className="truncate font-mono text-xs">
                            {draft.embeddingModel.trim()}
                          </span>
                          <Badge variant="outline" size="sm">
                            현재 설정 · 직접 지정
                          </Badge>
                        </span>
                      </SelectItem>
                    ) : null}
                    {availableModels.map((model) => {
                      const meta = buildModelMetaSummary(model);
                      return (
                        <SelectItem key={`${model.mode}:${model.name}`} value={model.name}>
                          <span className="flex min-w-0 items-center justify-between gap-2">
                            <span className="min-w-0 truncate">
                              <span className="font-mono text-xs">{model.name}</span>
                              {meta ? (
                                <span className="ml-2 text-[11px] text-muted-foreground">
                                  {meta}
                                </span>
                              ) : (
                                <span className="ml-2 text-[11px] text-muted-foreground">
                                  {sourceHintLabel(model.sourceHint)}
                                </span>
                              )}
                            </span>
                            <span className="flex shrink-0 items-center gap-1">
                              <Badge
                                variant={model.mode === "embedding" ? "success" : "secondary"}
                                size="sm"
                              >
                                {model.mode === "embedding" ? "벡터 임베딩" : "LLM 재정렬"}
                              </Badge>
                              {model.multilingualRecommended ? (
                                <Badge variant="success" size="sm">
                                  다국어 권장
                                </Badge>
                              ) : model.englishOnlyWarning ? (
                                <Badge variant="warning" size="sm">
                                  영어 전용
                                </Badge>
                              ) : null}
                            </span>
                          </span>
                        </SelectItem>
                      );
                    })}
                  </SelectPopup>
                </Select>
              ) : (
                <Input
                  aria-label="임베딩 모델"
                  className="min-w-0 flex-1 font-mono text-xs"
                  placeholder={
                    isLocalOllamaSelected
                      ? "예: bge-m3:latest"
                      : selectedProvider?.supportsEmbeddingsApi
                        ? "예: text-embedding-3-small"
                        : "등록된 모델 ID 입력"
                  }
                  value={draft.embeddingModel}
                  onChange={(event) => {
                    setDraft({ ...draft, embeddingModel: event.currentTarget.value });
                    setError(null);
                  }}
                />
              )}
              <Button
                type="button"
                size="sm"
                variant="outline"
                aria-label="Ollama 임베딩 모델 목록 새로고침"
                disabled={isLoadingModels || !primaryEnvironmentId}
                onClick={() => void fetchSemanticModels(draft.embeddingEndpoint)}
              >
                {isLoadingModels ? (
                  <LoaderIcon className="size-3.5 animate-spin" aria-hidden />
                ) : (
                  <RefreshCwIcon className="size-3.5" aria-hidden />
                )}
                새로고침
              </Button>
              {availableModels.length > 0 ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => setUseManualModelInput((current) => !current)}
                >
                  <PencilIcon className="size-3.5" aria-hidden />
                  {useManualModelInput ? "목록 선택" : "직접 입력"}
                </Button>
              ) : null}
            </div>

            {(!showSelectDropdown || useManualModelInput) &&
            selectedProvider?.supportsEmbeddingsApi &&
            selectedProvider.supportsRerankApi ? (
              <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <span>동작 방식:</span>
                <Button
                  type="button"
                  size="xs"
                  variant={effectiveMode === "embedding" ? "default" : "outline"}
                  onClick={() => setDraft({ ...draft, embeddingMode: "embedding" })}
                >
                  벡터 임베딩
                </Button>
                <Button
                  type="button"
                  size="xs"
                  variant={effectiveMode === "rerank" ? "default" : "outline"}
                  onClick={() => setDraft({ ...draft, embeddingMode: "rerank" })}
                >
                  LLM 의미 재정렬
                </Button>
              </div>
            ) : null}

            {selectedProvider && availableModels.length > 0 ? (
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                {selectedProvider.displayName}에서 모델 {availableModels.length}개
                {embeddingModelCount > 0 || rerankModelCount > 0
                  ? ` (임베딩 ${embeddingModelCount} · 재정렬 ${rerankModelCount})`
                  : ""}
                를 확인했습니다.
                {activeModelInfo
                  ? (() => {
                      const meta = buildModelMetaSummary(activeModelInfo);
                      const modeText =
                        activeModelInfo.mode === "embedding" ? "벡터 임베딩" : "LLM 의미 재정렬";
                      return ` 선택됨: ${activeModelInfo.name} · ${modeText}${meta ? ` (${meta})` : ""}`;
                    })()
                  : ""}
              </p>
            ) : isLocalOllamaSelected &&
              ollamaReachable === true &&
              availableModels.length === 0 ? (
              <p className="text-[11px] leading-relaxed text-amber-700 dark:text-amber-300">
                Ollama에 설치된 모델이 없습니다. 터미널에서 `ollama pull bge-m3` 등으로 설치하거나
                위에서 등록된 API 계정을 선택하세요.
              </p>
            ) : null}

            {isLocalOllamaSelected && ollamaReachable === false && discoveryMessage ? (
              <p
                role="status"
                className="rounded-md border border-amber-500/30 bg-amber-500/8 px-2.5 py-1.5 text-[11px] leading-relaxed text-amber-700 dark:text-amber-300"
              >
                {discoveryMessage}
              </p>
            ) : null}

            {selectedProvider?.statusMessage && !isLocalOllamaSelected ? (
              <p
                role="status"
                className="rounded-md border border-amber-500/30 bg-amber-500/8 px-2.5 py-1.5 text-[11px] leading-relaxed text-amber-700 dark:text-amber-300"
              >
                {selectedProvider.statusMessage}
              </p>
            ) : null}

            {selectedProvider && !selectedProvider.isLocal ? (
              <p className="rounded-md border border-sky-500/30 bg-sky-500/8 px-2.5 py-1.5 text-[11px] leading-relaxed text-sky-700 dark:text-sky-300">
                원격 API 계정({selectedProvider.displayName})을 사용하면 검색 질의와 문서 조각이
                해당 API 서버로 전송되며 제공자 요금이 발생할 수 있습니다.
              </p>
            ) : null}

            {activeModelInfo?.englishOnlyWarning ? (
              <p className="rounded-md border border-amber-500/30 bg-amber-500/8 px-2.5 py-1.5 text-[11px] leading-relaxed text-amber-700 dark:text-amber-300">
                {activeModelInfo.englishOnlyWarning}
              </p>
            ) : null}

            {effectiveMode === "rerank" ? (
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                LLM 의미 재정렬은 대량 사전 색인 없이 검색 시점의 상위 후보(최대 16건)를 선택한
                모델로 의미 평가해 키워드 검색과 결합합니다.
              </p>
            ) : modelChangedFromSaved ? (
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                제공자 또는 모델을 변경해 저장하면 기존 원본과 이전 캐시는 유지되며 새 모델로
                백그라운드 재색인이 자동 진행됩니다.
              </p>
            ) : null}
          </div>
        }
      />
      <SettingsRow
        title="스캔 PDF 로컬 OCR"
        description="한국어·영어를 인식하고 표의 열 간격을 보존합니다. 문서당 최대 12페이지이며 인식 결과와 원본을 함께 보관합니다."
        control={
          <Switch
            checked={draft.ocrEnabled}
            onCheckedChange={(value) => setDraft({ ...draft, ocrEnabled: value })}
          />
        }
      />
      <SettingsRow
        title="동일 문서 추출 결과 재사용"
        description="같은 프로젝트에서 원본과 추출 설정이 같을 때 재사용합니다. 원본이 바뀌거나 부분 추출이면 다시 처리합니다. Claude·Codex 등 모든 AI에 적용됩니다."
        control={
          <Switch
            checked={draft.documentCacheEnabled !== false}
            onCheckedChange={(value) => setDraft({ ...draft, documentCacheEnabled: value })}
          />
        }
      />
      <SettingsRow
        title="문서 캐시 새로고침"
        description="다음 첨부부터 다시 추출합니다. 기존 대화와 근거 파일은 보존됩니다."
        control={
          <Button
            onClick={() => {
              const epoch = (draft.documentCacheEpoch ?? 0) + 1;
              setDraft({ ...draft, documentCacheEpoch: epoch });
              update({ aiSearch: { documentCacheEpoch: epoch } });
            }}
          >
            새로고침
          </Button>
        }
      />
      <SettingsRow
        title="Grok 조사 모델"
        description="프로젝트의 지식·RAG 화면에서 API 키, 출처 필터와 비용 상한을 설정하고 조사합니다."
        control={
          <Input
            aria-label="Grok 조사 모델"
            value={draft.researchModel}
            onChange={(event) => setDraft({ ...draft, researchModel: event.currentTarget.value })}
          />
        }
      />
      <SettingsRow
        title="조사 단계 상한"
        description="한 조사 호출에서 Grok이 반복하는 단계 수를 제한합니다."
        control={
          <Input
            type="number"
            min={1}
            max={8}
            aria-label="조사 단계 상한"
            value={draft.researchMaxTurns}
            onChange={(event) =>
              setDraft({ ...draft, researchMaxTurns: Number(event.currentTarget.value) })
            }
          />
        }
      />
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <Button onClick={save}>AI 검색 설정 저장</Button>
    </SettingsSection>
  );
}
