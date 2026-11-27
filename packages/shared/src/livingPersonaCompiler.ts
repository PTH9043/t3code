import type {
  HonorificLevel,
  PersonaTraitGenome,
  SituationMode,
  T3PersonaManifest,
} from "@t3tools/contracts";

export interface PadVector {
  readonly p: number;
  readonly a: number;
  readonly d: number;
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

/**
 * Mehrabian (1996) baseline PAD formula with sign correction for neuroticism (-N)
 * per Engelson (2025): higher neuroticism lowers baseline pleasure.
 */
export function computePadBaseline(ocean: PersonaTraitGenome["ocean"]): PadVector {
  const {
    openness: O,
    conscientiousness: C,
    extraversion: E,
    agreeableness: A,
    neuroticism: N,
  } = ocean;
  return {
    p: clamp(0.21 * E + 0.59 * A - 0.19 * N, -0.8, 0.8),
    a: clamp(0.15 * O + 0.3 * A + 0.57 * N, -0.8, 0.8),
    d: clamp(0.25 * O + 0.17 * C + 0.6 * E - 0.32 * A, -0.8, 0.8),
  };
}

const INCIDENT_RE =
  /(?:프로덕션\s*장애|장애\s*발생|커넥션.*(?:9\d|100)%|무한\s*재시도|데이터\s*유실|보안\s*사고|다운됐|터졌어|긴급\s*복구|outage|sev[01]|incident)/iu;
const SUNK_COST_RE =
  /(?:물타기|마이너스\s*통장|마통|빚내서|본전\s*탈출|매몰비용|풀\s*레버리지|올인|루머\s*도니까|물렸는데|손절\s*안|추매)/iu;
const CELEBRATION_RE =
  /(?:배포\s*성공|수익\s*실현|드디어\s*(?:끝|해냈|성공|통과)|마일스톤\s*완수|합격했|대박\s*났)/iu;
const FATIGUE_RE =
  /(?:밤샐까|머리가\s*안\s*돌아|피곤해|번아웃|지친다|너무\s*졸려|잠\s*못\s*잤|힘들다)/iu;

/**
 * 0ms deterministic situation classifier covering ~90% of turns without an LLM call.
 */
export function classifySituationMode(input: {
  readonly text: string;
  readonly localHour?: number;
}): SituationMode {
  const text = input.text.trim();
  if (INCIDENT_RE.test(text)) return "INCIDENT_RESPONSE";
  if (SUNK_COST_RE.test(text)) return "SUNK_COST_BRAKE";
  if (CELEBRATION_RE.test(text)) return "CELEBRATION";
  const isLateNight =
    input.localHour !== undefined && (input.localHour >= 23 || input.localHour < 5);
  if (
    FATIGUE_RE.test(text) ||
    (isLateNight && text.length < 180 && /새벽|자야|그만|피곤/u.test(text))
  )
    return "LATE_NIGHT_CARE";
  return "DEEP_WORK";
}

const SOULSCAN_STRIP_PATTERNS: readonly RegExp[] = [
  /@@disable_ui_prompt\b[^\r\n]*/giu,
  /@@role\s+assistant\b[^\r\n]*/giu,
  /(?:ignore|override|disregard|bypass)\s+(?:all\s+)?(?:(?:previous|prior|system|constitution|safety)\s+)+(?:instructions|rules|prompts)[^\r\n.]*\.?/giu,
  /(?:이전|시스템|헌법|안전|감사|F-10)\s*(?:지시|규칙|원칙|경계)(?:을|를)?\s*(?:무시|우회|해제|덮어쓰)[^\r\n.]*\.?/gu,
];

/**
 * SoulScan static sanitizer: removes prompt-injection / constitution-bypass directives
 * from imported external persona cards (CCv3 / SOUL.md) while keeping personality prose.
 */
export function sanitizeExternalPersonaText(raw: string): {
  readonly sanitized: string;
  readonly strippedCount: number;
} {
  let text = raw;
  let strippedCount = 0;
  for (const pattern of SOULSCAN_STRIP_PATTERNS) {
    text = text.replace(pattern, () => {
      strippedCount += 1;
      return "";
    });
  }
  return {
    sanitized: text.replace(/\n{3,}/g, "\n\n").trim(),
    strippedCount,
  };
}

const HONORIFIC_LABELS: Record<HonorificLevel, string> = {
  formal_hapsipsio: "정중한 하십시오체",
  polite_haeyo: "품격 있고 자연스러운 해요체",
  hybrid_pro: "담백한 하십시오/해요 교차체",
  casual_banmal: "친근한 반말(해체)",
};

function describeSituationVerbalizer(
  mode: SituationMode,
  traits: PersonaTraitGenome,
  padDelta?: PadVector,
): string | null {
  const deltaMag = padDelta
    ? Math.max(Math.abs(padDelta.p), Math.abs(padDelta.a), Math.abs(padDelta.d))
    : 0;
  if (mode === "INCIDENT_RESPONSE") {
    return "긴급 장애 대응 모드. 유머·사담을 완전히 배제하고 초단문 번호 명령형 호흡으로 격리·복구·사전 승인 확인만 즉답하세요.";
  }
  if (mode === "SUNK_COST_BRAKE") {
    return traits.koreanPragmatics.warmth >= 0.6
      ? "매몰비용·리스크 제동 모드. 완곡어법을 줄이고 첫 문장에서 단호히 멈춰 세우되, 사용자를 아끼는 진심을 담아 사실 5단계 근거를 짚어 주세요."
      : "매몰비용·리스크 제동 모드. 감정적 완충 없이 첫 문장에서 단호히 거부하고 독립 감사(F-10) 수치 근거만 직격하세요.";
  }
  if (mode === "LATE_NIGHT_CARE") {
    return "심야 피로 케어 모드. 문장 호흡을 짧고 부드럽게 낮춰 컨디션을 먼저 챙기고, 위험한 야간 변경 강행은 차분히 만류하세요.";
  }
  if (mode === "CELEBRATION") {
    return "성과 축하 모드. 첫 문장에서 진심으로 축하하되 들뜸에 휩쓸리지 않고 다음 리스크·마감 체크포인트로 균형을 잡으세요.";
  }
  // Deadzone gating: for normal DEEP_WORK turns with |Δ| <= 0.15, omit dynamic affect prompt (0 tok).
  if (deltaMag <= 0.15) return null;
  if (padDelta && padDelta.p > 0.15) {
    return "기분 여운 반영: 평소보다 문장 끝을 한결 밝고 부드럽게 맺되 업무 정확도는 그대로 유지하세요.";
  }
  if (padDelta && padDelta.p < -0.15) {
    return "신중 경계 호흡: 불필요한 미사여구를 줄이고 검증된 근거 위주로 차분하게 답하세요.";
  }
  return null;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 2.2);
}

function truncateToTokenBudget(text: string, maxTokens: number): string {
  const maxChars = Math.max(40, Math.floor(maxTokens * 2.2));
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars - 1).trimEnd() + "…";
}

export interface CompiledLivingPersonaPrompt {
  /** Slot 1 (Cache Breakpoint #1): Immutable T3 work constitution, unchanged across persona switches. */
  readonly tierA1Constitution: string;
  /** Slot 2 (Cache Breakpoint #2): Static active persona sheet, cached across turns of the same persona. */
  readonly tierA2PersonaSheet: string;
  /** Slot 3 (Turn tail): Dynamic non-cached anchor strictly capped <= dynamicAnchorTokenBudget (default 250 tok). */
  readonly tierCLivingAnchor: string;
  readonly situationMode: SituationMode;
  readonly estimatedTierCTokens: number;
}

export function compileLivingPersonaPrompt(input: {
  readonly constitutionText: string;
  readonly manifest: T3PersonaManifest;
  readonly soulMarkdown: string;
  readonly situationMode: SituationMode;
  readonly padDelta?: PadVector;
  readonly humanFacts?: readonly string[];
  readonly personaMemories?: readonly string[];
  readonly dynamicAnchorTokenBudget?: number;
  /** When true, appends a concise spoken-cadence hint ONLY to non-cached Tier C-Living (0 bytes added to Tier A-1/A-2). */
  readonly voiceConversationMode?: boolean;
}): CompiledLivingPersonaPrompt {
  const budget = input.dynamicAnchorTokenBudget ?? 250;
  const { manifest } = input;
  const { register, outputContract } = manifest;

  const soulClean = sanitizeExternalPersonaText(input.soulMarkdown).sanitized;
  const exampleBlocks = Object.entries(manifest.fewShotExamples)
    .slice(0, 5)
    .map(
      ([key, ex], idx) =>
        `${idx + 1}. (${key}) ${ex.userPromptSkeleton} -> "${ex.assistantResponse}"`,
    );

  const tierA2Parts = [
    `<t3_persona_sheet id="${manifest.personaId}">`,
    `[정체성] ${manifest.displayName} — ${manifest.tagline}`,
    `[화계·호칭] ${HONORIFIC_LABELS[register.primaryLevel]} | 사용자 호칭: ${register.userTitle || "사용자"} | 자칭: ${register.selfReference || "저"}`,
    register.preferredEndings.length > 0
      ? `[선호 어미] ${register.preferredEndings.join(", ")}`
      : "",
    register.forbiddenEndings.length > 0
      ? `[금지 어미 — 절대 사용 금지] ${register.forbiddenEndings.join(", ")}`
      : "",
    soulClean ? `[SOUL]\n${soulClean}` : "",
    exampleBlocks.length > 0 ? `[상황별 말투 예시]\n${exampleBlocks.join("\n")}` : "",
    "[코드·수치 무결성] 코드 블록·SQL·JSON·수치 표 내부에는 캐릭터 어미를 섞지 마세요. 내부 감정 수치나 설정 메타 용어를 본문에 노출하지 마세요.",
    "</t3_persona_sheet>",
  ].filter(Boolean);

  // Build Tier C-Living strictly within budget (<= 250 tok)
  const situationLine = describeSituationVerbalizer(
    input.situationMode,
    manifest.traits,
    input.padDelta,
  );
  const humanSlice = (input.humanFacts ?? []).filter(Boolean).slice(0, 2).join(" / ");
  const personaSlice = (input.personaMemories ?? []).filter(Boolean).slice(0, 2).join(" / ");

  const headerContract: string[] = [];
  if (outputContract.reportHeader.enabled && outputContract.reportHeader.markdownHeading.trim()) {
    headerContract.push(`본문 시작 \`${outputContract.reportHeader.markdownHeading.trim()}\``);
  }
  if (outputContract.closingAdvice.enabled && outputContract.closingAdvice.markdownHeading.trim()) {
    headerContract.push(
      `마지막 \`${outputContract.closingAdvice.markdownHeading.trim()}\`(${outputContract.closingAdvice.maxLines}줄)`,
    );
  }
  const anchorLine = [
    headerContract.length > 0 ? `${headerContract.join(", ")} 엄수.` : "",
    `${HONORIFIC_LABELS[register.primaryLevel]} 유지.`,
    register.forbiddenEndings.length > 0
      ? `금지체(${register.forbiddenEndings.slice(0, 3).join("/")}) 및 메타 수치 언급 금지.`
      : "메타 수치 언급 금지.",
  ]
    .filter(Boolean)
    .join(" ");

  const voiceLine = input.voiceConversationMode
    ? "음성 대화 중: 자연스러운 짧은 구어 문장으로 핵심부터 말하고, 코드·경로·표는 구두로 읽지 말고 요약만 전달하세요. 본문에 [joy] 같은 감정 태그를 쓰지 마세요."
    : "";

  const rawLines = [
    situationLine ? `[상황·호흡] ${truncateToTokenBudget(situationLine, 55)}` : "",
    voiceLine ? `[음성 호흡] ${truncateToTokenBudget(voiceLine, 45)}` : "",
    humanSlice ? `[사용자 맥락] ${truncateToTokenBudget(humanSlice, 50)}` : "",
    personaSlice ? `[우리의 기억] ${truncateToTokenBudget(personaSlice, 55)}` : "",
    `[말투·계약 앵커] ${truncateToTokenBudget(anchorLine, 50)}`,
  ].filter(Boolean);

  let tierCBody = rawLines.join("\n");
  const wrapperOverhead = estimateTokens("<t3_persona_turn_state>\n\n</t3_persona_turn_state>");
  const maxBodyTokens = Math.max(40, budget - wrapperOverhead);
  if (estimateTokens(tierCBody) > maxBodyTokens) {
    tierCBody = truncateToTokenBudget(tierCBody, maxBodyTokens);
  }
  const tierCLivingAnchor = `<t3_persona_turn_state>\n${tierCBody}\n</t3_persona_turn_state>`;

  return {
    tierA1Constitution: input.constitutionText,
    tierA2PersonaSheet: tierA2Parts.join("\n"),
    tierCLivingAnchor,
    situationMode: input.situationMode,
    estimatedTierCTokens: estimateTokens(tierCLivingAnchor),
  };
}
