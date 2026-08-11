import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ProjectId,
  WorkspaceScheduleId,
  type OrchestrationCommand,
  type WorkspaceCollaborationRun,
  type WorkspaceSchedule,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { expect, it } from "vite-plus/test";

import { ProjectionWorkspaceCollaborationRunRepository } from "../../persistence/Services/ProjectionWorkspaceCollaborationRuns.ts";
import { ProjectionWorkspaceScheduleRepository } from "../../persistence/Services/ProjectionWorkspaceSchedules.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import { WorkspaceSchedulerReactor } from "../Services/WorkspaceSchedulerReactor.ts";
import { WorkspaceSchedulerReactorLive } from "./WorkspaceSchedulerReactor.ts";

it("triggers one deterministic unattended run and durably advances the schedule", async () => {
  const projectId = ProjectId.make("workspace-a");
  const scheduleId = WorkspaceScheduleId.make("schedule-a");
  const initialSchedule: WorkspaceSchedule = {
    id: scheduleId,
    projectId,
    title: "One-time unattended task",
    task: "Verify the Workspace",
    enabled: true,
    timing: { kind: "once", runAt: "2020-01-01T00:00:00.000Z" },
    nextTriggerAt: "2020-01-01T00:00:00.000Z",
    lastTriggeredAt: null,
    lastRunId: null,
    lastError: null,
    createdAt: "2020-01-01T00:00:00.000Z",
    updatedAt: "2020-01-01T00:00:00.000Z",
  };
  const scheduleRef = await Effect.runPromise(Ref.make(initialSchedule));
  const runsRef = await Effect.runPromise(Ref.make(new Map<string, WorkspaceCollaborationRun>()));
  let sequence = 0;

  const dispatch: OrchestrationEngineShape["dispatch"] = (command: OrchestrationCommand) =>
    Effect.gen(function* () {
      sequence += 1;
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
      }
      return { sequence };
    });
  const engine: OrchestrationEngineShape = {
    dispatch,
    readEvents: () => Stream.empty,
    streamDomainEvents: Stream.empty,
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
    listPendingReconciliation: () => Effect.succeed([]),
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
    getById: ({ projectId: requestedProjectId, runId }) =>
      Ref.get(runsRef).pipe(
        Effect.map((runs) => {
          const run = runs.get(runId);
          return run?.projectId === requestedProjectId ? Option.some(run) : Option.none();
        }),
      ),
    list: () => Ref.get(runsRef).pipe(Effect.map((runs) => [...runs.values()])),
    listResumable: () => Effect.succeed([]),
  } satisfies ProjectionWorkspaceCollaborationRunRepository["Service"];
  const layer = WorkspaceSchedulerReactorLive.pipe(
    Layer.provideMerge(Layer.succeed(OrchestrationEngineService, engine)),
    Layer.provideMerge(Layer.succeed(ProjectionWorkspaceScheduleRepository, scheduleRepository)),
    Layer.provideMerge(Layer.succeed(ProjectionWorkspaceCollaborationRunRepository, runRepository)),
    Layer.provideMerge(NodeServices.layer),
  );
  const runtime = ManagedRuntime.make(layer);

  try {
    const scheduler = await runtime.runPromise(Effect.service(WorkspaceSchedulerReactor));
    await runtime.runPromise(scheduler.tick);
    await runtime.runPromise(scheduler.tick);

    const runs = await Effect.runPromise(Ref.get(runsRef));
    expect(runs.size).toBe(1);
    const [run] = [...runs.values()];
    expect(run).toMatchObject({
      projectId,
      source: "schedule",
      scheduleId,
      task: "Verify the Workspace",
    });
    expect(run!.id).toBe(`sr-${scheduleId}-1577836800000`);
    expect(await Effect.runPromise(Ref.get(scheduleRef))).toMatchObject({
      nextTriggerAt: null,
      lastTriggeredAt: "2020-01-01T00:00:00.000Z",
      lastRunId: run!.id,
      lastError: null,
    });
  } finally {
    await runtime.dispose();
  }
});
