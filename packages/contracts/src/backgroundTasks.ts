import * as Schema from "effect/Schema";
import { createAndRecordClassifierTelemetry } from "./classifierTelemetry.ts";
import { NonNegativeInt } from "./baseSchemas.ts";

export const UnifiedBgTaskState = Schema.Literals([
  "RUNNING",
  "STALLED",
  "UNVERIFIED",
  "COMPLETED",
  "FAILED",
]);
export type UnifiedBgTaskState = typeof UnifiedBgTaskState.Type;

export const UnifiedBgExecType = Schema.Literals(["LOCAL_PID", "REMOTE_JOB"]);
export type UnifiedBgExecType = typeof UnifiedBgExecType.Type;

export const UnifiedBgTask = Schema.Struct({
  taskId: Schema.String,
  threadId: Schema.String,
  turnId: Schema.NullOr(Schema.String),
  provider: Schema.String,
  modelLabel: Schema.optionalKey(Schema.String),
  title: Schema.String,
  execType: UnifiedBgExecType,
  proofHandle: Schema.String,
  startedAtMs: Schema.Number,
  lastProgressAtMs: Schema.Number,
  logTail: Schema.optionalKey(Schema.String),
  artifactCount: Schema.optionalKey(NonNegativeInt),
  watcherArmed: Schema.Boolean,
  state: UnifiedBgTaskState,
});
export type UnifiedBgTask = typeof UnifiedBgTask.Type;

export const BG_TASK_STALLED_THRESHOLD_MS = 60_000;

const STATE_SEVERITY: Record<UnifiedBgTaskState, number> = {
  FAILED: 5,
  UNVERIFIED: 4,
  STALLED: 3,
  RUNNING: 2,
  COMPLETED: 1,
};

export function bgProviderShortCode(provider: string): string {
  const normalized = provider.trim().toLowerCase();
  if (normalized === "gemini" || normalized === "antigravity") return "G";
  if (normalized === "codex" || normalized === "openai") return "Cx";
  if (normalized === "claude" || normalized === "claudeagent" || normalized === "anthropic")
    return "Cl";
  if (normalized === "opencode") return "Oc";
  if (normalized === "cursor") return "Cu";
  if (normalized === "grok") return "Gk";
  if (normalized === "muse") return "Mu";
  return normalized.slice(0, 2).toUpperCase() || "BG";
}

export function bgProviderDisplayName(provider: string): string {
  const normalized = provider.trim().toLowerCase();
  if (normalized === "gemini" || normalized === "antigravity") return "Antigravity";
  if (normalized === "codex" || normalized === "openai") return "Codex";
  if (normalized === "claude" || normalized === "claudeagent" || normalized === "anthropic")
    return "Claude";
  if (normalized === "opencode") return "OpenCode";
  if (normalized === "cursor") return "Cursor";
  if (normalized === "grok") return "Grok";
  if (normalized === "muse") return "Muse";
  return provider;
}

export interface UnifiedBgTaskRollup {
  readonly totalActive: number;
  readonly stalledCount: number;
  readonly failedCount: number;
  readonly worstState: UnifiedBgTaskState | null;
  readonly byProvider: ReadonlyArray<{
    readonly provider: string;
    readonly shortCode: string;
    readonly label: string;
    readonly count: number;
  }>;
}

export function rollupBackgroundTasks(tasks: readonly UnifiedBgTask[]): UnifiedBgTaskRollup {
  const active = tasks.filter((t) => t.state !== "COMPLETED");
  const counts = new Map<string, number>();
  let worstState: UnifiedBgTaskState | null = null;
  let stalledCount = 0;
  let failedCount = 0;

  for (const task of active) {
    const label = bgProviderDisplayName(task.provider);
    counts.set(label, (counts.get(label) ?? 0) + 1);
    if (task.state === "STALLED") stalledCount += 1;
    if (task.state === "FAILED") failedCount += 1;
    if (!worstState || STATE_SEVERITY[task.state] > STATE_SEVERITY[worstState]) {
      worstState = task.state;
    }
  }

  const byProvider = [...counts.entries()].map(([label, count]) => ({
    provider: label.toLowerCase(),
    shortCode: bgProviderShortCode(label),
    label,
    count,
  }));

  return {
    totalActive: active.length,
    stalledCount,
    failedCount,
    worstState,
    byProvider,
  };
}

const FENCED_CODE_BLOCK_RE = /(?:```|~~~)[\s\S]*?(?:```|~~~|$)/gu;
const DETAILS_BLOCK_RE = /<details\b[\s\S]*?<\/details>/giu;
const BLOCKQUOTE_LINE_RE = /^\s*>.*$/gmu;
const INLINE_CODE_RE = /`[^`\n]*`/gu;

const ACTIVE_BG_PROGRESS_RE =
  /(?:백그라운드(?:에서|로)?\s*(?:[^\n.!?]{0,28}?)(?:실행|진행|촬영|계산|수집|검증|분석|처리|돌아가|돌고|돌리고)\s*(?:중|하고\s*있|되고\s*있|을?\s*시작)|백그라운드\s*(?:전수\s*)?(?:촬영|실행|계산|수집|검증|분석|작업)(?:이|가)?\s*(?:약\s*\d|끝나|완료|종료|진행\s*중)|(?:하는|묶는|촬영|진행|처리|실행|계산|분석|수집)\s*중(?:이에요|입니다|임)|(?:전수\s*(?:계산|촬영|검증|분석|수집|실행)|백그라운드\s*(?:작업|실행|검증|계산|촬영)|빌드|테스트|스모크\s*검증|다운로드)(?:이|가)?\s*(?:끝날|완료될|마무리될)\s*때까지|추가\s*조작\s*없이\s*대기|잠시\s*대기해\s*주시면|자동\s*알림(?:을|이)?\s*(?:받아|도착|오는))/u;

const DEFERRED_BG_PROMISE_RE =
  /(?:(?:끝나는|완료되는|마무리되는)\s*(?:대로|즉시)|(?:완료|종료)\s*(?:알림|신호)(?:이|가)?\s*(?:도착|오는|오면)|(?:추가\s*조작\s*없이\s*)?(?:대기해|기다려)\s*주시면|자동\s*알림(?:을)?\s*받아\s*(?:[^\n.!?]{0,28}?)(?:보고|알려|정리|올려|전달|공유)|약\s*\d+(?:\s*[~-]\s*\d+)?\s*(?:초|분)\s*(?:안팎|안|내|뒤|후)(?:으로|에)?\s*(?:[^\n.!?]{0,30}?)(?:끝나|완료|마무리|알림|보고|올려|정리)|(?:최종|완료)\s*보고(?:를)?\s*(?:올려|드리겠|드릴게|할게)|(?:끝나면|완료되면|마무리되면)\s*(?:[^\n.!?]{0,36}?)(?:올려|보고|알려|정리|요약|전달|공유|확정)(?:해)?\s*(?:드릴게|드리겠|할게|드려요))/u;

const NEGATED_BG_SENTENCE_RE =
  /(?:백그라운드|남은\s*(?:도구\s*)?작업|실행\s*중인\s*작업)[^\n.!?]{0,32}(?:없습니다|없어요|없음|없고|없이|아니에요|아닙니다)|(?:실행|진행|촬영|계산|수집|검증|분석|처리|돌아가|돌고|돌리고)\s*중(?:인|이)?[^\n.!?]{0,20}(?:없습니다|없어요|없음|아니에요|아닙니다)|(?:없습니다|없어요|없음)\s*\(?\[?확인\s*완료/u;

const USER_INPUT_CONDITION_RE =
  /(?:답변|말씀|알려|지시|선택|입력|한\s*마디|확인|결정|승인)(?:해|만)?\s*주시면/u;

const EXPLICIT_DEFERRED_COMPLETION_RE =
  /(?:끝나는|완료되는|마무리되는)\s*(?:대로|즉시)|(?:완료|종료)\s*(?:알림|신호)|추가\s*조작\s*없이\s*대기|자동\s*알림/u;

const MAX_CLAIM_WINDOW_CHARS = 320;

function stripNonClaimMarkdown(text: string): string {
  return text
    .replace(FENCED_CODE_BLOCK_RE, " ")
    .replace(DETAILS_BLOCK_RE, " ")
    .replace(BLOCKQUOTE_LINE_RE, " ")
    .replace(INLINE_CODE_RE, " ");
}

function splitClaimSentences(text: string): string[] {
  return text
    .split(/(?:\r?\n)+|(?<=[.!?])\s+/u)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

/**
 * Deterministic check for assistant replies that promise an ongoing background
 * run or future auto-report ("약 1분 뒤 자동 알림을 받아 보고드릴게요", "묶는 중이에요").
 * Evaluates only prose sentences (excluding code fences, `<details>`, quotes)
 * within the same or immediately adjacent sentence window, while rejecting
 * explicit negations ("백그라운드 작업은 없습니다") and user-input conditionals
 * ("답변해 주시면 정리해 드릴게요").
 */
export function detectDeferredBackgroundClaim(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) {
    createAndRecordClassifierTelemetry({
      classifier: "deferred_background_claim",
      decision: "none",
      confidence: 1,
      fallbackUsed: false,
      ruleId: "bg_claim.empty",
      signalSource: "structured",
    });
    return false;
  }

  const sentences = splitClaimSentences(stripNonClaimMarkdown(trimmed));
  if (sentences.length === 0) {
    createAndRecordClassifierTelemetry({
      classifier: "deferred_background_claim",
      decision: "none",
      confidence: 1,
      fallbackUsed: false,
      ruleId: "bg_claim.non_prose_only",
      signalSource: "structured",
    });
    return false;
  }

  let exemptReason: "negated_exempt" | "user_input_conditional_exempt" | null = null;

  for (let i = 0; i < sentences.length; i += 1) {
    const current = sentences[i]!;
    if (current.startsWith("#")) continue;

    const windows: string[] = [current];
    let nextIdx = i + 1;
    while (nextIdx < sentences.length && sentences[nextIdx]!.startsWith("#")) {
      nextIdx += 1;
    }
    if (nextIdx < sentences.length) {
      const pair = `${current} ${sentences[nextIdx]!}`;
      if (pair.length <= MAX_CLAIM_WINDOW_CHARS) {
        windows.push(pair);
      }
    }

    for (const window of windows) {
      if (!ACTIVE_BG_PROGRESS_RE.test(window)) continue;
      if (!DEFERRED_BG_PROMISE_RE.test(window)) continue;
      if (NEGATED_BG_SENTENCE_RE.test(window)) {
        exemptReason = "negated_exempt";
        continue;
      }
      if (USER_INPUT_CONDITION_RE.test(window) && !EXPLICIT_DEFERRED_COMPLETION_RE.test(window)) {
        exemptReason = "user_input_conditional_exempt";
        continue;
      }
      createAndRecordClassifierTelemetry({
        classifier: "deferred_background_claim",
        decision: "deferred_claim",
        confidence: 0.88,
        fallbackUsed: false,
        ruleId: "bg_claim.active_progress_and_promise",
        signalSource: "heuristic",
      });
      return true;
    }
  }

  createAndRecordClassifierTelemetry({
    classifier: "deferred_background_claim",
    decision: exemptReason ?? "none",
    confidence: exemptReason ? 0.92 : 0.95,
    fallbackUsed: false,
    ruleId: exemptReason ? `bg_claim.${exemptReason}` : "bg_claim.no_match",
    signalSource: "heuristic",
  });
  return false;
}

export const UNVERIFIED_BG_RETRY_PROMPT =
  "방금 답변에서 백그라운드 실행 또는 완료 후 자동 보고를 안내했지만, 시스템 확인 결과 실제 등록·실행 중인 백그라운드 작업(PID/Job)이 0건입니다. 중간 예고나 시간 예측을 적지 말고 지금 즉시 실제 도구를 호출해 작업을 끝내고 확인된 결과만 보고해 주세요.";
