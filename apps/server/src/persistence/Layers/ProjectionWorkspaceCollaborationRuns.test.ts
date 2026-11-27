import {
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  WorkspaceCollaborationRunId,
  WorkspaceIncidentId,
  WorkspaceMeetingParticipantId,
  WorkspaceTaskNodeId,
  type WorkspaceTaskGraph,
} from "@t3tools/contracts";
import { workflowDefaults } from "@t3tools/shared/workflow";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ProjectionWorkspaceCollaborationRunRepository } from "../Services/ProjectionWorkspaceCollaborationRuns.ts";
import { ProjectionWorkspaceCollaborationRunRepositoryLive } from "./ProjectionWorkspaceCollaborationRuns.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { parkRefusedWorkflowAssignment } from "../../orchestration/workspaceWorkflowAssignment.ts";

const layer = it.layer(
  ProjectionWorkspaceCollaborationRunRepositoryLive.pipe(
    Layer.provideMerge(SqlitePersistenceMemory),
  ),
);

layer("ProjectionWorkspaceCollaborationRunRepository", (it) => {
  it.effect("persists manual assignment review and clears only its matching refusal question", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const repository = yield* ProjectionWorkspaceCollaborationRunRepository;
      const projectId = ProjectId.make("review-refusal-project");
      const runId = WorkspaceCollaborationRunId.make("review-refusal-run");
      const at = "2026-01-01T00:00:00.000Z";
      yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at)
        VALUES (${projectId},'Project','/project','[]',${at},${at})`;
      const definition = {
        ...workflowDefaults()[0]!,
        revision: 1,
        archived: false,
        digest: "fixture-digest",
        createdAt: at,
      };
      const participants = ["chair", "worker"].map((id) => ({
        id: WorkspaceMeetingParticipantId.make(id),
        displayName: id,
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: id },
      }));
      const run = {
        id: runId,
        projectId,
        source: "user" as const,
        scheduleId: null,
        incidentId: null,
        task: "작업",
        status: "running" as const,
        steps: [],
        graph: null,
        meeting: {
          mode: "fixed-rounds" as const,
          phase: "planning" as const,
          threadId: ThreadId.make("review-refusal-thread"),
          participants,
          chairParticipantId: participants[0]!.id,
          maxRounds: 0,
          userInLoop: false,
          rounds: [],
          pendingQuestion: null,
          answers: [],
          interjections: [],
        },
        orchestra: { maxParallel: 2, isolateWorktrees: false, reviewPlan: true },
        workflow: {
          definitionId: definition.id,
          definitionRevision: 1,
          definitionDigest: definition.digest,
          definition,
          title: definition.title,
          values: { goal: "목표" },
          nodeSkills: definition.nodes.map((node) => ({ nodeId: node.id, skills: [] })),
          roleBindings: [],
          control: "active" as const,
          controlRevision: 0,
          updatedAt: at,
          requestDigest: "fixture",
        },
        finalOutput: null,
        error: null,
        createdAt: at,
        updatedAt: at,
      };
      const partial = parkRefusedWorkflowAssignment(
        run,
        "Your message was flagged by Claude's safeguards.",
        at,
      );
      yield* repository.upsert({
        ...run,
        graph: { ...partial.graph, planReview: { revision: 0, status: "pending", updatedAt: at } },
        meeting: { ...run.meeting, phase: "executing", pendingQuestion: partial.question },
      });
      yield* repository.recordReview!({
        projectId,
        runId,
        expectedRevision: 0,
        approve: true,
        reviewedAt: at,
        edits: definition.nodes.map((node) => ({
          nodeId: WorkspaceTaskNodeId.make(node.id),
          title: node.title,
          task: node.task,
          participantId: participants[1]!.id,
          dependsOn: node.dependsOn.map((id) => WorkspaceTaskNodeId.make(id)),
        })),
      });
      const saved = Option.getOrThrow(yield* repository.getById({ projectId, runId }));
      expect(saved.meeting?.pendingQuestion).toBeNull();
      expect(saved.graph?.workflowAssignment).toBeUndefined();
      expect(saved.graph?.nodes.find((node) => node.id === "plan")).toMatchObject({
        status: "completed",
        output: expect.stringContaining("flagged by Claude"),
      });
      expect(saved.graph?.nodes.find((node) => node.id === "execute")?.participantId).toBe(
        participants[1]!.id,
      );
      yield* repository.upsert({ ...saved, status: "cancelled" });
      const secondId = WorkspaceCollaborationRunId.make("review-refusal-answered");
      yield* repository.upsert({
        ...run,
        id: secondId,
        graph: { ...partial.graph, planReview: { revision: 0, status: "pending", updatedAt: at } },
        meeting: {
          ...run.meeting,
          threadId: ThreadId.make("review-refusal-thread-2"),
          phase: "executing",
          pendingQuestion: partial.question,
        },
      });
      yield* repository.recordAnswer({
        projectId,
        runId: secondId,
        question: partial.question.question,
        answer: "다시 시도",
        answeredAt: at,
      });
      yield* repository.recordReview!({
        projectId,
        runId: secondId,
        expectedRevision: 0,
        approve: true,
        reviewedAt: at,
        edits: definition.nodes.map((node) => ({
          nodeId: WorkspaceTaskNodeId.make(node.id),
          title: node.title,
          task: node.task,
          participantId: participants[1]!.id,
          dependsOn: node.dependsOn.map((id) => WorkspaceTaskNodeId.make(id)),
        })),
      });
      const answered = Option.getOrThrow(yield* repository.getById({ projectId, runId: secondId }));
      expect(answered.meeting?.answers.map((entry) => entry.answer)).toEqual(["다시 시도"]);
      expect(answered.meeting?.pendingQuestion).toBeNull();
      expect(answered.graph?.workflowAssignment).toBeUndefined();
      yield* repository.upsert({ ...answered, status: "cancelled" });
    }),
  );
  it.effect("isolates legacy runs by project and enforces one active legacy run per project", () =>
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
        meeting: null,
        orchestra: null,
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
        meeting: null,
        orchestra: null,
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
        meeting: null,
        orchestra: null,
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
        meeting: null,
        orchestra: null,
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
        meeting: null,
        orchestra: null,
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
        meeting: null,
        orchestra: null,
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
        meeting: null,
        orchestra: null,
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
        meeting: null,
        orchestra: null,
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
          meeting: null,
          orchestra: null,
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

  it.effect("keeps interjections through the reactor's wholesale meeting rewrites", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const repository = yield* ProjectionWorkspaceCollaborationRunRepository;
      const projectId = ProjectId.make("workspace-i");
      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, default_model_selection_json,
          scripts_json, workspace_control_json, created_at, updated_at, deleted_at
        ) VALUES (
          ${projectId}, ${projectId}, ${`D:/${projectId}`}, NULL, '[]',
          '{"isolationMode":"strict","longTermMemoryRoot":null}',
          '2026-08-17T00:00:00.000Z', '2026-08-17T00:00:00.000Z', NULL
        )
      `;

      const runId = WorkspaceCollaborationRunId.make("run-i");
      const meeting = {
        mode: "fixed-rounds",
        phase: "discussing",
        threadId: null,
        participants: [
          {
            id: WorkspaceMeetingParticipantId.make("p1"),
            displayName: "Claude",
            modelSelection: { instanceId: ProviderInstanceId.make("claude-a"), model: "m" },
          },
          {
            id: WorkspaceMeetingParticipantId.make("p2"),
            displayName: "Codex",
            modelSelection: { instanceId: ProviderInstanceId.make("codex-a"), model: "m" },
          },
        ],
        chairParticipantId: null,
        maxRounds: 1,
        userInLoop: false,
        rounds: [],
        pendingQuestion: null,
        answers: [],
        interjections: [],
      } as const;
      const run = {
        id: runId,
        projectId,
        source: "user",
        scheduleId: null,
        incidentId: null,
        task: "회의 주제",
        status: "running",
        steps: [],
        graph: null,
        meeting,
        orchestra: null,
        finalOutput: null,
        error: null,
        createdAt: "2026-08-17T01:00:00.000Z",
        updatedAt: "2026-08-17T01:00:00.000Z",
      } as const;
      yield* repository.upsert(run);

      yield* repository.recordInterjection({
        projectId,
        runId,
        text: "예산은 무료 티어로",
        interjectedAt: "2026-08-17T01:10:00.000Z",
      });

      const afterRecord = Option.getOrThrow(yield* repository.getById({ projectId, runId }));
      expect(afterRecord.meeting?.interjections).toEqual([
        {
          text: "예산은 무료 티어로",
          roundIndex: 0,
          afterStatements: 0,
          saidAt: "2026-08-17T01:10:00.000Z",
        },
      ]);

      // The reactor persists from its own snapshot, which never saw the
      // interjection — the rewrite must not eat it.
      yield* repository.upsert({ ...run, updatedAt: "2026-08-17T01:20:00.000Z" });
      const afterRewrite = Option.getOrThrow(yield* repository.getById({ projectId, runId }));
      expect(afterRewrite.meeting?.interjections).toHaveLength(1);

      yield* repository.upsert({
        ...run,
        meeting: { ...meeting, supervisorReviewedInterjections: 1 },
        updatedAt: "2026-08-17T01:30:00.000Z",
      });
      const afterReview = Option.getOrThrow(yield* repository.getById({ projectId, runId }));
      expect(afterReview.meeting?.supervisorReviewedInterjections).toBe(1);
      expect(afterReview.meeting?.interjections).toHaveLength(1);
      expect((yield* repository.listResumable())[0]?.meeting?.supervisorReviewedInterjections).toBe(
        1,
      );

      // A finished run no longer takes remarks.
      yield* repository.upsert({
        ...run,
        status: "completed",
        updatedAt: "2026-08-17T02:00:00.000Z",
      });
      yield* repository.recordInterjection({
        projectId,
        runId,
        text: "끝난 뒤의 말",
        interjectedAt: "2026-08-17T02:10:00.000Z",
      });
      const afterDone = Option.getOrThrow(yield* repository.getById({ projectId, runId }));
      expect(afterDone.meeting?.interjections).toHaveLength(1);

      expect(yield* repository.list({ projectId })).toEqual([
        expect.objectContaining({
          meeting: expect.objectContaining({
            interjections: [expect.objectContaining({ text: "예산은 무료 티어로" })],
          }),
        }),
      ]);
    }),
  );

  it.effect("preserves a newer answer when a worker saves an older meeting snapshot", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const repository = yield* ProjectionWorkspaceCollaborationRunRepository;
      const projectId = ProjectId.make("answer-race-project");
      const runId = WorkspaceCollaborationRunId.make("answer-race-run");
      yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at)
        VALUES (${projectId},'Project','/project','[]','2026-01-01','2026-01-01')`;
      const question = {
        askedByParticipantId: null,
        question: "다음 작업은?",
        options: [],
        context: "",
        askedAt: "2026-01-01T00:00:00.000Z",
        nodeId: null,
      } as const;
      const run = {
        id: runId,
        projectId,
        source: "user" as const,
        scheduleId: null,
        incidentId: null,
        task: "작업",
        status: "running" as const,
        steps: [],
        graph: null,
        meeting: {
          mode: "fixed-rounds" as const,
          phase: "executing" as const,
          threadId: null,
          participants: [
            {
              id: WorkspaceMeetingParticipantId.make("p1"),
              displayName: "AI",
              modelSelection: { instanceId: ProviderInstanceId.make("codex-a"), model: "model" },
            },
          ],
          chairParticipantId: null,
          maxRounds: 0,
          userInLoop: false,
          rounds: [],
          pendingQuestion: question,
          answers: [],
          interjections: [],
        },
        orchestra: null,
        finalOutput: null,
        error: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      };
      yield* repository.upsert(run);
      yield* repository.recordAnswer({
        projectId,
        runId,
        question: question.question,
        answer: "중요한 추가 조건",
        answeredAt: "2026-01-01T00:00:01.000Z",
      });
      yield* repository.upsert({ ...run, updatedAt: "2026-01-01T00:00:02.000Z" });
      const stored = Option.getOrThrow(yield* repository.getById({ projectId, runId }));
      expect(stored.meeting?.pendingQuestion).toBeNull();
      expect(stored.meeting?.answers).toEqual([
        expect.objectContaining({ answer: "중요한 추가 조건" }),
      ]);
      yield* repository.upsert({
        ...stored,
        meeting: { ...stored.meeting!, pendingQuestion: question },
        updatedAt: "2026-01-01T00:00:03.000Z",
      });
      const reopened = Option.getOrThrow(yield* repository.getById({ projectId, runId }));
      expect(reopened.meeting?.pendingQuestion?.question).toBe(question.question);
      expect(reopened.meeting?.answers).toHaveLength(1);
      yield* repository.upsert({ ...run, updatedAt: "2026-01-01T00:00:04.000Z" });
      const afterStale = Option.getOrThrow(yield* repository.getById({ projectId, runId }));
      expect(afterStale.meeting?.pendingQuestion).toEqual(question);
      expect(afterStale.meeting?.answers).toHaveLength(1);
      yield* repository.upsert({ ...afterStale, status: "cancelled" });
    }),
  );

  it.effect("stores independent active runs for different conversations in the same project", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const repository = yield* ProjectionWorkspaceCollaborationRunRepository;
      const projectId = ProjectId.make("conversation-project");
      yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at)
        VALUES (${projectId},'Project','/project','[]','2026-01-01','2026-01-01')`;
      const meeting = {
        mode: "fixed-rounds" as const,
        phase: "planning" as const,
        threadId: ThreadId.make("conversation-a"),
        participants: [
          {
            id: WorkspaceMeetingParticipantId.make("supervisor"),
            displayName: "Supervisor",
            modelSelection: { instanceId: ProviderInstanceId.make("codex-a"), model: "model" },
          },
        ],
        chairParticipantId: WorkspaceMeetingParticipantId.make("supervisor"),
        maxRounds: 0,
        userInLoop: false,
        rounds: [],
        pendingQuestion: null,
        answers: [],
        interjections: [],
      };
      const first = {
        id: WorkspaceCollaborationRunId.make("conversation-run-a"),
        projectId,
        source: "user" as const,
        scheduleId: null,
        incidentId: null,
        task: "First task",
        status: "running" as const,
        steps: [],
        graph: null,
        meeting,
        orchestra: null,
        finalOutput: null,
        error: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      };
      const second = {
        ...first,
        id: WorkspaceCollaborationRunId.make("conversation-run-b"),
        meeting: { ...meeting, threadId: ThreadId.make("conversation-b") },
      };
      yield* repository.upsert(first);
      yield* repository.upsert(second);
      expect((yield* repository.listResumable()).map((run) => run.id).sort()).toEqual([
        first.id,
        second.id,
      ]);
      const duplicate = {
        ...first,
        id: WorkspaceCollaborationRunId.make("conversation-duplicate"),
      };
      expect(Exit.isFailure(yield* Effect.exit(repository.upsert(duplicate)))).toBe(true);
      yield* repository.upsert({ ...first, status: "cancelled" });
      yield* repository.upsert(duplicate);
      expect((yield* repository.getById({ projectId, runId: second.id }))._tag).toBe("Some");
    }),
  );

  it.effect("keeps the orchestra settings a run started with", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const repository = yield* ProjectionWorkspaceCollaborationRunRepository;
      const projectId = ProjectId.make("workspace-orchestra");
      const runId = WorkspaceCollaborationRunId.make("run-orchestra");
      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, default_model_selection_json,
          scripts_json, workspace_control_json, created_at, updated_at, deleted_at
        ) VALUES (
          ${projectId}, ${projectId}, ${`D:/${projectId}`}, NULL, '[]',
          '{"isolationMode":"strict","longTermMemoryRoot":null}',
          '2026-09-07T00:00:00.000Z', '2026-09-07T00:00:00.000Z', NULL
        )
      `;
      const run = {
        id: runId,
        projectId,
        source: "user",
        scheduleId: null,
        incidentId: null,
        task: "병렬 조사",
        status: "queued",
        steps: [],
        graph: null,
        meeting: null,
        orchestra: { maxParallel: 2, isolateWorktrees: false },
        finalOutput: null,
        error: null,
        createdAt: "2026-09-07T00:00:00.000Z",
        updatedAt: "2026-09-07T00:00:00.000Z",
      } as const;
      yield* repository.upsert(run);
      const stored = Option.getOrThrow(yield* repository.getById({ projectId, runId }));
      expect(stored.orchestra).toEqual({ maxParallel: 2, isolateWorktrees: false });
      expect(
        (yield* repository.list({ projectId })).map((candidate) => candidate.orchestra),
      ).toEqual([{ maxParallel: 2, isolateWorktrees: false }]);
    }),
  );
});
