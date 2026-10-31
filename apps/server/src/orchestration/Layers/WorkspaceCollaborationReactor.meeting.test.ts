import { buildInitialWorkspaceTaskGraph } from "../workspaceTaskGraph.ts";
import {
  EventId,
  ProviderDriverKind,
  type ProviderExecutionContext,
  type ProviderRuntimeEvent,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  MessageId,
  WorkspaceCollaborationRunId,
  WorkspaceMemoryError,
  WorkspaceMeetingParticipantId,
  WorkspaceTaskNodeId,
  type OrchestrationEvent,
  type OrchestrationCommand,
  type OrchestrationThread,
  type WorkspaceCollaborationRun,
  type WorkspaceMeeting,
  type WorkspacePromptComposeInput,
  WorkspaceCollaborationRun as WorkspaceCollaborationRunSchema,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Deferred from "effect/Deferred";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { workflowDefaults } from "@t3tools/shared/workflow";
import { WorkspaceWorkflowStore } from "../../persistence/WorkspaceWorkflowStore.ts";
import { expect, it } from "@effect/vitest";

import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import type { ProjectionThreadActivity } from "../../persistence/Services/ProjectionThreadActivities.ts";
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
import {
  WorkspaceAgentExecutor,
  WorkspaceAgentExecutionError,
  type WorkspaceAgentExecutionInput,
} from "../Services/WorkspaceAgentExecutor.ts";
import { OrchestrationTurnWaitLive } from "./OrchestrationTurnWait.ts";
import { WorkspaceCollaborationReactorLive } from "./WorkspaceCollaborationReactor.ts";
import * as GitWorkflowService from "../../git/GitWorkflowService.ts";
import * as WorktreeProvisionService from "../../git/WorktreeProvisionService.ts";
import { WorkspaceWorktreeCleanup } from "./WorkspaceWorktreeCleanup.ts";
import { ServerConfig } from "../../config.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { WorkspaceAgentControl, makeWorkspaceAgentControl } from "../WorkspaceAgentControl.ts";
import { WorkspaceAgentExecutorLive } from "./WorkspaceAgentExecutor.ts";
import { WorkspaceMemory } from "../WorkspaceMemory.ts";

/**
 * Deterministic provisioning fakes: non-isolating runs never touch them, and
 * an isolating run gets a stable per-branch path. Terminal cleanup is a no-op.
 */
const orchestraWorktreeStubs = Layer.mergeAll(
  Layer.mock(WorktreeProvisionService.WorktreeProvisionService)({
    provision: (request) =>
      Effect.succeed({
        worktreePath: `E:/worktrees/${request.branch ?? "detached"}`,
        refName: request.branch ?? request.baseBranch,
        reused: false,
      }),
    runSetupGate: () => Effect.succeed({ status: "ok" as const }),
  }),
  Layer.mock(GitWorkflowService.GitWorkflowService)({
    localStatus: () =>
      Effect.succeed({
        isRepo: true,
        hasPrimaryRemote: false,
        isDefaultRef: false,
        refName: "main",
        hasWorkingTreeChanges: false,
        workingTree: { files: [], insertions: 0, deletions: 0 },
      }),
  }),
  Layer.mock(WorkspaceWorktreeCleanup)({
    cleanupRunWorktrees: () => Effect.void,
    sweepOrphans: () => Effect.void,
  }),
);

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
  readonly memoryDirective?: string;
  readonly memoryContext?: string;
  readonly memoryFailure?: boolean;
  readonly memoryPaths?: ReadonlyArray<string>;
  readonly memoryPathsFailure?: boolean;
  readonly compactHandoffs?: boolean;
  readonly liveExecutor?: boolean;
  readonly run: WorkspaceCollaborationRun;
  readonly existingThreads?: ReadonlyArray<OrchestrationThread>;
  readonly respond: (prompt: string) => string;
  readonly onTurnStart?: (input: {
    readonly prompt: string;
    readonly run: WorkspaceCollaborationRun;
  }) => Effect.Effect<void>;
  readonly executionFailure?: (
    execution: WorkspaceAgentExecutionInput,
  ) => WorkspaceAgentExecutionError | undefined;
  readonly onRunUpdated?: (run: WorkspaceCollaborationRun) => Effect.Effect<void>;
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
    const threadsRef = yield* Ref.make(
      new Map<string, OrchestrationThread>(
        (input.existingThreads ?? []).map((thread) => [thread.id, thread]),
      ),
    );
    const commandsRef = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
    const promptsRef = yield* Ref.make<ReadonlyArray<string>>([]);
    const compositionsRef = yield* Ref.make<ReadonlyArray<WorkspacePromptComposeInput>>([]);
    const executionsRef = yield* Ref.make<ReadonlyArray<WorkspaceAgentExecutionInput>>([]);
    const sessionStopsRef = yield* Ref.make(0);
    const pubsub = yield* PubSub.unbounded<OrchestrationEvent>();
    let sequence = 0;

    const dispatch: OrchestrationEngineShape["dispatch"] = (command) =>
      Effect.gen(function* () {
        sequence += 1;
        yield* Ref.update(commandsRef, (current) => [...current, command]);
        switch (command.type) {
          case "thread.message.assistant.delta":
          case "thread.message.assistant.complete":
            yield* Ref.update(threadsRef, (current) => {
              const existing = current.get(command.threadId);
              if (!existing) return current;
              const previous = existing.messages.find(
                (message) => message.id === command.messageId,
              );
              const message = {
                id: command.messageId,
                role: "assistant" as const,
                text:
                  (previous?.text ?? "") +
                  (command.type === "thread.message.assistant.delta" ? command.delta : ""),
                attachments: [],
                turnId: null,
                streaming: command.type === "thread.message.assistant.delta",
                createdAt: previous?.createdAt ?? command.createdAt,
                updatedAt: command.createdAt,
              };
              const next = new Map(current);
              next.set(command.threadId, {
                ...existing,
                messages: previous
                  ? existing.messages.map((entry) => (entry.id === message.id ? message : entry))
                  : [...existing.messages, message],
              });
              return next;
            });
            break;
          case "project.collaboration.run.update":
            yield* Ref.set(runRef, command.run);
            if (input.onRunUpdated !== undefined) yield* input.onRunUpdated(command.run);
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
                branch: command.branch,
                worktreePath: command.worktreePath,
                orchestraRunThreadId: command.orchestraRunThreadId ?? null,
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
            if (input.onTurnStart !== undefined) {
              yield* input.onTurnStart({
                prompt: command.message.text,
                run: yield* Ref.get(runRef),
              });
            }
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
      recordControl: () => Effect.void,
      recordReview: () => Effect.void,
      requestVerification: () => Effect.void,
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
      getWorkspaceContextSettings: () =>
        Effect.succeed(
          input.compactHandoffs
            ? { memoryMode: "relevant" as const, compactHandoffs: true, autoChatMemory: false }
            : undefined,
        ),
      getCommandReadModel: () => Effect.succeed({ projects: [], threads: [] }),
      listWorkspaceAgentRoles: () => Effect.succeed({ roles: [] }),
      composeWorkspacePrompt: (request: WorkspacePromptComposeInput) =>
        Effect.succeed({
          prompt: `Workspace ID: workspace-m\n필수 사용자 지침: 확인하지 않은 검사를 통과했다고 쓰지 않는다.\n현재 사용자 작업: ${request.task}`,
          sourceItemIds: [],
          ragMatches: [],
          truncated: false,
        }).pipe(Effect.tap(() => Ref.update(compositionsRef, (current) => [...current, request]))),
      getThreadShellById: (threadId: ThreadId) =>
        Ref.get(threadsRef).pipe(
          Effect.map((threads) => Option.fromNullishOr(threads.get(threadId))),
        ),
      getThreadRuntimeContext: (threadId: ThreadId) =>
        Ref.get(threadsRef).pipe(
          Effect.map((threads) => Option.fromNullishOr(threads.get(threadId))),
        ),
      getProjectShellById: () =>
        Effect.succeed(
          Option.some({ id: projectId, workspaceRoot: "D:/repo", scripts: [] } as never),
        ),
    } as unknown as ProjectionSnapshotQueryShape;
    const providerInstances = [
      {
        instanceId: ProviderInstanceId.make("claude-a"),
        driverKind: "claude",
        enabled: true,
        snapshot: { getSnapshot: Effect.succeed({}) },
      },
      {
        instanceId: ProviderInstanceId.make("codex-a"),
        driverKind: "codex",
        enabled: true,
        snapshot: { getSnapshot: Effect.succeed({}) },
      },
    ] as unknown as ReadonlyArray<ProviderInstance>;
    const providerRegistry = {
      getInstance: (instanceId: ProviderInstanceId) =>
        Effect.succeed(providerInstances.find((instance) => instance.instanceId === instanceId)),
      listInstances: Effect.succeed(providerInstances),
    } as unknown as ProviderInstanceRegistry["Service"];
    const liveExecutorLayer = WorkspaceAgentExecutorLive.pipe(
      Layer.provideMerge(
        Layer.effect(
          WorkspaceAgentControl,
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            return yield* makeWorkspaceAgentControl({
              stateDir: yield* fs.makeTempDirectoryScoped(),
              runs: repository,
              query,
              engine,
              activities: {
                listByThreadIdAndKinds: ({ threadId, kinds }) =>
                  Ref.get(commandsRef).pipe(
                    Effect.map((commands) => {
                      const rows = new Map<string, ProjectionThreadActivity>();
                      for (const command of commands) {
                        if (
                          command.type !== "thread.activity.append" ||
                          command.threadId !== threadId ||
                          !kinds.includes(command.activity.kind)
                        )
                          continue;
                        rows.set(command.activity.id, {
                          ...command.activity,
                          activityId: command.activity.id,
                          threadId,
                        });
                      }
                      return [...rows.values()];
                    }),
                  ),
              },
            });
          }),
        ),
      ),
      Layer.provideMerge(
        Layer.unwrap(
          Effect.gen(function* () {
            const events = yield* PubSub.unbounded<ProviderRuntimeEvent>();
            const sessions = new Map<ThreadId, ProviderExecutionContext>();
            return Layer.mock(ProviderService)({
              startSession: (threadId, request) =>
                Effect.sync(() => {
                  if (request.execution) sessions.set(threadId, request.execution);
                  return {
                    threadId,
                    provider: ProviderDriverKind.make("codex"),
                    status: "ready" as const,
                    runtimeMode: request.runtimeMode,
                    createdAt: at,
                    updatedAt: at,
                  };
                }),
              sendTurn: (request) =>
                Effect.gen(function* () {
                  const prompt = request.input ?? "";
                  const execution = sessions.get(request.threadId)!;
                  if (input.onTurnStart)
                    yield* input.onTurnStart({ prompt, run: yield* Ref.get(runRef) });
                  yield* Ref.update(promptsRef, (current) => [...current, prompt]);
                  const base = {
                    provider: ProviderDriverKind.make("codex"),
                    threadId: request.threadId,
                    execution,
                    createdAt: at,
                  };
                  yield* PubSub.publish(events, {
                    ...base,
                    type: "content.delta",
                    eventId: EventId.make(execution.executionId + ":delta"),
                    payload: { streamKind: "assistant_text", delta: input.respond(prompt) },
                  });
                  yield* PubSub.publish(events, {
                    ...base,
                    type: "turn.completed",
                    eventId: EventId.make(execution.executionId + ":done"),
                    payload: { state: "completed" },
                  });
                  return { threadId: request.threadId, turnId: TurnId.make(execution.executionId) };
                }),
              stopSession: () => Effect.void,
              streamEvents: Stream.fromPubSub(events),
            });
          }),
        ),
      ),
    );
    const layer = WorkspaceCollaborationReactorLive.pipe(
      Layer.provideMerge(
        input.memoryDirective === undefined &&
          !input.memoryFailure &&
          input.memoryPaths === undefined
          ? Layer.empty
          : Layer.mock(WorkspaceMemory)({
              context: (_projectId, _task, directivesOnly) =>
                input.memoryFailure
                  ? Effect.fail(new WorkspaceMemoryError({ message: "memory unavailable" }))
                  : Effect.succeed(
                      directivesOnly
                        ? input.memoryDirective!
                        : (input.memoryContext ?? "unexpected full memory"),
                    ),
              contextPaths: () =>
                input.memoryPathsFailure
                  ? Effect.fail(new WorkspaceMemoryError({ message: "folder unavailable" }))
                  : Effect.succeed(input.memoryPaths ?? []),
            }),
      ),
      Layer.provideMerge(
        input.liveExecutor
          ? liveExecutorLayer
          : Layer.succeed(WorkspaceAgentExecutor, {
              execute: (execution) =>
                Effect.gen(function* () {
                  yield* Ref.update(executionsRef, (current) => [...current, execution]);
                  const failure = input.executionFailure?.(execution);
                  if (failure) return yield* failure;
                  if (input.onTurnStart !== undefined)
                    yield* input.onTurnStart({
                      prompt: execution.prompt,
                      run: yield* Ref.get(runRef),
                    });
                  yield* Ref.update(promptsRef, (current) => [...current, execution.prompt]);
                  return input.respond(execution.prompt);
                }),
            }),
      ),
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
      Layer.provideMerge(orchestraWorktreeStubs),
      Layer.provideMerge(ServerConfig.layerTest("D:/repo", { prefix: "t3-meeting-context-" })),
      Layer.provideMerge(NodeServices.layer),
    );
    return {
      runRef,
      promptsRef,
      compositionsRef,
      executionsRef,
      threadsRef,
      commandsRef,
      sessionStopsRef,
      pubsub,
      layer,
    };
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

const decodeContextSourcePath = Schema.decodeSync(Schema.fromJsonString(Schema.String));
const runJsonSchema = Schema.fromJsonString(WorkspaceCollaborationRunSchema);
const decodeRunJson = Schema.decodeEffect(runJsonSchema);
const encodeRunJson = Schema.encodeEffect(runJsonSchema);

it.effect("passes required user directives to every meeting and orchestra execution", () =>
  Effect.gen(function* () {
    const directive = "<t3_user_directives>REQUIRED_USER_RULE</t3_user_directives>";
    const harness = yield* makeHarness({
      run: orchestraRun(),
      memoryDirective: directive,
      respond: respondForOrchestraPrompt,
    });
    yield* Effect.gen(function* () {
      const reactor = yield* WorkspaceCollaborationReactor;
      yield* reactor.start();
      yield* reactor.drain;
      const executions = yield* Ref.get(harness.executionsRef);
      expect((yield* Ref.get(harness.runRef)).status).toBe("completed");
      expect(executions.some((execution) => execution.orchestraPhase === "meeting")).toBe(true);
      expect(executions.some((execution) => execution.orchestraPhase === "task")).toBe(true);
      expect(executions.every((execution) => execution.prompt.includes(directive))).toBe(true);
    }).pipe(Effect.provide(harness.layer), Effect.scoped);
  }),
);

it.effect("reports missing user directives to every direct execution", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness({ run: orchestraRun(), respond: respondForOrchestraPrompt });
    yield* Effect.gen(function* () {
      const reactor = yield* WorkspaceCollaborationReactor;
      yield* reactor.start();
      yield* reactor.drain;
      const executions = yield* Ref.get(harness.executionsRef);
      expect(executions.length).toBeGreaterThan(0);
      expect(
        executions.every((execution) => execution.prompt.includes("<t3_memory_unavailable>")),
      ).toBe(true);
    }).pipe(Effect.provide(harness.layer), Effect.scoped);
  }),
);

it.effect("reports a failed directive lookup to every direct execution", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness({
      run: orchestraRun(),
      memoryFailure: true,
      respond: respondForOrchestraPrompt,
    });
    yield* Effect.gen(function* () {
      const reactor = yield* WorkspaceCollaborationReactor;
      yield* reactor.start();
      yield* reactor.drain;
      const executions = yield* Ref.get(harness.executionsRef);
      expect(executions.length).toBeGreaterThan(0);
      expect(
        executions.every((execution) => execution.prompt.includes("<t3_memory_unavailable>")),
      ).toBe(true);
    }).pipe(Effect.provide(harness.layer), Effect.scoped);
  }),
);

it.effect("parks an AI-planned meeting when the shared run control requests a pause", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness({
      run: {
        ...meetingRun(),
        runControl: { control: "pause-requested", controlRevision: 1, updatedAt: at },
      },
      respond: respondForMeetingPrompt,
    });
    yield* Effect.gen(function* () {
      const reactor = yield* WorkspaceCollaborationReactor;
      yield* reactor.start();
      yield* reactor.drain;
      expect(yield* Ref.get(harness.promptsRef)).toEqual([]);
      expect((yield* Ref.get(harness.runRef)).runControl).toMatchObject({
        control: "paused",
        controlRevision: 1,
      });
    }).pipe(Effect.provide(harness.layer), Effect.scoped);
  }),
);

it.effect("executes an AI-planned graph with the selected model and permission snapshot", () =>
  Effect.gen(function* () {
    const selected = { instanceId: ProviderInstanceId.make("codex-a"), model: "selected-model" };
    const roleBindings = (["coordinator", "implementer", "researcher"] as const).map((role) => ({
      projectId,
      role,
      displayName: selected.model,
      modelSelection: selected,
      runtimeMode: "full-access" as const,
      interactionMode: "plan" as const,
      instructions: "",
      enabled: true,
      updatedAt: at,
    }));
    const harness = yield* makeHarness({
      run: {
        ...meetingRun(),
        meeting: null,
        runContext: { requestDigest: "fixture", roleBindings, requestMode: "direct" },
        runControl: { control: "active", controlRevision: 0, updatedAt: at },
      },
      respond: (prompt) =>
        prompt.includes("Return one strict machine-readable proposal between <t3_task_graph>")
          ? `<t3_task_graph>${JSON.stringify({ summary: "Plan", nextAction: "Implement", nodes: [{ id: "build", kind: "implementation", agent: "codex", title: "Build", task: "Implement", goal: "Complete", context: "Request", input: "Goal", constraints: [], expectedOutput: "Result", successCriteria: ["Verified"], dependsOn: [], priority: 1 }] })}</t3_task_graph>`
          : respondForMeetingPrompt(prompt),
    });
    yield* Effect.gen(function* () {
      const reactor = yield* WorkspaceCollaborationReactor;
      yield* reactor.start();
      yield* reactor.drain;
      const executions = yield* Ref.get(harness.executionsRef);
      expect(executions.length).toBeGreaterThan(0);
      expect(
        executions.every(
          (entry) =>
            entry.modelSelection.model === selected.model &&
            entry.modelSelection.instanceId === selected.instanceId &&
            entry.runtimeMode === "full-access" &&
            entry.interactionMode === "plan",
        ),
      ).toBe(true);
      expect((yield* Ref.get(harness.runRef)).status).toBe("completed");
    }).pipe(Effect.provide(harness.layer), Effect.scoped);
  }),
);

it.effect("persists meeting failures and stops an exhausted step after reconstruction", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness({
      run: meetingRun({ maxRounds: 0, phase: "planning" }),
      respond: () => "계획 JSON 없는 잘못된 응답",
    });
    const failed = yield* Effect.gen(function* () {
      const reactor = yield* Effect.service(WorkspaceCollaborationReactor);
      yield* reactor.start();
      yield* reactor.drain;
      const run = yield* Ref.get(harness.runRef);
      expect(run.status).toBe("failed");
      expect(run.meeting?.turnFailures).toMatchObject([{ key: "plan", count: 2 }]);
      expect(
        (yield* Ref.get(harness.promptsRef)).filter((prompt) =>
          prompt.startsWith("# Workspace Meeting Plan"),
        ),
      ).toHaveLength(2);
      return run;
    }).pipe(Effect.provide(harness.layer), Effect.scoped);
    const decoded = yield* decodeRunJson(yield* encodeRunJson(failed));
    const resumed = yield* makeHarness({
      run: { ...decoded, status: "running", error: null },
      respond: respondForMeetingPrompt,
    });
    yield* Effect.gen(function* () {
      const reactor = yield* Effect.service(WorkspaceCollaborationReactor);
      yield* reactor.start();
      yield* reactor.drain;
      expect(yield* Ref.get(resumed.promptsRef)).toEqual([]);
      expect((yield* Ref.get(resumed.runRef)).status).toBe("failed");
      expect((yield* Ref.get(resumed.runRef)).meeting?.turnFailures).toEqual(
        decoded.meeting?.turnFailures,
      );
    }).pipe(Effect.provide(resumed.layer), Effect.scoped);
  }),
);

it.effect("a reconstructed meeting spends only its remaining failure budget", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness({
      run: meetingRun({
        maxRounds: 0,
        phase: "planning",
        turnFailures: [{ key: "plan", count: 1, message: "previous failure" }],
      }),
      respond: () => "잘못된 계획",
    });
    yield* Effect.gen(function* () {
      const reactor = yield* Effect.service(WorkspaceCollaborationReactor);
      yield* reactor.start();
      yield* reactor.drain;
      const run = yield* Ref.get(harness.runRef);
      expect(run.status).toBe("failed");
      expect(run.meeting?.turnFailures).toMatchObject([{ key: "plan", count: 2 }]);
      expect(
        (yield* Ref.get(harness.promptsRef)).filter((prompt) =>
          prompt.startsWith("# Workspace Meeting Plan"),
        ),
      ).toHaveLength(1);
    }).pipe(Effect.provide(harness.layer), Effect.scoped);
  }),
);
it.effect(
  "keeps the complete long statement and node output behind bounded source references",
  () =>
    Effect.gen(function* () {
      const longStatement =
        "Complete opening paragraph.\n\n" +
        "statement detail ".repeat(2000) +
        "\n\nUnresolved dissent at the statement tail.";
      const longOutput =
        "Complete result heading.\n\n" +
        "implementation detail ".repeat(6000) +
        "\n\nPending external evidence at the node tail.";
      const harness = yield* makeHarness({
        run: meetingRun({ answers: [executeWrapUp(1)] }),
        compactHandoffs: true,
        respond: (prompt) =>
          prompt.startsWith("# Workspace Meeting Statement")
            ? longStatement
            : prompt.includes("Node: build\n")
              ? longOutput
              : respondForMeetingPrompt(prompt),
      });
      yield* Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const reactor = yield* WorkspaceCollaborationReactor;
        yield* reactor.start();
        yield* reactor.drain;
        const run = yield* awaitRunStatus(harness.runRef, "completed");
        const statement = run.meeting!.rounds[0]!.statements[0]!.content;
        const output = run.graph!.nodes.find((node) => node.id === "build")!.output!;
        expect(statement.length).toBeLessThanOrEqual(20_000);
        expect(output.length).toBeLessThanOrEqual(100_000);
        for (const [preview, original] of [
          [statement, longStatement],
          [output, longOutput],
        ]) {
          const source = preview!.match(/원문 파일: ("(?:[^"\\]|\\.)*");/u)?.[1];
          expect(source).toBeDefined();
          expect(yield* fs.readFileString(decodeContextSourcePath(source!))).toBe(original);
          expect(preview).toContain("미리보기만으로 검증을 통과시키지 마세요");
        }
        const prompts = yield* Ref.get(harness.promptsRef);
        expect(
          prompts.some(
            (prompt) =>
              prompt.startsWith("# Workspace Meeting Round Close") && prompt.includes("원문 파일:"),
          ),
        ).toBe(true);
        expect(
          prompts.some(
            (prompt) => prompt.includes("Node: validate-build") && prompt.includes("원문 파일:"),
          ),
        ).toBe(true);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
);

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
      const meetingThreads = yield* Ref.get(harness.threadsRef);
      expect(meetingThreads.size).toBe(1);
      const summary = meetingThreads
        .get(meetingThread!)
        ?.messages.find((message) => message.id === `orchestra-summary:${run.id}`);
      expect(summary?.streaming).toBe(false);
      expect(summary?.text).toContain("오케스트라 대화 정리");
      expect(summary?.text).toContain("합의: 서버 구현으로 진행");
      expect(summary?.text).toContain("회의 합의대로 구현 완료");
      // Without an orchestra the one conversation is the person's own, so
      // nothing marks it as a run internal and nothing hides it.
      expect([...meetingThreads.values()].every((t) => t.orchestraRunThreadId === null)).toBe(true);
      // Handing the conversation between providers released the live session
      // each time the speaker's driver changed.
      expect(yield* Ref.get(harness.sessionStopsRef)).toBe(0);

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

it.effect(
  "isolating orchestra run gives the write chain a worktree and pins its threads there",
  () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        run: {
          ...meetingRun({ answers: [executeWrapUp(1)] }),
          orchestra: { maxParallel: 2, isolateWorktrees: true },
        },
        respond: respondForMeetingPrompt,
      });

      yield* Effect.gen(function* () {
        const reactor = yield* Effect.service(WorkspaceCollaborationReactor);
        yield* reactor.start();
        yield* reactor.drain;

        const run = yield* Ref.get(harness.runRef);
        expect(run.status).toBe("completed");
        const nodes = new Map(run.graph?.nodes.map((node) => [String(node.id), node]));
        const build = nodes.get("build");
        const validate = nodes.get("validate-build");
        // The write node and its validation gate share one chain worktree, so
        // the gate judges the tree the write actually edited; readers stay in
        // the project root.
        expect(build?.worktreePath).toContain("E:/worktrees/t3code/orch-runm-");
        expect(build?.branch).toContain("t3code/orch-runm-");
        expect(validate?.worktreePath).toBe(build?.worktreePath);
        expect(nodes.get("plan")?.worktreePath ?? null).toBeNull();
        // Worktree ownership belongs to executions; the shared conversation stays at the root.
        const threads = yield* Ref.get(harness.threadsRef);
        const buildThread = build?.threadId != null ? threads.get(build.threadId) : undefined;
        expect(threads.size).toBe(1);
        expect(buildThread?.worktreePath).toBeNull();
        expect(buildThread?.branch).toBeNull();
        const executions = yield* Ref.get(harness.executionsRef);
        expect(executions.find((entry) => entry.execution.nodeId === "build")?.cwd).toBe(
          build?.worktreePath,
        );
        expect(executions.find((entry) => entry.execution.nodeId === "validate-build")?.cwd).toBe(
          build?.worktreePath,
        );
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
);

it.effect.each([
  [false, true],
  [true, true],
  [true, false],
] as const)(
  "executes a workflow with selected models (live=%s, existing chat=%s)",
  ([liveExecutor, existingChat]) =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("workflow-existing-chat");
      const definition = {
        ...workflowDefaults()[0]!,
        revision: 1,
        archived: false,
        digest: "fixture-digest",
        createdAt: at,
      };
      const models = {
        coordinator: { instanceId: ProviderInstanceId.make("claude-a"), model: "lead-model" },
        implementer: { instanceId: ProviderInstanceId.make("codex-a"), model: "build-model" },
        researcher: { instanceId: ProviderInstanceId.make("claude-a"), model: "research-model" },
      };
      const roleBindings = (["coordinator", "implementer", "researcher"] as const).map((role) => ({
        projectId,
        role,
        displayName: role,
        modelSelection: models[role],
        runtimeMode: "approval-required" as const,
        interactionMode: "default" as const,
        instructions: "",
        enabled: true,
        updatedAt: at,
      }));
      let failedOnce = false;
      const harness = yield* makeHarness({
        liveExecutor,
        executionFailure: (execution) => {
          if (!liveExecutor && execution.execution.nodeId === "execute" && !failedOnce) {
            failedOnce = true;
            return new WorkspaceAgentExecutionError({ message: "temporary test failure" });
          }
          return undefined;
        },
        run: {
          ...meetingRun(),
          meeting: null,
          workflow: {
            definitionId: definition.id,
            definitionRevision: 1,
            definitionDigest: definition.digest,
            definition,
            title: definition.title,
            values: { goal: "workflow target" },
            nodeSkills: definition.nodes.map((node) => ({ nodeId: node.id, skills: [] })),
            roleBindings,
            roleModels: models,
            ...(existingChat ? { threadId } : {}),
            control: "active",
            controlRevision: 0,
            updatedAt: at,
            requestDigest: "fixture",
          },
        },
        respond: respondForMeetingPrompt,
      });
      if (existingChat)
        yield* Ref.update(harness.threadsRef, (current) => {
          const next = new Map(current);
          next.set(threadId, {
            id: threadId,
            projectId,
            title: "기존 대화",
            modelSelection: models.coordinator,
            runtimeMode: "approval-required",
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
          } as OrchestrationThread);
          return next;
        });
      yield* Effect.gen(function* () {
        const reactor = yield* WorkspaceCollaborationReactor;
        yield* reactor.start();
        yield* reactor.drain;
        const run = yield* Ref.get(harness.runRef);
        expect(run.status, run.error ?? undefined).toBe("completed");
        const actualThreadId = existingChat
          ? threadId
          : run.steps.find((step) => step.threadId !== null)?.threadId;
        expect(actualThreadId).toBeTruthy();
        const executions = yield* Ref.get(harness.executionsRef);
        if (!liveExecutor) {
          expect(executions.length).toBeGreaterThan(0);
          expect(executions.every((entry) => entry.execution.ownerThreadId === threadId)).toBe(
            true,
          );
          expect(
            executions.find((entry) => entry.kind === "implementation")?.modelSelection,
          ).toEqual(models.implementer);
          expect(
            executions
              .filter((entry) => entry.execution.nodeId === "execute")
              .map((entry) => entry.modelSelection),
          ).toEqual([models.implementer, models.implementer]);
          expect(executions.find((entry) => entry.kind === "validation")?.modelSelection).toEqual(
            models.coordinator,
          );
        }
        const threads = yield* Ref.get(harness.threadsRef);
        expect(threads.size).toBe(1);
        expect(
          threads
            .get(actualThreadId!)
            ?.messages.find((message) => message.id === `orchestra-summary:${run.id}`)?.text,
        ).toContain("회의 합의대로 구현 완료");
        const commands = yield* Ref.get(harness.commandsRef);
        expect(commands.some((command) => command.type === "thread.create")).toBe(!existingChat);
        if (liveExecutor) {
          expect(
            commands.some(
              (command) =>
                command.type === "thread.message.assistant.delta" &&
                command.threadId === actualThreadId &&
                command.delta.includes("구현을 완료했다"),
            ),
          ).toBe(true);
        }
      }).pipe(
        Effect.provide(
          harness.layer.pipe(
            Layer.provideMerge(
              Layer.mock(WorkspaceWorkflowStore)({ retrySafe: () => Effect.succeed(true) }),
            ),
          ),
        ),
        Effect.scoped,
      );
    }),
);

for (const folderFailure of [false, true]) {
  it.effect(
    `holds the meeting in the conversation and ${folderFailure ? "reports a folder lookup failure" : "uses its selected folder"}`,
    () =>
      Effect.gen(function* () {
        const existingThreadId = ThreadId.make("thread-existing");
        const harness = yield* makeHarness({
          run: meetingRun({ threadId: existingThreadId, answers: [executeWrapUp(1)] }),
          memoryDirective: "REQUIRED_USER_RULE",
          memoryContext: "CURRENT_FOLDER_MEMORY",
          memoryPaths: ["apps/web"],
          memoryPathsFailure: folderFailure,
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
            messages: [
              {
                id: MessageId.make("selected-folder"),
                role: "user",
                text: "apps/web 폴더에서 계속해",
                streaming: false,
                createdAt: "2026-08-16T00:00:00.000Z",
                updatedAt: "2026-08-16T00:00:00.000Z",
                attachments: [],
                turnId: null,
              },
              {
                id: MessageId.make("prior-work"),
                role: "assistant",
                text: "OTHER_FOLDER_PRIVATE_CANARY",
                streaming: false,
                createdAt: "2026-08-16T00:00:00.000Z",
                updatedAt: "2026-08-16T00:00:00.000Z",
                attachments: [],
                turnId: null,
              },
            ],
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
          const compositions = yield* Ref.get(harness.compositionsRef);
          expect(
            compositions.every((request) => !request.task.includes("OTHER_FOLDER_PRIVATE_CANARY")),
          ).toBe(true);
          expect(compositions.every((request) => request.contextPaths?.[0] === "apps/web")).toBe(
            true,
          );
          if (folderFailure) expect(compositions).toHaveLength(0);
          else expect(compositions.length).toBeGreaterThan(0);
          expect(compositions.every((request) => request.includeRag === true)).toBe(true);
          expect(
            compositions.every(
              (request) =>
                request.includeShared === false &&
                request.includeSharedLibrary === false &&
                request.contextMode === "relevant",
            ),
          ).toBe(true);
          const prompts = yield* Ref.get(harness.promptsRef);
          if (folderFailure)
            expect(
              prompts.every((prompt) => prompt.includes("<t3_folder_memory_unavailable>")),
            ).toBe(true);
          expect(prompts.every((prompt) => !prompt.includes("OTHER_FOLDER_PRIVATE_CANARY"))).toBe(
            true,
          );
          expect(prompts.every((prompt) => prompt.includes("REQUIRED_USER_RULE"))).toBe(true);
          if (!folderFailure)
            expect(prompts.some((prompt) => prompt.includes("CURRENT_FOLDER_MEMORY"))).toBe(true);
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
}

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
      yield* reactor.drain;
      const summary = (yield* Ref.get(harness.threadsRef))
        .get(concluded.meeting!.threadId!)
        ?.messages.find((message) => message.id === `orchestra-summary:${runId}`);
      expect(summary?.text).toContain("여기서 종료 (실행 없음)");
      expect(summary?.text).toContain("논의와 결정");
      expect(summary?.text).not.toContain("## 회의 전문");
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
      expect(
        (yield* Ref.get(harness.commandsRef)).some(
          (command) =>
            command.type === "thread.message.assistant.delta" &&
            command.messageId === `orchestra-summary:${runId}`,
        ),
      ).toBe(false);

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
      expect(cancelled.meeting?.pendingQuestion).toBeNull();
      yield* reactor.drain;
      const summary = (yield* Ref.get(harness.threadsRef))
        .get(cancelled.meeting!.threadId!)
        ?.messages.find((message) => message.id === `orchestra-summary:${runId}`);
      expect(summary?.streaming).toBe(false);
      expect(summary?.text).toContain("중지됨");
      expect(summary?.text).toContain("미완료 작업은 완료로 처리하지 않았습니다");
    }).pipe(Effect.provide(harness.layer), Effect.scoped);
  }),
);

it.effect(
  "publishes failure details in the existing conversation without claiming unfinished work is complete",
  () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({
        run: meetingRun(),
        respond: () => {
          throw new Error("provider disconnected");
        },
      });
      yield* Effect.gen(function* () {
        const reactor = yield* Effect.service(WorkspaceCollaborationReactor);
        yield* reactor.start();
        yield* reactor.drain;
        const run = yield* Ref.get(h.runRef);
        expect(run.status).toBe("failed");
        const summary = (yield* Ref.get(h.threadsRef))
          .get(run.meeting!.threadId!)
          ?.messages.find((message) => message.id === `orchestra-summary:${runId}`);
        expect(summary?.streaming).toBe(false);
        expect(summary?.text).toContain("**실패**");
        expect(summary?.text).toContain("provider disconnected");
        expect(summary?.text).not.toContain("### 최종 결과");
      }).pipe(Effect.provide(h.layer), Effect.scoped);
    }),
);

it.effect("does not duplicate a terminal run summary when the run is delivered again", () =>
  Effect.gen(function* () {
    const first = yield* makeHarness({
      run: meetingRun({ answers: [executeWrapUp(1)] }),
      respond: respondForMeetingPrompt,
    });
    yield* Effect.gen(function* () {
      const reactor = yield* Effect.service(WorkspaceCollaborationReactor);
      yield* reactor.start();
      yield* reactor.drain;
    }).pipe(Effect.provide(first.layer), Effect.scoped);
    const run = yield* Ref.get(first.runRef);
    const threads = [...(yield* Ref.get(first.threadsRef)).values()];
    const second = yield* makeHarness({
      run,
      existingThreads: threads,
      respond: respondForMeetingPrompt,
    });
    yield* Effect.gen(function* () {
      const reactor = yield* Effect.service(WorkspaceCollaborationReactor);
      yield* reactor.start();
      yield* reactor.drain;
      expect(yield* Ref.get(second.promptsRef)).toEqual([]);
      expect(
        (yield* Ref.get(second.commandsRef)).filter(
          (command) =>
            command.type === "thread.message.assistant.delta" ||
            command.type === "thread.message.assistant.complete",
        ),
      ).toEqual([]);
      expect(
        (yield* Ref.get(second.threadsRef))
          .get(run.meeting!.threadId!)
          ?.messages.filter((message) => message.id === `orchestra-summary:${runId}`),
      ).toHaveLength(1);
    }).pipe(Effect.provide(second.layer), Effect.scoped);
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
      memoryDirective: "필수 사용자 지침: 확인하지 않은 검사를 통과했다고 쓰지 않는다.",
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
      expect(validation?.attempts[0]?.output).toBe("구현은 괜찮아 보인다.");
      expect(validation?.attempts[0]?.formatRepair?.chars).toBe("구현은 괜찮아 보인다.".length);
      const executions = yield* Ref.get(harness.executionsRef);
      const repair = executions.find((entry) => entry.usagePhase === "format-repair");
      expect(repair?.prompt).toContain("ORIGINAL OUTPUT (verbatim):");
      expect(repair?.prompt).toContain("구현은 괜찮아 보인다.");
      expect(repair?.prompt).toContain("Do not repeat research, tools, builds, tests, file edits");
      expect(repair?.prompt).not.toContain("DEPENDENCIES:");
      expect(repair?.prompt).not.toContain("redo the work");
      expect(repair?.prompt).not.toContain("Independently verify the target output");
      expect(repair?.prompt).toContain(
        "필수 사용자 지침: 확인하지 않은 검사를 통과했다고 쓰지 않는다.",
      );
      expect(executions.filter((entry) => entry.execution.nodeId === "build")).toHaveLength(1);
      expect(repair?.execution.attempt).toBe(2);
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

import { reviewWorkspaceOrchestraPlan } from "../workspaceOrchestraReview.ts";
import { WorkspaceDevelopmentGit } from "../WorkspaceDevelopmentGit.ts";

const seatQuestion = (question: string) =>
  `<t3_question>${JSON.stringify({ question, options: ["A", "B"], context: "선택이 남았다." })}</t3_question>`;

it.effect("orchestra: persists a finished sibling while another execution is still running", () =>
  Effect.gen(function* () {
    const slowStarted = yield* Deferred.make<void>();
    const releaseSlow = yield* Deferred.make<void>();
    const fastPersisted = yield* Deferred.make<WorkspaceCollaborationRun>();
    const harness = yield* makeHarness({
      run: orchestraRun(),
      respond: respondForOrchestraPrompt,
      onTurnStart: ({ prompt }) =>
        Effect.gen(function* () {
          if (prompt.includes("Node: research-p1\n")) {
            yield* Deferred.succeed(slowStarted, undefined);
            yield* Deferred.await(releaseSlow);
          } else if (prompt.includes("Node: research-p2\n")) {
            yield* Deferred.await(slowStarted);
          }
        }),
      onRunUpdated: (run) =>
        run.graph?.nodes.some(
          (node) => node.id === "research-p2" && node.attempts.at(-1)?.status === "completed",
        )
          ? Deferred.succeed(fastPersisted, run).pipe(Effect.asVoid)
          : Effect.void,
    });
    yield* Effect.gen(function* () {
      const reactor = yield* WorkspaceCollaborationReactor;
      yield* reactor.start();
      const partial = yield* Deferred.await(fastPersisted);
      expect(partial.graph?.status).toBe("executing");
      expect(partial.graph?.nodes.find((node) => node.id === "research-p1")?.status).toBe(
        "running",
      );
      expect(
        partial.graph?.nodes.find((node) => node.id === "research-p2")?.attempts.at(-1)?.status,
      ).toBe("completed");
      yield* Deferred.succeed(releaseSlow, undefined);
      yield* reactor.drain;
      expect((yield* Ref.get(harness.runRef)).status).toBe("completed");
    }).pipe(Effect.provide(harness.layer), Effect.scoped);
  }),
);

it.effect("orchestra: runs independent executions side by side inside one conversation", () =>
  Effect.gen(function* () {
    const firstStarted = yield* Deferred.make<void>();
    const secondStarted = yield* Deferred.make<void>();
    const harness = yield* makeHarness({
      run: orchestraRun(),
      respond: respondForOrchestraPrompt,
      onTurnStart: ({ prompt }) =>
        Effect.gen(function* () {
          if (prompt.includes("Node: research-p1\n")) {
            yield* Deferred.succeed(firstStarted, undefined);
            yield* Deferred.await(secondStarted);
          } else if (prompt.includes("Node: research-p2\n")) {
            yield* Deferred.succeed(secondStarted, undefined);
            yield* Deferred.await(firstStarted);
          }
        }),
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
      const threads = yield* Ref.get(harness.threadsRef);
      for (const node of nodes) {
        expect(node.threadId).not.toBeNull();
        expect(node.threadId).toBe(meetingThread);
        expect(node.attempts.every((attempt) => attempt.threadId === node.threadId)).toBe(true);
        expect(threads.get(String(node.threadId))?.orchestraRunThreadId).toBeNull();
      }
      expect(threads.size).toBe(1);
      const executions = (yield* Ref.get(harness.executionsRef)).filter(
        (entry) => entry.kind === "research",
      );
      expect(new Set(executions.map((entry) => entry.execution.executionId)).size).toBe(2);
      expect(executions.every((entry) => entry.execution.ownerThreadId === meetingThread)).toBe(
        true,
      );
      // Both research prompts were issued in the same wave: the second one
      // went out before either result could have been applied.
      const prompts = yield* Ref.get(harness.promptsRef);
      const researchPrompts = prompts.filter((prompt) => prompt.includes("Node: research-"));
      expect(researchPrompts).toHaveLength(2);
    }).pipe(Effect.provide(harness.layer), Effect.scoped);
  }),
);

it.effect("orchestra: isolation=true runs write chains in parallel, each in its own worktree", () =>
  Effect.gen(function* () {
    const writeWaves: string[][] = [];
    const firstWriteStarted = yield* Deferred.make<void>();
    const secondWriteStarted = yield* Deferred.make<void>();
    const harness = yield* makeHarness({
      run: { ...orchestraRun(), orchestra: { maxParallel: 2, isolateWorktrees: true } },
      respond: (prompt) =>
        respondForOrchestraPrompt(prompt).replaceAll(
          '"kind":"research"',
          '"kind":"implementation"',
        ),
      onTurnStart: ({ prompt, run }) =>
        Effect.gen(function* () {
          if (!prompt.includes("# Workspace Task Graph Assignment")) return;
          const running = run.graph?.nodes.filter((node) => node.status === "running") ?? [];
          if (running.some((node) => node.kind === "implementation" || node.kind === "debug")) {
            writeWaves.push(running.map((node) => String(node.id)).toSorted());
            if (prompt.includes("Node: research-p1\n")) {
              yield* Deferred.succeed(firstWriteStarted, undefined);
              yield* Deferred.await(secondWriteStarted);
            } else if (prompt.includes("Node: research-p2\n")) {
              yield* Deferred.succeed(secondWriteStarted, undefined);
              yield* Deferred.await(firstWriteStarted);
            }
          }
        }),
    });
    yield* Effect.gen(function* () {
      const reactor = yield* Effect.service(WorkspaceCollaborationReactor);
      yield* reactor.start();
      yield* reactor.drain;
      const done = yield* Ref.get(harness.runRef);
      expect(done.status).toBe("completed");
      // Two independent write chains share one wave now that each edits its
      // own worktree instead of the shared checkout.
      expect(writeWaves).toEqual([
        ["research-p1", "research-p2"],
        ["research-p1", "research-p2"],
      ]);
      const writes = done.graph?.nodes.filter((node) => node.kind === "implementation") ?? [];
      expect(writes).toHaveLength(2);
      expect(writes.every((node) => node.worktreePath !== null)).toBe(true);
      expect(new Set(writes.map((node) => node.worktreePath)).size).toBe(2);
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

it.effect("settles blocked nodes too when a cancelled run drains", () =>
  Effect.gen(function* () {
    const initial = meetingRun();
    const graph = buildInitialWorkspaceTaskGraph(initial.task);
    const harness = yield* makeHarness({
      run: {
        ...initial,
        status: "cancel-requested",
        graph: {
          ...graph,
          nodes: [
            { ...graph.nodes[0]!, status: "completed" },
            { ...graph.nodes[0]!, id: WorkspaceTaskNodeId.make("waiting"), status: "blocked" },
          ],
        },
      },
      respond: respondForMeetingPrompt,
    });
    yield* Effect.gen(function* () {
      const reactor = yield* WorkspaceCollaborationReactor;
      yield* reactor.start();
      yield* reactor.drain;
      const run = yield* Ref.get(harness.runRef);
      expect(run.status).toBe("cancelled");
      expect(run.graph?.nodes[0]?.status).toBe("completed");
      expect(run.graph!.nodes.length).toBeGreaterThan(1);
      expect(run.graph?.nodes.slice(1).every((node) => node.status === "cancelled")).toBe(true);
      expect(yield* Ref.get(harness.promptsRef)).toEqual([]);
    }).pipe(Effect.provide(harness.layer), Effect.scoped);
  }),
);

for (const maxRounds of [0, 1]) {
  it.effect(
    `asks the selected conductor first and parks before ${maxRounds === 0 ? "direct execution" : "discussion"}`,
    () =>
      Effect.gen(function* () {
        const question = "가격·지갑 검증만 진행할까요?";
        const harness = yield* makeHarness({
          run: meetingRun({ phase: "clarifying", maxRounds, chairParticipantId: pid("p2") }),
          respond: (prompt) => {
            expect(prompt.startsWith("# Workspace Meeting Intake")).toBe(true);
            return `작업 범위를 확인하겠습니다.<t3_question>${JSON.stringify({ question, options: ["가격·지갑만 진행", "설명만"], context: "범위 확인" })}</t3_question>`;
          },
        });
        yield* Effect.gen(function* () {
          const reactor = yield* WorkspaceCollaborationReactor;
          yield* reactor.start();
          yield* reactor.drain;
          const parked = yield* Ref.get(harness.runRef);
          expect(parked.graph).toBeNull();
          expect(parked.meeting?.rounds).toEqual([]);
          expect(parked.meeting?.pendingQuestion).toMatchObject({
            question,
            askedByParticipantId: pid("p2"),
          });
          const executions = yield* Ref.get(harness.executionsRef);
          expect(executions).toHaveLength(1);
          expect(executions[0]?.modelSelection.instanceId).toBe("codex-a");
          expect(executions[0]?.title).toBe("지휘 AI · 질문 먼저");
        }).pipe(Effect.provide(harness.layer), Effect.scoped);
      }),
  );
}

it.effect("receives the saved answer in the conductor before planning and assigning work", () =>
  Effect.gen(function* () {
    const answer = "가격·지갑 검증만 진행하세요. 프로그램 재시작은 금지합니다.";
    const harness = yield* makeHarness({
      run: meetingRun({
        phase: "clarifying",
        maxRounds: 0,
        chairParticipantId: pid("p2"),
        answers: [{ question: "어떤 작업을 할까요?", answer, answeredAt: at, nodeId: null }],
      }),
      respond: (prompt) =>
        prompt.startsWith("# Workspace Meeting Intake")
          ? "<t3_ready>가격·지갑 검증만 진행합니다.</t3_ready>"
          : respondForMeetingPrompt(prompt),
    });
    yield* Effect.gen(function* () {
      const reactor = yield* WorkspaceCollaborationReactor;
      yield* reactor.start();
      yield* reactor.drain;
      const run = yield* Ref.get(harness.runRef);
      expect(run.status).toBe("completed");
      const executions = yield* Ref.get(harness.executionsRef);
      expect(executions[0]?.modelSelection.instanceId).toBe("codex-a");
      expect(executions[0]?.prompt).toContain(answer);
      const plan = executions.find((entry) => entry.prompt.startsWith("# Workspace Meeting Plan"));
      expect(plan?.prompt).toContain(answer);
      expect(plan?.modelSelection.instanceId).toBe("codex-a");
      expect(run.graph?.nodes.some((node) => node.kind === "implementation")).toBe(true);
    }).pipe(Effect.provide(harness.layer), Effect.scoped);
  }),
);

for (const answer of [null, "작업하지 말고 설명만 해 주세요."]) {
  it.effect(
    `ends with the conductor's answer and no graph for ${answer === null ? "a question" : "an explanation-only reply"}`,
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({
          run: meetingRun({
            phase: "clarifying",
            maxRounds: 0,
            answers:
              answer === null
                ? []
                : [{ question: "진행할까요?", answer, answeredAt: at, nodeId: null }],
          }),
          respond: () => "이 프로그램의 역할을 설명합니다. 요청된 작업은 시작하지 않습니다.",
        });
        yield* Effect.gen(function* () {
          const reactor = yield* WorkspaceCollaborationReactor;
          yield* reactor.start();
          yield* reactor.drain;
          const run = yield* Ref.get(harness.runRef);
          expect(run.status).toBe("completed");
          expect(run.graph).toBeNull();
          expect(run.meeting?.phase).toBe("done");
          expect(run.finalOutput).toContain("프로그램의 역할");
          expect(yield* Ref.get(harness.executionsRef)).toHaveLength(1);
        }).pipe(Effect.provide(harness.layer), Effect.scoped);
      }),
  );
}

for (const output of [
  "<t3_ready>바로 실행</t3_ready>",
  '<t3_task_graph>{"nodes":[]}</t3_task_graph>',
]) {
  it.effect(`refuses an attempted execution before an answer: ${output}`, () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        run: meetingRun({ phase: "clarifying", maxRounds: 0 }),
        respond: () => output,
      });
      yield* Effect.gen(function* () {
        const reactor = yield* WorkspaceCollaborationReactor;
        yield* reactor.start();
        yield* reactor.drain;
        expect((yield* Ref.get(harness.runRef)).status).toBe("failed");
        expect((yield* Ref.get(harness.runRef)).graph).toBeNull();
        expect(yield* Ref.get(harness.executionsRef)).toHaveLength(1);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );
}

it.effect("resumes a parked question without calling the conductor again", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness({
      run: meetingRun({
        phase: "clarifying",
        pendingQuestion: {
          question: "진행 범위는?",
          askedByParticipantId: pid("p1"),
          options: [],
          context: "",
          askedAt: at,
          nodeId: null,
        },
      }),
      respond: respondForMeetingPrompt,
    });
    yield* Effect.gen(function* () {
      const reactor = yield* WorkspaceCollaborationReactor;
      yield* reactor.start();
      yield* reactor.drain;
      expect(yield* Ref.get(harness.executionsRef)).toEqual([]);
      expect((yield* Ref.get(harness.runRef)).graph).toBeNull();
    }).pipe(Effect.provide(harness.layer), Effect.scoped);
  }),
);

it.effect("dispatches a finished worker's validator while its slow sibling still runs", () =>
  Effect.gen(function* () {
    const slowStarted = yield* Deferred.make<void>();
    const releaseSlow = yield* Deferred.make<void>();
    const validatorStarted = yield* Deferred.make<void>();
    const harness = yield* makeHarness({
      run: orchestraRun(),
      respond: respondForOrchestraPrompt,
      onTurnStart: ({ prompt }) =>
        Effect.gen(function* () {
          if (prompt.includes("Node: research-p1\n")) {
            yield* Deferred.succeed(slowStarted, undefined);
            yield* Deferred.await(releaseSlow);
          }
          if (prompt.includes("Node: research-p2\n")) yield* Deferred.await(slowStarted);
          if (prompt.includes("Node: validate-research-p2\n"))
            yield* Deferred.succeed(validatorStarted, undefined);
        }),
    });
    yield* Effect.gen(function* () {
      const reactor = yield* WorkspaceCollaborationReactor;
      yield* reactor.start();
      yield* Deferred.await(validatorStarted);
      const partial = yield* Ref.get(harness.runRef);
      expect(partial.graph?.nodes.find((node) => node.id === "research-p1")?.status).toBe(
        "running",
      );
      expect(
        partial.graph?.nodes.filter((node) => node.status === "running").length,
      ).toBeLessThanOrEqual(2);
      yield* Deferred.succeed(releaseSlow, undefined);
      yield* reactor.drain;
      expect((yield* Ref.get(harness.runRef)).status).toBe("completed");
    }).pipe(Effect.provide(harness.layer), Effect.scoped);
  }),
);

it.effect(
  "parks before execution, saves a human edit without spending retries, and resumes only on confirmation",
  () =>
    Effect.gen(function* () {
      const completed = yield* Deferred.make<void>();
      const harness = yield* makeHarness({
        run: { ...orchestraRun(), orchestra: { ...orchestraRun().orchestra!, reviewPlan: true } },
        respond: respondForOrchestraPrompt,
        onRunUpdated: (run) =>
          run.status === "completed"
            ? Deferred.succeed(completed, undefined).pipe(Effect.asVoid)
            : Effect.void,
      });
      yield* Effect.gen(function* () {
        const reactor = yield* WorkspaceCollaborationReactor;
        yield* reactor.start();
        yield* reactor.drain;
        const parked = yield* Ref.get(harness.runRef);
        expect(parked.graph?.planReview?.status).toBe("pending");
        expect(parked.graph!.nodes.flatMap((node) => node.attempts)).toHaveLength(0);
        const target = parked.graph!.nodes.find((node) => node.id === "research-p2")!;
        const request = {
          projectId,
          runId,
          expectedRevision: 0,
          edits: [
            {
              nodeId: target.id,
              title: "사용자가 고친 작업",
              task: "이 지시로만 조사한다.",
              participantId: target.participantId,
              dependsOn: [],
            },
          ],
          approve: false,
          reviewedAt: at,
        };
        const saved = reviewWorkspaceOrchestraPlan(parked, request)!;
        expect(saved.revision).toBe(parked.graph!.revision);
        expect(saved.planReview?.status).toBe("pending");
        expect(
          reviewWorkspaceOrchestraPlan({ ...parked, graph: saved }, { ...request, approve: true }),
        ).toBeNull();
        const approved = reviewWorkspaceOrchestraPlan(
          { ...parked, graph: saved },
          { ...request, expectedRevision: 1, approve: true },
        )!;
        yield* Ref.set(harness.runRef, { ...parked, graph: approved });
        yield* PubSub.publish(harness.pubsub, {
          type: "project.collaboration-run-reviewed",
          payload: { ...request, expectedRevision: 1, approve: true },
        } as unknown as OrchestrationEvent);
        yield* Deferred.await(completed);
        yield* reactor.drain;
        const executions = yield* Ref.get(harness.executionsRef);
        expect(
          executions.find((execution) => execution.execution.nodeId === target.id)?.prompt,
        ).toContain("이 지시로만 조사한다.");
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
);

it.effect("stops at the persisted worker-turn limit and retains finished output", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness({
      run: { ...orchestraRun(), orchestra: { ...orchestraRun().orchestra!, maxWorkerTurns: 1 } },
      respond: respondForOrchestraPrompt,
    });
    yield* Effect.gen(function* () {
      const reactor = yield* WorkspaceCollaborationReactor;
      yield* reactor.start();
      yield* reactor.drain;
      const run = yield* Ref.get(harness.runRef);
      expect(run.status).toBe("failed");
      expect(run.error).toContain("실행 한도");
      expect(run.graph!.nodes.flatMap((node) => node.attempts)).toHaveLength(1);
      expect(run.graph!.nodes.some((node) => node.output !== null)).toBe(true);
    }).pipe(Effect.provide(harness.layer), Effect.scoped);
  }),
);

it.effect(
  "keeps AI-approved work pending until actual verification passes, then resumes without rerunning workers",
  () =>
    Effect.gen(function* () {
      let passed = false;
      let checks = 0;
      const completed = yield* Deferred.make<void>();
      const harness = yield* makeHarness({
        run: {
          ...orchestraRun(),
          orchestra: {
            ...orchestraRun().orchestra!,
            completionCheck: true,
            verificationCommands: ["test-command"],
          },
        },
        respond: respondForMeetingPrompt,
        onRunUpdated: (run) =>
          run.status === "completed"
            ? Deferred.succeed(completed, undefined).pipe(Effect.asVoid)
            : Effect.void,
      });
      const git = Layer.mock(WorkspaceDevelopmentGit)({
        inspect: () =>
          Effect.succeed({
            sha: "base",
            branch: "main",
            commonDirectory: "repo",
            clean: true,
            fingerprint: "current",
          }),
        verify: (_cwd, commands) =>
          Effect.sync(() => {
            checks++;
            return {
              passed,
              artifacts: [],
              commands: commands.map((command) => ({
                ...command,
                exitCode: passed ? 0 : 7,
                timedOut: false,
                logPath: "receipt.log",
              })),
            };
          }),
      });
      yield* Effect.gen(function* () {
        const reactor = yield* WorkspaceCollaborationReactor;
        yield* reactor.start();
        yield* reactor.drain;
        const pending = yield* Ref.get(harness.runRef);
        expect(pending.graph?.status).toBe("completed");
        expect(pending.status).toBe("running");
        expect(pending.graph?.delivery?.status).toBe("failed");
        expect(pending.graph?.delivery?.commands[0]?.exitCode).toBe(7);
        expect(pending.finalOutput).toContain("구현 완료");
        const workersBefore = (yield* Ref.get(harness.executionsRef)).length;
        passed = true;
        yield* Ref.set(harness.runRef, {
          ...pending,
          graph: {
            ...pending.graph!,
            delivery: { ...pending.graph!.delivery!, status: "verifying" },
          },
        });
        yield* PubSub.publish(harness.pubsub, {
          type: "project.collaboration-verification-requested",
          payload: { projectId, runId, verificationCommands: ["test-command"], requestedAt: at },
        } as unknown as OrchestrationEvent);
        yield* Deferred.await(completed);
        yield* reactor.drain;
        expect((yield* Ref.get(harness.runRef)).graph?.delivery?.status).toBe("passed");
        expect((yield* Ref.get(harness.executionsRef)).length).toBe(workersBefore);
        expect(checks).toBe(2);
      }).pipe(Effect.provide(harness.layer.pipe(Layer.provide(git))), Effect.scoped);
    }),
);

it.effect(
  "cancels verification immediately and interrupts its worker without marking completion",
  () =>
    Effect.gen(function* () {
      const verificationStarted = yield* Deferred.make<void>();
      const interrupted = yield* Deferred.make<void>();
      const cancelled = yield* Deferred.make<void>();
      const harness = yield* makeHarness({
        run: {
          ...orchestraRun(),
          orchestra: {
            ...orchestraRun().orchestra!,
            completionCheck: true,
            verificationCommands: ["test-command"],
          },
        },
        respond: respondForMeetingPrompt,
        onRunUpdated: (run) =>
          run.status === "cancelled"
            ? Deferred.succeed(cancelled, undefined).pipe(Effect.asVoid)
            : Effect.void,
      });
      const git = Layer.mock(WorkspaceDevelopmentGit)({
        inspect: () =>
          Effect.succeed({
            sha: "base",
            branch: "main",
            commonDirectory: "repo",
            clean: true,
            fingerprint: "current",
          }),
        verify: () =>
          Deferred.succeed(verificationStarted, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(Deferred.succeed(interrupted, undefined)),
          ),
      });
      yield* Effect.gen(function* () {
        const reactor = yield* WorkspaceCollaborationReactor;
        yield* reactor.start();
        yield* Deferred.await(verificationStarted);
        yield* Ref.update(harness.runRef, (run) => ({
          ...run,
          status: "cancel-requested" as const,
        }));
        yield* PubSub.publish(harness.pubsub, {
          type: "project.collaboration-run-cancel-requested",
          payload: { projectId, runId, cancelledAt: at },
        } as unknown as OrchestrationEvent);
        yield* Deferred.await(interrupted);
        yield* Deferred.await(cancelled);
        yield* reactor.drain;
        expect((yield* Ref.get(harness.runRef)).status).toBe("cancelled");
      }).pipe(Effect.provide(harness.layer.pipe(Layer.provide(git))), Effect.scoped);
    }),
);

it.effect("parks a genuine limit without occupying the run and resumes once at its deadline", () =>
  Effect.gen(function* () {
    const waiting = yield* Deferred.make<void>();
    const resumed = yield* Deferred.make<void>();
    let limited = false;
    const run = orchestraRun();
    const harness = yield* makeHarness({
      run: { ...run, orchestra: { ...run.orchestra!, resumeAfterLimit: true } },
      respond: respondForOrchestraPrompt,
      executionFailure: (execution) => {
        if (execution.prompt.includes("Node: research-p1\n") && !limited) {
          limited = true;
          return new WorkspaceAgentExecutionError({
            message: "HTTP 429 Too Many Requests; Retry-After: 60",
          });
        }
        return undefined;
      },
      onTurnStart: ({ prompt }) =>
        prompt.includes("Node: research-p1\n")
          ? Deferred.succeed(resumed, undefined).pipe(Effect.asVoid)
          : Effect.void,
      onRunUpdated: (run) =>
        run.graph?.nodes.some((n) => n.usageRecovery?.phase === "waiting")
          ? Deferred.succeed(waiting, undefined).pipe(Effect.asVoid)
          : Effect.void,
    });
    yield* Effect.gen(function* () {
      const reactor = yield* WorkspaceCollaborationReactor;
      yield* reactor.start();
      yield* Deferred.await(waiting);
      yield* reactor.drain;
      const parked = yield* Ref.get(harness.runRef);
      expect(parked.status).toBe("running");
      expect(parked.graph?.nodes.find((n) => n.id === "research-p1")?.attempts).toHaveLength(1);
      yield* TestClock.adjust("61 seconds");
      yield* Deferred.await(resumed);
      yield* reactor.drain;
      const done = yield* Ref.get(harness.runRef);
      expect(done.status, done.error ?? undefined).toBe("completed");
      expect(done.graph?.nodes.find((n) => n.id === "research-p1")?.attempts).toHaveLength(2);
    }).pipe(Effect.provide(harness.layer), Effect.scoped);
  }),
);

for (const cancel of [false, true]) {
  it.effect(`restores a persisted usage wait on startup (cancel=${cancel})`, () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const cancelled = yield* Deferred.make<void>();
      const graph = buildInitialWorkspaceTaskGraph("recovered task");
      const run = orchestraRun({ phase: "executing" });
      const harness = yield* makeHarness({
        run: {
          ...run,
          status: "running",
          orchestra: { ...run.orchestra!, resumeAfterLimit: true },
          graph: {
            ...graph,
            status: "executing",
            nodes: graph.nodes.map((n) => ({
              ...n,
              kind: "research",
              participantId: pid("p1"),
              usageRecovery: {
                fingerprint: "persisted",
                resumeAt: "1970-01-01T00:01:01.000Z",
                count: 1,
                phase: "waiting",
                lastError: "HTTP 429",
              },
            })),
          },
        },
        respond: () => seatQuestion("재개한 작업 확인"),
        onTurnStart: () => Deferred.succeed(entered, undefined).pipe(Effect.asVoid),
        onRunUpdated: (run) =>
          run.status === "cancelled"
            ? Deferred.succeed(cancelled, undefined).pipe(Effect.asVoid)
            : Effect.void,
      });
      yield* Effect.gen(function* () {
        const reactor = yield* WorkspaceCollaborationReactor;
        yield* reactor.start();
        yield* reactor.drain;
        expect(yield* Ref.get(harness.executionsRef)).toHaveLength(0);
        if (cancel) {
          yield* Ref.update(harness.runRef, (r) => ({ ...r, status: "cancel-requested" as const }));
          yield* PubSub.publish(harness.pubsub, {
            type: "project.collaboration-run-cancel-requested",
            payload: { projectId, runId, cancelledAt: at },
          } as OrchestrationEvent);
          yield* Deferred.await(cancelled);
          yield* reactor.drain;
        }
        yield* TestClock.adjust("61 seconds");
        if (!cancel) {
          yield* Deferred.await(entered);
          yield* reactor.drain;
          expect((yield* Ref.get(harness.runRef)).meeting?.pendingQuestion?.question).toBe(
            "재개한 작업 확인",
          );
        } else {
          yield* reactor.drain;
          expect(yield* Ref.get(harness.executionsRef)).toHaveLength(0);
          expect((yield* Ref.get(harness.runRef)).status).toBe("cancelled");
        }
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );
}

for (const maxRounds of [0, 1]) {
  it.effect(
    `live executor: plans without a graph and completes with agent control enabled (rounds=${maxRounds})`,
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({
          liveExecutor: true,
          run: orchestraRun({ maxRounds, phase: maxRounds === 0 ? "planning" : "discussing" }),
          respond: respondForOrchestraPrompt,
        });
        yield* Effect.gen(function* () {
          const reactor = yield* WorkspaceCollaborationReactor;
          yield* reactor.start();
          yield* reactor.drain;
          const done = yield* Ref.get(harness.runRef);
          expect(done.error).toBeNull();
          expect(done.status).toBe("completed");
          expect(done.graph?.nodes.some((node) => node.attempts.length > 0)).toBe(true);
          const prompts = yield* Ref.get(harness.promptsRef);
          expect(
            prompts.filter((prompt) => prompt.startsWith("# Workspace Meeting Plan")),
          ).toHaveLength(1);
          expect(
            prompts.find((prompt) => prompt.startsWith("# Workspace Meeting Plan")),
          ).not.toContain("<workspace_agent_mailbox>");
          expect(prompts.some((prompt) => prompt.includes("<workspace_agent_mailbox>"))).toBe(true);
          const control = Option.getOrThrow(yield* Effect.serviceOption(WorkspaceAgentControl));
          const records = (yield* control.overview({ projectId, runId })).records;
          const handoff = records.find((record) => record.recordType === "handoff");
          expect(handoff).toBeDefined();
          const evidence = yield* control.evidence({ projectId, runId, recordId: handoff!.id });
          expect(prompts).toContain(evidence.text);
          const missing = yield* control
            .prepare({
              projectId,
              runId,
              nodeId: WorkspaceTaskNodeId.make("missing-task"),
              executionId: "orchestra:run-m:missing-task:1",
              prompt: "must not be submitted",
              model: "test-model",
              providerInstanceId: "codex-a",
            })
            .pipe(Effect.result);
          expect(missing).toMatchObject({
            _tag: "Failure",
            failure: { message: "인계할 작업 단계를 찾을 수 없습니다." },
          });
        }).pipe(Effect.provide(harness.layer), Effect.scoped);
      }),
  );
}

it.effect("live executor: asks before creating a graph with agent control enabled", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness({
      liveExecutor: true,
      run: orchestraRun({ phase: "clarifying", maxRounds: 0, chairParticipantId: pid("p2") }),
      respond: () => seatQuestion("분석할 지표의 기간과 출처를 알려 주세요."),
    });
    yield* Effect.gen(function* () {
      const reactor = yield* WorkspaceCollaborationReactor;
      yield* reactor.start();
      yield* reactor.drain;
      const parked = yield* Ref.get(harness.runRef);
      expect(parked.error).toBeNull();
      expect(parked.graph).toBeNull();
      expect(parked.meeting?.pendingQuestion?.question).toBe(
        "분석할 지표의 기간과 출처를 알려 주세요.",
      );
      expect(yield* Ref.get(harness.promptsRef)).toHaveLength(1);
    }).pipe(Effect.provide(harness.layer), Effect.scoped);
  }),
);

for (const runtimeMode of [
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
] as const) {
  it.effect(`uses the app-selected ${runtimeMode} for the conductor and every task phase`, () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        run: orchestraRun({ runtimeMode, interactionMode: "default" }),
        respond: respondForOrchestraPrompt,
      });
      yield* Effect.gen(function* () {
        const reactor = yield* WorkspaceCollaborationReactor;
        yield* reactor.start();
        yield* reactor.drain;
        expect((yield* Ref.get(harness.runRef)).status).toBe("completed");
        const executions = yield* Ref.get(harness.executionsRef);
        expect(executions.some((e) => e.orchestraPhase === "meeting")).toBe(true);
        expect(executions.some((e) => e.kind === "research")).toBe(true);
        expect(executions.every((e) => e.runtimeMode === runtimeMode)).toBe(true);
        expect(executions.every((e) => e.interactionMode === "default")).toBe(true);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );
}

it.effect("keeps the app-selected plan interaction mode on the conductor", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness({
      run: orchestraRun({
        phase: "clarifying",
        runtimeMode: "approval-required",
        interactionMode: "plan",
      }),
      respond: () => seatQuestion("계획에서 확인할 정보를 알려 주세요."),
    });
    yield* Effect.gen(function* () {
      const reactor = yield* WorkspaceCollaborationReactor;
      yield* reactor.start();
      yield* reactor.drain;
      const executions = yield* Ref.get(harness.executionsRef);
      expect(executions).toHaveLength(1);
      expect(executions[0]).toMatchObject({
        runtimeMode: "approval-required",
        interactionMode: "plan",
      });
      expect((yield* Ref.get(harness.runRef)).graph).toBeNull();
    }).pipe(Effect.provide(harness.layer), Effect.scoped);
  }),
);
