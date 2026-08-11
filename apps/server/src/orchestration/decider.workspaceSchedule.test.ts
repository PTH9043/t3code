import {
  CommandId,
  ProjectId,
  WorkspaceCollaborationRunId,
  WorkspaceScheduleId,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const now = "2026-08-08T00:00:00.000Z";

function singleEvent(
  result:
    | Omit<OrchestrationEvent, "sequence">
    | ReadonlyArray<Omit<OrchestrationEvent, "sequence">>,
) {
  const event = Array.isArray(result) ? result[0] : result;
  if (!event) throw new Error("Expected one event");
  return event;
}

const workspaceReadModel = Effect.gen(function* () {
  const projectId = ProjectId.make("workspace-a");
  const created = singleEvent(
    yield* decideOrchestrationCommand({
      command: {
        type: "project.create",
        commandId: CommandId.make("create-workspace-a"),
        projectId,
        title: "Workspace A",
        workspaceRoot: "D:/workspace-a",
        createdAt: now,
      },
      readModel: createEmptyReadModel(now),
    }),
  );
  const readModel = yield* projectEvent(createEmptyReadModel(now), {
    ...created,
    sequence: 1,
  } as OrchestrationEvent);
  return { projectId, readModel } as const;
});

it.layer(NodeServices.layer)("Workspace schedule decider", (it) => {
  it.effect("emits a Workspace-owned schedule definition", () =>
    Effect.gen(function* () {
      const { projectId, readModel } = yield* workspaceReadModel;
      const scheduleId = WorkspaceScheduleId.make("schedule-a");
      const event = singleEvent(
        yield* decideOrchestrationCommand({
          command: {
            type: "project.schedule.upsert",
            commandId: CommandId.make("upsert-schedule-a"),
            projectId,
            scheduleId,
            title: "Daily checks",
            task: "Run focused checks",
            enabled: true,
            timing: { kind: "daily", localTime: "09:00", timeZone: "Asia/Seoul" },
            createdAt: now,
          },
          readModel,
        }),
      );
      expect(event.type).toBe("project.schedule-upserted");
      if (event.type !== "project.schedule-upserted") return;
      expect(event.payload).toMatchObject({ projectId, scheduleId, enabled: true });
    }),
  );

  it.effect("marks internal scheduled runs separately from absolute-priority user runs", () =>
    Effect.gen(function* () {
      const { projectId, readModel } = yield* workspaceReadModel;
      const scheduleId = WorkspaceScheduleId.make("schedule-a");
      const scheduled = singleEvent(
        yield* decideOrchestrationCommand({
          command: {
            type: "project.collaboration.run.schedule",
            commandId: CommandId.make("trigger-schedule-a"),
            runId: WorkspaceCollaborationRunId.make("scheduled-run-a"),
            scheduleId,
            projectId,
            task: "Scheduled task",
            createdAt: now,
          },
          readModel,
        }),
      );
      const user = singleEvent(
        yield* decideOrchestrationCommand({
          command: {
            type: "project.collaboration.run.request",
            commandId: CommandId.make("user-run-a"),
            runId: WorkspaceCollaborationRunId.make("user-run-a"),
            projectId,
            task: "User task",
            createdAt: now,
          },
          readModel,
        }),
      );
      expect(scheduled.type).toBe("project.collaboration-run-requested");
      expect(user.type).toBe("project.collaboration-run-requested");
      if (
        scheduled.type !== "project.collaboration-run-requested" ||
        user.type !== "project.collaboration-run-requested"
      ) {
        return;
      }
      expect(scheduled.payload.run).toMatchObject({ source: "schedule", scheduleId });
      expect(user.payload.run).toMatchObject({ source: "user", scheduleId: null });
    }),
  );
});
