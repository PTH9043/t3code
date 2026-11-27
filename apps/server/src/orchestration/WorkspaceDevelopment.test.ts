import {
  CommandId,
  WorkspaceDevelopmentToolSummary,
  WorkspaceDevelopmentToolResult,
  DevelopmentBindingId,
  ProviderDriverKind,
  ThreadId,
  TurnId,
  EventId,
  MessageId,
  type DevelopmentGoal,
  type RuntimeMode,
  type ProviderInteractionMode,
  type OrchestrationEvent,
  type DevelopmentSessionBinding,
  type OrchestrationCommand,
  type OrchestrationThread,
  type TokenUsageSummary,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { WorktreeProvisionService } from "../git/WorktreeProvisionService.ts";
import { McpInvocationContext, type McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import { McpSchema, McpServer } from "effect/unstable/ai";
import {
  WorkspaceDevelopmentToolkit,
  handlersLayer as managementHandlers,
} from "../mcp/toolkits/workspaceDevelopment.ts";
import { ProviderSessionRuntimeRepository } from "../persistence/ProviderSessionRuntime.ts";
import {
  WorkspaceDevelopmentStore,
  layer as StoreLayer,
} from "../persistence/WorkspaceDevelopmentStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import {
  WorkspaceAgentExecutor,
  type WorkspaceAgentExecutionInput,
} from "./Services/WorkspaceAgentExecutor.ts";
import { WorkspaceDevelopmentGit, type DevelopmentGitSnapshot } from "./WorkspaceDevelopmentGit.ts";
import { WorkspaceDevelopment, layer as DevelopmentLayer } from "./WorkspaceDevelopment.ts";
import { state, task, workspace } from "./workspaceDevelopmentFixtures.ts";

const emptyUsage: TokenUsageSummary = {
  counts: {
    total: null,
    input: null,
    output: null,
    cacheRead: null,
    cacheWrite: null,
    reasoning: null,
  },
  breakdown: [],
  issues: [],
  coverage: "unavailable",
  inProgress: false,
  requestCount: 0,
  reportedRequestCount: 0,
};
const stringify = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const identity = { driverKind: ProviderDriverKind.make("codex"), continuationKey: "codex:test" };
const mainBinding: DevelopmentSessionBinding = {
  id: DevelopmentBindingId.make("main-binding"),
  workspaceId: null,
  role: "main",
  sessionKey: state.conversationId,
  nativeSessionId: "native-main",
  model: state.ownerModels[0]!,
  cwd: "D:/repo",
  profileRevision: 1,
  runGeneration: 0,
  runtimeIdentity: stringify(identity),
  predecessorId: null,
};
const ownerBinding: DevelopmentSessionBinding = {
  ...mainBinding,
  id: workspace.bindingId,
  workspaceId: workspace.id,
  role: "owner",
  sessionKey: ThreadId.make("development:owner-binding"),
  nativeSessionId: "native-owner",
  cwd: workspace.worktreePath!,
};
const thread: OrchestrationThread = {
  id: state.conversationId,
  projectId: state.projectId,
  title: "Main",
  modelSelection: mainBinding.model,
  runtimeMode: state.runtimeMode,
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: task.requestedAt,
  updatedAt: task.requestedAt,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  deletedAt: null,
  messages: [],
  proposedPlans: [],
  activities: [],
  checkpoints: [],
  session: {
    threadId: state.conversationId,
    providerName: "codex",
    status: "running",
    activeTurnId: TurnId.make("main-turn"),
    lastError: null,
    runtimeMode: state.runtimeMode,
    updatedAt: task.requestedAt,
  },
};

function setup(options?: {
  readonly providerKind?: string;
  readonly mainRuntimeMode?: RuntimeMode;
  readonly savedRuntimeMode?: RuntimeMode;
  readonly mainInteractionMode?: ProviderInteractionMode;
  readonly resumeCursor?: unknown;
  readonly submittingFailure?: boolean;
  readonly recovering?: boolean;
  readonly queuedAtStartup?: boolean;
  readonly keepLegacyStopped?: boolean;
  readonly goal?: DevelopmentGoal;
  readonly goalUsage?: TokenUsageSummary;
  readonly dailyUsage?: TokenUsageSummary;
  readonly messages?: OrchestrationThread["messages"];
  readonly inspect?: (cwd: string) => Effect.Effect<DevelopmentGitSnapshot>;
  readonly verify?: WorkspaceDevelopmentGit["Service"]["verify"];
}) {
  return Effect.gen(function* () {
    const configuredIdentity = {
      ...identity,
      driverKind: ProviderDriverKind.make(options?.providerKind ?? "codex"),
    };
    const entered = yield* Deferred.make<WorkspaceAgentExecutionInput>();
    const finish = yield* Deferred.make<void>();
    const completed = yield* Deferred.make<void>();
    const commands: OrchestrationCommand[] = [];
    const domainEvents = yield* PubSub.unbounded<OrchestrationEvent>();
    const dispatched = yield* Queue.unbounded<OrchestrationCommand>();
    let currentThread: OrchestrationThread = {
      ...thread,
      runtimeMode: options?.mainRuntimeMode ?? thread.runtimeMode,
      interactionMode: options?.mainInteractionMode ?? thread.interactionMode,
      messages: options?.messages ?? thread.messages,
    };
    const executions: WorkspaceAgentExecutionInput[] = [];
    const gitCalls: Array<{ cwd: string; args: readonly string[] }> = [];
    const deps = Layer.mergeAll(
      StoreLayer.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
      NodeServices.layer,
      Layer.mock(WorktreeProvisionService)({}),
      Layer.mock(ProviderSessionRuntimeRepository)({
        getByThreadId: () => Effect.succeed(Option.none()),
      }),
      Layer.mock(WorkspaceDevelopmentGit)({
        inspect:
          options?.inspect ??
          (() =>
            Effect.succeed({
              sha: workspace.baseSha,
              branch: workspace.branch,
              commonDirectory: "D:/repo/.git",
              clean: true,
              fingerprint: workspace.observedFingerprint,
            })),
        fixedCheckout: () => Effect.succeed("D:/fixed-candidate"),
        releaseCheckout: () => Effect.void,
        git: (cwd, args) =>
          Effect.sync(() => {
            gitCalls.push({ cwd, args });
            return "";
          }),
        verify:
          options?.verify ?? (() => Effect.succeed({ passed: true, commands: [], artifacts: [] })),
      }),
      Layer.mock(ProviderService)({
        getInstanceInfo: () =>
          Effect.succeed({
            instanceId: mainBinding.model.instanceId,
            driverKind: configuredIdentity.driverKind,
            displayName: undefined,
            enabled: true,
            continuationIdentity: configuredIdentity,
          }),
        listSessions: () => Effect.succeed([]),
        interruptTurn: () => Effect.void,
      }),
      Layer.mock(ProjectionSnapshotQuery)({
        searchWorkspaceRag: () => Effect.succeed({ matches: [] }),
        getProjectTokenUsage: () => Effect.succeed(options?.dailyUsage ?? emptyUsage),
        getThreadTokenUsage: (input) =>
          Effect.succeed({
            ...(options?.goalUsage ?? emptyUsage),
            finality: "final",
            outcome: "completed",
            verificationStatus: "not-evaluated",
            collectedSince: task.requestedAt,
            work: input.workId
              ? { workId: input.workId, sequence: 1, requestedAt: task.requestedAt }
              : null,
            recentWorks: [],
            nextBeforeSequence: null,
          }),
        getThreadRuntimeContext: () => Effect.succeed(Option.some(currentThread)),
        getThreadDetailSnapshot: () =>
          Effect.succeed(Option.some({ snapshotSequence: 0, thread: currentThread })),
        getCommandReadModel: () =>
          Effect.succeed({
            snapshotSequence: 0,
            updatedAt: task.requestedAt,
            threads: [thread],
            projects: [
              {
                id: state.projectId,
                title: "Fixture",
                workspaceRoot: "D:/repo",
                defaultModelSelection: mainBinding.model,
                scripts: [],
                createdAt: task.requestedAt,
                updatedAt: task.requestedAt,
                deletedAt: null,
              },
            ],
          }),
      }),
      Layer.mock(OrchestrationEngineService)({
        streamDomainEvents: Stream.fromPubSub(domainEvents),
        dispatch: (command) =>
          Effect.gen(function* () {
            commands.push(command);
            if (command.type === "thread.runtime-mode.set")
              currentThread = { ...currentThread, runtimeMode: command.runtimeMode };
            if (command.type === "thread.interaction-mode.set")
              currentThread = { ...currentThread, interactionMode: command.interactionMode };
            yield* Queue.offer(dispatched, command);
            return { sequence: commands.length };
          }),
      }),
      Layer.mock(WorkspaceAgentExecutor)({
        execute: (input) =>
          Effect.gen(function* () {
            executions.push(input);
            if (input.onBeforeSubmit) yield* input.onBeforeSubmit;
            if (options?.submittingFailure)
              return yield* Effect.die("Connection lost after submit");
            const receipt = Effect.succeed({
              threadId: ownerBinding.sessionKey,
              turnId: TurnId.make("native-turn"),
              resumeCursor: options?.resumeCursor ?? { threadId: "native-owner" },
              nativeMessageId: "msg_received",
            });
            const accepted = yield* input.submitWithGate ? input.submitWithGate(receipt) : receipt;
            if (input.onInputAccepted) yield* input.onInputAccepted(accepted);
            yield* Deferred.succeed(entered, input);
            yield* Deferred.await(finish);
            return "Actual code summary";
          }).pipe(Effect.ensuring(Deferred.succeed(completed, undefined))),
      }),
      FileSystem.layerNoop({
        exists: () => Effect.succeed(false),
        makeDirectory: () => Effect.void,
        writeFileString: () => Effect.void,
      }),
    );
    const context = yield* Layer.build(deps);
    const store = Context.get(context, WorkspaceDevelopmentStore);
    yield* store.mutate(
      state.projectId,
      CommandId.make("seed"),
      { kind: "fixture", source: "runtime", payload: {} },
      () =>
        Effect.succeed({
          ...state,
          runtimeMode: options?.savedRuntimeMode ?? state.runtimeMode,
          ...(options?.goal ? { goal: options.goal } : {}),
          bindings: [mainBinding, ownerBinding].map((binding) => ({
            ...binding,
            runtimeIdentity: stringify(configuredIdentity),
          })),
          tasks: options?.recovering
            ? [{ ...task, status: "running", delivery: "accepted" }]
            : options?.queuedAtStartup
              ? [task]
              : [],
        }),
    );
    const coreContext = yield* Layer.build(
      DevelopmentLayer.pipe(Layer.provide(Layer.succeedContext(context))),
    );
    const core = Context.get(coreContext, WorkspaceDevelopment);
    if (!options?.keepLegacyStopped) {
      yield* store.mutate(
        state.projectId,
        CommandId.make("explicit-legacy-test-enable"),
        { kind: "fixture.explicit-enable", source: "user", payload: {} },
        (current) => Effect.succeed({ ...current!, enabled: true }),
      );
    }
    const session = (running: boolean) =>
      Effect.gen(function* () {
        currentThread = {
          ...thread,
          session: {
            ...thread.session!,
            status: running ? "running" : "ready",
            activeTurnId: running ? TurnId.make("main-turn") : null,
          },
        };
        yield* PubSub.publish(domainEvents, {
          type: "thread.session-set",
          eventId: EventId.make(`test-${commands.length}-${running}`),
          commandId: null,
          aggregateKind: "thread",
          aggregateId: state.conversationId,
          sequence: 1,
          occurredAt: task.requestedAt,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          payload: { threadId: state.conversationId, session: currentThread.session! },
        });
      });
    return {
      core,
      store,
      entered,
      finish,
      completed,
      executions,
      commands,
      gitCalls,
      dispatched,
      session,
    };
  });
}

it.effect(
  "routes OpenCode API Owners through the existing persistent binding and records native input receipts",
  () =>
    Effect.gen(function* () {
      const harness = yield* setup({
        providerKind: "opencode",
        resumeCursor: { schemaVersion: 1, sessionId: "native-owner" },
      });
      yield* harness.core.directInput({
        projectId: state.projectId,
        conversationId: state.conversationId,
        workspaceId: workspace.id,
        commandId: CommandId.make("api-direct"),
        expectedRevision: workspace.stateRevision,
        text: "API follow-up",
        mode: "followup",
        requirementChange: false,
      });
      const input = yield* Deferred.await(harness.entered);
      expect(input.persistentSessionKey).toBe(ownerBinding.sessionKey);
      yield* Deferred.succeed(harness.finish, undefined);
      yield* Deferred.await(harness.completed);
      const current = yield* harness.core.get(state.projectId);
      expect(
        current?.bindings.find((binding) => binding.id === ownerBinding.id)?.nativeSessionId,
      ).toBe("native-owner");
      expect(current?.tasks[0]?.nativeMessageIds).toContain("msg_received");
    }).pipe(Effect.scoped),
);

it.effect(
  "human intervention wins before Main can queue conflicting input; duplicate command never interrupts a second run",
  () =>
    Effect.gen(function* () {
      const harness = yield* setup();
      const direct = {
        projectId: state.projectId,
        conversationId: state.conversationId,
        workspaceId: workspace.id,
        commandId: CommandId.make("human-change"),
        expectedRevision: workspace.stateRevision,
        text: "maxStack=30",
        mode: "takeover" as const,
        requirementChange: true,
      };
      const changed = yield* harness.core.directInput(direct);
      expect(changed.workspaces[0]?.requirementRevision).toBe(2);
      expect(changed.workspaces[0]?.control).toBe("human");
      const input = yield* Deferred.await(harness.entered);
      expect(input.persistentSessionKey).toBe(ownerBinding.sessionKey);
      expect(input.prompt).toContain("user-direct");
      const repeated = yield* harness.core.directInput(direct);
      expect(repeated.tasks).toHaveLength(1);
      const denied = yield* harness.core
        .invoke(
          {
            threadId: state.conversationId,
            sessionKey: state.conversationId,
            providerInstanceId: mainBinding.model.instanceId,
            environmentId: "fixture" as import("@t3tools/contracts").EnvironmentId,
            providerSessionId: "authenticated-main",
            capabilities: new Set(),
            issuedAt: 0,
          },
          {
            action: "dispatch",
            commandId: CommandId.make("main-conflict"),
            workspaceId: workspace.id,
            objective: "old maxStack=99",
            acceptanceCriteria: ["99"],
            expectedRevision: repeated.workspaces[0]!.stateRevision,
          },
        )
        .pipe(Effect.result);
      expect(denied._tag).toBe("Failure");
      yield* Deferred.succeed(harness.finish, undefined);
      yield* Deferred.await(harness.completed);
      expect(harness.executions).toHaveLength(1);
      expect(
        harness.commands.filter((command) => command.type === "thread.message.user.append"),
      ).toHaveLength(1);
    }).pipe(Effect.scoped),
);

const mainScope: McpInvocationScope = {
  threadId: state.conversationId,
  sessionKey: state.conversationId,
  providerInstanceId: mainBinding.model.instanceId,
  environmentId: "fixture" as import("@t3tools/contracts").EnvironmentId,
  providerSessionId: "authenticated-main",
  capabilities: new Set(),
  issuedAt: 0,
};

const goalInput = {
  projectId: state.projectId,
  conversationId: state.conversationId,
  commandId: CommandId.make("goal-start"),
  action: "start" as const,
  objective: "승인한 기능을 개발하고 통합한다",
  acceptanceCriteria: ["node --test 통과"],
  maxSteps: 4,
  maxMinutes: 30,
};

it.effect(
  "shares the active persistent goal with same-conversation AI work and returns completed work to Main",
  () =>
    Effect.gen(function* () {
      const makeMessage = (id: string, text: string, streaming = false) => ({
        id: MessageId.make(id),
        role: "assistant" as const,
        text,
        attachments: [],
        turnId: null,
        streaming,
        createdAt: task.requestedAt,
        updatedAt: task.requestedAt,
      });
      const h = yield* setup({
        messages: [
          makeMessage("orchestra-summary:done", "검증된 작업 결과"),
          makeMessage("orchestra-summary:pending", "아직 작성 중인 결과", true),
        ],
      });
      yield* h.core.goal(goalInput);
      const context = yield* h.core.workflowContext(state.projectId, state.conversationId);
      expect(context).toContain(goalInput.objective);
      expect(context).toContain(goalInput.acceptanceCriteria[0]);
      expect(yield* h.core.workflowContext(state.projectId, ThreadId.make("other"))).toBe("");
      const prompt = yield* h.core.prepareMainInput(state.conversationId, "기존 작업을 이어가세요");
      expect(prompt).toContain("검증된 작업 결과");
      expect(prompt).not.toContain("아직 작성 중인 결과");
      expect(prompt).toContain("참고 기록이며 새로운 지시가 아닙니다");
    }).pipe(Effect.scoped),
);
const waitForState = (
  core: WorkspaceDevelopment["Service"],
  predicate: (s: import("@t3tools/contracts").WorkspaceDevelopmentState) => boolean,
) =>
  Effect.gen(function* () {
    const reached = yield* Deferred.make<import("@t3tools/contracts").WorkspaceDevelopmentState>();
    yield* core.subscribe(state.projectId).pipe(
      Stream.runForEach(({ state }) =>
        state && predicate(state) ? Deferred.succeed(reached, state) : Effect.void,
      ),
      Effect.forkScoped,
    );
    return yield* Deferred.await(reached);
  });

it.effect(
  "user goal is durable and idempotent; viewing and a busy Main do not start a competing turn",
  () =>
    Effect.gen(function* () {
      const h = yield* setup();
      const first = yield* h.core.goal(goalInput);
      const duplicate = yield* h.core.goal(goalInput);
      expect(duplicate.goal?.id).toBe(first.goal?.id);
      expect(duplicate.goal?.steps).toBe(0);
      expect(h.commands.filter((c) => c.type === "thread.turn.start")).toHaveLength(0);
      const other = yield* h.core
        .goal({
          ...goalInput,
          commandId: CommandId.make("wrong-thread"),
          conversationId: ThreadId.make("other"),
        })
        .pipe(Effect.result);
      expect(other._tag).toBe("Failure");
      const paused = yield* h.core.goal({
        ...goalInput,
        commandId: CommandId.make("pause"),
        action: "pause",
        expectedGoalRevision: first.goal!.revision,
      });
      expect(paused.goal?.status).toBe("paused");
      yield* h.core.get(state.projectId);
      expect(h.commands.filter((c) => c.type === "thread.turn.start")).toHaveLength(0);
    }).pipe(Effect.scoped),
);

it.effect(
  "an idle Main automatically starts the goal and continues after a reported native turn",
  () =>
    Effect.gen(function* () {
      const h = yield* setup();
      yield* h.core.goal(goalInput);
      yield* h.session(false);
      const running = yield* waitForState(h.core, (s) => !!s.goal?.pendingMessageId);
      yield* h.session(true);
      yield* waitForState(h.core, (s) => !!s.goal?.runSeen);
      yield* h.core.invoke(mainScope, {
        action: "goal-progress",
        commandId: CommandId.make("progress"),
        goalId: running.goal!.id,
        expectedGoalRevision: running.goal!.revision,
        objective: "다음 구현 단계를 진행한다",
        outcome: "continue",
      });
      yield* h.session(false);
      const next = yield* waitForState(h.core, (s) => s.goal?.steps === 2);
      expect(next.goal?.pendingMessageId).not.toBe(running.goal?.pendingMessageId);
      expect(h.commands.filter((c) => c.type === "thread.turn.start")).toHaveLength(2);
    }).pipe(Effect.scoped),
);

it.effect(
  "pausing an executing goal blocks new Main dispatch; cancelling preserves completed work",
  () =>
    Effect.gen(function* () {
      const h = yield* setup();
      yield* h.core.goal(goalInput);
      yield* h.session(false);
      const running = yield* waitForState(h.core, (s) => !!s.goal?.pendingMessageId);
      yield* h.session(true);
      yield* waitForState(h.core, (s) => !!s.goal?.runSeen);
      yield* h.core.goal({
        ...goalInput,
        commandId: CommandId.make("pause-running"),
        action: "pause",
        expectedGoalRevision: running.goal!.revision,
      });
      const denied = yield* h.core
        .invoke(mainScope, {
          action: "dispatch",
          commandId: CommandId.make("paused-dispatch"),
          workspaceId: workspace.id,
          objective: "implement",
          acceptanceCriteria: ["tests"],
          expectedRevision: workspace.stateRevision,
        })
        .pipe(Effect.result);
      expect(denied._tag).toBe("Failure");
      yield* h.session(false);
      const paused = yield* waitForState(
        h.core,
        (s) => s.goal?.status === "paused" && !s.goal.pendingMessageId,
      );
      expect(h.commands.filter((c) => c.type === "thread.turn.start")).toHaveLength(1);
      const cancelled = yield* h.core.goal({
        ...goalInput,
        commandId: CommandId.make("cancel-goal"),
        action: "cancel",
        expectedGoalRevision: paused.goal!.revision,
      });
      expect(cancelled.goal?.status).toBe("cancelled");
      expect(cancelled.bindings.map((b) => b.nativeSessionId)).toEqual([
        "native-main",
        "native-owner",
      ]);
    }).pipe(Effect.scoped),
);

it.effect(
  "a Main turn without progress acknowledgement blocks instead of looping; explicit resume reuses Main",
  () =>
    Effect.gen(function* () {
      const h = yield* setup();
      yield* h.core.goal(goalInput);
      yield* h.session(false);
      yield* waitForState(h.core, (s) => !!s.goal?.pendingMessageId);
      yield* h.session(true);
      yield* waitForState(h.core, (s) => !!s.goal?.runSeen);
      yield* h.session(false);
      const blocked = yield* waitForState(
        h.core,
        (s) => s.goal?.status === "blocked" && !s.goal.pendingMessageId,
      );
      yield* h.core.goal({
        ...goalInput,
        commandId: CommandId.make("resume-goal"),
        action: "resume",
        expectedGoalRevision: blocked.goal!.revision,
      });
      const resumed = yield* waitForState(h.core, (s) => s.goal?.steps === 2);
      expect(resumed.bindings[0]?.nativeSessionId).toBe("native-main");
    }).pipe(Effect.scoped),
);

it.effect(
  "completion requires a current verified integration; waiting requires real outstanding Owner work",
  () =>
    Effect.gen(function* () {
      const h = yield* setup();
      const started = yield* h.core.goal(goalInput);
      for (const outcome of ["complete", "wait"] as const) {
        const denied = yield* h.core
          .invoke(mainScope, {
            action: "goal-progress",
            commandId: CommandId.make(`false-${outcome}`),
            goalId: started.goal!.id,
            expectedGoalRevision: started.goal!.revision,
            objective: "모델의 주장",
            outcome,
            integrationId: "invented",
          })
          .pipe(Effect.result);
        expect(denied._tag).toBe("Failure");
      }
      expect((yield* h.core.get(state.projectId))?.goal?.status).toBe("active");
    }).pipe(Effect.scoped),
);

it.effect("restart stops a legacy goal with an uncertain turn and preserves identity", () =>
  Effect.gen(function* () {
    const first = yield* setup();
    const started = yield* first.core.goal(goalInput);
    const h = yield* setup({
      goal: { ...started.goal!, pendingMessageId: "uncertain", phase: "running", steps: 1 },
      keepLegacyStopped: true,
    });
    const recovered = yield* waitForState(
      h.core,
      (s) => s.goal?.status === "paused" && !s.goal.pendingMessageId,
    );
    expect(recovered.enabled).toBe(false);
    expect(recovered.goal?.pendingMessageId).toBeNull();
    expect(recovered.goal?.lastSummary).toContain("기존 지속 작업실의 자동 진행을 중지");
    expect(recovered.goal?.lastSummary).toContain("자동 재전송하지 않습니다");
    expect(recovered.bindings[0]?.nativeSessionId).toBe("native-main");
    expect(h.commands).toHaveLength(0);
  }).pipe(Effect.scoped),
);

it.effect("startup preserves legacy work but stops its automatic execution", () =>
  Effect.gen(function* () {
    const first = yield* setup();
    const started = yield* first.core.goal(goalInput);
    const h = yield* setup({
      goal: started.goal!,
      queuedAtStartup: true,
      keepLegacyStopped: true,
    });
    const stopped = yield* h.core.get(state.projectId);
    expect(stopped?.enabled).toBe(false);
    expect(stopped?.goal?.status).toBe("paused");
    expect(stopped?.goal?.objective).toBe(goalInput.objective);
    expect(stopped?.tasks).toHaveLength(1);
    expect(stopped?.tasks[0]?.status).toBe("queued");
    expect(stopped?.tasks[0]?.objective).toBe(task.objective);
    yield* h.session(false);
    expect(h.commands.filter((command) => command.type === "thread.turn.start")).toHaveLength(0);
    expect(h.executions).toHaveLength(0);
  }).pipe(Effect.scoped),
);

it.effect("startup also stops legacy queued work without a goal", () =>
  Effect.gen(function* () {
    const h = yield* setup({ queuedAtStartup: true, keepLegacyStopped: true });
    const stopped = yield* h.core.get(state.projectId);
    expect(stopped?.enabled).toBe(false);
    expect(stopped?.tasks[0]).toMatchObject({ status: "queued", objective: task.objective });
    yield* h.session(false);
    expect(h.commands.filter((command) => command.type === "thread.turn.start")).toHaveLength(0);
    expect(h.executions).toHaveLength(0);
  }).pipe(Effect.scoped),
);

it.effect("waiting for an Owner does not poll Main; completion resumes the same goal", () =>
  Effect.gen(function* () {
    const h = yield* setup();
    yield* h.core.goal(goalInput);
    yield* h.session(false);
    const started = yield* waitForState(h.core, (s) => !!s.goal?.pendingMessageId);
    yield* h.session(true);
    yield* waitForState(h.core, (s) => !!s.goal?.runSeen);
    yield* h.core.invoke(mainScope, {
      action: "dispatch",
      commandId: CommandId.make("goal-owner-task"),
      workspaceId: workspace.id,
      objective: "implement",
      acceptanceCriteria: ["tests"],
      expectedRevision: workspace.stateRevision,
    });
    yield* Deferred.await(h.entered);
    const latest = (yield* h.core.get(state.projectId))!;
    expect(latest.tasks[0]?.goalId).toBe(started.goal!.id);
    yield* h.core.invoke(mainScope, {
      action: "goal-progress",
      commandId: CommandId.make("wait-owner"),
      goalId: latest.goal!.id,
      expectedGoalRevision: latest.goal!.revision,
      objective: "Owner 실제 실행 대기",
      outcome: "wait",
    });
    yield* h.session(false);
    yield* waitForState(h.core, (s) => s.goal?.phase === "waiting" && !s.goal.pendingMessageId);
    expect(h.commands.filter((c) => c.type === "thread.turn.start")).toHaveLength(1);
    yield* Deferred.succeed(h.finish, undefined);
    yield* waitForState(h.core, (s) => s.goal?.steps === 2);
    expect(h.commands.filter((c) => c.type === "thread.turn.start")).toHaveLength(2);
  }).pipe(Effect.scoped),
);

it.effect(
  "the approved automatic turn limit stops a continuation instead of starting another turn",
  () =>
    Effect.gen(function* () {
      const h = yield* setup();
      yield* h.core.goal({ ...goalInput, maxSteps: 1 });
      yield* h.session(false);
      const started = yield* waitForState(h.core, (s) => !!s.goal?.pendingMessageId);
      yield* h.session(true);
      yield* waitForState(h.core, (s) => !!s.goal?.runSeen);
      yield* h.core.invoke(mainScope, {
        action: "goal-progress",
        commandId: CommandId.make("continue-at-limit"),
        goalId: started.goal!.id,
        expectedGoalRevision: started.goal!.revision,
        objective: "후속 단계 필요",
        outcome: "continue",
      });
      yield* h.session(false);
      const limited = yield* waitForState(h.core, (s) => s.goal?.status === "limited");
      expect(limited.goal?.steps).toBe(1);
      expect(h.commands.filter((c) => c.type === "thread.turn.start")).toHaveLength(1);
    }).pipe(Effect.scoped),
);

it.effect(
  "token budgets stop new automation, retain user control and preserve spend when raised",
  () =>
    Effect.gen(function* () {
      const usage: TokenUsageSummary = {
        ...emptyUsage,
        coverage: "reported",
        requestCount: 2,
        reportedRequestCount: 2,
        counts: { ...emptyUsage.counts, total: 1200, input: 1000, output: 200 },
      };
      const h = yield* setup({ goalUsage: usage });
      yield* h.core.goal({ ...goalInput, maxTokens: 1000 });
      const limited = yield* waitForState(h.core, (s) => s.goal?.status === "limited");
      expect(limited.goal?.lastSummary).toContain("토큰");
      expect(h.commands.filter((command) => command.type === "thread.turn.start")).toHaveLength(0);
      const denied = yield* h.core
        .invoke(mainScope, {
          action: "dispatch",
          commandId: CommandId.make("budget-dispatch"),
          workspaceId: workspace.id,
          objective: "automatic",
          acceptanceCriteria: ["tests"],
          expectedRevision: workspace.stateRevision,
        })
        .pipe(Effect.result);
      expect(denied._tag).toBe("Failure");
      yield* h.core.directInput({
        projectId: state.projectId,
        conversationId: state.conversationId,
        workspaceId: workspace.id,
        commandId: CommandId.make("budget-human"),
        expectedRevision: workspace.stateRevision,
        text: "explicit follow-up",
        mode: "followup",
        requirementChange: false,
      });
      const direct = yield* Deferred.await(h.entered);
      expect(direct.prompt).toContain("explicit follow-up");
      yield* Deferred.succeed(h.finish, undefined);
      yield* Deferred.await(h.completed);
      const resumed = yield* h.core.goal({
        ...goalInput,
        commandId: CommandId.make("raise-budget"),
        action: "resume",
        expectedGoalRevision: limited.goal!.revision,
        maxTokens: 2000,
      });
      expect(resumed.goal?.id).toBe(limited.goal?.id);
      expect(resumed.goal?.maxTokens).toBe(2000);
      expect(resumed.goal?.lastResumedAt).toBe(resumed.goal?.activatedAt);
      expect(resumed.goal?.lastResumedAt).toBeDefined();
      expect((yield* h.core.get(state.projectId))?.usage?.goal?.counts.total).toBe(1200);
    }).pipe(Effect.scoped),
);

it.effect("a project daily budget also stops automation without inventing missing usage", () =>
  Effect.gen(function* () {
    const h = yield* setup({
      dailyUsage: {
        ...emptyUsage,
        coverage: "reported",
        requestCount: 1,
        reportedRequestCount: 1,
        counts: { ...emptyUsage.counts, total: 500 },
      },
    });
    yield* h.core.configure({
      projectId: state.projectId,
      conversationId: state.conversationId,
      commandId: CommandId.make("daily-cap"),
      enabled: true,
      mainModel: mainBinding.model,
      ownerModels: state.ownerModels,
      runtimeMode: state.runtimeMode,
      maxParallelOwners: state.maxParallelOwners,
      verificationCommands: state.verificationCommands,
      maxDailyTokens: 500,
    });
    yield* h.core.goal(goalInput);
    const limited = yield* waitForState(h.core, (s) => s.goal?.status === "limited");
    expect(limited.goal?.lastSummary).toContain("일일");
    expect(limited.usage?.goal?.counts.total).toBeNull();
  }).pipe(Effect.scoped),
);

it.effect("disabling automation preserves Main and Owner native session identities", () =>
  Effect.gen(function* () {
    const harness = yield* setup();
    const disabled = yield* harness.core.configure({
      projectId: state.projectId,
      conversationId: state.conversationId,
      commandId: CommandId.make("disable"),
      enabled: false,
      mainModel: mainBinding.model,
      ownerModels: state.ownerModels,
      runtimeMode: state.runtimeMode,
      maxParallelOwners: state.maxParallelOwners,
      verificationCommands: state.verificationCommands,
    });
    expect(disabled.enabled).toBe(false);
    expect(disabled.bindings.find((binding) => binding.role === "main")?.nativeSessionId).toBe(
      "native-main",
    );
    expect(disabled.bindings.find((binding) => binding.role === "owner")?.nativeSessionId).toBe(
      "native-owner",
    );
    expect(disabled.workspaces[0]?.id).toBe(workspace.id);
    expect(harness.executions).toHaveLength(0);
  }).pipe(Effect.scoped),
);

it.effect(
  "saving settings preserves the development goal and disabling pauses it without erasing work",
  () =>
    Effect.gen(function* () {
      const h = yield* setup();
      const started = yield* h.core.goal(goalInput);
      const configure = {
        projectId: state.projectId,
        conversationId: state.conversationId,
        mainModel: mainBinding.model,
        ownerModels: state.ownerModels,
        runtimeMode: state.runtimeMode,
        maxParallelOwners: state.maxParallelOwners,
        verificationCommands: state.verificationCommands,
      };
      const saved = yield* h.core.configure({
        ...configure,
        commandId: CommandId.make("save-goal-config"),
        enabled: true,
      });
      expect(saved.goal).toEqual(started.goal);
      const disabled = yield* h.core.configure({
        ...configure,
        commandId: CommandId.make("disable-goal-config"),
        enabled: false,
      });
      expect(disabled.goal?.id).toBe(started.goal?.id);
      expect(disabled.goal?.status).toBe("paused");
      expect(disabled.goal?.objective).toBe(started.goal?.objective);
      expect(disabled.goal?.revision).toBe(started.goal!.revision + 1);
      expect(disabled.goal?.activatedAt).toBeNull();
      expect(disabled.workspaces).toEqual(saved.workspaces);
      expect(disabled.tasks).toEqual(saved.tasks);
      const enabled = yield* h.core.configure({
        ...configure,
        commandId: CommandId.make("reenable-goal-config"),
        enabled: true,
      });
      expect(enabled.goal).toEqual(disabled.goal);
      expect(h.commands.filter((command) => command.type === "thread.turn.start")).toHaveLength(0);
    }).pipe(Effect.scoped),
);

it.effect("Main cannot select an Owner profile outside the user's approved pool", () =>
  Effect.gen(function* () {
    const harness = yield* setup();
    const denied = yield* harness.core
      .invoke(mainScope, {
        action: "create",
        commandId: CommandId.make("outside-pool"),
        name: "New",
        scope: ["new"],
        objective: "separate responsibility",
        modelIndex: 8,
      })
      .pipe(Effect.result);
    expect(denied._tag).toBe("Failure");
    expect(harness.executions).toHaveLength(0);
    expect((yield* harness.core.get(state.projectId))?.workspaces).toHaveLength(1);
  }).pipe(Effect.scoped),
);

it.effect(
  "a target change during combined integration verification never updates the integration checkout",
  () =>
    Effect.gen(function* () {
      let targetSha = workspace.baseSha;
      let checks = 0;
      const harness = yield* setup({
        inspect: (cwd) =>
          Effect.succeed({
            sha: cwd === "D:/repo" ? targetSha : workspace.baseSha,
            branch: workspace.branch,
            commonDirectory: "D:/repo/.git",
            clean: true,
            fingerprint: workspace.observedFingerprint,
          }),
        verify: () =>
          Effect.sync(() => {
            if (++checks === 2) targetSha = "b".repeat(40);
            return { passed: true, commands: [], artifacts: [] };
          }),
      });
      yield* harness.core.invoke(mainScope, {
        action: "verify",
        commandId: CommandId.make("initial-candidate"),
        workspaceId: workspace.id,
        expectedRevision: workspace.stateRevision,
        candidateSha: workspace.baseSha,
      });
      const verified = yield* harness.core.get(state.projectId);
      yield* harness.core.invoke(mainScope, {
        action: "integrate",
        commandId: CommandId.make("changed-target"),
        verificationIds: [verified!.verifications[0]!.id],
      });
      const latest = yield* harness.core.get(state.projectId);
      expect(latest?.integrations[0]?.status).toBe("stale");
      expect(harness.gitCalls.some((call) => call.cwd === "D:/repo")).toBe(false);
    }).pipe(Effect.scoped),
);

it.effect(
  "a lost submit acknowledgement becomes delivery_unknown without replaying the input",
  () =>
    Effect.gen(function* () {
      const harness = yield* setup({ submittingFailure: true });
      const done = yield* Deferred.make<void>();
      yield* harness.core.subscribe(state.projectId).pipe(
        Stream.runForEach(({ state }) =>
          state?.tasks.at(-1)?.delivery === "delivery_unknown"
            ? Deferred.succeed(done, undefined)
            : Effect.void,
        ),
        Effect.forkScoped,
      );
      yield* harness.core.invoke(mainScope, {
        action: "dispatch",
        commandId: CommandId.make("ambiguous"),
        workspaceId: workspace.id,
        expectedRevision: workspace.stateRevision,
        objective: "implement",
        acceptanceCriteria: ["test"],
      });
      yield* Deferred.await(done);
      yield* harness.core.invoke(mainScope, {
        action: "dispatch",
        commandId: CommandId.make("ambiguous"),
        workspaceId: workspace.id,
        expectedRevision: workspace.stateRevision,
        objective: "implement",
        acceptanceCriteria: ["test"],
      });
      expect(harness.executions).toHaveLength(1);
    }).pipe(Effect.scoped),
);

it.effect("verification forwards requested evidence and persists a missing output as failed", () =>
  Effect.gen(function* () {
    const artifact = {
      relativePath: "report.pdf",
      label: "report.pdf",
      mediaType: null,
      snapshotPath: null,
      byteLength: null,
      sha256: null,
      error: "missing output",
    };
    const harness = yield* setup({
      verify: (_cwd, _commands, _label, evidencePaths) =>
        Effect.sync(() => {
          expect(evidencePaths).toEqual(["report.pdf"]);
          return { passed: false, commands: [], artifacts: [artifact] };
        }),
    });
    yield* harness.core.invoke(mainScope, {
      action: "verify",
      commandId: CommandId.make("verify-evidence"),
      workspaceId: workspace.id,
      expectedRevision: workspace.stateRevision,
      candidateSha: workspace.baseSha,
      evidencePaths: ["report.pdf"],
    });
    const latest = yield* harness.core.get(state.projectId);
    expect(latest?.verifications[0]?.status).toBe("failed");
    expect(latest?.verifications[0]?.artifacts).toEqual([artifact]);
  }).pipe(Effect.scoped),
);

it.effect("verification records a stale target change and never promotes the former result", () =>
  Effect.gen(function* () {
    let targetSha = workspace.baseSha;
    const harness = yield* setup({
      inspect: (cwd) =>
        Effect.succeed({
          sha: cwd === "D:/repo" ? targetSha : workspace.baseSha,
          branch: workspace.branch,
          commonDirectory: "D:/repo/.git",
          clean: true,
          fingerprint: workspace.observedFingerprint,
        }),
      verify: () =>
        Effect.sync(() => {
          targetSha = "b".repeat(40);
          return { passed: true, commands: [], artifacts: [] };
        }),
    });
    yield* harness.core.invoke(mainScope, {
      action: "verify",
      commandId: CommandId.make("verify-target-change"),
      workspaceId: workspace.id,
      expectedRevision: workspace.stateRevision,
      candidateSha: workspace.baseSha,
    });
    const latest = yield* harness.core.get(state.projectId);
    expect(latest?.verifications[0]?.status).toBe("stale");
    const denied = yield* harness.core
      .invoke(mainScope, {
        action: "integrate",
        commandId: CommandId.make("deny-stale"),
        verificationIds: [latest!.verifications[0]!.id],
      })
      .pipe(Effect.result);
    expect(denied._tag).toBe("Failure");
    expect(harness.gitCalls).toHaveLength(0);
  }).pipe(Effect.scoped),
);

it.effect("B added after A was reviewed cannot inherit A's verification", () =>
  Effect.gen(function* () {
    let ownerSha = workspace.baseSha;
    const harness = yield* setup({
      inspect: (cwd) =>
        Effect.succeed({
          sha: cwd === "D:/repo" ? workspace.baseSha : ownerSha,
          branch: workspace.branch,
          commonDirectory: "D:/repo/.git",
          clean: true,
          fingerprint: workspace.observedFingerprint,
        }),
    });
    yield* harness.core.invoke(mainScope, {
      action: "verify",
      commandId: CommandId.make("verify-a"),
      workspaceId: workspace.id,
      expectedRevision: workspace.stateRevision,
      candidateSha: workspace.baseSha,
    });
    const verified = yield* harness.core.get(state.projectId);
    ownerSha = "b".repeat(40);
    const denied = yield* harness.core
      .invoke(mainScope, {
        action: "integrate",
        commandId: CommandId.make("deny-b"),
        verificationIds: [verified!.verifications[0]!.id],
      })
      .pipe(Effect.result);
    expect(denied._tag).toBe("Failure");
    expect(harness.gitCalls).toHaveLength(0);
  }).pipe(Effect.scoped),
);

it.effect("an Owner cannot impersonate Main by sharing its owning conversation id", () =>
  Effect.gen(function* () {
    const harness = yield* setup();
    const denied = yield* harness.core
      .invoke(
        {
          threadId: state.conversationId,
          sessionKey: ownerBinding.sessionKey,
          providerInstanceId: mainBinding.model.instanceId,
          environmentId: "fixture" as import("@t3tools/contracts").EnvironmentId,
          providerSessionId: "authenticated-owner",
          capabilities: new Set(),
          issuedAt: 0,
        },
        { action: "create", commandId: CommandId.make("spoof") },
      )
      .pipe(Effect.result);
    expect(denied._tag).toBe("Failure");
  }).pipe(Effect.scoped),
);

it.effect(
  "recovery keeps accepted input unknown and never runs a replacement writer automatically",
  () =>
    Effect.gen(function* () {
      let observedFingerprint = workspace.observedFingerprint;
      const harness = yield* setup({
        recovering: true,
        inspect: () =>
          Effect.succeed({
            sha: workspace.baseSha,
            branch: workspace.branch,
            commonDirectory: "D:/repo/.git",
            clean: true,
            fingerprint: observedFingerprint,
          }),
      });
      const recovered = yield* Deferred.make<void>();
      yield* harness.core.subscribe(state.projectId).pipe(
        Stream.runForEach(({ state }) =>
          state?.tasks[0]?.delivery === "delivery_unknown"
            ? Deferred.succeed(recovered, undefined)
            : Effect.void,
        ),
        Effect.forkScoped,
      );
      yield* Deferred.await(recovered);
      const restored = yield* harness.core.get(state.projectId);
      expect(restored?.tasks[0]?.status).toBe("delivery_unknown");
      expect(restored?.workspaces[0]?.control).toBe("reconciling");
      expect(restored?.bindings[1]?.nativeSessionId).toBe("native-owner");
      expect(harness.executions).toHaveLength(0);
      observedFingerprint = "changed-checkout";
      yield* harness.store.mutate(
        state.projectId,
        CommandId.make("checkout-reconciled"),
        { kind: "workspace.reconciled", source: "main", payload: {} },
        (current) =>
          Effect.succeed({
            ...current!,
            mainObservedRevision: 100,
            tasks: current!.tasks.map((entry) => ({
              ...entry,
              failureCodeFingerprint: "previous-checkout",
            })),
            workspaces: current!.workspaces.map((entry) => ({
              ...entry,
              observedFingerprint: "changed-checkout",
              control: "managed",
              summaryPending: false,
              externalUnmanaged: false,
              requirementRevision: entry.requirementRevision + 1,
            })),
          }),
      );
      const changed = (yield* harness.core.get(state.projectId))!;
      const rejected = yield* harness.core
        .invoke(mainScope, {
          action: "dispatch",
          commandId: CommandId.make("do-not-replay-after-checkout-change"),
          workspaceId: workspace.id,
          expectedRevision: changed.workspaces[0]!.stateRevision,
          objective: task.objective,
          acceptanceCriteria: ["tests"],
          recoveryStrategy: "repair-and-verify",
        })
        .pipe(Effect.result);
      expect(rejected._tag).toBe("Failure");
      if (rejected._tag === "Failure") expect(rejected.failure.message).toContain("전달 여부");
      expect(harness.executions).toHaveLength(0);
      const explicit = yield* harness.core.directInput({
        projectId: state.projectId,
        conversationId: state.conversationId,
        workspaceId: workspace.id,
        commandId: CommandId.make("explicit-user-replacement"),
        expectedRevision: changed.workspaces[0]!.stateRevision,
        text: "진행 기록을 확인한 뒤 새 지시로 교체합니다.",
        mode: "replace",
        requirementChange: false,
      });
      expect(explicit.tasks[0]?.status).toBe("superseded");
      expect(explicit.tasks[0]?.delivery).toBe("delivery_unknown");
      expect(explicit.tasks[0]?.messageId).toBe(task.messageId);
      yield* Deferred.await(harness.entered);
      expect(harness.executions).toHaveLength(1);
      const current = (yield* harness.core.get(state.projectId))!;
      expect(current.tasks.at(-1)?.commandId).toBe("explicit-user-replacement");
      yield* Deferred.succeed(harness.finish, undefined);
      yield* Deferred.await(harness.completed);
    }).pipe(Effect.scoped),
);

for (const runtimeMode of [
  "full-access",
  "auto",
  "auto-accept-edits",
  "approval-required",
] as const) {
  const interactionMode = runtimeMode === "approval-required" ? "plan" : "default";
  it.effect(`app-selected policy reaches Architect: ${runtimeMode}/${interactionMode}`, () =>
    Effect.gen(function* () {
      const h = yield* setup({
        mainRuntimeMode: runtimeMode,
        mainInteractionMode: interactionMode,
      });
      const running = yield* h.core
        .invoke(mainScope, {
          action: "architect",
          commandId: CommandId.make("selected-architect"),
          objective: "Read the Python runtime version without changing files.",
        })
        .pipe(Effect.forkChild);
      const input = yield* Deferred.await(h.entered);
      expect(input.runtimeMode).toBe(runtimeMode);
      expect(input.interactionMode).toBe(interactionMode);
      yield* Deferred.succeed(h.finish, undefined);
      yield* Fiber.join(running);
    }).pipe(Effect.scoped),
  );
  it.effect(`app-selected policy reaches persistent Owner: ${runtimeMode}/${interactionMode}`, () =>
    Effect.gen(function* () {
      const h = yield* setup({
        mainRuntimeMode: runtimeMode,
        mainInteractionMode: interactionMode,
      });
      yield* h.core.directInput({
        projectId: state.projectId,
        conversationId: state.conversationId,
        workspaceId: workspace.id,
        commandId: CommandId.make("selected-owner"),
        expectedRevision: workspace.stateRevision,
        text: "Read the Python runtime version without changing files.",
        mode: "followup",
        requirementChange: false,
      });
      const input = yield* Deferred.await(h.entered);
      expect(input.runtimeMode).toBe(runtimeMode);
      expect(input.interactionMode).toBe(interactionMode);
      yield* Deferred.succeed(h.finish, undefined);
      yield* Deferred.await(h.completed);
    }).pipe(Effect.scoped),
  );
}

it.effect(
  "saving app-selected execution settings updates Main and retains persistent session identities",
  () =>
    Effect.gen(function* () {
      const h = yield* setup();
      const configured = yield* h.core.configure({
        projectId: state.projectId,
        conversationId: state.conversationId,
        commandId: CommandId.make("selected-configuration"),
        enabled: true,
        mainModel: mainBinding.model,
        ownerModels: state.ownerModels,
        runtimeMode: "full-access",
        interactionMode: "plan",
        maxParallelOwners: state.maxParallelOwners,
        verificationCommands: state.verificationCommands,
      });
      expect(configured.runtimeMode).toBe("full-access");
      expect(configured.interactionMode).toBe("plan");
      expect(h.commands).toContainEqual(
        expect.objectContaining({ type: "thread.runtime-mode.set", runtimeMode: "full-access" }),
      );
      expect(h.commands).toContainEqual(
        expect.objectContaining({ type: "thread.interaction-mode.set", interactionMode: "plan" }),
      );
      expect(configured.bindings.map((b) => b.nativeSessionId)).toEqual([
        "native-main",
        "native-owner",
      ]);
      const input = yield* h.core.prepareMainInput(
        state.conversationId,
        "Continue the authorized work.",
      );
      expect(input).toContain("Continue the authorized work.");
      expect((yield* h.core.get(state.projectId))?.runtimeMode).toBe("full-access");
    }).pipe(Effect.scoped),
);

it.effect(
  "a restricted app selection replaces a previously full-access workspace before execution",
  () =>
    Effect.gen(function* () {
      const h = yield* setup({
        savedRuntimeMode: "full-access",
        mainRuntimeMode: "approval-required",
      });
      yield* h.core.directInput({
        projectId: state.projectId,
        conversationId: state.conversationId,
        workspaceId: workspace.id,
        commandId: CommandId.make("restricted-selection"),
        expectedRevision: workspace.stateRevision,
        text: "Read the version.",
        mode: "followup",
        requirementChange: false,
      });
      const input = yield* Deferred.await(h.entered);
      expect(input.runtimeMode).toBe("approval-required");
      expect((yield* h.core.get(state.projectId))?.runtimeMode).toBe("approval-required");
      yield* Deferred.succeed(h.finish, undefined);
      yield* Deferred.await(h.completed);
    }).pipe(Effect.scoped),
);

const decodeManagementResult = Schema.decodeUnknownEffect(WorkspaceDevelopmentToolResult);
const decodeManagementSummary = Schema.decodeUnknownEffect(
  Schema.fromJsonString(WorkspaceDevelopmentToolSummary),
);
const managementClient = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "workspace-round-trip", version: "1" },
  },
  getClient: Effect.die("No external client is used by the management test"),
});

it.effect(
  "Architect completion returns a durable review through the actual MCP contract without repeating execution",
  () =>
    Effect.gen(function* () {
      const h = yield* setup();
      const input = {
        action: "architect" as const,
        commandId: CommandId.make("architect-round-trip"),
        objective: "Review existing boundaries without changing files.",
      };
      const toolkit = McpServer.toolkit(WorkspaceDevelopmentToolkit).pipe(
        Layer.provide(
          managementHandlers.pipe(Layer.provide(Layer.succeed(WorkspaceDevelopment, h.core))),
        ),
        Layer.provideMerge(McpServer.McpServer.layer),
      );
      const pending = yield* Effect.gen(function* () {
        const server = yield* McpServer.McpServer;
        return yield* server.callTool({ name: "workspace_manage", arguments: input });
      }).pipe(
        Effect.provideService(McpInvocationContext, mainScope),
        Effect.provideService(McpSchema.McpServerClient, managementClient),
        Effect.provide(toolkit),
        Effect.forkChild,
      );
      yield* Deferred.await(h.entered);
      yield* Deferred.succeed(h.finish, undefined);
      const result = yield* Fiber.join(pending);
      expect(result.isError).toBe(false);
      const decoded = yield* decodeManagementResult(result.structuredContent);
      expect(decoded).toMatchObject({
        architectReview: {
          commandId: input.commandId,
          runGeneration: 1,
          output: "Actual code summary",
        },
        receipt: { action: "architect", commandId: input.commandId },
      });
      const persisted = yield* h.store.read(state.projectId);
      expect(persisted).toMatchObject({
        architectReview: { commandId: input.commandId, output: "Actual code summary" },
      });
      const read = yield* h.core.invoke(mainScope, {
        action: "status",
        commandId: CommandId.make("read-completed-review"),
      });
      expect(yield* decodeManagementSummary(read)).toMatchObject({
        architectReview: { commandId: input.commandId, output: "Actual code summary" },
      });
      const replay = yield* h.core.invoke(mainScope, input);
      expect(yield* decodeManagementSummary(replay)).toMatchObject({
        architectReview: { commandId: input.commandId, output: "Actual code summary" },
      });
      expect(h.executions).toHaveLength(1);
    }).pipe(Effect.scoped),
);

for (const role of ["owner", "architect"] as const) {
  it.effect(
    "a bound " + role + " can read status without recording a Main observation or dispatching work",
    () =>
      Effect.gen(function* () {
        const h = yield* setup();
        const binding: DevelopmentSessionBinding =
          role === "owner"
            ? ownerBinding
            : {
                ...mainBinding,
                id: DevelopmentBindingId.make("architect-reader"),
                role: "architect",
                sessionKey: ThreadId.make("development:architect-reader"),
                nativeSessionId: "native-architect",
              };
        const entered = yield* h.store.mutate(
          state.projectId,
          CommandId.make("reader-fixture"),
          { kind: "fixture", source: "runtime", payload: {} },
          (current) =>
            Effect.succeed({
              ...current!,
              mainObservedRevision: 0,
              bindings: current!.bindings.some((b) => b.id === binding.id)
                ? current!.bindings
                : [...current!.bindings, binding],
            }),
        );
        const scope: McpInvocationScope = { ...mainScope, sessionKey: binding.sessionKey };
        const text = yield* h.core.invoke(scope, {
          action: "status",
          commandId: CommandId.make("bound-role-read"),
        });
        const decoded = yield* decodeManagementSummary(text);
        expect(decoded.revision).toBe(entered.revision);
        expect(decoded.mainObservedRevision).toBe(0);
        expect((yield* h.core.get(state.projectId))?.mainObservedRevision).toBe(0);
        expect(h.executions).toHaveLength(0);
        const denied = yield* h.core
          .invoke(scope, {
            action: "architect",
            commandId: CommandId.make("role-mutation"),
            objective: "Start a new review",
          })
          .pipe(Effect.result);
        expect(denied._tag).toBe("Failure");
        expect(h.executions).toHaveLength(0);
      }).pipe(Effect.scoped),
  );
}

it.effect(
  "status remains unavailable to an unbound session even inside the Main conversation",
  () =>
    Effect.gen(function* () {
      const h = yield* setup();
      const denied = yield* h.core
        .invoke(
          { ...mainScope, sessionKey: ThreadId.make("development:unbound-session") },
          { action: "status", commandId: CommandId.make("unbound-read") },
        )
        .pipe(Effect.result);
      expect(denied._tag).toBe("Failure");
      if (denied._tag === "Failure") {
        expect(denied.failure.message).toContain("일반 대화의 파일 접근·수정 권한과 무관");
        expect(denied.failure.message).toContain("현재 대화에서 직접 계속");
      }
      expect(h.executions).toHaveLength(0);
    }).pipe(Effect.scoped),
);
