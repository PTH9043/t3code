/**
 * Context-Preserving Memory v3 — Deterministic Entity, Rationale, Contextual Prefix,
 * and Fact/Observation Consolidation Helpers (`0ms` LLM-free runtime path).
 */

import { formatLocalIsoDate } from "./koreanTemporalParser.ts";

export type MemoryLayer = "fact" | "observation";

const KOREAN_HONORIFIC_SUFFIX =
  /(?:팀장님|책임님|수석님|매니저님|대표님|실장님|리드님|팀장|책임|수석|선임|매니저|리드|대표|원장|실장|님|씨)$/u;

/**
 * Generic common Korean nouns / pronouns / modifiers that are NOT specific named entities.
 * Rejecting these prevents unrelated notes like "서버의 포트: 3000" and "서버의 포트: 8080"
 * from superseding one another across different services (see WorkspaceMemory.test.ts).
 */
export const GENERIC_KOREAN_ENTITY_NOUNS: ReadonlySet<string> = new Set([
  "서버",
  "서비스",
  "설정",
  "버전",
  "모델",
  "포트",
  "경로",
  "런타임",
  "패키지",
  "패키지매니저",
  "데이터베이스",
  "앱",
  "어플",
  "애플리케이션",
  "프로그램",
  "시스템",
  "프로젝트",
  "워크스페이스",
  "화면",
  "페이지",
  "컴포넌트",
  "환경",
  "기본",
  "현재",
  "기존",
  "이전",
  "과거",
  "전체",
  "최신",
  "로컬",
  "운영",
  "개발",
  "스테이징",
  "프로덕션",
  "테스트",
  "모듈",
  "패키지들",
  "파일",
  "폴더",
  "디렉토리",
  "방",
  "대화",
  "스레드",
  "세션",
  "계정",
  "사용자",
  "유저",
  "고객",
  "담당자",
  "에이전트",
  "작업자",
  "일꾼",
  "하위",
  "상위",
  "내부",
  "외부",
  "우리",
  "저희",
  "각각",
  "일부",
  "위쪽",
  "아래",
  "앞쪽",
  "뒤쪽",
  "이번",
  "당시",
  "원래",
  "실제",
  "공통",
  "개별",
  "내일",
  "오늘",
  "어제",
  "방금",
  "클라이언트",
  "백엔드",
  "프론트",
  "프론트엔드",
]);

/**
 * Strip Korean honorifics ("김민지님" -> "김민지") while keeping at least 2 characters.
 */
export function stripKoreanHonorific(raw: string): string {
  const trimmed = raw.normalize("NFKC").trim();
  const match = KOREAN_HONORIFIC_SUFFIX.exec(trimmed);
  if (!match) return trimmed;
  const stem = trimmed.slice(0, trimmed.length - match[0].length).trim();
  return Array.from(stem).length >= 2 ? stem : trimmed;
}

/**
 * Validate whether an `<entity>의` candidate names a specific Latin or Korean entity
 * (e.g. `auth-api`, `결제서버`, `주문서비스`, `김민지님`) rather than a generic noun (`서버`, `설정`).
 */
export function normalizeSpecificSlotEntity(rawCandidate: string | undefined): string | null {
  if (!rawCandidate) return null;
  const stripped = stripKoreanHonorific(rawCandidate).toLowerCase().replace(/\s+/gu, " ");
  if (Array.from(stripped).length < 2) return null;

  // Latin/alphanumeric identifier (`auth-api`, `server.http`, `node`, `t3`)
  if (/[a-z]/iu.test(stripped)) {
    return GENERIC_KOREAN_ENTITY_NOUNS.has(stripped) ? null : stripped;
  }

  // Pure Hangul (+ optional digits/hyphens): must not be a bare generic noun
  if (/^[가-힣][가-힣0-9_-]*$/u.test(stripped)) {
    if (GENERIC_KOREAN_ENTITY_NOUNS.has(stripped)) return null;
    return stripped;
  }

  return null;
}

const OPTION_PLAN_TOKEN =
  /(?<![a-zA-Z0-9가-힣])([a-zA-Z]|[1-9]|일|이|삼|갑|을)\s*안(?=[으로로은는이가을를에의\s,.!?)]|$)/giu;
const KOREAN_DECISION_DOMAIN_NOUNS = [
  "결제",
  "인증",
  "로그인",
  "보안",
  "배포",
  "데이터베이스",
  "스토리지",
  "캐시",
  "인프라",
  "검색",
  "임베딩",
  "메모리",
  "기억",
  "모델",
  "백엔드",
  "프론트엔드",
  "모바일",
  "데스크톱",
  "아키텍처",
  "요금제",
  "예산",
  "수수료",
  "알림",
  "배치",
  "스케줄러",
] as const;

/**
 * Extract normalized entity/concept tags (up to 12) for Entity Co-occurrence Arm (Arm 3)
 * and Tail Embedding enrichment.
 */
export function extractMemoryEntities(
  text: string,
  topic = "",
  explicitEntityKey?: string | null,
): string[] {
  const normalized = `${topic} ${text}`.normalize("NFKC");
  const entities = new Set<string>();

  if (explicitEntityKey && explicitEntityKey.trim()) {
    entities.add(explicitEntityKey.trim().toLowerCase());
  }

  // 1. Option plans ("A안", "B안", "1안") -> emit both specific plan ("a안") and shared group ("option_plan")
  for (const match of normalized.matchAll(OPTION_PLAN_TOKEN)) {
    const planLabel = `${match[1]!.toLowerCase()}안`;
    entities.add(planLabel);
    entities.add("option_plan");
  }

  // 2. Backticked code/file identifiers
  for (const match of normalized.matchAll(/`([^`\r\n]{2,64})`/gu)) {
    const token = match[1]!.trim().toLowerCase();
    if (token && !token.includes(" ")) {
      entities.add(token);
      const base = token.split(/[\\/]/).at(-1);
      if (base && base.length >= 2) entities.add(base);
    }
  }

  // 3. Hyphenated / dotted technical identifiers (`auth-api`, `bge-m3`, `gpt-5`, `state.sqlite`)
  for (const match of normalized.matchAll(/\b[a-z][a-z0-9]*(?:[-._][a-z0-9]+)+\b/giu)) {
    const id = match[0].toLowerCase();
    if (id.length >= 3 && id.length <= 48) entities.add(id);
  }

  // 4. Specific `<entity>의` mentions (`결제서버의`, `김민지님의`)
  for (const match of normalized.matchAll(
    /(?<![\p{L}\p{N}_.-])([a-zA-Z0-9가-힣_-]{2,20})의(?=\s)/gu,
  )) {
    const specific = normalizeSpecificSlotEntity(match[1]);
    if (specific) entities.add(specific);
  }

  // 5. Domain nouns when paired with option plans or architectural decisions
  const lower = normalized.toLowerCase();
  for (const domain of KOREAN_DECISION_DOMAIN_NOUNS) {
    if (lower.includes(domain)) {
      entities.add(domain);
    }
  }

  return [...entities].slice(0, 12);
}

export type DecisionCandidateKind =
  | "reasoned_decision"
  | "override_decision"
  | "tentative_question";

export interface ExtractedDecisionCandidate {
  readonly kind: DecisionCandidateKind;
  readonly subjectKey: string;
  readonly decisionSummary: string;
  readonly rationale: string | null;
  readonly entities: ReadonlyArray<string>;
}

const QUESTION_ENDING =
  /(?:할까(?:요)?|쓸까(?:요)?|갈까(?:요)?|바꿀까(?:요)?|어때(?:요)?|어떨까(?:요)?|괜찮을까(?:요)?|볼까(?:요)?)\s*\??\s*$/u;
const EXPLICIT_REASON_CLAUSE =
  /(?<rationale>[^.\n!?]{2,90}?)\s*(?:때문에|이유로|사유로|문제로|제약으로|한계로|덕분에|위해서)\s*,?\s*(?<decision>[^.\n!?]{3,160})/u;
const POSTFIX_REASON_CLAUSE =
  /(?<decision>[^.\n!?]{3,120}?(?:채택|결정|선택|전환|기각|보류|고정|제한)[^.\n!?]{0,30}?)\s*(?:\(|—|-|:|이유는|사유는|원인은)\s*(?<rationale>[^.\n!?)]{2,90})/u;
const STRONG_DECISION_VERB =
  /(?:채택|결정했|선택했|가기로\s*했|쓰기로\s*했|하기로\s*했|전환하기로|변경하기로|기각했|기각한다|제외하기로|보류하기로|제한한다|고정한다)/u;
const EXPLICIT_OVERRIDE_CUE =
  /(?:이제부터(?:는)?|기존\s*결정을?\s*바꿔|전환하기로\s*(?:결정|확정)|변경하기로\s*(?:결정|확정)|대신\s*[^\s]+(?:으로|로)\s*(?:전환|변경|확정))/u;

function deriveDecisionSubjectKey(text: string, entities: ReadonlyArray<string>): string | null {
  const hasOptionPlan = entities.includes("option_plan");
  if (hasOptionPlan) {
    // Keep option-plan choices ("B안으로 가기로 했어" -> "그냥 A안으로 할까?") in one shared subject
    // within the same (scope, projectId, folder) even when follow-up turns omit the domain noun.
    return "decision:option_plan";
  }
  const domainEntity = entities.find((e) =>
    (KOREAN_DECISION_DOMAIN_NOUNS as readonly string[]).includes(e),
  );
  const specificTechEntity = entities.find(
    (e) =>
      e !== "option_plan" &&
      !/^[a-z0-9가-힣]안$/u.test(e) &&
      !(KOREAN_DECISION_DOMAIN_NOUNS as readonly string[]).includes(e),
  );

  if (specificTechEntity && domainEntity) {
    return `decision:${specificTechEntity}:${domainEntity}`;
  }
  if (specificTechEntity) {
    return `decision:${specificTechEntity}`;
  }
  if (domainEntity) {
    return `decision:${domainEntity}`;
  }
  const head = text.normalize("NFKC").trim().slice(0, 24).replace(/\s+/gu, "_");
  return head.length >= 4 ? `decision:${head}` : null;
}

/**
 * Deterministic extractor for user architectural/product decisions, their causal `rationale`,
 * and casual reconsideration questions ("그냥 A안으로 할까?").
 */
export function extractDecisionCandidate(
  text: string,
  origin: string,
  topic = "",
): ExtractedDecisionCandidate | null {
  if (origin !== "user" && origin !== "user-requested") return null;
  const cleaned = text.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (cleaned.length < 5 || cleaned.length > 1_200) return null;

  const entities = extractMemoryEntities(cleaned, topic);
  const isQuestion = cleaned.endsWith("?") || QUESTION_ENDING.test(cleaned);

  // Casual reconsideration question (e.g., "그냥 A안으로 할까?", "결제 방식을 바꿀까?")
  if (isQuestion) {
    if (!entities.includes("option_plan") && entities.length === 0) return null;
    const subjectKey = deriveDecisionSubjectKey(cleaned, entities);
    if (!subjectKey) return null;
    return {
      kind: "tentative_question",
      subjectKey,
      decisionSummary: cleaned.slice(0, 180),
      rationale: null,
      entities,
    };
  }

  const reasonMatch = EXPLICIT_REASON_CLAUSE.exec(cleaned) ?? POSTFIX_REASON_CLAUSE.exec(cleaned);
  if (reasonMatch?.groups) {
    const rawRationale = reasonMatch.groups.rationale?.trim() ?? "";
    const rawDecision = reasonMatch.groups.decision?.trim() ?? "";
    if (
      rawRationale.length >= 2 &&
      rawDecision.length >= 3 &&
      (STRONG_DECISION_VERB.test(cleaned) || entities.includes("option_plan"))
    ) {
      const subjectKey = deriveDecisionSubjectKey(cleaned, entities);
      if (!subjectKey) return null;
      return {
        kind: EXPLICIT_OVERRIDE_CUE.test(cleaned) ? "override_decision" : "reasoned_decision",
        subjectKey,
        decisionSummary: rawDecision.slice(0, 220),
        rationale: rawRationale.slice(0, 160),
        entities,
      };
    }
  }

  if (EXPLICIT_OVERRIDE_CUE.test(cleaned) && STRONG_DECISION_VERB.test(cleaned)) {
    const subjectKey = deriveDecisionSubjectKey(cleaned, entities);
    if (!subjectKey) return null;
    return {
      kind: "override_decision",
      subjectKey,
      decisionSummary: cleaned.slice(0, 220),
      rationale: null,
      entities,
    };
  }

  return null;
}

export interface SynthesizedObservationSpec {
  readonly subjectKey: string;
  readonly primaryFactId: string;
  readonly topic: string;
  readonly text: string;
  readonly rationale: string | null;
  readonly proofFactIds: ReadonlyArray<string>;
  readonly entities: ReadonlyArray<string>;
  readonly validFrom: number;
  readonly validTo: number | null;
  readonly supersededObservationKeys: ReadonlyArray<string>;
}

/**
 * Apply Rationale Precedence & Transition Narrative across chronological decision candidates
 * sharing the same `(scope, projectId, subjectKey)`:
 * 1) A reasoned decision creates an active `observation` backed by `proofFactIds`.
 * 2) A later casual question without rationale ("그냥 A안으로 할까?") NEVER supersedes a reasoned
 *    observation; it appends a reconsideration note while preserving the active rationale.
 * 3) A later explicit reasoned change closes the earlier observation and synthesizes a
 *    "[과거 결정(이유)] → [변경 사유]로 인해 [현 결정]으로 전환" narrative linking all proof Fact IDs.
 */
export function synthesizeSubjectObservations(
  events: ReadonlyArray<{
    readonly factId: string;
    readonly createdAtMs: number;
    readonly candidate: ExtractedDecisionCandidate;
  }>,
): ReadonlyArray<SynthesizedObservationSpec> {
  if (events.length === 0) return [];
  const observations: Array<{
    key: string;
    subjectKey: string;
    primaryFactId: string;
    topic: string;
    decisionSummary: string;
    dateIso: string;
    text: string;
    rationale: string | null;
    proofFactIds: string[];
    entities: Set<string>;
    validFrom: number;
    validTo: number | null;
    supersededObservationKeys: string[];
  }> = [];

  for (const event of events) {
    const { factId, createdAtMs, candidate } = event;
    const dateIso = formatLocalIsoDate(createdAtMs);
    const active = observations.findLast((obs) => obs.validTo === null);

    if (candidate.kind === "tentative_question") {
      if (active) {
        if (!active.proofFactIds.includes(factId)) {
          active.proofFactIds.push(factId);
        }
        for (const entity of candidate.entities) active.entities.add(entity);
        const reconsiderTag = `[${dateIso} 재검토 질문 발생: "${candidate.decisionSummary}" — 기존 결정 이유(${active.rationale ?? "명시 사유 확인"}) 유효 여부 확인 필요]`;
        if (!active.text.includes(reconsiderTag)) {
          active.text = `${active.text}\n${reconsiderTag}`;
        }
      }
      continue;
    }

    // Reasoned decision or explicit override
    if (!active) {
      const label = candidate.subjectKey.replace(/^decision:/, "").replaceAll(":", " · ");
      const text = candidate.rationale
        ? `[${dateIso} 확정 결정] ${candidate.decisionSummary} (결정 이유: ${candidate.rationale})`
        : `[${dateIso} 확정 결정] ${candidate.decisionSummary}`;
      observations.push({
        key: `${candidate.subjectKey}::${factId}`,
        subjectKey: candidate.subjectKey,
        primaryFactId: factId,
        topic: `의사결정 관찰 · ${label}`,
        decisionSummary: candidate.decisionSummary,
        dateIso,
        text,
        rationale: candidate.rationale,
        proofFactIds: [factId],
        entities: new Set(candidate.entities),
        validFrom: createdAtMs,
        validTo: null,
        supersededObservationKeys: [],
      });
      continue;
    }

    // Duplicate restatement of same summary & rationale -> augment proof IDs only
    if (
      active.decisionSummary === candidate.decisionSummary &&
      (active.rationale ?? "") === (candidate.rationale ?? "")
    ) {
      if (!active.proofFactIds.includes(factId)) active.proofFactIds.push(factId);
      for (const entity of candidate.entities) active.entities.add(entity);
      continue;
    }

    // Rationale Precedence: if active observation has an explicit rationale and the new statement
    // has NO rationale and is NOT an explicit override, augment rather than supersede!
    if (active.rationale && !candidate.rationale && candidate.kind !== "override_decision") {
      if (!active.proofFactIds.includes(factId)) active.proofFactIds.push(factId);
      for (const entity of candidate.entities) active.entities.add(entity);
      active.text = `${active.text}\n[${dateIso} 후속 언급(사유 미기재로 기존 결정 유지): ${candidate.decisionSummary}]`;
      continue;
    }

    // Explicit reasoned transition -> close previous observation & synthesize transition narrative
    active.validTo = createdAtMs;
    const label = candidate.subjectKey.replace(/^decision:/, "").replaceAll(":", " · ");
    const priorClause = active.rationale
      ? `[${active.dateIso} 구 결정: ${active.decisionSummary} (당시 이유: ${active.rationale})]`
      : `[${active.dateIso} 구 결정: ${active.decisionSummary}]`;
    const transitionReason = candidate.rationale
      ? `[${dateIso} 변경 사유: ${candidate.rationale}]로 인해 `
      : `[${dateIso} 명시적 결정 변경] `;
    const transitionText = `${priorClause} → ${transitionReason}[현 결정: ${candidate.decisionSummary}]로 전환`;
    const mergedProofIds = [...new Set([...active.proofFactIds, factId])];
    const mergedEntities = new Set([...active.entities, ...candidate.entities]);

    observations.push({
      key: `${candidate.subjectKey}::${factId}`,
      subjectKey: candidate.subjectKey,
      primaryFactId: factId,
      topic: `의사결정 관찰 · ${label}`,
      decisionSummary: candidate.decisionSummary,
      dateIso,
      text: transitionText,
      rationale: candidate.rationale ?? active.rationale,
      proofFactIds: mergedProofIds,
      entities: mergedEntities,
      validFrom: createdAtMs,
      validTo: null,
      supersededObservationKeys: [active.key],
    });
  }

  return observations.map((obs) => ({
    subjectKey: obs.subjectKey,
    primaryFactId: obs.primaryFactId,
    topic: obs.topic,
    text: obs.text,
    rationale: obs.rationale,
    proofFactIds: obs.proofFactIds,
    entities: [...obs.entities],
    validFrom: obs.validFrom,
    validTo: obs.validTo,
    supersededObservationKeys: obs.supersededObservationKeys,
  }));
}

/**
 * Deterministic `0ms` Contextual Retrieval prefix (`안 1`).
 */
export function buildDeterministicContextPrefix(input: {
  readonly createdAtMs: number;
  readonly topic: string;
  readonly origin: string;
  readonly scope?: string | undefined;
  readonly folder?: string | null | undefined;
  readonly threadTitle?: string | null | undefined;
  readonly rationale?: string | null | undefined;
}): string {
  const dateIso = formatLocalIsoDate(input.createdAtMs);
  const speaker =
    input.origin === "user" || input.origin === "user-requested"
      ? "사용자"
      : input.origin === "system"
        ? "시스템"
        : "AI보고";
  const parts = [`기준일:${dateIso}`, `화자:${speaker}`];
  if (input.scope === "global") parts.push("범위:공용");
  if (input.folder) parts.push(`폴더:${input.folder}`);
  if (input.threadTitle) parts.push(`대화:${input.threadTitle.slice(0, 60)}`);
  if (input.topic) parts.push(`주제:${input.topic.slice(0, 60)}`);
  if (input.rationale) parts.push(`이유:${input.rationale.slice(0, 80)}`);
  return `[맥락 ${parts.join(" · ")}]`;
}

/**
 * Shared-entity graph score $\tanh(0.5 \times |\text{shared}|) \in [0, 1)$ for 4-arm RRF Arm 3.
 */
export function computeEntityOverlapScore(
  queryEntities: ReadonlySet<string>,
  candidateEntities: ReadonlyArray<string>,
): number {
  if (queryEntities.size === 0 || candidateEntities.length === 0) return 0;
  let shared = 0;
  for (const entity of candidateEntities) {
    if (queryEntities.has(entity.toLowerCase())) {
      shared += 1;
    }
  }
  return shared > 0 ? Math.tanh(0.5 * shared) : 0;
}
