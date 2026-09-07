import {
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  MessageId,
  WorkspaceCollaborationRunId,
  WorkspaceMeetingParticipantId,
  WorkspaceTaskNodeId,
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

import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import { ProjectionWorkspaceCollaborationRunRepository } from "../../persistence/Services/ProjectionWorkspaceCollaborationRuns.ts";
import type { ProviderInstance } from "../../provider/ProviderDriver.ts";
import { ProviderInstanceRegistry } from "../../provider/Services/ProviderInstanceRegistry.ts";
import {
  meetingWrapUpQuestion,
  nodeInterventionQuestion,
  roundCheckInQuestion,
} from "../workspaceMeeting.ts";
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
      interjections: [],
      ...meeting,
    },
    orchestra: null,
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
  /**
   * Mutable on purpose: the projection writes interjections outside the run
   * snapshot, so the fake mirrors that by grafting this array onto every read.
   * A test pushes into it from `respond` to interject mid-round.
   */
  readonly liveInterjections?: WorkspaceMeeting["interjections"][number][];
}) {
  return Effect.gen(function* () {
    const liveInterjections = input.liveInterjections ?? [];
    const withLiveInterjections = (run: WorkspaceCollaborationRun): WorkspaceCollaborationRun =>
      run.meeting === null
        ? run
        : { ...run, meeting: { ...run.meeting, interjections: [...liveInterjections] } };
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
      recordInterjection: () => Effect.void,
      getById: ({ projectId: requestedProjectId, runId: requestedRunId }) =>
        Ref.get(runRef).pipe(
          Effect.map((run) =>
            run.projectId === requestedProjectId && run.id === requestedRunId
              ? Option.some(withLiveInterjections(run))
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
      Layer.provideMerge(
        Layer.succeed(ProjectionTurnRepository, {
          getByTurnId: () => Effect.succeed(Option.none()),
        } as unknown as ProjectionTurnRepository["Service"]),
      ),
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

/** A pre-recorded "go ahead and execute" for the end-of-discussion gate. */
const executeWrapUp = (roundCount: number) => ({
  question: meetingWrapUpQuestion(roundCount),
  answer: "합의대로 실행 시작",
  answeredAt: at,
  nodeId: null,
});

it.effect("runs the meeting, plans onto the roster, and executes with the same seats", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness({
      run: meetingRun({ answers: [executeWrapUp(1)] }),
      respond: respondForMeetingPrompt,
    });

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

it.effect("holds the meeting in the conversation the person sent it from", () =>
  Effect.gen(function* () {
    const existingThreadId = ThreadId.make("thread-existing");
    const harness = yield* makeHarness({
      run: meetingRun({ threadId: existingThreadId, answers: [executeWrapUp(1)] }),
      respond: respondForMeetingPrompt,
    });
    // The person's conversation predates the meeting; its title is theirs.
    yield* Ref.update(harness.threadsRef, (current) => {
      const next = new Map(current);
      next.set(existingThreadId, {
        id: existingThreadId,
        projectId,
        title: "내 원래 대화",
        modelSelection: {
          instanceId: ProviderInstanceId.make("claude-a"),
          model: "claude-fable",
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        latestTurn: null,
        createdAt: at,
        updatedAt: at,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        deletedAt: null,
        messages: [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        session: null,
      } as unknown as OrchestrationThread);
      return next;
    });

    yield* Effect.gen(function* () {
      const reactor = yield* Effect.service(WorkspaceCollaborationReactor);
      yield* reactor.start();
      yield* reactor.drain;

      const run = yield* Ref.get(harness.runRef);
      expect(run.status).toBe("completed");
      expect(run.meeting?.threadId).toBe(existingThreadId);

      const threads = yield* Ref.get(harness.threadsRef);
      // No fresh thread was opened, and the person's title survived.
      expect(threads.size).toBe(1);
      expect(threads.get(existingThreadId)?.title).toBe("내 원래 대화");
      expect(
        run.meeting?.rounds[0]?.statements.every(
          (statement) => statement.threadId === existingThreadId,
        ),
      ).toBe(true);
    }).pipe(Effect.provide(harness.layer), Effect.scoped);
  }),
);

it.effect("hands a mid-round interjection to the very next speaker", () =>
  Effect.gen(function* () {
    const liveInterjections: WorkspaceMeeting["interjections"][number][] = [];
    const harness = yield* makeHarness({
      run: meetingRun({ answers: [executeWrapUp(1)] }),
      // The person speaks up while the first seat is mid-turn; the projection
      // (faked by liveInterjections) has recorded it by the time the reactor
      // reloads the run for the second seat.
      respond: (prompt) => {
        if (prompt.startsWith("# Workspace Meeting Statement") && prompt.includes("Seat: Claude")) {
          liveInterjections.push({
            text: "긴급: 예산은 무료 티어로 한정해줘",
            roundIndex: 0,
            afterStatements: 1,
            saidAt: at,
          });
        }
        return respondForMeetingPrompt(prompt);
      },
      liveInterjections,
    });

    yield* Effect.gen(function* () {
      const reactor = yield* Effect.service(WorkspaceCollaborationReactor);
      yield* reactor.start();
      yield* reactor.drain;

      const run = yield* Ref.get(harness.runRef);
      expect(run.status).toBe("completed");

      const prompts = yield* Ref.get(harness.promptsRef);
      const claudePrompt = prompts.find((prompt) => prompt.includes("Seat: Claude"));
      const codexPrompt = prompts.find((prompt) => prompt.includes("Seat: Codex"));
      // The first seat spoke before the person did; the second seat reads the
      // interjection inside the transcript, in arrival order.
      expect(claudePrompt).not.toContain("긴급: 예산은 무료 티어로 한정해줘");
      expect(codexPrompt).toContain("사용자 (개입)");
      expect(codexPrompt).toContain("긴급: 예산은 무료 티어로 한정해줘");
    }).pipe(Effect.provide(harness.layer), Effect.scoped);
  }),
);

it.effect("parks on the round check-in and resumes when the person answers", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness({
      run: meetingRun({ userInLoop: true, answers: [executeWrapUp(1)] }),
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
          answers: [
            executeWrapUp(1),
            {
              question: roundCheckInQuestion(0),
              answer: "계속 진행",
              answeredAt: at,
              nodeId: null,
            },
          ],
        },
      }));
      yield* PubSub.publish(harness.pubsub, answeredEvent(roundCheckInQuestion(0), "계속 진행"));

      const resumed = yield* awaitRunStatus(harness.runRef, "completed");
      expect(resumed.meeting?.phase).toBe("done");
      expect(resumed.finalOutput).toBe("회의 합의대로 구현 완료");
      expect(resumed.meeting?.answers).toHaveLength(2);

      const prompts = yield* Ref.get(harness.promptsRef);
      const planPrompt = prompts.find((prompt) => prompt.startsWith("# Workspace Meeting Plan"));
      expect(planPrompt).toContain("## 사용자 결정");
      expect(planPrompt).toContain("계속 진행");
      const buildPrompt = prompts.find((prompt) => prompt.includes("Node: build\n"));
      expect(buildPrompt).toContain("USER DECISIONS:");
    }).pipe(Effect.provide(harness.layer), Effect.scoped);
  }),
);

it.effect("parks at the wrap-up gate and concludes without execution when the person stops", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness({ run: meetingRun(), respond: respondForMeetingPrompt });

    yield* Effect.gen(function* () {
      const reactor = yield* Effect.service(WorkspaceCollaborationReactor);
      yield* reactor.start();
      yield* reactor.drain;

      // The round budget is spent: no plan, no graph — the run waits on the person.
      const parked = yield* Ref.get(harness.runRef);
      expect(parked.status).toBe("running");
      expect(parked.graph).toBeNull();
      expect(parked.meeting?.pendingQuestion).toMatchObject({
        askedByParticipantId: null,
        question: meetingWrapUpQuestion(1),
        options: ["합의대로 실행 시작", "라운드 1회 추가", "여기서 종료 (실행 없음)"],
      });
      expect(parked.meeting?.pendingQuestion?.context).toContain("합의: 서버 구현으로 진행");

      // The projection applies the answer before the event is published.
      yield* Ref.update(harness.runRef, (run) => ({
        ...run,
        meeting: {
          ...run.meeting!,
          pendingQuestion: null,
          answers: [
            {
              question: meetingWrapUpQuestion(1),
              answer: "여기서 종료 (실행 없음)",
              answeredAt: at,
              nodeId: null,
            },
          ],
        },
      }));
      yield* PubSub.publish(
        harness.pubsub,
        answeredEvent(meetingWrapUpQuestion(1), "여기서 종료 (실행 없음)"),
      );

      const concluded = yield* awaitRunStatus(harness.runRef, "completed");
      expect(concluded.graph).toBeNull();
      expect(concluded.meeting?.phase).toBe("done");
      expect(concluded.finalOutput).toContain("## 회의 결론");
      expect(concluded.finalOutput).toContain("합의: 서버 구현으로 진행");
      expect(concluded.finalOutput).toContain("## 회의 전문");
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
      run: meetingRun({ answers: [executeWrapUp(1)] }),
      respond: (prompt) => {
        if (prompt.includes("Node: build\n")) {
          // The wrap-up answer already renders a USER DECISIONS section into
          // every node prompt, so the park/resume split keys on the node's
          // own answer instead.
          return prompt.includes("SQLite")
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
          answers: [{ question, answer: "SQLite", answeredAt: at, nodeId: null }],
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

it.effect("parks on the node instead of failing the run when its retries run out", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness({
      run: meetingRun({ answers: [executeWrapUp(1)] }),
      respond: (prompt) =>
        // The validator answers in prose, so the receipt never parses. This is
        // the shape of the production failure ("Missing <t3_validation> JSON
        // payload."): a formatting miss, not a wrong plan.
        prompt.includes("Return one strict receipt between <t3_validation>")
          ? "구현은 괜찮아 보인다."
          : respondForMeetingPrompt(prompt),
    });

    yield* Effect.gen(function* () {
      const reactor = yield* Effect.service(WorkspaceCollaborationReactor);
      yield* reactor.start();
      yield* reactor.drain;

      const parked = yield* Ref.get(harness.runRef);
      const validation = parked.graph?.nodes.find((node) => node.kind === "validation");
      expect(validation).toBeDefined();
      // The run is alive and waiting ON the node, with every earlier node kept.
      expect(parked.status).toBe("running");
      expect(validation?.status).toBe("awaiting-user");
      expect(parked.graph?.status).not.toBe("failed");
      expect(parked.graph?.nodes.find((node) => node.id === "build")?.status).toBe(
        "awaiting-validation",
      );
      expect(parked.meeting?.pendingQuestion).toMatchObject({
        question: nodeInterventionQuestion(validation!.title),
      });
      expect(parked.meeting?.pendingQuestion?.context).toContain("<t3_validation>");
      // It spent its own attempts, but a malformed reply is re-askable for
      // free, so the shared plan-revision budget is untouched.
      expect(validation?.attempts).toHaveLength(validation!.maxAttempts);
      // Still the planned graph's own revision: both rejected receipts would
      // otherwise have charged it, which is what stranded real runs on
      // "Task graph revision limit N has been reached."
      expect(parked.graph?.revision).toBe(1);
      // The retry told the seat what was wrong instead of re-sending the
      // identical prompt.
      const prompts = yield* Ref.get(harness.promptsRef);
      expect(prompts.some((prompt) => prompt.includes("WAS REJECTED:"))).toBe(true);

      const question = parked.meeting!.pendingQuestion!.question;
      const answer = "이 단계 건너뛰고 계속";
      yield* Ref.update(harness.runRef, (run) => ({
        ...run,
        meeting: {
          ...run.meeting!,
          pendingQuestion: null,
          answers: [...run.meeting!.answers, { question, answer, answeredAt: at, nodeId: null }],
        },
      }));
      yield* PubSub.publish(harness.pubsub, answeredEvent(question, answer));

      const resumed = yield* awaitRunStatus(harness.runRef, "completed");
      const skipped = resumed.graph?.nodes.find((node) => node.kind === "validation");
      expect(skipped?.status).toBe("completed");
      expect(skipped?.output).toContain("건너뛰");
    }).pipe(Effect.provide(harness.layer), Effect.scoped);
  }),
);

it.effect("still retries a node when the person's revision budget is 1", () =>
  Effect.gen(function* () {
    let receipts = 0;
    const harness = yield* makeHarness({
      // The tightest budget a person can set. It used to leave a run with no
      // retry at all — the plan already sits on revision 1 — so the very first
      // rejected reply ended it.
      run: meetingRun({ maxRevisions: 1, answers: [executeWrapUp(1)] }),
      respond: (prompt) => {
        if (prompt.includes("Return one strict receipt between <t3_validation>")) {
          receipts += 1;
          if (receipts === 1) return "구현은 괜찮아 보인다.";
        }
        return respondForMeetingPrompt(prompt);
      },
    });

    yield* Effect.gen(function* () {
      const reactor = yield* Effect.service(WorkspaceCollaborationReactor);
      yield* reactor.start();
      yield* reactor.drain;

      const run = yield* awaitRunStatus(harness.runRef, "completed");
      const validation = run.graph?.nodes.find((node) => node.kind === "validation");
      expect(validation?.status).toBe("completed");
      expect(validation?.attempts).toHaveLength(2);
      expect(validation?.attempts[0]?.status).toBe("failed");
    }).pipe(Effect.provide(harness.layer), Effect.scoped);
  }),
);

it.effect("hands a parked node to another seat when the person asks for one", () =>
  Effect.gen(function* () {
    let receipts = 0;
    const harness = yield* makeHarness({
      run: meetingRun({ answers: [executeWrapUp(1)] }),
      respond: (prompt) => {
        if (prompt.includes("Return one strict receipt between <t3_validation>")) {
          receipts += 1;
          // Rejected on the chair's seat until the node moves to the other one.
          if (receipts <= 2) return "구현은 괜찮아 보인다.";
        }
        return respondForMeetingPrompt(prompt);
      },
    });

    yield* Effect.gen(function* () {
      const reactor = yield* Effect.service(WorkspaceCollaborationReactor);
      yield* reactor.start();
      yield* reactor.drain;

      const parked = yield* Ref.get(harness.runRef);
      const validation = parked.graph?.nodes.find((node) => node.kind === "validation");
      expect(validation?.status).toBe("awaiting-user");
      expect(parked.meeting?.pendingQuestion?.options).toContain("다른 좌석에게 맡기기");
      const seatBefore = validation?.participantId;

      const question = parked.meeting!.pendingQuestion!.question;
      const answer = "다른 좌석에게 맡기기";
      yield* Ref.update(harness.runRef, (run) => ({
        ...run,
        meeting: {
          ...run.meeting!,
          pendingQuestion: null,
          answers: [...run.meeting!.answers, { question, answer, answeredAt: at, nodeId: null }],
        },
      }));
      yield* PubSub.publish(harness.pubsub, answeredEvent(question, answer));

      const resumed = yield* awaitRunStatus(harness.runRef, "completed");
      const moved = resumed.graph?.nodes.find((node) => node.kind === "validation");
      expect(moved?.status).toBe("completed");
      // A seat the person already picked — never an account outside the meeting.
      expect(moved?.participantId).not.toBe(seatBefore);
      expect(
        resumed.meeting?.participants.some(
          (participant) => participant.id === moved?.participantId,
        ),
      ).toBe(true);
    }).pipe(Effect.provide(harness.layer), Effect.scoped);
  }),
);

/** Two independent research nodes, one per seat, for the orchestra tests. */
function respondForOrchestraPrompt(prompt: string): string {
  if (prompt.startsWith("# Workspace Meeting Plan")) {
    return `<t3_task_graph>${JSON.stringify({
      summary: "조사 계획",
      nextAction: "조사 실행",
      nodes: ["p1", "p2"].map((participantId, index) => ({
        id: `research-${participantId}`,
        kind: "research",
        participantId,
        title: `조사 ${index + 1}`,
        task: "조사한다.",
        goal: "근거 확보",
        context: "회의 합의",
        input: "합의 내용",
        constraints: [],
        expectedOutput: "조사 결과",
        successCriteria: ["근거 제시"],
        dependsOn: [],
        priority: 1,
      })),
    })}</t3_task_graph>`;
  }
  return respondForMeetingPrompt(prompt);
}

const orchestraRun = (meeting: Partial<WorkspaceMeeting> = {}): WorkspaceCollaborationRun => ({
  ...meetingRun({ answers: [executeWrapUp(1)], ...meeting }),
  orchestra: { maxParallel: 2, isolateWorktrees: false },
});

const seatQuestion = (question: string) =>
  `<t3_question>${JSON.stringify({ question, options: ["A", "B"], context: "선택이 남았다." })}</t3_question>`;

it.effect("orchestra: runs nodes side by side, each in its own fixed conversation", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness({
      run: orchestraRun(),
      respond: respondForOrchestraPrompt,
    });

    yield* Effect.gen(function* () {
      const reactor = yield* Effect.service(WorkspaceCollaborationReactor);
      yield* reactor.start();
      yield* reactor.drain;

      const done = yield* Ref.get(harness.runRef);
      expect(done.status).toBe("completed");
      const nodes = done.graph?.nodes.filter((node) => node.kind === "research") ?? [];
      expect(nodes).toHaveLength(2);
      const meetingThread = done.meeting?.threadId;
      for (const node of nodes) {
        // The node's conversation is its own, not the meeting's.
        expect(node.threadId).not.toBeNull();
        expect(node.threadId).not.toBe(meetingThread);
        expect(node.attempts.every((attempt) => attempt.threadId === node.threadId)).toBe(true);
      }
      expect(new Set(nodes.map((node) => node.threadId)).size).toBe(2);
      // Both research prompts were issued in the same wave: the second one
      // went out before either result could have been applied.
      const prompts = yield* Ref.get(harness.promptsRef);
      const researchPrompts = prompts.filter((prompt) => prompt.includes("Node: research-"));
      expect(researchPrompts).toHaveLength(2);
    }).pipe(Effect.provide(harness.layer), Effect.scoped);
  }),
);

it.effect(
  "orchestra: binds a seat's question to its node and resumes only that node on its own thread",
  () =>
    Effect.gen(function* () {
      const question = "조사 범위는 어디까지?";
      let asked = false;
      const harness = yield* makeHarness({
        run: orchestraRun(),
        respond: (prompt) => {
          if (prompt.includes("Node: research-p1\n") && !asked) {
            asked = true;
            return seatQuestion(question);
          }
          if (prompt.includes("Node: research-p1\n")) {
            // Only this node's own decision reaches it.
            expect(prompt).toContain(`A: 전체 범위`);
            return "전체 범위로 조사를 마쳤다.";
          }
          if (prompt.includes("Node: research-p2\n")) {
            expect(prompt).not.toContain("전체 범위");
            return "조사를 마쳤다.";
          }
          return respondForOrchestraPrompt(prompt);
        },
      });

      yield* Effect.gen(function* () {
        const reactor = yield* Effect.service(WorkspaceCollaborationReactor);
        yield* reactor.start();
        yield* reactor.drain;

        const parked = yield* Ref.get(harness.runRef);
        expect(parked.status).toBe("running");
        expect(parked.meeting?.pendingQuestion).toMatchObject({
          askedByParticipantId: "p1",
          question,
          nodeId: "research-p1",
        });
        const p1 = parked.graph?.nodes.find((node) => node.id === "research-p1");
        const p2 = parked.graph?.nodes.find((node) => node.id === "research-p2");
        expect(p1?.status).toBe("awaiting-user");
        expect(p1?.parkedQuestion).toBeNull();
        // The sibling finished in the same wave and was not held by p1's question.
        expect(p2?.status).not.toBe("awaiting-user");
        const p1Thread = p1?.threadId;
        expect(p1Thread).not.toBeNull();

        yield* Ref.update(harness.runRef, (run) => ({
          ...run,
          meeting: {
            ...run.meeting!,
            pendingQuestion: null,
            answers: [
              ...run.meeting!.answers,
              {
                question,
                answer: "전체 범위",
                answeredAt: at,
                nodeId: WorkspaceTaskNodeId.make("research-p1"),
              },
            ],
          },
        }));
        yield* PubSub.publish(harness.pubsub, answeredEvent(question, "전체 범위"));

        const resumed = yield* awaitRunStatus(harness.runRef, "completed");
        const resumedP1 = resumed.graph?.nodes.find((node) => node.id === "research-p1");
        expect(resumedP1?.status).toBe("completed");
        expect(resumedP1?.attempts).toHaveLength(2);
        // Same conversation before and after the park.
        expect(resumedP1?.threadId).toBe(p1Thread);
        expect(resumedP1?.attempts.every((attempt) => attempt.threadId === p1Thread)).toBe(true);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
);

it.effect(
  "orchestra: a second question waits on its node and is asked once the first is answered",
  () =>
    Effect.gen(function* () {
      const questionA = "p1 질문";
      const questionB = "p2 질문";
      const askedFor = new Set<string>();
      const harness = yield* makeHarness({
        run: orchestraRun(),
        respond: (prompt) => {
          for (const participantId of ["p1", "p2"]) {
            if (!prompt.includes(`Node: research-${participantId}\n`)) continue;
            if (askedFor.has(participantId)) return `${participantId} 조사를 마쳤다.`;
            askedFor.add(participantId);
            return seatQuestion(participantId === "p1" ? questionA : questionB);
          }
          return respondForOrchestraPrompt(prompt);
        },
      });

      yield* Effect.gen(function* () {
        const reactor = yield* Effect.service(WorkspaceCollaborationReactor);
        yield* reactor.start();
        yield* reactor.drain;

        const parked = yield* Ref.get(harness.runRef);
        const pending = parked.meeting?.pendingQuestion;
        expect(pending?.nodeId).not.toBeNull();
        const firstId = pending!.nodeId!;
        const secondId = firstId === "research-p1" ? "research-p2" : "research-p1";
        const second = parked.graph?.nodes.find((node) => node.id === secondId);
        // Both asked in one wave: one holds the slot, the other keeps its
        // question on the node instead of losing it.
        expect(second?.status).toBe("awaiting-user");
        expect(second?.parkedQuestion?.question).toBe(
          secondId === "research-p1" ? questionA : questionB,
        );

        yield* Ref.update(harness.runRef, (run) => ({
          ...run,
          meeting: {
            ...run.meeting!,
            pendingQuestion: null,
            answers: [
              ...run.meeting!.answers,
              { question: pending!.question, answer: "A", answeredAt: at, nodeId: firstId },
            ],
          },
        }));
        yield* PubSub.publish(harness.pubsub, answeredEvent(pending!.question, "A"));

        // The slot frees and the parked question is published for its own node.
        const republished = yield* awaitRunStatus(
          harness.runRef,
          "running",
          (run) => run.meeting?.pendingQuestion?.nodeId === secondId,
        );
        const secondNow = republished.graph?.nodes.find((node) => node.id === secondId);
        expect(secondNow?.parkedQuestion).toBeNull();
        expect(secondNow?.status).toBe("awaiting-user");
        const firstNow = republished.graph?.nodes.find((node) => node.id === firstId);
        expect(firstNow?.status).not.toBe("awaiting-user");

        const secondQuestion = republished.meeting!.pendingQuestion!.question;
        yield* Ref.update(harness.runRef, (run) => ({
          ...run,
          meeting: {
            ...run.meeting!,
            pendingQuestion: null,
            answers: [
              ...run.meeting!.answers,
              {
                question: secondQuestion,
                answer: "B",
                answeredAt: at,
                nodeId: WorkspaceTaskNodeId.make(secondId),
              },
            ],
          },
        }));
        yield* PubSub.publish(harness.pubsub, answeredEvent(secondQuestion, "B"));

        const done = yield* awaitRunStatus(harness.runRef, "completed");
        expect(
          done.graph?.nodes
            .filter((node) => node.kind === "research")
            .every((node) => node.status === "completed"),
        ).toBe(true);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
);
