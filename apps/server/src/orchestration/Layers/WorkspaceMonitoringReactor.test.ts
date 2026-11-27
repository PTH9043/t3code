import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DEFAULT_WORKSPACE_CONTROL_SETTINGS,
  DEFAULT_WORKSPACE_MONITORING_SETTINGS,
  DEFAULT_WORKSPACE_PROGRAM_HUB_MEMORY,
  DEFAULT_WORKSPACE_PROGRAM_INTEGRITY,
  ProjectId,
  ProviderInstanceId,
  WorkspaceProgramId,
  WorkspaceProgramRunId,
  type OrchestrationCommand,
  type OrchestrationThread,
  type ResourceTelemetrySnapshot,
  type ServerSettings,
  type VcsStatusLocalResult,
  type WorkspaceMonitoringPlan,
  type WorkspaceMonitoringSettings,
  type WorkspaceProgram,
  type WorkspaceProgramRun,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient } from "effect/unstable/http";
import { expect, it } from "@effect/vitest";

import { ServerSelfSignals, makeServerSelfSignals } from "../../diagnostics/ServerSelfSignals.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import type { ProjectionProject } from "../../persistence/Services/ProjectionProjects.ts";
import { ProjectionProjectRepository } from "../../persistence/Services/ProjectionProjects.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import { ProjectionWorkspaceAgentRoleRepository } from "../../persistence/Services/ProjectionWorkspaceAgentRoles.ts";
import { ProjectionWorkspaceProgramRepository } from "../../persistence/Services/ProjectionWorkspacePrograms.ts";
import * as ProcessRunner from "../../processRunner.ts";
import { ResourceTelemetry } from "../../resourceTelemetry/ResourceTelemetry.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { VcsStatusBroadcaster } from "../../vcs/VcsStatusBroadcaster.ts";
import {
  WORKSPACE_MONITORING_ACTION_CLOSE_MARKER,
  WORKSPACE_MONITORING_ACTION_OPEN_MARKER,
  WORKSPACE_MONITORING_PLAN_CLOSE_MARKER,
  WORKSPACE_MONITORING_PLAN_OPEN_MARKER,
} from "../workspaceMonitoring.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import { OrchestrationTurnWait } from "../Services/OrchestrationTurnWait.ts";
import { OrchestrationCommandInvariantError } from "../Errors.ts";
import { WorkspaceMonitoringReactor } from "../Services/WorkspaceMonitoringReactor.ts";
import { WorkspaceProgramSupervisor } from "../Services/WorkspaceProgramSupervisor.ts";
import { WorkspaceMonitoringReactorLive } from "./WorkspaceMonitoringReactor.ts";

const T0 = "2026-08-21T00:00:00.000Z";
const projectId = ProjectId.make("workspace-a");
const programId = WorkspaceProgramId.make("prog-dev");

const program: WorkspaceProgram = {
  id: programId,
  projectId,
  name: "dev",
  command: "pnpm dev",
  relativeDirectory: "",
  environmentVariableNames: [],
  startPolicy: "manual",
  healthCheck: null,
  errorPatterns: [],
  enabled: true,
  integrity: DEFAULT_WORKSPACE_PROGRAM_INTEGRITY,
  hubMemory: DEFAULT_WORKSPACE_PROGRAM_HUB_MEMORY,
  createdAt: T0,
  updatedAt: T0,
};

const runWith = (consecutiveHealthFailures: number, pid = 4242): WorkspaceProgramRun => ({
  id: WorkspaceProgramRunId.make("run-1"),
  projectId,
  programId,
  status: "running",
  pid,
  startedAt: T0,
  stoppedAt: null,
  exitCode: null,
  exitSignal: null,
  healthStatus: consecutiveHealthFailures > 0 ? "unhealthy" : "healthy",
  consecutiveHealthFailures,
  lastHealthCheckAt: T0,
  lastHealthFailure: null,
  recentLogTail: "",
  updatedAt: T0,
});

const planOutput = `감시 계획입니다.\n${WORKSPACE_MONITORING_PLAN_OPEN_MARKER}\n${JSON.stringify({
  rationale: "dev 서버 상태검사",
  targets: [{ kind: "program", label: "dev", programId }],
  metrics: [{ targetIndex: 0, metric: "health", trend: "threshold", windowMin: 1, limit: 1 }],
  playbooks: [{ when: 0, action: "notify-only" }],
})}\n${WORKSPACE_MONITORING_PLAN_CLOSE_MARKER}`;

const emptyTelemetry = { processes: [] } as unknown as ResourceTelemetrySnapshot;

const vcsStatus = (files: ReadonlyArray<string>): VcsStatusLocalResult =>
  ({
    isRepo: true,
    hasPrimaryRemote: false,
    isDefaultRef: true,
    refName: "main",
    hasWorkingTreeChanges: files.length > 0,
    workingTree: {
      files: files.map((path) => ({ path, insertions: 1, deletions: 0 })),
      insertions: files.length,
      deletions: 0,
    },
  }) as unknown as VcsStatusLocalResult;

/**
 * Everything the reactor talks to, as stubs with knobs. Each test gets a fresh
 * harness; the engine stub applies the reactor's own bookkeeping commands so
 * the next read sees them, which is all the decider would do here.
 */
const makeHarness = (input: {
  readonly workspaceRoot?: string;
  readonly monitoring?: Partial<WorkspaceMonitoringSettings>;
  readonly program?: WorkspaceProgram;
  readonly allowAutoActions?: boolean;
  readonly selfSignals?: ServerSelfSignals["Service"];
}) =>
  Effect.gen(function* () {
    const projectRef = yield* Ref.make<ProjectionProject>({
      projectId,
      title: "Workspace A",
      workspaceRoot: input.workspaceRoot ?? process.cwd(),
      defaultModelSelection: null,
      scripts: [],
      workspaceControl: {
        ...DEFAULT_WORKSPACE_CONTROL_SETTINGS,
        monitoring: {
          ...DEFAULT_WORKSPACE_MONITORING_SETTINGS,
          enabled: true,
          checkIntervalSec: 15,
          aiTurnBudget: { perHour: 1, perDay: 5 },
          ...input.monitoring,
        },
      },
      runtimeViewedThrough: null,
      createdAt: T0,
      updatedAt: T0,
      deletedAt: null,
    });
    const runRef = yield* Ref.make(runWith(0));
    const turnGate = yield* Deferred.make<void>();
    const vcsRef = yield* Ref.make<VcsStatusLocalResult | null>(null);
    const commands: OrchestrationCommand[] = [];
    const processRuns: string[] = [];
    const state = {
      assistantOutput: planOutput,
      currentAssistantOutput: true,
      requestedAt: T0,
      requestedMessageId: "",
      differentRequest: false,
      resultRequestedAt: null as string | null,
      explicitAssistantMessageId: null as string | null,
      selfReads: 0,
      blockTurn: false,
      denyNextAutoAction: false,
      stopFailure: null as
        | "transient"
        | "plan-disabled"
        | "rejected"
        | "guard-denied"
        | "interrupted"
        | "persistent"
        | null,
      subscribers: 0,
      monitoredProcesses: [] as ReadonlyArray<{
        readonly pid: number;
        readonly startTimeMs?: number;
      }>,
      processExitCode: 0,
      httpOk: true,
      httpCalls: 0,
      selfRatesByWindow: new Map<number, { slowSpansPerMin: number; failedSpansPerMin: number }>(),
    };
    const activeProgram = input.program ?? program;

    const patchMonitoring = (patch: Partial<WorkspaceMonitoringSettings>) =>
      Ref.update(projectRef, (project) => ({
        ...project,
        workspaceControl: {
          ...project.workspaceControl,
          monitoring: { ...project.workspaceControl.monitoring, ...patch },
        },
      }));

    const engine: OrchestrationEngineShape = {
      dispatch: (command) =>
        Effect.gen(function* () {
          commands.push(command);
          if (command.type === "project.program.stop" && state.stopFailure !== null) {
            const failure = state.stopFailure;
            if (failure !== "persistent") state.stopFailure = null;
            if (failure === "plan-disabled") yield* patchMonitoring({ enabled: false });
            if (failure === "guard-denied") state.denyNextAutoAction = true;
            if (failure === "interrupted") return yield* Effect.interrupt;
            if (failure === "rejected") {
              return yield* new OrchestrationCommandInvariantError({
                commandType: command.type,
                detail: "plan rejected",
              });
            }
            return yield* Effect.die(new Error("synthetic dispatch failure"));
          }
          switch (command.type) {
            case "thread.turn.start":
              state.requestedAt = command.createdAt;
              state.requestedMessageId = command.message.messageId;
              break;
            case "project.monitoring.runtime.update":
              yield* patchMonitoring({
                ...(command.threadId !== undefined ? { threadId: command.threadId } : {}),
                ...(command.turnLog !== undefined ? { turnLog: command.turnLog } : {}),
                ...(command.lastCheckedAt !== undefined
                  ? { lastCheckedAt: command.lastCheckedAt }
                  : {}),
              });
              break;
            case "project.monitoring.plan.propose":
              yield* patchMonitoring({
                plan: { ...command.plan, revision: 1 },
                planStatus: "proposed",
              });
              break;
            default:
              break;
          }
          return { sequence: commands.length };
        }),
      readEvents: () => Stream.empty,
      streamDomainEvents: Stream.empty,
      latestSequence: Effect.succeed(0),
    };

    const layer = WorkspaceMonitoringReactorLive.pipe(
      Layer.provideMerge(Layer.succeed(OrchestrationEngineService, engine)),
      Layer.provideMerge(
        Layer.succeed(ProjectionTurnRepository, {
          getByTurnId: () =>
            Effect.succeed(
              Option.some({
                pendingMessageId: state.differentRequest
                  ? "a-different-request"
                  : state.requestedMessageId,
              } as never),
            ),
        } as unknown as ProjectionTurnRepository["Service"]),
      ),
      Layer.provideMerge(
        Layer.succeed(ProjectionProjectRepository, {
          upsert: () => Effect.void,
          getById: ({ projectId: requested }) =>
            Ref.get(projectRef).pipe(
              Effect.map((project) =>
                project.projectId === requested ? Option.some(project) : Option.none(),
              ),
            ),
          listAll: () => Ref.get(projectRef).pipe(Effect.map((project) => [project])),
          deleteById: () => Effect.void,
        } satisfies ProjectionProjectRepository["Service"]),
      ),
      Layer.provideMerge(
        Layer.succeed(ProjectionWorkspaceProgramRepository, {
          upsertProgram: () => Effect.void,
          removeProgram: () => Effect.void,
          removeByProjectId: () => Effect.void,
          getProgram: () => Effect.succeed(Option.some(activeProgram)),
          listPrograms: () => Effect.succeed([activeProgram]),
          listAutoStartPrograms: () => Effect.succeed([]),
          updateIntegrity: () => Effect.void,
          listIntegrityPrograms: () => Effect.succeed([]),
          upsertRun: () => Effect.void,
          listRuns: () => Ref.get(runRef).pipe(Effect.map((run) => [run])),
          listActiveRuns: () => Effect.succeed([]),
          upsertIncident: () => Effect.void,
          getIncident: () => Effect.succeed(Option.none()),
          findOpenIncidentByFingerprint: () => Effect.succeed(Option.none()),
          listIncidents: () => Effect.succeed([]),
          listRecoverableIncidents: () => Effect.succeed([]),
        } satisfies ProjectionWorkspaceProgramRepository["Service"]),
      ),
      Layer.provideMerge(
        Layer.succeed(ProjectionWorkspaceAgentRoleRepository, {
          upsert: () => Effect.void,
          remove: () => Effect.void,
          listByProjectId: () =>
            Effect.succeed([
              {
                projectId,
                role: "operator",
                modelSelection: {
                  instanceId: ProviderInstanceId.make("codex"),
                  model: "gpt-5-codex",
                },
                enabled: true,
                createdAt: T0,
                updatedAt: T0,
              },
            ] as never),
        } satisfies ProjectionWorkspaceAgentRoleRepository["Service"]),
      ),
      Layer.provideMerge(
        Layer.succeed(WorkspaceProgramSupervisor, {
          start: () => Effect.void,
          drain: Effect.void,
          discover: () => Effect.succeed({ candidates: [] }),
        }),
      ),
      Layer.provideMerge(
        Layer.succeed(ResourceTelemetry, {
          latest: Effect.succeed(emptyTelemetry),
          changes: Stream.empty,
          subscribe: Effect.acquireRelease(
            Effect.sync(() => {
              state.subscribers += 1;
              return { latest: emptyTelemetry, changes: Stream.empty };
            }),
            () =>
              Effect.sync(() => {
                state.subscribers -= 1;
              }),
          ),
          readHistory: () => Effect.die("unused"),
          refresh: Effect.die("unused"),
          validateProcessIdentity: () => Effect.succeed(true),
          setMonitoredProcesses: (processes: typeof state.monitoredProcesses) =>
            Effect.sync(() => {
              state.monitoredProcesses = processes;
            }),
          retry: Effect.die("unused"),
        } as unknown as ResourceTelemetry["Service"]),
      ),
      Layer.provideMerge(
        Layer.succeed(OrchestrationTurnWait, {
          waitForSettledTurn: () =>
            Effect.gen(function* () {
              if (state.blockTurn) yield* Deferred.await(turnGate);
              return {
                turn: {
                  state: "completed",
                  turnId: "monitor-turn",
                  requestedAt: state.resultRequestedAt ?? state.requestedAt,
                  assistantMessageId: state.explicitAssistantMessageId,
                } as never,
                thread: {
                  messages: [
                    {
                      id: "m1",
                      role: "assistant",
                      turnId: state.currentAssistantOutput ? "monitor-turn" : "older-turn",
                      text: state.assistantOutput,
                    },
                  ],
                  session: null,
                } as unknown as OrchestrationThread,
              };
            }),
        }),
      ),
      Layer.provideMerge(
        Layer.succeed(ServerSettingsService, {
          runMonitoringAutoAction: (action: Effect.Effect<unknown, never, never>) =>
            Effect.suspend(() => {
              if (state.denyNextAutoAction) {
                state.denyNextAutoAction = false;
                return Effect.succeed(Option.none());
              }
              return input.allowAutoActions
                ? action.pipe(Effect.map(Option.some))
                : Effect.succeed(Option.none());
            }),
          getSettings: Effect.succeed({
            workspaceProgramPermissions: {
              manualControl: true,
              collectLogs: true,
              autoStart: false,
              autoDiagnosis: true,
              autoRestartAfterRepair: false,
              monitoringAutoActions: input.allowAutoActions ?? false,
            },
            selfMonitoring: { enabled: false, projectId: null },
          } as unknown as ServerSettings),
        } as unknown as ServerSettingsService["Service"]),
      ),
      Layer.provideMerge(
        Layer.succeed(VcsStatusBroadcaster, {
          getStatus: () => Effect.die("unused"),
          refreshLocalStatus: () =>
            Ref.get(vcsRef).pipe(
              Effect.flatMap((status) =>
                status === null ? Effect.die("no vcs status") : Effect.succeed(status),
              ),
            ),
          refreshStatus: () => Effect.die("unused"),
          streamStatus: () => Stream.empty,
        } as unknown as VcsStatusBroadcaster["Service"]),
      ),
      Layer.provideMerge(
        Layer.succeed(ProcessRunner.ProcessRunner, {
          run: (runInput: { readonly args: ReadonlyArray<string> }) =>
            Effect.sync(() => {
              processRuns.push(runInput.args.at(-1) ?? "");
              return {
                stdout: "",
                stderr: state.processExitCode === 0 ? "" : "1 test failed",
                code: state.processExitCode,
                timedOut: false,
                stdoutTruncated: false,
                stderrTruncated: false,
              };
            }),
        } as unknown as ProcessRunner.ProcessRunner["Service"]),
      ),
      Layer.provideMerge(Layer.succeed(HostProcessPlatform, "win32")),
      Layer.provideMerge(
        Layer.succeed(HttpClient.HttpClient, {
          execute: () =>
            Effect.sync(() => {
              state.httpCalls += 1;
              return {
                status: state.httpOk ? 200 : 503,
                stream: Stream.make(new Uint8Array()),
              };
            }),
        } as unknown as HttpClient.HttpClient),
      ),
      Layer.provideMerge(
        Layer.succeed(
          ServerSelfSignals,
          input.selfSignals ?? {
            recordSpan: () => undefined,
            read: () => {
              state.selfReads += 1;
              return { eventLoopP99Ms: 0, slowSpansPerMin: 0, failedSpansPerMin: 0 };
            },
            readRates: (windowMin) =>
              state.selfRatesByWindow.get(windowMin) ?? {
                slowSpansPerMin: 0,
                failedSpansPerMin: 0,
              },
          },
        ),
      ),
      // The reactor journals findings and cooldowns in SQLite.
      Layer.provideMerge(SqlitePersistenceMemory),
      Layer.provideMerge(NodeServices.layer),
    );

    return {
      layer,
      commands,
      processRuns,
      state,
      turnGate,
      patchMonitoring,
      setRun: (run: WorkspaceProgramRun) => Ref.set(runRef, run),
      setVcs: (status: VcsStatusLocalResult) => Ref.set(vcsRef, status),
      monitoring: () => Ref.get(projectRef).pipe(Effect.map((p) => p.workspaceControl.monitoring)),
      types: () => commands.map((command) => command.type),
    };
  });

const approvedPlan = (metrics: WorkspaceMonitoringPlan["metrics"]): WorkspaceMonitoringPlan => ({
  revision: 1,
  proposedAt: T0,
  approvedAt: T0,
  rationale: null,
  targets: [
    { kind: "program", label: "dev", programId },
    { kind: "url", label: "site", url: "http://127.0.0.1:9/health" },
  ],
  metrics,
  playbooks: [],
});

it.effect("suspends a missing workspace and resumes monitoring when its folder returns", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const parent = yield* fs.makeTempDirectoryScoped({ prefix: "t3-monitor-workspace-" });
    const root = path.join(parent, "삭제된 프로젝트");
    const h = yield* makeHarness({ workspaceRoot: root });
    yield* TestClock.setTime(Date.parse(T0));
    yield* Effect.gen(function* () {
      const reactor = yield* WorkspaceMonitoringReactor;
      yield* reactor.start();
      yield* reactor.tick;
      yield* reactor.drain;
      expect(h.types()).not.toContain("thread.turn.start");
      expect(h.types()).not.toContain("thread.create");
      yield* fs.makeDirectory(root);
      yield* TestClock.adjust("20 seconds");
      yield* reactor.tick;
      yield* TestClock.adjust("1 second");
      yield* reactor.drain;
      expect(h.types()).toContain("thread.turn.start");
    }).pipe(Effect.provide(h.layer));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("does not reuse an older assistant message as a new monitoring proposal", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness({});
    h.state.currentAssistantOutput = false;
    yield* TestClock.setTime(Date.parse(T0));
    yield* Effect.gen(function* () {
      const reactor = yield* WorkspaceMonitoringReactor;
      yield* reactor.start();
      yield* reactor.tick;
      yield* TestClock.adjust("1 second");
      yield* reactor.drain;
      expect(h.types()).not.toContain("project.monitoring.plan.propose");
      expect(
        h.commands.some(
          (command) =>
            command.type === "thread.activity.append" &&
            command.activity.kind === "monitoring.proposal.failed",
        ),
      ).toBe(true);
    }).pipe(Effect.provide(h.layer), Effect.scoped);
  }),
);

it.effect("does not start another proposal turn on later checks after one failed", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness({});
    h.state.currentAssistantOutput = false;
    yield* TestClock.setTime(Date.parse(T0));
    yield* Effect.gen(function* () {
      const reactor = yield* WorkspaceMonitoringReactor;
      yield* reactor.start();
      yield* reactor.tick;
      yield* TestClock.adjust("1 second");
      yield* reactor.drain;
      for (let check = 0; check < 3; check += 1) {
        yield* TestClock.adjust("2 hours");
        yield* reactor.tick;
        yield* TestClock.adjust("1 second");
        yield* reactor.drain;
      }
      expect(h.types().filter((type) => type === "thread.turn.start")).toHaveLength(1);
    }).pipe(Effect.provide(h.layer), Effect.scoped);
  }),
);

it.effect(
  "does not use a newer turn or mismatched assistant message as a monitoring proposal",
  () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({});
      h.state.resultRequestedAt = "2026-11-12T00:00:01.000Z";
      h.state.explicitAssistantMessageId = "m1";
      yield* TestClock.setTime(Date.parse(T0));
      yield* Effect.gen(function* () {
        const reactor = yield* WorkspaceMonitoringReactor;
        yield* reactor.start();
        yield* reactor.tick;
        yield* TestClock.adjust("1 second");
        yield* reactor.drain;
        expect(h.types()).not.toContain("project.monitoring.plan.propose");
      }).pipe(Effect.provide(h.layer), Effect.scoped);
    }),
);

it.effect("does not use an explicitly named assistant message from another turn", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness({});
    h.state.currentAssistantOutput = false;
    h.state.explicitAssistantMessageId = "m1";
    yield* TestClock.setTime(Date.parse(T0));
    yield* Effect.gen(function* () {
      const reactor = yield* WorkspaceMonitoringReactor;
      yield* reactor.start();
      yield* reactor.tick;
      yield* TestClock.adjust("1 second");
      yield* reactor.drain;
      expect(h.types()).not.toContain("project.monitoring.plan.propose");
    }).pipe(Effect.provide(h.layer), Effect.scoped);
  }),
);

it.effect("does not accept a different request created at the same timestamp", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness({});
    h.state.differentRequest = true;
    h.state.explicitAssistantMessageId = "m1";
    yield* TestClock.setTime(Date.parse(T0));
    yield* Effect.gen(function* () {
      const reactor = yield* WorkspaceMonitoringReactor;
      yield* reactor.start();
      yield* reactor.tick;
      yield* TestClock.adjust("1 second");
      yield* reactor.drain;
      expect(h.types()).not.toContain("project.monitoring.plan.propose");
    }).pipe(Effect.provide(h.layer), Effect.scoped);
  }),
);

it.effect("does not reset the self-server latency histogram for unrelated plans", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness({
      monitoring: { planStatus: "approved", plan: approvedPlan([]) },
    });
    yield* TestClock.setTime(Date.parse(T0));
    yield* Effect.gen(function* () {
      const reactor = yield* WorkspaceMonitoringReactor;
      yield* reactor.start();
      yield* reactor.tick;
      yield* TestClock.adjust("20 seconds");
      yield* reactor.tick;
      yield* reactor.drain;
      expect(h.state.selfReads).toBe(0);
    }).pipe(Effect.provide(h.layer), Effect.scoped);
  }),
);

it.effect("continues health probes while a diagnosis turn is still running", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness({
      monitoring: {
        planStatus: "approved",
        plan: approvedPlan([
          { targetIndex: 1, metric: "health", trend: "threshold", windowMin: 1, limit: 1 },
        ]),
      },
    });
    h.state.httpOk = false;
    h.state.blockTurn = true;
    yield* TestClock.setTime(Date.parse(T0));
    yield* Effect.gen(function* () {
      const reactor = yield* WorkspaceMonitoringReactor;
      yield* reactor.start();
      yield* reactor.tick;
      yield* TestClock.adjust("1 second");
      expect(h.types().filter((type) => type === "thread.turn.start")).toHaveLength(1);
      const firstProbes = h.state.httpCalls;
      yield* TestClock.adjust("20 seconds");
      yield* reactor.tick;
      expect(h.state.httpCalls).toBeGreaterThan(firstProbes);
      expect(h.types().filter((type) => type === "thread.turn.start")).toHaveLength(1);
    }).pipe(Effect.provide(h.layer), Effect.scoped);
  }),
);

it.effect(
  "reports an anomaly observed during diagnosis without acting on an expired condition",
  () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({
        allowAutoActions: true,
        monitoring: {
          autonomy: "playbooks",
          planStatus: "approved",
          aiTurnBudget: { perHour: 1, perDay: 10 },
          plan: {
            ...approvedPlan([
              { targetIndex: 0, metric: "health", trend: "threshold", windowMin: 1, limit: 1 },
              { targetIndex: 1, metric: "health", trend: "threshold", windowMin: 1, limit: 1 },
            ]),
            playbooks: [{ when: 0, action: "restart-program" }],
          },
        },
      });
      h.state.httpOk = false;
      h.state.blockTurn = true;
      yield* TestClock.setTime(Date.parse(T0));
      yield* Effect.gen(function* () {
        const reactor = yield* WorkspaceMonitoringReactor;
        yield* reactor.start();
        yield* reactor.tick;
        yield* TestClock.adjust("1 second");
        expect(h.types().filter((type) => type === "thread.turn.start")).toHaveLength(1);
        h.state.httpOk = true;
        yield* h.setRun(runWith(2));
        yield* TestClock.adjust("20 seconds");
        yield* reactor.tick;
        expect(h.types()).not.toContain("project.program.restart");
        yield* h.setRun(runWith(0));
        h.state.blockTurn = false;
        yield* Deferred.succeed(h.turnGate, undefined);
        yield* reactor.drain;
        yield* TestClock.adjust("20 seconds");
        yield* reactor.tick;
        yield* TestClock.adjust("1 second");
        yield* reactor.drain;
        expect(h.types().filter((type) => type === "thread.turn.start")).toHaveLength(1);
        yield* h.patchMonitoring({ turnLog: [] });
        yield* TestClock.adjust("20 seconds");
        yield* reactor.tick;
        yield* TestClock.adjust("1 second");
        yield* reactor.drain;
        const turns = h.commands.filter((command) => command.type === "thread.turn.start");
        expect(turns).toHaveLength(2);
        expect((turns[1] as { message: { text: string } }).message.text).toContain("이전에 관찰됨");
        expect(h.types()).not.toContain("project.program.restart");
      }).pipe(Effect.provide(h.layer), Effect.scoped);
    }),
);

it.effect("preserves a repeated anomaly that occurs during a long diagnosis", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness({
      monitoring: {
        planStatus: "approved",
        aiTurnBudget: { perHour: 5, perDay: 10 },
        plan: approvedPlan([
          { targetIndex: 1, metric: "health", trend: "threshold", windowMin: 1, limit: 1 },
        ]),
      },
    });
    h.state.httpOk = false;
    h.state.blockTurn = true;
    yield* TestClock.setTime(Date.parse(T0));
    yield* Effect.gen(function* () {
      const reactor = yield* WorkspaceMonitoringReactor;
      yield* reactor.start();
      yield* reactor.tick;
      yield* TestClock.adjust("1 second");
      h.state.httpOk = true;
      yield* TestClock.adjust("31 minutes");
      h.state.httpOk = false;
      yield* TestClock.adjust("20 seconds");
      yield* reactor.tick;
      h.state.httpOk = true;
      h.state.blockTurn = false;
      yield* Deferred.succeed(h.turnGate, undefined);
      yield* TestClock.adjust("1 second");
      yield* TestClock.adjust("20 seconds");
      yield* reactor.tick;
      yield* TestClock.adjust("1 second");
      yield* reactor.drain;
      const turns = h.commands.filter((command) => command.type === "thread.turn.start");
      expect(turns).toHaveLength(2);
      expect((turns[1] as { message: { text: string } }).message.text).toContain("이전에 관찰됨");
    }).pipe(Effect.provide(h.layer), Effect.scoped);
  }),
);

it.effect("does not carry deferred findings into a different plan with the same revision", () =>
  Effect.gen(function* () {
    const oldPlan = approvedPlan([
      { targetIndex: 0, metric: "health", trend: "threshold", windowMin: 1, limit: 1 },
      { targetIndex: 1, metric: "health", trend: "threshold", windowMin: 1, limit: 1 },
    ]);
    const h = yield* makeHarness({ monitoring: { planStatus: "approved", plan: oldPlan } });
    h.state.httpOk = false;
    h.state.blockTurn = true;
    yield* TestClock.setTime(Date.parse(T0));
    yield* Effect.gen(function* () {
      const reactor = yield* WorkspaceMonitoringReactor;
      yield* reactor.start();
      yield* reactor.tick;
      yield* TestClock.adjust("1 second");
      h.state.httpOk = true;
      yield* h.setRun(runWith(2));
      yield* TestClock.adjust("20 seconds");
      yield* reactor.tick;
      yield* h.setRun(runWith(0));
      yield* h.patchMonitoring({
        plan: {
          ...oldPlan,
          targets: [{ ...oldPlan.targets[0]!, label: "new" }, oldPlan.targets[1]!],
        },
      });
      yield* TestClock.adjust("20 seconds");
      yield* reactor.tick;
      h.state.blockTurn = false;
      yield* Deferred.succeed(h.turnGate, undefined);
      yield* TestClock.adjust("1 second");
      yield* TestClock.adjust("20 seconds");
      yield* reactor.tick;
      yield* TestClock.adjust("1 second");
      yield* reactor.drain;
      expect(h.types().filter((type) => type === "thread.turn.start")).toHaveLength(1);
    }).pipe(Effect.provide(h.layer), Effect.scoped);
  }),
);

it.effect("does not repeat an active diagnosis or playbook after monitoring is toggled", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness({
      allowAutoActions: true,
      monitoring: {
        autonomy: "playbooks",
        planStatus: "approved",
        plan: {
          ...approvedPlan([
            { targetIndex: 0, metric: "health", trend: "threshold", windowMin: 1, limit: 1 },
          ]),
          playbooks: [{ when: 0, action: "restart-program" }],
        },
      },
    });
    h.state.blockTurn = true;
    yield* TestClock.setTime(Date.parse(T0));
    yield* Effect.gen(function* () {
      const reactor = yield* WorkspaceMonitoringReactor;
      yield* reactor.start();
      yield* reactor.tick;
      yield* h.setRun(runWith(2));
      yield* TestClock.adjust("20 seconds");
      yield* reactor.tick;
      yield* TestClock.adjust("1 second");
      expect(h.types().filter((type) => type === "thread.turn.start")).toHaveLength(1);
      expect(h.types().filter((type) => type === "project.program.restart")).toHaveLength(1);
      yield* h.patchMonitoring({ enabled: false });
      yield* reactor.tick;
      yield* h.patchMonitoring({ enabled: true });
      yield* reactor.start();
      yield* TestClock.adjust("20 seconds");
      yield* reactor.tick;
      expect(h.types().filter((type) => type === "thread.turn.start")).toHaveLength(1);
      expect(h.types().filter((type) => type === "project.program.restart")).toHaveLength(1);
    }).pipe(Effect.provide(h.layer), Effect.scoped);
  }),
);

it.effect(
  "enable → one thread + one proposal; approve → findings report under budget; off → released",
  () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({});
      yield* TestClock.setTime(Date.parse(T0));
      yield* Effect.gen(function* () {
        const reactor = yield* WorkspaceMonitoringReactor;
        yield* reactor.start();

        // First tick: thread created, proposal turn started, plan parsed & proposed.
        yield* reactor.tick;
        yield* TestClock.adjust("1 second");
        yield* reactor.drain;
        expect(h.types().filter((type) => type === "thread.create")).toHaveLength(1);
        expect(h.types().filter((type) => type === "thread.turn.start")).toHaveLength(1);
        expect(h.types()).toContain("project.monitoring.plan.propose");
        expect(h.state.subscribers).toBe(1);
        expect((yield* h.monitoring()).threadId).not.toBeNull();

        // Proposed but not approved: another due tick must not start anything.
        yield* TestClock.adjust("20 seconds");
        yield* reactor.tick;
        expect(h.types().filter((type) => type === "thread.turn.start")).toHaveLength(1);

        // Approve; the program's health check is failing → one finding turn, logged.
        const proposed = (yield* h.monitoring()).plan;
        expect(proposed).not.toBeNull();
        yield* h.patchMonitoring({
          planStatus: "approved",
          plan: { ...proposed!, approvedAt: T0 },
        });
        yield* h.setRun(runWith(2));
        h.state.assistantOutput = "확인했습니다.";
        yield* TestClock.adjust("20 seconds");
        yield* reactor.tick;
        yield* TestClock.adjust("1 second");
        expect(h.types().filter((type) => type === "thread.turn.start")).toHaveLength(2);
        expect((yield* h.monitoring()).turnLog).toHaveLength(1);

        // Same anomaly inside its cooldown, and the hourly budget (1) is spent:
        // no third turn, held notice goes to the thread instead.
        yield* TestClock.adjust("20 seconds");
        yield* reactor.tick;
        expect(h.types().filter((type) => type === "thread.turn.start")).toHaveLength(2);

        // Switch off → the telemetry subscription is released on the next tick.
        yield* h.patchMonitoring({ enabled: false });
        yield* reactor.tick;
        yield* reactor.tick;
        expect(h.state.subscribers).toBe(0);
      }).pipe(Effect.provide(h.layer), Effect.scoped);
    }),
);

it.effect(
  "an approved plan's process targets are handed to the telemetry sidecar, and withdrawn when off",
  () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({
        monitoring: {
          planStatus: "approved",
          plan: {
            ...approvedPlan([]),
            targets: [
              { kind: "program", label: "dev", programId },
              { kind: "process", label: "worker", pid: 4_321, startTimeMs: 1_000 },
              { kind: "process", label: "unpinned" },
            ],
          },
        },
      });
      yield* TestClock.setTime(Date.parse(T0));
      yield* Effect.gen(function* () {
        const reactor = yield* WorkspaceMonitoringReactor;
        yield* reactor.start();
        yield* reactor.tick;
        // Only the target with a pid has something to follow.
        expect(h.state.monitoredProcesses).toEqual([{ pid: 4_321, startTimeMs: 1_000 }]);

        yield* h.patchMonitoring({ enabled: false });
        yield* reactor.tick;
        expect(h.state.monitoredProcesses).toEqual([]);
      }).pipe(Effect.provide(h.layer), Effect.scoped);
    }),
);

it.effect(
  "a code change runs the registered validation commands; a failure becomes a finding",
  () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({
        monitoring: {
          planStatus: "approved",
          aiTurnBudget: { perHour: 5, perDay: 10 },
          plan: approvedPlan([
            { targetIndex: 0, metric: "regression", trend: "threshold", windowMin: 5, limit: 1 },
          ]),
        },
        program: {
          ...program,
          integrity: {
            ...DEFAULT_WORKSPACE_PROGRAM_INTEGRITY,
            validationCommands: ["pnpm test", "pnpm typecheck"],
          },
        },
      });
      h.state.assistantOutput = "회귀입니다.";
      yield* TestClock.setTime(Date.parse(T0));
      yield* Effect.gen(function* () {
        const reactor = yield* WorkspaceMonitoringReactor;
        yield* reactor.start();

        // First poll only records the baseline fingerprint.
        yield* h.setVcs(vcsStatus([]));
        yield* reactor.tick;
        yield* TestClock.adjust("1 second");
        expect(h.processRuns).toHaveLength(0);

        // Unchanged tree a minute later: still nothing to run.
        yield* TestClock.adjust("61 seconds");
        yield* reactor.tick;
        yield* TestClock.adjust("1 second");
        expect(h.processRuns).toHaveLength(0);

        // The working tree changed and a validation command fails.
        yield* h.setVcs(vcsStatus(["src/app.ts"]));
        h.state.processExitCode = 1;
        yield* TestClock.adjust("61 seconds");
        yield* reactor.tick;
        yield* TestClock.adjust("1 second");
        expect(h.processRuns).toEqual(["pnpm test", "pnpm typecheck"]);
        const notices = h.commands.filter(
          (command) =>
            command.type === "thread.activity.append" &&
            command.activity.kind === "monitoring.regression.failed",
        );
        expect(notices).toHaveLength(1);

        // The next evaluation samples the failure count and reports it.
        yield* TestClock.adjust("20 seconds");
        yield* reactor.tick;
        yield* TestClock.adjust("1 second");
        const turnStarts = h.commands.filter((command) => command.type === "thread.turn.start");
        expect(turnStarts).toHaveLength(1);
        expect((turnStarts[0] as { message: { text: string } }).message.text).toContain(
          "1 test failed",
        );
      }).pipe(Effect.provide(h.layer), Effect.scoped);
    }),
);

it.effect(
  "a log target is tailed by the server: new matching lines become a finding with the lines quoted",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-monitor-log-" });
      const logPath = path.join(dir, "watcher.log");
      const append = (text: string) => fs.writeFileString(logPath, text, { flag: "a" });
      yield* fs.writeFileString(logPath, "old: database is locked\n");
      const h = yield* makeHarness({
        monitoring: {
          planStatus: "approved",
          aiTurnBudget: { perHour: 5, perDay: 10 },
          plan: {
            ...approvedPlan([
              { targetIndex: 0, metric: "log-matches", trend: "threshold", windowMin: 5, limit: 1 },
            ]),
            targets: [
              {
                kind: "log",
                label: "워처 로그",
                path: logPath,
                patterns: ["database is locked", "^!! "],
              },
            ],
          },
        },
      });
      h.state.assistantOutput = "잠금 오류입니다.";
      yield* TestClock.setTime(Date.parse(T0));
      yield* Effect.gen(function* () {
        const reactor = yield* WorkspaceMonitoringReactor;
        yield* reactor.start();

        // First sight only records the size: history is not replayed.
        yield* reactor.tick;
        yield* TestClock.adjust("1 second");
        expect(h.commands.filter((command) => command.type === "thread.turn.start")).toHaveLength(
          0,
        );

        // Quiet lines change nothing.
        yield* append("cycle ok\n");
        yield* TestClock.adjust("20 seconds");
        yield* reactor.tick;
        yield* TestClock.adjust("1 second");
        expect(h.commands.filter((command) => command.type === "thread.turn.start")).toHaveLength(
          0,
        );

        // Two matching lines land: the finding quotes them.
        yield* append("!! 21:05:10 앱 미응답(15초)\nwrite failed: database is locked\n");
        yield* TestClock.adjust("20 seconds");
        yield* reactor.tick;
        yield* TestClock.adjust("1 second");
        const turnStarts = h.commands.filter((command) => command.type === "thread.turn.start");
        expect(turnStarts).toHaveLength(1);
        const text = (turnStarts[0] as { message: { text: string } }).message.text;
        expect(text).toContain("워처 로그");
        expect(text).toContain("!! 21:05:10 앱 미응답(15초)");
        expect(text).toContain("write failed: database is locked");
        expect(text).not.toContain("old: database is locked");
      }).pipe(Effect.provide(h.layer), Effect.scoped);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "url targets are probed each evaluation; consecutive failures cross the health limit",
  () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({
        monitoring: {
          planStatus: "approved",
          aiTurnBudget: { perHour: 5, perDay: 10 },
          plan: approvedPlan([
            { targetIndex: 1, metric: "health", trend: "threshold", windowMin: 5, limit: 2 },
          ]),
        },
      });
      h.state.assistantOutput = "사이트가 내려갔습니다.";
      yield* TestClock.setTime(Date.parse(T0));
      yield* Effect.gen(function* () {
        const reactor = yield* WorkspaceMonitoringReactor;
        yield* reactor.start();

        yield* reactor.tick;
        yield* TestClock.adjust("1 second");
        expect(h.state.httpCalls).toBe(1);
        expect(h.types().filter((type) => type === "thread.turn.start")).toHaveLength(0);

        h.state.httpOk = false;
        yield* TestClock.adjust("20 seconds");
        yield* reactor.tick;
        yield* TestClock.adjust("1 second");
        // One failure: under the limit of 2.
        expect(h.types().filter((type) => type === "thread.turn.start")).toHaveLength(0);

        yield* TestClock.adjust("20 seconds");
        yield* reactor.tick;
        yield* TestClock.adjust("1 second");
        expect(h.state.httpCalls).toBe(3);
        expect(h.types().filter((type) => type === "thread.turn.start")).toHaveLength(1);
      }).pipe(Effect.provide(h.layer), Effect.scoped);
    }),
);

it.effect(
  "self-server failure rates use each metric window and do not apply to other targets",
  () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({
        monitoring: {
          planStatus: "approved",
          aiTurnBudget: { perHour: 5, perDay: 10 },
          plan: {
            ...approvedPlan([
              {
                targetIndex: 0,
                metric: "failed-spans",
                trend: "threshold",
                windowMin: 1,
                limit: 1,
              },
              { targetIndex: 0, metric: "slow-spans", trend: "threshold", windowMin: 5, limit: 1 },
              {
                targetIndex: 1,
                metric: "failed-spans",
                trend: "threshold",
                windowMin: 1,
                limit: 1,
              },
            ]),
            targets: [
              { kind: "self-server", label: "T3 서버" },
              { kind: "program", label: "다른 프로그램", programId },
            ],
          },
        },
      });
      h.state.assistantOutput = "실패를 확인했습니다.";
      yield* TestClock.setTime(Date.parse(T0));
      yield* Effect.gen(function* () {
        const reactor = yield* WorkspaceMonitoringReactor;
        yield* reactor.start();
        yield* reactor.tick;
        yield* TestClock.adjust("1 second");
        expect(h.types().filter((type) => type === "thread.turn.start")).toHaveLength(0);

        h.state.selfRatesByWindow.set(1, { failedSpansPerMin: 2, slowSpansPerMin: 3 });
        h.state.selfRatesByWindow.set(5, { failedSpansPerMin: 0.4, slowSpansPerMin: 0.6 });
        yield* TestClock.adjust("20 seconds");
        yield* reactor.tick;
        yield* TestClock.adjust("1 second");
        const starts = h.commands.filter((command) => command.type === "thread.turn.start");
        expect(starts).toHaveLength(1);
        const message = (starts[0] as { message: { text: string } }).message.text;
        expect(message).toContain("failed-spans");
        expect(message).not.toContain("slow-spans");
        expect(message).not.toContain("다른 프로그램");
      }).pipe(Effect.provide(h.layer), Effect.scoped);
    }),
);

it.effect("a real failed span reaches the configured self-server monitor", () =>
  Effect.gen(function* () {
    const signals = makeServerSelfSignals({
      histogram: { percentile: () => 0, reset: () => undefined } as never,
    });
    const readings: Array<{ windowMin: number; nowMs: number; failedSpansPerMin: number }> = [];
    const h = yield* makeHarness({
      selfSignals: {
        ...signals,
        readRates: (windowMin, nowMs) => {
          const result = signals.readRates(windowMin, nowMs);
          readings.push({ windowMin, nowMs, failedSpansPerMin: result.failedSpansPerMin });
          return result;
        },
      },
      monitoring: {
        planStatus: "approved",
        plan: {
          ...approvedPlan([
            { targetIndex: 0, metric: "failed-spans", trend: "threshold", windowMin: 1, limit: 1 },
          ]),
          targets: [{ kind: "self-server", label: "T3 서버" }],
        },
      },
    });
    h.state.assistantOutput = "실패 신호를 확인했습니다.";
    yield* TestClock.setTime(Date.parse(T0));
    yield* Effect.gen(function* () {
      const reactor = yield* WorkspaceMonitoringReactor;
      yield* reactor.start();
      yield* reactor.tick;
      yield* TestClock.adjust("20 seconds");
      signals.recordSpan({
        type: "effect-span",
        durationMs: 10,
        endTimeUnixNano: String(BigInt(Date.parse(T0) + 20_000) * 1_000_000n),
        exit: { _tag: "Failure", cause: "synthetic failure" },
      } as never);
      expect(signals.readRates(1, Date.parse(T0) + 20_000).failedSpansPerMin).toBe(1);
      yield* TestClock.adjust("20 seconds");
      yield* reactor.tick;
      yield* TestClock.adjust("1 second");
      yield* reactor.drain;
      expect(
        readings.some((reading) => reading.windowMin === 1 && reading.failedSpansPerMin === 1),
      ).toBe(true);
      const turns = h.commands.filter((command) => command.type === "thread.turn.start");
      expect(turns).toHaveLength(1);
      expect((turns[0] as { message: { text: string } }).message.text).toContain("failed-spans");
    }).pipe(Effect.provide(h.layer), Effect.scoped);
  }),
);

it.effect("an AI action block is recorded as a suggestion without executing a program", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness({
      monitoring: {
        autonomy: "ask",
        planStatus: "approved",
        plan: approvedPlan([
          { targetIndex: 0, metric: "health", trend: "threshold", windowMin: 1, limit: 1 },
        ]),
      },
    });
    h.state.assistantOutput = [
      WORKSPACE_MONITORING_ACTION_OPEN_MARKER,
      '[{"action":"restart-program","programId":"prog-dev"}]',
      WORKSPACE_MONITORING_ACTION_CLOSE_MARKER,
    ].join("\n");
    yield* TestClock.setTime(Date.parse(T0));
    yield* Effect.gen(function* () {
      const reactor = yield* WorkspaceMonitoringReactor;
      yield* reactor.start();
      yield* reactor.tick;
      yield* h.setRun(runWith(2));
      yield* TestClock.adjust("20 seconds");
      yield* reactor.tick;
      yield* TestClock.adjust("1 second");
      yield* reactor.drain;
      expect(h.types()).not.toContain("project.program.restart");
      expect(
        h.commands.some(
          (command) =>
            command.type === "thread.activity.append" &&
            command.activity.kind === "monitoring.action.suggested",
        ),
      ).toBe(true);
    }).pipe(Effect.provide(h.layer), Effect.scoped);
  }),
);

it.effect("an explicitly enabled monitoring playbook still runs when its condition fires", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness({
      allowAutoActions: true,
      monitoring: {
        autonomy: "playbooks",
        planStatus: "approved",
        plan: {
          ...approvedPlan([
            { targetIndex: 0, metric: "health", trend: "threshold", windowMin: 1, limit: 1 },
          ]),
          playbooks: [{ when: 0, action: "restart-program" }],
        },
      },
    });
    h.state.assistantOutput = "점검했습니다.";
    yield* TestClock.setTime(Date.parse(T0));
    yield* Effect.gen(function* () {
      const reactor = yield* WorkspaceMonitoringReactor;
      yield* reactor.start();
      yield* reactor.tick;
      yield* h.setRun(runWith(2));
      yield* TestClock.adjust("20 seconds");
      yield* reactor.tick;
      yield* TestClock.adjust("1 second");
      yield* reactor.drain;
      expect(h.types().filter((type) => type === "project.program.restart")).toHaveLength(1);
    }).pipe(Effect.provide(h.layer), Effect.scoped);
  }),
);

it.effect("runs an identical program playbook only once for simultaneous findings", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness({
      allowAutoActions: true,
      monitoring: {
        autonomy: "playbooks",
        planStatus: "approved",
        plan: {
          ...approvedPlan([
            { targetIndex: 0, metric: "health", trend: "threshold", windowMin: 1, limit: 1 },
            { targetIndex: 0, metric: "health", trend: "threshold", windowMin: 5, limit: 1 },
          ]),
          playbooks: [
            { when: 0, action: "restart-program" },
            { when: 1, action: "restart-program" },
          ],
        },
      },
    });
    yield* TestClock.setTime(Date.parse(T0));
    yield* Effect.gen(function* () {
      const reactor = yield* WorkspaceMonitoringReactor;
      yield* reactor.start();
      yield* reactor.tick;
      yield* h.setRun(runWith(2));
      yield* TestClock.adjust("20 seconds");
      yield* reactor.tick;
      yield* TestClock.adjust("1 second");
      yield* reactor.drain;
      expect(h.types().filter((type) => type === "project.program.restart")).toHaveLength(1);
    }).pipe(Effect.provide(h.layer), Effect.scoped);
  }),
);

for (const [scenario, attempts] of [
  ["transient", 2],
  ["plan-disabled", 1],
  ["rejected", 1],
  ["guard-denied", 1],
  ["interrupted", 1],
  ["persistent", 2],
] as const) {
  it.effect("retries only the failed stop with the same receipt ID: " + scenario, () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({
        allowAutoActions: true,
        monitoring: {
          autonomy: "playbooks",
          planStatus: "approved",
          plan: {
            ...approvedPlan([
              { targetIndex: 0, metric: "health", trend: "threshold", windowMin: 1, limit: 1 },
              { targetIndex: 0, metric: "health", trend: "threshold", windowMin: 5, limit: 1 },
            ]),
            playbooks: [
              { when: 0, action: "restart-program" },
              { when: 1, action: "stop-program" },
            ],
          },
        },
      });
      h.state.stopFailure = scenario;
      yield* TestClock.setTime(Date.parse(T0));
      yield* Effect.gen(function* () {
        const reactor = yield* WorkspaceMonitoringReactor;
        yield* reactor.start();
        yield* reactor.tick;
        yield* h.setRun(runWith(2));
        yield* TestClock.adjust("20 seconds");
        yield* reactor.tick;
        yield* TestClock.adjust("20 seconds");
        yield* reactor.tick;
        yield* TestClock.adjust("1 second");
        yield* reactor.drain;
        const stops = h.commands.filter((command) => command.type === "project.program.stop");
        expect(stops).toHaveLength(attempts);
        expect(stops.at(-1)).toEqual(stops[0]);
        expect(h.types().filter((type) => type === "project.program.restart")).toHaveLength(1);
      }).pipe(Effect.provide(h.layer), Effect.scoped);
    }),
  );
}

it.effect("a stale plan keeps observing without executing stale playbooks", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness({
      allowAutoActions: true,
      monitoring: {
        autonomy: "playbooks",
        planStatus: "stale",
        plan: {
          ...approvedPlan([
            { targetIndex: 0, metric: "health", trend: "threshold", windowMin: 1, limit: 1 },
          ]),
          playbooks: [{ when: 0, action: "restart-program" }],
        },
      },
    });
    h.state.assistantOutput = "상태를 확인했습니다.";
    yield* TestClock.setTime(Date.parse(T0));
    yield* Effect.gen(function* () {
      const reactor = yield* WorkspaceMonitoringReactor;
      yield* reactor.start();
      yield* reactor.tick;
      yield* h.setRun(runWith(2));
      yield* TestClock.adjust("20 seconds");
      yield* reactor.tick;
      yield* TestClock.adjust("1 second");
      yield* reactor.drain;
      expect(h.types().filter((type) => type === "thread.turn.start")).toHaveLength(1);
      expect(h.types()).not.toContain("project.program.restart");
      expect((yield* h.monitoring()).autonomy).toBe("playbooks");
    }).pipe(Effect.provide(h.layer), Effect.scoped);
  }),
);
