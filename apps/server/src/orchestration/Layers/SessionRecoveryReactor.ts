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
  type OrchestrationThreadShell,
  type ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { forkParked } from "../../serverActivation.ts";
import {
  ProjectionThreadActivityRepository,
  type ProjectionThreadActivity,
} from "../../persistence/Services/ProjectionThreadActivities.ts";
import { ProjectionWorkspaceCollaborationRunRepository } from "../../persistence/Services/ProjectionWorkspaceCollaborationRuns.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  SessionRecoveryReactor,
  type SessionRecoveryReactorShape,
} from "../Services/SessionRecoveryReactor.ts";

const RECOVERY_TURN_TEXT = [
  "[자동 복구] 서버가 재시작되면서 직전 턴이 중단되었습니다.",
  "중단 전까지의 대화와 작업 상태를 직접 확인한 뒤, 끝나지 않은 작업이 있으면 이어서 완료해 주세요.",
  "이미 완료된 작업은 반복하지 말고, 확인 결과와 이어서 한 작업을 정리해 보고해 주세요.",
].join(" ");

const ABANDONED_QUESTION_TEXT =
  "중단 직전에 사용자에게 던진 질문은 답을 받지 못한 채 사라졌습니다. 아직 답이 필요하면 같은 질문을 다시 해 주세요.";

const ABANDONED_QUESTION_SUMMARY =
  "서버가 재시작되어 이 질문은 사라졌습니다. 답이 필요하면 다시 묻습니다.";

/** Background work the dead session was running, read back from the activity log. */
export interface OrphanedBackgroundWork {
  readonly tasks: ReadonlyArray<{ readonly taskId: string; readonly title: string | null }>;
  /** ISO time the seat had scheduled itself to wake, if that was still ahead. */
  readonly wakeupScheduledFor: string | null;
}

const TERMINAL_TASK_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "stopped",
  "cancelled",
  "interrupted",
]);

function payloadOf(activity: ProjectionThreadActivity): Record<string, unknown> | null {
  return typeof activity.payload === "object" && activity.payload !== null
    ? (activity.payload as Record<string, unknown>)
    : null;
}

/**
 * Monitor loops / background shells still open at the end of the log, and a
 * self-wakeup scheduled for after `nowMs`. Ordered by the same rule as the
 * question scan so both read the log the same way.
 */
export function orphanedBackgroundWork(
  activities: ReadonlyArray<ProjectionThreadActivity>,
  nowMs: number,
): OrphanedBackgroundWork {
  const ordered = [...activities].toSorted(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) ||
      left.activityId.localeCompare(right.activityId),
  );
  const open = new Map<string, { readonly taskId: string; readonly title: string | null }>();
  let wakeupScheduledFor: string | null = null;
  for (const activity of ordered) {
    const payload = payloadOf(activity);
    if (payload === null) continue;
    if (activity.kind === "session.recovered") {
      // Everything before an earlier recovery marker was already settled.
      open.clear();
      wakeupScheduledFor = null;
      continue;
    }
    const taskId = typeof payload.taskId === "string" ? payload.taskId : null;
    if (taskId !== null) {
      if (activity.kind === "task.started" && payload.agentKind === "background") {
        open.set(taskId, {
          taskId,
          title: typeof payload.title === "string" ? payload.title : null,
        });
      } else if (
        (activity.kind === "task.completed" &&
          typeof payload.status === "string" &&
          TERMINAL_TASK_STATUSES.has(payload.status)) ||
        (activity.kind === "task.updated" && typeof payload.endedAt === "string")
      ) {
        open.delete(taskId);
      }
      continue;
    }
    if (activity.kind === "tool.completed") {
      const data = payloadOf({ ...activity, payload: payload.data });
      if (data?.toolName !== "ScheduleWakeup") continue;
      const input =
        typeof data.input === "object" && data.input !== null
          ? (data.input as Record<string, unknown>)
          : null;
      if (input?.stop === true) {
        wakeupScheduledFor = null;
        continue;
      }
      const delaySeconds = typeof input?.delaySeconds === "number" ? input.delaySeconds : null;
      if (delaySeconds === null) continue;
      const at =
        Date.parse(activity.createdAt) + Math.min(3_600, Math.max(60, delaySeconds)) * 1_000;
      wakeupScheduledFor = at > nowMs ? DateTime.formatIso(DateTime.makeUnsafe(at)) : null;
    }
  }
  return { tasks: [...open.values()], wakeupScheduledFor };
}

function orphanedWorkText(work: OrphanedBackgroundWork): string {
  const parts: string[] = [];
  if (work.tasks.length > 0) {
    const names = work.tasks
      .map((task) => task.title)
      .filter((title): title is string => title !== null)
      .slice(0, 4)
      .join(", ");
    parts.push(
      `백그라운드 감시 ${work.tasks.length}개(${names || "제목 없음"})는 서버와 함께 종료되어 더 이상 돌지 않습니다. 아직 필요하면 같은 감시를 다시 띄우세요.`,
    );
  }
  if (work.wakeupScheduledFor !== null) {
    parts.push(
      "예약해 둔 자동 깨어남(ScheduleWakeup)도 사라졌습니다. 계속 주기적으로 확인해야 하면 다시 예약하세요.",
    );
  }
  return parts.join(" ");
}

const isInterruptedSessionStatus = (status: string): boolean =>
  status === "starting" || status === "running";

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

export const makeSessionRecoveryReactor = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const snapshotQuery = yield* ProjectionSnapshotQuery;
  const runRepository = yield* ProjectionWorkspaceCollaborationRunRepository;
  const activityRepository = yield* ProjectionThreadActivityRepository;
  const crypto = yield* Crypto.Crypto;
  const randomUUID = crypto.randomUUIDv4;
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const done = yield* Deferred.make<void>();

  /** Close every question the dead session left open; returns how many there were. */
  const abandonOpenQuestions = Effect.fn("SessionRecoveryReactor.abandonOpenQuestions")(function* (
    threadId: ThreadId,
    activities: ReadonlyArray<ProjectionThreadActivity>,
  ) {
    const open = openUserInputRequestIds(activities);
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

  /**
   * Settle background work the dead session took with it: one interrupted
   * `task.completed` per open task (keeps the timeline's task state honest)
   * and a `session.recovered` marker the clients use as the cut-off for
   * "still watching" / "next wake" displays.
   */
  const settleOrphanedWork = Effect.fn("SessionRecoveryReactor.settleOrphanedWork")(function* (
    threadId: ThreadId,
    activities: ReadonlyArray<ProjectionThreadActivity>,
  ) {
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    const work = orphanedBackgroundWork(activities, nowMs);
    if (work.tasks.length === 0 && work.wakeupScheduledFor === null) return work;
    for (const task of work.tasks) {
      const createdAt = yield* nowIso;
      yield* engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make(yield* randomUUID),
        threadId,
        activity: {
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
        },
        createdAt,
      });
    }
    const createdAt = yield* nowIso;
    yield* engine.dispatch({
      type: "thread.activity.append",
      commandId: CommandId.make(yield* randomUUID),
      threadId,
      activity: {
        id: EventId.make(yield* randomUUID),
        tone: "info",
        kind: "session.recovered",
        summary:
          work.tasks.length > 0
            ? `서버 재시작으로 백그라운드 감시 ${work.tasks.length}개가 끊겼습니다${work.wakeupScheduledFor === null ? "" : " (예약된 자동 깨어남 포함)"}`
            : "서버 재시작으로 예약된 자동 깨어남이 사라졌습니다",
        payload: {
          interruptedTasks: work.tasks,
          wakeupScheduledFor: work.wakeupScheduledFor,
        },
        turnId: null,
        createdAt,
      },
      createdAt,
    });
    return work;
  });

  const recoverThread = Effect.fn("SessionRecoveryReactor.recoverThread")(function* (
    thread: OrchestrationThreadShell,
    startRecoveryTurn: boolean,
  ) {
    // Settle the phantom session first; the provider process behind it died
    // with the previous server. Domain commands process in order, so the
    // recovery turn below always sees the released binding.
    yield* engine.dispatch({
      type: "thread.session.stop",
      commandId: CommandId.make(yield* randomUUID),
      threadId: thread.id,
      createdAt: yield* nowIso,
    });
    const activities = yield* activityRepository.listByThreadId({ threadId: thread.id });
    const abandonedQuestions = thread.hasPendingUserInput
      ? yield* abandonOpenQuestions(thread.id, activities)
      : 0;
    const orphaned = yield* settleOrphanedWork(thread.id, activities);
    if (!startRecoveryTurn) return;

    yield* engine.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make(yield* randomUUID),
      threadId: thread.id,
      message: {
        messageId: MessageId.make(yield* randomUUID),
        role: "user",
        text: [
          RECOVERY_TURN_TEXT,
          ...(abandonedQuestions > 0 ? [ABANDONED_QUESTION_TEXT] : []),
          ...(orphaned.tasks.length > 0 || orphaned.wakeupScheduledFor !== null
            ? [orphanedWorkText(orphaned)]
            : []),
        ].join(" "),
        attachments: [],
      },
      inputOrigin: "automation",
      modelSelection: thread.modelSelection,
      runtimeMode: thread.runtimeMode,
      interactionMode: thread.interactionMode,
      createdAt: yield* nowIso,
    });
    yield* Effect.logInfo("recovered an interrupted turn after restart", {
      threadId: thread.id,
      projectId: thread.projectId,
      abandonedQuestions,
      interruptedBackgroundTasks: orphaned.tasks.length,
      lostWakeup: orphaned.wakeupScheduledFor !== null,
    });
  });

  const sweep = Effect.gen(function* () {
    const snapshot = yield* snapshotQuery.getShellSnapshot();
    const stranded = snapshot.threads.filter(
      (thread) => thread.session !== null && isInterruptedSessionStatus(thread.session.status),
    );
    if (stranded.length === 0) return;

    // Threads a resumable collaboration run holds get settled only — the
    // collaboration reactor restarts that work itself.
    const resumableRuns = yield* runRepository.listResumable();
    const runOwnedThreadIds = new Set(
      resumableRuns.flatMap((run) => (run.meeting?.threadId ? [run.meeting.threadId] : [])),
    );

    yield* Effect.logInfo("settling sessions stranded by the previous server process", {
      threads: stranded.length,
    });
    for (const thread of stranded) {
      const hadTurnInFlight = thread.session?.activeTurnId != null;
      yield* recoverThread(thread, hadTurnInFlight && !runOwnedThreadIds.has(thread.id)).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("failed to recover a stranded thread", {
            threadId: thread.id,
            cause: Cause.pretty(cause),
          }),
        ),
      );
    }
  });

  const start: SessionRecoveryReactorShape["start"] = Effect.fn("start")(function* () {
    yield* forkParked(
      sweep.pipe(
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
