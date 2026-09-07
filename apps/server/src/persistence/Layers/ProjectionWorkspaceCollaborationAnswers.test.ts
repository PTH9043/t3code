import {
  ProjectId,
  EventId,
  ProviderInstanceId,
  WorkspaceCollaborationRunId,
  WorkspaceMeetingParticipantId,
  WorkspaceTaskNodeId,
  type WorkspaceCollaborationRun,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ProjectionWorkspaceCollaborationRunRepository } from "../Services/ProjectionWorkspaceCollaborationRuns.ts";
import { ProjectionWorkspaceCollaborationRunRepositoryLive } from "./ProjectionWorkspaceCollaborationRuns.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { ServerConfig } from "../../config.ts";
import { OrchestrationProjectionPipelineLive } from "../../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionPipeline } from "../../orchestration/Services/ProjectionPipeline.ts";
import { OrchestrationEventStoreLive } from "./OrchestrationEventStore.ts";

const testLayer = ProjectionWorkspaceCollaborationRunRepositoryLive.pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
);
const projectionLayer = OrchestrationProjectionPipelineLive.pipe(
  Layer.provide(OrchestrationEventStoreLive),
  Layer.provideMerge(testLayer),
  Layer.provide(ServerConfig.layerTest("D:/questions", { prefix: "t3-orchestra-answer-test-" })),
  Layer.provide(NodeServices.layer),
);
const at = "2026-09-07T00:00:00.000Z";
const nextAt = "2026-09-07T00:01:00.000Z";
const seed = Effect.fn("seedCollaborationQuestion")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const repository = yield* ProjectionWorkspaceCollaborationRunRepository;
  const projectId = ProjectId.make("question-project");
  const runId = WorkspaceCollaborationRunId.make("question-run");
  yield* sql`INSERT INTO projection_projects (
    project_id, title, workspace_root, default_model_selection_json,
    scripts_json, workspace_control_json, created_at, updated_at, deleted_at
  ) VALUES (
    ${projectId}, 'Questions', 'D:/questions', NULL, '[]',
    '{"isolationMode":"strict","longTermMemoryRoot":null}', ${at}, ${at}, NULL
  )`;
  const pending = {
    askedByParticipantId: WorkspaceMeetingParticipantId.make("seat-a"),
    nodeId: WorkspaceTaskNodeId.make("node-a"),
    question: "계속할까요?",
    options: ["계속", "건너뛰기"],
    context: "",
    askedAt: at,
  };
  const run: WorkspaceCollaborationRun = {
    id: runId,
    projectId,
    source: "user",
    scheduleId: null,
    incidentId: null,
    task: "parallel questions",
    status: "running",
    steps: [],
    graph: null,
    orchestra: { maxParallel: 2, isolateWorktrees: false },
    meeting: {
      mode: "fixed-rounds",
      phase: "executing",
      threadId: null,
      participants: ["a", "b"].map((id) => ({
        id: WorkspaceMeetingParticipantId.make(`seat-${id}`),
        displayName: id,
        modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "test" },
      })),
      chairParticipantId: null,
      maxRounds: 0,
      userInLoop: false,
      rounds: [],
      pendingQuestion: pending,
      answers: [],
      interjections: [],
    },
    finalOutput: null,
    error: null,
    createdAt: at,
    updatedAt: at,
  };
  yield* repository.upsert(run);
  const lookup = { projectId, runId };
  const read = repository.getById(lookup).pipe(Effect.map(Option.getOrThrow));
  const answer = {
    ...lookup,
    question: pending.question,
    answer: "계속",
    answeredAt: nextAt,
    questionRef: { nodeId: pending.nodeId, askedAt: pending.askedAt },
  };
  return { repository, run, pending, read, answer };
});

it.effect(
  "persists the answered node through the real SQL repository and consumes a question once",
  () =>
    Effect.gen(function* () {
      const { repository, read, answer } = yield* seed();
      yield* repository.recordAnswer(answer);
      yield* repository.recordAnswer({ ...answer, answer: "건너뛰기" });
      const stored = yield* read;
      expect(stored.meeting?.pendingQuestion).toBeNull();
      expect(stored.meeting?.answers).toEqual([
        {
          question: answer.question,
          answer: "계속",
          answeredAt: nextAt,
          nodeId: "node-a",
        },
      ]);
    }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "does not apply a stale answer to a sibling asking identical text at the same timestamp",
  () =>
    Effect.gen(function* () {
      const { repository, pending, read, answer } = yield* seed();
      yield* repository.recordAnswer(answer);
      const stored = yield* read;
      const next = { ...pending, nodeId: WorkspaceTaskNodeId.make("node-b") };
      yield* repository.upsert({
        ...stored,
        meeting: { ...stored.meeting!, pendingQuestion: next },
      });
      yield* repository.recordAnswer({ ...answer, answer: "건너뛰기" });
      const unchanged = yield* read;
      expect(unchanged.meeting?.pendingQuestion).toEqual(next);
      expect(unchanged.meeting?.answers).toHaveLength(1);
      yield* repository.recordAnswer({
        ...answer,
        answer: "건너뛰기",
        questionRef: { nodeId: next.nodeId, askedAt: next.askedAt },
      });
      expect((yield* read).meeting?.answers.map((item) => item.nodeId)).toEqual([
        "node-a",
        "node-b",
      ]);
    }).pipe(Effect.provide(testLayer)),
);

it.effect("distinguishes a repeated question from the same node by its publication time", () =>
  Effect.gen(function* () {
    const { repository, run, pending, read, answer } = yield* seed();
    const next = { ...pending, askedAt: nextAt };
    yield* repository.upsert({ ...run, meeting: { ...run.meeting!, pendingQuestion: next } });
    yield* repository.recordAnswer(answer);
    expect((yield* read).meeting?.answers).toEqual([]);
    yield* repository.recordAnswer({
      ...answer,
      questionRef: { ...answer.questionRef, askedAt: nextAt },
    });
    expect((yield* read).meeting?.pendingQuestion).toBeNull();
    expect((yield* read).meeting?.answers).toHaveLength(1);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("leaves cancelled, cancelling, completed and failed questions as history", () =>
  Effect.gen(function* () {
    const { repository, read, answer } = yield* seed();
    const sql = yield* SqlClient.SqlClient;
    for (const status of ["cancel-requested", "cancelled", "completed", "failed"] as const) {
      yield* sql`UPDATE projection_workspace_collaboration_runs SET status = ${status}`;
      expect((yield* read).status).toBe(status);
      yield* repository.recordAnswer(answer);
      expect((yield* read).meeting?.answers).toEqual([]);
    }
  }).pipe(Effect.provide(testLayer)),
);

it.effect("still replays older answer events without a question reference", () =>
  Effect.gen(function* () {
    const { repository, read, answer } = yield* seed();
    const { questionRef: _, ...legacy } = answer;
    yield* repository.recordAnswer(legacy);
    expect((yield* read).meeting?.answers[0]?.nodeId).toBe("node-a");
  }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "projects answer identity through the real event pipeline before recording a decision",
  () =>
    Effect.gen(function* () {
      const { read, answer, pending } = yield* seed();
      const pipeline = yield* OrchestrationProjectionPipeline;
      const event = {
        type: "project.collaboration-run-answered" as const,
        eventId: EventId.make("answer-event-1"),
        sequence: 1,
        aggregateKind: "project" as const,
        aggregateId: answer.projectId,
        occurredAt: nextAt,
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        payload: { ...answer, questionRef: { ...answer.questionRef, askedAt: nextAt } },
      };
      yield* pipeline.projectEvent(event);
      expect((yield* read).meeting?.pendingQuestion).toEqual(pending);
      yield* pipeline.projectEvent({
        ...event,
        eventId: EventId.make("answer-event-2"),
        sequence: 2,
        payload: answer,
      });
      expect((yield* read).meeting?.pendingQuestion).toBeNull();
      expect((yield* read).meeting?.answers[0]?.nodeId).toBe("node-a");
    }).pipe(Effect.provide(projectionLayer)),
);
