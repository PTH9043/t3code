import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ProjectId,
  EventId,
  WorkspaceCollaborationRunId,
  WorkspaceScheduleId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type WorkspaceScheduleTiming,
  type WorkspaceCollaborationRun,
  type WorkspaceSchedule,
  type WorkspaceInboxTask,
  type WorkspaceTaskSubmit,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { expect, it } from "@effect/vitest";

import { ProjectionWorkspaceCollaborationRunRepository } from "../../persistence/Services/ProjectionWorkspaceCollaborationRuns.ts";
import { ProjectionWorkspaceScheduleRepository } from "../../persistence/Services/ProjectionWorkspaceSchedules.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import { WorkspaceSchedulerReactor } from "../Services/WorkspaceSchedulerReactor.ts";
import { WorkspaceSchedulerReactorLive } from "./WorkspaceSchedulerReactor.ts";
import { WorkspaceTaskInbox } from "../WorkspaceTaskInbox.ts";

const exerciseScheduler = (
  input: {
    timing?: WorkspaceScheduleTiming;
    predecessor?: WorkspaceCollaborationRun;
    completeLater?: boolean;
    crashBeforeAdvance?: boolean;
    recipeInbox?: boolean;
    recipeBusy?: boolean;
  } = {},
) =>
  Effect.gen(function* () {
    const projectId = ProjectId.make("workspace-a");
    const scheduleId = WorkspaceScheduleId.make("schedule-a");
    const initialSchedule: WorkspaceSchedule = {
      id: scheduleId,
      projectId,
      title: "One-time unattended task",
      task: "Verify the Workspace",
      enabled: true,
      timing: input.timing ?? { kind: "once", runAt: "2020-01-01T00:00:00.000Z" },
      nextTriggerAt: input.timing?.kind === "after-run" ? null : "2020-01-01T00:00:00.000Z",
      lastTriggeredAt: null,
      lastRunId: null,
      lastError: null,
      createdAt: "2020-01-01T00:00:00.000Z",
      updatedAt: "2020-01-01T00:00:00.000Z",
    };
    const scheduleRef = yield* Ref.make(initialSchedule);
    const runsRef = yield* Ref.make(
      new Map<string, WorkspaceCollaborationRun>(
        input.predecessor ? [[input.predecessor.id, input.predecessor]] : [],
      ),
    );
    const commands = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
    const events = yield* Queue.unbounded<OrchestrationEvent>();
    const receipts = yield* Queue.unbounded<void>();
    const inboxTasks = new Map<string, WorkspaceInboxTask>();
    const inboxRequests: WorkspaceTaskSubmit[] = [];
    let sequence = 0;

    const dispatch: OrchestrationEngineShape["dispatch"] = (command: OrchestrationCommand) =>
      Effect.gen(function* () {
        sequence += 1;
        yield* Ref.update(commands, (current) => [...current, command]);
        if (command.type === "project.collaboration.run.schedule") {
          yield* Ref.update(runsRef, (current) => {
            const next = new Map(current);
            next.set(command.runId, {
              id: command.runId,
              projectId: command.projectId,
              source: "schedule",
              scheduleId: command.scheduleId,
              incidentId: null,
              task: command.task,
              status: "queued",
              steps: [],
              graph: null,
              meeting: null,
              orchestra: null,
              finalOutput: null,
              error: null,
              createdAt: command.createdAt,
              updatedAt: command.createdAt,
            });
            return next;
          });
        }
        if (command.type === "project.schedule.runtime.update") {
          yield* Ref.update(scheduleRef, (schedule) => ({
            ...schedule,
            nextTriggerAt: command.nextTriggerAt,
            lastTriggeredAt: command.lastTriggeredAt,
            lastRunId: command.lastRunId,
            lastError: command.lastError,
            updatedAt: command.updatedAt,
          }));
          yield* Queue.offer(receipts, undefined);
        }
        if (command.type === "project.schedule.upsert")
          yield* Ref.update(scheduleRef, (schedule) => ({
            ...schedule,
            enabled: command.enabled,
            nextTriggerAt: null,
          }));
        return { sequence };
      });
    const engine: OrchestrationEngineShape = {
      dispatch,
      readEvents: () => Stream.empty,
      streamDomainEvents: Stream.fromQueue(events),
      latestSequence: Effect.succeed(0),
    };
    const scheduleRepository = {
      upsertDefinition: () => Effect.void,
      remove: () => Effect.void,
      removeByProjectId: () => Effect.void,
      updateRuntime: () => Effect.void,
      getById: ({ projectId: requestedProjectId, scheduleId: requestedScheduleId }) =>
        Ref.get(scheduleRef).pipe(
          Effect.map((schedule) =>
            schedule.projectId === requestedProjectId && schedule.id === requestedScheduleId
              ? Option.some(schedule)
              : Option.none(),
          ),
        ),
      listByProjectId: () => Ref.get(scheduleRef).pipe(Effect.map((schedule) => [schedule])),
      listPendingReconciliation: () =>
        Ref.get(scheduleRef).pipe(
          Effect.map((schedule) =>
            schedule.enabled && schedule.nextTriggerAt === null ? [schedule] : [],
          ),
        ),
      listDue: (now: string) =>
        Ref.get(scheduleRef).pipe(
          Effect.map((schedule) =>
            schedule.enabled && schedule.nextTriggerAt !== null && schedule.nextTriggerAt <= now
              ? [schedule]
              : [],
          ),
        ),
    } satisfies ProjectionWorkspaceScheduleRepository["Service"];
    const runRepository = {
      upsert: () => Effect.void,
      requestCancel: () => Effect.void,
      recordAnswer: () => Effect.void,
      recordInterjection: () => Effect.void,
      recordControl: () => Effect.void,
      recordReview: () => Effect.void,
      requestVerification: () => Effect.void,
      getById: ({ projectId: requestedProjectId, runId }) =>
        Ref.get(runsRef).pipe(
          Effect.map((runs) => {
            const run = runs.get(runId);
            return run?.projectId === requestedProjectId ? Option.some(run) : Option.none();
          }),
        ),
      list: ({ statuses }) =>
        Ref.get(runsRef).pipe(
          Effect.map((runs) =>
            [...runs.values()].filter((run) => !statuses || statuses.includes(run.status)),
          ),
        ),
      listResumable: () => Effect.succeed([]),
    } satisfies ProjectionWorkspaceCollaborationRunRepository["Service"];
    const layer = WorkspaceSchedulerReactorLive.pipe(
      Layer.provideMerge(Layer.succeed(OrchestrationEngineService, engine)),
      Layer.provideMerge(Layer.succeed(ProjectionWorkspaceScheduleRepository, scheduleRepository)),
      Layer.provideMerge(
        Layer.succeed(ProjectionWorkspaceCollaborationRunRepository, runRepository),
      ),
      Layer.provideMerge(NodeServices.layer),
      Layer.provideMerge(
        input.recipeInbox
          ? Layer.mock(WorkspaceTaskInbox)({
              hasPendingSource: () => Effect.succeed(input.recipeBusy === true),
              submit: (request) =>
                Effect.sync(() => {
                  inboxRequests.push(request);
                  const existing = inboxTasks.get(request.externalId);
                  if (existing) return existing;
                  const task: WorkspaceInboxTask = {
                    id: `task-${request.externalId}`,
                    projectId: request.projectId,
                    source: request.source,
                    externalId: request.externalId,
                    inputHash: "hash",
                    inputs: request.inputs,
                    recipe: {
                      id: request.recipeId,
                      name: "Recipe",
                      revision: request.recipeRevision ?? 1,
                      enabled: true,
                      updatedAt: initialSchedule.createdAt,
                      parameters: [],
                      taskTemplate: "Task",
                      execution: "script",
                      script: "node task.cjs",
                      precheck: { kind: "none" },
                      artifacts: [],
                      verificationCommands: [],
                      executionProfile: null,
                    },
                    status: "queued",
                    attempt: 0,
                    runId: null,
                    monitorKey: "monitor",
                    workspaceRoot: null,
                    precheckFingerprint: null,
                    baseline: {},
                    receipts: [],
                    output: "",
                    error: null,
                    aiSkipped: false,
                    createdAt: initialSchedule.createdAt,
                    updatedAt: initialSchedule.createdAt,
                  };
                  inboxTasks.set(request.externalId, task);
                  return task;
                }),
            })
          : Layer.empty,
      ),
    );

    yield* TestClock.setTime(Date.parse("2020-01-01T00:00:00.000Z"));

    yield* Effect.gen(function* () {
      const scheduler = yield* Effect.service(WorkspaceSchedulerReactor);
      if (input.timing?.kind === "after-run") {
        yield* scheduler.start();
        yield* scheduler.drain;
        if (input.completeLater && input.predecessor) {
          yield* Queue.take(receipts);
          const run = { ...input.predecessor, status: "completed" as const };
          yield* Ref.update(runsRef, (current) => new Map(current).set(run.id, run));
          yield* Queue.offer(events, {
            sequence: 1,
            eventId: EventId.make("completed"),
            aggregateKind: "project",
            aggregateId: projectId,
            occurredAt: run.updatedAt,
            commandId: null,
            causationEventId: null,
            correlationId: null,
            metadata: {},
            type: "project.collaboration-run-upserted",
            payload: { run },
          });
          yield* Queue.take(receipts);
          yield* scheduler.drain;
        }
      }
      yield* scheduler.tick;
      yield* scheduler.tick;
    }).pipe(Effect.provide(layer), Effect.scoped);

    if (input.crashBeforeAdvance) {
      yield* Ref.update(scheduleRef, (schedule) => ({
        ...schedule,
        nextTriggerAt: "2020-01-01T00:00:00.000Z",
        lastTriggeredAt: null,
        lastRunId: null,
      }));
      yield* Effect.gen(function* () {
        const scheduler = yield* WorkspaceSchedulerReactor;
        yield* scheduler.tick;
      }).pipe(Effect.provide(layer), Effect.scoped);
    }

    const runs = yield* Ref.get(runsRef);
    return {
      runs: [...runs.values()].filter((run) => run.source === "schedule"),
      schedule: yield* Ref.get(scheduleRef),
      commands: yield* Ref.get(commands),
      projectId,
      scheduleId,
      inboxTasks: [...inboxTasks.values()],
      inboxRequests,
    };
  });

it.effect("triggers one deterministic unattended run and durably advances the schedule", () =>
  Effect.gen(function* () {
    const { runs, schedule, projectId, scheduleId } = yield* exerciseScheduler();
    expect(runs).toHaveLength(1);
    const [run] = runs;
    expect(run).toMatchObject({
      projectId,
      source: "schedule",
      scheduleId,
      task: "Verify the Workspace",
    });
    expect(run!.id).toBe(`sr-${scheduleId}-1577836800000`);
    expect(schedule).toMatchObject({
      nextTriggerAt: null,
      lastTriggeredAt: "2020-01-01T00:00:00.000Z",
      lastRunId: run!.id,
      lastError: null,
    });
  }),
);

it.effect(
  "queues a pinned recipe and preserves exactly one task if advancement is interrupted",
  () =>
    Effect.gen(function* () {
      const result = yield* exerciseScheduler({
        recipeInbox: true,
        crashBeforeAdvance: true,
        timing: {
          kind: "once",
          runAt: "2020-01-01T00:00:00.000Z",
          taskRecipe: { recipeId: "recipe-a", revision: 4, inputs: { topic: "GitHub" } },
        },
      });
      expect(result.runs).toHaveLength(0);
      expect(result.inboxTasks).toHaveLength(1);
      expect(result.inboxRequests[0]).toMatchObject({
        recipeId: "recipe-a",
        recipeRevision: 4,
        inputs: { topic: "GitHub" },
        source: `schedule:${result.scheduleId}`,
        externalId: "2020-01-01T00:00:00.000Z",
      });
      expect(result.schedule.lastTriggeredAt).toBe("2020-01-01T00:00:00.000Z");
      expect(result.schedule.lastRunId).toBeNull();
    }),
);
it.effect("skips a recipe occurrence while an older task is still active or uncertain", () =>
  Effect.gen(function* () {
    const result = yield* exerciseScheduler({
      recipeInbox: true,
      recipeBusy: true,
      timing: {
        kind: "once",
        runAt: "2020-01-01T00:00:00.000Z",
        taskRecipe: { recipeId: "recipe-a", revision: 1, inputs: {} },
      },
    });
    expect(result.inboxTasks).toHaveLength(0);
    expect(result.schedule.lastError).toContain("still active");
    expect(result.schedule.nextTriggerAt).toBeNull();
  }),
);

const predecessor: WorkspaceCollaborationRun = {
  id: WorkspaceCollaborationRunId.make("preceding"),
  projectId: ProjectId.make("workspace-a"),
  source: "user",
  scheduleId: null,
  incidentId: null,
  task: "First task",
  status: "running",
  steps: [],
  graph: null,
  meeting: null,
  orchestra: null,
  finalOutput: null,
  error: null,
  createdAt: "2020-01-01T00:00:00.000Z",
  updatedAt: "2020-01-01T00:00:00.000Z",
};
const dependency: WorkspaceScheduleTiming = {
  kind: "after-run",
  runId: predecessor.id,
  condition: "completed",
  onFailure: "hold",
};
it.effect("wakes a waiting follow-up from a persisted completion event and fires once", () =>
  Effect.gen(function* () {
    const result = yield* exerciseScheduler({
      timing: dependency,
      predecessor,
      completeLater: true,
    });
    expect(result.runs).toHaveLength(1);
    expect(
      result.commands.filter((command) => command.type === "project.collaboration.run.schedule"),
    ).toHaveLength(1);
    expect(result.schedule.lastTriggeredAt).toBe(predecessor.updatedAt);
  }),
);
it.effect("recovers on startup and deduplicates a crash before schedule advancement", () =>
  Effect.gen(function* () {
    const result = yield* exerciseScheduler({
      timing: dependency,
      predecessor: { ...predecessor, status: "completed" },
      crashBeforeAdvance: true,
    });
    expect(
      result.commands.filter((command) => command.type === "project.collaboration.run.schedule"),
    ).toHaveLength(1);
    expect(result.schedule.nextTriggerAt).toBeNull();
  }),
);
it.effect("holds unverified or cross-project completions without starting an agent", () =>
  Effect.gen(function* () {
    for (const source of [
      { ...predecessor, status: "completed" as const },
      { ...predecessor, projectId: ProjectId.make("other"), status: "completed" as const },
    ]) {
      const result = yield* exerciseScheduler({
        timing: { ...dependency, condition: "verified" },
        predecessor: source,
      });
      expect(result.runs).toHaveLength(0);
      expect(result.schedule.lastError).not.toBeNull();
    }
  }),
);
it.effect("cancels a follow-up when the predecessor fails without invoking an agent", () =>
  Effect.gen(function* () {
    const result = yield* exerciseScheduler({
      timing: { ...dependency, onFailure: "cancel" },
      predecessor: { ...predecessor, status: "failed" },
    });
    expect(result.runs).toHaveLength(0);
    expect(result.schedule.enabled).toBe(false);
    expect(result.schedule.lastError).toContain("cancelled");
  }),
);
