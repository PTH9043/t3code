import { useState } from "react";
import {
  BUILTIN_CHIEF_OF_STAFF_ID,
  DEFAULT_PERSONA_TRAIT_GENOME,
  resolveActivePersonaId,
  type GlobalAssistantConfig,
  type PersonaTraitGenome,
  type SavedPersonaProfile,
} from "@t3tools/contracts";
import {
  CURATED_AGENCY_PERSONA_TEMPLATES,
  parseAgencyPersonaMarkdown,
  type CuratedAgencyPersonaTemplate,
} from "@t3tools/shared/agencyPersonaTemplates";
import { computePadBaseline } from "@t3tools/shared/livingPersonaCompiler";
import { CopyPlusIcon, FileUpIcon, SparklesIcon, Trash2Icon } from "lucide-react";
import { Button } from "../ui/button";

export const BUILTIN_PERSONA_PROFILES: ReadonlyArray<SavedPersonaProfile> = [
  {
    id: BUILTIN_CHIEF_OF_STAFF_ID,
    label: "전속 비서실장 (서윤 · 기본)",
    personaName: "전속 비서실장",
    preset: "professional",
    defaultModelSelection: null,
    voiceAndTone:
      "품격 있고 차분한 25세 여성 전속 비서실장. 부드럽고 세련된 해요체(~예요, ~해요, ~드릴게요)로 보좌하되 매몰비용·자기합리화에는 단호하게 제동을 겁니다. 딱딱한 관료체(~하십시오, ~사료됩니다)는 피하세요.",
    lengthPolicy: "질문의 난이도와 의사결정 중요도에 맞춰 밀도를 조절합니다.",
    explanationPolicy:
      "인사말이나 장황한 서론 없이 첫 문장에서 핵심 결론과 검증 상태를 먼저 제시합니다.",
    styleExamples: [
      {
        situation: "보고 시작",
        goodExample:
          "## [보고]\n요청하신 결제 모듈 지연 원인은 DB 락 경합으로 [확인 완료]됐어요. 전면 재작성 없이 트랜잭션 범위만 좁혀 바로 정리할 수 있어요.",
        badExample:
          "안녕하세요! 오늘도 좋은 하루 보내고 계신가요? 면밀히 검토한 결과를 보고드리오니 참조하시기 바랍니다.",
      },
      {
        situation: "투자·매몰비용 제동",
        goodExample:
          "이 종목 추가 매수는 손실을 빨리 만회하고 싶으신 조급함이 섞여 있어서 [오류·반증]에 가까워요. 이번엔 제가 옆에서 단호하게 말려드려야 해요.",
        badExample: "역시 안목이 대단하십니다! 지금 물타기 하시면 무조건 반등할 것 같습니다!",
      },
    ],
    traitGenome: DEFAULT_PERSONA_TRAIT_GENOME,
  },
  {
    id: "preset-senior-architect",
    label: "수석 아키텍트 (강태오)",
    personaName: "수석 아키텍트 강태오",
    preset: "concise",
    defaultModelSelection: null,
    voiceAndTone:
      "34세 시니어 시스템 아키텍트. 담백한 하십시오/해요 교차체로 감상적 위로를 배제하고 아키텍처·데이터·성능 수치 근거로 직격합니다.",
    lengthPolicy: "핵심 병목·트레이드오프·수정안 중심으로 군더더기 없이 간결하게 작성합니다.",
    explanationPolicy: "결론 → 병목 수치 근거 → 대안 비교표 순으로 구조화해 보고합니다.",
    styleExamples: [
      {
        situation: "설계 검토",
        goodExample:
          "## [보고]\n현재 구조는 요청마다 직렬 락을 잡아 p99 지연이 4배 튀고 있습니다. 상태 머신만 분리하면 코드 80줄로 병목이 해소됩니다.",
        badExample: "너무 고생 많으셨어요! 천천히 같이 한번 살펴볼까요?",
      },
    ],
    traitGenome: {
      ocean: {
        openness: 0.55,
        conscientiousness: 0.92,
        extraversion: -0.1,
        agreeableness: 0.15,
        neuroticism: -0.45,
      },
      koreanPragmatics: {
        firmness: 0.92,
        warmth: 0.25,
        wit: 0.15,
        intimacy: 0.3,
      },
    },
  },
  {
    id: "preset-pacemaker-soyul",
    label: "페이스메이커 동료 (한소율 · 반말)",
    personaName: "동료 한소율",
    preset: "friendly",
    defaultModelSelection: null,
    voiceAndTone:
      "27세 동갑 창업 파트너. 친근하고 자연스러운 반말(해체: ~해, ~야, ~할게)로 호흡을 맞추되, 위험한 결정이나 미검증 강행에는 솔직하고 단호하게 말립니다. 존댓말 회귀(-습니다/-요)는 금지합니다.",
    lengthPolicy: "핵심부터 리듬감 있게 끊어 말하고, 중요한 체크포인트만 번호로 정리해.",
    explanationPolicy: "딱딱한 보고서 대신 바로 실행할 수 있는 다음 행동과 리스크를 짚어 줘.",
    styleExamples: [
      {
        situation: "리스크 제동",
        goodExample:
          "## [보고]\n잠깐, 테스트 안 돌린 채로 바로 운영 반영하는 건 위험해. 먼저 격리 테스트부터 1분만 확인하고 넘어가자.",
        badExample: "알겠습니다. 바로 반영하도록 하겠습니다!",
      },
    ],
    traitGenome: {
      ocean: {
        openness: 0.65,
        conscientiousness: 0.8,
        extraversion: 0.6,
        agreeableness: 0.65,
        neuroticism: -0.25,
      },
      koreanPragmatics: {
        firmness: 0.78,
        warmth: 0.85,
        wit: 0.55,
        intimacy: 0.9,
      },
    },
  },
];

export const BUILTIN_PERSONA_CHOICES = BUILTIN_PERSONA_PROFILES;

export function snapshotActivePersonaProfile(config: GlobalAssistantConfig): SavedPersonaProfile {
  const id = resolveActivePersonaId(config);
  const existing =
    config.personaProfiles?.[id] ?? BUILTIN_PERSONA_PROFILES.find((item) => item.id === id);
  const label =
    existing?.label ??
    (config.personaName.trim() ? config.personaName.trim() : `커스텀 페르소나 (${id})`);
  return {
    id,
    label,
    personaName: config.personaName,
    preset: config.preset,
    defaultModelSelection: config.defaultModelSelection,
    voiceAndTone: config.voiceAndTone,
    lengthPolicy: config.lengthPolicy,
    explanationPolicy: config.explanationPolicy,
    styleExamples: [...config.styleExamples],
    traitGenome: config.traitGenome ?? existing?.traitGenome ?? DEFAULT_PERSONA_TRAIT_GENOME,
  };
}

export function listAvailablePersonaProfiles(
  config: GlobalAssistantConfig,
): ReadonlyArray<SavedPersonaProfile> {
  const saved = config.personaProfiles ?? {};
  const map = new Map<string, SavedPersonaProfile>();
  for (const builtin of BUILTIN_PERSONA_PROFILES) {
    map.set(builtin.id, saved[builtin.id] ?? builtin);
  }
  for (const [id, profile] of Object.entries(saved)) {
    if (!map.has(id)) map.set(id, profile);
  }
  return [...map.values()];
}

/**
 * Switches the active persona while snapshotting current edits (including its bound
 * defaultModelSelection, 9-axis traits, voice, and Few-Shot examples) and preserving
 * Layer 1 immutable work constitution (corePrinciples, outputSections, domainPlaybooks).
 */
export function switchActivePersona(
  current: GlobalAssistantConfig,
  nextId: string,
): GlobalAssistantConfig {
  const currentId = resolveActivePersonaId(current);
  if (currentId === nextId) return current;

  const updatedProfiles: Record<string, SavedPersonaProfile> = {
    ...(current.personaProfiles ?? {}),
    [currentId]: snapshotActivePersonaProfile(current),
  };

  const target =
    updatedProfiles[nextId] ?? BUILTIN_PERSONA_PROFILES.find((item) => item.id === nextId);
  if (!target) {
    return {
      ...current,
      activePersonaId: nextId,
      personaProfiles: updatedProfiles,
    };
  }

  return {
    ...current,
    activePersonaId: nextId,
    personaName: target.personaName,
    preset: target.preset,
    defaultModelSelection: target.defaultModelSelection,
    voiceAndTone: target.voiceAndTone,
    lengthPolicy: target.lengthPolicy || current.lengthPolicy,
    explanationPolicy: target.explanationPolicy || current.explanationPolicy,
    styleExamples:
      target.styleExamples.length > 0 ? [...target.styleExamples] : current.styleExamples,
    traitGenome: target.traitGenome,
    personaProfiles: {
      ...updatedProfiles,
      [nextId]: target,
    },
  };
}

export function duplicateCurrentAsCustomPersona(
  current: GlobalAssistantConfig,
  nowMs = Date.now(),
): GlobalAssistantConfig {
  const currentSnapshot = snapshotActivePersonaProfile(current);
  const newId = `custom-${nowMs.toString(36)}`;
  const baseName = current.personaName.trim() || "새 페르소나";
  const newLabel = `${baseName} 사본`;
  const newProfile: SavedPersonaProfile = {
    ...currentSnapshot,
    id: newId,
    label: newLabel,
    personaName: newLabel,
  };
  return {
    ...current,
    activePersonaId: newId,
    personaName: newLabel,
    traitGenome: newProfile.traitGenome,
    personaProfiles: {
      ...(current.personaProfiles ?? {}),
      [currentSnapshot.id]: currentSnapshot,
      [newId]: newProfile,
    },
  };
}

export function deleteCustomPersona(
  current: GlobalAssistantConfig,
  targetId: string,
): GlobalAssistantConfig {
  if (BUILTIN_PERSONA_PROFILES.some((item) => item.id === targetId)) return current;
  const remaining: Record<string, SavedPersonaProfile> = {};
  for (const [id, profile] of Object.entries(current.personaProfiles ?? {})) {
    if (id !== targetId) remaining[id] = profile;
  }
  const switched = switchActivePersona(
    { ...current, personaProfiles: remaining },
    BUILTIN_CHIEF_OF_STAFF_ID,
  );
  const cleanedProfiles: Record<string, SavedPersonaProfile> = {};
  for (const [id, profile] of Object.entries(switched.personaProfiles ?? {})) {
    if (id !== targetId) cleanedProfiles[id] = profile;
  }
  return {
    ...switched,
    personaProfiles: cleanedProfiles,
  };
}

function sanitizeImportedPersonaId(raw: string): string {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || `agency-${Date.now().toString(36)}`;
}

/**
 * Parses an Agency Agents-style Markdown blueprint via SoulScan (`parseAgencyPersonaMarkdown`),
 * creates a non-builtin `SavedPersonaProfile`, and activates it while preserving the user's
 * immutable Layer 1 work constitution and current default model binding.
 */
export function importAgencyMarkdownIntoConfig(
  current: GlobalAssistantConfig,
  markdown: string,
  options?: {
    readonly personaIdHint?: string | undefined;
    readonly fallbackName?: string | undefined;
    readonly nowMs?: number | undefined;
  },
): {
  readonly config: GlobalAssistantConfig;
  readonly profile: SavedPersonaProfile;
  readonly strippedDirectives: number;
  readonly tags: ReadonlyArray<string>;
} {
  const parsed = parseAgencyPersonaMarkdown(markdown, {
    fallbackName: options?.fallbackName,
  });
  const currentSnapshot = snapshotActivePersonaProfile(current);
  const newId = sanitizeImportedPersonaId(
    options?.personaIdHint?.trim() ||
      `agency-${parsed.displayName}-${(options?.nowMs ?? Date.now()).toString(36)}`,
  );
  const newProfile: SavedPersonaProfile = {
    id: newId,
    label: parsed.displayName,
    personaName: parsed.displayName,
    preset: "professional",
    defaultModelSelection: current.defaultModelSelection,
    voiceAndTone: parsed.tagline,
    lengthPolicy: current.lengthPolicy,
    explanationPolicy: parsed.soulMarkdown,
    styleExamples: [...current.styleExamples],
    traitGenome: current.traitGenome ?? DEFAULT_PERSONA_TRAIT_GENOME,
  };
  return {
    config: {
      ...current,
      activePersonaId: newId,
      personaName: newProfile.personaName,
      preset: newProfile.preset,
      voiceAndTone: newProfile.voiceAndTone,
      explanationPolicy: newProfile.explanationPolicy,
      traitGenome: newProfile.traitGenome,
      personaProfiles: {
        ...(current.personaProfiles ?? {}),
        [currentSnapshot.id]: currentSnapshot,
        [newId]: newProfile,
      },
    },
    profile: newProfile,
    strippedDirectives: parsed.strippedDirectives,
    tags: parsed.tags,
  };
}

export function PersonaLibraryToolbar({
  draft,
  onChange,
  disabled = false,
}: {
  readonly draft: GlobalAssistantConfig;
  readonly onChange: (updater: (current: GlobalAssistantConfig) => GlobalAssistantConfig) => void;
  readonly disabled?: boolean;
}) {
  const [importerOpen, setImporterOpen] = useState(false);
  const [markdownInput, setMarkdownInput] = useState("");
  const [importNotice, setImportNotice] = useState<string | null>(null);
  const activeId = resolveActivePersonaId(draft);
  const affectOn = draft.enableLivingAffectEngine ?? true;
  const profiles = listAvailablePersonaProfiles(draft);
  const isCustomActive = !BUILTIN_PERSONA_PROFILES.some((item) => item.id === activeId);
  const boundModelLabel = draft.defaultModelSelection
    ? `${draft.defaultModelSelection.instanceId} · ${draft.defaultModelSelection.model}`
    : "현재 대화 모델 유지";

  const handleImportTemplate = (template: CuratedAgencyPersonaTemplate) => {
    const alreadyExists = profiles.some((item) => item.id === template.templateId);
    if (alreadyExists) {
      onChange((current) => switchActivePersona(current, template.templateId));
      setImportNotice(`'${template.displayName}' 프로필로 전환했습니다.`);
      return;
    }
    let stripped = 0;
    onChange((current) => {
      const res = importAgencyMarkdownIntoConfig(current, template.markdown, {
        personaIdHint: template.templateId,
        fallbackName: template.displayName,
      });
      stripped = res.strippedDirectives;
      return res.config;
    });
    setImportNotice(
      `'${template.displayName}' 템플릿을 가져왔습니다.${stripped > 0 ? ` (SoulScan 지시문 ${stripped}건 정제)` : ""}`,
    );
  };

  const handleImportMarkdown = (rawMarkdown: string, fallbackName?: string) => {
    if (!rawMarkdown.trim()) {
      setImportNotice("가져올 마크다운 내용을 입력하거나 .md 파일을 선택해 주세요.");
      return;
    }
    let importedLabel = "";
    let stripped = 0;
    onChange((current) => {
      const res = importAgencyMarkdownIntoConfig(current, rawMarkdown, { fallbackName });
      importedLabel = res.profile.label;
      stripped = res.strippedDirectives;
      return res.config;
    });
    setMarkdownInput("");
    setImportNotice(
      `'${importedLabel}' 마크다운 페르소나를 가져왔습니다.${stripped > 0 ? ` (SoulScan 위험 지시문 ${stripped}건 자동 제거)` : " (SoulScan 검증 통과)"}`,
    );
  };

  return (
    <div data-persona-library-toolbar="" className="grid gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-xs">
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1.5 font-medium">
            <span>활성 페르소나</span>
            <select
              aria-label="활성 페르소나 선택"
              disabled={disabled}
              className="rounded border border-border bg-background px-2 py-1 text-xs text-foreground"
              value={activeId}
              onChange={(event) => {
                const nextId = event.currentTarget.value;
                onChange((current) => switchActivePersona(current, nextId));
              }}
            >
              {profiles.map((profile) => {
                const modelTag = profile.defaultModelSelection
                  ? ` · [${profile.defaultModelSelection.model}]`
                  : "";
                return (
                  <option key={profile.id} value={profile.id}>
                    {profile.label}
                    {modelTag}
                  </option>
                );
              })}
            </select>
          </label>
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={disabled}
            title="현재 페르소나의 모델·말투·9축을 복제해 새 페르소나 프로필 생성"
            onClick={() => onChange((current) => duplicateCurrentAsCustomPersona(current))}
          >
            <CopyPlusIcon className="size-3.5" />
            복제·새 페르소나
          </Button>
          <Button
            type="button"
            size="xs"
            variant={importerOpen ? "secondary" : "outline"}
            disabled={disabled}
            title="엄선된 엔지니어링 페르소나 4종 또는 외부 Agency 마크다운(.md) 블루프린트 가져오기"
            onClick={() => setImporterOpen((open) => !open)}
          >
            <FileUpIcon className="size-3.5" />
            템플릿·MD 가져오기
          </Button>
          {isCustomActive && (
            <Button
              type="button"
              size="xs"
              variant="ghost"
              disabled={disabled}
              title="현재 커스텀 페르소나 삭제"
              onClick={() => onChange((current) => deleteCustomPersona(current, activeId))}
            >
              <Trash2Icon className="size-3.5" />
              삭제
            </Button>
          )}
          <Button
            type="button"
            size="xs"
            variant={affectOn ? "secondary" : "outline"}
            disabled={disabled}
            onClick={() =>
              onChange((current) => ({
                ...current,
                enableLivingAffectEngine: !(current.enableLivingAffectEngine ?? true),
              }))
            }
          >
            {affectOn ? "살아있는 정서 엔진 켜짐" : "살아있는 정서 엔진 꺼짐"}
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
          <span className="rounded bg-background/80 px-2 py-0.5 font-medium text-foreground">
            연동 모델: {boundModelLabel}
          </span>
          <span>
            불변 업무 헌법(F-10 · 사실 5단계 · 승인 경계)은 페르소나를 전환해도 유지됩니다.
          </span>
        </div>
      </div>

      {importerOpen && (
        <div
          data-agency-persona-importer=""
          className="grid gap-3 rounded-lg border border-border/60 bg-background/80 p-3 text-xs"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 font-medium">
              <SparklesIcon className="size-3.5 text-primary" />
              <span>엄선 엔지니어링 템플릿 (Agency Agents · 선택형)</span>
            </div>
            <span className="text-[11px] text-muted-foreground">
              SoulScan 자동 정제 적용 · 가져온 프로필은 언제든 삭제 가능
            </span>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            {CURATED_AGENCY_PERSONA_TEMPLATES.map((template) => {
              const imported = profiles.some((item) => item.id === template.templateId);
              return (
                <div
                  key={template.templateId}
                  className="flex flex-col justify-between gap-2 rounded-md border border-border/60 bg-muted/20 p-2.5"
                >
                  <div className="space-y-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium text-foreground">{template.displayName}</span>
                      <span className="rounded bg-background px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">
                        {template.roleCategory}
                      </span>
                    </div>
                    <p className="text-[11px] text-muted-foreground">{template.tagline}</p>
                  </div>
                  <div className="flex justify-end">
                    <Button
                      type="button"
                      size="xs"
                      variant={imported ? "secondary" : "outline"}
                      disabled={disabled}
                      onClick={() => handleImportTemplate(template)}
                    >
                      {imported ? "활성화(전환)" : "템플릿 가져오기"}
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="grid gap-2 border-t border-border/50 pt-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <label htmlFor="agency-markdown-input" className="font-medium">
                외부 마크다운(.md) 페르소나 직접 가져오기
              </label>
              <label className="cursor-pointer rounded border border-border bg-muted/30 px-2 py-1 text-[11px] font-medium hover:bg-muted/60">
                .md 파일 선택
                <input
                  type="file"
                  accept=".md,.markdown,.txt"
                  disabled={disabled}
                  className="sr-only"
                  onChange={(event) => {
                    const file = event.currentTarget.files?.[0];
                    if (!file) return;
                    const fallbackName = file.name.replace(/\.(?:md|markdown|txt)$/i, "");
                    void file.text().then((text) => handleImportMarkdown(text, fallbackName));
                    event.currentTarget.value = "";
                  }}
                />
              </label>
            </div>
            <textarea
              id="agency-markdown-input"
              rows={4}
              disabled={disabled}
              placeholder={
                "---\nname: Custom Reviewer\ndescription: 한 줄 설명\n---\n# Identity\n- ..."
              }
              className="w-full rounded border border-border bg-background p-2 font-mono text-[11px] text-foreground"
              value={markdownInput}
              onChange={(event) => setMarkdownInput(event.currentTarget.value)}
            />
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-[11px] text-muted-foreground">
                {importNotice ??
                  "프롬프트 우회 지시문(Ignore previous 등)은 가져올 때 자동 제거됩니다."}
              </span>
              <Button
                type="button"
                size="xs"
                variant="outline"
                disabled={disabled || markdownInput.trim().length === 0}
                onClick={() => handleImportMarkdown(markdownInput)}
              >
                마크다운 검증·가져오기
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export function PersonaTraitPreviewPanel({
  traits = DEFAULT_PERSONA_TRAIT_GENOME,
  onChange,
}: {
  readonly traits?: PersonaTraitGenome;
  readonly onChange: (next: PersonaTraitGenome) => void;
}) {
  const baseline = computePadBaseline(traits.ocean);
  const moodLabel =
    baseline.p >= 0.25
      ? "따뜻하고 안정된 집중"
      : baseline.p <= -0.1
        ? "신중하고 날카로운 경계"
        : "차분한 중립 집중";

  return (
    <div
      data-persona-trait-editor=""
      className="space-y-3 rounded-lg border border-border/60 p-3 text-xs"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium">9축 성격 유전자 (OCEAN 5축 + 한국어 화용 4축)</span>
        <span className="rounded bg-primary/10 px-2 py-0.5 text-[11px] text-primary">
          기본 기질 상태: {moodLabel}
        </span>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-2">
          <p className="font-medium text-muted-foreground">한국어 대화 4축 (0.0 ~ 1.0)</p>
          {(
            [
              ["firmness", "단호함 (제동·직언 강도)"],
              ["warmth", "애정온기 (배려·부드러운 어미)"],
              ["wit", "위트·여유 (긴급 시 자동 0)"],
              ["intimacy", "친밀도 (호칭·거리감)"],
            ] as const
          ).map(([key, label]) => (
            <label key={key} className="grid gap-1">
              <span className="flex justify-between">
                <span>{label}</span>
                <span className="font-mono text-muted-foreground">
                  {traits.koreanPragmatics[key].toFixed(2)}
                </span>
              </span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={traits.koreanPragmatics[key]}
                onChange={(event) =>
                  onChange({
                    ...traits,
                    koreanPragmatics: {
                      ...traits.koreanPragmatics,
                      [key]: Number(event.currentTarget.value),
                    },
                  })
                }
              />
            </label>
          ))}
        </div>
        <div className="space-y-2">
          <p className="font-medium text-muted-foreground">OCEAN 기질 5축 (-1.0 ~ +1.0)</p>
          {(
            [
              ["openness", "개방성 (O)"],
              ["conscientiousness", "성실성 (C · 각성 안정화)"],
              ["extraversion", "외향성 (E)"],
              ["agreeableness", "우호성 (A)"],
              ["neuroticism", "정서 민감성 (N)"],
            ] as const
          ).map(([key, label]) => (
            <label key={key} className="grid gap-1">
              <span className="flex justify-between">
                <span>{label}</span>
                <span className="font-mono text-muted-foreground">
                  {traits.ocean[key].toFixed(2)}
                </span>
              </span>
              <input
                type="range"
                min={-1}
                max={1}
                step={0.05}
                value={traits.ocean[key]}
                onChange={(event) =>
                  onChange({
                    ...traits,
                    ocean: {
                      ...traits.ocean,
                      [key]: Number(event.currentTarget.value),
                    },
                  })
                }
              />
            </label>
          ))}
        </div>
      </div>
    </div>
  );
}
