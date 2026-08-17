import {
  CommandId,
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
  isWorkspaceRepairRunApproved,
  makeWorkspaceProgramSupervisor,
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
  type: "project.program-start-requested" | "project.program-stop-requested",
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
}) {
  const { projectId, programId, program, events, dispatched } = input;
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
      getThreadDetailById: () => Effect.succeed(Option.none()),
      getThreadDetailSnapshot: () => Effect.succeed(Option.none()),
    }),
    Layer.succeed(ProjectionWorkspaceProgramRepository, {
      upsertProgram: () => Effect.void,
      removeProgram: () => Effect.void,
      removeByProjectId: () => Effect.void,
      getProgram: (input) =>
        Effect.succeed(
          input.projectId === projectId && input.programId === programId
            ? Option.some(program)
            : Option.none(),
        ),
      listPrograms: () => Effect.succeed([program]),
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
      },
    }),
    Layer.succeed(PtyAdapter.PtyAdapter, {
      spawn: (spawnInput) =>
        Effect.sync(() => {
          input.onSpawn(spawnInput);
          return input.process;
        }),
    }),
  );
  return Layer.effect(WorkspaceProgramSupervisor, makeWorkspaceProgramSupervisor).pipe(
    Layer.provide(OrchestrationTurnWaitLive),
    Layer.provide(base),
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
