// @effect-diagnostics nodeBuiltinImport:off anyUnknownInErrorContext:off
import * as NodeCrypto from "node:crypto";
import {
  CommandId,
  EventId,
  MessageId,
  type OrchestrationThread,
  type ThreadId,
  type TurnId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { type ProjectionThreadRuntimeRead } from "../Services/ProjectionSnapshotQuery.ts";
import { asksThroughText } from "../textQuestions.ts";
import {
  decodeQueuedQuestionRecovery,
  decodeRecoveredQuestions,
  isOrchestrationCommandInvariantError,
  type ProviderIntentEvent,
} from "./ProviderCommandHelpers.ts";

export interface AsyncQuestionAnswerRecovererDeps<EResolve, EFail> {
  readonly orchestrationEngine: OrchestrationEngineService["Service"];
  readonly providerService: ProviderService["Service"];
  readonly resolveThread: (
    threadId: ThreadId,
    read?: ProjectionThreadRuntimeRead,
  ) => Effect.Effect<OrchestrationThread | undefined, EResolve>;
  readonly appendProviderFailureActivity: (input: {
    readonly threadId: ThreadId;
    readonly kind:
      | "provider.turn.start.failed"
      | "provider.turn.interrupt.failed"
      | "provider.approval.respond.failed"
      | "provider.user-input.respond.failed"
      | "provider.session.stop.failed";
    readonly summary: string;
    readonly detail: string;
    readonly turnId: TurnId | null;
    readonly createdAt: string;
    readonly requestId?: string;
  }) => Effect.Effect<unknown, EFail>;
}

export function makeAsyncQuestionAnswerRecoverer<EResolve, EFail>(
  deps: AsyncQuestionAnswerRecovererDeps<EResolve, EFail>,
) {
  const { orchestrationEngine, providerService, resolveThread, appendProviderFailureActivity } =
    deps;

  return Effect.fn("recoverAsyncQuestionAnswer")(function* (
    thread: OrchestrationThread,
    event: Extract<ProviderIntentEvent, { type: "thread.user-input-response-requested" }>,
  ) {
    const requestId = event.payload.requestId;
    const fail = (detail: string) =>
      appendProviderFailureActivity({
        threadId: thread.id,
        kind: "provider.user-input.respond.failed",
        summary: "질문 답변을 전달하지 못했습니다",
        detail,
        turnId: null,
        createdAt: event.payload.createdAt,
        requestId,
      });
    const latest = yield* resolveThread(thread.id, { messages: true });
    if (!latest) return;
    if (
      requestId.startsWith("text-question:") &&
      latest.activities.some((activity) => {
        const deferred = activity.payload as { requestId?: unknown; requestIds?: unknown } | null;
        return (
          activity.kind === "provider.user-input.duplicate.deferred" &&
          (deferred?.requestId === requestId ||
            (Array.isArray(deferred?.requestIds) && deferred.requestIds.includes(requestId)))
        );
      })
    ) {
      return yield* fail(
        "동일한 네이티브 질문이 감지됐습니다. 중복 전송을 막기 위해 기존 답변과 실행 상태를 확인해 주세요.",
      );
    }
    if (
      latest.activities.some((activity) => {
        const payload = activity.payload as { requestId?: unknown } | null;
        return activity.kind === "user-input.resolved" && payload?.requestId === requestId;
      })
    ) {
      return yield* fail(
        "이미 종료된 질문입니다 (stale pending user-input request). 현재 표시된 질문을 확인해 주세요.",
      );
    }
    const deliveryMarkers = latest.activities.filter((activity) => {
      const payload = activity.payload as { requestId?: unknown; attemptId?: unknown } | null;
      return payload?.requestId === requestId && typeof payload.attemptId === "string";
    });
    const finishedAttempts = new Set(
      deliveryMarkers
        .filter((activity) => activity.kind === "provider.user-input.delivery.finished")
        .map((activity) => (activity.payload as { attemptId: string }).attemptId),
    );
    if (
      deliveryMarkers.some(
        (activity) =>
          activity.kind === "provider.user-input.delivery.started" &&
          !finishedAttempts.has((activity.payload as { attemptId: string }).attemptId),
      )
    ) {
      return yield* fail(
        "이전 답변의 전달 여부를 확인할 수 없습니다. 중복 전송을 막기 위해 대화 기록에서 처리 여부를 먼저 확인해 주세요.",
      );
    }
    if (
      deliveryMarkers.some(
        (activity) =>
          activity.kind === "provider.user-input.delivery.finished" &&
          (activity.payload as { outcome?: string }).outcome !== "not-delivered",
      )
    ) {
      return yield* fail(
        "이전 답변이 이미 전달됐을 수 있습니다 (stale pending user-input request). 중복 전송을 막기 위해 대화 기록에서 처리 여부를 확인해 주세요.",
      );
    }
    const request = latest.activities.findLast(
      (activity) =>
        activity.kind === "user-input.requested" &&
        typeof activity.payload === "object" &&
        activity.payload !== null &&
        (activity.payload as Record<string, unknown>).requestId === requestId,
    );
    const payload = decodeRecoveredQuestions(request?.payload);
    if (Option.isNone(payload) || payload.value.questions.length === 0) {
      return yield* fail(
        "저장된 질문을 복원하지 못했습니다. 대화에서 같은 질문을 다시 요청해 주세요.",
      );
    }
    const sections: string[] = [];
    for (const question of payload.value.questions) {
      const value = event.payload.answers[question.id];
      const raw =
        typeof value === "string"
          ? [value]
          : Array.isArray(value)
            ? value
            : typeof value === "object" && value !== null && "answers" in value
              ? value.answers
              : null;
      if (!Array.isArray(raw) || !raw.every((answer) => typeof answer === "string")) {
        return yield* fail(
          "질문별 답변을 확인하지 못했습니다. 답변을 확인한 뒤 다시 제출해 주세요.",
        );
      }
      sections.push(`${question.question}\n${raw.join("\n")}`);
    }
    let text = requestId.startsWith("text-question:")
      ? `User answers to the questions you asked:\n${sections.join("\n\n")}`
      : `User response to Codex question ${requestId.slice(6)}:\n${sections.join("\n\n")}`;
    const attachments = (event.payload.images ?? []).map(({ image }) => image);
    const previous = latest.activities
      .filter((activity) => activity.kind === "provider.user-input.recovery.queued")
      .map((activity) => decodeQueuedQuestionRecovery(activity.payload))
      .findLast((entry) => Option.isSome(entry) && entry.value.requestId === requestId);
    const queued = previous && Option.isSome(previous) ? previous.value : undefined;
    if (
      queued &&
      !latest.activities.some(
        (activity) =>
          activity.kind === "provider.user-input.recovery.not-sent" &&
          typeof activity.payload === "object" &&
          activity.payload !== null &&
          "messageId" in activity.payload &&
          activity.payload.messageId === queued.messageId,
      )
    ) {
      const sql = yield* SqlClient.SqlClient;
      const starts = yield* sql<{ sequence: number }>`
        SELECT sequence FROM orchestration_events
        WHERE aggregate_kind = ${"thread"} AND stream_id = ${thread.id} AND event_type = ${"thread.turn-start-requested"}
          AND json_extract(payload_json, ${"$.messageId"}) = ${queued.messageId}
        LIMIT 1
      `;
      if (starts.length > 0) {
        return yield* fail(
          "이미 제출한 답변의 처리 상태를 확인하고 있습니다. 대화 기록에서 결과를 확인해 주세요.",
        );
      }
    }
    if (queued) {
      text = `The previous answer was not delivered. Use this updated answer instead.\n\n${text}`;
    }
    const sessions = yield* providerService.listSessions();
    const runtimeBusy = sessions.some(
      (session) =>
        session.threadId === thread.id &&
        (session.status === "running" ||
          (session.activeTurnId != null && session.status !== "closed")),
    );
    const threadSessions = sessions.filter((session) => session.threadId === thread.id);
    const idleSession = threadSessions.length === 1 ? threadSessions[0] : undefined;
    const staleTextQuestionTurn =
      requestId.startsWith("text-question:") &&
      request?.turnId != null &&
      requestId === "text-question:" + request.turnId &&
      latest.session?.status === "running" &&
      latest.session.activeTurnId === request.turnId &&
      asksThroughText(latest.session.providerName) &&
      latest.session.providerInstanceId !== undefined &&
      idleSession?.providerInstanceId === latest.session.providerInstanceId &&
      idleSession.provider === latest.session.providerName &&
      idleSession.status === "ready" &&
      idleSession.activeTurnId == null;
    if (
      runtimeBusy ||
      ((latest.session?.status === "running" || latest.session?.status === "starting") &&
        !staleTextQuestionTurn)
    ) {
      return yield* fail("현재 작업이 진행 중입니다. 작업이 끝난 뒤 이 답변을 다시 제출해 주세요.");
    }
    if (staleTextQuestionTurn && latest.session) {
      const sql = yield* SqlClient.SqlClient;
      const pending = yield* sql<{ pending_message_id: string }>`
        SELECT pending_message_id FROM projection_turns
        WHERE thread_id = ${thread.id} AND state = 'pending'
          AND turn_id IS NULL AND pending_message_id IS NOT NULL
        LIMIT 1
      `;
      if (pending.length > 0) {
        return yield* fail("다른 요청이 대기 중입니다. 작업 상태를 확인한 뒤 다시 제출해 주세요.");
      }
      const updatedAt = DateTime.formatIso(yield* DateTime.now);
      const reconciled = yield* orchestrationEngine
        .dispatch({
          type: "thread.session.set",
          commandId: CommandId.make("recover-question-session:" + event.eventId),
          threadId: thread.id,
          session: { ...latest.session, status: "ready", activeTurnId: null, updatedAt },
          expectedCurrent: {
            threadUpdatedAt: latest.updatedAt,
            sessionUpdatedAt: latest.session.updatedAt,
            status: latest.session.status,
            activeTurnId: latest.session.activeTurnId,
          },
          createdAt: updatedAt,
        })
        .pipe(
          Effect.as(true),
          Effect.catch(() => Effect.succeed(false)),
        );
      if (!reconciled) {
        return yield* fail("대화 상태가 바뀌어 답변을 보내지 않았습니다. 다시 확인해 주세요.");
      }
      const current = (yield* providerService.listSessions()).filter(
        (session) => session.threadId === thread.id,
      );
      if (
        current.length !== 1 ||
        current[0]?.status !== "ready" ||
        current[0]?.activeTurnId != null ||
        current[0]?.providerInstanceId !== latest.session.providerInstanceId
      ) {
        return yield* fail("현재 작업 상태가 바뀌어 답변을 보내지 않았습니다. 다시 확인해 주세요.");
      }
    }
    const key = NodeCrypto.createHash("sha256")
      .update(`${thread.id}\0${requestId}${queued ? `\0${event.eventId}` : ""}`)
      .digest("hex");
    const messageId = MessageId.make(`recovered-question-${key}`);
    const queuedAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
    yield* orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: CommandId.make(`recover-question-queued:${key}`),
      threadId: thread.id,
      createdAt: queuedAt,
      activity: {
        id: EventId.make(`recover-question-queued:${key}`),
        kind: "provider.user-input.recovery.queued",
        tone: "info",
        summary: "복구한 질문 답변 준비",
        payload: { requestId, messageId, answers: event.payload.answers },
        turnId: null,
        createdAt: queuedAt,
      },
    });
    const started = yield* orchestrationEngine
      .dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make(`recover-question:${key}`),
        threadId: thread.id,
        message: { messageId, role: "user", text, attachments },
        modelSelection: latest.modelSelection,
        runtimeMode: latest.runtimeMode,
        interactionMode: latest.interactionMode,
        createdAt: event.payload.createdAt,
      })
      .pipe(
        Effect.as({ status: "started" as const }),
        Effect.catch((error) =>
          Effect.succeed(
            isOrchestrationCommandInvariantError(error)
              ? { status: "rejected" as const, detail: error.detail }
              : { status: "uncertain" as const },
          ),
        ),
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : Effect.succeed({ status: "uncertain" as const }),
        ),
      );
    if (started.status === "rejected") {
      yield* orchestrationEngine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make(`recover-question-rejected:${key}`),
        threadId: thread.id,
        createdAt: queuedAt,
        activity: {
          id: EventId.make(`recover-question-rejected:${key}`),
          kind: "provider.user-input.recovery.not-sent",
          tone: "info",
          summary: "질문 답변이 공급자에게 전송되기 전에 거절됐습니다",
          payload: { requestId, messageId },
          turnId: null,
          createdAt: queuedAt,
        },
      });
      return yield* fail(
        `답변을 대화에 연결하지 못했습니다: ${started.detail} 문제가 해결되면 다시 제출해 주세요.`,
      );
    }
    if (started.status === "uncertain")
      return yield* fail(
        "답변이 대화에 연결됐는지 확인할 수 없습니다. 중복 전송을 막기 위해 대화 기록에서 처리 여부를 확인해 주세요.",
      );
  });
}
