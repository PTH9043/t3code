import { useAtomValue } from "@effect/atom-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  DEFAULT_ASSISTANT_AUDIO_SETTINGS,
  DEFAULT_GLOBAL_ASSISTANT_CONFIG,
  DEFAULT_GLOBAL_ASSISTANT_ENFORCEMENT,
  DEFAULT_PERSONA_TRAIT_GENOME,
  resolveActivePersonaId,
  resolveEffectiveGlobalAssistant,
  type AssistantAudioSettings,
  type DomainPlaybook,
  type EnvironmentId,
  type GlobalAssistantConfig,
  type GlobalAssistantPreset,
  type OutputSectionPosition,
  type OutputSectionRule,
  type StyleExample,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { scoreGlobalAssistantBotReady } from "@t3tools/shared/botReadyContract";
import { compileGlobalAssistantPrompts } from "@t3tools/shared/globalAssistantPrompt";
import { useDesktopAssistant } from "~/hooks/useDesktopAssistant";
import { useEnvironmentSettings } from "~/hooks/useSettings";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "~/providerInstances";
import { getAppModelOptionsForInstance } from "~/modelSelection";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { notifyCommandFailure, notifySuccess } from "../control-center/controlCenterShared";
import { Button } from "../ui/button";
import { Sheet, SheetDescription, SheetHeader, SheetPopup, SheetTitle } from "../ui/sheet";
import {
  PersonaLibraryToolbar,
  PersonaTraitPreviewPanel,
  snapshotActivePersonaProfile,
} from "./PersonaLibraryToolbar";

const PRESETS: ReadonlyArray<readonly [GlobalAssistantPreset, string]> = [
  ["default", "기본"],
  ["concise", "간결"],
  ["detailed", "상세"],
  ["friendly", "친근"],
  ["professional", "전문"],
];

const POSITION_LABELS: ReadonlyArray<readonly [OutputSectionPosition, string]> = [
  ["start", "답변 시작"],
  ["body", "본문 중간"],
  ["end", "답변 맨 끝"],
];

type StudioTab = "identity" | "traits" | "contract" | "playbooks" | "monitor" | "preview";

const inputClass = "w-full rounded border border-border bg-background px-2 py-1 text-foreground";

export function GlobalAssistantStudio({
  environmentId,
  compact = false,
  showMonitorControls = false,
}: {
  environmentId: EnvironmentId;
  compact?: boolean;
  showMonitorControls?: boolean;
}) {
  const settings = useEnvironmentSettings(environmentId);
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const saveSettings = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const assistant = useDesktopAssistant();

  const resolvedSaved = useMemo<GlobalAssistantConfig>(() => {
    return resolveEffectiveGlobalAssistant(settings) ?? DEFAULT_GLOBAL_ASSISTANT_CONFIG;
  }, [settings]);

  const savedFingerprint = useMemo(() => JSON.stringify(resolvedSaved), [resolvedSaved]);
  const [draft, setDraft] = useState<GlobalAssistantConfig>(resolvedSaved);
  const [dirty, setDirty] = useState(false);
  const [pending, setPending] = useState(false);
  const [activeTab, setActiveTab] = useState<StudioTab>("identity");
  const [previewSample, setPreviewSample] = useState(
    "이 코드의 동시성 버그를 분석하고 수정 계획을 세워줘",
  );
  const [drawerOpen, setDrawerOpen] = useState(false);

  useEffect(() => {
    if (!dirty) setDraft(resolvedSaved);
    else if (JSON.stringify(draft) === savedFingerprint) setDirty(false);
  }, [dirty, draft, resolvedSaved, savedFingerprint]);

  const updateDraft = (updater: (current: GlobalAssistantConfig) => GlobalAssistantConfig) => {
    setDraft((current) => updater(current));
    setDirty(true);
  };

  const modelChoices = useMemo(() => {
    return sortProviderInstanceEntries(
      applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings),
    )
      .filter((entry) => entry.enabled && entry.isAvailable)
      .flatMap((entry) =>
        getAppModelOptionsForInstance(settings, entry).map((model) => ({
          key: JSON.stringify([entry.instanceId, model.slug]),
          instanceId: entry.instanceId,
          model: model.slug,
          label:
            entry.displayName === entry.instanceId
              ? `${entry.instanceId} · ${model.name}`
              : `${entry.displayName} (${entry.instanceId}) · ${model.name}`,
        })),
      );
  }, [providers, settings]);

  const selectedModelKey = draft.defaultModelSelection
    ? JSON.stringify([draft.defaultModelSelection.instanceId, draft.defaultModelSelection.model])
    : "";

  const compiledPreview = useMemo(
    () => compileGlobalAssistantPrompts(draft, { userMessage: previewSample }),
    [draft, previewSample],
  );
  const botReadyScore = useMemo(() => scoreGlobalAssistantBotReady(draft), [draft]);

  const persist = async (nextConfig: GlobalAssistantConfig | null) => {
    if (pending) return;
    setPending(true);
    try {
      const normalizedConfig =
        nextConfig === null
          ? null
          : {
              ...nextConfig,
              activePersonaId: resolveActivePersonaId(nextConfig),
              traitGenome: nextConfig.traitGenome ?? DEFAULT_PERSONA_TRAIT_GENOME,
              personaProfiles: {
                ...(nextConfig.personaProfiles ?? {}),
                [resolveActivePersonaId(nextConfig)]: snapshotActivePersonaProfile(nextConfig),
              },
            };
      const result = await saveSettings({
        environmentId,
        input: { patch: { globalAssistant: normalizedConfig } },
      });
      if (result._tag !== "Success") {
        notifyCommandFailure(result, "전역 AI 설정을 저장하지 못했습니다.");
        return;
      }
      setDirty(false);
      notifySuccess(
        nextConfig === null
          ? "전역 AI 설정을 초기화했습니다."
          : "전역 AI·비서 설정을 저장했습니다. 모든 대화와 모델의 다음 턴부터 적용됩니다.",
      );
    } finally {
      setPending(false);
    }
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void persist(draft);
  };

  const updatePrinciple = (index: number, value: string) =>
    updateDraft((current) => ({
      ...current,
      corePrinciples: current.corePrinciples.map((entry, i) => (i === index ? value : entry)),
    }));

  const updateExample = (index: number, patch: Partial<StyleExample>) =>
    updateDraft((current) => ({
      ...current,
      styleExamples: current.styleExamples.map((entry, i) =>
        i === index ? { ...entry, ...patch } : entry,
      ),
    }));

  const updateSection = (index: number, patch: Partial<OutputSectionRule>) =>
    updateDraft((current) => ({
      ...current,
      outputSections: current.outputSections.map((entry, i) =>
        i === index ? { ...entry, ...patch } : entry,
      ),
    }));

  const updatePlaybook = (index: number, patch: Partial<DomainPlaybook>) =>
    updateDraft((current) => ({
      ...current,
      domainPlaybooks: current.domainPlaybooks.map((entry, i) =>
        i === index ? { ...entry, ...patch } : entry,
      ),
    }));

  const tabs: ReadonlyArray<readonly [StudioTab, string]> = [
    ["identity", "정체성·말투"],
    ["traits", "성격 9축·정서"],
    ["contract", `원칙·출력계약 (${draft.corePrinciples.length + draft.outputSections.length})`],
    ["playbooks", `전문 본부 (${draft.domainPlaybooks.length})`],
    ...(showMonitorControls && assistant.available ? ([["monitor", "모니터 비서"]] as const) : []),
    ["preview", "컴파일 미리보기"],
  ];

  const statusSummary = draft.enabled
    ? `${draft.personaName.trim() || "전역 AI"} · 출력 계약 ${draft.outputSections.filter((s) => s.required).length}개 · 전문 본부 ${draft.domainPlaybooks.length}개`
    : "비활성";

  const content = (
    <form className="mt-2 grid gap-3" onSubmit={handleSubmit}>
      <PersonaLibraryToolbar draft={draft} onChange={updateDraft} disabled={pending} />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <label className="inline-flex items-center gap-2 font-medium">
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(event) => {
              const checked = event.currentTarget.checked;
              updateDraft((current) => ({ ...current, enabled: checked }));
            }}
          />
          모든 대화·모델·모니터 비서에 전역 AI 계약 적용
        </label>
        <span className="text-muted-foreground">
          시스템 ~{compiledPreview.stats.estimatedSystemTokens}tok · 턴 앵커 ~
          {compiledPreview.stats.estimatedTurnTokens}tok
        </span>
      </div>

      <div className="flex flex-wrap gap-1 border-b border-border pb-2" role="tablist">
        {tabs.map(([tabId, label]) => (
          <Button
            key={tabId}
            type="button"
            size="xs"
            role="tab"
            aria-selected={activeTab === tabId}
            variant={activeTab === tabId ? "default" : "outline"}
            onClick={() => setActiveTab(tabId)}
          >
            {label}
          </Button>
        ))}
      </div>

      <fieldset className="grid gap-3" disabled={pending}>
        {activeTab === "identity" && (
          <div className="grid gap-2.5">
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="flex flex-col gap-1">
                전역 기본 모델 (새 대화 · 모니터 비서 공통)
                <select
                  aria-label="전역 기본 모델"
                  className={inputClass}
                  value={selectedModelKey}
                  onChange={(event) => {
                    const picked = modelChoices.find((c) => c.key === event.currentTarget.value);
                    updateDraft((current) => ({
                      ...current,
                      defaultModelSelection: picked
                        ? createModelSelection(picked.instanceId, picked.model)
                        : null,
                    }));
                  }}
                >
                  <option value="">현재 대화 모델 그대로 사용</option>
                  {draft.defaultModelSelection &&
                    !modelChoices.some((c) => c.key === selectedModelKey) && (
                      <option value={selectedModelKey}>
                        {draft.defaultModelSelection.instanceId} ·{" "}
                        {draft.defaultModelSelection.model}
                      </option>
                    )}
                  {modelChoices.map((choice) => (
                    <option key={choice.key} value={choice.key}>
                      {choice.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1">
                역할 / 페르소나 이름
                <input
                  aria-label="역할 이름"
                  className={inputClass}
                  placeholder="예: 전속 비서실장"
                  value={draft.personaName}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    updateDraft((current) => ({ ...current, personaName: value }));
                  }}
                />
              </label>
            </div>

            <div className="grid gap-2 sm:grid-cols-3">
              <label className="flex flex-col gap-1">
                기본 프리셋
                <select
                  aria-label="프리셋"
                  className={inputClass}
                  value={draft.preset}
                  onChange={(event) => {
                    const preset = event.currentTarget.value as GlobalAssistantPreset;
                    updateDraft((current) => ({
                      ...current,
                      preset,
                    }));
                  }}
                >
                  {PRESETS.map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1">
                답변 길이 정책
                <input
                  aria-label="답변 길이"
                  className={inputClass}
                  value={draft.lengthPolicy}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    updateDraft((current) => ({ ...current, lengthPolicy: value }));
                  }}
                />
              </label>
              <label className="flex flex-col gap-1">
                설명 방식
                <input
                  aria-label="설명 방식"
                  className={inputClass}
                  value={draft.explanationPolicy}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    updateDraft((current) => ({
                      ...current,
                      explanationPolicy: value,
                    }));
                  }}
                />
              </label>
            </div>

            <label className="flex flex-col gap-1">
              말투 및 페르소나 지시 (모든 모델의 System/Developer 채널로 승격 주입)
              <textarea
                aria-label="말투"
                rows={4}
                className={`min-h-28 resize-y leading-relaxed ${inputClass}`}
                value={draft.voiceAndTone}
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  updateDraft((current) => ({ ...current, voiceAndTone: value }));
                }}
              />
            </label>

            <div className="grid gap-2 rounded border border-border/70 p-2.5">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium">
                  말투 Few-Shot 예시 (실제 대사 2~3줄을 넣으면 모든 모델의 말투 재현율이 크게
                  높아집니다)
                </span>
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  onClick={() =>
                    updateDraft((current) => ({
                      ...current,
                      styleExamples: [
                        ...current.styleExamples,
                        { situation: "보고 시작", goodExample: "", badExample: "" },
                      ],
                    }))
                  }
                >
                  예시 추가
                </Button>
              </div>
              {draft.styleExamples.length === 0 ? (
                <p className="text-muted-foreground">등록된 말투 예시가 없습니다.</p>
              ) : (
                draft.styleExamples.map((example, idx) => (
                  <div key={idx} className="grid gap-1.5 border-t border-border pt-2">
                    <div className="flex items-center gap-2">
                      <input
                        aria-label={`예시 ${idx + 1} 상황`}
                        className={inputClass}
                        placeholder="상황 (예: 보고 시작 / 반대 검증 / 마지막 한 줄 조언)"
                        value={example.situation}
                        onChange={(event) =>
                          updateExample(idx, { situation: event.currentTarget.value })
                        }
                      />
                      <Button
                        type="button"
                        size="xs"
                        variant="ghost"
                        onClick={() =>
                          updateDraft((current) => ({
                            ...current,
                            styleExamples: current.styleExamples.filter((_, i) => i !== idx),
                          }))
                        }
                      >
                        삭제
                      </Button>
                    </div>
                    <input
                      aria-label={`예시 ${idx + 1} 모범 말투`}
                      className={inputClass}
                      placeholder="모범 말투 예시 (원하는 어조 그대로 작성)"
                      value={example.goodExample}
                      onChange={(event) =>
                        updateExample(idx, { goodExample: event.currentTarget.value })
                      }
                    />
                    <input
                      aria-label={`예시 ${idx + 1} 피할 말투`}
                      className={inputClass}
                      placeholder="피할 말투 (선택)"
                      value={example.badExample ?? ""}
                      onChange={(event) =>
                        updateExample(idx, { badExample: event.currentTarget.value })
                      }
                    />
                  </div>
                ))
              )}
            </div>

            <label className="flex flex-col gap-1">
              추가 운영 지시 (자유 텍스트)
              <textarea
                aria-label="추가 운영 지시"
                className={`min-h-24 ${inputClass}`}
                value={draft.extraInstructions}
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  updateDraft((current) => ({
                    ...current,
                    extraInstructions: value,
                  }));
                }}
              />
            </label>
          </div>
        )}

        {activeTab === "contract" && (
          <div className="grid gap-3">
            <div className="grid gap-2 rounded border border-border/70 p-2.5">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium">
                  절대 행동 원칙 (상위 모델 + 하위 위임 모델 공통 준수)
                </span>
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  onClick={() =>
                    updateDraft((current) => ({
                      ...current,
                      corePrinciples: [...current.corePrinciples, ""],
                    }))
                  }
                >
                  원칙 추가
                </Button>
              </div>
              {draft.corePrinciples.length === 0 ? (
                <p className="text-muted-foreground">등록된 핵심 원칙이 없습니다.</p>
              ) : (
                draft.corePrinciples.map((principle, idx) => (
                  <div key={idx} className="flex items-center gap-2">
                    <span className="w-5 shrink-0 text-muted-foreground">{idx + 1}.</span>
                    <input
                      aria-label={`행동 원칙 ${idx + 1}`}
                      className={inputClass}
                      value={principle}
                      onChange={(event) => updatePrinciple(idx, event.currentTarget.value)}
                    />
                    <Button
                      type="button"
                      size="xs"
                      variant="ghost"
                      onClick={() =>
                        updateDraft((current) => ({
                          ...current,
                          corePrinciples: current.corePrinciples.filter((_, i) => i !== idx),
                        }))
                      }
                    >
                      삭제
                    </Button>
                  </div>
                ))
              )}
            </div>

            <div className="grid gap-2 rounded border border-border/70 p-2.5">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium">
                  필수 출력 형식 계약 (응답 완료 시 0ms 자동 검사 연동)
                </span>
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  onClick={() =>
                    updateDraft((current) => ({
                      ...current,
                      outputSections: [
                        ...current.outputSections,
                        {
                          id: `section-${current.outputSections.length + 1}`,
                          heading: "## [보고]",
                          position: "start",
                          required: true,
                          constraint: "핵심 결론부터 제시",
                        },
                      ],
                    }))
                  }
                >
                  섹션 추가
                </Button>
              </div>
              {draft.outputSections.length === 0 ? (
                <p className="text-muted-foreground">
                  필수 섹션이 없습니다. 예: `## [보고]`(시작), `## [비서실장의 조언]`(맨 끝, 최대
                  1줄)
                </p>
              ) : (
                draft.outputSections.map((section, idx) => (
                  <div key={section.id} className="grid gap-1.5 border-t border-border pt-2">
                    <div className="grid gap-2 sm:grid-cols-4">
                      <input
                        aria-label={`섹션 ${idx + 1} 제목`}
                        className={inputClass}
                        placeholder="## [보고]"
                        value={section.heading}
                        onChange={(event) =>
                          updateSection(idx, { heading: event.currentTarget.value })
                        }
                      />
                      <select
                        aria-label={`섹션 ${idx + 1} 위치`}
                        className={inputClass}
                        value={section.position}
                        onChange={(event) =>
                          updateSection(idx, {
                            position: event.currentTarget.value as OutputSectionPosition,
                          })
                        }
                      >
                        {POSITION_LABELS.map(([pos, label]) => (
                          <option key={pos} value={pos}>
                            {label}
                          </option>
                        ))}
                      </select>
                      <input
                        aria-label={`섹션 ${idx + 1} 최대 줄 수`}
                        type="number"
                        min={1}
                        className={inputClass}
                        placeholder="최대 줄 수 (비우면 제한 없음)"
                        value={section.maxLines ?? ""}
                        onChange={(event) => {
                          const num = Number(event.currentTarget.value);
                          updateDraft((current) => ({
                            ...current,
                            outputSections: current.outputSections.map((entry, i) => {
                              if (i !== idx) return entry;
                              if (Number.isInteger(num) && num >= 1) {
                                return { ...entry, maxLines: num };
                              }
                              const { maxLines: _omitted, ...rest } = entry;
                              return rest;
                            }),
                          }));
                        }}
                      />
                      <div className="flex items-center justify-between gap-2">
                        <label className="inline-flex items-center gap-1">
                          <input
                            type="checkbox"
                            checked={section.required}
                            onChange={(event) =>
                              updateSection(idx, { required: event.currentTarget.checked })
                            }
                          />
                          필수
                        </label>
                        <Button
                          type="button"
                          size="xs"
                          variant="ghost"
                          onClick={() =>
                            updateDraft((current) => ({
                              ...current,
                              outputSections: current.outputSections.filter((_, i) => i !== idx),
                            }))
                          }
                        >
                          삭제
                        </Button>
                      </div>
                    </div>
                    <input
                      aria-label={`섹션 ${idx + 1} 제약`}
                      className={inputClass}
                      placeholder="작성 규칙 (예: 단 한 줄로만 작성, 후속 질문 금지)"
                      value={section.constraint}
                      onChange={(event) =>
                        updateSection(idx, { constraint: event.currentTarget.value })
                      }
                    />
                  </div>
                ))
              )}
            </div>

            <div className="grid gap-1.5 rounded border border-border/70 p-2.5">
              <span className="font-medium">이행 강화 옵션</span>
              {(
                [
                  [
                    "suppressDefaultNaturalWriting",
                    "충돌하는 기본 문체(정형표·목록 금지) 자동 억제",
                  ],
                  [
                    "injectRecencyReminder",
                    "매 턴 사용자 메시지 말미에 3줄 핵심 계약 앵커 부착 (이탈 방지)",
                  ],
                  [
                    "propagateCorePrinciplesToSubordinates",
                    "하위 모델(workspace_delegate·오케스트라)에도 절대 행동 원칙 전파",
                  ],
                  [
                    "verifyOutputContract",
                    "응답 완료 시 필수 출력 형식 0ms 검사 및 누락 시 '형식 보정' 버튼 표시",
                  ],
                ] as const
              ).map(([key, label]) => (
                <label key={key} className="inline-flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={draft.enforcement[key]}
                    onChange={(event) => {
                      const checked = event.currentTarget.checked;
                      updateDraft((current) => ({
                        ...current,
                        enforcement: {
                          ...DEFAULT_GLOBAL_ASSISTANT_ENFORCEMENT,
                          ...current.enforcement,
                          [key]: checked,
                        },
                      }));
                    }}
                  />
                  {label}
                </label>
              ))}
              <label className="inline-flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={draft.characterOverridesVoice}
                  onChange={(event) => {
                    const checked = event.currentTarget.checked;
                    updateDraft((current) => ({
                      ...current,
                      characterOverridesVoice: checked,
                    }));
                  }}
                />
                아바타 캐릭터가 전역 말투를 덮어쓰는 것을 허용 (기본 꺼짐 권장)
              </label>
            </div>
          </div>
        )}

        {activeTab === "playbooks" && (
          <div className="grid gap-2">
            <div className="flex items-center justify-between gap-2">
              <p className="text-muted-foreground">
                질문 주제와 키워드가 맞을 때만 해당 본부 규칙을 자동 주입해 지시 희석과 토큰 낭비를
                줄입니다.
              </p>
              <Button
                type="button"
                size="xs"
                variant="outline"
                onClick={() =>
                  updateDraft((current) => ({
                    ...current,
                    domainPlaybooks: [
                      ...current.domainPlaybooks,
                      {
                        id: `playbook-${current.domainPlaybooks.length + 1}`,
                        title: "새 전문 본부",
                        keywords: [],
                        alwaysInclude: false,
                        rules: "",
                      },
                    ],
                  }))
                }
              >
                본부 추가
              </Button>
            </div>
            {draft.domainPlaybooks.length === 0 ? (
              <p className="text-muted-foreground">등록된 분야별 전문 본부가 없습니다.</p>
            ) : (
              draft.domainPlaybooks.map((playbook, idx) => (
                <div
                  key={playbook.id}
                  className="grid gap-1.5 rounded border border-border/70 p-2.5"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      aria-label={`본부 ${idx + 1} 이름`}
                      className={`flex-1 ${inputClass}`}
                      value={playbook.title}
                      onChange={(event) =>
                        updatePlaybook(idx, { title: event.currentTarget.value })
                      }
                    />
                    <label className="inline-flex items-center gap-1">
                      <input
                        type="checkbox"
                        checked={playbook.alwaysInclude}
                        onChange={(event) =>
                          updatePlaybook(idx, { alwaysInclude: event.currentTarget.checked })
                        }
                      />
                      항상 포함
                    </label>
                    <Button
                      type="button"
                      size="xs"
                      variant="ghost"
                      onClick={() =>
                        updateDraft((current) => ({
                          ...current,
                          domainPlaybooks: current.domainPlaybooks.filter((_, i) => i !== idx),
                        }))
                      }
                    >
                      삭제
                    </Button>
                  </div>
                  <input
                    aria-label={`본부 ${idx + 1} 매칭 키워드`}
                    className={inputClass}
                    placeholder="자동 활성화 키워드 (쉼표로 구분, 예: 투자, 주식, 포트폴리오)"
                    value={playbook.keywords.join(", ")}
                    onChange={(event) =>
                      updatePlaybook(idx, {
                        keywords: event.currentTarget.value
                          .split(",")
                          .map((k) => k.trim())
                          .filter(Boolean),
                      })
                    }
                  />
                  <textarea
                    aria-label={`본부 ${idx + 1} 규칙`}
                    className={`min-h-14 ${inputClass}`}
                    value={playbook.rules}
                    onChange={(event) => updatePlaybook(idx, { rules: event.currentTarget.value })}
                  />
                </div>
              ))
            )}
          </div>
        )}

        {activeTab === "monitor" && showMonitorControls && assistant.available && (
          <div className="grid gap-2.5 rounded border border-border/70 p-2.5">
            <p className="text-muted-foreground">
              모니터 비서는 별도의 비서 모델을 두지 않고 위의 <strong>전역 기본 모델</strong>(또는
              연결된 대화의 모델)과 동일한 전역 AI 계약을 사용합니다.
            </p>
            {assistant.error ? (
              <p role="alert" className="text-destructive">
                {assistant.error}
              </p>
            ) : null}
            {!assistant.settings ? (
              <p>모니터 비서 설정을 불러오는 중…</p>
            ) : (
              <>
                <div className="grid gap-2 sm:grid-cols-2">
                  <label className="flex flex-col gap-1">
                    시각 아바타 캐릭터 (말투 덮어쓰기 안 함)
                    <select
                      aria-label="모니터 비서 아바타"
                      className={inputClass}
                      value={assistant.settings.character}
                      onChange={(event) =>
                        void assistant.update({
                          character: event.currentTarget
                            .value as typeof assistant.settings.character,
                        })
                      }
                    >
                      <option value="off">표시 안 함</option>
                      <option value="type95">1번 · 95식</option>
                      <option value="k2">2번 · K2</option>
                      <option value="ots14">3번 · OTs-14</option>
                      <option value="agustina">2D Agustina</option>
                      <option value="pixel">2D 픽셀 캐릭터</option>
                      <option value="livliv">2.5D LivLiv 캐릭터</option>
                      <option value="vrm">3D Polybot</option>
                    </select>
                  </label>
                  <label className="flex flex-col gap-1">
                    음성 전사 후 전송
                    <select
                      aria-label="음성 전사 후 전송"
                      className={inputClass}
                      value={assistant.settings.voiceSendMode ?? "confirm"}
                      onChange={(event) =>
                        void assistant.update({
                          voiceSendMode: event.currentTarget.value as "confirm" | "auto",
                        })
                      }
                    >
                      <option value="confirm">확인 후 전송</option>
                      <option value="auto">자동 전송</option>
                    </select>
                  </label>
                </div>
                {(() => {
                  const currentAudio = assistant.settings.audio ?? DEFAULT_ASSISTANT_AUDIO_SETTINGS;
                  return (
                    <div className="grid gap-2 rounded border border-border/60 bg-muted/20 p-2.5 sm:grid-cols-2">
                      <label className="flex flex-col gap-1">
                        TTS 엔진 (구어 발췌 · 5모음 립싱크)
                        <select
                          aria-label="TTS 엔진"
                          className={inputClass}
                          value={currentAudio.ttsEngine}
                          onChange={(event) =>
                            void assistant.update({
                              audio: {
                                ...currentAudio,
                                ttsEngine: event.currentTarget
                                  .value as AssistantAudioSettings["ttsEngine"],
                              },
                            })
                          }
                        >
                          <option value="local_tts">
                            로컬 기본 음성 (Web Speech + 한글 음소 립싱크)
                          </option>
                          <option value="local_clone">로컬 Qwen 복제 음성</option>
                          <option value="openai_compat">
                            OpenAI 호환 / unspeech (Kokoro·GPT-SoVITS·F5-TTS)
                          </option>
                        </select>
                      </label>
                      <label className="flex flex-col gap-1">
                        오디오 게이트웨이 URL (루프백 권장)
                        <input
                          aria-label="오디오 게이트웨이 URL"
                          className={inputClass}
                          placeholder="http://127.0.0.1:5933"
                          value={currentAudio.audioBaseUrl}
                          onChange={(event) =>
                            void assistant.update({
                              audio: {
                                ...currentAudio,
                                audioBaseUrl: event.currentTarget.value,
                              },
                            })
                          }
                        />
                      </label>
                      <label className="flex flex-col gap-1 sm:col-span-2">
                        커스텀 아바타 URL (선택: .model3.json / .vrm / .livliv)
                        <input
                          aria-label="커스텀 아바타 URL"
                          className={inputClass}
                          placeholder="/agent-characters/live2d-models/.../normal.model3.json 또는 .vrm"
                          value={assistant.settings.customAvatarUrl ?? ""}
                          onChange={(event) =>
                            void assistant.update({
                              customAvatarUrl: event.currentTarget.value.trim() || null,
                            })
                          }
                        />
                      </label>
                      <div className="flex flex-wrap gap-4 sm:col-span-2">
                        <label className="inline-flex items-center gap-1.5">
                          <input
                            type="checkbox"
                            checked={currentAudio.handsFreeVad}
                            onChange={(event) =>
                              void assistant.update({
                                audio: {
                                  ...currentAudio,
                                  handsFreeVad: event.currentTarget.checked,
                                },
                              })
                            }
                          />
                          핸즈프리 VAD 끼어들기 (≤80ms 중단)
                        </label>
                        <label className="inline-flex items-center gap-1.5">
                          <input
                            type="checkbox"
                            checked={assistant.settings.idlePowerSave30Fps ?? true}
                            onChange={(event) =>
                              void assistant.update({
                                idlePowerSave30Fps: event.currentTarget.checked,
                              })
                            }
                          />
                          무음 유휴 30fps 절전 (숨김 시 0fps)
                        </label>
                        <label className="inline-flex items-center gap-1.5">
                          <input
                            type="checkbox"
                            checked={currentAudio.proactiveBriefingEnabled}
                            onChange={(event) =>
                              void assistant.update({
                                audio: {
                                  ...currentAudio,
                                  proactiveBriefingEnabled: event.currentTarget.checked,
                                },
                              })
                            }
                          />
                          백그라운드 완료·지연 능동 브리핑 (30분 쿨다운)
                        </label>
                      </div>
                    </div>
                  );
                })()}
                <div className="flex flex-wrap gap-4">
                  <label className="inline-flex items-center gap-1.5">
                    <input
                      type="checkbox"
                      checked={assistant.settings.alwaysOnTop}
                      onChange={(event) =>
                        void assistant.update({ alwaysOnTop: event.currentTarget.checked })
                      }
                    />
                    항상 위에 표시
                  </label>
                  <label className="inline-flex items-center gap-1.5">
                    <input
                      type="checkbox"
                      checked={assistant.settings.openAtStartup}
                      onChange={(event) =>
                        void assistant.update({ openAtStartup: event.currentTarget.checked })
                      }
                    />
                    T3 시작 시 비서 열기
                  </label>
                  <label className="inline-flex items-center gap-1.5">
                    <input
                      type="checkbox"
                      checked={assistant.settings.keepOnMainClose}
                      onChange={(event) =>
                        void assistant.update({ keepOnMainClose: event.currentTarget.checked })
                      }
                    />
                    메인 창을 닫아도 비서 유지
                  </label>
                </div>
                <div className="flex gap-2">
                  <Button type="button" size="xs" onClick={() => void assistant.open()}>
                    비서 창 열기
                  </Button>
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    onClick={() => void assistant.close()}
                  >
                    비서 창 닫기
                  </Button>
                </div>
              </>
            )}
          </div>
        )}

        {activeTab === "traits" && (
          <PersonaTraitPreviewPanel
            traits={draft.traitGenome ?? DEFAULT_PERSONA_TRAIT_GENOME}
            onChange={(nextTraits) =>
              updateDraft((current) => ({ ...current, traitGenome: nextTraits }))
            }
          />
        )}

        {activeTab === "preview" && (
          <div className="grid gap-2">
            <label className="flex flex-col gap-1">
              테스트 질문 입력 (자동 활성화될 전문 본부와 턴 앵커를 실시간 확인)
              <input
                aria-label="테스트 질문"
                className={inputClass}
                value={previewSample}
                onChange={(event) => setPreviewSample(event.currentTarget.value)}
              />
            </label>
            <p className="text-muted-foreground">
              활성 페르소나: {compiledPreview.activePersonaId} · 상황 모드:{" "}
              {compiledPreview.situationMode} · 정서 엔진:{" "}
              {compiledPreview.livingAffectActive ? "켜짐" : "꺼짐"} · 매칭된 본부:{" "}
              {compiledPreview.matchedPlaybooks.length > 0
                ? compiledPreview.matchedPlaybooks.map((pb) => pb.title).join(", ")
                : "없음 (핵심 계약만 주입)"}
            </p>
            <div
              data-bot-ready-score=""
              className="flex flex-wrap items-center justify-between gap-2 rounded border border-border/60 bg-muted/20 px-2.5 py-1.5 text-[11px]"
            >
              <span className="font-medium text-foreground">
                Bot Ready 계약 점수: {botReadyScore.totalScore}/100 (
                {botReadyScore.recommendedAutonomy}
                {botReadyScore.ready ? " · 기준 충족" : " · 보강 권장"})
              </span>
              {botReadyScore.dimensions.some((d) => !d.passed) && (
                <span className="text-muted-foreground">
                  보강 항목:{" "}
                  {botReadyScore.dimensions
                    .filter((d) => !d.passed)
                    .slice(0, 3)
                    .map((d) => d.label)
                    .join(", ")}
                </span>
              )}
            </div>
            <div className="grid gap-1">
              <span className="font-medium">
                Tier A · System/Developer 계약 ({compiledPreview.stats.systemChars}자, ~
                {compiledPreview.stats.estimatedSystemTokens}토큰)
              </span>
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 font-mono text-[11px]">
                {compiledPreview.systemInstructions ?? "(비활성)"}
              </pre>
            </div>
            {compiledPreview.playbookBlock && (
              <div className="grid gap-1">
                <span className="font-medium">
                  Tier B · 매칭된 전문 본부 ({compiledPreview.stats.playbookChars}자)
                </span>
                <pre className="max-h-36 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 font-mono text-[11px]">
                  {compiledPreview.playbookBlock}
                </pre>
              </div>
            )}
            <div className="grid gap-1">
              <span className="font-medium">
                Tier C · 턴 말미 Recency 앵커 ({compiledPreview.stats.anchorChars}자)
              </span>
              <pre className="max-h-32 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 font-mono text-[11px]">
                {compiledPreview.recencyAnchor ?? "(꺼짐)"}
              </pre>
            </div>
          </div>
        )}

        <div
          data-studio-sticky-footer=""
          className="sticky bottom-0 z-10 flex flex-wrap items-center justify-between gap-2 border-t border-border/80 bg-popover/95 px-2 py-2.5 backdrop-blur-xs"
        >
          <span className="text-[11px] text-muted-foreground tabular-nums">
            시스템 ~{compiledPreview.stats.estimatedSystemTokens} tok · 턴 앵커 ~
            {Math.ceil(compiledPreview.stats.anchorChars / 3)} tok
          </span>
          <div className="flex flex-wrap items-center gap-2">
            {settings.globalAssistant !== null && (
              <Button type="button" size="xs" variant="outline" onClick={() => void persist(null)}>
                전역 설정 해제
              </Button>
            )}
            <Button type="submit" size="xs" disabled={!dirty && settings.globalAssistant !== null}>
              {pending ? "저장 중…" : "전역 AI 설정 저장 (모든 방 즉시 적용)"}
            </Button>
          </div>
        </div>
      </fieldset>
    </form>
  );

  if (compact) {
    return (
      <div
        data-global-assistant-compact-bar=""
        className="relative z-10 flex items-center justify-between gap-2 border-b border-border px-4 py-1.5 text-xs"
      >
        <span className="min-w-0 truncate text-muted-foreground">
          전역 AI · 비서 프로필 · {statusSummary}
        </span>
        <Button type="button" size="xs" variant="outline" onClick={() => setDrawerOpen(true)}>
          스튜디오 열기
        </Button>
        <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
          <SheetPopup
            side="right"
            className="w-[min(740px,94vw)] max-w-none p-0 text-xs"
            data-global-assistant-drawer=""
          >
            <SheetHeader className="shrink-0 border-b border-border px-5 py-3.5 pr-12">
              <SheetTitle className="text-sm font-semibold">전역 AI · 비서 스튜디오</SheetTitle>
              <SheetDescription className="text-xs">{statusSummary}</SheetDescription>
            </SheetHeader>
            <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-4">{content}</div>
          </SheetPopup>
        </Sheet>
      </div>
    );
  }

  return (
    <section aria-label="전역 AI 및 비서 설정" className="border-b border-border px-4 py-3 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">전역 AI · 비서 프로필</h2>
        <span className="text-muted-foreground">{statusSummary}</span>
      </div>
      {content}
    </section>
  );
}
