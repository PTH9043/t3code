import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DEFAULT_WORKSPACE_CONTROL_SETTINGS,
  DEFAULT_WORKSPACE_MONITORING_SETTINGS,
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
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient } from "effect/unstable/http";
import { expect, it } from "@effect/vitest";

import { ServerSelfSignals } from "../../diagnostics/ServerSelfSignals.ts";
import type { ProjectionProject } from "../../persistence/Services/ProjectionProjects.ts";
import { ProjectionProjectRepository } from "../../persistence/Services/ProjectionProjects.ts";
import { ProjectionWorkspaceAgentRoleRepository } from "../../persistence/Services/ProjectionWorkspaceAgentRoles.ts";
import { ProjectionWorkspaceProgramRepository } from "../../persistence/Services/ProjectionWorkspacePrograms.ts";
import * as ProcessRunner from "../../processRunner.ts";
import { ResourceTelemetry } from "../../resourceTelemetry/ResourceTelemetry.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { VcsStatusBroadcaster } from "../../vcs/VcsStatusBroadcaster.ts";
import {
  WORKSPACE_MONITORING_PLAN_CLOSE_MARKER,
  WORKSPACE_MONITORING_PLAN_OPEN_MARKER,
} from "../workspaceMonitoring.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import { OrchestrationTurnWait } from "../Services/OrchestrationTurnWait.ts";
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
  readonly monitoring?: Partial<WorkspaceMonitoringSettings>;
  readonly program?: WorkspaceProgram;
}) =>
  Effect.gen(function* () {
    const projectRef = yield* Ref.make<ProjectionProject>({
      projectId,
      title: "Workspace A",
      workspaceRoot: "D:/workspace-a",
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
    const vcsRef = yield* Ref.make<VcsStatusLocalResult | null>(null);
    const commands: OrchestrationCommand[] = [];
    const processRuns: string[] = [];
    const state = {
      assistantOutput: planOutput,
      subscribers: 0,
      monitoredProcesses: [] as ReadonlyArray<{
        readonly pid: number;
        readonly startTimeMs?: number;
      }>,
      processExitCode: 0,
      httpOk: true,
      httpCalls: 0,
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
          switch (command.type) {
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
            Effect.succeed({
              turn: { state: "completed", assistantMessageId: null } as never,
              thread: {
                messages: [{ id: "m1", role: "assistant", text: state.assistantOutput }],
                session: null,
              } as unknown as OrchestrationThread,
            }),
        }),
      ),
      Layer.provideMerge(
        Layer.succeed(ServerSettingsService, {
          getSettings: Effect.succeed({
            workspaceProgramPermissions: {
              manualControl: true,
              collectLogs: true,
              autoStart: false,
              autoDiagnosis: true,
              autoRestartAfterRepair: false,
              monitoringAutoActions: false,
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
        Layer.succeed(ServerSelfSignals, {
          recordSpan: () => undefined,
          read: () => ({ eventLoopP99Ms: 0, slowSpansPerMin: 0, failedSpansPerMin: 0 }),
        }),
      ),
      Layer.provideMerge(NodeServices.layer),
    );

    return {
      layer,
      commands,
      processRuns,
      state,
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
        yield* h.patchMonitoring({ planStatus: "approved" });
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
