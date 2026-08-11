import { ProjectId, WorkspaceCollaborationRunId, WorkspaceScheduleId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ProjectionWorkspaceScheduleRepository } from "../Services/ProjectionWorkspaceSchedules.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { ProjectionWorkspaceScheduleRepositoryLive } from "./ProjectionWorkspaceSchedules.ts";

const layer = it.layer(
  ProjectionWorkspaceScheduleRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("ProjectionWorkspaceScheduleRepository", (it) => {
  it.effect("isolates schedules by Workspace and returns due metadata with ownership", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const repository = yield* ProjectionWorkspaceScheduleRepository;
      const workspaceA = ProjectId.make("workspace-a");
      const workspaceB = ProjectId.make("workspace-b");
      for (const projectId of [workspaceA, workspaceB]) {
        yield* sql`
          INSERT INTO projection_projects (
            project_id, title, workspace_root, default_model_selection_json,
            scripts_json, workspace_control_json, created_at, updated_at, deleted_at
          ) VALUES (
            ${projectId}, ${projectId}, ${`D:/${projectId}`}, NULL, '[]',
            '{"isolationMode":"strict","longTermMemoryRoot":null}',
            '2026-08-08T00:00:00.000Z', '2026-08-08T00:00:00.000Z', NULL
          )
        `;
      }

      const scheduleA = WorkspaceScheduleId.make("schedule-a");
      const scheduleB = WorkspaceScheduleId.make("schedule-b");
      yield* repository.upsertDefinition({
        scheduleId: scheduleA,
        projectId: workspaceA,
        title: "Workspace A daily",
        task: "Run Workspace A checks",
        enabled: true,
        timing: { kind: "daily", localTime: "09:00", timeZone: "Asia/Seoul" },
        updatedAt: "2026-08-08T00:00:00.000Z",
      });
      yield* repository.upsertDefinition({
        scheduleId: scheduleB,
        projectId: workspaceB,
        title: "Workspace B once",
        task: "Run Workspace B task",
        enabled: true,
        timing: { kind: "once", runAt: "2026-08-10T00:00:00.000Z" },
        updatedAt: "2026-08-08T00:00:00.000Z",
      });

      yield* repository.updateRuntime({
        scheduleId: scheduleA,
        projectId: workspaceA,
        nextTriggerAt: "2026-08-08T01:00:00.000Z",
        lastTriggeredAt: "2026-08-07T01:00:00.000Z",
        lastRunId: WorkspaceCollaborationRunId.make("run-a"),
        lastError: null,
        updatedAt: "2026-08-08T00:30:00.000Z",
      });
      yield* repository.updateRuntime({
        scheduleId: scheduleB,
        projectId: workspaceB,
        nextTriggerAt: "2026-08-10T00:00:00.000Z",
        lastTriggeredAt: null,
        lastRunId: null,
        lastError: null,
        updatedAt: "2026-08-08T00:30:00.000Z",
      });

      expect(yield* repository.listByProjectId(workspaceA)).toHaveLength(1);
      expect(yield* repository.listByProjectId(workspaceB)).toHaveLength(1);
      expect(yield* repository.listDue("2026-08-08T02:00:00.000Z")).toEqual([
        expect.objectContaining({ id: scheduleA, projectId: workspaceA }),
      ]);
      expect(
        Option.isNone(yield* repository.getById({ projectId: workspaceB, scheduleId: scheduleA })),
      ).toBe(true);

      // A globally unique id cannot be used to move a schedule across Workspaces.
      yield* repository.upsertDefinition({
        scheduleId: scheduleA,
        projectId: workspaceB,
        title: "Foreign overwrite",
        task: "Should not move",
        enabled: false,
        timing: { kind: "once", runAt: "2026-08-08T00:00:00.000Z" },
        updatedAt: "2026-08-08T03:00:00.000Z",
      });
      expect(
        Option.getOrThrow(
          yield* repository.getById({ projectId: workspaceA, scheduleId: scheduleA }),
        ),
      ).toMatchObject({ projectId: workspaceA, title: "Workspace A daily" });
    }),
  );
});
