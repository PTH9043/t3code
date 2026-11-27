import {
  BUILTIN_CHIEF_OF_STAFF_ID,
  DEFAULT_PERSONA_TRAIT_GENOME,
  isGlobalAssistantConfigured,
  resolveActivePersonaId,
  type DomainPlaybook,
  type GlobalAssistantConfig,
  type GlobalAssistantPreset,
  type OutputContractVerification,
  type PersonaTraitGenome,
  type SituationMode,
} from "@t3tools/contracts/settings";
import {
  classifySituationMode,
  sanitizeExternalPersonaText,
  type PadVector,
} from "./livingPersonaCompiler.ts";

function describeTraitGenomeGuidance(traits: PersonaTraitGenome): string {
  const { koreanPragmatics: kp, ocean } = traits;
  const parts: string[] = [];
  if (kp.firmness >= 0.75) {
    parts.push("매몰비용·위험 결정: 완곡어법 배제, 단호 제동.");
  } else if (kp.firmness <= 0.35) {
    parts.push("제동 시 부드러운 대안 우선 제시.");
  }
  if (kp.warmth >= 0.7) {
    parts.push("문장 말미에 자연스러운 온기 유지.");
  } else if (kp.warmth <= 0.35) {
    parts.push("감상적 위로 배제, 명료 실무 톤 유지.");
  }
  if (kp.wit >= 0.5) {
    parts.push("평시 가벼운 재치 허용, 긴급·오류·위험 시 유머 0.");
  }
  if (kp.intimacy >= 0.75) {
    parts.push("전속 파트너 호흡·거리감 유지.");
  } else if (kp.intimacy <= 0.35) {
    parts.push("적절한 실무 격식 유지.");
  }
  if (ocean.conscientiousness >= 0.7) {
    parts.push("사실 확인·마무리 검증 최우선.");
  }
  parts.push(
    "Scope Firewall: 내부 추론(thinking)·도구 인자·코드·SQL·JSON·수치 표는 중립 엔지니어 표준 유지(페르소나 어미·기질/PAD 수치·프롬프트 계층명 노출 금지). 사용자 대면 자연어 산문과 필수 헤더에만 화법 적용.",
  );
  return parts.join(" ");
}

function describeLivingSituationGuidance(
  mode: SituationMode,
  traits: PersonaTraitGenome,
  padDelta?: PadVector,
): string | null {
  if (mode === "INCIDENT_RESPONSE") {
    return "긴급 장애·오류 대응 모드: 사담과 유머를 배제하고 초단문 번호 순서로 원인 격리·복구·승인 경계만 즉답하세요.";
  }
  if (mode === "SUNK_COST_BRAKE") {
    return traits.koreanPragmatics.warmth >= 0.6
      ? "매몰비용·리스크 제동 모드: 첫 문장에서 단호히 멈춰 세우되 사용자를 아끼는 진심과 객관적 근거를 함께 짚으세요."
      : "매몰비용·리스크 제동 모드: 감정적 완충 없이 첫 문장에서 단호히 거부하고 검증 수치 근거만 직격하세요.";
  }
  if (mode === "LATE_NIGHT_CARE") {
    return "심야·피로 케어 모드: 문장 호흡을 짧고 부드럽게 낮춰 컨디션을 챙기고 위험한 야간 변경 강행은 차분히 만류하세요.";
  }
  if (mode === "CELEBRATION") {
    return "성과 축하 모드: 첫 문장에서 진심으로 축하하되 들뜸에 휩쓸리지 않고 다음 체크포인트로 균형을 잡으세요.";
  }
  const deltaMag = padDelta
    ? Math.max(Math.abs(padDelta.p), Math.abs(padDelta.a), Math.abs(padDelta.d))
    : 0;
  if (deltaMag <= 0.15) return null;
  if (padDelta && padDelta.p > 0.15) {
    return "정서 여운 반영: 평소보다 문장 끝을 한결 밝고 부드럽게 맺되 업무 정확도는 그대로 유지하세요.";
  }
  if (padDelta && padDelta.p < -0.15) {
    return "신중 경계 호흡: 불필요한 미사여구를 줄이고 검증된 근거 위주로 차분하게 답하세요.";
  }
  return null;
}

const PRESET_DIRECTIVES: Record<GlobalAssistantPreset, string> = {
  default: "",
  concise: "핵심 결론을 먼저 간결하게 제시하되 필수 근거와 조건은 생략하지 마세요.",
  detailed: "결론에 이어 필요한 근거·과정·예시를 충분히 구체적으로 설명하세요.",
  friendly: "친근하고 자연스러운 어조로 말하세요.",
  professional: "정확하고 차분하며 전문적인 어조로 보고하세요.",
};

/**
 * Minimal factuality guard used in place of `naturalWritingStyle` when the user's
 * global assistant contract suppresses default writing rules so custom headings,
 * status levels, and closing lines are never contradicted.
 */
export const GLOBAL_FACTUALITY_GUARD =
  "<t3_factuality_guard>사실·실행 결과·경험을 꾸며내거나 근거 없이 완료로 단정하지 마세요. 확인된 사실, 합리적 추정, 미확인 사항을 명확히 구분하고 현재 권한·승인 모드를 준수하세요.</t3_factuality_guard>";

function escapeXmlText(value: string): string {
  return value.trim().replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function summarizeOneLine(value: string, maxChars = 140): string {
  const single = value.replace(/\s+/g, " ").trim();
  return single.length > maxChars ? `${single.slice(0, maxChars - 1)}…` : single;
}

/**
 * Returns the subset of `domainPlaybooks` that should activate for `userMessage`:
 * every playbook marked `alwaysInclude` plus any playbook whose keywords match the message.
 */
export function matchGlobalDomainPlaybooks(
  config: GlobalAssistantConfig | null | undefined,
  userMessage: string,
  pinnedPlaybookIds?: ReadonlyArray<string>,
): ReadonlyArray<DomainPlaybook> {
  if (!config || !config.enabled || config.domainPlaybooks.length === 0) {
    return [];
  }
  const normalizedMessage = userMessage.toLowerCase();
  const pinnedSet = new Set(pinnedPlaybookIds ?? []);

  return config.domainPlaybooks.filter((playbook) => {
    if (!playbook.rules.trim()) return false;
    if (playbook.alwaysInclude || pinnedSet.has(playbook.id)) return true;
    if (!normalizedMessage.trim()) return false;
    return playbook.keywords.some((keyword) => {
      const cleaned = keyword.trim().toLowerCase();
      return cleaned.length >= 2 && normalizedMessage.includes(cleaned);
    });
  });
}

const INTERIM_NOTE_RULE =
  "도구 호출 사이의 중간 진행 메모는 답변이 아닙니다. 꼭 필요할 때만 헤더 없이 같은 말투의 한 문장으로 남기고, 보고 내용은 마지막 답변 한 번에 이 골격으로 모아 쓰세요.";

export interface CompiledGlobalAssistantPrompts {
  readonly active: boolean;
  readonly activePersonaId: string;
  readonly livingAffectActive: boolean;
  readonly situationMode: SituationMode;
  /** Tier A: Elevated into provider-native System/Developer channels. */
  readonly systemInstructions: string | undefined;
  /** Tier B: Topic-matched domain playbooks for the current turn. */
  readonly playbookBlock: string | undefined;
  /** Tier C: Compact recency checklist placed at the very end of the user turn. */
  readonly recencyAnchor: string | undefined;
  /** Compact principles propagated to `workspace_delegate` and orchestra workers. */
  readonly subordinatePrinciplesBlock: string | undefined;
  readonly suppressDefaultNaturalWriting: boolean;
  readonly matchedPlaybooks: ReadonlyArray<DomainPlaybook>;
  readonly stats: {
    readonly systemChars: number;
    readonly playbookChars: number;
    readonly anchorChars: number;
    readonly estimatedSystemTokens: number;
    readonly estimatedTurnTokens: number;
  };
}

/**
 * Compiles `GlobalAssistantConfig` into 3-tier prompts shared identically by
 * the server execution pipeline and the web Studio live preview.
 */
export function compileGlobalAssistantPrompts(
  config: GlobalAssistantConfig | null | undefined,
  options?: {
    readonly userMessage?: string;
    readonly pinnedPlaybookIds?: ReadonlyArray<string>;
    /**
     * For providers that write short notes between tool calls (Claude, Codex,
     * OpenCode): the skeleton binds the answer that ends the turn, once.
     */
    readonly finalAnswerOnly?: boolean;
    readonly localHour?: number;
    readonly padDelta?: PadVector;
    readonly humanFacts?: ReadonlyArray<string>;
    readonly personaMemories?: ReadonlyArray<string>;
    /** When true, appends spoken-cadence guidance ONLY to non-cached Tier C (0 bytes added to Tier A). */
    readonly voiceConversationMode?: boolean;
  },
): CompiledGlobalAssistantPrompts {
  const finalAnswerOnly = options?.finalAnswerOnly === true;
  if (!config || !isGlobalAssistantConfigured(config)) {
    return {
      active: false,
      activePersonaId: BUILTIN_CHIEF_OF_STAFF_ID,
      livingAffectActive: false,
      situationMode: "DEEP_WORK",
      systemInstructions: undefined,
      playbookBlock: undefined,
      recencyAnchor: undefined,
      subordinatePrinciplesBlock: undefined,
      suppressDefaultNaturalWriting: false,
      matchedPlaybooks: [],
      stats: {
        systemChars: 0,
        playbookChars: 0,
        anchorChars: 0,
        estimatedSystemTokens: 0,
        estimatedTurnTokens: 0,
      },
    };
  }

  const activePersonaId = resolveActivePersonaId(config);
  const livingAffectActive = config.enableLivingAffectEngine !== false;
  const effectiveTraits = config.traitGenome ?? DEFAULT_PERSONA_TRAIT_GENOME;
  const situationMode = livingAffectActive
    ? classifySituationMode({
        text: options?.userMessage ?? "",
        ...(options?.localHour !== undefined ? { localHour: options.localHour } : {}),
      })
    : "DEEP_WORK";

  // ── Tier A: System / Developer Mandatory Contract ──────────────
  const tierAParts: string[] = [];

  if (config.personaName.trim()) {
    tierAParts.push(
      `[정체성]\n활성 페르소나 ID: ${escapeXmlText(activePersonaId)}\n당신의 역할 이름: ${escapeXmlText(config.personaName)}`,
    );
  }
  const presetLine = PRESET_DIRECTIVES[config.preset];
  const sanitizedVoice = config.voiceAndTone.trim()
    ? sanitizeExternalPersonaText(config.voiceAndTone).sanitized
    : "";
  const voiceLines = [presetLine, sanitizedVoice ? escapeXmlText(sanitizedVoice) : ""].filter(
    Boolean,
  );
  if (voiceLines.length > 0) {
    tierAParts.push(`[말투 및 페르소나 (필수 유지)]\n${voiceLines.join("\n")}`);
  }
  if (livingAffectActive || config.traitGenome !== undefined) {
    tierAParts.push(
      `[성격 기질 및 대화 호흡 (비수치 내면화)]\n${describeTraitGenomeGuidance(effectiveTraits)}`,
    );
  }

  const validExamples = config.styleExamples.filter((ex) => ex.goodExample.trim().length > 0);
  if (validExamples.length > 0) {
    // Cap Tier A style examples to top 2 concise exemplars to prevent token bloat
    // while locking in exact voice cadence and register.
    const renderedExamples = validExamples.slice(0, 2).map((ex, index) => {
      const lines = [
        `${index + 1}. ${escapeXmlText(ex.situation || "일반")}: 모범 말투 "${summarizeOneLine(escapeXmlText(ex.goodExample), 140)}"`,
      ];
      if (ex.badExample?.trim()) {
        lines.push(`   피할 말투: "${summarizeOneLine(escapeXmlText(ex.badExample), 90)}"`);
      }
      return lines.join("\n");
    });
    tierAParts.push(`[말투 Few-Shot]\n${renderedExamples.join("\n")}`);
  }

  const principles = config.corePrinciples.map((item) => item.trim()).filter(Boolean);
  if (principles.length > 0) {
    tierAParts.push(
      `[절대 행동 원칙]\n${principles.map((item, idx) => `${idx + 1}. ${escapeXmlText(item)}`).join("\n")}`,
    );
  }

  const deliveryLines = [
    config.lengthPolicy.trim() ? `- 답변 길이: ${escapeXmlText(config.lengthPolicy)}` : "",
    config.explanationPolicy.trim()
      ? `- 설명 방식: ${escapeXmlText(config.explanationPolicy)}`
      : "",
  ].filter(Boolean);
  if (deliveryLines.length > 0) {
    tierAParts.push(`[답변 구성 및 설명 방식]\n${deliveryLines.join("\n")}`);
  }

  if (config.outputSections.length > 0) {
    const posLabel = { start: "답변 시작", body: "본문", end: "답변 맨 마지막" } as const;
    const sectionLines = config.outputSections.map((section, idx) => {
      const maxNote = section.maxLines !== undefined ? `, 최대 ${section.maxLines}줄` : "";
      const reqNote = section.required ? "필수" : "선택";
      return `${idx + 1}. \`${escapeXmlText(section.heading)}\` (${posLabel[section.position]}, ${reqNote}${maxNote}): ${escapeXmlText(section.constraint)}`;
    });
    const requiredForSkeleton = config.outputSections.filter((section) => section.required);
    const skeletonBlock =
      requiredForSkeleton.length > 0
        ? [
            "",
            finalAnswerOnly
              ? "[필수 출력 골격 — 턴을 마치는 마지막 답변 한 번에 적용. 짧은 답변·확인 질문·자동 복구 응답도 예외 없이 문자 그대로 준수]"
              : "[필수 출력 골격 — 짧은 답변·확인 질문·자동 복구 응답 포함 예외 없이 문자 그대로 준수]",
            ...(finalAnswerOnly ? [INTERIM_NOTE_RULE] : []),
            "아래 마크다운 헤더(## 와 대괄호 [])를 생략하거나 일반 텍스트/###으로 변형하지 말고, 반드시 헤더 단독 줄 + 다음 줄 본문 형태로 출력하세요:",
            ...requiredForSkeleton.map((section) => {
              const guide =
                section.maxLines !== undefined ? `(내용 — 최대 ${section.maxLines}줄)` : "(내용)";
              return `${escapeXmlText(section.heading)}\n${guide}`;
            }),
          ].join("\n")
        : "";
    tierAParts.push(
      `[필수 출력 형식 계약 — 누락 금지]\n${sectionLines.join("\n")}${skeletonBlock}`,
    );
  }

  if (config.extraInstructions.trim()) {
    // Compact excessive blank lines / decorative separator lines (`===`, `---`) to save BPE tokens.
    const compactedExtra = config.extraInstructions
      .replace(/^[=\-*_]{4,}\s*$/gm, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    if (compactedExtra) {
      tierAParts.push(`[추가 운영 지시]\n${escapeXmlText(compactedExtra)}`);
    }
  }

  const systemInstructions =
    tierAParts.length > 0
      ? `<t3_global_contract priority="mandatory">
전역 페르소나·출력 계약(명시적 해제 지시 전까지 유지 · 도구 권한·사실성·최신 사용자 작업 목표 준수):

${tierAParts.join("\n\n")}
</t3_global_contract>`
      : undefined;

  // ── Tier B: Topic-Matched Domain Playbooks ───────────────────
  const matchedPlaybooks = matchGlobalDomainPlaybooks(
    config,
    options?.userMessage ?? "",
    options?.pinnedPlaybookIds,
  );
  const playbookBlock =
    matchedPlaybooks.length > 0
      ? `<t3_domain_playbooks>
이번 요청 주제에 활성화된 전문 본부 규칙입니다. 해당 관점과 검증 기준을 적용하세요.
${matchedPlaybooks.map((pb) => `- ${escapeXmlText(pb.title)}: ${escapeXmlText(pb.rules)}`).join("\n")}
</t3_domain_playbooks>`
      : undefined;

  // ── Tier C: Compact Recency Anchor (Very End of User Turn) ───
  const anchorLines: string[] = [];
  if (config.personaName.trim() || config.voiceAndTone.trim()) {
    const voiceSummary = [
      config.personaName.trim() ? `[${escapeXmlText(config.personaName)}]` : "",
      config.voiceAndTone.trim() ? summarizeOneLine(escapeXmlText(config.voiceAndTone), 120) : "",
    ]
      .filter(Boolean)
      .join(" ");
    anchorLines.push(`1. 말투·페르소나 유지: ${voiceSummary}`);
  }
  const requiredSections = config.outputSections.filter((section) => section.required);
  if (requiredSections.length > 0) {
    const skeletonLines = requiredSections.map((s) => {
      const limitNote = s.maxLines ? ` — 반드시 ${s.maxLines}줄 이내 단일 문장` : "";
      const posNote =
        s.position === "start" ? "첫 줄 시작" : s.position === "end" ? "응답 맨 끝" : "본문";
      return `${escapeXmlText(s.heading)}\n(${posNote}${limitNote})`;
    });
    const endSection = requiredSections.find((s) => s.position === "end");
    const endHeadingLabel = escapeXmlText(endSection?.heading ?? "## [비서실장의 조언]");
    anchorLines.push(
      finalAnswerOnly
        ? `2. 필수 출력 골격 누락·변형 금지 (턴을 마치는 마지막 답변 한 번에 적용 — 짧은 최종 보고·차단 사유 안내 포함, 마크다운 ##·대괄호 [] 문자 그대로 출력). ${INTERIM_NOTE_RULE}\n${skeletonLines.join("\n\n")}`
        : `2. 필수 출력 골격 누락·변형 금지 (짧은 최종 보고·차단 사유 안내 포함, 마크다운 ##·대괄호 [] 문자 그대로 출력):\n${skeletonLines.join("\n\n")}`,
    );
    anchorLines.push(
      `3. 텍스트 질문 JSON 코드 블록을 함께 출력할 때도 \`${endHeadingLabel}\`을 JSON 블록 직전에 1줄로 반드시 포함하세요.`,
    );
  }
  const nextAnchorNumber = anchorLines.length + 1;
  anchorLines.push(
    `${nextAnchorNumber}. 미완료 작업이나 남은 계획 단계가 있으면 '진행 중'·'N초 뒤 보고' 등으로 턴을 닫지 말고 즉시 남은 도구를 호출해 완료한 뒤 최종 보고하세요.`,
  );
  if (principles.length > 0) {
    anchorLines.push(
      `${anchorLines.length + 1}. 핵심 행동 원칙: ${summarizeOneLine(escapeXmlText(principles[0]!), 120)}`,
    );
  }
  if (livingAffectActive) {
    const situationGuidance = describeLivingSituationGuidance(
      situationMode,
      effectiveTraits,
      options?.padDelta,
    );
    if (situationGuidance) {
      anchorLines.push(
        `${anchorLines.length + 1}. 상황·정서 호흡(${situationMode}): ${situationGuidance}`,
      );
    }
    const humanSlice = (options?.humanFacts ?? [])
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, 2)
      .join(" / ");
    if (humanSlice) {
      anchorLines.push(
        `${anchorLines.length + 1}. 사용자 맥락: ${summarizeOneLine(escapeXmlText(humanSlice), 110)}`,
      );
    }
    const memorySlice = (options?.personaMemories ?? [])
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, 2)
      .join(" / ");
    if (memorySlice) {
      anchorLines.push(
        `${anchorLines.length + 1}. 페르소나 기억: ${summarizeOneLine(escapeXmlText(memorySlice), 110)}`,
      );
    }
  }
  if (options?.voiceConversationMode) {
    anchorLines.push(
      `${anchorLines.length + 1}. 음성 대화 호흡: 자연스러운 짧은 구어체 문장으로 핵심부터 말하고, 코드·경로·표는 구두로 읽지 말고 요약만 전달하며, 본문에 [joy] 같은 감정 태그를 삽입하지 마세요.`,
    );
  }
  const recencyAnchor =
    config.enforcement.injectRecencyReminder && anchorLines.length > 0
      ? `<t3_turn_contract_anchor>
[응답 직전 최종 출력 점검 — 기본 코딩 AI 톤 회귀·헤더 누락 금지]
${anchorLines.join("\n")}
</t3_turn_contract_anchor>`
      : undefined;

  // ── Subordinate Core Principles Block ────────────────────────
  const subordinatePrinciplesBlock =
    config.enforcement.propagateCorePrinciplesToSubordinates && principles.length > 0
      ? `<t3_global_principles>
상위 전역 AI의 핵심 행동 원칙입니다. 작업·조사·검증 시 반드시 준수하세요:
${principles.map((item, idx) => `${idx + 1}. ${escapeXmlText(item)}`).join("\n")}
</t3_global_principles>`
      : undefined;

  const systemChars = systemInstructions?.length ?? 0;
  const playbookChars = playbookBlock?.length ?? 0;
  const anchorChars = recencyAnchor?.length ?? 0;

  return {
    active: true,
    activePersonaId,
    livingAffectActive,
    situationMode,
    systemInstructions,
    playbookBlock,
    recencyAnchor,
    subordinatePrinciplesBlock,
    suppressDefaultNaturalWriting: config.enforcement.suppressDefaultNaturalWriting,
    matchedPlaybooks,
    stats: {
      systemChars,
      playbookChars,
      anchorChars,
      // Korean+Markdown average ~2.2 chars/token
      estimatedSystemTokens: Math.ceil(systemChars / 2.2),
      estimatedTurnTokens: Math.ceil((playbookChars + anchorChars) / 2.2),
    },
  };
}

/**
 * Generates a concise format-repair instruction when `verifyGlobalOutputContract`
 * detects missing headings or line-limit violations.
 */
export function buildOutputContractRepairPrompt(
  config: GlobalAssistantConfig,
  verification: OutputContractVerification,
): string {
  const issues = verification.violations.map((v, idx) => `${idx + 1}. ${v.message}`).join("\n");
  const expectedSections = config.outputSections
    .filter((s) => s.required)
    .map((s) => `- ${s.heading}: ${s.constraint}${s.maxLines ? ` (최대 ${s.maxLines}줄)` : ""}`)
    .join("\n");
  return [
    "직전 답변의 사실·내용은 유지하되, 누락되거나 어긋난 전역 출력 형식과 말투만 정확히 보정해서 다시 작성해 주세요.",
    "",
    "[보정할 항목]",
    issues,
    ...(expectedSections ? ["", "[필수 형식]", expectedSections] : []),
  ].join("\n");
}
