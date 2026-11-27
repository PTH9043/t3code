/**
 * Zero-Latency (<1ms) Local Multi-Dimensional Smart Model Router
 * (distilled from ClawRouter's local complexity classifier, with zero external
 * gateway or payment dependencies):
 * Scores prompt characteristics locally and maps them onto the user's own
 * T3 provider pool (`zero_cost_local` | `fast_cheap` | `balanced` | `deep_reasoning`).
 */

import {
  createAndRecordClassifierTelemetry,
  type ClassifierTelemetry,
} from "./classifierTelemetry.ts";

export type SmartModelTier = "zero_cost_local" | "fast_cheap" | "balanced" | "deep_reasoning";

export interface SmartRouteDecision {
  readonly tier: SmartModelTier;
  readonly complexityScore: number;
  readonly reasons: ReadonlyArray<string>;
  readonly telemetry?: ClassifierTelemetry<SmartModelTier>;
}

const DEEP_REASONING_PATTERN =
  /아키텍처|설계|동시성|데드락|보안\s*감사|취약점|근본\s*원인|리팩터링|마이그레이션|백테스트|수학적|증명|architecture|concurrency|security\s+audit|root\s+cause|refactor|migration|distributed/i;

const ZERO_COST_PATTERN =
  /번역|요약|다듬어|맞춤법|json\s*정규화|포맷|한\s*줄|영어로|한국어로|translate|summarize|format\s+json|proofread|rephrase/i;

const CODE_OR_DEBUG_PATTERN =
  /```|오류|에러|버그|테스트|수정|구현|타입|스택|traceback|exception|stack\s*trace|vitest|pytest|tsgo|sql/i;

const MULTI_FILE_PATTERN =
  /전체|여러\s*파일|모노레포|백엔드.*프론트|웹.*서버|across\s+files|end-to-end|e2e|wave\s*\d/i;

export function classifySmartModelRoute(input: {
  readonly prompt: string;
  readonly attachmentCount?: number;
  readonly requiresTools?: boolean;
}): SmartRouteDecision {
  const text = input.prompt.trim();
  const len = text.length;
  const reasons: string[] = [];
  let score = 0;

  if (len > 2500) {
    score += 30;
    reasons.push("long_prompt");
  } else if (len > 800) {
    score += 15;
    reasons.push("medium_prompt");
  } else if (len < 180) {
    score -= 10;
    reasons.push("short_prompt");
  }

  if ((input.attachmentCount ?? 0) > 0) {
    score += 15;
    reasons.push("has_attachments");
  }
  if (input.requiresTools) {
    score += 20;
    reasons.push("requires_tools");
  }
  if (DEEP_REASONING_PATTERN.test(text)) {
    score += 40;
    reasons.push("deep_reasoning_domain");
  }
  if (MULTI_FILE_PATTERN.test(text)) {
    score += 25;
    reasons.push("multi_file_scope");
  }
  if (CODE_OR_DEBUG_PATTERN.test(text)) {
    score += 20;
    reasons.push("code_or_debug");
  }
  if (ZERO_COST_PATTERN.test(text) && !DEEP_REASONING_PATTERN.test(text) && !input.requiresTools) {
    score -= 30;
    reasons.push("lightweight_transform");
  }

  const clamped = Math.max(0, Math.min(100, score + 30));
  const tier: SmartModelTier =
    clamped >= 75
      ? "deep_reasoning"
      : clamped >= 48
        ? "balanced"
        : clamped >= 25
          ? "fast_cheap"
          : "zero_cost_local";
  const isFallback = text.length === 0 || reasons.length === 0;
  const telemetry = createAndRecordClassifierTelemetry({
    classifier: "smart_model_router",
    decision: tier,
    confidence: isFallback ? 0.5 : Math.min(0.95, 0.65 + reasons.length * 0.08),
    fallbackUsed: isFallback,
    ruleId:
      text.length === 0
        ? "router.empty_default"
        : reasons.length === 0
          ? "router.baseline_default"
          : `router.${tier}`,
    signalSource: isFallback ? "fallback" : "heuristic",
  });

  return {
    tier,
    complexityScore: clamped,
    reasons,
    telemetry,
  };
}

export interface RoutableModelCandidate {
  readonly instanceId: string;
  readonly model: string;
  readonly isLocalZeroCost?: boolean;
}

const TIER_MODEL_PREFERENCES: Record<SmartModelTier, ReadonlyArray<RegExp>> = {
  zero_cost_local: [/qwen|granite|exaone|llama|ollama|local/i, /flash|haiku|mini/i],
  fast_cheap: [/flash|haiku|mini|luna|fast|nano/i, /sonnet|sol|gpt-4o/i],
  balanced: [/sonnet|sol|gpt-5\.4|gemini-.*pro|neon/i, /opus|astra/i],
  deep_reasoning: [/opus|astra|o3|neon|thinking|pro/i, /sonnet|sol/i],
};

/** Picks the best available model from the user's configured candidate pool for a routed tier. */
export function selectBestModelFromPool<T extends RoutableModelCandidate>(
  candidates: ReadonlyArray<T>,
  tier: SmartModelTier,
): T | undefined {
  if (candidates.length === 0) return undefined;
  if (tier === "zero_cost_local") {
    const local = candidates.find((c) => c.isLocalZeroCost);
    if (local) return local;
  }
  for (const pattern of TIER_MODEL_PREFERENCES[tier]) {
    const matched = candidates.find((c) => pattern.test(c.model) || pattern.test(c.instanceId));
    if (matched) return matched;
  }
  return candidates[0];
}
