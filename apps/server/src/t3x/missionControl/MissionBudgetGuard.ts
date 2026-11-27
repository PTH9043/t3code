// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import type { MissionCircuitBreakerState, MissionModelTier } from "@t3tools/contracts";

/**
 * 4계층 토큰·비용·루프 서킷 브레이커 및 캐시 히트율 계산기.
 *
 * 계층 1 (단일 턴):  입력 > 12,000T → 자동 압축(THROTTLED)
 * 계층 2 (태스크):   턴 > 12 | 홉 > 4 | 재작업 > 2 | 경과 > 8분 | 동일 에러 해시 2회 → TRIPPED_TO_INBOX
 * 계층 3 (미션):     토큰 > 80,000T | 비용 > $1.50(또는 지정 상한) | 경과 > 45분 → TRIPPED_TO_INBOX
 * 계층 4 (일일):     일일 비용 > $10.00 | 429 오류 >= 5회 → 신규 실행 차단 + 경보
 */

export const MISSION_GUARDRAIL_LIMITS = {
  maxTurnInputTokens: 12_000,
  maxTaskTurns: 12,
  maxTaskHops: 4,
  maxReworkCycles: 2,
  maxTaskDurationMs: 8 * 60_000,
  maxRepeatSameErrorHash: 2,
  maxMissionTokens: 80_000,
  defaultMissionBudgetUsd: 1.5,
  maxMissionDurationMs: 45 * 60_000,
  defaultDailyBudgetUsd: 10.0,
  maxDailyRateLimitErrors: 5,
  foremanLoopSimilarityThreshold: 0.85,
} as const;

export interface TokenCostInput {
  readonly modelTier: MissionModelTier;
  readonly promptTokens: number;
  readonly cachedTokens: number;
  readonly completionTokens: number;
}

/**
 * 모델 티어별 보수적 추정 단가 (USD per 1M tokens).
 * 프롬프트 캐시 히트 토큰은 90% 할인(0.1x)을 반영한다.
 */
const TIER_RATES_PER_MILLION: Record<
  MissionModelTier,
  { readonly input: number; readonly cachedInput: number; readonly output: number }
> = {
  TIER_S: { input: 3.0, cachedInput: 0.3, output: 15.0 },
  TIER_A: { input: 1.5, cachedInput: 0.15, output: 6.0 },
  TIER_B: { input: 0.25, cachedInput: 0.025, output: 1.0 },
};

export function estimateMissionStepCostUsd(input: TokenCostInput): number {
  const rates = TIER_RATES_PER_MILLION[input.modelTier];
  const cached = Math.max(0, Math.min(input.cachedTokens, input.promptTokens));
  const uncached = Math.max(0, input.promptTokens - cached);
  const completion = Math.max(0, input.completionTokens);
  const cost =
    (uncached * rates.input + cached * rates.cachedInput + completion * rates.output) / 1_000_000;
  return Math.round(cost * 10_000) / 10_000;
}

export function computeErrorFingerprint(rawError: string): string {
  const normalized = rawError
    .replace(/\b\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\b/g, "<ts>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<uuid>")
    .replace(/\bline\s+\d+\b/gi, "line <n>")
    .replace(/:\d+:\d+/g, ":<l>:<c>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 600);
  return NodeCrypto.createHash("sha256").update(normalized, "utf8").digest("hex");
}

export function computeCacheHitRatePercent(
  totalInputTokens: number,
  totalCachedTokens: number,
): number {
  if (totalInputTokens <= 0) return 0;
  const clampedCached = Math.max(0, Math.min(totalCachedTokens, totalInputTokens));
  return Math.round((clampedCached / totalInputTokens) * 1000) / 10;
}

export interface MissionGuardEvaluationInput {
  readonly turnInputTokens: number;
  readonly turnCount: number;
  readonly hopCount: number;
  readonly reworkCount: number;
  readonly taskElapsedMs: number;
  readonly missionElapsedMs: number;
  readonly missionTotalTokens: number;
  readonly missionTotalCostUsd: number;
  readonly missionBudgetLimitUsd: number;
  readonly dailySpentUsd: number;
  readonly dailyLimitUsd: number;
  readonly dailyRateLimitErrors: number;
  readonly repeatErrorCount: number;
  readonly killSwitchActive: boolean;
}

export type MissionGuardTrigger =
  | "KILL_SWITCH"
  | "DAILY_BUDGET"
  | "RATE_LIMIT_STORM"
  | "MISSION_BUDGET"
  | "MISSION_TOKENS"
  | "MISSION_TIMEOUT"
  | "HOP_LIMIT"
  | "REWORK_LIMIT"
  | "TURN_LIMIT"
  | "TASK_TIMEOUT"
  | "REPEAT_ERROR_HASH"
  | "TURN_TOKEN_THROTTLE"
  | null;

export interface MissionGuardEvaluationResult {
  readonly state: MissionCircuitBreakerState;
  readonly trigger: MissionGuardTrigger;
  readonly reason: string | null;
  readonly shouldCompactPrompt: boolean;
  readonly shouldTripToInbox: boolean;
}

export function evaluateMissionCircuitBreaker(
  input: MissionGuardEvaluationInput,
): MissionGuardEvaluationResult {
  if (input.killSwitchActive) {
    return {
      state: "TRIPPED_TO_INBOX",
      trigger: "KILL_SWITCH",
      reason: "전역 긴급 중지(Kill Switch)가 활성화되어 자율 실행이 중단되었습니다.",
      shouldCompactPrompt: false,
      shouldTripToInbox: true,
    };
  }
  if (input.dailySpentUsd >= input.dailyLimitUsd) {
    return {
      state: "TRIPPED_TO_INBOX",
      trigger: "DAILY_BUDGET",
      reason: `일일 비용 상한($${input.dailyLimitUsd.toFixed(2)})에 도달했습니다 (현재 $${input.dailySpentUsd.toFixed(2)}).`,
      shouldCompactPrompt: false,
      shouldTripToInbox: true,
    };
  }
  if (input.dailyRateLimitErrors >= MISSION_GUARDRAIL_LIMITS.maxDailyRateLimitErrors) {
    return {
      state: "TRIPPED_TO_INBOX",
      trigger: "RATE_LIMIT_STORM",
      reason: `금일 429 레이트리밋 오류가 ${input.dailyRateLimitErrors}회 누적되어 실행을 일시 중단했습니다.`,
      shouldCompactPrompt: false,
      shouldTripToInbox: true,
    };
  }
  if (input.repeatErrorCount >= MISSION_GUARDRAIL_LIMITS.maxRepeatSameErrorHash) {
    return {
      state: "TRIPPED_TO_INBOX",
      trigger: "REPEAT_ERROR_HASH",
      reason: `동일한 오류 패턴이 ${input.repeatErrorCount}회 연속 반복되어 자동 루프 차단 후 결재함으로 상신했습니다.`,
      shouldCompactPrompt: false,
      shouldTripToInbox: true,
    };
  }
  if (input.hopCount > MISSION_GUARDRAIL_LIMITS.maxTaskHops) {
    return {
      state: "TRIPPED_TO_INBOX",
      trigger: "HOP_LIMIT",
      reason: `에이전트 교신 홉 상한(${MISSION_GUARDRAIL_LIMITS.maxTaskHops}회)을 초과했습니다.`,
      shouldCompactPrompt: false,
      shouldTripToInbox: true,
    };
  }
  if (input.reworkCount > MISSION_GUARDRAIL_LIMITS.maxReworkCycles) {
    return {
      state: "TRIPPED_TO_INBOX",
      trigger: "REWORK_LIMIT",
      reason: `리뷰 반려 재작업 상한(${MISSION_GUARDRAIL_LIMITS.maxReworkCycles}회)을 초과했습니다.`,
      shouldCompactPrompt: false,
      shouldTripToInbox: true,
    };
  }
  if (input.turnCount > MISSION_GUARDRAIL_LIMITS.maxTaskTurns) {
    return {
      state: "TRIPPED_TO_INBOX",
      trigger: "TURN_LIMIT",
      reason: `태스크 최대 턴(${MISSION_GUARDRAIL_LIMITS.maxTaskTurns}턴)을 초과했습니다.`,
      shouldCompactPrompt: false,
      shouldTripToInbox: true,
    };
  }
  if (input.taskElapsedMs > MISSION_GUARDRAIL_LIMITS.maxTaskDurationMs) {
    return {
      state: "TRIPPED_TO_INBOX",
      trigger: "TASK_TIMEOUT",
      reason: `단일 태스크 실행 시간 상한(8분)을 초과했습니다.`,
      shouldCompactPrompt: false,
      shouldTripToInbox: true,
    };
  }
  if (input.missionTotalCostUsd >= input.missionBudgetLimitUsd) {
    return {
      state: "TRIPPED_TO_INBOX",
      trigger: "MISSION_BUDGET",
      reason: `미션 비용 상한($${input.missionBudgetLimitUsd.toFixed(2)})에 도달했습니다 (누적 $${input.missionTotalCostUsd.toFixed(2)}).`,
      shouldCompactPrompt: false,
      shouldTripToInbox: true,
    };
  }
  if (input.missionTotalTokens >= MISSION_GUARDRAIL_LIMITS.maxMissionTokens) {
    return {
      state: "TRIPPED_TO_INBOX",
      trigger: "MISSION_TOKENS",
      reason: `미션 토큰 상한(${MISSION_GUARDRAIL_LIMITS.maxMissionTokens.toLocaleString()}T)에 도달했습니다.`,
      shouldCompactPrompt: false,
      shouldTripToInbox: true,
    };
  }
  if (input.missionElapsedMs > MISSION_GUARDRAIL_LIMITS.maxMissionDurationMs) {
    return {
      state: "TRIPPED_TO_INBOX",
      trigger: "MISSION_TIMEOUT",
      reason: `미션 전체 실행 시간 상한(45분)을 초과했습니다.`,
      shouldCompactPrompt: false,
      shouldTripToInbox: true,
    };
  }
  if (input.turnInputTokens > MISSION_GUARDRAIL_LIMITS.maxTurnInputTokens) {
    return {
      state: "THROTTLED",
      trigger: "TURN_TOKEN_THROTTLE",
      reason: `단일 턴 입력 토큰(${input.turnInputTokens.toLocaleString()}T)이 12,000T를 초과하여 자동 압축 모드로 전환했습니다.`,
      shouldCompactPrompt: true,
      shouldTripToInbox: false,
    };
  }
  return {
    state: "OK",
    trigger: null,
    reason: null,
    shouldCompactPrompt: false,
    shouldTripToInbox: false,
  };
}
