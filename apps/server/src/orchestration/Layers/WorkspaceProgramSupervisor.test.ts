import {
  CommandId,
  DEFAULT_WORKSPACE_PROGRAM_HUB_MEMORY,
  DEFAULT_WORKSPACE_PROGRAM_INTEGRITY,
  EventId,
  ProjectId,
  ProviderInstanceId,
  WorkspaceProgramId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type WorkspaceProgram,
  type WorkspaceTaskGraph,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { expect, it } from "@effect/vitest";

import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import { ProjectionWorkspaceAgentRoleRepository } from "../../persistence/Services/ProjectionWorkspaceAgentRoles.ts";
import { ProjectionWorkspaceCollaborationRunRepository } from "../../persistence/Services/ProjectionWorkspaceCollaborationRuns.ts";
import { ProjectionWorkspaceProgramRepository } from "../../persistence/Services/ProjectionWorkspacePrograms.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import * as PtyAdapter from "../../terminal/PtyAdapter.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { OrchestrationTurnWaitLive } from "./OrchestrationTurnWait.ts";
import { WorkspaceProgramSupervisor } from "../Services/WorkspaceProgramSupervisor.ts";
import {
  classifyHealthFailure,
  isWorkspaceRepairRunApproved,
  makeWorkspaceProgramSupervisor,
  WorkspaceHealthCheckError,
} from "./WorkspaceProgramSupervisor.ts";
import {
  buildInitialWorkspaceTaskGraph,
  materializeWorkspaceTaskGraphPlan,
  parseWorkspaceTaskGraphProposal,
} from "../workspaceTaskGraph.ts";

const at = "2026-08-09T00:00:00.000Z";

function programFixture(projectId: ProjectId, programId: WorkspaceProgramId): WorkspaceProgram {
  return {
    id: programId,
    projectId,
    name: "개발 서버",
    command: "npm run dev",
    relativeDirectory: "apps/web",
    environmentVariableNames: [],
    startPolicy: "manual",
    healthCheck: null,
    errorPatterns: [],
    enabled: true,
    integrity: DEFAULT_WORKSPACE_PROGRAM_INTEGRITY,
    hubMemory: DEFAULT_WORKSPACE_PROGRAM_HUB_MEMORY,
    createdAt: at,
    updatedAt: at,
  };
}

function verifiedRepairGraph(): WorkspaceTaskGraph {
  const initial = buildInitialWorkspaceTaskGraph("오류 수정");
  const planned = {
    ...initial,
    nodes: initial.nodes.map((node) => ({
      ...node,
      status: "completed" as const,
      output: "계획",
    })),
  };
  const proposal = parseWorkspaceTaskGraphProposal(
    `<t3_task_graph>${JSON.stringify({
      summary: "수정 계획",
      nextAction: "수정",
      nodes: [
        {
          id: "repair",
          kind: "implementation",
          agent: "codex",
          title: "오류 수정",
          task: "오류를 수정한다.",
          goal: "프로그램 복구",
          context: "사건 로그",
          input: "오류 재현",
          constraints: [],
          expectedOutput: "검증된 수정",
          successCriteria: ["집중 테스트 통과"],
          dependsOn: [],
          priority: 1,
        },
      ],
    })}</t3_task_graph>`,
  );
  const graph = materializeWorkspaceTaskGraphPlan({
    graph: planned,
    proposal,
    bindings: [
      {
        projectId: ProjectId.make("workspace-repair"),
        role: "coordinator",
        displayName: "Fable",
        modelSelection: {
          instanceId: ProviderInstanceId.make("fable"),
          model: "fable-model",
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        instructions: "",
        enabled: true,
        updatedAt: at,
      },
      {
        projectId: ProjectId.make("workspace-repair"),
        role: "implementer",
        displayName: "Codex",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "codex-model",
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        instructions: "",
        enabled: true,
        updatedAt: at,
      },
    ],
    occurredAt: at,
  });
  return {
    ...graph,
    status: "completed",
    overallConfidence: "high",
    repairApproved: true,
    nodes: graph.nodes.map((node) => {
      if (node.id === "repair") return { ...node, status: "completed" as const };
      if (node.kind !== "validation" || node.validationTargetId === null) return node;
      return {
        ...node,
        status: "completed" as const,
        confidence: "high" as const,
        validation: {
          targetNodeId: node.validationTargetId,
          verdict: "pass" as const,
          confidence: "high" as const,
          summary: "검증 통과",
          evidence: ["집중 테스트 통과"],
          failureClassification: null,
          nextAction: "재시작 가능",
          recordedAt: at,
        },
      };
    }),
  };
}

it("requires typed non-low validation before an incident repair can restart", () => {
  const approved = verifiedRepairGraph();
  expect(isWorkspaceRepairRunApproved({ graph: approved, finalOutput: "완료" })).toBe(true);
  expect(
    isWorkspaceRepairRunApproved({
      graph: { ...approved, overallConfidence: "low" },
      finalOutput: "[T3_RESTART_APPROVED]",
    }),
  ).toBe(false);
  expect(
    isWorkspaceRepairRunApproved({
      graph: {
        ...approved,
        nodes: approved.nodes.map((node) =>
          node.id === "repair" ? { ...node, status: "failed" as const } : node,
        ),
      },
      finalOutput: "[T3_RESTART_APPROVED]",
    }),
  ).toBe(false);
  expect(isWorkspaceRepairRunApproved({ graph: null, finalOutput: "[T3_RESTART_APPROVED]" })).toBe(
    true,
  );
});

function event(
  type:
    | "project.program-start-requested"
    | "project.program-stop-requested"
    | "project.program-restart-requested",
  projectId: ProjectId,
  programId: WorkspaceProgramId,
  sequence: number,
): OrchestrationEvent {
  return {
    sequence,
    eventId: EventId.make(`event-${sequence}`),
    aggregateKind: "project",
    aggregateId: projectId,
    occurredAt: at,
    commandId: CommandId.make(`command-${sequence}`),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type,
    payload: { projectId, programId, requestedAt: at },
  };
}

type RunUpdateCommand = Extract<OrchestrationCommand, { type: "project.program.run.update" }>;

/**
 * Waits for the supervisor to report a run status. Each dispatched command is a receipt, so
 * consuming until the expected one arrives beats sleeping for the worker.
 */
const takeRunUpdate = (
  dispatched: Queue.Queue<OrchestrationCommand>,
  status: RunUpdateCommand["run"]["status"],
): Effect.Effect<RunUpdateCommand> =>
  Queue.take(dispatched).pipe(
    Effect.flatMap((command) =>
      command.type === "project.program.run.update" && command.run.status === status
        ? Effect.succeed(command)
        : takeRunUpdate(dispatched, status),
    ),
  );

/**
 * Wires the supervisor against fakes for one project holding one program — the shape both
 * stop-path tests need, differing only in how their fake process answers a signal.
 */
function supervisorHarness(input: {
  readonly projectId: ProjectId;
  readonly programId: WorkspaceProgramId;
  readonly program: WorkspaceProgram;
  readonly process: PtyAdapter.PtyProcess;
  readonly events: Queue.Queue<OrchestrationEvent>;
  readonly dispatched: Queue.Queue<OrchestrationCommand>;
  readonly onSpawn: (spawnInput: PtyAdapter.PtySpawnInput) => void;
  readonly onDispatch?: (command: OrchestrationCommand) => void;
  /** Extra programs of the same project (hub concurrency tests). */
  readonly siblings?: ReadonlyArray<WorkspaceProgram>;
  readonly programs?: () => ReadonlyArray<WorkspaceProgram>;
  /** Per-spawn process factory; defaults to the single `process`. */
  readonly processFor?: (spawnInput: PtyAdapter.PtySpawnInput) => PtyAdapter.PtyProcess;
}) {
  const { projectId, program, events, dispatched } = input;
  const programs = input.programs ?? (() => [program, ...(input.siblings ?? [])]);
  const unused = Effect.never;
  const base = Layer.mergeAll(
    NodeServices.layer,
    NodeHttpClient.layerFetch,
    Layer.succeed(HostProcessPlatform, "win32"),
    Layer.succeed(OrchestrationEngineService, {
      readEvents: () => Stream.empty,
      dispatch: (command) =>
        Effect.sync(() => input.onDispatch?.(command)).pipe(
          Effect.andThen(Queue.offer(dispatched, command)),
          Effect.as({ sequence: 1 }),
        ),
      streamDomainEvents: Stream.fromQueue(events),
      latestSequence: Effect.succeed(0),
    }),
    Layer.succeed(ProjectionSnapshotQuery, {
      getCommandReadModel: () => unused,
      getSnapshot: () => unused,
      getShellSnapshot: () => unused,
      getArchivedShellSnapshot: () => unused,
      searchThreads: () => unused,
      getSnapshotSequence: () => unused,
      getCounts: () => unused,
      getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
      getProjectShellById: (requestedProjectId) =>
        Effect.succeed(
          requestedProjectId === projectId
            ? Option.some({
                id: projectId,
                title: "Supervisor Workspace",
                workspaceRoot: "D:/workspace-supervisor",
                defaultModelSelection: null,
                scripts: [],
                createdAt: at,
                updatedAt: at,
              })
            : Option.none(),
        ),
      getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
      getThreadCheckpointContext: () => Effect.succeed(Option.none()),
      getFullThreadDiffContext: () => Effect.succeed(Option.none()),
      getThreadShellById: () => Effect.succeed(Option.none()),
      getThreadRuntimeContext: () => Effect.die("unused runtime context"),
      getThreadDetailById: () => Effect.succeed(Option.none()),
      getThreadDetailSnapshot: () => Effect.succeed(Option.none()),
    }),
    Layer.succeed(ProjectionWorkspaceProgramRepository, {
      upsertProgram: () => Effect.void,
      removeProgram: () => Effect.void,
      removeByProjectId: () => Effect.void,
      getProgram: (input) => {
        const found =
          input.projectId === projectId
            ? programs().find((candidate) => candidate.id === input.programId)
            : undefined;
        return Effect.succeed(found === undefined ? Option.none() : Option.some(found));
      },
      listPrograms: () => Effect.sync(programs),
      listAutoStartPrograms: () => Effect.succeed([]),
      updateIntegrity: () => Effect.void,
      listIntegrityPrograms: () => Effect.succeed([]),
      upsertRun: () => Effect.void,
      listRuns: () => Effect.succeed([]),
      listActiveRuns: () => Effect.succeed([]),
      upsertIncident: () => Effect.void,
      getIncident: () => Effect.succeed(Option.none()),
      findOpenIncidentByFingerprint: () => Effect.succeed(Option.none()),
      listIncidents: () => Effect.succeed([]),
      listRecoverableIncidents: () => Effect.succeed([]),
    }),
    Layer.succeed(ProjectionWorkspaceAgentRoleRepository, {
      upsert: () => Effect.void,
      remove: () => Effect.void,
      listByProjectId: () => Effect.succeed([]),
    }),
    Layer.succeed(ProjectionWorkspaceCollaborationRunRepository, {
      upsert: () => Effect.void,
      requestCancel: () => Effect.void,
      recordAnswer: () => Effect.void,
      recordInterjection: () => Effect.void,
      recordControl: () => Effect.void,
      recordReview: () => Effect.void,
      requestVerification: () => Effect.void,
      getById: () => Effect.succeed(Option.none()),
      list: () => Effect.succeed([]),
      listResumable: () => Effect.succeed([]),
    }),
    ServerSettingsService.layerTest({
      workspaceProgramPermissions: {
        manualControl: true,
        collectLogs: true,
        autoStart: false,
        autoDiagnosis: false,
        autoRestartAfterRepair: false,
        monitoringAutoActions: false,
      },
    }),
    Layer.succeed(PtyAdapter.PtyAdapter, {
      spawn: (spawnInput) =>
        Effect.sync(() => {
          input.onSpawn(spawnInput);
          return input.processFor?.(spawnInput) ?? input.process;
        }),
    }),
  );
  return Layer.effect(WorkspaceProgramSupervisor, makeWorkspaceProgramSupervisor).pipe(
    Layer.provide(OrchestrationTurnWaitLive),
    Layer.provide(
      Layer.mergeAll(
        base,
        Layer.succeed(ProjectionTurnRepository, {
          getByTurnId: () => Effect.succeed(Option.none()),
        } as unknown as ProjectionTurnRepository["Service"]),
      ),
    ),
  );
}

it.effect("starts and stops only the PTY process created for the requested Workspace program", () =>
  Effect.gen(function* () {
    const projectId = ProjectId.make("workspace-supervisor");
    const programId = WorkspaceProgramId.make("dev-server");
    const program = programFixture(projectId, programId);
    const events = yield* Queue.unbounded<OrchestrationEvent>();
    const dispatched = yield* Queue.unbounded<OrchestrationCommand>();
    let spawnInput: PtyAdapter.PtySpawnInput | undefined;
    let exitListener: ((exit: PtyAdapter.PtyExitEvent) => void) | undefined;
    let killCount = 0;
    const fakeProcess: PtyAdapter.PtyProcess = {
      pid: 4321,
      write: () => undefined,
      resize: () => undefined,
      kill: () => {
        killCount += 1;
        exitListener?.({ exitCode: 0, signal: null });
      },
      onData: () => () => undefined,
      onExit: (listener) => {
        exitListener = listener;
        return () => {
          if (exitListener === listener) exitListener = undefined;
        };
      },
    };

    yield* Effect.gen(function* () {
      const supervisor = yield* WorkspaceProgramSupervisor;
      yield* supervisor.start();
      yield* Queue.offer(events, event("project.program-start-requested", projectId, programId, 1));

      const runningCommand = yield* takeRunUpdate(dispatched, "running");
      expect(runningCommand.run.pid).toBe(4321);
      expect(spawnInput?.shell.toLowerCase()).toMatch(/cmd\.exe$/);
      expect(spawnInput).toMatchObject({
        useConptyDll: true,
        args: ["/d", "/s", "/c", "npm run dev"],
        cwd: "D:\\workspace-supervisor\\apps\\web",
      });

      yield* Queue.offer(events, event("project.program-stop-requested", projectId, programId, 2));
      const exitedCommand = yield* takeRunUpdate(dispatched, "exited");
      expect(killCount).toBe(1);
      expect(exitedCommand.run).toMatchObject({ pid: null, exitCode: 0, exitSignal: null });
    }).pipe(
      Effect.provide(
        supervisorHarness({
          projectId,
          programId,
          program,
          process: fakeProcess,
          events,
          dispatched,
          onSpawn: (input) => {
            spawnInput = input;
          },
        }),
      ),
      Effect.scoped,
    );
  }),
);

it.effect("flushes a quiet startup log after the write interval without another output event", () =>
  Effect.gen(function* () {
    const projectId = ProjectId.make("quiet-startup");
    const programId = WorkspaceProgramId.make("probe");
    const program = programFixture(projectId, programId);
    const events = yield* Queue.unbounded<OrchestrationEvent>();
    const dispatched = yield* Queue.unbounded<OrchestrationCommand>();
    const fake = fakeProcessWithPid(4322);
    let onData: ((data: string) => void) | undefined;
    yield* Effect.gen(function* () {
      const supervisor = yield* WorkspaceProgramSupervisor;
      yield* supervisor.start();
      yield* Queue.offer(events, event("project.program-start-requested", projectId, programId, 1));
      yield* takeRunUpdate(dispatched, "running");
      onData?.("HUB_NATIVE_");
      onData?.("READY\n");
      yield* supervisor.drain;
      yield* TestClock.adjust(Duration.seconds(1));
      const flushed = yield* takeRunUpdate(dispatched, "running");
      expect(flushed.run.recentLogTail).toBe("HUB_NATIVE_READY\n");
    }).pipe(
      Effect.provide(
        supervisorHarness({
          projectId,
          programId,
          program,
          events,
          dispatched,
          onSpawn: () => undefined,
          process: {
            ...fake.process,
            onData: (listener) => {
              onData = listener;
              return () => {
                onData = undefined;
              };
            },
          },
        }),
      ),
      Effect.scoped,
    );
  }),
);

function fakeProcessWithPid(pid: number): {
  readonly process: PtyAdapter.PtyProcess;
  readonly exit: (event: PtyAdapter.PtyExitEvent) => void;
} {
  let exitListener: ((exit: PtyAdapter.PtyExitEvent) => void) | undefined;
  return {
    process: {
      pid,
      write: () => undefined,
      resize: () => undefined,
      kill: () => exitListener?.({ exitCode: 0, signal: null }),
      onData: () => () => undefined,
      onExit: (listener) => {
        exitListener = listener;
        return () => {
          if (exitListener === listener) exitListener = undefined;
        };
      },
    },
    exit: (event) => exitListener?.(event),
  };
}

it.effect(
  "wraps a program with a commit cap in the Windows job guard and publishes its shared datasets",
  () =>
    Effect.gen(function* () {
      const projectId = ProjectId.make("hub-guarded");
      const programId = WorkspaceProgramId.make("research");
      const program: WorkspaceProgram = {
        ...programFixture(projectId, programId),
        command: "python -X utf8 research.py --resume",
        hubMemory: {
          commitLimitMb: 3072,
          concurrencyGroup: null,
          concurrencySlots: null,
          sharedDatasets: [{ name: "WALLET_EVENTS", relativeSource: "data/wallet_events.jsonl" }],
        },
      };
      const events = yield* Queue.unbounded<OrchestrationEvent>();
      const dispatched = yield* Queue.unbounded<OrchestrationCommand>();
      let spawnInput: PtyAdapter.PtySpawnInput | undefined;
      const fake = fakeProcessWithPid(77);

      yield* Effect.gen(function* () {
        const supervisor = yield* WorkspaceProgramSupervisor;
        yield* supervisor.start();
        yield* Queue.offer(
          events,
          event("project.program-start-requested", projectId, programId, 1),
        );
        yield* takeRunUpdate(dispatched, "running");
        expect(spawnInput?.shell.toLowerCase()).toMatch(/t3-hub-guard\.exe$/);
        expect(spawnInput?.args).toEqual([]);
        expect(spawnInput?.env).toMatchObject({
          T3_HUB_GUARDED_COMMAND: "python -X utf8 research.py --resume",
          T3_HUB_MEMORY_HARD_CAP_MB: "3072",
        });
        expect(spawnInput?.env?.T3_HUB_DATASET_WALLET_EVENTS?.replaceAll("\\", "/")).toBe(
          "D:/workspace-supervisor/data/wallet_events.jsonl",
        );
        expect(spawnInput?.env?.T3_HUB_MANIFEST).toContain('"commitLimitMb":3072');
      }).pipe(
        Effect.provide(
          supervisorHarness({
            projectId,
            programId,
            program,
            process: fake.process,
            events,
            dispatched,
            onSpawn: (input) => {
              spawnInput = input;
            },
          }),
        ),
        Effect.scoped,
      );
    }),
);

it.effect("queues a program behind its hub concurrency slots until a sibling exits", () =>
  Effect.gen(function* () {
    const projectId = ProjectId.make("hub-slots");
    const firstId = WorkspaceProgramId.make("research-a");
    const secondId = WorkspaceProgramId.make("research-b");
    const budget = {
      commitLimitMb: null,
      concurrencyGroup: "research",
      concurrencySlots: 1,
      sharedDatasets: [],
    } as const;
    const first: WorkspaceProgram = { ...programFixture(projectId, firstId), hubMemory: budget };
    const second: WorkspaceProgram = {
      ...programFixture(projectId, secondId),
      command: "npm run research-b",
      hubMemory: budget,
    };
    const events = yield* Queue.unbounded<OrchestrationEvent>();
    const dispatched = yield* Queue.unbounded<OrchestrationCommand>();
    const spawnedCommands: string[] = [];
    const fakes = [fakeProcessWithPid(1), fakeProcessWithPid(2)];

    yield* Effect.gen(function* () {
      const supervisor = yield* WorkspaceProgramSupervisor;
      yield* supervisor.start();
      yield* Queue.offer(events, event("project.program-start-requested", projectId, firstId, 1));
      const firstRunning = yield* takeRunUpdate(dispatched, "running");
      expect(firstRunning.run.programId).toBe(firstId);
      yield* Queue.offer(events, event("project.program-start-requested", projectId, secondId, 2));
      const waiting = yield* takeRunUpdate(dispatched, "starting");
      expect(waiting.run).toMatchObject({ programId: secondId, pid: null });
      expect(spawnedCommands).toEqual(["npm run dev"]);

      yield* Queue.offer(events, event("project.program-stop-requested", projectId, firstId, 3));
      yield* takeRunUpdate(dispatched, "exited");
      const secondRunning = yield* takeRunUpdate(dispatched, "running");
      expect(secondRunning.run.programId).toBe(secondId);
      expect(spawnedCommands).toEqual(["npm run dev", "npm run research-b"]);
    }).pipe(
      Effect.provide(
        supervisorHarness({
          projectId,
          programId: firstId,
          program: first,
          siblings: [second],
          process: fakes[0]!.process,
          processFor: () => fakes[spawnedCommands.length - 1]!.process,
          events,
          dispatched,
          onSpawn: (input) => {
            const args = input.args ?? [];
            spawnedCommands.push(args[args.length - 1] ?? "");
          },
        }),
      ),
      Effect.scoped,
    );
  }),
);

it.effect("treats exit 75 from a grouped program as a hub yield and starts it again later", () =>
  Effect.gen(function* () {
    const projectId = ProjectId.make("hub-yield");
    const programId = WorkspaceProgramId.make("research");
    const program: WorkspaceProgram = {
      ...programFixture(projectId, programId),
      hubMemory: {
        commitLimitMb: null,
        concurrencyGroup: "research",
        concurrencySlots: 2,
        sharedDatasets: [],
      },
    };
    const events = yield* Queue.unbounded<OrchestrationEvent>();
    const dispatched = yield* Queue.unbounded<OrchestrationCommand>();
    const fakes = [fakeProcessWithPid(11), fakeProcessWithPid(12)];
    let spawnCount = 0;
    const incidents: OrchestrationCommand[] = [];

    yield* Effect.gen(function* () {
      const supervisor = yield* WorkspaceProgramSupervisor;
      yield* supervisor.start();
      yield* Queue.offer(events, event("project.program-start-requested", projectId, programId, 1));
      const running = yield* takeRunUpdate(dispatched, "running");
      expect(running.run.pid).toBe(11);
      fakes[0]!.exit({ exitCode: 75, signal: null });
      const exited = yield* takeRunUpdate(dispatched, "exited");
      expect(exited.run).toMatchObject({ exitCode: 75, status: "exited" });
      expect(incidents).toEqual([]);
      yield* TestClock.adjust(Duration.seconds(61));
      const restarted = yield* takeRunUpdate(dispatched, "running");
      expect(restarted.run.pid).toBe(12);
      expect(spawnCount).toBe(2);
    }).pipe(
      Effect.provide(
        supervisorHarness({
          projectId,
          programId,
          program,
          process: fakes[0]!.process,
          processFor: () => fakes[spawnCount - 1]!.process,
          events,
          dispatched,
          onSpawn: () => {
            spawnCount += 1;
          },
          onDispatch: (command) => {
            if (command.type === "project.program.incident.upsert") incidents.push(command);
          },
        }),
      ),
      Effect.scoped,
    );
  }),
);

for (const action of ["stop", "disable", "remove"] as const) {
  it.effect(`cancels a yielded program's pending restart on ${action}`, () =>
    Effect.gen(function* () {
      const projectId = ProjectId.make(`hub-cancel-${action}`);
      const programId = WorkspaceProgramId.make("research");
      const program: WorkspaceProgram = {
        ...programFixture(projectId, programId),
        hubMemory: {
          ...DEFAULT_WORKSPACE_PROGRAM_HUB_MEMORY,
          concurrencyGroup: "research",
          concurrencySlots: 1,
        },
      };
      let definitions: ReadonlyArray<WorkspaceProgram> = [program];
      const events = yield* Queue.unbounded<OrchestrationEvent>();
      const dispatched = yield* Queue.unbounded<OrchestrationCommand>();
      const fake = fakeProcessWithPid(101);
      let spawns = 0;
      yield* Effect.gen(function* () {
        const supervisor = yield* WorkspaceProgramSupervisor;
        yield* supervisor.start();
        yield* Queue.offer(
          events,
          event("project.program-start-requested", projectId, programId, 1),
        );
        yield* takeRunUpdate(dispatched, "running");
        fake.exit({ exitCode: 75, signal: null });
        yield* takeRunUpdate(dispatched, "exited");
        const waiting = yield* takeRunUpdate(dispatched, "starting");
        expect(waiting.run.recentLogTail).toContain("60초");
        if (action === "disable") {
          definitions = [{ ...program, enabled: false }];
          yield* Queue.offer(events, {
            ...event("project.program-start-requested", projectId, programId, 2),
            type: "project.program-upserted",
            payload: { program: definitions[0]! },
          });
        } else if (action === "remove") {
          definitions = [];
          yield* Queue.offer(events, {
            ...event("project.program-stop-requested", projectId, programId, 2),
            type: "project.program-removed",
            payload: { projectId, programId, removedAt: at },
          });
        } else {
          yield* Queue.offer(
            events,
            event("project.program-stop-requested", projectId, programId, 2),
          );
        }
        if (action !== "remove") yield* takeRunUpdate(dispatched, "exited");
        yield* TestClock.adjust(Duration.seconds(61));
        yield* supervisor.drain;
        expect(spawns).toBe(1);
      }).pipe(
        Effect.provide(
          supervisorHarness({
            projectId,
            programId,
            program,
            programs: () => definitions,
            process: fake.process,
            events,
            dispatched,
            onSpawn: () => {
              spawns += 1;
            },
          }),
        ),
        Effect.scoped,
      );
    }),
  );
}

it.effect("restarts after the old process exit has been processed", () =>
  Effect.gen(function* () {
    const projectId = ProjectId.make("hub-restart");
    const programId = WorkspaceProgramId.make("research");
    const program = programFixture(projectId, programId);
    const events = yield* Queue.unbounded<OrchestrationEvent>();
    const dispatched = yield* Queue.unbounded<OrchestrationCommand>();
    const fakes = [fakeProcessWithPid(111), fakeProcessWithPid(112)];
    let spawns = 0;
    yield* Effect.gen(function* () {
      const supervisor = yield* WorkspaceProgramSupervisor;
      yield* supervisor.start();
      yield* Queue.offer(events, event("project.program-start-requested", projectId, programId, 1));
      yield* takeRunUpdate(dispatched, "running");
      yield* Queue.offer(
        events,
        event("project.program-restart-requested", projectId, programId, 2),
      );
      const restarted = yield* takeRunUpdate(dispatched, "running");
      expect(restarted.run.pid).toBe(112);
      expect(spawns).toBe(2);
    }).pipe(
      Effect.provide(
        supervisorHarness({
          projectId,
          programId,
          program,
          process: fakes[0]!.process,
          processFor: () => fakes[spawns - 1]!.process,
          events,
          dispatched,
          onSpawn: () => {
            spawns += 1;
          },
        }),
      ),
      Effect.scoped,
    );
  }),
);

it.effect("honors the strictest group cap and uses the latest queued definition", () =>
  Effect.gen(function* () {
    const projectId = ProjectId.make("hub-latest");
    const firstId = WorkspaceProgramId.make("first");
    const secondId = WorkspaceProgramId.make("second");
    const first: WorkspaceProgram = {
      ...programFixture(projectId, firstId),
      hubMemory: {
        ...DEFAULT_WORKSPACE_PROGRAM_HUB_MEMORY,
        concurrencyGroup: "research",
        concurrencySlots: 1,
      },
    };
    const second: WorkspaceProgram = {
      ...programFixture(projectId, secondId),
      command: "old-command",
      hubMemory: { ...first.hubMemory, concurrencySlots: 4 },
    };
    let definitions = [first, second];
    const events = yield* Queue.unbounded<OrchestrationEvent>();
    const dispatched = yield* Queue.unbounded<OrchestrationCommand>();
    const fakes = [fakeProcessWithPid(121), fakeProcessWithPid(122)];
    const commands: string[] = [];
    yield* Effect.gen(function* () {
      const supervisor = yield* WorkspaceProgramSupervisor;
      yield* supervisor.start();
      yield* Queue.offer(events, event("project.program-start-requested", projectId, firstId, 1));
      yield* takeRunUpdate(dispatched, "running");
      yield* Queue.offer(events, event("project.program-start-requested", projectId, secondId, 2));
      yield* takeRunUpdate(dispatched, "starting");
      yield* supervisor.drain;
      expect(commands).toEqual([first.command]);
      definitions = [first, { ...second, command: "updated-command" }];
      yield* Queue.offer(events, event("project.program-stop-requested", projectId, firstId, 3));
      const admitted = yield* takeRunUpdate(dispatched, "running");
      expect(admitted.run.programId).toBe(secondId);
      expect(commands).toEqual([first.command, "updated-command"]);
    }).pipe(
      Effect.provide(
        supervisorHarness({
          projectId,
          programId: firstId,
          program: first,
          programs: () => definitions,
          process: fakes[0]!.process,
          processFor: () => fakes[commands.length - 1]!.process,
          events,
          dispatched,
          onSpawn: (input) => {
            commands.push(input.args?.at(-1) ?? "");
          },
        }),
      ),
      Effect.scoped,
    );
  }),
);

it.effect(
  "keeps a program that outlives the stop escalation tracked instead of reporting it stopped",
  () =>
    Effect.gen(function* () {
      const projectId = ProjectId.make("stubborn-program");
      const programId = WorkspaceProgramId.make("dev-server");
      const program = programFixture(projectId, programId);
      const events = yield* Queue.unbounded<OrchestrationEvent>();
      const dispatched = yield* Queue.unbounded<OrchestrationCommand>();
      const commands: OrchestrationCommand[] = [];
      const signals: Array<string | undefined> = [];
      let spawnCount = 0;
      let exitListener: ((exit: PtyAdapter.PtyExitEvent) => void) | undefined;
      // A dev server that traps every signal, until the test lets it die.
      let honorSignals = false;
      const stubbornProcess: PtyAdapter.PtyProcess = {
        pid: 9876,
        write: () => undefined,
        resize: () => undefined,
        kill: (signal) => {
          signals.push(signal);
          if (honorSignals) exitListener?.({ exitCode: 143, signal: 15 });
        },
        onData: () => () => undefined,
        onExit: (listener) => {
          exitListener = listener;
          return () => {
            if (exitListener === listener) exitListener = undefined;
          };
        },
      };
      const runStatuses = () =>
        commands.flatMap((command) =>
          command.type === "project.program.run.update" ? [command.run.status] : [],
        );

      yield* Effect.gen(function* () {
        const supervisor = yield* WorkspaceProgramSupervisor;
        yield* supervisor.start();
        yield* Queue.offer(
          events,
          event("project.program-start-requested", projectId, programId, 1),
        );
        yield* takeRunUpdate(dispatched, "running");
        expect(spawnCount).toBe(1);

        yield* Queue.offer(
          events,
          event("project.program-stop-requested", projectId, programId, 2),
        );
        yield* takeRunUpdate(dispatched, "stopping");
        // Walk the escalation's grace and force windows forward; they are the behaviour under
        // test, and on the test clock they cost nothing.
        yield* TestClock.adjust(Duration.seconds(3));
        yield* TestClock.adjust(Duration.seconds(6));
        yield* supervisor.drain;

        expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
        expect(runStatuses()).not.toContain("exited");

        // Still tracked, so the program is not startable behind its own back: the worker is
        // serial, so the later stop reaching `stopping` proves this start was processed, and
        // had the timeout dropped the live entry it would have spawned a second instance.
        honorSignals = true;
        yield* Queue.offer(
          events,
          event("project.program-start-requested", projectId, programId, 3),
        );
        yield* Queue.offer(
          events,
          event("project.program-stop-requested", projectId, programId, 4),
        );
        yield* takeRunUpdate(dispatched, "stopping");
        expect(spawnCount).toBe(1);

        // Once the process finally answers, the exit handler — not stopProgram — reports it.
        yield* takeRunUpdate(dispatched, "exited");
        const exited = commands.flatMap((command) =>
          command.type === "project.program.run.update" && command.run.status === "exited"
            ? [command.run]
            : [],
        );
        expect(exited).toHaveLength(1);
        expect(exited[0]).toMatchObject({ pid: null, exitCode: 143, exitSignal: 15 });
      }).pipe(
        Effect.provide(
          supervisorHarness({
            projectId,
            programId,
            program,
            process: stubbornProcess,
            events,
            dispatched,
            onSpawn: () => {
              spawnCount += 1;
            },
            onDispatch: (command) => {
              commands.push(command);
            },
          }),
        ),
        Effect.scoped,
      );
    }),
);

it("classifies health-check failures and treats a late timeout as the watcher's, not the program's", () => {
  const checkedAt = "2026-08-22T00:00:10.000Z";
  const timeout = new WorkspaceHealthCheckError({
    message: "HTTP 상태검사 시간 초과",
    reason: "timeout",
  });

  // A timeout that settled near its limit is a real timeout and counts.
  const real = classifyHealthFailure({
    failure: timeout,
    timeoutSeconds: 5,
    elapsedMs: 5_120,
    checkedAt,
  });
  expect(real.reason).toBe("timeout");
  expect(real.detail).toContain("한도 5.0초");
  expect(real.detail).toContain("경과 5.1초");

  // One that settled seconds after its limit was timed by a stalled event loop.
  const stalled = classifyHealthFailure({
    failure: timeout,
    timeoutSeconds: 5,
    elapsedMs: 9_300,
    checkedAt,
  });
  expect(stalled.reason).toBe("inconclusive");
  expect(stalled.detail).toContain("감시하는 서버 자체가 멈춰");
  expect(stalled.elapsedMs).toBe(9_300);

  // Refusals carry the socket's own message; the elapsed time never promotes them to inconclusive.
  const refused = classifyHealthFailure({
    failure: new WorkspaceHealthCheckError({
      message: "TCP 상태검사 연결 실패",
      reason: "connection",
      cause: new Error("connect ECONNREFUSED 127.0.0.1:3000"),
    }),
    timeoutSeconds: 5,
    elapsedMs: 12_000,
    checkedAt,
  });
  expect(refused.reason).toBe("connection");
  expect(refused.detail).toContain("ECONNREFUSED");

  const status = classifyHealthFailure({
    failure: new WorkspaceHealthCheckError({
      message: "예상하지 않은 HTTP 503",
      reason: "unexpected-status",
    }),
    timeoutSeconds: 5,
    elapsedMs: 40,
    checkedAt,
  });
  expect(status.reason).toBe("unexpected-status");
});
