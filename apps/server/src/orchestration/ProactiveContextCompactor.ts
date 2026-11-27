import { buildStructuredWorkingCompaction } from "./BackgroundAutoCompactor.ts";
import { estimateMixedTokens } from "../provider/ClaudePromptTelemetry.ts";

/**
 * Wave 3-B2: Proactive context compaction & clean turn-boundary handoff helper.
 *
 * Guarantees:
 * - Only triggers at a completed turn boundary (`turnStatus === "completed"`), never mid-turn.
 * - Evaluates threshold against actual `inputTokens` (never a clamped `usedTokens`).
 * - Respects global enable flag, configurable threshold (default 250,000), and per-thread OFF toggle.
 * - Produces a single-line Korean timeline record `"문맥 압축됨 (N → M 토큰)"` with zero popups/focus theft.
 */

export const DEFAULT_PROACTIVE_COMPACT_THRESHOLD_TOKENS = 250_000;

export interface ProactiveCompactionEvalInput {
  readonly turnId: string;
  readonly turnStatus: string;
  readonly actualInputTokens: number | undefined;
  readonly enabled: boolean;
  readonly threadDisabled: boolean;
  readonly thresholdTokens: number;
  readonly lastCompactedTurnId?: string | undefined;
}

export interface ProactiveCompactionDecision {
  readonly shouldCompact: boolean;
  readonly reason:
    | "trigger"
    | "disabled_globally"
    | "disabled_for_thread"
    | "not_turn_completed"
    | "below_threshold"
    | "missing_tokens"
    | "already_compacted_turn";
  readonly actualInputTokens: number;
  readonly thresholdTokens: number;
}

export function evaluateProactiveCompactionDecision(
  input: ProactiveCompactionEvalInput,
): ProactiveCompactionDecision {
  const threshold =
    Number.isFinite(input.thresholdTokens) && input.thresholdTokens > 0
      ? Math.round(input.thresholdTokens)
      : DEFAULT_PROACTIVE_COMPACT_THRESHOLD_TOKENS;
  const actual =
    typeof input.actualInputTokens === "number" &&
    Number.isFinite(input.actualInputTokens) &&
    input.actualInputTokens > 0
      ? Math.round(input.actualInputTokens)
      : 0;

  if (!input.enabled) {
    return {
      shouldCompact: false,
      reason: "disabled_globally",
      actualInputTokens: actual,
      thresholdTokens: threshold,
    };
  }
  if (input.threadDisabled) {
    return {
      shouldCompact: false,
      reason: "disabled_for_thread",
      actualInputTokens: actual,
      thresholdTokens: threshold,
    };
  }
  if (input.turnStatus !== "completed") {
    return {
      shouldCompact: false,
      reason: "not_turn_completed",
      actualInputTokens: actual,
      thresholdTokens: threshold,
    };
  }
  if (actual <= 0) {
    return {
      shouldCompact: false,
      reason: "missing_tokens",
      actualInputTokens: actual,
      thresholdTokens: threshold,
    };
  }
  if (input.lastCompactedTurnId && input.lastCompactedTurnId === input.turnId) {
    return {
      shouldCompact: false,
      reason: "already_compacted_turn",
      actualInputTokens: actual,
      thresholdTokens: threshold,
    };
  }
  if (actual < threshold) {
    return {
      shouldCompact: false,
      reason: "below_threshold",
      actualInputTokens: actual,
      thresholdTokens: threshold,
    };
  }
  return {
    shouldCompact: true,
    reason: "trigger",
    actualInputTokens: actual,
    thresholdTokens: threshold,
  };
}

export function formatCompactionSummaryLine(
  preTokens: number | undefined,
  postTokens: number | undefined,
): string {
  const pre =
    typeof preTokens === "number" && Number.isFinite(preTokens) && preTokens > 0
      ? Math.round(preTokens)
      : undefined;
  const post =
    typeof postTokens === "number" && Number.isFinite(postTokens) && postTokens > 0
      ? Math.round(postTokens)
      : undefined;
  if (pre !== undefined && post !== undefined) {
    return `문맥 압축됨 (${pre.toLocaleString("en-US")} → ${post.toLocaleString("en-US")} 토큰)`;
  }
  if (post !== undefined) {
    return `문맥 압축됨 (현재 ${post.toLocaleString("en-US")} 토큰)`;
  }
  return "문맥 압축됨";
}

export function extractCompactBoundaryTokens(detail: unknown): {
  readonly preTokens?: number | undefined;
  readonly postTokens?: number | undefined;
} {
  if (!detail || typeof detail !== "object") return {};
  const rec = detail as Record<string, unknown>;
  const meta =
    rec.compact_metadata && typeof rec.compact_metadata === "object"
      ? (rec.compact_metadata as Record<string, unknown>)
      : rec;
  const pre =
    typeof meta.pre_tokens === "number" && Number.isFinite(meta.pre_tokens) && meta.pre_tokens > 0
      ? Math.round(meta.pre_tokens)
      : typeof meta.preTokens === "number" && Number.isFinite(meta.preTokens) && meta.preTokens > 0
        ? Math.round(meta.preTokens)
        : undefined;
  const post =
    typeof meta.post_tokens === "number" &&
    Number.isFinite(meta.post_tokens) &&
    meta.post_tokens > 0
      ? Math.round(meta.post_tokens)
      : typeof meta.postTokens === "number" &&
          Number.isFinite(meta.postTokens) &&
          meta.postTokens > 0
        ? Math.round(meta.postTokens)
        : undefined;
  return { preTokens: pre, postTokens: post };
}

/**
 * Resolves Claude Agent SDK 0.3.251 official `autoCompactEnabled` and `autoCompactWindow`
 * settings for a session based on global + per-thread settings.
 */
export function resolveClaudeAutoCompactSdkSettings(input: {
  readonly proactiveCompactEnabled?: boolean | undefined;
  readonly proactiveCompactThresholdTokens?: number | undefined;
  readonly threadDisabled?: boolean | undefined;
}): {
  readonly autoCompactEnabled?: boolean;
  readonly autoCompactWindow?: number;
} {
  const enabled = input.proactiveCompactEnabled !== false && input.threadDisabled !== true;
  if (!enabled) {
    return { autoCompactEnabled: false };
  }
  const threshold =
    typeof input.proactiveCompactThresholdTokens === "number" &&
    Number.isFinite(input.proactiveCompactThresholdTokens) &&
    input.proactiveCompactThresholdTokens >= 50_000
      ? Math.round(input.proactiveCompactThresholdTokens)
      : DEFAULT_PROACTIVE_COMPACT_THRESHOLD_TOKENS;
  return {
    autoCompactEnabled: true,
    autoCompactWindow: threshold,
  };
}

export interface CompactionMemoryCheckpoint {
  readonly summaryText: string;
  readonly estimatedPostTokens: number;
  readonly coveredTurnCount: number;
  readonly memoryNote: string;
}

/**
 * Prepares the pre-compaction memory checkpoint summarizing key decisions,
 * constraints/rejections, open tasks, and recent turn flow so nothing important
 * is lost across compaction or session handoff.
 */
export function prepareCompactionMemoryCheckpoint(input: {
  readonly threadId: string;
  readonly turns: ReadonlyArray<{ readonly role: string; readonly text: string }>;
  readonly actualInputTokens: number;
}): CompactionMemoryCheckpoint {
  const summaryText = buildStructuredWorkingCompaction(input.turns);
  const summaryEst = estimateMixedTokens(summaryText).estTokens;
  // Estimate post-compaction footprint: compact summary + typical baseline overhead (~35k) capped below preTokens
  const estimatedPostTokens = Math.min(
    Math.max(summaryEst + 12_000, summaryEst),
    Math.max(1, Math.round(input.actualInputTokens * 0.45)),
  );
  const memoryNote = `[문맥 사전 압축 체크포인트 thread=${input.threadId} pre=${input.actualInputTokens}tok]\n${summaryText}`;
  return {
    summaryText,
    estimatedPostTokens,
    coveredTurnCount: input.turns.length,
    memoryNote,
  };
}
