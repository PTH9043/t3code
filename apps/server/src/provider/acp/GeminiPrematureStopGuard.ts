import {
  createAndRecordClassifierTelemetry as createClassifierTelemetry,
  type ClassifierTelemetry,
} from "@t3tools/shared/classifierTelemetry";
import {
  buildT3McpRecoveryPrompt,
  isFalseSecurityRefusalAfterT3ToolDrop,
} from "./GeminiMcpToolRecovery.ts";

export type PrematureStopReason =
  | "t3_mcp_tool_dropped"
  | "active_delegation"
  | "active_background_task"
  | "incomplete_plan"
  | "promise_pattern";

export interface PrematureStopGuardInput {
  readonly assistantText: string;
  readonly planStatuses: ReadonlyArray<string>;
  readonly hasPendingApproval: boolean;
  readonly isAborted: boolean;
  readonly retryCount: number;
  readonly maxRetries?: number;
  readonly previousSignatures: ReadonlyArray<string>;
  /** Number of live `workspace_delegate` runs owned by this thread (structured signal). */
  readonly activeDelegationCount?: number;
  /** Number of live provider background tasks owned by this thread (structured signal). */
  readonly activeBackgroundTaskCount?: number;
  /** Structured `t3-code` MCP tool names observed as dropped/not-enabled during this turn. */
  readonly unrecoveredT3ToolDrops?: ReadonlyArray<string>;
  /** True once this turn already executed an automatic `t3-code`-only session reconnect. */
  readonly alreadyAttemptedMcpRecovery?: boolean;
}

export interface PrematureStopGuardResult {
  readonly shouldContinue: boolean;
  readonly reason?: PrematureStopReason;
  readonly normalizedSignature: string;
  readonly activityLog?: string;
  readonly repairPrompt?: string;
  readonly telemetry: ClassifierTelemetry<PrematureStopReason | "allow_stop">;
}

const DEFAULT_MAX_RETRIES = 3;

// Stage 3: Exclusion patterns (questions, declarative confirmation requests, permission/env blocks).
// IMPORTANT (Edge #2): "잠시만 기다려 주세요" is intentionally NOT excluded here.
const QUESTION_MARK_PATTERN = /[?？]/u;

const KOREAN_CONFIRMATION_REQUEST_PATTERN =
  /(?:알려\s*주시면|알려\s*주세요|알려\s*주시기\s*바랍니다|확인해\s*주세요|확인해\s*주시기\s*바랍니다|확인\s*부탁(?:드립니다|합니다|해요)?|선택해\s*주세요|선택해\s*주시기\s*바랍니다|결정해\s*주세요|답변해\s*주세요|지정해\s*주세요|말씀해\s*주세요|의견을?\s*주시면|질문\s*카드에서\s*선택)/u;

const PERMISSION_OR_ENV_BLOCK_PATTERN =
  /(?:권한이\s*없|접근할\s*수\s*없|접근이\s*거부|차단되(?:어|었|고)|멈췄습니다|중단했습니다|진행할\s*수\s*없|실행할\s*수\s*없|사용할\s*수\s*없|권한\s*부족|승인이\s*필요|허가가\s*필요|로그인이\s*필요|API\s*Error:|안전장치가\s+이\s+요청을\s+(?:거절|차단))/iu;

// Stage 4: Signal A (progress predicate AND future completion promise) + wait auxiliary signal.
const PROGRESS_MARKER_PATTERN =
  /(?:진행\s*중(?:입니다|이에요|이오|이다|이며|이고)?|실행\s*중(?:입니다|이에요|이다|이며|이고)?|작업\s*중(?:입니다|이에요|이다|이며|이고)?|처리\s*중(?:입니다|이에요|이다|이며|이고)?|확인\s*중(?:입니다|이에요|이다|이며|이고)?|분석\s*중(?:입니다|이에요|이다|이며|이고)?|빌드\s*중(?:입니다|이에요|이다|이며|이고)?|테스트\s*중(?:입니다|이에요|이다|이며|이고)?|수집\s*중(?:입니다|이에요|이다|이며|이고)?|검토\s*중(?:입니다|이에요|이다|이며|이고)?|대기\s*중(?:입니다|이에요|이다|이며|이고)?|돌아가고\s*있|돌리고\s*있|수행하고\s*있|진행하고\s*있|기다리고\s*있|확인하고\s*있|처리하고\s*있|실행하고\s*있|백그라운드에서\s*(?:실행|진행|동작|돌아가)|in\s+progress|currently\s+running)/iu;

const FUTURE_PROMISE_PATTERN =
  /(?:(?:완료|끝나|마무리|준비|종료|결과가?\s*나오)(?:되면|하는\s*대로|되는\s*대로|되는\s*즉시|한?\s*후|뒤에?)|(?:잠시|조금|\d+\s*(?:초|분|ms|s|sec|min))\s*(?:후|뒤)에?|(?:이어서|계속해서|바로|곧|즉시|추후)\s*(?:보고|안내|알려|공유|진행|이어가|작성|전달|수정|확인)|(?:보고|안내|공유|전달|알려)\s*(?:드리겠|하겠습니다|드릴게|해\s*드리겠|올리겠|드리도록)|(?:진행|수행|처리|실행|확인|검증|완료)\s*(?:하겠습니다|하겠음|할\s*예정|할게요|해\s*보겠|드리겠)|will\s+(?:report|update|continue|check|follow\s+up))/iu;

const WAIT_AUXILIARY_SIGNAL_PATTERN =
  /(?:잠시(?:만)?\s*기다려\s*주(?:세요|십시오)|조금만\s*기다려\s*주(?:세요|십시오)|잠깐만?\s*기다려\s*주(?:세요|십시오)|please\s+wait)/iu;

const PROMISE_REPAIR_PROMPT =
  "진행 중이거나 추후 보고하겠다는 안내만으로 턴을 종료하지 마세요. 백그라운드 대기·남은 도구 호출·검증 작업이 있다면 지금 바로 이어서 끝까지 실행한 뒤 최종 결과를 보고해 주세요.";

const INCOMPLETE_PLAN_CONDITIONAL_REPAIR_PROMPT =
  "아직 완료되지 않은 계획 단계(pending/in_progress)가 남아 있습니다. 남은 작업이나 검증이 있다면 지금 바로 도구를 호출해 끝까지 완료하고 보고하세요. 이미 모든 작업·검증을 마쳤다면 플랜 상태만 완료(completed)로 갱신한 뒤 최종 보고해 주세요.";

const ACTIVE_DELEGATION_REPAIR_PROMPT =
  '이 대화에서 시작한 하위 모델 위임(`workspace_delegate`)이 아직 실행 중이거나 미수령 상태입니다. 안내 문구만으로 턴을 끝내지 말고 `workspace_delegate(action="wait" 또는 "join")`로 결과를 회수·검증한 뒤 최종 보고해 주세요.';

const ACTIVE_BACKGROUND_TASK_REPAIR_PROMPT =
  "아직 실행 중인 백그라운드 작업이 남아 있습니다. 작업 상태를 확인·회수한 뒤 검증된 최종 결과를 보고해 주세요.";

/**
 * Stage 2 helper: masks fenced code blocks, inline code spans, markdown blockquotes,
 * and quoted substrings so self-quoted logs/examples do not trigger false positives (Edge #6).
 */
export function stripCodeAndQuotesForStopGuard(text: string): string {
  // 1. Remove fenced code blocks (```...``` or ~~~...~~~), including unclosed trailing fences.
  let masked = text.replace(
    /(^|\r?\n)[ \t]*(`{3,}|~{3,})[^\r\n]*\r?\n[\s\S]*?(?:\r?\n[ \t]*\2[ \t]*(?=\r?\n|$)|$)/g,
    "$1",
  );

  // 2. Remove markdown blockquote lines (`> ...`).
  masked = masked.replace(/^[ \t]*>.*$/gm, "");

  // 3. Remove inline code spans (``...`` or `...`).
  masked = masked.replace(/(`+)[^`\r\n]*?\1/g, " ");

  // 4. Remove quoted substrings ("...", '...', “...”, ‘...’, 「...」, 『...』) on single lines.
  masked = masked
    .replace(/"[^"\r\n]*"/g, " ")
    .replace(/'[^'\r\n]*'/g, " ")
    .replace(/“[^”\r\n]*”/g, " ")
    .replace(/‘[^’\r\n]*’/g, " ")
    .replace(/「[^」\r\n]*」/g, " ")
    .replace(/『[^』\r\n]*』/g, " ");

  return masked;
}

/**
 * Extracts the trailing 1-2 non-empty paragraphs from preprocessed assistant text.
 */
export function extractTailParagraphs(preprocessedText: string, maxParagraphs = 2): string {
  const paragraphs = preprocessedText
    .split(/\r?\n[ \t]*\r?\n+/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);
  if (paragraphs.length === 0) {
    return "";
  }
  return paragraphs.slice(-maxParagraphs).join("\n\n");
}

/**
 * Stage 5 helper: strips digits, whitespace, and punctuation/symbols to detect
 * near-duplicate progress loops such as "10초 뒤 보고" -> "15초 뒤 보고" (Edge #3).
 */
export function normalizePrematureStopSignature(text: string): string {
  return text
    .toLowerCase()
    .replace(/\d+/g, "")
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}

function hasIncompletePlanStatus(planStatuses: ReadonlyArray<string>): boolean {
  return planStatuses.some((status) => {
    const normalized = status.trim().toLowerCase();
    return normalized === "pending" || normalized === "in_progress" || normalized === "inprogress";
  });
}

/**
 * Pure 5-stage premature-stop detector for Antigravity (Gemini ACP) turns.
 * Independent of ACP runtime classes so it can be tested and reused cleanly.
 */
export function evaluatePrematureStopGuard(
  input: PrematureStopGuardInput,
): PrematureStopGuardResult {
  const maxRetries = input.maxRetries ?? DEFAULT_MAX_RETRIES;

  // Stage 2 preprocessing is computed upfront so normalizedSignature is always populated.
  const preprocessed = stripCodeAndQuotesForStopGuard(input.assistantText);
  const tailText = extractTailParagraphs(preprocessed, 2);
  const normalizedSignature = normalizePrematureStopSignature(tailText);

  // Stage 1: Immediate exit guards.
  if (input.isAborted || input.hasPendingApproval || input.retryCount >= maxRetries) {
    return {
      shouldContinue: false,
      normalizedSignature,
      telemetry: createClassifierTelemetry({
        classifier: "gemini_premature_stop_guard",
        decision: "allow_stop",
        confidence: 1,
        fallbackUsed: false,
        ruleId: input.isAborted
          ? "guard.aborted"
          : input.hasPendingApproval
            ? "guard.pending_approval"
            : "guard.max_retries",
        signalSource: "structured",
      }),
    };
  }

  // Stage 2.5: Structured `t3-code` MCP drop + false security/permission refusal recovery.
  // Evaluated BEFORE Stage 3 text exclusions because the model's misdiagnosed refusal
  // ("권한 경계 · 차단", "T3 UI에서 직접 켜고 새 대화로 넘겨 주세요") would otherwise match
  // PERMISSION_OR_ENV_BLOCK_PATTERN / KOREAN_CONFIRMATION_REQUEST_PATTERN and exit early.
  // Genuine provider safety refusals (`isSafeguardBlock`, `isProviderContentRefusal`) are
  // explicitly rejected by `isFalseSecurityRefusalAfterT3ToolDrop`.
  const droppedT3Tools = input.unrecoveredT3ToolDrops ?? [];
  if (
    droppedT3Tools.length > 0 &&
    !input.alreadyAttemptedMcpRecovery &&
    isFalseSecurityRefusalAfterT3ToolDrop({
      assistantText: input.assistantText,
      droppedT3Tools,
    })
  ) {
    return {
      shouldContinue: true,
      reason: "t3_mcp_tool_dropped",
      normalizedSignature,
      activityLog: `t3-code MCP 도구(${Array.from(new Set(droppedT3Tools)).join(", ")}) 누락 감지 → 자동 재연결 후 이어 실행`,
      repairPrompt: buildT3McpRecoveryPrompt(droppedT3Tools),
      telemetry: createClassifierTelemetry({
        classifier: "gemini_premature_stop_guard",
        decision: "t3_mcp_tool_dropped",
        confidence: 0.99,
        fallbackUsed: false,
        ruleId: "guard.t3_mcp_tool_dropped_false_refusal",
        signalSource: "structured",
      }),
    };
  }

  // Stage 3: User-question, confirmation-request, or permission/environment-block exclusions.
  // Note (Edge #2): "잠시만 기다려 주세요" is NOT matched by these exclusions.
  if (
    QUESTION_MARK_PATTERN.test(tailText) ||
    KOREAN_CONFIRMATION_REQUEST_PATTERN.test(tailText) ||
    PERMISSION_OR_ENV_BLOCK_PATTERN.test(tailText)
  ) {
    return {
      shouldContinue: false,
      normalizedSignature,
      telemetry: createClassifierTelemetry({
        classifier: "gemini_premature_stop_guard",
        decision: "allow_stop",
        confidence: 0.9,
        fallbackUsed: false,
        ruleId: "guard.user_question_or_block",
        signalSource: "heuristic",
      }),
    };
  }

  // Stage 4: Premature-stop signals — structured runtime state takes priority over regex heuristics.
  const hasActiveDelegation = (input.activeDelegationCount ?? 0) > 0;
  const hasActiveBackgroundTask = (input.activeBackgroundTaskCount ?? 0) > 0;
  const signalB = hasIncompletePlanStatus(input.planStatuses);

  // Heuristic fallback Signal A: Progress predicate AND future completion promise.
  const hasProgress = PROGRESS_MARKER_PATTERN.test(tailText);
  const hasPromise = FUTURE_PROMISE_PATTERN.test(tailText);
  const hasWaitAuxiliary = WAIT_AUXILIARY_SIGNAL_PATTERN.test(tailText);
  const signalA = (hasProgress && hasPromise) || (hasWaitAuxiliary && (hasProgress || hasPromise));

  if (!hasActiveDelegation && !hasActiveBackgroundTask && !signalB && !signalA) {
    return {
      shouldContinue: false,
      normalizedSignature,
      telemetry: createClassifierTelemetry({
        classifier: "gemini_premature_stop_guard",
        decision: "allow_stop",
        confidence: 0.95,
        fallbackUsed: false,
        ruleId: "guard.no_signal",
        signalSource: "structured",
      }),
    };
  }

  // Stage 5: Near-duplicate loop escape (Edge #3).
  if (
    (normalizedSignature.length > 0 && input.previousSignatures.includes(normalizedSignature)) ||
    (normalizedSignature.length === 0 &&
      input.retryCount > 0 &&
      input.previousSignatures.includes(""))
  ) {
    return {
      shouldContinue: false,
      normalizedSignature,
      telemetry: createClassifierTelemetry({
        classifier: "gemini_premature_stop_guard",
        decision: "allow_stop",
        confidence: 1,
        fallbackUsed: false,
        ruleId: "guard.duplicate_signature_escape",
        signalSource: "structured",
      }),
    };
  }

  // Priority order: structured signals first (active_delegation -> active_background_task -> incomplete_plan),
  // regex heuristic (`promise_pattern`) last.
  const reason: PrematureStopReason = hasActiveDelegation
    ? "active_delegation"
    : hasActiveBackgroundTask
      ? "active_background_task"
      : signalB
        ? "incomplete_plan"
        : "promise_pattern";
  const isStructured = reason !== "promise_pattern";
  const nextAttempt = input.retryCount + 1;
  const activityLog = `조기 종료 감지 → 자동 계속 실행 (${nextAttempt}/${maxRetries})`;
  const repairPrompt =
    reason === "active_delegation"
      ? ACTIVE_DELEGATION_REPAIR_PROMPT
      : reason === "active_background_task"
        ? ACTIVE_BACKGROUND_TASK_REPAIR_PROMPT
        : reason === "incomplete_plan"
          ? INCOMPLETE_PLAN_CONDITIONAL_REPAIR_PROMPT
          : PROMISE_REPAIR_PROMPT;

  return {
    shouldContinue: true,
    reason,
    normalizedSignature,
    activityLog,
    repairPrompt,
    telemetry: createClassifierTelemetry({
      classifier: "gemini_premature_stop_guard",
      decision: reason,
      confidence: isStructured ? 0.98 : 0.72,
      fallbackUsed: !isStructured,
      ruleId: `guard.${reason}`,
      signalSource: isStructured ? "structured" : "heuristic",
    }),
  };
}
