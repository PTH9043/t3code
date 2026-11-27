/**
 * SessionRecoveryReactor - one-shot startup sweep that recovers work the
 * previous server process took down with it.
 *
 * Provider CLI sessions are stdio children of the server, so a restart —
 * a rebuild picked up by the dev watcher, an update, a crash — kills them
 * mid-turn. Nothing else corrects the projection afterwards: the session row
 * stays `running` forever and the thread wears a permanent spinner.
 *
 * The sweep does two things per stranded thread:
 *  1. settles the phantom session (`thread.session.stop`), and
 *  2. when a turn was actually in flight, starts a recovery turn that tells
 *     the seat to pick the work back up. The provider session restarts from
 *     its persisted `resumeCursor`, so it returns with the full prior
 *     conversation and can continue rather than start over.
 *
 * Threads owned by a resumable collaboration run are settled but NOT given a
 * recovery turn — the collaboration reactor re-drives those itself, and a
 * second driver would race it.
 *
 * A question the seat had open when the server died (`user-input.requested`
 * with no resolution) is closed here too. Provider callback state does not
 * survive the restart, so the card could only ever fail with "stale request"
 * when answered; meanwhile the recovery turn asks again. Closing it keeps one
 * live question on screen instead of a dead one above it.
 *
 * Background watch work dies with the provider process as well: Monitor
 * loops and background shells (`task.started` with no terminal row) and a
 * scheduled self-wakeup (`ScheduleWakeup`) the seat was counting on. Both are
 * invisible casualties — the seat resumes from its transcript believing they
 * still run, and the person sees nothing either way. The sweep records them
 * as interrupted (a `task.completed` per task plus one `session.recovered`
 * marker the clients read as the cut-off) and tells the seat in the recovery
 * turn so it can re-arm what it still needs.
 *
 * @module SessionRecoveryReactor
 */
import {
  CommandId,
  EventId,
  MessageId,
  WorkspaceOrchestraBlock,
  type OrchestrationThreadActivity,
  type OrchestrationThreadShell,
  type ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerConfig } from "../../config.ts";
import { isSafeguardBlock } from "../../provider/providerContentRefusal.ts";
import { forkParked } from "../../serverActivation.ts";
import { isDetachedUpgradeRoomThread } from "../UpgradeRoomTurns.ts";
import { WatchdogRuntime } from "../WatchdogRuntime.ts";
import {
  ProjectionThreadActivityRepository,
  type ProjectionThreadActivity,
} from "../../persistence/Services/ProjectionThreadActivities.ts";
import {
  ProjectionThreadMessageRepository,
  type ProjectionThreadMessage,
} from "../../persistence/Services/ProjectionThreadMessages.ts";
import { ProjectionWorkspaceCollaborationRunRepository } from "../../persistence/Services/ProjectionWorkspaceCollaborationRuns.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { makeRecoveryDeliveryJournal } from "../recoveryDeliveryJournal.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  SessionRecoveryReactor,
  type SessionRecoveryReactorShape,
} from "../Services/SessionRecoveryReactor.ts";

import {
  ABANDONED_QUESTION_TEXT,
  RECOVERY_BACKGROUND_TEXT,
  RECOVERY_MCP_CHECK_TEXT,
  RECOVERY_TURN_TEXT,
  RECOVERY_TURN_TEXT_PREFIX,
  MCP_MONITOR_MAX_MS,
  MCP_RECOVERY_SUMMARIES,
  orphanedBackgroundWork,
  orphanedWorkText,
  payloadOf,
} from "../backgroundWatchRecovery.ts";
export { orphanedBackgroundWork } from "../backgroundWatchRecovery.ts";
import { backgroundWatchPolicy, ServerSettingsService } from "../../serverSettings.ts";

const ABANDONED_QUESTION_SUMMARY =
  "서버 재시작으로 이전 질문이 만료됐습니다. 필요한 경우 다시 질문을 요청하세요.";
const ABANDONED_APPROVAL_SUMMARY = "서버 재시작으로 이전 승인 요청이 만료되어 닫혔습니다.";
const APPROVAL_LIFECYCLE_ACTIVITY_KINDS: ReadonlyArray<string> = [
  "approval.requested",
  "approval.resolved",
  "provider.approval.respond.failed",
];
const isOrchestraBlock = Schema.is(WorkspaceOrchestraBlock);
const decodeOrchestraBlockJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(WorkspaceOrchestraBlock),
);
const isLegacyUpgradeRoomExecutionId = (value: unknown): boolean =>
  typeof value === "string" && /^upgrade-room-turn-[a-f0-9]{32}$/.test(value);

const isStaleApprovalFailureDetail = (detail: unknown): boolean => {
  if (typeof detail !== "string") return false;
  const normalized = detail.toLowerCase();
  return (
    normalized.includes("stale pending approval request") ||
    normalized.includes("unknown pending approval request") ||
    normalized.includes("unknown pending permission request")
  );
};

/**
 * Recovery storm guard. A recovery turn that itself dies to the next restart
 * is evidence the thread's own work is what keeps killing the server — an
 * in-app seat editing a bundled contract, say, restarts the desktop host
 * mid-edit, and the recovery turn then redoes the same edit. Past this many
 * recovery turns inside the window the sweep settles the session but leaves
 * the thread parked; the person resumes it with a message when they are ready.
 */
export const RECOVERY_STORM_WINDOW_MS = 15 * 60 * 1_000;
export const RECOVERY_STORM_LIMIT = 3;
/** Recovery turns the server already injected into this thread inside the window, newest first. */
export function recentRecoveryTurnCount(
  messages: ReadonlyArray<Pick<ProjectionThreadMessage, "role" | "text" | "createdAt">>,
  nowMs: number,
  windowMs: number = RECOVERY_STORM_WINDOW_MS,
): number {
  let count = 0;
  for (const message of messages) {
    if (message.role !== "user" || !message.text.startsWith(RECOVERY_TURN_TEXT_PREFIX)) continue;
    const at = Date.parse(message.createdAt);
    if (Number.isNaN(at) || nowMs - at > windowMs) continue;
    count += 1;
  }
  return count;
}

const recoveryHeldText = (recoveries: number): string =>
  `자동 복구 보류: ${Math.round(RECOVERY_STORM_WINDOW_MS / 60_000)}분 안에 서버가 ${recoveries}번 재시작되어 이 대화는 자동으로 재개하지 않습니다. 이 대화의 작업이 재시작의 원인일 수 있습니다. 계속하려면 직접 메시지를 보내세요.`;

const isInterruptedSessionStatus = (status: string): boolean =>
  status === "starting" || status === "running";

const isRecoverableQuestion = (requestId: string): boolean =>
  requestId.startsWith("async:") || requestId.startsWith("text-question:");

const requestIdOf = (payload: unknown): string | null => {
  if (typeof payload !== "object" || payload === null) return null;
  const requestId = (payload as Record<string, unknown>).requestId;
  return typeof requestId === "string" ? requestId : null;
};

/**
 * Request ids of questions still open in the activity log — asked, never
 * resolved, and not already failed as stale. Mirrors the projection's own
 * pending-count derivation so the two never disagree on what is open.
 */
export function openUserInputRequestIds(
  activities: ReadonlyArray<ProjectionThreadActivity>,
): ReadonlyArray<string> {
  const open = new Set<string>();
  const ordered = [...activities].toSorted(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) ||
      left.activityId.localeCompare(right.activityId),
  );
  for (const activity of ordered) {
    const requestId = requestIdOf(activity.payload);
    if (requestId === null) continue;
    if (activity.kind === "user-input.requested") open.add(requestId);
    else if (activity.kind === "user-input.resolved") open.delete(requestId);
    else if (activity.kind === "provider.user-input.respond.failed") {
      const detail = (activity.payload as Record<string, unknown>).detail;
      if (typeof detail === "string" && /pending user.?input request/i.test(detail)) {
        open.delete(requestId);
      }
    }
  }
  return [...open];
}

function uncertainAsyncAnswers(
  activities: ReadonlyArray<ProjectionThreadActivity>,
  priorIds: ReadonlySet<string>,
  priorActivityIds: ReadonlySet<string>,
): ReadonlyArray<string> {
  const open = new Set(openUserInputRequestIds(activities));
  const records = new Map<
    string,
    {
      started: Set<string>;
      finished: Map<string, unknown>;
      priorFinished: Set<string>;
      queued: Set<string>;
      notSent: Set<string>;
      warned: boolean;
    }
  >();
  for (const activity of activities) {
    const payload = payloadOf(activity);
    const requestId = requestIdOf(payload);
    if (
      !payload ||
      !requestId ||
      !isRecoverableQuestion(requestId) ||
      !priorIds.has(requestId) ||
      !open.has(requestId)
    )
      continue;
    const entry = records.get(requestId) ?? {
      started: new Set<string>(),
      finished: new Map<string, unknown>(),
      priorFinished: new Set<string>(),
      queued: new Set<string>(),
      notSent: new Set<string>(),
      warned: false,
    };
    if (
      activity.kind === "provider.user-input.delivery.started" &&
      priorActivityIds.has(activity.activityId) &&
      typeof payload.attemptId === "string"
    )
      entry.started.add(payload.attemptId);
    if (
      activity.kind === "provider.user-input.delivery.finished" &&
      typeof payload.attemptId === "string"
    ) {
      entry.finished.set(payload.attemptId, payload.outcome);
      if (priorActivityIds.has(activity.activityId)) entry.priorFinished.add(payload.attemptId);
    }
    if (
      activity.kind === "provider.user-input.recovery.queued" &&
      priorActivityIds.has(activity.activityId) &&
      typeof payload.messageId === "string"
    )
      entry.queued.add(payload.messageId);
    if (
      activity.kind === "provider.user-input.recovery.not-sent" &&
      typeof payload.messageId === "string"
    )
      entry.notSent.add(payload.messageId);
    if (
      activity.kind === "provider.user-input.respond.failed" &&
      payload.code === "delivery-unknown-after-restart"
    )
      entry.warned = true;
    records.set(requestId, entry);
  }
  return [...records].flatMap(([requestId, entry]) => {
    const unknown =
      [...entry.started].some((id) => !entry.finished.has(id)) ||
      [...entry.priorFinished].some((id) => entry.finished.get(id) !== "not-delivered") ||
      [...entry.queued].some((id) => !entry.notSent.has(id));
    return unknown && !entry.warned ? [requestId] : [];
  });
}

/**
 * Request ids of approvals still open in the activity log — requested, never
 * resolved, and not already failed as stale.
 */
export function openApprovalRequestIds(
  activities: ReadonlyArray<ProjectionThreadActivity>,
): ReadonlyArray<string> {
  const open = new Set<string>();
  const ordered = [...activities].toSorted(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) ||
      left.activityId.localeCompare(right.activityId),
  );
  for (const activity of ordered) {
    const requestId = requestIdOf(activity.payload);
    if (requestId === null) continue;
    if (activity.kind === "approval.requested") open.add(requestId);
    else if (activity.kind === "approval.resolved") open.delete(requestId);
    else if (activity.kind === "provider.approval.respond.failed") {
      if (isStaleApprovalFailureDetail((activity.payload as Record<string, unknown>).detail)) {
        open.delete(requestId);
      }
    }
  }
  return [...open];
}

/**
 * Latest orchestra.block snapshot per messageId that is still in an active
 * non-terminal status (`running` or `awaiting-user`).
 */
export function runningOrchestraBlocksByMessage(
  activities: ReadonlyArray<
    Pick<ProjectionThreadActivity, "kind" | "payload" | "createdAt" | "activityId">
  >,
): ReadonlyMap<MessageId, WorkspaceOrchestraBlock> {
  const latest = new Map<MessageId, WorkspaceOrchestraBlock>();
  const ordered = [...activities].toSorted(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) ||
      left.activityId.localeCompare(right.activityId),
  );
  for (const activity of ordered) {
    if (activity.kind !== "orchestra.block" || !isOrchestraBlock(activity.payload)) continue;
    if (
      activity.payload.ownerThreadId === "autousage-upgrade-room" &&
      activity.payload.runId === "upgrade-room" &&
      isLegacyUpgradeRoomExecutionId(activity.payload.executionId)
    ) {
      continue;
    }
    latest.set(activity.payload.messageId, activity.payload);
  }
  const active = new Map<MessageId, WorkspaceOrchestraBlock>();
  for (const [messageId, block] of latest) {
    if (block.status === "running" || block.status === "awaiting-user") {
      active.set(messageId, block);
    }
  }
  return active;
}

export const makeSessionRecoveryReactor = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const policy = backgroundWatchPolicy(yield* ServerSettingsService);
  const sql = yield* SqlClient.SqlClient;
  const recoveryDelivery = makeRecoveryDeliveryJournal(sql);
  const serverConfig = yield* Effect.serviceOption(ServerConfig);
  // Detached room workers own their own recovery; never resend their turns here.
  const detachedRoom =
    Option.isSome(serverConfig) && Option.isSome(yield* Effect.serviceOption(WatchdogRuntime))
      ? (threadId: string) => isDetachedUpgradeRoomThread(serverConfig.value.upgradeRoom, threadId)
      : () => false;
  const messageRepository = yield* ProjectionThreadMessageRepository;
  const snapshotQuery = yield* ProjectionSnapshotQuery;
  const runRepository = yield* ProjectionWorkspaceCollaborationRunRepository;
  const activityRepository = yield* ProjectionThreadActivityRepository;
  const crypto = yield* Crypto.Crypto;
  const randomUUID = crypto.randomUUIDv4;
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const done = yield* Deferred.make<void>();

  const listPendingApprovalIdsFromSql = (threadId: ThreadId) =>
    sql<{ readonly requestId: string }>`
      SELECT request_id AS "requestId"
      FROM projection_pending_approvals
      WHERE thread_id = ${threadId}
        AND status = 'pending'
      ORDER BY created_at ASC, request_id ASC
    `.pipe(
      Effect.map((rows) => rows.map((row) => row.requestId)),
      Effect.orElseSucceed(() => [] as ReadonlyArray<string>),
    );

  /** Close every approval request the dead server process left open. */
  const abandonOpenApprovals = Effect.fn("SessionRecoveryReactor.abandonOpenApprovals")(function* (
    threadId: ThreadId,
    priorIds: ReadonlySet<string>,
  ) {
    if (priorIds.size === 0) return 0;
    const activities = yield* activityRepository.listByThreadIdAndKinds({
      threadId,
      kinds: APPROVAL_LIFECYCLE_ACTIVITY_KINDS,
    });
    const sqlPending = yield* listPendingApprovalIdsFromSql(threadId);
    const open = [...new Set([...openApprovalRequestIds(activities), ...sqlPending])].filter(
      (requestId) => priorIds.has(requestId),
    );
    for (const requestId of open) {
      const createdAt = yield* nowIso;
      yield* engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make(yield* randomUUID),
        threadId,
        activity: {
          id: EventId.make(yield* randomUUID),
          tone: "info",
          kind: "approval.resolved",
          summary: ABANDONED_APPROVAL_SUMMARY,
          payload: {
            requestId,
            decision: "cancel",
            abandoned: true,
            timelineBypass: true,
          },
          turnId: null,
          createdAt,
        },
        createdAt,
      });
    }
    return open.length;
  });

  const captureRunningOrchestraBlocks = () =>
    sql<{
      readonly threadId: string;
      readonly activityId: string;
      readonly createdAt: string;
      readonly payloadJson: string;
    }>`
      SELECT thread_id AS "threadId",
             activity_id AS "activityId",
             created_at AS "createdAt",
             payload_json AS "payloadJson"
      FROM projection_thread_activities
      WHERE kind = 'orchestra.block'
      ORDER BY created_at ASC, activity_id ASC
    `.pipe(
      Effect.map((rows) => {
        const byThread = new Map<
          ThreadId,
          Array<Pick<ProjectionThreadActivity, "kind" | "payload" | "createdAt" | "activityId">>
        >();
        for (const row of rows) {
          const decoded = decodeOrchestraBlockJson(row.payloadJson);
          if (Option.isNone(decoded)) continue;
          const threadId = row.threadId as ThreadId;
          const list = byThread.get(threadId) ?? [];
          list.push({
            kind: "orchestra.block",
            payload: decoded.value,
            createdAt: row.createdAt,
            activityId: EventId.make(row.activityId),
          });
          byThread.set(threadId, list);
        }
        const activeByThread = new Map<ThreadId, ReadonlyMap<MessageId, WorkspaceOrchestraBlock>>();
        for (const [threadId, activities] of byThread) {
          const active = runningOrchestraBlocksByMessage(activities);
          if (active.size > 0) activeByThread.set(threadId, active);
        }
        return activeByThread;
      }),
      Effect.orElseSucceed(
        () => new Map<ThreadId, ReadonlyMap<MessageId, WorkspaceOrchestraBlock>>(),
      ),
    );

  const cancelOrphanedOrchestraBlocks = Effect.fn(
    "SessionRecoveryReactor.cancelOrphanedOrchestraBlocks",
  )(function* (
    threadId: ThreadId,
    capturedBlocks: ReadonlyMap<MessageId, WorkspaceOrchestraBlock>,
    resumableRunIds: ReadonlySet<string>,
  ) {
    const candidates = [...capturedBlocks.values()].filter(
      (block) => !resumableRunIds.has(block.runId),
    );
    if (candidates.length === 0) return 0;
    const currentActivities = yield* activityRepository
      .listByThreadIdAndKinds({
        threadId,
        kinds: ["orchestra.block"],
      })
      .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<ProjectionThreadActivity>));
    const latestByMessage = new Map<MessageId, WorkspaceOrchestraBlock>();
    const orderedCurrent = [...currentActivities].toSorted(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) ||
        left.activityId.localeCompare(right.activityId),
    );
    for (const activity of orderedCurrent) {
      if (activity.kind === "orchestra.block" && isOrchestraBlock(activity.payload)) {
        latestByMessage.set(activity.payload.messageId, activity.payload);
      }
    }
    const messages = yield* messageRepository
      .listByThreadId({ threadId })
      .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<ProjectionThreadMessage>));
    const streamingMessageIds = new Set(
      messages.filter((message) => message.isStreaming).map((message) => message.messageId),
    );
    let cancelledCount = 0;
    for (const captured of candidates) {
      const current = latestByMessage.get(captured.messageId);
      if (
        current &&
        (current.executionId !== captured.executionId ||
          current.attempt !== captured.attempt ||
          (current.status !== "running" && current.status !== "awaiting-user"))
      ) {
        continue;
      }
      const target = current ?? captured;
      const createdAt = yield* nowIso;
      yield* engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make(yield* randomUUID),
        threadId,
        activity: {
          id: EventId.make(yield* randomUUID),
          tone: "info",
          kind: "orchestra.block",
          summary: target.title,
          payload: { ...target, status: "cancelled" },
          turnId: null,
          createdAt,
        },
        createdAt,
      });
      if (streamingMessageIds.has(target.messageId)) {
        yield* engine.dispatch({
          type: "thread.message.assistant.complete",
          commandId: CommandId.make(yield* randomUUID),
          threadId,
          messageId: target.messageId,
          createdAt,
        });
      }
      cancelledCount += 1;
    }
    return cancelledCount;
  });

  /** Close every question the dead session left open; returns how many there were. */
  const abandonOpenQuestions = Effect.fn("SessionRecoveryReactor.abandonOpenQuestions")(function* (
    threadId: ThreadId,
    activities: ReadonlyArray<ProjectionThreadActivity>,
    priorIds: ReadonlySet<string>,
  ) {
    const open = openUserInputRequestIds(activities).filter(
      (requestId) => priorIds.has(requestId) && !isRecoverableQuestion(requestId),
    );
    for (const requestId of open) {
      const createdAt = yield* nowIso;
      yield* engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make(yield* randomUUID),
        threadId,
        activity: {
          id: EventId.make(yield* randomUUID),
          tone: "info",
          kind: "user-input.resolved",
          summary: ABANDONED_QUESTION_SUMMARY,
          payload: { requestId, answers: {}, abandoned: true },
          turnId: null,
          createdAt,
        },
        createdAt,
      });
    }
    return open.length;
  });

  const reportUncertainAsyncAnswers = Effect.fn(
    "SessionRecoveryReactor.reportUncertainAsyncAnswers",
  )(function* (
    threadId: ThreadId,
    activities: ReadonlyArray<ProjectionThreadActivity>,
    priorIds: ReadonlySet<string>,
    priorActivityIds: ReadonlySet<string>,
  ) {
    for (const requestId of uncertainAsyncAnswers(activities, priorIds, priorActivityIds)) {
      const createdAt = yield* nowIso;
      yield* engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make(yield* randomUUID),
        threadId,
        createdAt,
        activity: {
          id: EventId.make(yield* randomUUID),
          kind: "provider.user-input.respond.failed",
          tone: "error",
          summary: "질문 답변의 전달 여부를 확인해 주세요",
          payload: {
            requestId,
            code: "delivery-unknown-after-restart",
            detail:
              "서버 재시작 전에 제출한 답변이 전달됐는지 확인할 수 없습니다. 중복 전송을 막기 위해 자동으로 다시 보내지 않았습니다. 대화 기록에서 처리 여부를 확인해 주세요.",
          },
          turnId: null,
          createdAt,
        },
      });
    }
  });

  /**
   * Settle background work the dead session took with it: one interrupted
   * `task.completed` per open task (keeps the timeline's task state honest)
   * and a `session.recovered` marker the clients use as the cut-off for
   * "still watching" / "next wake" displays.
   */
  const prepareOrphanedWork = Effect.fn("SessionRecoveryReactor.prepareOrphanedWork")(function* (
    activities: ReadonlyArray<ProjectionThreadActivity>,
    revokedAtMs?: number,
  ) {
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    const work = orphanedBackgroundWork(activities, nowMs, revokedAtMs);
    const prepared: Array<OrchestrationThreadActivity> = [];
    for (const task of work.otherTasks) {
      prepared.push({
        id: EventId.make(yield* randomUUID),
        tone: "info",
        kind: "task.completed",
        summary:
          "서버 재시작으로 백그라운드 작업 추적이 중단되었습니다. 작업의 최종 상태는 확인되지 않았습니다.",
        payload: {
          taskId: task.taskId,
          agentKind: "background",
          status: "interrupted",
          outcomeUnknown: true,
        },
        turnId: null,
        createdAt: yield* nowIso,
      });
    }
    if (
      work.tasks.length === 0 &&
      work.mcpMonitors.length === 0 &&
      work.wakeupScheduledFor === null
    )
      return { work, prepared };
    for (const task of work.tasks) {
      const createdAt = yield* nowIso;
      prepared.push({
        id: EventId.make(yield* randomUUID),
        tone: "info",
        kind: "task.completed",
        summary: "서버 재시작으로 백그라운드 작업이 끊겼습니다",
        payload: {
          taskId: task.taskId,
          status: "interrupted",
          agentKind: "background",
          ...(task.title === null ? {} : { title: task.title }),
        },
        turnId: null,
        createdAt,
      });
    }
    const createdAt = yield* nowIso;
    prepared.push({
      id: EventId.make(yield* randomUUID),
      tone: "info",
      kind: "session.recovered",
      summary:
        work.tasks.length > 0
          ? `서버 재시작으로 백그라운드 감시 ${work.tasks.length}개가 끊겼습니다${work.wakeupScheduledFor === null ? "" : " (예약된 자동 깨어남 포함)"}`
          : work.mcpMonitors.length > 0
            ? "서버 재시작 전 MCP 감시의 상태 확인이 필요합니다"
            : "서버 재시작으로 예약된 자동 깨어남이 사라졌습니다",
      payload: {
        interruptedTasks: work.tasks,
        possibleMcpMonitors: work.mcpMonitors,
        wakeupScheduledFor: work.wakeupScheduledFor,
      },
      turnId: null,
      createdAt,
    });
    return { work, prepared };
  });

  const recoverThread = Effect.fn("SessionRecoveryReactor.recoverThread")(function* (
    thread: OrchestrationThreadShell,
    allowRecoveryTurn: boolean,
    priorIds: ReadonlySet<string>,
    priorActivityIds: ReadonlySet<string>,
  ) {
    const recentMcpSince = DateTime.formatIso(
      DateTime.makeUnsafe(DateTime.toEpochMillis(yield* DateTime.now) - MCP_MONITOR_MAX_MS),
    );
    const activities = yield* activityRepository.listByThreadIdAndKinds({
      threadId: thread.id,
      kinds: [
        "session.recovered",
        "task.started",
        "task.completed",
        "task.updated",
        "user-input.requested",
        "user-input.resolved",
        "provider.user-input.respond.failed",
        "provider.user-input.delivery.started",
        "provider.user-input.delivery.finished",
        "provider.user-input.recovery.queued",
        "provider.user-input.recovery.not-sent",
      ],
      completedToolNames: ["ScheduleWakeup"],
      recentMcp: { since: recentMcpSince, summaries: MCP_RECOVERY_SUMMARIES },
    });
    const abandonedQuestions = thread.hasPendingUserInput
      ? yield* abandonOpenQuestions(thread.id, activities, priorIds)
      : 0;
    if (thread.hasPendingUserInput)
      yield* reportUncertainAsyncAnswers(thread.id, activities, priorIds, priorActivityIds);
    const settings = yield* policy.current;
    const { work: orphaned, prepared } = yield* prepareOrphanedWork(
      activities,
      settings.backgroundWatchRevokedAtMs?.[thread.id],
    );
    const hasWatch =
      orphaned.tasks.length > 0 ||
      orphaned.mcpMonitors.length > 0 ||
      orphaned.wakeupScheduledFor !== null;
    const recoverWatch = hasWatch && settings.backgroundWatchThreadIds.includes(thread.id);
    const activeTurnId = thread.session?.activeTurnId;
    const hadTurnInFlight =
      activeTurnId != null &&
      !(yield* recoveryDelivery.activeTurnIsWatchOnly(thread.id, activeTurnId));
    const waitingForTextQuestion = openUserInputRequestIds(activities).some((requestId) =>
      requestId.startsWith("text-question:"),
    );
    if (waitingForTextQuestion) return;

    if (
      !allowRecoveryTurn ||
      // A refused request is refused again when resent; never wake it automatically.
      isSafeguardBlock(thread.session?.lastError) ||
      (!hadTurnInFlight && !recoverWatch)
    ) {
      if (thread.session?.status !== "ready")
        yield* engine.dispatch({
          type: "thread.session.stop",
          commandId: CommandId.make(yield* randomUUID),
          threadId: thread.id,
          createdAt: yield* nowIso,
        });
      for (const activity of prepared)
        yield* engine.dispatch({
          type: "thread.activity.append",
          commandId: CommandId.make(yield* randomUUID),
          threadId: thread.id,
          activity,
          createdAt: activity.createdAt,
        });
      return;
    }

    const recentRecoveries = recentRecoveryTurnCount(
      yield* messageRepository.listByThreadId({ threadId: thread.id }),
      DateTime.toEpochMillis(yield* DateTime.now),
    );
    if (recentRecoveries >= RECOVERY_STORM_LIMIT) {
      yield* engine.dispatch({
        type: "thread.session.stop",
        commandId: CommandId.make(yield* randomUUID),
        threadId: thread.id,
        createdAt: yield* nowIso,
      });
      for (const activity of prepared)
        yield* engine.dispatch({
          type: "thread.activity.append",
          commandId: CommandId.make(yield* randomUUID),
          threadId: thread.id,
          activity,
          createdAt: activity.createdAt,
        });
      const createdAt = yield* nowIso;
      yield* engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make(yield* randomUUID),
        threadId: thread.id,
        activity: {
          id: EventId.make(yield* randomUUID),
          tone: "info",
          kind: "session.recovery-held",
          summary: recoveryHeldText(recentRecoveries),
          payload: {
            recentRecoveries,
            windowMs: RECOVERY_STORM_WINDOW_MS,
            limit: RECOVERY_STORM_LIMIT,
          },
          turnId: null,
          createdAt,
        },
        createdAt,
      });
      yield* Effect.logWarning("recovery turn held: the thread keeps dying to restarts", {
        threadId: thread.id,
        projectId: thread.projectId,
        recentRecoveries,
        windowMs: RECOVERY_STORM_WINDOW_MS,
      });
      return;
    }

    const commandId = CommandId.make(yield* randomUUID);
    const createdAt = yield* nowIso;
    const latestSettings = yield* policy.current;
    const stillWatching =
      recoverWatch &&
      latestSettings.backgroundWatchThreadIds.includes(thread.id) &&
      latestSettings.backgroundWatchRevokedAtMs?.[thread.id] ===
        settings.backgroundWatchRevokedAtMs?.[thread.id];
    if (!hadTurnInFlight && !stillWatching) return;
    const turn = {
      type: "thread.turn.start" as const,
      commandId,
      threadId: thread.id,
      message: {
        messageId: MessageId.make(yield* randomUUID),
        role: "user" as const,
        text: [
          hadTurnInFlight
            ? RECOVERY_TURN_TEXT
            : orphaned.tasks.length > 0 || orphaned.wakeupScheduledFor !== null
              ? RECOVERY_BACKGROUND_TEXT
              : RECOVERY_MCP_CHECK_TEXT,
          ...(abandonedQuestions > 0 ? [ABANDONED_QUESTION_TEXT] : []),
          ...(stillWatching ? [orphanedWorkText(orphaned)] : []),
        ].join(" "),
        attachments: [],
      },
      inputOrigin: "automation" as const,
      modelSelection: thread.modelSelection,
      runtimeMode: thread.runtimeMode,
      interactionMode: thread.interactionMode,
      createdAt,
    };
    if (thread.session !== null) {
      const latest = (yield* snapshotQuery.getShellSnapshot()).threads.find(
        (entry) => entry.id === thread.id,
      );
      if (
        !latest ||
        latest.archivedAt !== null ||
        latest.latestUserMessageAt !== thread.latestUserMessageAt ||
        latest.session?.status !== thread.session.status ||
        latest.session.updatedAt !== thread.session.updatedAt ||
        (latest.hasPendingUserInput && !thread.hasPendingUserInput)
      )
        return;
      yield* engine.dispatch({
        type: "thread.background-recovery.start",
        commandId,
        threadId: thread.id,
        expectedSessionStatus: thread.session.status,
        expectedSessionUpdatedAt: thread.session.updatedAt,
        expectedThreadUpdatedAt: latest.updatedAt,
        activities: prepared,
        turn,
        createdAt,
      });
    } else {
      yield* engine.dispatch({
        type: "thread.session.stop",
        commandId: CommandId.make(yield* randomUUID),
        threadId: thread.id,
        createdAt,
      });
      yield* engine.dispatch(turn);
    }
    yield* Effect.logInfo("recovered an interrupted turn after restart", {
      threadId: thread.id,
      projectId: thread.projectId,
      abandonedQuestions,
      interruptedBackgroundTasks: orphaned.tasks.length,
      lostWakeup: orphaned.wakeupScheduledFor !== null,
    });
  });

  const sweep = Effect.fn("SessionRecoveryReactor.sweep")(function* (
    threads: ReadonlyArray<OrchestrationThreadShell>,
    priorQuestions: ReadonlyMap<ThreadId, ReadonlySet<string>>,
    priorActivities: ReadonlyMap<ThreadId, ReadonlySet<string>>,
    priorApprovals: ReadonlyMap<ThreadId, ReadonlySet<string>>,
    priorOrchestraBlocks: ReadonlyMap<ThreadId, ReadonlyMap<MessageId, WorkspaceOrchestraBlock>>,
  ) {
    threads = threads.filter((thread) => !detachedRoom(thread.id));
    const protectedThreads = yield* recoveryDelivery.activeThreads();
    const stranded = threads.filter(
      (thread) =>
        !protectedThreads.has(thread.id) &&
        thread.session !== null &&
        isInterruptedSessionStatus(thread.session.status),
    );
    const otherQuestions = threads.filter(
      (thread) =>
        thread.hasPendingUserInput &&
        (thread.session === null || !isInterruptedSessionStatus(thread.session.status)),
    );
    const pendingApprovalThreads = threads.filter((thread) => thread.hasPendingApprovals);
    const readyThreads = threads.filter(
      (thread) =>
        !protectedThreads.has(thread.id) &&
        thread.session?.status === "ready" &&
        thread.archivedAt === null,
    );
    if (
      stranded.length === 0 &&
      otherQuestions.length === 0 &&
      pendingApprovalThreads.length === 0 &&
      priorOrchestraBlocks.size === 0 &&
      readyThreads.length === 0
    ) {
      return;
    }

    for (const thread of pendingApprovalThreads) {
      yield* abandonOpenApprovals(thread.id, priorApprovals.get(thread.id) ?? new Set()).pipe(
        Effect.tap((closedCount) =>
          closedCount > 0
            ? Effect.logInfo("closed stale pending approvals from the previous server", {
                threadId: thread.id,
                closedCount,
              })
            : Effect.void,
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning("failed to close pending approvals from the previous server", {
            threadId: thread.id,
            cause: Cause.pretty(cause),
          }),
        ),
      );
    }

    for (const thread of otherQuestions) {
      yield* Effect.gen(function* () {
        const activities = yield* activityRepository.listByThreadIdAndKinds({
          threadId: thread.id,
          kinds: [
            "user-input.requested",
            "user-input.resolved",
            "provider.user-input.respond.failed",
            "provider.user-input.delivery.started",
            "provider.user-input.delivery.finished",
            "provider.user-input.recovery.queued",
            "provider.user-input.recovery.not-sent",
          ],
        });
        yield* abandonOpenQuestions(
          thread.id,
          activities,
          priorQuestions.get(thread.id) ?? new Set(),
        );
        yield* reportUncertainAsyncAnswers(
          thread.id,
          activities,
          priorQuestions.get(thread.id) ?? new Set(),
          priorActivities.get(thread.id) ?? new Set(),
        );
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("failed to close a question from the previous server", {
            threadId: thread.id,
            cause: Cause.pretty(cause),
          }),
        ),
      );
    }
    if (stranded.length === 0 && readyThreads.length === 0 && priorOrchestraBlocks.size === 0)
      return;

    // Threads a resumable collaboration run holds get settled only — the
    // collaboration reactor restarts that work itself. That includes the
    // running graph-attempt and legacy-step threads, not just the shared
    // meeting thread: a recovery turn injected into one of those would be
    // read back by the collaboration reactor as the node's own output.
    // Settled attempts' threads stay eligible for recovery — the reactor
    // never re-drives those, so a person's own interrupted turn there still
    // deserves its restart.
    const resumableRuns = yield* runRepository.listResumable();
    const resumableRunIds = new Set<string>(resumableRuns.map((run) => run.id));
    const runOwnedThreadIds = new Set(
      resumableRuns.flatMap((run) => [
        ...(run.meeting?.threadId ? [run.meeting.threadId] : []),
        ...(run.graph?.nodes ?? []).flatMap((node) => [
          ...node.attempts
            .filter((attempt) => attempt.status === "running")
            .map((attempt) => attempt.threadId),
          // An orchestra node's fixed conversation, while the node is live.
          ...(node.status === "running" && node.threadId !== null ? [node.threadId] : []),
        ]),
        ...(run.steps ?? []).flatMap((step) =>
          step.threadId !== null && step.status === "running" ? [step.threadId] : [],
        ),
      ]),
    );

    for (const [threadId, capturedBlocks] of priorOrchestraBlocks) {
      if (detachedRoom(threadId)) continue;
      yield* cancelOrphanedOrchestraBlocks(threadId, capturedBlocks, resumableRunIds).pipe(
        Effect.tap((cancelledCount) =>
          cancelledCount > 0
            ? Effect.logInfo("cancelled orphaned orchestra blocks from the previous server", {
                threadId,
                cancelledCount,
              })
            : Effect.void,
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning("failed to settle orphaned orchestra blocks from the previous server", {
            threadId,
            cause: Cause.pretty(cause),
          }),
        ),
      );
    }

    if (stranded.length > 0) {
      yield* Effect.logInfo("settling sessions stranded by the previous server process", {
        threads: stranded.length,
      });
    }
    for (const thread of stranded) {
      yield* recoverThread(
        thread,
        !runOwnedThreadIds.has(thread.id),
        priorQuestions.get(thread.id) ?? new Set(),
        priorActivities.get(thread.id) ?? new Set(),
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("failed to recover a stranded thread", {
            threadId: thread.id,
            cause: Cause.pretty(cause),
          }),
        ),
      );
    }
    // A provider may have returned "ready" while leaving a background monitor
    // alive. Such a monitor belongs to the old process even though no turn was
    // in flight. Do not revive stopped/archived sessions or run-owned threads.
    for (const thread of readyThreads) {
      if (runOwnedThreadIds.has(thread.id) || thread.hasPendingUserInput) continue;
      yield* Effect.gen(function* () {
        const activities = yield* activityRepository.listByThreadIdAndKinds({
          threadId: thread.id,
          kinds: ["session.recovered", "task.started", "task.completed", "task.updated"],
          completedToolNames: ["ScheduleWakeup"],
          recentMcp: {
            since: DateTime.formatIso(
              DateTime.makeUnsafe(DateTime.toEpochMillis(yield* DateTime.now) - MCP_MONITOR_MAX_MS),
            ),
            summaries: MCP_RECOVERY_SUMMARIES,
          },
        });
        const work = orphanedBackgroundWork(
          activities,
          DateTime.toEpochMillis(yield* DateTime.now),
        );
        if (
          work.tasks.length === 0 &&
          work.otherTasks.length === 0 &&
          work.mcpMonitors.length === 0 &&
          work.wakeupScheduledFor === null
        )
          return;
        const latest = (yield* snapshotQuery.getShellSnapshot()).threads.find(
          (entry) => entry.id === thread.id,
        );
        if (
          latest?.session?.status !== "ready" ||
          latest.session.updatedAt !== thread.session?.updatedAt ||
          latest.hasPendingUserInput
        )
          return;
        yield* recoverThread(
          thread,
          true,
          priorQuestions.get(thread.id) ?? new Set(),
          priorActivities.get(thread.id) ?? new Set(),
        );
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("failed to recover background work from a ready session", {
            threadId: thread.id,
            cause: Cause.pretty(cause),
          }),
        ),
      );
    }
  });

  const start: SessionRecoveryReactorShape["start"] = Effect.fn("start")(function* () {
    // Capture exact request IDs before activation; provider session sequence
    // numbers are not global and cannot identify the startup boundary.
    const captured = yield* Effect.gen(function* () {
      const snapshot = yield* snapshotQuery.getShellSnapshot();
      const questions = new Map<ThreadId, ReadonlySet<string>>();
      const priorActivities = new Map<ThreadId, ReadonlySet<string>>();
      const approvals = new Map<ThreadId, ReadonlySet<string>>();
      for (const thread of snapshot.threads) {
        if (thread.hasPendingUserInput) {
          const activities = yield* activityRepository
            .listByThreadIdAndKinds({
              threadId: thread.id,
              kinds: [
                "user-input.requested",
                "user-input.resolved",
                "provider.user-input.respond.failed",
                "provider.user-input.delivery.started",
                "provider.user-input.delivery.finished",
                "provider.user-input.recovery.queued",
                "provider.user-input.recovery.not-sent",
              ],
            })
            .pipe(
              Effect.catch((error) =>
                Effect.logWarning("failed to capture a question from the previous server", {
                  threadId: thread.id,
                  error: error.message,
                }).pipe(Effect.as([] as ReadonlyArray<ProjectionThreadActivity>)),
              ),
            );
          questions.set(thread.id, new Set(openUserInputRequestIds(activities)));
          priorActivities.set(
            thread.id,
            new Set(activities.map((activity) => activity.activityId)),
          );
        }
        if (thread.hasPendingApprovals) {
          const activities = yield* activityRepository
            .listByThreadIdAndKinds({
              threadId: thread.id,
              kinds: APPROVAL_LIFECYCLE_ACTIVITY_KINDS,
            })
            .pipe(
              Effect.catch((error) =>
                Effect.logWarning("failed to capture pending approvals from the previous server", {
                  threadId: thread.id,
                  error: error.message,
                }).pipe(Effect.as([] as ReadonlyArray<ProjectionThreadActivity>)),
              ),
            );
          const sqlPending = yield* listPendingApprovalIdsFromSql(thread.id);
          approvals.set(thread.id, new Set([...openApprovalRequestIds(activities), ...sqlPending]));
        }
      }
      const orchestraBlocks = yield* captureRunningOrchestraBlocks();
      return {
        threads: snapshot.threads,
        questions,
        priorActivities,
        approvals,
        orchestraBlocks,
      };
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("failed to capture questions from the previous server", {
          error: error.message,
        }).pipe(
          Effect.as({
            threads: [] as ReadonlyArray<OrchestrationThreadShell>,
            questions: new Map<ThreadId, ReadonlySet<string>>(),
            priorActivities: new Map<ThreadId, ReadonlySet<string>>(),
            approvals: new Map<ThreadId, ReadonlySet<string>>(),
            orchestraBlocks: new Map<ThreadId, ReadonlyMap<MessageId, WorkspaceOrchestraBlock>>(),
          }),
        ),
      ),
    );
    yield* forkParked(
      sweep(
        captured.threads,
        captured.questions,
        captured.priorActivities,
        captured.approvals,
        captured.orchestraBlocks,
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("session recovery sweep failed", { cause: Cause.pretty(cause) }),
        ),
        Effect.ensuring(Deferred.succeed(done, undefined)),
      ),
    );
  });

  return {
    start,
    drain: Deferred.await(done),
  } satisfies SessionRecoveryReactorShape;
});

export const SessionRecoveryReactorLive = Layer.effect(
  SessionRecoveryReactor,
  makeSessionRecoveryReactor,
);
