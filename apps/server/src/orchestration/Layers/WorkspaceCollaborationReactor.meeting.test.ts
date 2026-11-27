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
  WorkspaceMeetingSetup,
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
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
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
  nodeRefusalQuestion,
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
import { WorkspaceDevelopment } from "../WorkspaceDevelopment.ts";

const encodeJsonFixture = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

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
  readonly persistentContext?: string;
  readonly memoryDirective?: string;
  readonly memoryContext?: string;
  readonly memoryFailure?: boolean;
  readonly memorySaveReceipt?: string;
  readonly memoryPaths?: ReadonlyArray<string>;
  readonly memoryPathsFailure?: boolean;
  readonly compactHandoffs?: boolean;
  readonly liveExecutor?: boolean;
  readonly run: WorkspaceCollaborationRun;
  readonly additionalRun?: WorkspaceCollaborationRun;
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
    const additionalRunRef = yield* Ref.make(input.additionalRun ?? null);
    const threadsRef = yield* Ref.make(
      new Map<string, OrchestrationThread>(
        (input.existingThreads ?? []).map((thread) => [thread.id, thread]),
      ),
    );
    const commandsRef = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
    const promptsRef = yield* Ref.make<ReadonlyArray<string>>([]);
    const compositionsRef = yield* Ref.make<ReadonlyArray<WorkspacePromptComposeInput>>([]);
    const executionsRef = yield* Ref.make<ReadonlyArray<WorkspaceAgentExecutionInput>>([]);
    const memoryCallsRef = yield* Ref.make<ReadonlyArray<{ input: unknown; context: unknown }>>([]);
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
            if (command.run.id === input.run.id) yield* Ref.set(runRef, command.run);
            else yield* Ref.set(additionalRunRef, command.run);
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
        Effect.all([Ref.get(runRef), Ref.get(additionalRunRef)]).pipe(
          Effect.map(([first, second]) => {
            const run = [first, second].find(
              (candidate) =>
                candidate?.projectId === requestedProjectId && candidate.id === requestedRunId,
            );
            return run ? Option.some(withLiveInterjections(run)) : Option.none();
          }),
        ),
      list: (listInput) =>
        Effect.all([Ref.get(runRef), Ref.get(additionalRunRef)]).pipe(
          Effect.map(([first, second]) =>
            [first, ...(second ? [second] : [])].filter(
              (candidate) =>
                candidate.projectId === listInput.projectId &&
                (listInput.statuses === undefined || listInput.statuses.includes(candidate.status)),
            ),
          ),
        ),
      listResumable: () =>
        Effect.all([Ref.get(runRef), Ref.get(additionalRunRef)]).pipe(
          Effect.map(([first, second]) => [first, ...(second ? [second] : [])]),
        ),
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
      listUnavailable: Effect.succeed([]),
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
        input.persistentContext === undefined
          ? Layer.empty
          : Layer.mock(WorkspaceDevelopment)({
              workflowContext: () => Effect.succeed(input.persistentContext!),
            }),
      ),
      Layer.provideMerge(
        input.memoryDirective === undefined &&
          !input.memoryFailure &&
          input.memoryPaths === undefined
          ? Layer.empty
          : Layer.mock(WorkspaceMemory)({
              invoke: (action, context) =>
                Ref.update(memoryCallsRef, (calls) => [...calls, { input: action, context }]).pipe(
                  Effect.as(input.memorySaveReceipt ?? '{"id":"saved","saved":true}'),
                ),
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
                      run:
                        execution.execution.runId === input.run.id
                          ? yield* Ref.get(runRef)
                          : (yield* Ref.get(additionalRunRef))!,
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
      additionalRunRef,
      promptsRef,
      compositionsRef,
      executionsRef,
      memoryCallsRef,
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
const decodeMeetingSetup = Schema.decodeUnknownEffect(WorkspaceMeetingSetup);

it.effect("does not add persistent workspace instructions to an independent meeting", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness({
      run: orchestraRun(),
      persistentContext: "OLD_PERSISTENT_WORKSPACE_CONTEXT",
      respond: respondForOrchestraPrompt,
    });
    yield* Effect.gen(function* () {
      const reactor = yield* WorkspaceCollaborationReactor;
      yield* reactor.start();
      yield* reactor.drain;
      expect((yield* Ref.get(harness.runRef)).status).toBe("completed");
      expect(
        (yield* Ref.get(harness.compositionsRef)).every(
          (request) => !request.task.includes("OLD_PERSISTENT_WORKSPACE_CONTEXT"),
        ),
      ).toBe(true);
    }).pipe(Effect.provide(harness.layer), Effect.scoped);
  }),
);

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
      if ((yield* HostProcessPlatform) === "win32") {
        expect(
          executions.every((execution) => execution.prompt.includes("<t3_windows_shell_policy>")),
        ).toBe(true);
      }
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

for (const phase of ["statement", "chair close", "plan"] as const) {
  for (const asError of [false, true]) {
    it.effect(`preserves a ${phase} safety refusal without another call (error=${asError})`, () =>
      Effect.gen(function* () {
        const refusal = "Your message was flagged by Claude's safeguards.";
        const prefix =
          phase === "statement"
            ? "# Workspace Meeting Statement"
            : phase === "chair close"
              ? "# Workspace Meeting Round Close"
              : "# Workspace Meeting Plan";
        const harness = yield* makeHarness({
          run:
            phase === "plan"
              ? meetingRun({ maxRounds: 0, phase: "planning" })
              : meetingRun({ answers: [executeWrapUp(1)] }),
          respond: (prompt) =>
            prompt.startsWith(prefix) && !asError ? refusal : respondForMeetingPrompt(prompt),
          executionFailure: (execution) =>
            asError && execution.prompt.startsWith(prefix)
              ? new WorkspaceAgentExecutionError({ message: refusal })
              : undefined,
        });
        const failed = yield* Effect.gen(function* () {
          const reactor = yield* WorkspaceCollaborationReactor;
          yield* reactor.start();
          yield* reactor.drain;
          const run = yield* Ref.get(harness.runRef);
          const attempts = (yield* Ref.get(harness.executionsRef)).filter((entry) =>
            entry.prompt.startsWith(prefix),
          );
          expect(attempts).toHaveLength(1);
          expect(run.status).toBe("failed");
          expect(run.error).toContain(refusal);
          expect(run.meeting?.turnFailures?.at(-1)).toMatchObject({ count: 1 });
          expect(run.meeting?.turnFailures?.at(-1)?.message).toContain(refusal);
          return run;
        }).pipe(Effect.provide(harness.layer), Effect.scoped);
        const decoded = yield* decodeRunJson(yield* encodeRunJson(failed));
        const resumed = yield* makeHarness({
          run: { ...decoded, status: "running", error: null },
          respond: respondForMeetingPrompt,
        });
        yield* Effect.gen(function* () {
          const reactor = yield* WorkspaceCollaborationReactor;
          yield* reactor.start();
          yield* reactor.drain;
          expect(yield* Ref.get(resumed.executionsRef)).toHaveLength(0);
          expect((yield* Ref.get(resumed.runRef)).error).toContain(refusal);
        }).pipe(Effect.provide(resumed.layer), Effect.scoped);
      }),
    );
  }
}

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
          expect(executions.every((entry) => entry.allowAdditionalSkillWorkers === true)).toBe(
            true,
          );
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
                id: MessageId.make(`workflow-request:${runId}`),
                role: "user",
                text: "RESEARCHER_ROLE_CANARY: 연구자에게 출처 검증 역할을 맡겨라",
                streaming: false,
                createdAt: at,
                updatedAt: at,
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
          expect(prompts.find((prompt) => prompt.startsWith("# Workspace Meeting Plan"))).toContain(
            "RESEARCHER_ROLE_CANARY",
          );
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

it.effect("keeps a refused node on its selected model even if reassignment is requested", () =>
  Effect.gen(function* () {
    const refusal = "Your message was flagged by Claude's safeguards.";
    const base = meetingRun({ answers: [executeWrapUp(1)] });
    const harness = yield* makeHarness({
      run: {
        ...base,
        meeting: {
          ...base.meeting!,
          participants: base.meeting!.participants.map((participant, index) =>
            index === 0 ? { ...participant, roleDescription: "개발 방향 감독" } : participant,
          ),
        },
      },
      respond: (prompt) =>
        prompt.startsWith("사용자가 요청한 통합 작업의 감독자입니다")
          ? '<t3_persistent_verdict>{"decision":"complete","summary":"추가 지시 확인"}</t3_persistent_verdict>'
          : prompt.includes("Return one strict receipt between <t3_validation>")
            ? refusal
            : respondForMeetingPrompt(prompt),
    });
    yield* Effect.gen(function* () {
      const reactor = yield* WorkspaceCollaborationReactor;
      yield* reactor.start();
      yield* reactor.drain;
      const parked = yield* Ref.get(harness.runRef);
      const node = parked.graph?.nodes.find((entry) => entry.kind === "validation");
      expect(node?.status).toBe("awaiting-user");
      expect(node?.attempts).toHaveLength(1);
      const question = nodeRefusalQuestion(node!.title);
      expect(parked.meeting?.pendingQuestion?.question).toBe(question);
      expect(parked.meeting?.pendingQuestion?.options).not.toContain("다른 좌석에게 맡기기");
      expect(parked.meeting?.pendingQuestion?.context).toContain(refusal);
      const executionsBefore = (yield* Ref.get(harness.executionsRef)).length;
      let reviewed = 0;
      for (const answer of [
        "다른 모델에게 맡기기",
        "재시도하지 말고 가능한 다른 작업은 계속해",
        "건너뛰지 마",
        "남은 작업은 담당자에게 맡겨",
        "계속해",
      ]) {
        yield* Ref.update(harness.runRef, (run) => ({
          ...run,
          meeting: {
            ...run.meeting!,
            pendingQuestion: null,
            answers: [
              ...run.meeting!.answers,
              { question, answer, answeredAt: at, nodeId: node!.id },
            ],
          },
        }));
        yield* PubSub.publish(harness.pubsub, answeredEvent(question, answer));
        yield* reactor.drain;
        const again = yield* Ref.get(harness.runRef);
        const same = again.graph?.nodes.find((entry) => entry.id === node!.id);
        expect(same?.status).toBe("awaiting-user");
        expect(same?.participantId).toBe(node?.participantId);
        expect(same?.attempts).toHaveLength(1);
        expect(again.meeting?.pendingQuestion?.context).toContain("우회할 수 없습니다");
        expect(again.meeting?.answers.at(-1)?.answer).toBe(answer);
        if (answer !== "다른 모델에게 맡기기") reviewed += 1;
        const executions = yield* Ref.get(harness.executionsRef);
        expect(executions).toHaveLength(executionsBefore + reviewed);
        if (answer !== "다른 모델에게 맡기기") {
          expect(again.meeting?.refusalInstructionReview?.status).toBe("completed");
          expect(executions.at(-1)?.prompt).toContain(answer);
          expect(executions.at(-1)?.prompt).toContain("다른 모델이나 계정으로");
          expect(executions.at(-1)?.prompt).toContain(
            "사용자가 지정한 감독자 역할: 개발 방향 감독",
          );
          expect(executions.at(-1)?.modelSelection).toEqual(
            parked.meeting?.participants[0]?.modelSelection,
          );
        }
      }
      const answer = "이 단계 건너뛰고 계속";
      yield* Ref.update(harness.runRef, (run) => ({
        ...run,
        meeting: {
          ...run.meeting!,
          pendingQuestion: null,
          answers: [
            ...run.meeting!.answers,
            { question, answer, answeredAt: at, nodeId: node!.id },
          ],
        },
      }));
      yield* PubSub.publish(harness.pubsub, answeredEvent(question, answer));
      const resumed = yield* awaitRunStatus(harness.runRef, "completed");
      expect(resumed.graph?.nodes.find((entry) => entry.id === node!.id)?.output).toContain(
        "건너뛰",
      );
      const review = (yield* Ref.get(harness.promptsRef)).find((prompt) =>
        prompt.startsWith("사용자가 요청한 통합 작업의 감독자입니다"),
      );
      expect(review).toContain("재시도하지 말고 가능한 다른 작업은 계속해");
      expect(review).toContain("건너뛰지 마");
      expect(resumed.meeting?.pendingSupervisorReview).toBe(false);
    }).pipe(Effect.provide(harness.layer), Effect.scoped);
  }),
);

it.effect("keeps the supervisor review obligation after a pending refusal is restored", () =>
  Effect.gen(function* () {
    const refusal = "Your message was flagged by Claude's safeguards.";
    const respond = (prompt: string) =>
      prompt.startsWith("사용자가 요청한 통합 작업의 감독자입니다")
        ? '<t3_persistent_verdict>{"decision":"complete","summary":"추가 지시 확인"}</t3_persistent_verdict>'
        : prompt.includes("Return one strict receipt between <t3_validation>")
          ? refusal
          : respondForMeetingPrompt(prompt);
    const first = yield* makeHarness({
      run: meetingRun({ answers: [executeWrapUp(1)] }),
      respond,
    });
    const saved = yield* Effect.gen(function* () {
      const reactor = yield* WorkspaceCollaborationReactor;
      yield* reactor.start();
      yield* reactor.drain;
      const parked = yield* Ref.get(first.runRef);
      const node = parked.graph!.nodes.find((entry) => entry.kind === "validation")!;
      const question = parked.meeting!.pendingQuestion!.question;
      const answer = "이 결과도 감독자가 확인해";
      yield* Ref.update(first.runRef, (run) => ({
        ...run,
        meeting: {
          ...run.meeting!,
          pendingQuestion: null,
          answers: [...run.meeting!.answers, { question, answer, answeredAt: at, nodeId: node.id }],
        },
      }));
      yield* PubSub.publish(first.pubsub, answeredEvent(question, answer));
      yield* reactor.drain;
      return yield* decodeRunJson(yield* encodeRunJson(yield* Ref.get(first.runRef)));
    }).pipe(Effect.provide(first.layer), Effect.scoped);
    expect(saved.meeting?.pendingSupervisorReview).toBe(true);
    const second = yield* makeHarness({ run: saved, respond });
    yield* Effect.gen(function* () {
      const reactor = yield* WorkspaceCollaborationReactor;
      yield* reactor.start();
      yield* reactor.drain;
      expect(yield* Ref.get(second.executionsRef)).toHaveLength(0);
      const question = saved.meeting!.pendingQuestion!.question;
      const nodeId = saved.meeting!.pendingQuestion!.nodeId!;
      const answer = "이 단계 건너뛰고 계속";
      yield* Ref.update(second.runRef, (run) => ({
        ...run,
        meeting: {
          ...run.meeting!,
          pendingQuestion: null,
          answers: [...run.meeting!.answers, { question, answer, answeredAt: at, nodeId }],
        },
      }));
      yield* PubSub.publish(second.pubsub, answeredEvent(question, answer));
      const completed = yield* awaitRunStatus(second.runRef, "completed");
      const review = (yield* Ref.get(second.promptsRef)).find((prompt) =>
        prompt.startsWith("사용자가 요청한 통합 작업의 감독자입니다"),
      );
      expect(review).toContain("이 결과도 감독자가 확인해");
      expect(completed.meeting?.pendingSupervisorReview).toBe(false);
    }).pipe(Effect.provide(second.layer), Effect.scoped);
  }),
);

for (const priorStatus of ["completed", "running"] as const) {
  it.effect(`recovers a ${priorStatus} supervisor review without calling the provider again`, () =>
    Effect.gen(function* () {
      const prefix = "사용자가 통합 작업에 추가 지시를 보냈습니다";
      const respond = (prompt: string) =>
        prompt.includes("Return one strict receipt between <t3_validation>")
          ? "Your message was flagged by Claude's safeguards."
          : respondForMeetingPrompt(prompt);
      const first = yield* makeHarness({
        run: meetingRun({ answers: [executeWrapUp(1)] }),
        liveExecutor: true,
        respond,
      });
      const snapshot = yield* Effect.gen(function* () {
        const reactor = yield* WorkspaceCollaborationReactor;
        yield* reactor.start();
        yield* reactor.drain;
        const parked = yield* Ref.get(first.runRef);
        const question = parked.meeting!.pendingQuestion!.question;
        const nodeId = parked.meeting!.pendingQuestion!.nodeId!;
        const answer = "남은 작업을 확인해";
        yield* Ref.update(first.runRef, (run) => ({
          ...run,
          meeting: {
            ...run.meeting!,
            pendingQuestion: null,
            answers: [...run.meeting!.answers, { question, answer, answeredAt: at, nodeId }],
          },
        }));
        yield* PubSub.publish(first.pubsub, answeredEvent(question, answer));
        yield* reactor.drain;
        const run = yield* Ref.get(first.runRef);
        expect(run.meeting?.refusalInstructionReview?.status).toBe("completed");
        expect(
          (yield* Ref.get(first.promptsRef)).filter((prompt) => prompt.startsWith(prefix)),
        ).toHaveLength(1);
        const executionId = `orchestra-refusal-review:${run.id}:${run.meeting!.refusalInstructionReview!.answerCount}`;
        const messageId = `orchestra-message:${executionId}:1`;
        const activityId = `orchestra-block:${executionId}:1`;
        const activityCommands = yield* Ref.get(first.commandsRef);
        const threads = [...(yield* Ref.get(first.threadsRef)).values()].map((thread) => {
          const activities = new Map(thread.activities.map((activity) => [activity.id, activity]));
          for (const command of activityCommands) {
            if (command.type === "thread.activity.append" && command.threadId === thread.id)
              activities.set(command.activity.id, command.activity);
          }
          return {
            ...thread,
            messages: thread.messages.map((message) =>
              priorStatus === "running" && message.id === messageId
                ? { ...message, streaming: true }
                : message,
            ),
            activities: [...activities.values()].map((activity) =>
              priorStatus === "running" && activity.id === activityId
                ? { ...activity, payload: { ...(activity.payload as object), status: "running" } }
                : activity,
            ),
          };
        });
        return {
          run: yield* decodeRunJson(
            yield* encodeRunJson({
              ...run,
              meeting: {
                ...run.meeting!,
                refusalInstructionReview: {
                  ...run.meeting!.refusalInstructionReview!,
                  status: "pending",
                },
              },
            }),
          ),
          threads,
        };
      }).pipe(Effect.provide(first.layer), Effect.scoped);
      const restored = yield* makeHarness({
        run: snapshot.run,
        existingThreads: snapshot.threads,
        liveExecutor: true,
        respond,
      });
      yield* Effect.gen(function* () {
        const reactor = yield* WorkspaceCollaborationReactor;
        yield* reactor.start();
        yield* reactor.drain;
        expect(yield* Ref.get(restored.promptsRef)).toEqual([]);
        const review = (yield* Ref.get(restored.runRef)).meeting?.refusalInstructionReview;
        expect(review?.status).toBe(priorStatus === "completed" ? "completed" : "failed");
        if (priorStatus === "running") expect(review?.error).toContain("중단된 실행");
      }).pipe(Effect.provide(restored.layer), Effect.scoped);
    }),
  );
}

it.effect("keeps a failed pending-instruction review recorded without retrying it on restart", () =>
  Effect.gen(function* () {
    const prefix = "사용자가 통합 작업에 추가 지시를 보냈습니다";
    const harness = yield* makeHarness({
      run: meetingRun({ answers: [executeWrapUp(1)] }),
      respond: (prompt) =>
        prompt.includes("Return one strict receipt between <t3_validation>")
          ? "Your message was flagged by Claude's safeguards."
          : respondForMeetingPrompt(prompt),
      executionFailure: (execution) =>
        execution.prompt.startsWith(prefix)
          ? new WorkspaceAgentExecutionError({ message: `감독자 연결 실패 ${"E".repeat(25_000)}` })
          : undefined,
    });
    const saved = yield* Effect.gen(function* () {
      const reactor = yield* WorkspaceCollaborationReactor;
      yield* reactor.start();
      yield* reactor.drain;
      const parked = yield* Ref.get(harness.runRef);
      const question = parked.meeting!.pendingQuestion!.question;
      const nodeId = parked.meeting!.pendingQuestion!.nodeId!;
      const answer = "남은 작업을 확인해";
      yield* Ref.update(harness.runRef, (run) => ({
        ...run,
        meeting: {
          ...run.meeting!,
          pendingQuestion: null,
          answers: [...run.meeting!.answers, { question, answer, answeredAt: at, nodeId }],
        },
      }));
      yield* PubSub.publish(harness.pubsub, answeredEvent(question, answer));
      yield* reactor.drain;
      const failed = yield* Ref.get(harness.runRef);
      expect(failed.status).toBe("running");
      expect(failed.meeting?.refusalInstructionReview).toMatchObject({
        status: "failed",
        error: expect.stringContaining("감독자 연결 실패"),
      });
      expect(failed.meeting?.pendingQuestion?.context).toContain("감독자 연결 실패");
      expect(failed.meeting!.pendingQuestion!.context.length).toBeLessThanOrEqual(20_000);
      expect(
        (yield* Ref.get(harness.commandsRef)).some(
          (command) =>
            command.type === "thread.activity.append" &&
            command.activity.kind === "orchestra.instruction-review.failed" &&
            command.activity.summary.includes("감독자 연결 실패"),
        ),
      ).toBe(true);
      return yield* decodeRunJson(yield* encodeRunJson(failed));
    }).pipe(Effect.provide(harness.layer), Effect.scoped);
    const restored = yield* makeHarness({ run: saved, respond: respondForMeetingPrompt });
    yield* Effect.gen(function* () {
      const reactor = yield* WorkspaceCollaborationReactor;
      yield* reactor.start();
      yield* reactor.drain;
      expect(yield* Ref.get(restored.executionsRef)).toHaveLength(0);
      expect((yield* Ref.get(restored.runRef)).meeting?.refusalInstructionReview?.status).toBe(
        "failed",
      );
    }).pipe(Effect.provide(restored.layer), Effect.scoped);
  }),
);

it.effect("honors cancellation while a supervisor reviews an instruction on a refused node", () =>
  Effect.gen(function* () {
    let cancel: Effect.Effect<void> = Effect.void;
    const harness = yield* makeHarness({
      run: meetingRun({ answers: [executeWrapUp(1)] }),
      respond: (prompt) =>
        prompt.includes("Return one strict receipt between <t3_validation>")
          ? "Your message was flagged by Claude's safeguards."
          : respondForMeetingPrompt(prompt),
      onTurnStart: ({ prompt }) =>
        prompt.startsWith("사용자가 통합 작업에 추가 지시를 보냈습니다") ? cancel : Effect.void,
    });
    cancel = Ref.update(harness.runRef, (run) => ({ ...run, status: "cancel-requested" as const }));
    yield* Effect.gen(function* () {
      const reactor = yield* WorkspaceCollaborationReactor;
      yield* reactor.start();
      yield* reactor.drain;
      const parked = yield* Ref.get(harness.runRef);
      const question = parked.meeting!.pendingQuestion!.question;
      const nodeId = parked.meeting!.pendingQuestion!.nodeId!;
      const answer = "남은 작업을 확인해";
      yield* Ref.update(harness.runRef, (run) => ({
        ...run,
        meeting: {
          ...run.meeting!,
          pendingQuestion: null,
          answers: [...run.meeting!.answers, { question, answer, answeredAt: at, nodeId }],
        },
      }));
      yield* PubSub.publish(harness.pubsub, answeredEvent(question, answer));
      const cancelled = yield* awaitRunStatus(harness.runRef, "cancelled");
      expect(cancelled.meeting?.answers.at(-1)?.answer).toBe(answer);
      expect(cancelled.graph?.nodes.find((node) => node.id === nodeId)?.attempts).toHaveLength(1);
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

it.effect.each([false, true])(
  "executes ten selected seats with independent roles (same model=%s)",
  (sameModel) =>
    Effect.gen(function* () {
      const base = workflowDefaults()[0]!;
      const definition = {
        ...base,
        nodes: Array.from({ length: 9 }, (_, index) => ({
          ...base.nodes[1]!,
          id: `worker-${index}`,
          title: `Worker ${index}`,
          dependsOn: [],
        })),
        revision: 1,
        archived: false,
        digest: "ten-model-fixture",
        createdAt: at,
      };
      const existingThreadId = ThreadId.make("thread-roster-current-request");
      const initial = orchestraRun({
        maxRounds: 0,
        chairParticipantId: pid("p1"),
        threadId: existingThreadId,
      });
      const prototype = initial.meeting!.participants[0]!;
      const participants = Array.from({ length: 10 }, (_, index) => ({
        ...prototype,
        id: pid(`p${index + 1}`),
        displayName: `Selected ${index}`,
        modelSelection: {
          ...prototype.modelSelection,
          model: sameModel ? "shared-model" : `selected-${index}`,
        },
        roleDescription: `role-${index}`,
      }));
      const harness = yield* makeHarness({
        memoryPaths: ["apps/web"],
        existingThreads: [
          {
            id: existingThreadId,
            projectId,
            title: "기존 대화",
            modelSelection: prototype.modelSelection,
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
                id: MessageId.make(`workflow-request:${runId}`),
                role: "user",
                text: "WORKFLOW_ROLE_CANARY: 10번 참가자에게 출처 검증을 맡겨라",
                streaming: false,
                createdAt: at,
                updatedAt: at,
                attachments: [],
                turnId: null,
              },
            ],
            proposedPlans: [],
            activities: [],
            checkpoints: [],
            session: null,
          } as unknown as OrchestrationThread,
        ],
        run: {
          ...initial,
          meeting: { ...initial.meeting!, participants },
          workflow: {
            definitionId: definition.id,
            definitionRevision: 1,
            definitionDigest: definition.digest,
            definition,
            title: definition.title,
            values: { goal: "fixture" },
            nodeSkills: definition.nodes.map((node) => ({ nodeId: node.id, skills: [] })),
            roleBindings: [],
            control: "active",
            controlRevision: 0,
            updatedAt: at,
            requestDigest: "fixture",
          },
        },
        respond: (prompt) =>
          prompt.startsWith("# Saved Workflow Assignment")
            ? `<t3_workflow_assignments>${JSON.stringify({
                assignments: definition.nodes.map((node, index) => ({
                  nodeId: node.id,
                  participantId: participants[index + 1]!.id,
                })),
              })}</t3_workflow_assignments>`
            : respondForMeetingPrompt(prompt),
      });
      yield* Effect.gen(function* () {
        const reactor = yield* WorkspaceCollaborationReactor;
        yield* reactor.start();
        yield* reactor.drain;
        const run = yield* Ref.get(harness.runRef);
        expect(run.status, run.error ?? undefined).toBe("completed");
        const executions = yield* Ref.get(harness.executionsRef);
        const assignmentPrompt = executions.find((entry) =>
          entry.prompt.startsWith("# Saved Workflow Assignment"),
        )?.prompt;
        expect(assignmentPrompt).toContain("WORKFLOW_ROLE_CANARY");
        for (let index = 0; index < definition.nodes.length; index++) {
          const execution = executions.find(
            (entry) => entry.execution.nodeId === definition.nodes[index]!.id,
          );
          expect(execution?.modelSelection).toEqual(participants[index + 1]!.modelSelection);
          expect(execution?.prompt).toContain(`role-${index + 1}`);
        }
        expect(
          executions.every((entry) =>
            participants.some((p) => p.modelSelection.model === entry.modelSelection.model),
          ),
        ).toBe(true);
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

for (const outcome of ["valid", "invalid-participant", "refusal", "question"] as const) {
  it.effect(`lets the selected supervisor assign saved workflow steps (${outcome})`, () =>
    Effect.gen(function* () {
      const definition = {
        ...workflowDefaults()[0]!,
        revision: 1,
        archived: false,
        digest: "fixture-digest",
        createdAt: at,
      };
      const initial = orchestraRun({ maxRounds: 0, chairParticipantId: pid("p1") });
      const participants = initial.meeting!.participants.map((participant, index) => ({
        ...participant,
        roleDescription: index === 0 ? "감독" : "구현 담당",
      }));
      let assignmentCount = 0;
      const completed = yield* Deferred.make<void>();
      const harness = yield* makeHarness({
        run: {
          ...initial,
          meeting: { ...initial.meeting!, participants },
          workflow: {
            definitionId: definition.id,
            definitionRevision: 1,
            definitionDigest: definition.digest,
            definition,
            title: definition.title,
            values: { goal: "workflow target" },
            nodeSkills: definition.nodes.map((node) => ({ nodeId: node.id, skills: [] })),
            roleBindings: [],
            control: "active",
            controlRevision: 0,
            updatedAt: at,
            requestDigest: "fixture",
          },
        },
        respond: (prompt) => {
          if (!prompt.startsWith("# Saved Workflow Assignment"))
            return respondForMeetingPrompt(prompt);
          assignmentCount++;
          if (outcome === "refusal") return "Your message was flagged by Claude's safeguards.";
          if (outcome === "question" && assignmentCount === 1)
            return `<t3_question>${JSON.stringify({ question: "어느 범위인가요?", options: ["전체"], context: "범위 확인" })}</t3_question>`;
          return `<t3_workflow_assignments>${JSON.stringify({
            assignments: definition.nodes
              .filter((node) => node.participantId === null)
              .map((node) => ({
                nodeId: node.id,
                participantId: outcome === "invalid-participant" ? "outside" : "p2",
              })),
          })}</t3_workflow_assignments>`;
        },
        onRunUpdated: (run) =>
          run.status === "completed"
            ? Deferred.succeed(completed, undefined).pipe(Effect.asVoid)
            : Effect.void,
      });
      yield* Effect.gen(function* () {
        const reactor = yield* WorkspaceCollaborationReactor;
        yield* reactor.start();
        yield* reactor.drain;
        let run = yield* Ref.get(harness.runRef);
        if (outcome === "question") {
          const question = run.meeting?.pendingQuestion?.question;
          expect(question).toBe("어느 범위인가요?");
          expect(run.graph).toBeNull();
          yield* Ref.update(harness.runRef, (current) => ({
            ...current,
            meeting: {
              ...current.meeting!,
              pendingQuestion: null,
              answers: [
                ...current.meeting!.answers,
                { question: question!, answer: "전체", answeredAt: at, nodeId: null },
              ],
            },
          }));
          yield* PubSub.publish(harness.pubsub, answeredEvent(question!, "전체"));
          yield* Deferred.await(completed);
          yield* reactor.drain;
          run = yield* Ref.get(harness.runRef);
        }
        const executions = yield* Ref.get(harness.executionsRef);
        const assigned = executions.filter((execution) =>
          execution.prompt.startsWith("# Saved Workflow Assignment"),
        );
        expect(assigned.length).toBeGreaterThan(0);
        expect(assigned[0]!.modelSelection).toEqual(participants[0]!.modelSelection);
        expect(assigned[0]!.prompt).toContain("구현 담당");
        if (outcome === "refusal") {
          expect(run.status).toBe("running");
          expect(run.meeting?.pendingQuestion?.context).toContain("flagged by Claude");
          expect(run.graph?.nodes.find((node) => node.id === "plan")?.status).toBe("awaiting-user");
          expect(assigned).toHaveLength(1);
          expect(
            executions.every((execution) => execution.execution.nodeId === "workflow-assignment"),
          ).toBe(true);
        } else if (outcome === "invalid-participant") {
          expect(run.status).toBe("failed");
          expect(run.error).toContain("명단 밖 참가자");
          expect(
            executions.every((execution) => execution.execution.nodeId === "workflow-assignment"),
          ).toBe(true);
        } else {
          expect(run.status, run.error ?? undefined).toBe("completed");
          if (outcome === "question") {
            expect(assigned).toHaveLength(2);
            expect(assigned[1]!.prompt).toContain("전체");
            expect(assigned[0]!.execution.executionId).not.toBe(assigned[1]!.execution.executionId);
          }
          for (const node of definition.nodes) {
            const actual = run.graph?.nodes.find((entry) => entry.id === node.id);
            expect(actual?.participantId).toBe("p2");
            expect(actual?.handoff.task).toContain("workflow target");
          }
          expect(
            executions.find((execution) => execution.kind === "implementation")?.modelSelection,
          ).toEqual(participants[1]!.modelSelection);
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
}

for (const decision of [
  "다시 시도",
  "재시도 후 질문",
  "이 단계 건너뛰고 계속",
  "여기서 종료",
] as const) {
  it.effect(
    `continues explicitly assigned independent work after assignment refusal (${decision})`,
    () =>
      Effect.gen(function* () {
        const base = workflowDefaults()[0]!;
        const definition = {
          ...base,
          nodes: [
            ...base.nodes.map((node, index) =>
              index === 0 ? { ...node, participantId: "p2" } : node,
            ),
            {
              ...base.nodes[1]!,
              id: "dependent",
              participantId: "p2",
              dependsOn: [base.nodes[1]!.id],
            },
          ],
          revision: 1,
          archived: false,
          digest: "fixture-digest",
          createdAt: at,
        };
        let assignmentCalls = 0;
        const settled = yield* Deferred.make<void>();
        const retryQuestion = yield* Deferred.make<void>();
        const initial = orchestraRun({ maxRounds: 0, chairParticipantId: pid("p1") });
        const harness = yield* makeHarness({
          run: {
            ...initial,
            workflow: {
              definitionId: definition.id,
              definitionRevision: 1,
              definitionDigest: definition.digest,
              definition,
              title: definition.title,
              values: { goal: "workflow target" },
              nodeSkills: definition.nodes.map((node) => ({ nodeId: node.id, skills: [] })),
              roleBindings: [],
              control: "active",
              controlRevision: 0,
              updatedAt: at,
              requestDigest: "fixture",
            },
          },
          respond: (prompt) => {
            if (!prompt.startsWith("# Saved Workflow Assignment"))
              return respondForMeetingPrompt(prompt);
            assignmentCalls++;
            if (assignmentCalls === 1) return "Your message was flagged by Claude's safeguards.";
            if (decision === "재시도 후 질문" && assignmentCalls === 2)
              return `<t3_question>${JSON.stringify({ question: "재배정 범위는?", options: ["전체"], context: "범위 확인" })}</t3_question>`;
            return `<t3_workflow_assignments>${JSON.stringify({
              assignments: [{ nodeId: definition.nodes[1]!.id, participantId: "p2" }],
            })}</t3_workflow_assignments>`;
          },
          onRunUpdated: (run) =>
            Effect.gen(function* () {
              if (["completed", "cancelled"].includes(run.status))
                yield* Deferred.succeed(settled, undefined);
              if (run.meeting?.pendingQuestion?.question === "재배정 범위는?")
                yield* Deferred.succeed(retryQuestion, undefined);
            }),
        });
        yield* Effect.gen(function* () {
          const reactor = yield* WorkspaceCollaborationReactor;
          yield* reactor.start();
          yield* reactor.drain;
          const parked = yield* Ref.get(harness.runRef);
          const question = parked.meeting?.pendingQuestion;
          expect(parked.status).toBe("running");
          expect(question?.context).toContain("flagged by Claude");
          expect(
            parked.graph?.nodes.find((node) => node.id === definition.nodes[0]!.id)?.status,
          ).toBe("completed");
          expect(
            parked.graph?.nodes.find((node) => node.id === definition.nodes[1]!.id)?.status,
          ).toBe("blocked");
          expect(
            parked.graph?.nodes.find((node) => node.id === definition.nodes[1]!.id)?.participantId,
          ).toBeNull();
          expect(parked.steps.some((step) => step.displayName === "담당 미정")).toBe(true);
          expect(
            (yield* Ref.get(harness.executionsRef)).some(
              (execution) => execution.execution.nodeId === definition.nodes[1]!.id,
            ),
          ).toBe(false);
          const restored = yield* decodeRunJson(yield* encodeRunJson(parked));
          expect(restored.graph?.workflowAssignment?.pendingNodeIds).toEqual([
            definition.nodes[1]!.id,
          ]);
          yield* Ref.set(harness.runRef, restored);
          const firstAnswer = decision === "재시도 후 질문" ? "다시 시도" : decision;
          yield* Ref.update(harness.runRef, (run) => ({
            ...run,
            meeting: {
              ...run.meeting!,
              pendingQuestion: null,
              answers: [
                ...run.meeting!.answers,
                {
                  question: question!.question,
                  answer: firstAnswer,
                  answeredAt: at,
                  nodeId: question!.nodeId,
                },
              ],
            },
          }));
          yield* PubSub.publish(harness.pubsub, answeredEvent(question!.question, firstAnswer));
          if (decision === "재시도 후 질문") {
            yield* Deferred.await(retryQuestion);
            const pending = yield* Ref.get(harness.runRef);
            expect(
              pending.graph?.nodes.find((node) => node.id === definition.nodes[1]!.id)?.status,
            ).toBe("blocked");
            const next = pending.meeting!.pendingQuestion!;
            yield* Ref.update(harness.runRef, (run) => ({
              ...run,
              meeting: {
                ...run.meeting!,
                pendingQuestion: null,
                answers: [
                  ...run.meeting!.answers,
                  { question: next.question, answer: "전체", answeredAt: at, nodeId: next.nodeId },
                ],
              },
            }));
            yield* PubSub.publish(harness.pubsub, answeredEvent(next.question, "전체"));
          }
          yield* Deferred.await(settled);
          yield* reactor.drain;
          const run = yield* Ref.get(harness.runRef);
          const missing = run.graph?.nodes.find((node) => node.id === definition.nodes[1]!.id);
          const dependent = run.graph?.nodes.find((node) => node.id === "dependent");
          if (decision === "다시 시도" || decision === "재시도 후 질문") {
            expect(run.status, run.error ?? undefined).toBe("completed");
            expect(missing?.status).toBe("completed");
            expect(missing?.participantId).toBe("p2");
            expect(dependent?.status).toBe("completed");
            expect(assignmentCalls).toBe(decision === "재시도 후 질문" ? 3 : 2);
          } else {
            expect(run.status).toBe(decision === "여기서 종료" ? "cancelled" : "completed");
            expect(missing?.status).toBe(decision === "여기서 종료" ? "cancelled" : "skipped");
            expect(dependent?.status).toBe(decision === "여기서 종료" ? "cancelled" : "skipped");
            if (decision !== "여기서 종료") {
              expect(run.finalOutput).toContain("미수행 단계");
              expect(run.finalOutput).toContain(definition.nodes[1]!.title);
              expect(run.finalOutput).toContain("dependent");
              const saved = yield* decodeRunJson(yield* encodeRunJson(run));
              expect(saved.graph?.workflowSkippedNodeIds).toEqual([
                definition.nodes[1]!.id,
                "dependent",
              ]);
            }
            expect(assignmentCalls).toBe(1);
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
}

it.effect("reuses a completed saved-workflow assignment after a restart", () =>
  Effect.gen(function* () {
    const definition = {
      ...workflowDefaults()[0]!,
      revision: 1,
      archived: false,
      digest: "fixture-digest",
      createdAt: at,
    };
    const initial = orchestraRun({ maxRounds: 0, chairParticipantId: pid("p1") });
    const respond = (prompt: string) =>
      prompt.startsWith("# Saved Workflow Assignment")
        ? `<t3_workflow_assignments>${JSON.stringify({
            assignments: definition.nodes
              .filter((node) => node.participantId === null)
              .map((node) => ({ nodeId: node.id, participantId: "p2" })),
          })}</t3_workflow_assignments>`
        : respondForMeetingPrompt(prompt);
    const first = yield* makeHarness({
      liveExecutor: true,
      run: {
        ...initial,
        workflow: {
          definitionId: definition.id,
          definitionRevision: 1,
          definitionDigest: definition.digest,
          definition,
          title: definition.title,
          values: { goal: "workflow target" },
          nodeSkills: definition.nodes.map((node) => ({ nodeId: node.id, skills: [] })),
          roleBindings: [],
          control: "active",
          controlRevision: 0,
          updatedAt: at,
          requestDigest: "fixture",
        },
      },
      respond,
    });
    const snapshot = yield* Effect.gen(function* () {
      const reactor = yield* WorkspaceCollaborationReactor;
      yield* reactor.start();
      yield* reactor.drain;
      const run = yield* Ref.get(first.runRef);
      expect(
        run.status,
        yield* encodeJsonFixture({
          error: run.error,
          phase: run.meeting?.phase,
          graph: run.graph?.status,
          pending: run.meeting?.pendingQuestion,
        }),
      ).toBe("completed");
      expect(
        (yield* Ref.get(first.promptsRef)).filter((p) =>
          p.startsWith("# Saved Workflow Assignment"),
        ),
      ).toHaveLength(1);
      const commands = yield* Ref.get(first.commandsRef);
      const threads = [...(yield* Ref.get(first.threadsRef)).values()].map((thread) => {
        const activities = new Map(thread.activities.map((activity) => [activity.id, activity]));
        for (const command of commands)
          if (command.type === "thread.activity.append" && command.threadId === thread.id)
            activities.set(command.activity.id, command.activity);
        return { ...thread, activities: [...activities.values()] };
      });
      return {
        run: yield* decodeRunJson(
          yield* encodeRunJson({
            ...run,
            status: "running",
            graph: null,
            steps: [],
            finalOutput: null,
            meeting: { ...run.meeting!, phase: "planning" },
          }),
        ),
        threads,
      };
    }).pipe(
      Effect.provide(
        first.layer.pipe(
          Layer.provideMerge(
            Layer.mock(WorkspaceWorkflowStore)({ retrySafe: () => Effect.succeed(true) }),
          ),
        ),
      ),
      Effect.scoped,
    );
    const restored = yield* makeHarness({
      run: snapshot.run,
      existingThreads: snapshot.threads,
      liveExecutor: true,
      respond,
    });
    yield* Effect.gen(function* () {
      const reactor = yield* WorkspaceCollaborationReactor;
      yield* reactor.start();
      yield* reactor.drain;
      expect(
        (yield* Ref.get(restored.promptsRef)).filter((p) =>
          p.startsWith("# Saved Workflow Assignment"),
        ),
      ).toHaveLength(0);
      const run = yield* Ref.get(restored.runRef);
      expect(
        run.status,
        yield* encodeJsonFixture({
          error: run.error,
          phase: run.meeting?.phase,
          graph: run.graph?.status,
          pending: run.meeting?.pendingQuestion,
        }),
      ).toBe("completed");
      expect(
        run.graph?.nodes.find((node) => node.id === definition.nodes[0]!.id)?.participantId,
      ).toBe("p2");
    }).pipe(
      Effect.provide(
        restored.layer.pipe(
          Layer.provideMerge(
            Layer.mock(WorkspaceWorkflowStore)({ retrySafe: () => Effect.succeed(true) }),
          ),
        ),
      ),
      Effect.scoped,
    );
  }),
);

it.effect(
  "continues independent work while an unavailable selected provider waits for user action",
  () =>
    Effect.gen(function* () {
      const base = orchestraRun();
      const unavailable =
        "선택한 AI 연결을 사용할 수 없습니다. 역할: researcher, 연결: missing, 모델: test. 해당 연결이 등록되어 있지 않습니다.";
      const harness = yield* makeHarness({
        run: { ...base, orchestra: { ...base.orchestra!, maxParallel: 1 } },
        respond: respondForOrchestraPrompt,
        executionFailure: (execution) =>
          execution.prompt.includes("Node: research-p1\n")
            ? new WorkspaceAgentExecutionError({ message: unavailable })
            : undefined,
      });
      yield* Effect.gen(function* () {
        const reactor = yield* WorkspaceCollaborationReactor;
        yield* reactor.start();
        yield* reactor.drain;
        const run = yield* Ref.get(harness.runRef);
        const blocked = run.graph?.nodes.find((node) => node.id === "research-p1");
        const independent = run.graph?.nodes.find((node) => node.id === "research-p2");
        expect(blocked?.status).toBe("awaiting-user");
        expect(blocked?.attempts).toHaveLength(1);
        expect(blocked?.error).toContain(unavailable);
        expect(independent?.attempts).toHaveLength(1);
        expect(independent?.status).not.toBe("queued");
        expect(run.meeting?.pendingQuestion?.question).toContain(
          "선택된 AI 연결을 사용할 수 없습니다",
        );
        expect(run.meeting?.pendingQuestion?.context).toContain("연결: missing");
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
);

it.effect(
  "does not retry a deterministic function name request error and continues unrelated work",
  () =>
    Effect.gen(function* () {
      const base = orchestraRun();
      const message = "Expected 'function.name' to be a string.";
      const harness = yield* makeHarness({
        run: { ...base, orchestra: { ...base.orchestra!, maxParallel: 1 } },
        respond: respondForOrchestraPrompt,
        executionFailure: (execution) =>
          execution.prompt.includes("Node: research-p1\n")
            ? new WorkspaceAgentExecutionError({ message })
            : undefined,
      });
      yield* Effect.gen(function* () {
        const reactor = yield* WorkspaceCollaborationReactor;
        yield* reactor.start();
        yield* reactor.drain;
        const run = yield* Ref.get(harness.runRef);
        const failed = run.graph?.nodes.find((node) => node.id === "research-p1");
        const independent = run.graph?.nodes.find((node) => node.id === "research-p2");
        expect(failed?.status).toBe("awaiting-user");
        expect(failed?.attempts).toHaveLength(1);
        expect(failed?.error).toContain(message);
        expect(independent?.attempts).toHaveLength(1);
        expect(run.meeting?.pendingQuestion?.question).toContain("함수 이름 형식 오류");
        expect(run.meeting?.pendingQuestion?.context).toContain(message);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
);

for (const error of ["handoff input file ENOENT: missing.txt", "인계 파일 해시 불일치"]) {
  it.effect(
    `parks a deterministic input error without retrying or substituting another file: ${error}`,
    () =>
      Effect.gen(function* () {
        const base = orchestraRun();
        const harness = yield* makeHarness({
          run: { ...base, orchestra: { ...base.orchestra!, maxParallel: 1 } },
          respond: respondForOrchestraPrompt,
          executionFailure: (execution) =>
            execution.prompt.includes("Node: research-p1\n")
              ? new WorkspaceAgentExecutionError({ message: error })
              : undefined,
        });
        yield* Effect.gen(function* () {
          const reactor = yield* WorkspaceCollaborationReactor;
          yield* reactor.start();
          yield* reactor.drain;
          const run = yield* Ref.get(harness.runRef);
          const failed = run.graph?.nodes.find((node) => node.id === "research-p1");
          expect(failed?.status).toBe("awaiting-user");
          expect(failed?.attempts).toHaveLength(1);
          expect(failed?.error).toContain(error);
          expect(run.graph?.nodes.find((node) => node.id === "research-p2")?.attempts).toHaveLength(
            1,
          );
          expect(run.meeting?.pendingQuestion?.question).toContain("지정된 입력 자료");
          expect(run.meeting?.pendingQuestion?.context).toContain(error);
        }).pipe(Effect.provide(harness.layer), Effect.scoped);
      }),
  );
}

it.effect("does not automatically resend an input with unconfirmed prior delivery", () =>
  Effect.gen(function* () {
    const base = orchestraRun();
    const error = "이전 입력의 전달·종료가 미확인입니다. 자동 재전송을 중단했습니다.";
    const harness = yield* makeHarness({
      run: { ...base, orchestra: { ...base.orchestra!, maxParallel: 1 } },
      respond: respondForOrchestraPrompt,
      executionFailure: (execution) =>
        execution.prompt.includes("Node: research-p1\n")
          ? new WorkspaceAgentExecutionError({ message: error })
          : undefined,
    });
    yield* Effect.gen(function* () {
      const reactor = yield* WorkspaceCollaborationReactor;
      yield* reactor.start();
      yield* reactor.drain;
      const run = yield* Ref.get(harness.runRef);
      const blocked = run.graph?.nodes.find((node) => node.id === "research-p1");
      expect(blocked?.status).toBe("awaiting-user");
      expect(blocked?.attempts).toHaveLength(1);
      expect(run.meeting?.pendingQuestion?.question).toContain(
        "전달 또는 종료 상태가 확인되지 않아",
      );
      expect(run.graph?.nodes.find((node) => node.id === "research-p2")?.attempts).toHaveLength(1);
    }).pipe(Effect.provide(harness.layer), Effect.scoped);
  }),
);

it.effect("redacts credential-like values from persisted failure and intervention context", () =>
  Effect.gen(function* () {
    const base = orchestraRun();
    const syntheticSecret = "sk-proj-FAKE0123456789abcdef";
    const message = `선택한 AI 연결을 사용할 수 없습니다. api_key=${syntheticSecret}`;
    const harness = yield* makeHarness({
      run: { ...base, orchestra: { ...base.orchestra!, maxParallel: 1 } },
      respond: respondForOrchestraPrompt,
      executionFailure: (execution) =>
        execution.prompt.includes("Node: research-p1\n")
          ? new WorkspaceAgentExecutionError({ message })
          : undefined,
    });
    yield* Effect.gen(function* () {
      const reactor = yield* WorkspaceCollaborationReactor;
      yield* reactor.start();
      yield* reactor.drain;
      const run = yield* Ref.get(harness.runRef);
      const node = run.graph?.nodes.find((entry) => entry.id === "research-p1");
      expect(node?.error).toContain("민감정보 제거");
      expect(node?.error).not.toContain(syntheticSecret);
      expect(node?.attempts[0]?.error).not.toContain(syntheticSecret);
      expect(run.meeting?.pendingQuestion?.context).not.toContain(syntheticSecret);
    }).pipe(Effect.provide(harness.layer), Effect.scoped);
  }),
);

it.effect(
  "passes exact rejected evidence to the repair worker and independently revalidates the correction",
  () =>
    Effect.gen(function* () {
      const evidence = [
        "stop_loss_engine.py:26 entryNotional exists",
        "account_risk_limits.py:178 stopFraction requires separate evidence",
      ];
      const harness = yield* makeHarness({
        run: orchestraRun({ maxRounds: 0, phase: "planning" }),
        respond: (prompt) => {
          if (prompt.includes("Node: validate-build\n")) {
            return `<t3_validation>${JSON.stringify({
              verdict: "fail",
              confidence: "high",
              summary: "entryNotional missing claim is incorrect",
              evidence,
              failureClassification: "implementation",
              nextAction: "correct the claims and revalidate",
              followUpNodes: [
                {
                  id: "fix-claims",
                  kind: "debug",
                  participantId: "p2",
                  title: "근거 정정",
                  task: "잘못된 필드 주장을 정정",
                  goal: "정확한 근거",
                  context: "검증 반려",
                  input: "검증 영수증",
                  constraints: [],
                  expectedOutput: "정정 결과",
                  successCriteria: ["근거 확인"],
                  dependsOn: [],
                  priority: 1,
                },
              ],
            })}</t3_validation>`;
          }
          if (prompt.includes("Node: fix-claims\n"))
            return "확인된 근거에 따라 필드 주장을 정정했습니다.";
          return respondForMeetingPrompt(prompt);
        },
      });
      yield* Effect.gen(function* () {
        const reactor = yield* WorkspaceCollaborationReactor;
        yield* reactor.start();
        yield* reactor.drain;
        const run = yield* Ref.get(harness.runRef);
        const prompts = yield* Ref.get(harness.promptsRef);
        const repair = prompts.find((prompt) => prompt.includes("Node: fix-claims\n"));
        expect(repair).toBeDefined();
        expect(repair).toContain("DIRECT VALIDATION REJECTION RECEIPTS");
        for (const line of evidence) expect(repair).toContain(line);
        expect(run.graph?.nodes.find((node) => node.id === "fix-claims")?.status).toBe("completed");
        expect(
          run.graph?.nodes.find((node) => node.validationTargetId === "fix-claims")?.validation
            ?.verdict,
        ).toBe("pass");
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
);

it.effect(
  "keeps independent role-based work when a selected researcher connection is missing",
  () =>
    Effect.gen(function* () {
      const selected = { instanceId: ProviderInstanceId.make("codex-a"), model: "selected-model" };
      const missing = {
        instanceId: ProviderInstanceId.make("missing-researcher"),
        model: "research-model",
      };
      const roleBindings = (["coordinator", "implementer", "researcher"] as const).map((role) => ({
        projectId,
        role,
        displayName: role,
        modelSelection: role === "researcher" ? missing : selected,
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        instructions: "",
        enabled: true,
        updatedAt: at,
      }));
      const plan = [
        { id: "research", kind: "research", agent: "grok", priority: 2 },
        { id: "build", kind: "implementation", agent: "codex", priority: 1 },
      ].map((entry) => ({
        ...entry,
        title: entry.id,
        task: entry.id,
        goal: "goal",
        context: "context",
        input: "input",
        constraints: [],
        expectedOutput: "evidence",
        successCriteria: ["checked"],
        dependsOn: [],
      }));
      const harness = yield* makeHarness({
        run: {
          ...meetingRun(),
          meeting: null,
          orchestra: { maxParallel: 1, isolateWorktrees: false },
          runContext: { requestDigest: "missing-researcher", roleBindings, requestMode: "direct" },
        },
        respond: (prompt) =>
          prompt.includes("Return one strict machine-readable proposal between <t3_task_graph>")
            ? `<t3_task_graph>${JSON.stringify({ summary: "plan", nextAction: "execute", nodes: plan })}</t3_task_graph>`
            : respondForMeetingPrompt(prompt),
      });
      yield* Effect.gen(function* () {
        const reactor = yield* WorkspaceCollaborationReactor;
        yield* reactor.start();
        yield* reactor.drain;
        const result = yield* Ref.get(harness.runRef);
        const research = result.graph?.nodes.find((entry) => entry.id === "research");
        const build = result.graph?.nodes.find((entry) => entry.id === "build");
        expect(research?.status).toBe("failed");
        expect(research?.error).toContain("missing-researcher");
        expect(research?.attempts).toHaveLength(1);
        expect(build?.attempts).toHaveLength(1);
        expect(build?.status).toBe("completed");
        expect(result.status).toBe("failed");
        expect(result.error).toContain("missing-researcher");
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
);

it.effect("continues an independent queued node while a plain-text safety refusal is parked", () =>
  Effect.gen(function* () {
    const base = orchestraRun();
    const refusal = "Your message was flagged by Claude's safeguards.";
    const harness = yield* makeHarness({
      run: { ...base, orchestra: { ...base.orchestra!, maxParallel: 1 } },
      respond: (prompt) =>
        prompt.includes("Node: research-p1\n") ? refusal : respondForOrchestraPrompt(prompt),
    });
    yield* Effect.gen(function* () {
      const reactor = yield* WorkspaceCollaborationReactor;
      yield* reactor.start();
      yield* reactor.drain;
      const run = yield* Ref.get(harness.runRef);
      const rejected = run.graph?.nodes.find((node) => node.id === "research-p1");
      const independent = run.graph?.nodes.find((node) => node.id === "research-p2");
      expect(rejected?.status).toBe("awaiting-user");
      expect(rejected?.attempts).toHaveLength(1);
      expect(rejected?.error).toContain(refusal);
      expect(independent?.attempts).toHaveLength(1);
      expect(independent?.status).not.toBe("queued");
      expect(run.meeting?.pendingQuestion?.nodeId).toBe("research-p1");
    }).pipe(Effect.provide(harness.layer), Effect.scoped);
  }),
);

it.effect(
  "reviews a refusal instruction while another worker is still running without losing its result",
  () =>
    Effect.gen(function* () {
      const slowStarted = yield* Deferred.make<void>();
      const releaseSlow = yield* Deferred.make<void>();
      const refused = yield* Deferred.make<void>();
      const reviewStarted = yield* Deferred.make<void>();
      const releaseReview = yield* Deferred.make<void>();
      const workerSettled = yield* Deferred.make<void>();
      const harness = yield* makeHarness({
        run: orchestraRun(),
        respond: (prompt) =>
          prompt.includes("Node: research-p1\n")
            ? "Your message was flagged by Claude's safeguards."
            : respondForOrchestraPrompt(prompt),
        onTurnStart: ({ prompt }) =>
          Effect.gen(function* () {
            if (prompt.includes("Node: research-p2\n")) {
              yield* Deferred.succeed(slowStarted, undefined);
              yield* Deferred.await(releaseSlow);
            }
            if (prompt.includes("Node: research-p1\n")) yield* Deferred.await(slowStarted);
            if (prompt.startsWith("사용자가 통합 작업에 추가 지시를 보냈습니다")) {
              yield* Deferred.succeed(reviewStarted, undefined);
              yield* Deferred.await(releaseReview);
            }
          }),
        onRunUpdated: (run) =>
          Effect.gen(function* () {
            if (run.meeting?.pendingQuestion?.nodeId === "research-p1")
              yield* Deferred.succeed(refused, undefined);
            if (
              run.graph?.nodes.some(
                (node) => node.id === "research-p2" && node.status === "awaiting-validation",
              )
            )
              yield* Deferred.succeed(workerSettled, undefined);
          }),
      });
      yield* Effect.gen(function* () {
        const reactor = yield* WorkspaceCollaborationReactor;
        yield* reactor.start();
        yield* Deferred.await(refused);
        const parked = yield* Ref.get(harness.runRef);
        expect(parked.graph?.nodes.find((node) => node.id === "research-p2")?.status).toBe(
          "running",
        );
        const question = parked.meeting!.pendingQuestion!.question;
        const nodeId = parked.meeting!.pendingQuestion!.nodeId!;
        const answer = "남은 작업을 감독해";
        yield* Ref.update(harness.runRef, (run) => ({
          ...run,
          meeting: {
            ...run.meeting!,
            pendingQuestion: null,
            answers: [...run.meeting!.answers, { question, answer, answeredAt: at, nodeId }],
          },
        }));
        yield* PubSub.publish(harness.pubsub, answeredEvent(question, answer));
        yield* Deferred.await(reviewStarted);
        expect(
          (yield* Ref.get(harness.runRef)).graph?.nodes.find((node) => node.id === "research-p2")
            ?.status,
        ).toBe("running");
        yield* Deferred.succeed(releaseSlow, undefined);
        yield* Deferred.await(workerSettled);
        yield* Deferred.succeed(releaseReview, undefined);
        yield* reactor.drain;
        const result = yield* Ref.get(harness.runRef);
        expect(result.meeting?.refusalInstructionReview?.status).toBe("completed");
        expect(result.meeting?.pendingQuestion?.nodeId).toBe("research-p1");
        const worker = result.graph?.nodes.find((node) => node.id === "research-p2");
        expect(worker?.attempts).toHaveLength(1);
        expect(worker?.attempts[0]?.status).toBe("completed");
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
);

for (const safetyRefusal of [true, false]) {
  it.effect(
    `stops a running worker when the user ends a failed step (safety=${safetyRefusal})`,
    () =>
      Effect.gen(function* () {
        const slowStarted = yield* Deferred.make<void>();
        const interrupted = yield* Deferred.make<void>();
        const refused = yield* Deferred.make<void>();
        const harness = yield* makeHarness({
          run: orchestraRun(),
          respond: (prompt) =>
            safetyRefusal && prompt.includes("Node: research-p1\n")
              ? "Your message was flagged by Claude's safeguards."
              : respondForOrchestraPrompt(prompt),
          executionFailure: (execution) =>
            !safetyRefusal && execution.prompt.includes("Node: research-p1\n")
              ? new WorkspaceAgentExecutionError({ message: "일반 작업 실패" })
              : undefined,
          onTurnStart: ({ prompt }) =>
            prompt.includes("Node: research-p2\n")
              ? Deferred.succeed(slowStarted, undefined).pipe(
                  Effect.andThen(Effect.never),
                  Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
                )
              : prompt.includes("Node: research-p1\n")
                ? Deferred.await(slowStarted)
                : Effect.void,
          onRunUpdated: (run) =>
            run.meeting?.pendingQuestion?.nodeId === "research-p1"
              ? Deferred.succeed(refused, undefined).pipe(Effect.asVoid)
              : Effect.void,
        });
        yield* Effect.gen(function* () {
          const reactor = yield* WorkspaceCollaborationReactor;
          yield* reactor.start();
          yield* Deferred.await(refused);
          yield* Deferred.await(slowStarted);
          const parked = yield* Ref.get(harness.runRef);
          const question = parked.meeting!.pendingQuestion!.question;
          const nodeId = parked.meeting!.pendingQuestion!.nodeId!;
          const answer = "여기서 종료";
          yield* Ref.update(harness.runRef, (run) => ({
            ...run,
            meeting: {
              ...run.meeting!,
              pendingQuestion: null,
              answers: [...run.meeting!.answers, { question, answer, answeredAt: at, nodeId }],
            },
          }));
          yield* PubSub.publish(harness.pubsub, answeredEvent(question, answer));
          yield* Deferred.await(interrupted);
          const cancelled = yield* awaitRunStatus(harness.runRef, "cancelled");
          expect(cancelled.meeting?.answers.at(-1)?.answer).toBe(answer);
          expect(cancelled.graph?.nodes.find((node) => node.id === "research-p2")?.status).toBe(
            "cancelled",
          );
          yield* reactor.drain;
        }).pipe(Effect.provide(harness.layer), Effect.scoped);
      }),
  );
}

it.effect(
  "continues an explicit persistent run in the same conversation until the supervisor completes it",
  () =>
    Effect.gen(function* () {
      const initial = orchestraRun({ maxRounds: 0, phase: "planning", answers: [] });
      let assessments = 0;
      const liveInterjections: WorkspaceMeeting["interjections"][number][] = [];
      const harness = yield* makeHarness({
        run: { ...initial, orchestra: { ...initial.orchestra!, executionMode: "persistent" } },
        memoryDirective: "<t3_user_directives>required</t3_user_directives>",
        liveInterjections,
        onTurnStart: ({ prompt }) =>
          Effect.sync(() => {
            if (prompt.includes("조사한다.") && liveInterjections.length === 0)
              liveInterjections.push({
                text: "추가로 재시작도 검증해라",
                roundIndex: 0,
                afterStatements: 0,
                saidAt: at,
              });
          }),
        respond: (prompt) => {
          if (prompt.startsWith("사용자가 요청한 통합 작업의 감독자입니다")) {
            assessments += 1;
            return assessments === 1
              ? '<t3_persistent_verdict>{"decision":"continue","summary":"첫 조사 완료","nextTask":"남은 검증을 진행"}</t3_persistent_verdict>'
              : '<t3_persistent_verdict>{"decision":"complete","summary":"두 회차를 검증해 목표 완료"}</t3_persistent_verdict>';
          }
          return respondForOrchestraPrompt(prompt);
        },
      });
      yield* Effect.gen(function* () {
        const reactor = yield* WorkspaceCollaborationReactor;
        yield* reactor.start();
        const result = yield* awaitRunStatus(harness.runRef, "completed");
        yield* reactor.drain;
        expect(assessments).toBe(2);
        expect(result.meeting?.continuation?.cycle).toBe(1);
        expect(result.finalOutput).toBe("두 회차를 검증해 목표 완료");
        const executions = yield* Ref.get(harness.executionsRef);
        const plans = executions.filter((entry) =>
          entry.prompt.startsWith("# Workspace Meeting Plan"),
        );
        expect(plans).toHaveLength(2);
        expect(plans[1]!.prompt).toContain("남은 검증을 진행");
        expect(
          executions.some(
            (entry) =>
              entry.prompt.startsWith("사용자가 요청한 통합 작업의 감독자입니다") &&
              entry.prompt.includes("추가로 재시작도 검증해라"),
          ),
        ).toBe(true);
        expect(new Set(executions.map((entry) => entry.execution.ownerThreadId)).size).toBe(1);
        const taskIds = executions
          .filter((entry) => entry.orchestraPhase === "task")
          .map((entry) => entry.execution.executionId);
        expect(new Set(taskIds).size).toBe(taskIds.length);
        expect(taskIds.some((id) => id.includes("cycle-1-"))).toBe(true);
        const memoryCalls = yield* Ref.get(harness.memoryCallsRef);
        expect(memoryCalls).toHaveLength(2);
        expect(memoryCalls[0]).toMatchObject({
          input: { action: "remember", scope: "project" },
          context: { threadId: result.meeting?.threadId, agentReported: true },
        });
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
);

it.effect("reports an unconfirmed RAG save in the conversation without stopping the work", () =>
  Effect.gen(function* () {
    const initial = orchestraRun({ maxRounds: 0, phase: "planning", answers: [] });
    const harness = yield* makeHarness({
      run: { ...initial, orchestra: { ...initial.orchestra!, executionMode: "persistent" } },
      memoryDirective: "",
      memorySaveReceipt: '{"id":"unsaved","saved":false}',
      respond: (prompt) =>
        prompt.startsWith("사용자가 요청한 통합 작업의 감독자입니다")
          ? '<t3_persistent_verdict>{"decision":"complete","summary":"작업 완료"}</t3_persistent_verdict>'
          : respondForOrchestraPrompt(prompt),
    });
    yield* Effect.gen(function* () {
      const reactor = yield* WorkspaceCollaborationReactor;
      yield* reactor.start();
      yield* reactor.drain;
      const completed = yield* Ref.get(harness.runRef);
      expect(completed.status).toBe("completed");
      expect(
        (yield* Ref.get(harness.commandsRef)).some(
          (command) =>
            command.type === "thread.activity.append" &&
            command.threadId === completed.meeting?.threadId &&
            command.activity.kind === "workspace.memory.save-failed",
        ),
      ).toBe(true);
    }).pipe(Effect.provide(harness.layer), Effect.scoped);
  }),
);

it.effect("resumes a saved persistent cycle after the reactor starts again", () =>
  Effect.gen(function* () {
    const original = orchestraRun({
      maxRounds: 0,
      phase: "planning",
      answers: [],
      continuation: { cycle: 1, workerTurns: 3, summary: "첫 회차 결과", nextTask: "남은 작업" },
    });
    const saved = yield* decodeRunJson(
      yield* encodeRunJson({
        ...original,
        status: "running",
        orchestra: { ...original.orchestra!, executionMode: "persistent" },
      }),
    );
    const harness = yield* makeHarness({
      run: saved,
      respond: (prompt) =>
        prompt.startsWith("사용자가 요청한 통합 작업의 감독자입니다")
          ? '<t3_persistent_verdict>{"decision":"complete","summary":"남은 작업 완료"}</t3_persistent_verdict>'
          : respondForOrchestraPrompt(prompt),
    });
    yield* Effect.gen(function* () {
      const reactor = yield* WorkspaceCollaborationReactor;
      yield* reactor.start();
      const result = yield* awaitRunStatus(harness.runRef, "completed");
      expect(result.finalOutput).toBe("남은 작업 완료");
      expect(
        (yield* Ref.get(harness.promptsRef)).some((prompt) => prompt.includes("남은 작업")),
      ).toBe(true);
    }).pipe(Effect.provide(harness.layer), Effect.scoped);
  }),
);

it.effect("does not start another persistent cycle when the user cancels during assessment", () =>
  Effect.gen(function* () {
    const initial = orchestraRun({ maxRounds: 0, phase: "planning", answers: [] });
    let cancelAssessment: Effect.Effect<void> = Effect.void;
    const harness = yield* makeHarness({
      run: { ...initial, orchestra: { ...initial.orchestra!, executionMode: "persistent" } },
      onTurnStart: ({ prompt }) =>
        prompt.startsWith("사용자가 요청한 통합 작업의 감독자입니다")
          ? cancelAssessment
          : Effect.void,
      respond: (prompt) =>
        prompt.startsWith("사용자가 요청한 통합 작업의 감독자입니다")
          ? '<t3_persistent_verdict>{"decision":"continue","summary":"첫 회차","nextTask":"다음"}</t3_persistent_verdict>'
          : respondForOrchestraPrompt(prompt),
    });
    cancelAssessment = Ref.update(harness.runRef, (run) => ({
      ...run,
      status: "cancel-requested" as const,
    }));
    yield* Effect.gen(function* () {
      const reactor = yield* WorkspaceCollaborationReactor;
      yield* reactor.start();
      const cancelled = yield* awaitRunStatus(harness.runRef, "cancelled");
      expect(cancelled.graph).not.toBeNull();
      expect(cancelled.meeting?.continuation).toBeUndefined();
      expect(
        (yield* Ref.get(harness.executionsRef)).filter((entry) =>
          entry.prompt.startsWith("# Workspace Meeting Plan"),
        ),
      ).toHaveLength(1);
    }).pipe(Effect.provide(harness.layer), Effect.scoped);
  }),
);

it.effect("does not repeat supervisor review for an instruction included in the plan", () =>
  Effect.gen(function* () {
    const liveInterjections: WorkspaceMeeting["interjections"][number][] = [
      { text: "계획에 반영할 조건", roundIndex: 0, afterStatements: 0, saidAt: at },
    ];
    const harness = yield* makeHarness({
      run: orchestraRun({ maxRounds: 0, phase: "planning", answers: [] }),
      liveInterjections,
      respond: respondForOrchestraPrompt,
    });
    yield* Effect.gen(function* () {
      const reactor = yield* WorkspaceCollaborationReactor;
      yield* reactor.start();
      const completed = yield* awaitRunStatus(harness.runRef, "completed");
      expect(completed.meeting?.supervisorReviewedInterjections).toBe(1);
      const prompts = yield* Ref.get(harness.promptsRef);
      expect(
        prompts.some(
          (prompt) =>
            prompt.startsWith("# Workspace Meeting Plan") && prompt.includes("계획에 반영할 조건"),
        ),
      ).toBe(true);
      expect(
        prompts.some((prompt) => prompt.startsWith("사용자가 요청한 통합 작업의 감독자입니다")),
      ).toBe(false);
    }).pipe(Effect.provide(harness.layer), Effect.scoped);
  }),
);

it.effect("supervisor reviews an instruction received before the final wave of a one-off run", () =>
  Effect.gen(function* () {
    const liveInterjections: WorkspaceMeeting["interjections"][number][] = [];
    const harness = yield* makeHarness({
      run: orchestraRun({ maxRounds: 0, phase: "planning", answers: [] }),
      liveInterjections,
      onTurnStart: ({ prompt }) =>
        Effect.sync(() => {
          if (prompt.includes("Node: research-p1") && !liveInterjections.length)
            liveInterjections.push({
              text: "초기 작업 중 추가한 요구사항을 감독자가 확인해라",
              roundIndex: 0,
              afterStatements: 0,
              saidAt: at,
            });
        }),
      respond: (prompt) =>
        prompt.startsWith("사용자가 요청한 통합 작업의 감독자입니다")
          ? '<t3_persistent_verdict>{"decision":"complete","summary":"추가 지시 확인 완료"}</t3_persistent_verdict>'
          : respondForOrchestraPrompt(prompt),
    });
    yield* Effect.gen(function* () {
      const reactor = yield* WorkspaceCollaborationReactor;
      yield* reactor.start();
      const completed = yield* awaitRunStatus(harness.runRef, "completed");
      expect(completed.finalOutput).toBe("추가 지시 확인 완료");
      expect(
        (yield* Ref.get(harness.promptsRef)).some(
          (prompt) =>
            prompt.startsWith("사용자가 요청한 통합 작업의 감독자입니다") &&
            prompt.includes("초기 작업 중 추가한 요구사항을 감독자가 확인해라"),
        ),
      ).toBe(true);
    }).pipe(Effect.provide(harness.layer), Effect.scoped);
  }),
);

it.effect("delivers a late instruction to the supervisor before a one-off run finishes", () =>
  Effect.gen(function* () {
    const liveInterjections: WorkspaceMeeting["interjections"][number][] = [];
    const harness = yield* makeHarness({
      run: orchestraRun({ maxRounds: 0, phase: "planning", answers: [] }),
      liveInterjections,
      onTurnStart: ({ prompt }) =>
        Effect.sync(() => {
          if (
            prompt.includes("Return one strict payload between <t3_synthesis>") &&
            !liveInterjections.length
          )
            liveInterjections.push({
              text: "완료 전에 추가 조건을 반영해라",
              roundIndex: 0,
              afterStatements: 0,
              saidAt: at,
            });
        }),
      respond: (prompt) =>
        prompt.startsWith("사용자가 요청한 통합 작업의 감독자입니다")
          ? '<t3_persistent_verdict>{"decision":"complete","summary":"추가 조건 반영 완료"}</t3_persistent_verdict>'
          : respondForOrchestraPrompt(prompt),
    });
    yield* Effect.gen(function* () {
      const reactor = yield* WorkspaceCollaborationReactor;
      yield* reactor.start();
      const completed = yield* awaitRunStatus(harness.runRef, "completed");
      expect(completed.finalOutput).toBe("추가 조건 반영 완료");
      expect(
        (yield* Ref.get(harness.promptsRef)).some(
          (prompt) =>
            prompt.startsWith("사용자가 요청한 통합 작업의 감독자입니다") &&
            prompt.includes("완료 전에 추가 조건을 반영해라"),
        ),
      ).toBe(true);
    }).pipe(Effect.provide(harness.layer), Effect.scoped);
  }),
);

it.effect("recovery does not cancel a scheduled run in another conversation", () =>
  Effect.gen(function* () {
    const first = orchestraRun({
      threadId: ThreadId.make("user-chat"),
      maxRounds: 0,
      phase: "planning",
    });
    const second = {
      ...orchestraRun({
        threadId: ThreadId.make("scheduled-chat"),
        maxRounds: 0,
        phase: "planning",
      }),
      id: WorkspaceCollaborationRunId.make("scheduled-chat-run"),
      source: "automation" as const,
    };
    const harness = yield* makeHarness({
      run: first,
      additionalRun: second,
      respond: respondForOrchestraPrompt,
    });
    yield* Effect.gen(function* () {
      const reactor = yield* WorkspaceCollaborationReactor;
      yield* reactor.start();
      yield* reactor.drain;
      expect(
        (yield* Ref.get(harness.commandsRef)).filter(
          (command) =>
            command.type === "project.collaboration.run.cancel" && command.runId === second.id,
        ),
      ).toEqual([]);
      expect((yield* Ref.get(harness.runRef)).status).toBe("completed");
      expect((yield* Ref.get(harness.additionalRunRef))?.status).toBe("completed");
    }).pipe(Effect.provide(harness.layer), Effect.scoped);
  }),
);

it.effect("legacy project work does not preempt a scheduled conversation", () =>
  Effect.gen(function* () {
    const first = {
      ...orchestraRun({
        threadId: ThreadId.make("legacy-owner"),
        maxRounds: 0,
        phase: "planning",
      }),
      meeting: null,
    };
    const second = {
      ...orchestraRun({
        threadId: ThreadId.make("independent-chat"),
        maxRounds: 0,
        phase: "planning",
      }),
      id: WorkspaceCollaborationRunId.make("independent-scheduled-run"),
      source: "automation" as const,
    };
    const harness = yield* makeHarness({
      run: first,
      additionalRun: second,
      respond: respondForOrchestraPrompt,
    });
    yield* Effect.gen(function* () {
      const reactor = yield* WorkspaceCollaborationReactor;
      yield* reactor.start();
      yield* reactor.drain;
      expect(
        (yield* Ref.get(harness.commandsRef)).filter(
          (command) =>
            command.type === "project.collaboration.run.cancel" && command.runId === second.id,
        ),
      ).toEqual([]);
      expect((yield* Ref.get(harness.additionalRunRef))?.status).toBe("completed");
    }).pipe(Effect.provide(harness.layer), Effect.scoped);
  }),
);

it.effect("a conversation run does not preempt unrelated legacy scheduled work", () =>
  Effect.gen(function* () {
    const first = orchestraRun({
      threadId: ThreadId.make("user-conversation"),
      maxRounds: 0,
      phase: "planning",
    });
    const second = {
      ...orchestraRun({
        threadId: ThreadId.make("legacy-owner"),
        maxRounds: 0,
        phase: "planning",
      }),
      id: WorkspaceCollaborationRunId.make("legacy-scheduled-run"),
      source: "automation" as const,
      meeting: null,
    };
    const harness = yield* makeHarness({
      run: first,
      additionalRun: second,
      respond: respondForOrchestraPrompt,
    });
    yield* Effect.gen(function* () {
      const reactor = yield* WorkspaceCollaborationReactor;
      yield* reactor.start();
      yield* reactor.drain;
      expect(
        (yield* Ref.get(harness.commandsRef)).filter(
          (command) =>
            command.type === "project.collaboration.run.cancel" && command.runId === second.id,
        ),
      ).toEqual([]);
      expect((yield* Ref.get(harness.runRef)).status).toBe("completed");
    }).pipe(Effect.provide(harness.layer), Effect.scoped);
  }),
);

it.effect("starts separate conversations in the same project independently", () =>
  Effect.gen(function* () {
    const first = orchestraRun({
      threadId: ThreadId.make("conversation-a"),
      maxRounds: 0,
      phase: "planning",
      answers: [],
    });
    const second = {
      ...orchestraRun({
        threadId: ThreadId.make("conversation-b"),
        maxRounds: 0,
        phase: "planning",
        answers: [],
      }),
      id: WorkspaceCollaborationRunId.make("run-other"),
    };
    const bothStarted = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const started = new Set<string>();
    const harness = yield* makeHarness({
      run: first,
      additionalRun: second,
      onTurnStart: ({ prompt, run }) =>
        prompt.startsWith("# Workspace Meeting Plan")
          ? Effect.gen(function* () {
              started.add(run.id);
              if (started.size === 2) yield* Deferred.succeed(bothStarted, undefined);
              yield* Deferred.await(release);
            })
          : Effect.void,
      respond: respondForOrchestraPrompt,
    });
    yield* Effect.gen(function* () {
      const reactor = yield* WorkspaceCollaborationReactor;
      yield* reactor.start();
      yield* Deferred.await(bothStarted);
      expect(started).toEqual(new Set([first.id, second.id]));
      yield* Deferred.succeed(release, undefined);
      yield* reactor.drain;
      expect((yield* Ref.get(harness.runRef)).status).toBe("completed");
      expect((yield* Ref.get(harness.additionalRunRef))?.status).toBe("completed");
    }).pipe(Effect.provide(harness.layer), Effect.scoped);
  }),
);

it.effect(
  "stopping one conversation does not stop a different conversation in the same project",
  () =>
    Effect.gen(function* () {
      const first = orchestraRun({
        threadId: ThreadId.make("stop-a"),
        maxRounds: 0,
        phase: "planning",
      });
      const second = {
        ...orchestraRun({ threadId: ThreadId.make("stop-b"), maxRounds: 0, phase: "planning" }),
        id: WorkspaceCollaborationRunId.make("stop-other"),
      };
      const bothStarted = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const started = new Set<string>();
      const harness = yield* makeHarness({
        run: first,
        additionalRun: second,
        onTurnStart: ({ prompt, run }) =>
          prompt.startsWith("# Workspace Meeting Plan")
            ? Effect.gen(function* () {
                started.add(run.id);
                if (started.size === 2) yield* Deferred.succeed(bothStarted, undefined);
                yield* Deferred.await(release);
              })
            : Effect.void,
        respond: respondForOrchestraPrompt,
      });
      yield* Effect.gen(function* () {
        const reactor = yield* WorkspaceCollaborationReactor;
        yield* reactor.start();
        yield* Deferred.await(bothStarted);
        yield* Ref.update(harness.runRef, (run) => ({
          ...run,
          status: "cancel-requested" as const,
        }));
        yield* Deferred.succeed(release, undefined);
        yield* reactor.drain;
        expect((yield* Ref.get(harness.runRef)).status).toBe("cancelled");
        expect((yield* Ref.get(harness.additionalRunRef))?.status).toBe("completed");
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
);

it.effect("allows the supervisor to plan and execute alone", () =>
  Effect.gen(function* () {
    const supervisor = meetingRun().meeting!.participants[0]!;
    const run = orchestraRun({
      participants: [supervisor],
      chairParticipantId: supervisor.id,
      maxRounds: 0,
      phase: "planning",
      answers: [],
    });
    const decoded = yield* decodeRunJson(yield* encodeRunJson(run));
    expect(decoded.meeting?.participants).toHaveLength(1);
    const setup = yield* decodeMeetingSetup({
      mode: "fixed-rounds",
      participants: [supervisor],
      chairParticipantId: supervisor.id,
      maxRounds: 0,
      userInLoop: false,
    });
    expect(setup.participants).toHaveLength(1);
    const harness = yield* makeHarness({
      run,
      respond: (prompt) => {
        const response = respondForOrchestraPrompt(prompt);
        if (!prompt.startsWith("# Workspace Meeting Plan")) return response;
        const graph = JSON.parse(
          response.slice("<t3_task_graph>".length, -"</t3_task_graph>".length),
        ) as { nodes: Array<{ participantId: string }> };
        graph.nodes = graph.nodes.filter((node) => node.participantId === "p1");
        return `<t3_task_graph>${JSON.stringify(graph)}</t3_task_graph>`;
      },
    });
    yield* Effect.gen(function* () {
      const reactor = yield* WorkspaceCollaborationReactor;
      yield* reactor.start();
      const completed = yield* awaitRunStatus(harness.runRef, "completed");
      expect(completed.status).toBe("completed");
      expect(completed.graph?.nodes.some((node) => node.participantId === supervisor.id)).toBe(
        true,
      );
    }).pipe(Effect.provide(harness.layer), Effect.scoped);
  }),
);

import {
  reviewWorkspaceOrchestraPlan,
  reviewWorkspaceOrchestraRun,
} from "../workspaceOrchestraReview.ts";
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

for (const mode of ["partial", "all", "answer-before-review", "skip-after-review"] as const) {
  it.effect(`preserves reviewed work after a supervisor assignment refusal (${mode})`, () =>
    Effect.gen(function* () {
      const allManuallyAssigned = mode === "all";
      const base = workflowDefaults()[0]!;
      const definition = {
        ...base,
        nodes: [
          { ...base.nodes[0]!, participantId: "p2" },
          base.nodes[1]!,
          {
            ...base.nodes[1]!,
            id: "dependent",
            participantId: null,
            dependsOn: [base.nodes[1]!.id],
          },
        ],
        revision: 1,
        archived: false,
        digest: "fixture-digest",
        createdAt: at,
      };
      const completed = yield* Deferred.make<void>();
      const independentDone = yield* Deferred.make<void>();
      let assignmentCalls = 0;
      const baseRun = orchestraRun({ maxRounds: 0, chairParticipantId: pid("p1") });
      const harness = yield* makeHarness({
        run: {
          ...baseRun,
          orchestra: { ...baseRun.orchestra!, reviewPlan: true },
          workflow: {
            definitionId: definition.id,
            definitionRevision: 1,
            definitionDigest: definition.digest,
            definition,
            title: definition.title,
            values: { goal: "workflow target" },
            nodeSkills: definition.nodes.map((node) => ({ nodeId: node.id, skills: [] })),
            roleBindings: [],
            control: "active",
            controlRevision: 0,
            updatedAt: at,
            requestDigest: "fixture",
          },
        },
        respond: (prompt) => {
          if (!prompt.startsWith("# Saved Workflow Assignment"))
            return respondForMeetingPrompt(prompt);
          assignmentCalls++;
          if (assignmentCalls === 1) return "Your message was flagged by Claude's safeguards.";
          return `<t3_workflow_assignments>${JSON.stringify({ assignments: [{ nodeId: "execute", participantId: "p2" }] })}</t3_workflow_assignments>`;
        },
        onRunUpdated: (run) =>
          Effect.gen(function* () {
            if (run.status === "completed") yield* Deferred.succeed(completed, undefined);
            if (run.graph?.nodes.find((node) => node.id === "analyze")?.status === "completed")
              yield* Deferred.succeed(independentDone, undefined);
          }),
      });
      yield* Effect.gen(function* () {
        const reactor = yield* WorkspaceCollaborationReactor;
        yield* reactor.start();
        yield* reactor.drain;
        let parked = yield* Ref.get(harness.runRef);
        expect(parked.status).toBe("running");
        expect(parked.graph?.planReview?.status).toBe("pending");
        expect(parked.graph?.workflowAssignment?.pendingNodeIds).toEqual(["execute", "dependent"]);
        expect(
          (yield* Ref.get(harness.executionsRef)).filter(
            (entry) => entry.execution.nodeId === "analyze",
          ),
        ).toHaveLength(0);
        if (mode === "answer-before-review") {
          const question = parked.meeting!.pendingQuestion!;
          yield* Ref.update(harness.runRef, (run) => ({
            ...run,
            meeting: {
              ...run.meeting!,
              pendingQuestion: null,
              answers: [
                ...run.meeting!.answers,
                {
                  question: question.question,
                  answer: "다시 시도",
                  answeredAt: at,
                  nodeId: question.nodeId,
                },
              ],
            },
          }));
          yield* PubSub.publish(harness.pubsub, answeredEvent(question.question, "다시 시도"));
          yield* reactor.drain;
          parked = yield* Ref.get(harness.runRef);
          expect(parked.graph?.planReview?.status).toBe("pending");
          expect(
            (yield* Ref.get(harness.executionsRef)).filter(
              (entry) => entry.execution.nodeId === "analyze",
            ),
          ).toHaveLength(0);
        }
        const request = {
          projectId,
          runId,
          expectedRevision: 0,
          approve: true,
          reviewedAt: at,
          edits: [
            {
              nodeId: WorkspaceTaskNodeId.make("analyze"),
              title: "사용자 분석",
              task: "수정된 분석 지시",
              participantId: pid("p2"),
              dependsOn: [],
            },
            {
              nodeId: WorkspaceTaskNodeId.make("execute"),
              title: "사용자 실행",
              task: "수정된 실행 지시",
              participantId: allManuallyAssigned ? pid("p2") : null,
              dependsOn: [WorkspaceTaskNodeId.make("analyze")],
            },
            {
              nodeId: WorkspaceTaskNodeId.make("dependent"),
              title: "사용자 후속",
              task: "수정된 후속 지시",
              participantId: pid("p1"),
              dependsOn: [WorkspaceTaskNodeId.make("execute")],
            },
          ],
        };
        const reviewed = reviewWorkspaceOrchestraRun(parked, request)!;
        expect(() =>
          reviewWorkspaceOrchestraRun(parked, {
            ...request,
            edits: [{ ...request.edits[0]!, participantId: null }],
          }),
        ).toThrow("선택한 참가자");
        if (allManuallyAssigned) {
          const otherQuestion = {
            ...parked.meeting!.pendingQuestion!,
            nodeId: WorkspaceTaskNodeId.make("dependent"),
          };
          const other = reviewWorkspaceOrchestraRun(
            { ...parked, meeting: { ...parked.meeting!, pendingQuestion: otherQuestion } },
            request,
          )!;
          expect(other.meeting?.pendingQuestion).toEqual(otherQuestion);
        }
        expect(reviewed.graph?.planReview?.status).toBe("approved");
        expect(reviewed.graph?.workflowAssignment?.pendingNodeIds).toEqual(
          allManuallyAssigned ? undefined : ["execute"],
        );
        expect(reviewed.meeting?.pendingQuestion === null).toBe(
          allManuallyAssigned || mode === "answer-before-review",
        );
        yield* Ref.set(harness.runRef, reviewed);
        yield* PubSub.publish(harness.pubsub, {
          type: "project.collaboration-run-reviewed",
          payload: request,
        } as unknown as OrchestrationEvent);
        if (!allManuallyAssigned && mode !== "answer-before-review") {
          yield* Deferred.await(independentDone);
          const progress = yield* Ref.get(harness.runRef);
          expect(progress.graph?.nodes.find((node) => node.id === "execute")?.status).toBe(
            "blocked",
          );
          const question = progress.meeting!.pendingQuestion!;
          const answer = mode === "skip-after-review" ? "이 단계 건너뛰고 계속" : "다시 시도";
          yield* Ref.update(harness.runRef, (run) => ({
            ...run,
            meeting: {
              ...run.meeting!,
              pendingQuestion: null,
              answers: [
                ...run.meeting!.answers,
                {
                  question: question.question,
                  answer,
                  answeredAt: at,
                  nodeId: question.nodeId,
                },
              ],
            },
          }));
          yield* PubSub.publish(harness.pubsub, answeredEvent(question.question, answer));
        }
        yield* Deferred.await(completed);
        yield* reactor.drain;
        const result = yield* Ref.get(harness.runRef);
        expect(result.status, result.error ?? undefined).toBe("completed");
        expect(result.graph?.nodes.find((node) => node.id === "dependent")).toMatchObject({
          participantId: "p1",
          handoff: { task: "수정된 후속 지시" },
          status: mode === "skip-after-review" ? "skipped" : "completed",
        });
        expect(result.graph?.nodes.find((node) => node.id === "execute")?.handoff.task).toBe(
          "수정된 실행 지시",
        );
        expect(assignmentCalls).toBe(allManuallyAssigned || mode === "skip-after-review" ? 1 : 2);
        if (mode === "skip-after-review") expect(result.finalOutput).toContain("미수행 단계");
        if (!allManuallyAssigned && mode !== "skip-after-review") {
          const assignment = (yield* Ref.get(harness.executionsRef)).filter((entry) =>
            entry.prompt.startsWith("# Saved Workflow Assignment"),
          )[1]!;
          expect(assignment.prompt).toContain("수정된 실행 지시");
          expect(assignment.prompt).toContain("수정된 후속 지시");
          expect(assignment.prompt).toContain('"participantId":"p1"');
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
}

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

it.effect("supervisor reviews an instruction received during final verification", () =>
  Effect.gen(function* () {
    const initial = orchestraRun({ maxRounds: 0, phase: "planning", answers: [] });
    const liveInterjections: WorkspaceMeeting["interjections"][number][] = [];
    const harness = yield* makeHarness({
      run: {
        ...initial,
        orchestra: {
          ...initial.orchestra!,
          completionCheck: true,
          verificationCommands: ["test-command"],
        },
      },
      liveInterjections,
      respond: (prompt) =>
        prompt.startsWith("사용자가 요청한 통합 작업의 감독자입니다")
          ? '<t3_persistent_verdict>{"decision":"complete","summary":"검증 중 추가 지시 확인"}</t3_persistent_verdict>'
          : respondForOrchestraPrompt(prompt),
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
          liveInterjections.push({
            text: "최종 검증 중 새 지시",
            roundIndex: 0,
            afterStatements: 0,
            saidAt: at,
          });
          return {
            passed: true,
            artifacts: [],
            commands: commands.map((command) => ({
              ...command,
              exitCode: 0,
              timedOut: false,
              logPath: "receipt.log",
            })),
          };
        }),
    });
    yield* Effect.gen(function* () {
      const reactor = yield* WorkspaceCollaborationReactor;
      yield* reactor.start();
      const completed = yield* awaitRunStatus(harness.runRef, "completed");
      expect(completed.finalOutput).toBe("검증 중 추가 지시 확인");
      expect(
        (yield* Ref.get(harness.promptsRef)).some(
          (prompt) =>
            prompt.startsWith("사용자가 요청한 통합 작업의 감독자입니다") &&
            prompt.includes("최종 검증 중 새 지시"),
        ),
      ).toBe(true);
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
            failure: { message: "종료되거나 취소 중인 실행에는 작업자 입력을 준비할 수 없습니다." },
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
