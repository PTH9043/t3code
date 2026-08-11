import {
  ProjectId,
  WorkspaceCollaborationRunId,
  WorkspaceIncidentId,
  type WorkspaceTaskGraph,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ProjectionWorkspaceCollaborationRunRepository } from "../Services/ProjectionWorkspaceCollaborationRuns.ts";
import { ProjectionWorkspaceCollaborationRunRepositoryLive } from "./ProjectionWorkspaceCollaborationRuns.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  ProjectionWorkspaceCollaborationRunRepositoryLive.pipe(
    Layer.provideMerge(SqlitePersistenceMemory),
  ),
);

layer("ProjectionWorkspaceCollaborationRunRepository", (it) => {
  it.effect("isolates runs by Workspace and enforces one active run per Workspace", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const repository = yield* ProjectionWorkspaceCollaborationRunRepository;
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

      const runA = WorkspaceCollaborationRunId.make("run-a");
      const runB = WorkspaceCollaborationRunId.make("run-b");
      yield* repository.upsert({
        id: runA,
        projectId: workspaceA,
        source: "user",
        scheduleId: null,
        incidentId: null,
        task: "Workspace A task",
        status: "running",
        steps: [],
        graph: null,
        finalOutput: null,
        error: null,
        createdAt: "2026-08-08T01:00:00.000Z",
        updatedAt: "2026-08-08T01:00:00.000Z",
      });
      yield* repository.upsert({
        id: runB,
        projectId: workspaceB,
        source: "user",
        scheduleId: null,
        incidentId: null,
        task: "Workspace B task",
        status: "queued",
        steps: [],
        graph: null,
        finalOutput: null,
        error: null,
        createdAt: "2026-08-08T02:00:00.000Z",
        updatedAt: "2026-08-08T02:00:00.000Z",
      });

      expect(yield* repository.list({ projectId: workspaceA })).toHaveLength(1);
      expect(yield* repository.list({ projectId: workspaceB })).toHaveLength(1);
      expect(Option.isNone(yield* repository.getById({ projectId: workspaceB, runId: runA }))).toBe(
        true,
      );

      yield* repository.requestCancel({
        projectId: workspaceB,
        runId: runB,
        cancelledAt: "2026-08-08T03:00:00.000Z",
      });
      expect(
        Option.getOrThrow(yield* repository.getById({ projectId: workspaceB, runId: runB })).status,
      ).toBe("cancelled");

      yield* repository.requestCancel({
        projectId: workspaceA,
        runId: runA,
        cancelledAt: "2026-08-08T03:00:00.000Z",
      });
      expect(
        Option.getOrThrow(yield* repository.getById({ projectId: workspaceA, runId: runA })).status,
      ).toBe("cancel-requested");

      // Internal progress updates must never revive a user-cancelled run.
      yield* repository.upsert({
        id: runA,
        projectId: workspaceA,
        source: "user",
        scheduleId: null,
        incidentId: null,
        task: "Workspace A task",
        status: "running",
        steps: [],
        graph: null,
        finalOutput: null,
        error: null,
        createdAt: "2026-08-08T01:00:00.000Z",
        updatedAt: "2026-08-08T03:30:00.000Z",
      });
      expect(
        Option.getOrThrow(yield* repository.getById({ projectId: workspaceA, runId: runA })).status,
      ).toBe("cancel-requested");

      // A globally unique run id cannot be reassigned to another Workspace.
      yield* repository.upsert({
        id: runA,
        projectId: workspaceB,
        source: "user",
        scheduleId: null,
        incidentId: null,
        task: "Attempted cross-Workspace reassignment",
        status: "completed",
        steps: [],
        graph: null,
        finalOutput: "foreign",
        error: null,
        createdAt: "2026-08-08T01:00:00.000Z",
        updatedAt: "2026-08-08T03:45:00.000Z",
      });
      expect(
        Option.getOrThrow(yield* repository.getById({ projectId: workspaceA, runId: runA })),
      ).toMatchObject({ projectId: workspaceA, task: "Workspace A task" });
      expect(Option.isNone(yield* repository.getById({ projectId: workspaceB, runId: runA }))).toBe(
        true,
      );

      const incidentRun = WorkspaceCollaborationRunId.make("incident-run");
      const originalIncident = WorkspaceIncidentId.make("incident-original");
      const updatedIncident = WorkspaceIncidentId.make("incident-updated");
      const taskGraph: WorkspaceTaskGraph = {
        revision: 0,
        status: "planning",
        nodes: [],
        changes: [],
        nextAction: "Fable이 작업 그래프를 설계합니다.",
        overallConfidence: null,
        repairApproved: null,
        memoryCandidates: [],
      };
      yield* repository.upsert({
        id: incidentRun,
        projectId: workspaceB,
        source: "incident",
        scheduleId: null,
        incidentId: originalIncident,
        task: "Repair the original incident",
        status: "queued",
        steps: [],
        graph: taskGraph,
        finalOutput: null,
        error: null,
        createdAt: "2026-08-08T03:50:00.000Z",
        updatedAt: "2026-08-08T03:50:00.000Z",
      });
      yield* repository.upsert({
        id: incidentRun,
        projectId: workspaceB,
        source: "incident",
        scheduleId: null,
        incidentId: updatedIncident,
        task: "Repair the updated incident",
        status: "running",
        steps: [],
        graph: taskGraph,
        finalOutput: null,
        error: null,
        createdAt: "2026-08-08T03:50:00.000Z",
        updatedAt: "2026-08-08T03:55:00.000Z",
      });
      expect(
        Option.getOrThrow(yield* repository.getById({ projectId: workspaceB, runId: incidentRun })),
      ).toMatchObject({
        source: "incident",
        scheduleId: null,
        incidentId: updatedIncident,
        task: "Repair the updated incident",
        status: "running",
        graph: expect.objectContaining({
          revision: 0,
          status: "planning",
          nextAction: "Fable이 작업 그래프를 설계합니다.",
        }),
      });
      yield* repository.upsert({
        id: incidentRun,
        projectId: workspaceB,
        source: "incident",
        scheduleId: null,
        incidentId: updatedIncident,
        task: "Repair the updated incident",
        status: "completed",
        steps: [],
        graph: { ...taskGraph, status: "completed", overallConfidence: "high" },
        finalOutput: "repaired",
        error: null,
        createdAt: "2026-08-08T03:50:00.000Z",
        updatedAt: "2026-08-08T03:58:00.000Z",
      });
      yield* repository.upsert({
        id: incidentRun,
        projectId: workspaceA,
        source: "incident",
        scheduleId: null,
        incidentId: WorkspaceIncidentId.make("foreign-incident"),
        task: "Attempted cross-Workspace incident reassignment",
        status: "completed",
        steps: [],
        graph: null,
        finalOutput: "foreign",
        error: null,
        createdAt: "2026-08-08T03:50:00.000Z",
        updatedAt: "2026-08-08T03:59:00.000Z",
      });
      expect(
        Option.getOrThrow(yield* repository.getById({ projectId: workspaceB, runId: incidentRun })),
      ).toMatchObject({
        projectId: workspaceB,
        incidentId: updatedIncident,
        finalOutput: "repaired",
        graph: expect.objectContaining({ status: "completed", overallConfidence: "high" }),
      });
      expect(
        Option.isNone(yield* repository.getById({ projectId: workspaceA, runId: incidentRun })),
      ).toBe(true);

      const duplicateActiveExit = yield* Effect.exit(
        repository.upsert({
          id: WorkspaceCollaborationRunId.make("run-a-2"),
          projectId: workspaceA,
          source: "user",
          scheduleId: null,
          incidentId: null,
          task: "Second active Workspace A task",
          status: "running",
          steps: [],
          graph: null,
          finalOutput: null,
          error: null,
          createdAt: "2026-08-08T04:00:00.000Z",
          updatedAt: "2026-08-08T04:00:00.000Z",
        }),
      );
      expect(Exit.isFailure(duplicateActiveExit)).toBe(true);

      expect(yield* repository.listResumable()).toEqual([
        expect.objectContaining({ id: runA, projectId: workspaceA, status: "cancel-requested" }),
      ]);

      // Resuming a run whose project is gone would create fresh threads and turns under a
      // project the user deleted, so a soft-deleted project drops out of recovery.
      yield* sql`
        UPDATE projection_projects
        SET deleted_at = '2026-08-08T05:00:00.000Z'
        WHERE project_id = ${workspaceA}
      `;
      expect(yield* repository.listResumable()).toEqual([]);
    }),
  );
});
