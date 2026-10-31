import { WorkspaceTaskInbox } from "../WorkspaceTaskInbox.ts";
import {
  CommandId,
  WorkspaceTaskInboxError,
  WorkspaceCollaborationRunId,
  type OrchestrationEvent,
  type ProjectId,
  type WorkspaceSchedule,
  type WorkspaceScheduleId,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { ProjectionWorkspaceCollaborationRunRepository } from "../../persistence/Services/ProjectionWorkspaceCollaborationRuns.ts";
import { ProjectionWorkspaceScheduleRepository } from "../../persistence/Services/ProjectionWorkspaceSchedules.ts";
import { forkParked } from "../../serverActivation.ts";
import { resolveWorkspaceScheduleNextTrigger } from "../workspaceSchedule.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  WorkspaceSchedulerReactor,
  type WorkspaceSchedulerReactorShape,
} from "../Services/WorkspaceSchedulerReactor.ts";

type ScheduleRef = {
  readonly projectId: ProjectId;
  readonly scheduleId: WorkspaceScheduleId;
};

const TICK_INTERVAL = Duration.seconds(1);
const FAILURE_BACKOFF_MS = 60_000;

function conciseCause(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause);
  return (error instanceof Error ? error.message : String(error)).slice(0, 4_000);
}

function scheduledRunId(schedule: WorkspaceSchedule, triggerAt: string) {
  return WorkspaceCollaborationRunId.make(`sr-${schedule.id}-${Date.parse(triggerAt)}`);
}

export const makeWorkspaceSchedulerReactor = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const taskInbox = yield* Effect.serviceOption(WorkspaceTaskInbox);
  const scheduleRepository = yield* ProjectionWorkspaceScheduleRepository;
  const runRepository = yield* ProjectionWorkspaceCollaborationRunRepository;
  const crypto = yield* Crypto.Crypto;
  const randomUUID = crypto.randomUUIDv4;
  const schedulerMutex = yield* Semaphore.make(1);
  const failureBackoffUntil = new Map<string, number>();
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const scheduleKey = (projectId: ProjectId, scheduleId: WorkspaceScheduleId) =>
    `${projectId}:${scheduleId}`;

  const updateRuntime = Effect.fn("WorkspaceSchedulerReactor.updateRuntime")(function* (input: {
    readonly schedule: WorkspaceSchedule;
    readonly nextTriggerAt: string | null;
    readonly lastTriggeredAt: string | null;
    readonly lastRunId: WorkspaceCollaborationRunId | null;
    readonly lastError: string | null;
    readonly commandId?: CommandId;
    readonly updatedAt: string;
  }) {
    yield* orchestrationEngine.dispatch({
      type: "project.schedule.runtime.update",
      commandId: input.commandId ?? CommandId.make(yield* randomUUID),
      scheduleId: input.schedule.id,
      projectId: input.schedule.projectId,
      nextTriggerAt: input.nextTriggerAt,
      lastTriggeredAt: input.lastTriggeredAt,
      lastRunId: input.lastRunId,
      lastError: input.lastError,
      updatedAt: input.updatedAt,
    });
  });

  const reconcile = Effect.fn("WorkspaceSchedulerReactor.reconcile")(function* (
    scheduleRef: ScheduleRef,
  ) {
    const current = yield* scheduleRepository.getById(scheduleRef);
    if (Option.isNone(current)) return;
    const schedule = current.value;
    if (!schedule.enabled) return;
    const now = yield* nowIso;
    const predecessor =
      schedule.timing.kind === "after-run"
        ? Option.getOrNull(
            yield* runRepository.getById({
              projectId: schedule.projectId,
              runId: schedule.timing.runId,
            }),
          )
        : null;
    if (
      schedule.lastTriggeredAt === null &&
      schedule.timing.kind === "after-run" &&
      schedule.timing.onFailure === "cancel" &&
      (predecessor?.status === "failed" || predecessor?.status === "cancelled")
    ) {
      yield* orchestrationEngine.dispatch({
        type: "project.schedule.upsert",
        commandId: CommandId.make(yield* randomUUID),
        scheduleId: schedule.id,
        projectId: schedule.projectId,
        title: schedule.title,
        task: schedule.task,
        timing: schedule.timing,
        enabled: false,
        createdAt: now,
      });
      yield* updateRuntime({
        schedule,
        nextTriggerAt: null,
        lastTriggeredAt: null,
        lastRunId: schedule.lastRunId,
        lastError: `Follow-up cancelled because the preceding run ${predecessor.status}.`,
        updatedAt: now,
      });
      return;
    }
    const resolution = resolveWorkspaceScheduleNextTrigger({
      timing: schedule.timing,
      now,
      lastTriggeredAt: schedule.lastTriggeredAt,
      predecessor,
    });
    yield* updateRuntime({
      schedule,
      nextTriggerAt: resolution.nextTriggerAt,
      lastTriggeredAt: schedule.lastTriggeredAt,
      lastRunId: schedule.lastRunId,
      lastError: resolution.error,
      updatedAt: now,
    });
  });

  const reconcileSafely = (scheduleRef: ScheduleRef) =>
    schedulerMutex.withPermit(reconcile(scheduleRef)).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
        return Effect.logWarning("Workspace schedule reconciliation failed", {
          projectId: scheduleRef.projectId,
          scheduleId: scheduleRef.scheduleId,
          cause: conciseCause(cause),
        });
      }),
    );
  const reconciliationWorker = yield* makeDrainableWorker(reconcileSafely);

  const advanceAfterTrigger = Effect.fn("WorkspaceSchedulerReactor.advanceAfterTrigger")(
    function* (input: {
      readonly schedule: WorkspaceSchedule;
      readonly triggerAt: string;
      readonly runId: WorkspaceCollaborationRunId | null;
      readonly now: string;
    }) {
      const resolution = resolveWorkspaceScheduleNextTrigger({
        timing: input.schedule.timing,
        now: input.now,
        lastTriggeredAt: input.triggerAt,
      });
      yield* updateRuntime({
        schedule: input.schedule,
        nextTriggerAt: resolution.nextTriggerAt,
        lastTriggeredAt: input.triggerAt,
        lastRunId: input.runId,
        lastError: resolution.error,
        commandId: CommandId.make(
          `scheduler-advance-${scheduledRunId(input.schedule, input.triggerAt)}`,
        ),
        updatedAt: input.now,
      });
      failureBackoffUntil.delete(scheduleKey(input.schedule.projectId, input.schedule.id));
    },
  );

  const skipOverlappingOccurrence = Effect.fn(
    "WorkspaceSchedulerReactor.skipOverlappingOccurrence",
  )(function* (input: {
    readonly schedule: WorkspaceSchedule;
    readonly activeRunId: WorkspaceCollaborationRunId;
    readonly now: string;
  }) {
    const resolution = resolveWorkspaceScheduleNextTrigger({
      timing: input.schedule.timing,
      now: input.now,
      lastTriggeredAt: input.schedule.lastTriggeredAt,
    });
    yield* updateRuntime({
      schedule: input.schedule,
      nextTriggerAt: resolution.nextTriggerAt,
      lastTriggeredAt: input.schedule.lastTriggeredAt,
      lastRunId: input.schedule.lastRunId,
      lastError: `Occurrence skipped because scheduled run '${input.activeRunId}' is still active.`,
      updatedAt: input.now,
    });
  });

  const triggerSchedule = Effect.fn("WorkspaceSchedulerReactor.triggerSchedule")(function* (
    candidate: WorkspaceSchedule,
    now: string,
  ) {
    const key = scheduleKey(candidate.projectId, candidate.id);
    const backoffUntil = failureBackoffUntil.get(key);
    if (backoffUntil !== undefined && Date.parse(now) < backoffUntil) return;

    const current = yield* scheduleRepository.getById({
      projectId: candidate.projectId,
      scheduleId: candidate.id,
    });
    if (Option.isNone(current)) return;
    const schedule = current.value;
    const triggerAt = schedule.nextTriggerAt;
    if (!schedule.enabled || triggerAt === null || triggerAt > now) return;
    // A completion may have been invalidated/cancelled since reconciliation.
    if (schedule.timing.kind === "after-run") {
      const predecessor = Option.getOrNull(
        yield* runRepository.getById({
          projectId: schedule.projectId,
          runId: schedule.timing.runId,
        }),
      );
      const resolution = resolveWorkspaceScheduleNextTrigger({
        timing: schedule.timing,
        now,
        lastTriggeredAt: schedule.lastTriggeredAt,
        predecessor,
      });
      if (resolution.nextTriggerAt !== triggerAt) {
        yield* reconcile({ projectId: schedule.projectId, scheduleId: schedule.id });
        return;
      }
    }
    const runId = scheduledRunId(schedule, triggerAt);

    const expectedRun = yield* runRepository.getById({
      projectId: schedule.projectId,
      runId,
    });
    if (Option.isSome(expectedRun)) {
      yield* advanceAfterTrigger({ schedule, triggerAt, runId, now });
      return;
    }

    const activeRuns = yield* runRepository.list({
      projectId: schedule.projectId,
      statuses: ["queued", "running", "cancel-requested"],
    });
    const activeForSchedule = activeRuns.find(
      (run) => run.source === "schedule" && run.scheduleId === schedule.id,
    );
    if (activeForSchedule !== undefined) {
      yield* skipOverlappingOccurrence({
        schedule,
        activeRunId: activeForSchedule.id,
        now,
      });
      return;
    }

    if (schedule.timing.taskRecipe) {
      if (Option.isNone(taskInbox))
        return yield* new WorkspaceTaskInboxError({
          message: "자동 업무 접수 서비스를 사용할 수 없습니다.",
        });
      const source = `schedule:${schedule.id}`;
      if (yield* taskInbox.value.hasPendingSource(schedule.projectId, source, triggerAt)) {
        const resolution = resolveWorkspaceScheduleNextTrigger({
          timing: schedule.timing,
          now,
          lastTriggeredAt: triggerAt,
        });
        yield* updateRuntime({
          schedule,
          nextTriggerAt: resolution.nextTriggerAt,
          lastTriggeredAt: triggerAt,
          lastRunId: schedule.lastRunId,
          lastError:
            "Previous recipe task is still active or needs reconciliation; this occurrence was skipped.",
          updatedAt: now,
        });
        return;
      }
      const task = yield* taskInbox.value.submit({
        projectId: schedule.projectId,
        source,
        externalId: triggerAt,
        recipeId: schedule.timing.taskRecipe.recipeId,
        recipeRevision: schedule.timing.taskRecipe.revision,
        inputs: schedule.timing.taskRecipe.inputs,
      });
      yield* advanceAfterTrigger({ schedule, triggerAt, runId: task.runId, now });
      return;
    }
    yield* orchestrationEngine.dispatch({
      type: "project.collaboration.run.schedule",
      commandId: CommandId.make(`scheduler-trigger-${runId}`),
      runId,
      scheduleId: schedule.id,
      projectId: schedule.projectId,
      task: schedule.task,
      ...(schedule.timing.executionProfile
        ? { executionProfile: schedule.timing.executionProfile }
        : {}),
      createdAt: triggerAt,
    });
    yield* advanceAfterTrigger({ schedule, triggerAt, runId, now });
  });

  const tickUnlocked = Effect.fn("WorkspaceSchedulerReactor.tick")(function* () {
    const now = yield* nowIso;
    const due = yield* scheduleRepository.listDue(now);
    yield* Effect.forEach(due, (schedule) =>
      triggerSchedule(schedule, now).pipe(
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
          const error = conciseCause(cause);
          failureBackoffUntil.set(
            scheduleKey(schedule.projectId, schedule.id),
            Date.parse(now) + FAILURE_BACKOFF_MS,
          );
          return updateRuntime({
            schedule,
            nextTriggerAt: schedule.nextTriggerAt,
            lastTriggeredAt: schedule.lastTriggeredAt,
            lastRunId: schedule.lastRunId,
            lastError: error,
            updatedAt: now,
          }).pipe(
            Effect.catchCause((updateCause) =>
              Effect.logError("Workspace schedule trigger failed", {
                projectId: schedule.projectId,
                scheduleId: schedule.id,
                error,
                updateError: conciseCause(updateCause),
              }),
            ),
          );
        }),
      ),
    );
  });
  const tick = schedulerMutex.withPermit(tickUnlocked()).pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : Effect.logWarning("Workspace scheduler tick failed", {
            cause: conciseCause(cause),
          }),
    ),
  );

  const enqueueEvent = Effect.fn("WorkspaceSchedulerReactor.enqueueEvent")(function* (
    event: OrchestrationEvent,
  ) {
    if (event.type === "project.schedule-upserted") {
      yield* reconciliationWorker.enqueue({
        projectId: event.payload.projectId,
        scheduleId: event.payload.scheduleId,
      });
    } else if (event.type === "project.collaboration-run-upserted") {
      const run = event.payload.run;
      const schedules = yield* scheduleRepository.listByProjectId(run.projectId);
      for (const schedule of schedules) {
        if (
          schedule.enabled &&
          schedule.lastTriggeredAt === null &&
          schedule.timing.kind === "after-run" &&
          schedule.timing.runId === run.id
        ) {
          yield* reconciliationWorker.enqueue({
            projectId: run.projectId,
            scheduleId: schedule.id,
          });
        }
      }
    }
  });

  const enqueueStartupReconciliation = scheduleRepository.listPendingReconciliation().pipe(
    Effect.flatMap((schedules) =>
      Effect.forEach(
        schedules,
        (schedule) =>
          reconciliationWorker.enqueue({
            projectId: schedule.projectId,
            scheduleId: schedule.id,
          }),
        { concurrency: 1, discard: true },
      ),
    ),
    Effect.catchCause((cause) =>
      Effect.logWarning("Workspace schedule startup reconciliation failed", {
        cause: conciseCause(cause),
      }),
    ),
  );

  const start: WorkspaceSchedulerReactorShape["start"] = Effect.fn("start")(function* () {
    yield* forkParked(Stream.runForEach(orchestrationEngine.streamDomainEvents, enqueueEvent), {
      startImmediately: true,
    });
    yield* enqueueStartupReconciliation;
    yield* reconciliationWorker.drain;
    yield* forkParked(Effect.forever(tick.pipe(Effect.andThen(Effect.sleep(TICK_INTERVAL)))));
  });

  const drain = reconciliationWorker.drain.pipe(
    Effect.andThen(schedulerMutex.withPermit(Effect.void)),
  );
  return { start, tick, drain } satisfies WorkspaceSchedulerReactorShape;
});

export const WorkspaceSchedulerReactorLive = Layer.effect(
  WorkspaceSchedulerReactor,
  makeWorkspaceSchedulerReactor,
);
