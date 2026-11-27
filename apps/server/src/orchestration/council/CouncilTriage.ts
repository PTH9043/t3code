/**
 * 0ms Deterministic Intelligent Triage Gate for Multi-Model Council.
 *
 * Avoids 4.2x token overhead on simple questions or narrow single-file edits while
 * surfacing clear council recommendations for cross-layer, high-risk, or architectural tasks.
 */

import {
  createAndRecordClassifierTelemetry,
  type ClassifierTelemetry,
  type CouncilMode,
  type EffectiveCouncilMode,
} from "@t3tools/contracts";

const EXPLICIT_DISCUSSION_ONLY_PATTERN =
  /(?:분석만|검토만|토론만|논의만|보고서만|수정\s*하지\s*말|코드\s*변경\s*없이|패치\s*없이|의견만)/iu;

const CODE_MUTATION_INTENT_PATTERN =
  /(?:수정해|고쳐|구현해|패치해|리팩터링해|마이그레이션해|작성해|추가해|제거해|삭제해|변경해|반영해|적용해|강화해|보완해|업데이트해|(?:버그|오류|결함|파일|코드|함수|컴포넌트|스키마)를?\s*(?:수정|구현|패치|리팩터링|개선|교체|강화)|\b(?:fix|implement|patch|refactor|migrate)\b)/iu;

const PURE_INQUIRY_TAIL_PATTERN =
  /(?:어떻게\s*성공|왜\s*(?:성공|실패)|원인\s*파악|공통점\s*분석|패턴.*협의|(?:방향|방안|전략|계획|우선순위)을?\s*(?:확정|수립|정리|결정)(?:해|해줘|하자)?[.!?~\s]*$|(?:전략|방안|방향|원인|이유|패턴).*?(?:논의|협의|분석|토론|비교|확정)[.!?~\s]*$)/iu;

/**
 * Resolves `"auto"` into `"discussion"` (report-only synthesis posted to timeline) vs
 * `"code_patch"` (CAS file locks + 1-click PinnedSpec worker execution).
 * - When `requestedMode === undefined` (programmatic callers / legacy RPC), preserves `"code_patch"`.
 * - When `requestedMode === "auto"` (UI default), defaults to `"discussion"` unless clear code-edit intent exists.
 */
export function resolveEffectiveCouncilMode(
  userPrompt: string,
  requestedMode?: CouncilMode,
): EffectiveCouncilMode {
  if (requestedMode === "discussion" || requestedMode === "code_patch") {
    return requestedMode;
  }
  if (requestedMode === undefined) {
    return "code_patch";
  }
  const trimmed = userPrompt.trim();
  if (!trimmed || EXPLICIT_DISCUSSION_ONLY_PATTERN.test(trimmed)) {
    return "discussion";
  }
  if (PURE_INQUIRY_TAIL_PATTERN.test(trimmed) && !/(?:수정해|고쳐|구현해|패치해)/iu.test(trimmed)) {
    return "discussion";
  }
  if (CODE_MUTATION_INTENT_PATTERN.test(trimmed)) {
    return "code_patch";
  }
  return "discussion";
}

export interface CouncilTriageEvaluation {
  readonly score: number;
  readonly recommendation: "skip" | "suggest" | "auto";
  readonly reasons: ReadonlyArray<string>;
  readonly telemetry?: ClassifierTelemetry<"skip" | "suggest" | "auto">;
}

const EXPLICIT_COUNCIL_PATTERN =
  /(?:^|\s)\/council(?:\s|$)|다자간\s*회의|위원회\s*(?:소집|열어|시작)|멀티\s*모델\s*회의/iu;
const SHORT_FOLLOWUP_PATTERN =
  /^(?:계속|진행|진행해|진행해줘|보고|상태|확인|응|네|좋아|승인|오케이|ok|yes|continue|proceed|go|계속\s*해라|곗혹\s*해라)[.!?~\s]*$/iu;

const HIGH_RISK_DOMAIN_PATTERNS: ReadonlyArray<{ readonly rx: RegExp; readonly label: string }> = [
  {
    rx: /마이그레이션|migration|sqlite|스키마|schema|데이터베이스|db\s*변경/iu,
    label: "DB·스키마 변경",
  },
  { rx: /인증|권한|보안|security|auth|ssrf|인젝션|암호화|토큰\s*검증/iu, label: "보안·권한 경계" },
  {
    rx: /동시성|경쟁\s*조건|race\s*condition|데드락|락|worktree|재시작|복구|상태\s*머신|fsm/iu,
    label: "동시성·상태 머신",
  },
  {
    rx: /아키텍처|리팩토링|전면\s*개편|통합\s*설계|파이프라인|오케스트레/iu,
    label: "아키텍처·파이프라인 설계",
  },
];

const BROAD_SCOPE_PATTERN =
  /전수|전체|일괄|다중|멀티|end-to-end|e2e|모노레포|계약.*서버.*웹|(\d+)\s*개\s*(?:이상\s*)?(?:파일|모듈|패키지|웨이브|단계)/iu;

const LAYER_PATTERNS: ReadonlyArray<{ readonly rx: RegExp; readonly name: string }> = [
  { rx: /packages\/contracts|@t3tools\/contracts|스키마|계약|rpc/iu, name: "contracts" },
  { rx: /apps\/server|백엔드|서버|sqlite|오케스트/iu, name: "server" },
  { rx: /apps\/web|프론트|ui\/ux|컴포넌트|화면|테마/iu, name: "web" },
  { rx: /apps\/desktop|electron|ipc/iu, name: "desktop" },
  { rx: /apps\/mobile|모바일|react\s*native/iu, name: "mobile" },
];

export function evaluateCouncilTriage(input: {
  readonly userPrompt: string;
  readonly forceCouncil?: boolean;
}): CouncilTriageEvaluation {
  const prompt = input.userPrompt.trim();
  if (input.forceCouncil || EXPLICIT_COUNCIL_PATTERN.test(prompt)) {
    const telemetry = createAndRecordClassifierTelemetry({
      classifier: "council_triage",
      decision: "auto",
      confidence: 1,
      fallbackUsed: false,
      ruleId: input.forceCouncil
        ? "council_triage.force_override"
        : "council_triage.explicit_keyword",
      signalSource: input.forceCouncil ? "structured" : "heuristic",
    });
    return {
      score: 1.0,
      recommendation: "auto",
      reasons: ["사용자가 다자간 위원회 소집을 명시적으로 요청했습니다."],
      telemetry,
    };
  }

  if (prompt.length < 18 || SHORT_FOLLOWUP_PATTERN.test(prompt)) {
    const telemetry = createAndRecordClassifierTelemetry({
      classifier: "council_triage",
      decision: "skip",
      confidence: 0.95,
      fallbackUsed: prompt.length === 0,
      ruleId:
        prompt.length === 0 ? "council_triage.empty_skip" : "council_triage.short_followup_skip",
      signalSource: prompt.length === 0 ? "fallback" : "heuristic",
    });
    return {
      score: 0.0,
      recommendation: "skip",
      reasons: ["단순 후속 지시 또는 짧은 질의로 일반 채팅이 적합합니다."],
      telemetry,
    };
  }

  let score = 0.0;
  const reasons: string[] = [];

  const matchedLayers = LAYER_PATTERNS.filter((entry) => entry.rx.test(prompt)).map(
    (entry) => entry.name,
  );
  if (matchedLayers.length >= 2) {
    score += 0.3;
    reasons.push(`다중 계층 변경 감지 (${matchedLayers.join(" · ")})`);
  }

  const matchedDomains = HIGH_RISK_DOMAIN_PATTERNS.filter((entry) => entry.rx.test(prompt)).map(
    (entry) => entry.label,
  );
  if (matchedDomains.length > 0) {
    score += matchedDomains.length >= 2 ? 0.4 : 0.3;
    reasons.push(`고위험 도메인 포함 (${matchedDomains.slice(0, 3).join(", ")})`);
  }

  if (BROAD_SCOPE_PATTERN.test(prompt)) {
    score += 0.25;
    reasons.push("광범위 수정 또는 다단계 파이프라인 작업");
  }

  const bulletCount = (prompt.match(/(?:^|\n)\s*(?:[-*•]|\d+[.)])\s+/gu) ?? []).length;
  if (prompt.length >= 450 || bulletCount >= 3) {
    score += 0.15;
    reasons.push(`복합 요구사항 (${prompt.length}자, 항목 ${bulletCount}건)`);
  }

  const clamped = Number(Math.max(0, Math.min(1, score)).toFixed(2));
  const recommendation: CouncilTriageEvaluation["recommendation"] =
    clamped >= 0.85 ? "auto" : clamped >= 0.55 ? "suggest" : "skip";
  const isFallback = reasons.length === 0;
  const telemetry = createAndRecordClassifierTelemetry({
    classifier: "council_triage",
    decision: recommendation,
    confidence: isFallback ? 0.6 : Math.min(0.95, 0.65 + clamped * 0.3),
    fallbackUsed: isFallback,
    ruleId: isFallback
      ? "council_triage.below_threshold_default"
      : `council_triage.scored_${recommendation}`,
    signalSource: isFallback ? "fallback" : "heuristic",
  });

  return {
    score: clamped,
    recommendation,
    reasons:
      reasons.length > 0
        ? reasons
        : ["복잡도 임계치 미만으로 단일 모델 일반 채팅 턴이 비용 효율적입니다."],
    telemetry,
  };
}
