import { expect, it } from "vite-plus/test";
import {
  MessageId,
  TurnId,
  type DevelopmentGoal,
  type OrchestrationThread,
} from "@t3tools/contracts";
import { state, task } from "./workspaceDevelopmentFixtures.ts";
import {
  developmentGoalElapsed,
  developmentGoalFingerprint,
  developmentGoalLimit,
  developmentGoalRepeatedFailure,
  developmentMainCompletionConfirmed,
} from "./workspaceDevelopmentGoal.ts";

const goal: DevelopmentGoal = {
  id: "goal",
  revision: 1,
  objective: "Develop",
  acceptanceCriteria: ["tests"],
  status: "active",
  phase: "ready",
  steps: 1,
  maxSteps: 3,
  maxMinutes: 10,
  activeMilliseconds: 1000,
  activatedAt: "2026-09-30T00:00:00Z",
  pendingMessageId: null,
  runSeen: false,
  progressReported: false,
  progressFingerprint: "",
  noProgressSteps: 0,
  lastSummary: "",
  integrationId: null,
  initialIntegrationIds: [],
  startedAt: "2026-09-30T00:00:00Z",
};
it("counts active time but not time while paused", () => {
  expect(developmentGoalElapsed(goal, "2026-09-30T00:00:03Z")).toBe(4000);
  expect(developmentGoalElapsed({ ...goal, activatedAt: null }, "2026-09-30T01:00:00Z")).toBe(1000);
});

it("halts identical failures on unchanged code and allows changed evidence", () => {
  const failures = [1, 2, 3].map((index) => ({
    ...task,
    id: `failed-${index}`,
    goalId: goal.id,
    status: "failed" as const,
    failureFingerprint: "unchanged",
  }));
  expect(developmentGoalRepeatedFailure({ ...state, goal, tasks: failures })).toContain("세 번");
  expect(developmentGoalRepeatedFailure({ ...state, goal, tasks: failures.slice(1) })).toBeNull();
  expect(
    developmentGoalRepeatedFailure({
      ...state,
      goal,
      tasks: failures.map((entry, index) => ({ ...entry, failureFingerprint: String(index) })),
    }),
  ).toBeNull();
  expect(
    developmentGoalRepeatedFailure({
      ...state,
      goal,
      tasks: failures.map((entry, index) => ({ ...entry, requirementRevision: index + 1 })),
    }),
  ).toBeNull();
});

it("an explicit resume retries without old failures immediately stopping the goal again", () => {
  const oldFailures = [1, 2, 3].map((index) => ({
    ...task,
    id: `old-${index}`,
    goalId: goal.id,
    status: "failed" as const,
    failureFingerprint: "unchanged",
  }));
  const resumed = { ...goal, lastResumedAt: "2026-09-30T01:00:00Z" };
  const newFailures = oldFailures.map((entry, index) => ({
    ...entry,
    id: `new-${index}`,
    requestedAt: resumed.lastResumedAt,
  }));
  expect(
    developmentGoalRepeatedFailure({ ...state, goal: resumed, tasks: oldFailures }),
  ).toBeNull();
  expect(
    developmentGoalRepeatedFailure({
      ...state,
      goal: resumed,
      tasks: [...oldFailures, ...newFailures.slice(0, 2)],
    }),
  ).toBeNull();
  expect(
    developmentGoalRepeatedFailure({
      ...state,
      goal: resumed,
      tasks: [...oldFailures, ...newFailures],
    }),
  ).toContain("세 번");
});

it("resumed verification ignores old failures and still stops repeated new failures", () => {
  const ownedTask = { ...task, goalId: goal.id };
  const resumed = { ...goal, lastResumedAt: "2026-09-30T01:00:00Z" };
  const old = [1, 2].map((index) => ({
    id: `verification-${index}`,
    workspaceId: task.workspaceId,
    candidateSha: task.baseSha,
    targetSha: task.baseSha,
    requirementRevision: task.requirementRevision,
    generation: 1,
    status: "failed" as const,
    commands: [
      { command: "node", args: ["--test"], exitCode: 1, timedOut: false, logPath: "test.log" },
    ],
    verifiedAt: goal.startedAt,
  }));
  const current = old.map((verification, index) => ({
    ...verification,
    id: `resumed-verification-${index}`,
    verifiedAt: resumed.lastResumedAt,
  }));
  const previous = { ...state, goal: resumed, tasks: [ownedTask], verifications: old };
  expect(developmentGoalRepeatedFailure({ ...previous, goal })).toContain("검증 실패");
  expect(developmentGoalRepeatedFailure(previous)).toBeNull();
  expect(
    developmentGoalRepeatedFailure({
      ...previous,
      verifications: [...old, ...current.slice(0, 1)],
    }),
  ).toBeNull();
  expect(
    developmentGoalRepeatedFailure({ ...previous, verifications: [...old, ...current] }),
  ).toContain("검증 실패");
  expect(
    developmentGoalRepeatedFailure({
      ...previous,
      verifications: current.map((verification, index) => ({
        ...verification,
        candidateSha: String(index).repeat(40),
      })),
    }),
  ).toBeNull();
});

it("recovers a completed Main only with persisted input, output, progress and the same native session", () => {
  const turnId = TurnId.make("finished-turn");
  const inputId = MessageId.make("pending-input");
  const outputId = MessageId.make("finished-output");
  const timestamp = goal.startedAt;
  const completed: OrchestrationThread = {
    id: state.conversationId,
    projectId: state.projectId,
    title: "Main",
    modelSelection: state.ownerModels[0]!,
    runtimeMode: state.runtimeMode,
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    activities: [],
    checkpoints: [],
    proposedPlans: [],
    latestTurn: {
      turnId,
      state: "completed",
      requestedAt: timestamp,
      startedAt: timestamp,
      completedAt: timestamp,
      assistantMessageId: outputId,
    },
    session: {
      threadId: state.conversationId,
      providerName: "codex",
      status: "ready",
      activeTurnId: null,
      lastError: null,
      runtimeMode: state.runtimeMode,
      updatedAt: timestamp,
    },
    messages: [
      {
        id: inputId,
        role: "user",
        text: "approved work",
        turnId,
        streaming: false,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      {
        id: outputId,
        role: "assistant",
        text: "verified result",
        turnId,
        streaming: false,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
  };
  const pending = { ...goal, pendingMessageId: inputId, progressReported: true };
  expect(developmentMainCompletionConfirmed(pending, completed, "native", "native")).toBe(true);
  expect(developmentMainCompletionConfirmed(pending, completed, "different", "native")).toBe(false);
  expect(
    developmentMainCompletionConfirmed(
      { ...pending, progressReported: false },
      completed,
      "native",
      "native",
    ),
  ).toBe(false);
  expect(
    developmentMainCompletionConfirmed(
      pending,
      { ...completed, messages: completed.messages.slice(0, 1) },
      "native",
      "native",
    ),
  ).toBe(false);
  expect(
    developmentMainCompletionConfirmed(
      pending,
      { ...completed, latestTurn: null },
      "native",
      "native",
    ),
  ).toBe(false);
});
it("enforces independent turn, time, and no-progress limits", () => {
  expect(developmentGoalLimit(goal, "2026-09-30T00:00:03Z")).toBeNull();
  expect(developmentGoalLimit({ ...goal, steps: 3 }, "2026-09-30T00:00:03Z")).toContain("횟수");
  expect(developmentGoalLimit(goal, "2026-09-30T00:10:00Z")).toContain("시간");
  expect(developmentGoalLimit({ ...goal, noProgressSteps: 2 }, "2026-09-30T00:00:03Z")).toContain(
    "반복",
  );
});
it("reading status and updating summaries is not progress; actual task receipts and results are", () => {
  expect(
    developmentGoalFingerprint({
      ...state,
      revision: 200,
      mainObservedRevision: 199,
      mainActedRevision: 199,
    }),
  ).toBe(developmentGoalFingerprint(state));
  const queued = { ...state, tasks: [task] };
  expect(developmentGoalFingerprint(queued)).not.toBe(developmentGoalFingerprint(state));
  expect(
    developmentGoalFingerprint({
      ...queued,
      tasks: [{ ...task, status: "completed", candidateSha: "b".repeat(40) }],
    }),
  ).not.toBe(developmentGoalFingerprint(queued));
});
