import {
  resolveThreadOutboxFailureAction,
  type QueuedThreadMessage,
  type ThreadOutboxCommandStage,
} from "./thread-outbox-model";

/** Persist an actionable failure without overwriting a newer queue edit. */
export async function retainThreadOutboxFailure(input: {
  readonly message: QueuedThreadMessage;
  readonly stage: ThreadOutboxCommandStage;
  readonly error: unknown;
  readonly interrupted: boolean;
  readonly updateIfCurrent: (
    expected: QueuedThreadMessage,
    replacement: QueuedThreadMessage,
  ) => Promise<boolean>;
}): Promise<"retry" | "held" | "changed"> {
  if (resolveThreadOutboxFailureAction(input) === "retry") return "retry";
  const failureMessage =
    input.error instanceof Error
      ? input.error.message
      : typeof input.error === "string"
        ? input.error
        : typeof input.error === "object" &&
            input.error !== null &&
            "message" in input.error &&
            typeof input.error.message === "string"
          ? input.error.message
          : "전송을 완료하지 못했습니다.";
  const saved = await input.updateIfCurrent(input.message, {
    ...input.message,
    deliveryFailure: { stage: input.stage, message: failureMessage },
  });
  return saved ? "held" : "changed";
}

export async function reconcileQueuedCreationReceipt(input: {
  readonly message: QueuedThreadMessage;
  readonly status: "accepted" | "unconfirmed" | "mismatch" | "rejected" | "unavailable";
  readonly removeIfCurrent: (expected: QueuedThreadMessage) => Promise<boolean>;
  readonly updateIfCurrent: (
    expected: QueuedThreadMessage,
    replacement: QueuedThreadMessage,
  ) => Promise<boolean>;
}): Promise<"removed" | "held" | "changed"> {
  if (input.status === "accepted")
    return (await input.removeIfCurrent(input.message)) ? "removed" : "changed";
  const detail =
    input.status === "unavailable"
      ? "서버에서 첫 메시지 접수 여부를 확인하지 못했습니다. 대화 기록을 확인하세요."
      : input.status === "mismatch"
        ? "저장된 요청이 서버의 접수 기록과 다릅니다. 대화 기록을 확인하세요."
        : input.status === "rejected"
          ? "서버가 첫 메시지 요청을 거절했습니다. 대화와 작업 상태를 확인하세요."
          : "첫 메시지의 접수 여부가 아직 확인되지 않았습니다. 대화 기록을 확인하세요.";
  if (
    input.status === "unconfirmed" &&
    input.message.deliveryReceiptChecked === false &&
    input.message.deliveryFailure?.stage === "start-turn" &&
    input.message.deliveryFailure.message === detail
  )
    return "held";
  const result = await retainThreadOutboxFailure({
    message: input.message,
    stage: "start-turn",
    error: detail,
    interrupted: false,
    updateIfCurrent: (expected, replacement) =>
      input.updateIfCurrent(expected, {
        ...replacement,
        deliveryReceiptChecked: input.status !== "unconfirmed",
      }),
  });
  return result === "held" ? "held" : "changed";
}
