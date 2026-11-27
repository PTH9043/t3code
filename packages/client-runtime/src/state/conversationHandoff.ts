import {
  ConversationHandoffDelivery,
  ConversationHandoffReport,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const isReport = Schema.is(ConversationHandoffReport);
const isDelivery = Schema.is(ConversationHandoffDelivery);
const number = new Intl.NumberFormat("ko-KR");
export const handoffModeLabel = {
  standard: "기존 인계",
  compact: "인계 문맥 절약",
  adaptive: "적응형 캡슐 인계",
} as const;
export const handoffDescription =
  "이 대화에서 모델 전환으로 새 세션을 만들 때 적용합니다. 사용자 원문을 보존하고 생략한 상세 기록은 필요할 때 다시 읽습니다. 모델·추론 수준은 바꾸지 않습니다.";
export const handoffMeasurementNote =
  "글자 감소량은 준비된 인계 입력의 비교입니다. 재조회·응답까지 포함한 실제 절감은 작업 토큰 사용량으로 확인해야 합니다.";
const reasons: Record<ConversationHandoffReport["reason"], string> = {
  reduced: "문맥 축소 준비됨",
  "insufficient-savings": "보존할 원문이 많거나 대화가 짧아 기존 인계를 유지했습니다.",
  "incomplete-history": "기록 경계가 불명확하거나 작성 중인 발언이 있어 기존 인계를 유지했습니다.",
  "source-unavailable": "상세 원문을 저장·확인하지 못해 기존 인계를 유지했습니다.",
  "source-too-large": "원문 보관 크기 한도를 넘어 기존 인계를 유지했습니다.",
  "attachments-present": "과거 첨부 자료가 있어 기존 인계를 유지했습니다.",
  "history-reverted": "되돌린 대화의 이전 결정을 다시 적용하지 않도록 기존 인계를 유지했습니다.",
};
function readDelivery(activity: OrchestrationThreadActivity) {
  return activity.kind === "conversation.handoff.delivered" && isDelivery(activity.payload)
    ? activity.payload
    : null;
}
function readPrepared(activity: OrchestrationThreadActivity) {
  return activity.kind === "conversation.handoff.prepared" && isReport(activity.payload)
    ? activity.payload
    : null;
}

export function latestHandoffActivity(activities: ReadonlyArray<OrchestrationThreadActivity>) {
  const activity = activities.findLast(
    (entry) =>
      entry.kind === "conversation.handoff.delivered" ||
      entry.kind === "conversation.handoff.prepared" ||
      entry.kind === "conversation.handoff.unavailable",
  );
  if (!activity) return null;
  return {
    createdAt: activity.createdAt,
    summary: activity.summary,
    delivery: readDelivery(activity),
    prepared: readPrepared(activity),
  };
}

export function latestHandoffReport(activities: ReadonlyArray<OrchestrationThreadActivity>) {
  for (let index = activities.length - 1; index >= 0; index--) {
    const activity = activities[index]!;
    const report = readDelivery(activity)?.compactReport ?? readPrepared(activity);
    if (report) return { report, createdAt: activity.createdAt };
  }
  return null;
}

function handoffSourceLabel(delivery: ConversationHandoffDelivery): string {
  if (delivery.backend === "workspace-memory") {
    if (delivery.archiveAttached) return "작업공간 기억 · 원문 스냅샷 포함";
    if (delivery.requestedMode === "compact" && delivery.archiveAttached === false)
      return "작업공간 기억 · 원문 스냅샷 없이 발췌본 전달";
    return "작업공간 기억";
  }
  if (delivery.compactReport?.status === "adaptive") return "적응형 캡슐 인계";
  if (delivery.compactReport?.status === "compact") return "대화 기록 · 축약본";
  return delivery.requestedMode === "compact"
    ? "대화 기록 · 기본 인계로 대체"
    : delivery.requestedMode === "adaptive"
      ? "적응형 캡슐 인계"
      : "대화 기록 · 기본 인계";
}

export function handoffDeliveryText(delivery: ConversationHandoffDelivery): string {
  const messages = delivery.compactReport
    ? ` · 이전 메시지 ${delivery.compactReport.sourceMessageCount}개`
    : "";
  return `${handoffSourceLabel(delivery)}${messages} · 접수된 인계 문맥 ${number.format(delivery.chars)}자`;
}
export function handoffReportText(report: ConversationHandoffReport): string {
  if (report.status === "fallback") return reasons[report.reason];
  return `인계 입력 ${number.format(report.originalChars)} → ${number.format(report.sentChars)}자 · ${number.format(report.savedChars)}자 감소`;
}
