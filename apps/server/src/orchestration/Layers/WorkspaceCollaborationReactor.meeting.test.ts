import {
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  MessageId,
  WorkspaceCollaborationRunId,
  WorkspaceMeetingParticipantId,
  type OrchestrationEvent,
  type OrchestrationThread,
  type WorkspaceCollaborationRun,
  type WorkspaceMeeting,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { expect, it } from "@effect/vitest";

import { ProjectionWorkspaceCollaborationRunRepository } from "../../persistence/Services/ProjectionWorkspaceCollaborationRuns.ts";
import type { ProviderInstance } from "../../provider/ProviderDriver.ts";
import { ProviderInstanceRegistry } from "../../provider/Services/ProviderInstanceRegistry.ts";
import { roundCheckInQuestion } from "../workspaceMeeting.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../Services/ProjectionSnapshotQuery.ts";
import { WorkspaceCollaborationReactor } from "../Services/WorkspaceCollaborationReactor.ts";
import { OrchestrationTurnWaitLive } from "./OrchestrationTurnWait.ts";
import { WorkspaceCollaborationReactorLive } from "./WorkspaceCollaborationReactor.ts";

const projectId = ProjectId.make("workspace-m");
const runId = WorkspaceCollaborationRunId.make("run-m");
const at = "2026-08-17T00:00:00.000Z";
const pid = (id: string) => WorkspaceMeetingParticipantId.make(id);

function meetingRun(meeting: Partial<WorkspaceMeeting> = {}): WorkspaceCollaborationRun {
  return {
    id: runId,
    projectId,
    source: "user",
    scheduleId: null,
    incidentId: null,
    task: "서버 기능 구현",
    status: "queued",
    steps: [],
    graph: null,
    meeting: {
      mode: "fixed-rounds",
      phase: "discussing",
      threadId: null,
      participants: [
        {
          id: pid("p1"),
          displayName: "Claude",
          modelSelection: {
            instanceId: ProviderInstanceId.make("claude-a"),
            model: "claude-fable",
          },
        },
        {
          id: pid("p2"),
          displayName: "Codex",
          modelSelection: { instanceId: ProviderInstanceId.make("codex-a"), model: "gpt-5" },
        },
      ],
      chairParticipantId: null,
      maxRounds: 1,
      userInLoop: false,
      rounds: [],
      pendingQuestion: null,
      answers: [],
      ...meeting,
    },
    finalOutput: null,
    error: null,
    createdAt: at,
    updatedAt: at,
  };
}

/** Scripted seats: statements, chair verdict, plan, then the graph payloads. */
function respondForMeetingPrompt(prompt: string): string {
  if (prompt.startsWith("# Workspace Meeting Statement")) {
    return prompt.includes("Seat: Claude")
      ? "서버 쪽에 구현하는 편이 맞다."
      : "동의한다. 내가 구현을 맡겠다. <t3_responds_to>p1</t3_responds_to>";
  }
  if (prompt.startsWith("# Workspace Meeting Round Close")) {
    return `<t3_chair_verdict>${JSON.stringify({
      summary: "합의: 서버 구현으로 진행하고 Codex 좌석이 구현을 맡는다.",
      consensusReached: null,
      nextSpeakerId: null,
      question: null,
    })}</t3_chair_verdict>`;
  }
  if (prompt.startsWith("# Workspace Meeting Plan")) {
    return `<t3_task_graph>${JSON.stringify({
      summary: "서버 구현 계획",
      nextAction: "구현 실행",
      nodes: [
        {
          id: "build",
          kind: "implementation",
          participantId: "p2",
          title: "서버 구현",
          task: "서버에 기능을 구현한다.",
          goal: "합의된 기능 완성",
          context: "회의 합의",
          input: "합의 내용",
          constraints: [],
          expectedOutput: "구현 결과",
          successCriteria: ["빌드 통과"],
          dependsOn: [],
          priority: 1,
        },
      ],
    })}</t3_task_graph>`;
  }
  if (prompt.includes("Return one strict receipt between <t3_validation>")) {
    return `<t3_validation>${JSON.stringify({
      verdict: "pass",
      confidence: "high",
      summary: "구현 결과를 직접 확인했다.",
      evidence: ["빌드 통과 확인"],
      failureClassification: null,
      nextAction: "종합",
      followUpNodes: [],
    })}</t3_validation>`;
  }
  if (prompt.includes("Return one strict payload between <t3_synthesis>")) {
    return `<t3_synthesis>${JSON.stringify({
      finalOutput: "회의 합의대로 구현 완료",
      confidence: "high",
      conflictDetected: false,
      nextAction: "완료",
      repairApproved: null,
      memoryCandidates: [],
    })}</t3_synthesis>`;
  }
  return "구현을 완료했다.";
}

function makeHarness(input: {
  readonly run: WorkspaceCollaborationRun;
  readonly respond: (prompt: string) => string;
}) {
  return Effect.gen(function* () {
    const runRef = yield* Ref.make(input.run);
    const threadsRef = yield* Ref.make(new Map<string, OrchestrationThread>());
    const promptsRef = yield* Ref.make<ReadonlyArray<string>>([]);
    const sessionStopsRef = yield* Ref.make(0);
    const pubsub = yield* PubSub.unbounded<OrchestrationEvent>();
    let sequence = 0;

    const dispatch: OrchestrationEngineShape["dispatch"] = (command) =>
      Effect.gen(function* () {
        sequence += 1;
        switch (command.type) {
          case "project.collaboration.run.update":
            yield* Ref.set(runRef, command.run);
            break;
          case "thread.session.stop":
            yield* Ref.update(sessionStopsRef, (count) => count + 1);
            yield* Ref.update(threadsRef, (current) => {
              const existing = current.get(command.threadId);
              if (!existing || existing.session === null) return current;
              const next = new Map(current);
              next.set(command.threadId, {
                ...existing,
                session: { ...existing.session, status: "stopped" },
              });
              return next;
            });
            break;
          case "thread.create":
            yield* Ref.update(threadsRef, (current) => {
              const next = new Map(current);
              next.set(command.threadId, {
                id: command.threadId,
                projectId: command.projectId,
                title: command.title,
                modelSelection: command.modelSelection,
                runtimeMode: command.runtimeMode,
                interactionMode: command.interactionMode,
                branch: null,
                worktreePath: null,
                latestTurn: null,
                createdAt: command.createdAt,
                updatedAt: command.createdAt,
                archivedAt: null,
                settledOverride: null,
                settledAt: null,
                deletedAt: null,
                messages: [],
                proposedPlans: [],
                activities: [],
                checkpoints: [],
                session: null,
              });
              return next;
            });
            break;
          case "thread.turn.start": {
            yield* Ref.update(promptsRef, (current) => [...current, command.message.text]);
            yield* Ref.update(threadsRef, (current) => {
              const existing = current.get(command.threadId)!;
              const next = new Map(current);
              const turnId = TurnId.make(`turn-${command.threadId}`);
              const assistantMessageId = MessageId.make(`assistant-${command.threadId}`);
              next.set(command.threadId, {
                ...existing,
                latestTurn: {
                  turnId,
                  state: "completed",
                  requestedAt: command.createdAt,
                  startedAt: command.createdAt,
                  completedAt: command.createdAt,
                  assistantMessageId,
                },
                // The provider session stays live after the turn, the way real
                // CLI sessions do — so a following turn on another provider
                // must release it first.
                session: {
                  threadId: command.threadId,
                  status: "running",
                  providerName:
                    command.modelSelection?.instanceId === "codex-a" ? "codex" : "claude",
                  ...(command.modelSelection !== undefined
                    ? { providerInstanceId: command.modelSelection.instanceId }
                    : {}),
                  runtimeMode: existing.runtimeMode,
                  activeTurnId: null,
                  lastError: null,
                  updatedAt: command.createdAt,
                },
                updatedAt: command.createdAt,
                messages: [
                  {
                    id: command.message.messageId,
                    role: "user",
                    text: command.message.text,
                    attachments: [],
                    turnId,
                    streaming: false,
                    createdAt: command.createdAt,
                    updatedAt: command.createdAt,
                  },
                  {
                    id: assistantMessageId,
                    role: "assistant",
                    text: input.respond(command.message.text),
                    attachments: [],
                    turnId,
                    streaming: false,
                    createdAt: command.createdAt,
                    updatedAt: command.createdAt,
                  },
                ],
              });
              return next;
            });
            break;
          }
          default:
            break;
        }
        return { sequence };
      });

    const engine: OrchestrationEngineShape = {
      dispatch,
      readEvents: () => Stream.empty,
      get streamDomainEvents() {
        return Stream.fromPubSub(pubsub);
      },
      latestSequence: Effect.succeed(0),
    };
    const repository = {
      upsert: (run: WorkspaceCollaborationRun) => Ref.set(runRef, run),
      requestCancel: () => Effect.void,
      recordAnswer: () => Effect.void,
      getById: ({ projectId: requestedProjectId, runId: requestedRunId }) =>
        Ref.get(runRef).pipe(
          Effect.map((run) =>
            run.projectId === requestedProjectId && run.id === requestedRunId
              ? Option.some(run)
              : Option.none(),
          ),
        ),
      list: (listInput) =>
        Ref.get(runRef).pipe(
          Effect.map((run) =>
            [run].filter(
              (candidate) =>
                candidate.projectId === listInput.projectId &&
                (listInput.statuses === undefined || listInput.statuses.includes(candidate.status)),
            ),
          ),
        ),
      listResumable: () => Ref.get(runRef).pipe(Effect.map((run) => [run])),
    } satisfies ProjectionWorkspaceCollaborationRunRepository["Service"];
    // No role bindings at all: a meeting must run on its roster alone.
    const query = {
      listWorkspaceAgentRoles: () => Effect.succeed({ roles: [] }),
      composeWorkspacePrompt: () =>
        Effect.succeed({
          prompt: "Workspace ID: workspace-m\n현재 사용자 작업: 서버 기능 구현",
          sourceItemIds: [],
          ragMatches: [],
          truncated: false,
        }),
      getThreadDetailById: (threadId: ThreadId) =>
        Ref.get(threadsRef).pipe(
          Effect.map((threads) => Option.fromNullishOr(threads.get(threadId))),
        ),
    } as unknown as ProjectionSnapshotQueryShape;
    const providerInstances = [
      {
        instanceId: ProviderInstanceId.make("claude-a"),
        driverKind: "claude",
        enabled: true,
      },
      {
        instanceId: ProviderInstanceId.make("codex-a"),
        driverKind: "codex",
        enabled: true,
      },
    ] as unknown as ReadonlyArray<ProviderInstance>;
    const providerRegistry = {
      getInstance: (instanceId: ProviderInstanceId) =>
        Effect.succeed(providerInstances.find((instance) => instance.instanceId === instanceId)),
      listInstances: Effect.succeed(providerInstances),
    } as unknown as ProviderInstanceRegistry["Service"];
    const layer = WorkspaceCollaborationReactorLive.pipe(
      Layer.provideMerge(OrchestrationTurnWaitLive),
      Layer.provideMerge(Layer.succeed(OrchestrationEngineService, engine)),
      Layer.provideMerge(Layer.succeed(ProjectionSnapshotQuery, query)),
      Layer.provideMerge(Layer.succeed(ProjectionWorkspaceCollaborationRunRepository, repository)),
      Layer.provideMerge(Layer.succeed(ProviderInstanceRegistry, providerRegistry)),
      Layer.provideMerge(NodeServices.layer),
    );
    return { runRef, promptsRef, threadsRef, sessionStopsRef, pubsub, layer };
  });
}

/** Everything here is cooperative Effect work, so yielding drives it to quiescence. */
const awaitRunStatus = (
  runRef: Ref.Ref<WorkspaceCollaborationRun>,
  status: WorkspaceCollaborationRun["status"],
  check: (run: WorkspaceCollaborationRun) => boolean = () => true,
) =>
  Effect.gen(function* () {
    for (let spin = 0; spin < 100_000; spin += 1) {
      const run = yield* Ref.get(runRef);
      if (run.status === status && check(run)) return run;
      yield* Effect.yieldNow;
    }
    return yield* Effect.die(new Error(`Run never reached status '${status}'.`));
  });

const answeredEvent = (question: string, answer: string): OrchestrationEvent =>
  ({
    type: "project.collaboration-run-answered",
    payload: { projectId, runId, question, answer, answeredAt: at },
  }) as unknown as OrchestrationEvent;

it.effect("runs the meeting, plans onto the roster, and executes with the same seats", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness({ run: meetingRun(), respond: respondForMeetingPrompt });

    yield* Effect.gen(function* () {
      const reactor = yield* Effect.service(WorkspaceCollaborationReactor);
      yield* reactor.start();
      yield* reactor.drain;

      const run = yield* Ref.get(harness.runRef);
      expect(run.status).toBe("completed");
      expect(run.finalOutput).toBe("회의 합의대로 구현 완료");
      expect(run.meeting?.phase).toBe("done");

      const round = run.meeting?.rounds[0];
      expect(round?.statements.map((statement) => statement.participantId)).toEqual(["p1", "p2"]);
      expect(round?.statements[1]?.respondsTo).toEqual(["p1"]);
      expect(round?.statements.every((statement) => statement.threadId !== null)).toBe(true);
      expect(round?.chairSummary).toContain("합의: 서버 구현으로 진행");

      // The whole meeting — every seat's statements, the chair's duties, the
      // execution — lives in ONE conversation.
      const meetingThread = run.meeting?.threadId ?? null;
      expect(meetingThread).not.toBeNull();
      expect(round?.statements.every((statement) => statement.threadId === meetingThread)).toBe(
        true,
      );
      expect((yield* Ref.get(harness.threadsRef)).size).toBe(1);
      // Handing the conversation between providers released the live session
      // each time the speaker's driver changed.
      expect(yield* Ref.get(harness.sessionStopsRef)).toBeGreaterThanOrEqual(3);

      const nodes = new Map(run.graph?.nodes.map((node) => [String(node.id), node]));
      expect(run.graph?.status).toBe("completed");
      expect(nodes.get("plan")).toMatchObject({ status: "completed", participantId: "p1" });
      expect(nodes.get("plan")?.output).toContain("## 회의 합의");
      expect(nodes.get("build")).toMatchObject({
        status: "completed",
        participantId: "p2",
        agent: "codex",
        confidence: "high",
      });
      expect(nodes.get("validate-build")?.participantId).toBe("p1");
      expect(run.graph?.nodes.find((node) => node.kind === "synthesis")?.participantId).toBe("p1");
      expect(
        nodes.get("build")?.attempts.map((attempt) => attempt.modelSelection.instanceId),
      ).toEqual(["codex-a"]);
      expect(nodes.get("build")?.attempts[0]?.threadId).toBe(meetingThread);
      expect(nodes.get("validate-build")?.attempts[0]?.threadId).toBe(meetingThread);
      expect(
        run.graph?.nodes.find((node) => node.kind === "synthesis")?.attempts[0]?.threadId,
      ).toBe(meetingThread);
      expect(run.steps.map((step) => step.displayName)).toContain("Codex");

      const prompts = yield* Ref.get(harness.promptsRef);
      expect(prompts).toHaveLength(7);
      // Only the opening statements pay for the workspace corpus.
      expect(prompts[0]).toContain("## Workspace context");
      const closePrompt = prompts.find((prompt) =>
        prompt.startsWith("# Workspace Meeting Round Close"),
      );
      expect(closePrompt).toContain("### Claude");
      const planPrompt = prompts.find((prompt) => prompt.startsWith("# Workspace Meeting Plan"));
      expect(planPrompt).toContain("- p2: Codex (gpt-5)");
      const buildPrompt = prompts.find((prompt) => prompt.includes("Node: build\n"));
      expect(buildPrompt).toContain("Participant: Codex (p2)");
      expect(buildPrompt).toContain("p1: Claude -> claude-a / claude-fable");
    }).pipe(Effect.provide(harness.layer), Effect.scoped);
  }),
);

it.effect("parks on the round check-in and resumes when the person answers", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness({
      run: meetingRun({ userInLoop: true }),
      respond: respondForMeetingPrompt,
    });

    yield* Effect.gen(function* () {
      const reactor = yield* Effect.service(WorkspaceCollaborationReactor);
      yield* reactor.start();
      yield* reactor.drain;

      const parked = yield* Ref.get(harness.runRef);
      expect(parked.status).toBe("running");
      expect(parked.graph).toBeNull();
      expect(parked.meeting?.pendingQuestion).toMatchObject({
        askedByParticipantId: null,
        question: roundCheckInQuestion(0),
        options: ["계속 진행", "방향 수정"],
      });
      expect(parked.meeting?.pendingQuestion?.context).toContain("합의: 서버 구현으로 진행");

      // The projection applies the answer before the event is published.
      yield* Ref.update(harness.runRef, (run) => ({
        ...run,
        meeting: {
          ...run.meeting!,
          pendingQuestion: null,
          answers: [{ question: roundCheckInQuestion(0), answer: "계속 진행", answeredAt: at }],
        },
      }));
      yield* PubSub.publish(harness.pubsub, answeredEvent(roundCheckInQuestion(0), "계속 진행"));

      const resumed = yield* awaitRunStatus(harness.runRef, "completed");
      expect(resumed.meeting?.phase).toBe("done");
      expect(resumed.finalOutput).toBe("회의 합의대로 구현 완료");
      expect(resumed.meeting?.answers).toHaveLength(1);

      const prompts = yield* Ref.get(harness.promptsRef);
      const planPrompt = prompts.find((prompt) => prompt.startsWith("# Workspace Meeting Plan"));
      expect(planPrompt).toContain("## 사용자 결정");
      expect(planPrompt).toContain("계속 진행");
      const buildPrompt = prompts.find((prompt) => prompt.includes("Node: build\n"));
      expect(buildPrompt).toContain("USER DECISIONS:");
    }).pipe(Effect.provide(harness.layer), Effect.scoped);
  }),
);

it.effect("finalizes a parked run when the person cancels instead of answering", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness({
      run: meetingRun({ userInLoop: true }),
      respond: respondForMeetingPrompt,
    });

    yield* Effect.gen(function* () {
      const reactor = yield* Effect.service(WorkspaceCollaborationReactor);
      yield* reactor.start();
      yield* reactor.drain;

      const parked = yield* Ref.get(harness.runRef);
      expect(parked.status).toBe("running");
      expect(parked.meeting?.pendingQuestion).not.toBeNull();

      // The projection flips the status before the event is published.
      yield* Ref.update(harness.runRef, (run) => ({
        ...run,
        status: "cancel-requested" as const,
      }));
      yield* PubSub.publish(harness.pubsub, {
        type: "project.collaboration-run-cancel-requested",
        payload: { projectId, runId, cancelledAt: at },
      } as unknown as OrchestrationEvent);

      const cancelled = yield* awaitRunStatus(harness.runRef, "cancelled");
      expect(cancelled.error).toBeNull();
    }).pipe(Effect.provide(harness.layer), Effect.scoped);
  }),
);

it.effect("parks a node whose seat asks the person and re-runs it with the answer", () =>
  Effect.gen(function* () {
    const question = "DB는 어느 것으로 할까요?";
    const harness = yield* makeHarness({
      run: meetingRun(),
      respond: (prompt) => {
        if (prompt.includes("Node: build\n")) {
          return prompt.includes("USER DECISIONS:")
            ? "SQLite 결정을 반영해 구현을 완료했다."
            : `<t3_question>${JSON.stringify({
                question,
                options: ["SQLite", "Postgres"],
                context: "저장소 선택이 남았다.",
              })}</t3_question>`;
        }
        return respondForMeetingPrompt(prompt);
      },
    });

    yield* Effect.gen(function* () {
      const reactor = yield* Effect.service(WorkspaceCollaborationReactor);
      yield* reactor.start();
      yield* reactor.drain;

      const parked = yield* Ref.get(harness.runRef);
      expect(parked.status).toBe("running");
      expect(parked.meeting?.pendingQuestion).toMatchObject({
        askedByParticipantId: "p2",
        question,
        options: ["SQLite", "Postgres"],
      });
      const parkedBuild = parked.graph?.nodes.find((node) => node.id === "build");
      expect(parkedBuild?.status).toBe("awaiting-user");
      expect(parkedBuild?.attempts).toHaveLength(1);
      expect(parkedBuild?.attempts[0]?.status).toBe("completed");

      yield* Ref.update(harness.runRef, (run) => ({
        ...run,
        meeting: {
          ...run.meeting!,
          pendingQuestion: null,
          answers: [{ question, answer: "SQLite", answeredAt: at }],
        },
      }));
      yield* PubSub.publish(harness.pubsub, answeredEvent(question, "SQLite"));

      const resumed = yield* awaitRunStatus(harness.runRef, "completed");
      const build = resumed.graph?.nodes.find((node) => node.id === "build");
      expect(build?.status).toBe("completed");
      expect(build?.output).toContain("SQLite 결정");
      expect(build?.attempts).toHaveLength(2);
      expect(build?.attempts[1]?.strategy).toContain("Resume after the user's answer");
      // The seat never switches accounts, even across the re-run.
      expect(
        build?.attempts.every((attempt) => attempt.modelSelection.instanceId === "codex-a"),
      ).toBe(true);
      // Both attempts continue the meeting's single conversation.
      const meetingThread = resumed.meeting?.threadId;
      expect(build?.attempts.every((attempt) => attempt.threadId === meetingThread)).toBe(true);
      expect((yield* Ref.get(harness.threadsRef)).size).toBe(1);
      expect(resumed.meeting?.phase).toBe("done");
    }).pipe(Effect.provide(harness.layer), Effect.scoped);
  }),
);
