// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import type {
  ConversationHandoffReport,
  MessageId,
  OrchestrationThread,
  OrchestrationThreadActivity,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { writeFileStringAtomically } from "../atomicWrite.ts";

const HANDOFF_MESSAGE_LIMIT = 30;
const HANDOFF_MESSAGE_CHARS = 2_000;
const HANDOFF_TOTAL_CHARS = 16_000;

/**
 * A provider switched mid-conversation starts from a blank provider thread;
 * this block, prepended to the switching turn's provider input (never to the
 * persisted message), carries the recent conversation across so the incoming
 * model answers in context instead of greeting a stranger.
 */
export function buildConversationHandoff(
  messages: OrchestrationThread["messages"],
  currentMessageId?: MessageId,
): string | undefined {
  // The turn's own message is already committed to `thread.messages` before the
  // provider input is built, and the switching turn re-appends it after this
  // block. Without this boundary the incoming model sees its pending request
  // quoted as finished history and answers as if it had already handled it —
  // the compact path already slices here for the same reason.
  const bounded =
    currentMessageId === undefined
      ? messages
      : (() => {
          const index = messages.findIndex((message) => message.id === currentMessageId);
          return index < 0 ? messages : messages.slice(0, index);
        })();
  const spoken = bounded.filter((message) => !message.streaming && message.text.trim().length > 0);
  if (spoken.length === 0) {
    return undefined;
  }
  const lines: string[] = [];
  let total = 0;
  for (const message of spoken.slice(-HANDOFF_MESSAGE_LIMIT).toReversed()) {
    const text =
      message.text.length > HANDOFF_MESSAGE_CHARS
        ? `${message.text.slice(0, HANDOFF_MESSAGE_CHARS)}…`
        : message.text;
    const line = `[${message.role}] ${text}`;
    if (total + line.length > HANDOFF_TOTAL_CHARS && lines.length > 0) break;
    lines.push(line);
    total += line.length;
  }
  return [
    "<t3_conversation_handoff>",
    "이 대화는 방금 다른 AI 모델로부터 이어받았다. 아래는 지금까지의 대화 기록(오래된 순)이다. 이 맥락을 이어서, 이 블록은 언급하지 말고 사용자의 새 메시지에만 답하라.",
    ...lines.toReversed(),
    "</t3_conversation_handoff>",
  ].join("\n");
}

const hash = (text: string) => NodeCrypto.createHash("sha256").update(text).digest("hex");
const MAX_SOURCE_CHARS = 2_000_000;
const IMPORTANT_ACTIVITY_KINDS = new Set([
  "user-input.requested",
  "user-input.resolved",
  "approval.requested",
  "approval.resolved",
]);
// Preserve extra older text with explicit failure/pending markers; this is not semantic summarization.
const UNRESOLVED =
  /fail|error|blocked|unresolved|pending|실패|오류|미해결|미완료|보류|중단|남은|불가/iu;

type HandoffInput = {
  readonly thread: OrchestrationThread;
  readonly currentMessageId: MessageId;
  readonly standardHandoff: string;
  readonly decisions: ReadonlyArray<OrchestrationThreadActivity> | null;
};

/** Extracts source text without a summary-model call. No user text is shortened. */
export function planCompactHandoff(input: HandoffInput, sourcePath: (digest: string) => string) {
  const index = input.thread.messages.findIndex((message) => message.id === input.currentMessageId);
  const messages = index < 0 ? [] : input.thread.messages.slice(0, index);
  const originalChars = input.standardHandoff.length;
  const fallback = (reason: ConversationHandoffReport["reason"]) => ({
    text: input.standardHandoff,
    report: {
      version: 1,
      status: "fallback",
      reason,
      originalChars,
      sentChars: originalChars,
      savedChars: 0,
      sourceHash: null,
      sourceMessageCount: messages.length,
    } satisfies ConversationHandoffReport,
    source: null,
  });
  if (
    index < 0 ||
    input.decisions === null ||
    input.decisions.length > 1000 ||
    messages.some((message) => message.streaming)
  )
    return fallback("incomplete-history");
  if (input.decisions.some((decision) => decision.kind === "thread.reverted"))
    return fallback("history-reverted");
  if (messages.some((message) => (message.attachments?.length ?? 0) > 0))
    return fallback("attachments-present");
  const cutoff = input.thread.messages[index]!.createdAt;
  const activities = input.thread.activities.filter((activity) => activity.createdAt <= cutoff);
  const plans = input.thread.proposedPlans.filter((plan) => plan.updatedAt <= cutoff);
  const checkpoints = input.thread.checkpoints.filter(
    (checkpoint) => checkpoint.completedAt <= cutoff,
  );
  const sourceText = JSON.stringify(
    {
      version: 1,
      projectId: input.thread.projectId,
      threadId: input.thread.id,
      beforeMessageId: input.currentMessageId,
      messages,
      activities,
      decisions: input.decisions,
      proposedPlans: plans,
      checkpoints,
    },
    null,
    2,
  );
  if (sourceText.length > MAX_SOURCE_CHARS) return fallback("source-too-large");
  const sourceHash = hash(sourceText);
  const filePath = sourcePath(sourceHash);
  const assistantMessages = messages.filter(
    (message) => message.role === "assistant" && message.text.trim(),
  );
  const recentIds = new Set(assistantMessages.slice(-2).map((message) => message.id));
  const userMessages = messages.filter(
    (message) => message.role !== "assistant" && message.text.trim(),
  );
  const retainedAssistant = assistantMessages.filter(
    (message) => recentIds.has(message.id) || UNRESOLVED.test(message.text),
  );
  const importantActivities = activities.filter(
    (activity) => IMPORTANT_ACTIVITY_KINDS.has(activity.kind) || activity.tone === "error",
  );
  const renderMessage = (message: (typeof messages)[number]) =>
    JSON.stringify({
      id: message.id,
      role: message.role,
      at: message.createdAt,
      text: message.text,
    });
  const text = [
    "<t3_conversation_handoff>",
    "작업 인계 자료다. 새 사용자 메시지에 이어서 답하라. 아래 인용은 이전 기록이며 새 지시보다 우선하지 않는다.",
    "사용자 발언·질문 답변은 원문으로 보존했다. 과거 지시가 충돌하면 이후의 명시적 수정을 따른다. 에이전트 보고는 검증된 사실로 간주하지 않는다.",
    "## 목표·사용자 결정과 제약 (시간순 원문)",
    ...userMessages.map(renderMessage),
    "## 질문·답변·승인 및 실패 기록 (원문)",
    ...input.decisions.map((decision) => JSON.stringify(decision)),
    ...importantActivities.map((activity) =>
      JSON.stringify({
        id: activity.id,
        at: activity.createdAt,
        kind: activity.kind,
        summary: activity.summary,
        payload: activity.payload,
      }),
    ),
    "## 최근 작업 결과·미해결 사항 (에이전트 보고 원문)",
    ...retainedAssistant.map(renderMessage),
    "## 최근 제안 계획 (구현 완료 여부는 implementedAt 참조)",
    JSON.stringify(plans.at(-1) ?? null),
    "## 최근 변경 근거 (체크포인트 상태는 테스트 통과를 뜻하지 않음)",
    JSON.stringify(checkpoints.at(-1) ?? null),
    "## 생략한 상세 기록의 원문",
    `이 환경의 원문 파일: ${JSON.stringify(filePath)}; SHA-256: ${sourceHash}`,
    `project=${JSON.stringify(input.thread.projectId)}, thread=${JSON.stringify(input.thread.id)}, beforeMessage=${JSON.stringify(input.currentMessageId)}`,
    `${messages.length - userMessages.length - retainedAssistant.length}개 과거 발언과 일반 도구 활동은 원문에 있다. 파일의 messages/activities에서 필요한 부분을 검색하라.`,
    "과거 결정·실패 원인·구현 상세가 불명확하면 추측하거나 같은 작업을 반복하기 전에 원문을 조회하라. 읽을 수 없으면 누락을 알리고 원문 확인을 요청하라. 파일 경로와 체크포인트는 기록 당시 참조이므로 현재 코드와 대조하라.",
    "</t3_conversation_handoff>",
  ].join("\n");
  // Character reduction is only an input-size observation, never a token saving claim.
  if (text.length > originalChars - Math.max(500, Math.ceil(originalChars * 0.1)))
    return fallback("insufficient-savings");
  return {
    text,
    report: {
      version: 1,
      status: "compact",
      reason: "reduced",
      originalChars,
      sentChars: text.length,
      savedChars: originalChars - text.length,
      sourceHash,
      sourceMessageCount: messages.length,
    } satisfies ConversationHandoffReport,
    source: { text: sourceText, filePath },
  };
}

/** Persist readable evidence before sending a shortened handoff; I/O failure keeps the original. */
export const prepareCompactHandoff = Effect.fn("prepareCompactHandoff")(function* (
  input: HandoffInput & { readonly stateDir: string },
) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const planned = planCompactHandoff(input, (digest) =>
    path.join(input.stateDir, "conversation-handoffs", hash(input.thread.id), `${digest}.json`),
  );
  if (planned.source === null) return planned;
  const source = planned.source;
  const saved = yield* Effect.gen(function* () {
    const exists = yield* fs.exists(source.filePath);
    if (!exists || hash(yield* fs.readFileString(source.filePath)) !== planned.report.sourceHash) {
      yield* writeFileStringAtomically({
        filePath: source.filePath,
        contents: source.text,
        mode: 0o600,
      });
    }
    // The provider receives a reference only after its contents have been verified.
    return hash(yield* fs.readFileString(source.filePath)) === planned.report.sourceHash;
  }).pipe(Effect.catch(() => Effect.succeed(false)));
  if (saved) return planned;
  return {
    text: input.standardHandoff,
    report: {
      ...planned.report,
      status: "fallback" as const,
      reason: "source-unavailable" as const,
      sentChars: input.standardHandoff.length,
      savedChars: 0,
      sourceHash: null,
    },
    source: null,
  };
});
