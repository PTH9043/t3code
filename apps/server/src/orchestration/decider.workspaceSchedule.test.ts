import {
  CommandId,
  ProjectId,
  WorkspaceCollaborationRunId,
  WorkspaceScheduleId,
  WorkspaceExecutionProfile,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const now = "2026-08-08T00:00:00.000Z";
const decodeProfile = Schema.decodeUnknownEffect(WorkspaceExecutionProfile);

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
  it.effect(
    "uses the profile snapshot for a scheduled roster without attaching its saved thread",
    () =>
      Effect.gen(function* () {
        const { projectId, readModel } = yield* workspaceReadModel;
        const profile = yield* decodeProfile({
          id: "focus",
          name: "Focused fix",
          revision: 3,
          instructions: "Limit scope",
          verificationCommands: ["vp test run src/fix.test.ts"],
          orchestra: { maxParallel: 2, isolateWorktrees: true },
          meeting: {
            mode: "fixed-rounds",
            maxRounds: 0,
            userInLoop: false,
            chairParticipantId: "one",
            threadId: "old-thread",
            participants: ["one", "two"].map((id) => ({
              id,
              displayName: id,
              modelSelection: {
                instanceId: "codex",
                model: "gpt-5.4",
                options: [{ id: "reasoningEffort", value: "high" }],
              },
            })),
          },
        });
        const event = singleEvent(
          yield* decideOrchestrationCommand({
            readModel,
            command: {
              type: "project.collaboration.run.schedule",
              commandId: CommandId.make("profile-run"),
              runId: WorkspaceCollaborationRunId.make("profile-run"),
              projectId,
              scheduleId: WorkspaceScheduleId.make("profile-schedule"),
              task: "Fix login",
              executionProfile: profile,
              createdAt: now,
            },
          }),
        );
        expect(event.type).toBe("project.collaboration-run-requested");
        if (event.type !== "project.collaboration-run-requested") return;
        expect(event.payload.run.orchestra).toEqual({
          ...profile.orchestra,
          completionCheck: true,
          verificationCommands: profile.verificationCommands,
        });
        expect(event.payload.run.meeting).toMatchObject({
          threadId: null,
          maxRounds: 0,
          participants: profile.meeting.participants,
        });
        expect(event.payload.run.task).toContain("revision 3");
        expect(event.payload.run.task).toContain("vp test run src/fix.test.ts");
        expect(event.payload.run.task).toContain("Fix login");
      }),
  );
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
      // A person's request displaces the queued schedule; that is what `preempt` carries.
      expect(user.payload.preempt).toBe(true);

      const integrity = singleEvent(
        yield* decideOrchestrationCommand({
          command: {
            type: "project.collaboration.run.request",
            commandId: CommandId.make("integrity-run-a"),
            runId: WorkspaceCollaborationRunId.make("integrity-run-a"),
            projectId,
            task: "Integrity convergence",
            source: "integrity",
            createdAt: now,
          },
          readModel,
        }),
      );
      expect(integrity.type).toBe("project.collaboration-run-requested");
      if (integrity.type !== "project.collaboration-run-requested") return;
      // The integrity loop runs on its own initiative, so it must not cancel the schedule.
      expect(integrity.payload.run).toMatchObject({ source: "integrity", scheduleId: null });
      expect(integrity.payload.preempt).toBe(false);
    }),
  );
});
