import {
  CommandId,
  EventId,
  MessageId,
  ThreadId,
  type OrchestrationEvent,
  type ProjectId,
  type ResourceMonitorExternalProcess,
  type ResourceTelemetrySnapshot,
  type WorkspaceIncident,
  type WorkspaceMonitoringMetric,
  type WorkspaceMonitoringPlan,
  type WorkspaceMonitoringPlaybook,
  type WorkspaceMonitoringSettings,
  type WorkspaceMonitoringTarget,
  type VcsStatusLocalResult,
  type WorkspaceProgram,
  type WorkspaceProgramRun,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import { ProjectionProjectRepository } from "../../persistence/Services/ProjectionProjects.ts";
import { ProjectionWorkspaceAgentRoleRepository } from "../../persistence/Services/ProjectionWorkspaceAgentRoles.ts";
import { ProjectionWorkspaceProgramRepository } from "../../persistence/Services/ProjectionWorkspacePrograms.ts";
import {
  ServerSelfSignals,
  type ServerSelfSignalsReading,
} from "../../diagnostics/ServerSelfSignals.ts";
import { ResourceTelemetry } from "../../resourceTelemetry/ResourceTelemetry.ts";
import { forkParked } from "../../serverActivation.ts";
import * as ProcessRunner from "../../processRunner.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { VcsStatusBroadcaster } from "../../vcs/VcsStatusBroadcaster.ts";
import {
  MONITORING_STALE_NOTICE,
  buildMonitoringFindingPrompt,
  buildMonitoringProposalPrompt,
  monitoringTurnBudget,
  parseMonitoringActions,
  parseMonitoringPlan,
  type MonitoringFinding,
} from "../workspaceMonitoring.ts";
import { SampleRing, evaluateTrend } from "../workspaceMonitoringTrends.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { OrchestrationTurnWait } from "../Services/OrchestrationTurnWait.ts";
import {
  WorkspaceMonitoringReactor,
  type WorkspaceMonitoringReactorShape,
} from "../Services/WorkspaceMonitoringReactor.ts";
import { WorkspaceProgramSupervisor } from "../Services/WorkspaceProgramSupervisor.ts";

/**
 * The base tick is coarse on purpose: every enabled project carries its own
 * `checkIntervalSec` (≥ 15s) and is only evaluated when that is due, so the
 * reactor's steady-state cost is one cheap row read per project per interval.
 */
const BASE_TICK = Duration.seconds(5);
const RING_CAPACITY = 240;
/** Don't write `lastCheckedAt` on every tick — each write is a project event clients react to. */
const LAST_CHECKED_WRITE_INTERVAL_MS = 5 * 60_000;
const HELD_NOTICE_INTERVAL_MS = 60 * 60_000;
const REPEAT_REPORT_MIN_MINUTES = 30;

function conciseCause(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause);
  return (error instanceof Error ? error.message : String(error)).slice(0, 4_000);
}

interface ProjectMonitor {
  readonly rings: Map<string, SampleRing>;
  /** fingerprint → epoch ms of the last turn it contributed to. */
  readonly firedAt: Map<string, number>;
  knownProgramIds: ReadonlySet<string> | null;
  proposalInFlight: boolean;
  turnInFlight: boolean;
  staleNoticed: boolean;
  lastEvaluatedAt: number;
  lastCheckedWriteAt: number;
  lastHeldNoticeAt: number;
  /** Working-tree fingerprint at the last poll; null until the first poll. */
  vcsFingerprint: string | null;
  lastVcsPollAt: number;
  regressionInFlight: boolean;
  /** Outcome of the last validation run after a code change; null until one ran. */
  regression: { readonly failures: number; readonly detail: string; readonly at: number } | null;
  /** HTTP probe state per probed URL (url targets and program health-check URLs). */
  readonly probes: Map<string, { consecutiveFailures: number; latencyMs: number | null }>;
  /** Tail state per log path: read offset and recent matching lines. */
  readonly logs: Map<string, LogTailState>;
  /** `process` targets of the approved plan, handed to the telemetry sidecar as extra roots. */
  externalProcesses: ReadonlyArray<ResourceMonitorExternalProcess>;
}

function freshMonitor(): ProjectMonitor {
  return {
    rings: new Map(),
    firedAt: new Map(),
    knownProgramIds: null,
    proposalInFlight: false,
    turnInFlight: false,
    staleNoticed: false,
    lastEvaluatedAt: 0,
    lastCheckedWriteAt: 0,
    lastHeldNoticeAt: 0,
    vcsFingerprint: null,
    lastVcsPollAt: 0,
    regressionInFlight: false,
    regression: null,
    probes: new Map(),
    logs: new Map(),
    externalProcesses: [],
  };
}

interface LogTailState {
  /** Byte offset already consumed; the file is read from here on each tick. */
  offset: number;
  /** Matching lines, newest last, trimmed to the last hour and LOG_MATCH_KEEP rows. */
  readonly matches: Array<{ readonly at: number; readonly line: string }>;
  lastError: string | null;
}

const LOG_MATCH_KEEP = 200;
const LOG_MATCH_RETAIN_MS = 60 * 60_000;
/** Per tick, per file: a runaway log must not stall the tick. */
const LOG_READ_CAP_BYTES = 1024 * 1024;
const LOG_LINE_MAX_CHARS = 300;

function compileLogPatterns(patterns: ReadonlyArray<string> | undefined): ReadonlyArray<RegExp> {
  if (patterns === undefined) return [];
  return patterns.flatMap((pattern) => {
    try {
      return [new RegExp(pattern)];
    } catch {
      return [];
    }
  });
}

function resolveLogPath(path: Path.Path, target: string, workspaceRoot: string): string {
  return path.isAbsolute(target) ? target : path.join(workspaceRoot, target);
}

/** The plan's `process` targets as sidecar roots; a target without a pid has nothing to follow. */
function externalProcessesOf(
  plan: WorkspaceMonitoringPlan | null,
): ReadonlyArray<ResourceMonitorExternalProcess> {
  if (plan === null) return [];
  return plan.targets.flatMap((target) =>
    target.kind !== "process" || target.pid === undefined
      ? []
      : [
          {
            pid: target.pid,
            ...(target.startTimeMs === undefined ? {} : { startTimeMs: target.startTimeMs }),
          },
        ],
  );
}

const PROBE_TIMEOUT = Duration.seconds(5);

/** Poll git no more often than this, whatever the project's check interval is. */
const VCS_POLL_INTERVAL_MS = 60_000;
const VALIDATION_COMMAND_TIMEOUT = Duration.minutes(10);
const VALIDATION_OUTPUT_TAIL = 1_500;

/** What "the code changed" means here: branch or working-tree contents. */
function vcsFingerprint(status: VcsStatusLocalResult): string {
  return JSON.stringify([
    status.refName,
    status.workingTree.files.map((file) => [file.path, file.insertions, file.deletions]),
  ]);
}

/** Resident bytes and cpu of a pid plus everything under it in the sampled tree. */
function subtreeUsage(
  snapshot: ResourceTelemetrySnapshot,
  rootPid: number,
): { readonly cpuPercent: number; readonly residentBytes: number } | null {
  const byPid = new Map(snapshot.processes.map((process) => [process.identity.pid, process]));
  if (!byPid.has(rootPid)) return null;
  let cpuPercent = 0;
  let residentBytes = 0;
  const stack = [rootPid];
  const seen = new Set<number>();
  while (stack.length > 0) {
    const pid = stack.pop()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    const process = byPid.get(pid);
    if (process === undefined) continue;
    cpuPercent += process.cpuPercent;
    residentBytes += process.residentBytes;
    stack.push(...process.childPids);
  }
  return { cpuPercent, residentBytes };
}

function categoryUsage(
  snapshot: ResourceTelemetrySnapshot,
  match: (category: string) => boolean,
): { readonly cpuPercent: number; readonly residentBytes: number } | null {
  const matched = snapshot.processes.filter((process) => match(process.category));
  if (matched.length === 0) return null;
  return {
    cpuPercent: matched.reduce((sum, process) => sum + process.cpuPercent, 0),
    residentBytes: matched.reduce((sum, process) => sum + process.residentBytes, 0),
  };
}

export const makeWorkspaceMonitoringReactor = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectRepository = yield* ProjectionProjectRepository;
  const programRepository = yield* ProjectionWorkspaceProgramRepository;
  const roleRepository = yield* ProjectionWorkspaceAgentRoleRepository;
  const supervisor = yield* WorkspaceProgramSupervisor;
  const telemetry = yield* ResourceTelemetry;
  const selfSignals = yield* ServerSelfSignals;
  const vcsStatus = yield* VcsStatusBroadcaster;
  const httpClient = yield* HttpClient.HttpClient;
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const platform = yield* HostProcessPlatform;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // Validation commands spawn processes; on Windows a spawn blocks the event
  // loop, so at most one runs at a time across all projects, always forked.
  const validationMutex = yield* Semaphore.make(1);
  const turnWait = yield* OrchestrationTurnWait;
  const serverSettings = yield* ServerSettingsService;
  const crypto = yield* Crypto.Crypto;
  const randomUUID = crypto.randomUUIDv4;
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const tickMutex = yield* Semaphore.make(1);

  // Background turns (proposal, finding report) outlive a tick. They are forked
  // into the scope `start` runs in, so a server shutdown interrupts them; before
  // `start`, and in tests that drive `tick` directly, they run as daemons.
  let runScope: Scope.Scope | null = null;
  const forkBackground = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<void> =>
    (runScope === null ? Effect.forkDetach(effect) : Effect.forkIn(effect, runScope)).pipe(
      Effect.asVoid,
    );

  /** Projects whose monitoring switch is on, refreshed from events and at start. */
  const enabledProjects = new Set<ProjectId>();
  const monitors = new Map<ProjectId, ProjectMonitor>();
  const monitorFor = (projectId: ProjectId): ProjectMonitor => {
    let monitor = monitors.get(projectId);
    if (monitor === undefined) {
      monitor = freshMonitor();
      monitors.set(projectId, monitor);
    }
    return monitor;
  };

  // The sidecar only streams while someone holds a subscription. Hold exactly
  // one while any project is monitored; drop it when the last switch goes off.
  let telemetryScope: Scope.Closeable | null = null;
  const ensureTelemetry = Effect.gen(function* () {
    if (telemetryScope !== null) return;
    const scope = yield* Scope.make();
    yield* telemetry.subscribe.pipe(Scope.provide(scope));
    telemetryScope = scope;
  });
  const releaseTelemetry = Effect.gen(function* () {
    if (telemetryScope === null) return;
    const scope = telemetryScope;
    telemetryScope = null;
    yield* Scope.close(scope, Exit.void);
  });

  const readPermissions = serverSettings.getSettings.pipe(
    Effect.map((settings) => settings.workspaceProgramPermissions),
    Effect.catchCause((cause) =>
      Effect.logWarning("Monitoring: permissions could not be read", {
        cause: conciseCause(cause),
      }).pipe(Effect.as({ autoDiagnosis: false, monitoringAutoActions: false } as const)),
    ),
  );

  // T3 Code's own signals go to exactly one project's thread: the one named in
  // server settings, or — when none is named — the first project with
  // monitoring on, so a single server anomaly never spends several budgets.
  const isSelfMonitoringOwner = (
    selfMonitoring: { readonly enabled: boolean; readonly projectId: string | null },
    projectId: ProjectId,
  ): boolean => {
    if (!selfMonitoring.enabled) return false;
    if (selfMonitoring.projectId !== null) return selfMonitoring.projectId === projectId;
    const [first] = [...enabledProjects].sort();
    return first === projectId;
  };

  const readSelfMonitoringTarget = serverSettings.getSettings.pipe(
    Effect.map((settings) => settings.selfMonitoring),
    Effect.catch(() => Effect.succeed({ enabled: false, projectId: null } as const)),
  );

  const appendNotice = Effect.fn("WorkspaceMonitoringReactor.appendNotice")(function* (input: {
    readonly threadId: ThreadId;
    readonly kind: string;
    readonly summary: string;
    readonly tone?: "info" | "error";
  }) {
    yield* orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: CommandId.make(yield* randomUUID),
      threadId: input.threadId,
      activity: {
        id: EventId.make(yield* randomUUID),
        tone: input.tone ?? "info",
        kind: input.kind,
        summary: input.summary,
        payload: {},
        turnId: null,
        createdAt: yield* nowIso,
      },
      createdAt: yield* nowIso,
    });
  });

  const updateRuntime = Effect.fn("WorkspaceMonitoringReactor.updateRuntime")(function* (
    projectId: ProjectId,
    patch: {
      readonly threadId?: ThreadId | null;
      readonly turnLog?: ReadonlyArray<string>;
      readonly lastCheckedAt?: string;
      readonly planStatus?: "stale";
    },
  ) {
    yield* orchestrationEngine.dispatch({
      type: "project.monitoring.runtime.update",
      commandId: CommandId.make(yield* randomUUID),
      projectId,
      ...patch,
    });
  });

  const pickBinding = (projectId: ProjectId) =>
    roleRepository
      .listByProjectId(projectId)
      .pipe(
        Effect.map(
          (bindings) =>
            bindings.find((candidate) => candidate.role === "operator" && candidate.enabled) ??
            bindings.find((candidate) => candidate.role === "coordinator" && candidate.enabled),
        ),
      );

  /**
   * The 감시 AI for a project: the model the person picked in monitoring
   * settings, else the operator/coordinator role binding. Null when neither
   * exists — monitoring cannot start a thread or a turn without an account.
   */
  const pickMonitoringModel = Effect.fn("WorkspaceMonitoringReactor.pickMonitoringModel")(
    function* (projectId: ProjectId) {
      const row = yield* projectRepository.getById({ projectId });
      const chosen = Option.isSome(row)
        ? row.value.workspaceControl.monitoring.modelSelection
        : null;
      if (chosen !== null) return chosen;
      const binding = yield* pickBinding(projectId);
      return binding?.modelSelection ?? null;
    },
  );

  /** Create the project's monitoring thread once; returns null when no AI account can own it. */
  const ensureThread = Effect.fn("WorkspaceMonitoringReactor.ensureThread")(function* (
    projectId: ProjectId,
    projectTitle: string,
    settings: WorkspaceMonitoringSettings,
  ) {
    if (settings.threadId !== null) return settings.threadId;
    const modelSelection = settings.modelSelection ?? (yield* pickMonitoringModel(projectId));
    if (modelSelection === null) {
      yield* Effect.logWarning(
        "Monitoring: no 감시 AI selected and no operator/coordinator role binding; thread not created",
        { projectId },
      );
      return null;
    }
    const threadId = ThreadId.make(yield* randomUUID);
    yield* orchestrationEngine.dispatch({
      type: "thread.create",
      commandId: CommandId.make(yield* randomUUID),
      threadId,
      projectId,
      title: `모니터링 · ${projectTitle}`,
      modelSelection,
      runtimeMode: "approval-required",
      interactionMode: "plan",
      branch: null,
      worktreePath: null,
      createdAt: yield* nowIso,
    });
    yield* updateRuntime(projectId, { threadId });
    return threadId;
  });

  /** Start an automation turn in the monitoring thread and wait for the assistant text. */
  const runAutomationTurn = Effect.fn("WorkspaceMonitoringReactor.runAutomationTurn")(function* (
    projectId: ProjectId,
    threadId: ThreadId,
    prompt: string,
  ) {
    const modelSelection = yield* pickMonitoringModel(projectId);
    if (modelSelection === null) return null;
    const requestedAt = yield* nowIso;
    yield* orchestrationEngine.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make(yield* randomUUID),
      threadId,
      message: {
        messageId: MessageId.make(yield* randomUUID),
        role: "user",
        text: prompt,
        attachments: [],
      },
      inputOrigin: "automation",
      modelSelection,
      runtimeMode: "approval-required",
      interactionMode: "plan",
      createdAt: requestedAt,
    });
    const result = yield* turnWait.waitForSettledTurn({
      threadId,
      requestedAtOrAfter: requestedAt,
    });
    if (result.turn.state !== "completed") return null;
    const assistantMessageId = result.turn.assistantMessageId;
    const message =
      (assistantMessageId === null
        ? undefined
        : result.thread.messages.find((candidate) => candidate.id === assistantMessageId)) ??
      result.thread.messages.findLast((candidate) => candidate.role === "assistant");
    return message?.text.trim() ?? null;
  });

  const propose = Effect.fn("WorkspaceMonitoringReactor.propose")(function* (input: {
    readonly projectId: ProjectId;
    readonly projectTitle: string;
    readonly workspaceRoot: string;
    readonly threadId: ThreadId;
    readonly settings: WorkspaceMonitoringSettings;
  }) {
    const monitor = monitorFor(input.projectId);
    monitor.proposalInFlight = true;
    yield* Effect.ensuring(
      Effect.gen(function* () {
        const [programs, runs, incidents, discovery, selfMonitoring] = yield* Effect.all([
          programRepository.listPrograms(input.projectId),
          programRepository.listRuns({ projectId: input.projectId, limit: 50 }),
          programRepository.listIncidents({
            projectId: input.projectId,
            statuses: ["open", "diagnosing", "awaiting-user", "repairing", "verifying"],
            limit: 20,
          }),
          supervisor
            .discover(input.projectId)
            .pipe(Effect.catch(() => Effect.succeed({ candidates: [] as const }))),
          readSelfMonitoringTarget,
        ]);
        const prompt = buildMonitoringProposalPrompt({
          projectTitle: input.projectTitle,
          workspaceRoot: input.workspaceRoot,
          programs,
          runs,
          candidates: discovery.candidates,
          openIncidents: incidents,
          selfMonitoring: isSelfMonitoringOwner(selfMonitoring, input.projectId),
          autonomy: input.settings.autonomy,
        });
        const output = yield* runAutomationTurn(input.projectId, input.threadId, prompt);
        if (output === null) {
          yield* appendNotice({
            threadId: input.threadId,
            kind: "monitoring.proposal.failed",
            tone: "error",
            summary:
              "감시 계획 제안 턴이 완료되지 않았습니다. 제어센터에서 다시 분석을 눌러 다시 시도할 수 있습니다.",
          });
          return;
        }
        const parsed = parseMonitoringPlan(output);
        switch (parsed._tag) {
          case "Plan":
            yield* orchestrationEngine.dispatch({
              type: "project.monitoring.plan.propose",
              commandId: CommandId.make(yield* randomUUID),
              projectId: input.projectId,
              plan: {
                ...parsed.plan,
                revision: 0,
                proposedAt: yield* nowIso,
                approvedAt: null,
              },
            });
            return;
          case "Missing":
            yield* appendNotice({
              threadId: input.threadId,
              kind: "monitoring.proposal.unparsed",
              tone: "error",
              summary:
                "응답에 감시 계획 블록이 없어 저장하지 못했습니다. 다시 분석을 누르면 새로 제안합니다.",
            });
            return;
          case "Invalid":
            yield* appendNotice({
              threadId: input.threadId,
              kind: "monitoring.proposal.unparsed",
              tone: "error",
              summary: `감시 계획 블록을 해석하지 못했습니다: ${parsed.detail.slice(0, 500)}`,
            });
            return;
        }
      }),
      Effect.sync(() => {
        monitor.proposalInFlight = false;
      }),
    );
  });

  interface SampleContext {
    readonly telemetry: ResourceTelemetrySnapshot;
    readonly programs: ReadonlyArray<WorkspaceProgram>;
    readonly runs: ReadonlyArray<WorkspaceProgramRun>;
    readonly openIncidents: ReadonlyArray<WorkspaceIncident>;
    readonly selfSignals: ServerSelfSignalsReading;
    readonly regression: ProjectMonitor["regression"];
    readonly probes: ProjectMonitor["probes"];
    readonly logs: ProjectMonitor["logs"];
    readonly workspaceRoot: string;
    readonly nowMs: number;
  }

  /** Read the current value of one metric for one target; null = not observable yet. */
  function targetIdentity(target: WorkspaceMonitoringTarget, context: SampleContext): string {
    switch (target.kind) {
      case "program": {
        const run = context.runs.find(
          (candidate) =>
            candidate.programId === target.programId &&
            (candidate.status === "running" || candidate.status === "starting"),
        );
        return run?.pid == null ? "down" : `pid:${run.pid}`;
      }
      case "process":
        return target.pid === undefined ? "none" : `pid:${target.pid}`;
      case "log":
        return target.path === undefined ? "none" : `log:${target.path}`;
      case "self-server":
      case "self-desktop":
      case "url":
        return target.kind;
    }
  }

  /** Matching lines of a log target inside the metric window, newest last. */
  function logMatchesFor(
    target: WorkspaceMonitoringTarget,
    windowMin: number,
    context: SampleContext,
  ): ReadonlyArray<{ readonly at: number; readonly line: string }> | null {
    if (target.kind !== "log" || target.path === undefined) return null;
    const state = context.logs.get(resolveLogPath(path, target.path, context.workspaceRoot));
    if (state === undefined) return null;
    const since = context.nowMs - windowMin * 60_000;
    return state.matches.filter((match) => match.at >= since);
  }

  function sampleMetric(
    target: WorkspaceMonitoringTarget,
    metric: WorkspaceMonitoringMetric,
    context: SampleContext,
  ): number | null {
    const usage = (() => {
      switch (target.kind) {
        case "program": {
          const run = context.runs.find(
            (candidate) =>
              candidate.programId === target.programId &&
              (candidate.status === "running" || candidate.status === "starting"),
          );
          return run?.pid == null ? null : subtreeUsage(context.telemetry, run.pid);
        }
        case "process":
          return target.pid === undefined ? null : subtreeUsage(context.telemetry, target.pid);
        case "self-server":
          return categoryUsage(
            context.telemetry,
            (category) => category === "server" || category === "server-child",
          );
        case "self-desktop":
          return categoryUsage(context.telemetry, (category) => category.startsWith("electron-"));
        case "url":
        case "log":
          return null;
      }
    })();
    switch (metric.metric) {
      case "cpu":
        return usage?.cpuPercent ?? null;
      case "memory":
        return usage?.residentBytes ?? null;
      case "health": {
        if (target.kind === "url") {
          return target.url === undefined
            ? null
            : (context.probes.get(target.url)?.consecutiveFailures ?? null);
        }
        if (target.kind !== "program") return null;
        const run = context.runs.find((candidate) => candidate.programId === target.programId);
        // An open incident (crash, spawn failure, log pattern, failed health
        // check) is the supervisor saying the program is down; count it as
        // crossing the health limit outright so a kill is not invisible just
        // because the health loop stopped with the process.
        const incident = context.openIncidents.some(
          (candidate) => candidate.programId === target.programId,
        );
        if (incident) return Math.max(run?.consecutiveHealthFailures ?? 0, metric.limit);
        return run?.consecutiveHealthFailures ?? null;
      }
      // For the server itself, "latency" is event-loop lag (p99 ms since the
      // last read) and "slow-spans" is the per-minute rate of slow effect
      // spans. Program latency and regression arrive with a later phase; a
      // metric with no sampler simply never fires rather than misfiring.
      case "latency": {
        if (target.kind === "self-server") return context.selfSignals.eventLoopP99Ms;
        const url = probeUrlFor(target, context.programs);
        return url === null ? null : (context.probes.get(url)?.latencyMs ?? null);
      }
      case "slow-spans":
        return target.kind === "self-server" ? context.selfSignals.slowSpansPerMin : null;
      case "log-matches": {
        const matches = logMatchesFor(target, metric.windowMin, context);
        return matches === null ? null : matches.length;
      }
      case "regression":
        return context.regression?.failures ?? null;
    }
  }

  const executePlaybooks = Effect.fn("WorkspaceMonitoringReactor.executePlaybooks")(function* (
    projectId: ProjectId,
    plan: WorkspaceMonitoringPlan,
    findings: ReadonlyArray<{ readonly metricIndex: number; readonly finding: MonitoringFinding }>,
    incidents: ReadonlyArray<WorkspaceIncident>,
  ) {
    const executed: string[] = [];
    const firedMetricIndexes = new Set(findings.map((entry) => entry.metricIndex));
    const playbooks: ReadonlyArray<WorkspaceMonitoringPlaybook> = plan.playbooks.filter(
      (playbook) => firedMetricIndexes.has(playbook.when) && playbook.action !== "notify-only",
    );
    for (const playbook of playbooks) {
      const metric = plan.metrics[playbook.when];
      const target = metric === undefined ? undefined : plan.targets[metric.targetIndex];
      const programId = playbook.programId ?? target?.programId;
      if (programId === undefined) continue;
      const createdAt = yield* nowIso;
      const commandId = CommandId.make(yield* randomUUID);
      switch (playbook.action) {
        case "restart-program":
        case "stop-program":
        case "start-program":
          yield* orchestrationEngine.dispatch({
            type:
              playbook.action === "restart-program"
                ? "project.program.restart"
                : playbook.action === "stop-program"
                  ? "project.program.stop"
                  : "project.program.start",
            commandId,
            projectId,
            programId,
            createdAt,
          });
          executed.push(`${playbook.action} · programId=${programId}`);
          break;
        case "repair-run": {
          const incident = incidents.find(
            (candidate) =>
              candidate.programId === programId &&
              (candidate.status === "open" || candidate.status === "awaiting-user"),
          );
          if (incident === undefined) break;
          yield* orchestrationEngine.dispatch({
            type: "project.program.incident.repair.request",
            commandId,
            projectId,
            incidentId: incident.id,
            instruction:
              "모니터링 플레이북(repair-run)이 자동으로 요청한 수정입니다. 장애 증거를 재현하고 고친 뒤 등록된 검증 명령으로 확인하세요.",
            createdAt,
          });
          executed.push(`repair-run · incident=${incident.id}`);
          break;
        }
        case "notify-only":
          break;
      }
    }
    return executed;
  });

  const executeRequestedActions = Effect.fn("WorkspaceMonitoringReactor.executeRequestedActions")(
    function* (
      projectId: ProjectId,
      threadId: ThreadId,
      plan: WorkspaceMonitoringPlan,
      output: string,
    ) {
      const parsed = parseMonitoringActions(output, plan);
      if (parsed.rejected !== null) {
        yield* appendNotice({
          threadId,
          kind: "monitoring.action.rejected",
          tone: "error",
          summary: parsed.rejected,
        });
      }
      for (const requested of parsed.actions) {
        yield* orchestrationEngine.dispatch({
          type:
            requested.action === "restart-program"
              ? "project.program.restart"
              : requested.action === "stop-program"
                ? "project.program.stop"
                : "project.program.start",
          commandId: CommandId.make(yield* randomUUID),
          projectId,
          programId: requested.programId,
          createdAt: yield* nowIso,
        });
        yield* appendNotice({
          threadId,
          kind: "monitoring.action.executed",
          summary: `사람의 결정에 따라 서버가 실행했습니다: ${requested.action} · programId=${requested.programId}. 결과는 다음 점검에서 확인합니다.`,
        });
      }
    },
  );

  /** Run every registered validation command once; the outcome becomes the regression sample. */
  const runValidationCommands = Effect.fn("WorkspaceMonitoringReactor.runValidationCommands")(
    function* (input: {
      readonly projectId: ProjectId;
      readonly workspaceRoot: string;
      readonly threadId: ThreadId;
      readonly commands: ReadonlyArray<string>;
    }) {
      const monitor = monitorFor(input.projectId);
      const failures: string[] = [];
      for (const command of input.commands) {
        const shell =
          platform === "win32"
            ? {
                command: process.env.ComSpec?.trim() || "cmd.exe",
                args: ["/d", "/s", "/c", command],
              }
            : { command: process.env.SHELL?.trim() || "/bin/sh", args: ["-lc", command] };
        const result = yield* processRunner
          .run({
            command: shell.command,
            args: shell.args,
            cwd: input.workspaceRoot,
            timeout: VALIDATION_COMMAND_TIMEOUT,
            timeoutBehavior: "timedOutResult",
            outputMode: "truncate",
          })
          .pipe(
            Effect.catch((error) =>
              Effect.succeed({ code: -1, timedOut: false, stderr: String(error), stdout: "" }),
            ),
          );
        if (result.timedOut || result.code !== 0) {
          const tail = (result.stderr || result.stdout).slice(-VALIDATION_OUTPUT_TAIL).trim();
          const outcome = result.timedOut ? "시간 초과" : `종료 코드 ${result.code}`;
          failures.push(`\`${command}\` → ${outcome}${tail ? `\n${tail}` : ""}`);
        }
      }
      monitor.regression = {
        failures: failures.length,
        detail: failures.length === 0 ? "모든 검증 명령 통과" : failures.join("\n\n"),
        at: Date.parse(yield* nowIso),
      };
      yield* appendNotice({
        threadId: input.threadId,
        kind:
          failures.length === 0 ? "monitoring.regression.passed" : "monitoring.regression.failed",
        tone: failures.length === 0 ? "info" : "error",
        summary:
          failures.length === 0
            ? `코드 변경 후 검증 명령 ${input.commands.length}개 모두 통과했습니다.`
            : `코드 변경 후 검증 명령 ${failures.length}/${input.commands.length}개가 실패했습니다. 다음 점검에서 보고합니다.`,
      });
    },
  );

  /**
   * Git is polled (never watched): at most once a minute, and only while the
   * plan carries a regression metric. A fingerprint change since the previous
   * poll starts the validation run in the background.
   */
  const pollForCodeChanges = Effect.fn("WorkspaceMonitoringReactor.pollForCodeChanges")(
    function* (input: {
      readonly projectId: ProjectId;
      readonly workspaceRoot: string;
      readonly threadId: ThreadId;
      readonly programs: ReadonlyArray<WorkspaceProgram>;
      readonly nowMs: number;
    }) {
      const monitor = monitorFor(input.projectId);
      if (input.nowMs - monitor.lastVcsPollAt < VCS_POLL_INTERVAL_MS) return;
      monitor.lastVcsPollAt = input.nowMs;
      const status = yield* vcsStatus
        .refreshLocalStatus(input.workspaceRoot)
        .pipe(Effect.catch(() => Effect.succeed(null)));
      if (status === null || !status.isRepo) return;
      const next = vcsFingerprint(status);
      const previous = monitor.vcsFingerprint;
      monitor.vcsFingerprint = next;
      if (previous === null || previous === next || monitor.regressionInFlight) return;
      const commands = [
        ...new Set(input.programs.flatMap((program) => program.integrity.validationCommands)),
      ];
      if (commands.length === 0) return;
      monitor.regressionInFlight = true;
      yield* forkBackground(
        validationMutex
          .withPermit(
            runValidationCommands({
              projectId: input.projectId,
              workspaceRoot: input.workspaceRoot,
              threadId: input.threadId,
              commands,
            }),
          )
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Monitoring: validation run failed", {
                projectId: input.projectId,
                cause: conciseCause(cause),
              }),
            ),
            Effect.ensuring(
              Effect.sync(() => {
                monitor.regressionInFlight = false;
              }),
            ),
          ),
      );
    },
  );

  /** The URL whose response time stands for a target's latency, if it has one. */
  function probeUrlFor(
    target: WorkspaceMonitoringTarget,
    programs: ReadonlyArray<WorkspaceProgram>,
  ): string | null {
    if (target.kind === "url") return target.url ?? null;
    if (target.kind !== "program") return null;
    const check = programs.find((program) => program.id === target.programId)?.healthCheck;
    return check?.kind === "http" ? check.url : null;
  }

  /**
   * Read what each `log` target's file gained since the last tick and keep the
   * lines that match its patterns. The first sight of a file only records its
   * size — history is not replayed — and a file that shrank (rotation) starts
   * over from zero. This is the server-side replacement for a seat's own
   * `tail -F | grep` Monitor loop: it needs no provider session and survives
   * restarts because the plan, not the seat, owns it.
   */
  const tailLogs = Effect.fn("WorkspaceMonitoringReactor.tailLogs")(function* (input: {
    readonly plan: WorkspaceMonitoringPlan;
    readonly workspaceRoot: string;
    readonly logs: ProjectMonitor["logs"];
    readonly nowMs: number;
  }) {
    const byPath = new Map<string, RegExp[]>();
    for (const target of input.plan.targets) {
      if (target.kind !== "log" || target.path === undefined) continue;
      const resolved = resolveLogPath(path, target.path, input.workspaceRoot);
      const list = byPath.get(resolved) ?? [];
      list.push(...compileLogPatterns(target.patterns));
      byPath.set(resolved, list);
    }
    // Paths that left the plan stop being tracked.
    for (const path of [...input.logs.keys()]) if (!byPath.has(path)) input.logs.delete(path);
    if (byPath.size === 0) return;
    yield* Effect.forEach(
      [...byPath],
      ([filePath, patterns]) =>
        Effect.gen(function* () {
          let state = input.logs.get(filePath);
          const stat = yield* fileSystem.stat(filePath).pipe(Effect.option);
          if (Option.isNone(stat)) {
            if (state !== undefined) state.lastError = "파일을 읽을 수 없습니다";
            return;
          }
          const size = Number(stat.value.size);
          if (state === undefined) {
            state = { offset: size, matches: [], lastError: null };
            input.logs.set(filePath, state);
            return;
          }
          state.lastError = null;
          if (size < state.offset) state.offset = 0;
          if (size === state.offset) return;
          const start = state.offset;
          const end = Math.min(size, start + LOG_READ_CAP_BYTES);
          const chunk = yield* Effect.scoped(
            Effect.gen(function* () {
              const file = yield* fileSystem.open(filePath, { flag: "r" });
              yield* file.seek(FileSystem.Size(start), "start");
              const bytes = yield* file.readAlloc(FileSystem.Size(end - start));
              return Option.match(bytes, {
                onNone: () => "",
                onSome: (buffer) => new TextDecoder().decode(buffer),
              });
            }),
          ).pipe(Effect.option);
          if (Option.isNone(chunk)) {
            state.lastError = "파일을 읽을 수 없습니다";
            return;
          }
          // Keep a trailing partial line for the next tick.
          const lastNewline = chunk.value.lastIndexOf("\n");
          const complete = lastNewline === -1 ? "" : chunk.value.slice(0, lastNewline + 1);
          state.offset = start + new TextEncoder().encode(complete).byteLength;
          if (end === size && lastNewline === -1 && end - start > LOG_LINE_MAX_CHARS * 4) {
            // A very long line with no newline yet: skip it rather than stall.
            state.offset = end;
          }
          for (const raw of complete.split("\n")) {
            const line = raw.replace(/\r$/, "");
            if (line.length === 0 || !patterns.some((pattern) => pattern.test(line))) continue;
            state.matches.push({ at: input.nowMs, line: line.slice(0, LOG_LINE_MAX_CHARS) });
          }
          const cutoff = input.nowMs - LOG_MATCH_RETAIN_MS;
          while (state.matches.length > 0 && state.matches[0]!.at < cutoff) state.matches.shift();
          if (state.matches.length > LOG_MATCH_KEEP) {
            state.matches.splice(0, state.matches.length - LOG_MATCH_KEEP);
          }
        }),
      { concurrency: 4, discard: true },
    );
  });

  /**
   * One GET per probed URL per evaluation, concurrently, bounded to 5s each.
   * Only URLs some metric actually reads are probed, so a plan without url or
   * latency metrics costs nothing here.
   */
  const probeUrls = Effect.fn("WorkspaceMonitoringReactor.probeUrls")(function* (input: {
    readonly plan: WorkspaceMonitoringPlan;
    readonly programs: ReadonlyArray<WorkspaceProgram>;
    readonly probes: ProjectMonitor["probes"];
  }) {
    const urls = new Set<string>();
    for (const metric of input.plan.metrics) {
      const target = input.plan.targets[metric.targetIndex];
      if (target === undefined) continue;
      if (metric.metric === "latency" || (metric.metric === "health" && target.kind === "url")) {
        const url = probeUrlFor(target, input.programs);
        if (url !== null) urls.add(url);
      }
    }
    if (urls.size === 0) return;
    yield* Effect.forEach(
      [...urls],
      (url) =>
        Effect.gen(function* () {
          const startedAt = yield* Clock.currentTimeMillis;
          const ok = yield* httpClient.execute(HttpClientRequest.get(url)).pipe(
            Effect.flatMap((response) =>
              response.stream.pipe(
                Stream.take(1),
                Stream.runDrain,
                Effect.as(response.status < 500),
              ),
            ),
            Effect.timeoutOption(PROBE_TIMEOUT),
            Effect.map(Option.getOrElse(() => false)),
            Effect.catch(() => Effect.succeed(false)),
          );
          const latencyMs = (yield* Clock.currentTimeMillis) - startedAt;
          const previous = input.probes.get(url) ?? { consecutiveFailures: 0, latencyMs: null };
          input.probes.set(url, {
            consecutiveFailures: ok ? 0 : previous.consecutiveFailures + 1,
            latencyMs: ok ? latencyMs : null,
          });
        }),
      { concurrency: 4, discard: true },
    );
  });

  const evaluateProject = Effect.fn("WorkspaceMonitoringReactor.evaluateProject")(
    function* (input: {
      readonly projectId: ProjectId;
      readonly projectTitle: string;
      readonly threadId: ThreadId;
      readonly settings: WorkspaceMonitoringSettings;
      readonly plan: WorkspaceMonitoringPlan;
      readonly workspaceRoot: string;
    }) {
      const monitor = monitorFor(input.projectId);
      const now = yield* nowIso;
      const nowMs = Date.parse(now);
      const [snapshot, programs, runs, incidents] = yield* Effect.all([
        telemetry.latest,
        programRepository.listPrograms(input.projectId),
        programRepository.listRuns({ projectId: input.projectId, limit: 50 }),
        programRepository.listIncidents({
          projectId: input.projectId,
          statuses: ["open", "diagnosing", "awaiting-user"],
          limit: 20,
        }),
      ]);
      // One read per evaluation, sized to the longest self-server window in
      // the plan (the event-loop histogram resets on read).
      const selfWindowMin = Math.max(
        1,
        ...input.plan.metrics
          .filter((metric) => input.plan.targets[metric.targetIndex]?.kind === "self-server")
          .map((metric) => metric.windowMin),
      );
      const context: SampleContext = {
        telemetry: snapshot,
        programs,
        runs,
        openIncidents: incidents,
        selfSignals: selfSignals.read(selfWindowMin, nowMs),
        regression: monitor.regression,
        probes: monitor.probes,
        logs: monitor.logs,
        workspaceRoot: input.workspaceRoot,
        nowMs,
      };
      yield* probeUrls({ plan: input.plan, programs, probes: monitor.probes });
      yield* tailLogs({
        plan: input.plan,
        workspaceRoot: input.workspaceRoot,
        logs: monitor.logs,
        nowMs,
      });
      if (input.plan.metrics.some((metric) => metric.metric === "regression")) {
        yield* pollForCodeChanges({
          projectId: input.projectId,
          workspaceRoot: input.workspaceRoot,
          threadId: input.threadId,
          programs,
          nowMs,
        });
      }

      const fired: Array<{ readonly metricIndex: number; readonly finding: MonitoringFinding }> =
        [];
      input.plan.metrics.forEach((metric, metricIndex) => {
        const target = input.plan.targets[metric.targetIndex];
        if (target === undefined) return;
        const value = sampleMetric(target, metric, context);
        if (value === null) return;
        // A restarted program is a new series: mixing the old process's
        // samples (or its absence) with the new one's warm-up reads as a
        // memory climb that never happened. Key the ring by process identity
        // so trends start over with the process; self targets key by kind.
        const ringKey = `${metric.targetIndex}|${metric.metric}|${targetIdentity(target, context)}`;
        let ring = monitor.rings.get(ringKey);
        if (ring === undefined) {
          ring = new SampleRing(RING_CAPACITY);
          monitor.rings.set(ringKey, ring);
          for (const key of monitor.rings.keys()) {
            if (key !== ringKey && key.startsWith(`${metric.targetIndex}|${metric.metric}|`)) {
              monitor.rings.delete(key);
            }
          }
        }
        ring.push({ at: nowMs, value });
        const verdict = evaluateTrend(metric, ring, nowMs);
        if (verdict === null || !verdict.anomalous) return;
        const fingerprint = `${metric.targetIndex}|${metric.metric}|${verdict.direction}`;
        // A condition that simply persists (a program that stays down) is
        // re-reported at most every 30 minutes — or the metric's own window if
        // that is longer — so the thread does not fill with the same finding.
        const lastFired = monitor.firedAt.get(fingerprint);
        const cooldownMs = Math.max(metric.windowMin, REPEAT_REPORT_MIN_MINUTES) * 60_000;
        if (lastFired !== undefined && nowMs - lastFired < cooldownMs) return;
        fired.push({
          metricIndex,
          finding: {
            fingerprint,
            targetLabel: target.label,
            programId: target.programId ?? null,
            metric,
            observed:
              metric.metric === "regression" && monitor.regression !== null
                ? verdict.observed + "\n" + monitor.regression.detail
                : metric.metric === "log-matches"
                  ? verdict.observed +
                    "\n" +
                    (logMatchesFor(target, metric.windowMin, context) ?? [])
                      .slice(-8)
                      .map((match) => `  ${match.line}`)
                      .join("\n")
                  : verdict.observed,
            observedAt: now,
          },
        });
      });
      if (fired.length === 0) return;

      const permissions = yield* readPermissions;
      const executed =
        input.settings.autonomy === "playbooks" && permissions.monitoringAutoActions
          ? yield* executePlaybooks(input.projectId, input.plan, fired, incidents)
          : [];

      const budget = monitoringTurnBudget(input.settings, now);
      if (!permissions.autoDiagnosis || budget.remainingHour === 0 || budget.remainingDay === 0) {
        // Held findings are still "seen" for cooldown purposes so a dry budget
        // does not turn into a flood the moment it refills.
        for (const entry of fired) monitor.firedAt.set(entry.finding.fingerprint, nowMs);
        if (nowMs - monitor.lastHeldNoticeAt >= HELD_NOTICE_INTERVAL_MS) {
          monitor.lastHeldNoticeAt = nowMs;
          yield* appendNotice({
            threadId: input.threadId,
            kind: "monitoring.finding.held",
            summary: !permissions.autoDiagnosis
              ? `이상 ${fired.length}건을 감지했지만 권한 설정에서 자동 AI 진단이 꺼져 있어 보고 턴을 시작하지 않았습니다: ${fired.map((entry) => entry.finding.targetLabel).join(", ")}`
              : `이상 ${fired.length}건을 감지했지만 AI 턴 예산이 소진되어 보류했습니다: ${fired.map((entry) => entry.finding.targetLabel).join(", ")}`,
          });
        }
        return;
      }

      for (const entry of fired) monitor.firedAt.set(entry.finding.fingerprint, nowMs);
      yield* updateRuntime(input.projectId, {
        turnLog: [...budget.trimmedLog, now].slice(-60),
        lastCheckedAt: now,
      });
      monitor.lastCheckedWriteAt = nowMs;
      const prompt = buildMonitoringFindingPrompt({
        projectTitle: input.projectTitle,
        findings: fired.map((entry) => entry.finding),
        executedPlaybooks: executed,
        autonomy: input.settings.autonomy,
        budget: {
          ...budget,
          remainingHour: budget.remainingHour - 1,
          remainingDay: budget.remainingDay - 1,
        },
      });
      monitor.turnInFlight = true;
      const plan = input.plan;
      yield* forkBackground(
        runAutomationTurn(input.projectId, input.threadId, prompt).pipe(
          // "답하면 실행": the turn settles only after the person answered the
          // AI's question; whatever action the AI relayed is executed here
          // with the same commands the control-center buttons dispatch.
          Effect.flatMap((output) =>
            output === null
              ? Effect.void
              : executeRequestedActions(input.projectId, input.threadId, plan, output),
          ),
          Effect.catchCause((cause) =>
            Effect.logWarning("Monitoring: finding turn failed", {
              projectId: input.projectId,
              cause: conciseCause(cause),
            }),
          ),
          Effect.ensuring(
            Effect.sync(() => {
              monitor.turnInFlight = false;
            }),
          ),
        ),
      );
    },
  );

  const checkProject = Effect.fn("WorkspaceMonitoringReactor.checkProject")(function* (
    projectId: ProjectId,
  ) {
    const row = yield* projectRepository.getById({ projectId });
    if (Option.isNone(row) || row.value.deletedAt !== null) {
      enabledProjects.delete(projectId);
      monitors.delete(projectId);
      return;
    }
    const project = row.value;
    const settings = project.workspaceControl.monitoring;
    if (!settings.enabled) {
      enabledProjects.delete(projectId);
      monitors.delete(projectId);
      return;
    }
    const monitor = monitorFor(projectId);
    monitor.externalProcesses =
      settings.planStatus === "approved" ? externalProcessesOf(settings.plan) : [];
    const nowMs = Date.parse(yield* nowIso);
    if (nowMs - monitor.lastEvaluatedAt < settings.checkIntervalSec * 1_000) return;
    monitor.lastEvaluatedAt = nowMs;

    const threadId = yield* ensureThread(projectId, project.title, settings);
    if (threadId === null) return;

    switch (settings.planStatus) {
      case "none":
        if (!monitor.proposalInFlight) {
          yield* forkBackground(
            propose({
              projectId,
              projectTitle: project.title,
              workspaceRoot: project.workspaceRoot,
              threadId,
              settings,
            }).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("Monitoring: proposal failed", {
                  projectId,
                  cause: conciseCause(cause),
                }),
              ),
            ),
          );
        }
        return;
      case "proposed":
        return;
      case "stale":
        if (!monitor.staleNoticed) {
          monitor.staleNoticed = true;
          yield* appendNotice({
            threadId,
            kind: "monitoring.plan.stale",
            summary: MONITORING_STALE_NOTICE,
          });
        }
        return;
      case "approved": {
        monitor.staleNoticed = false;
        if (settings.plan === null || monitor.turnInFlight) return;
        yield* evaluateProject({
          projectId,
          projectTitle: project.title,
          threadId,
          settings,
          plan: settings.plan,
          workspaceRoot: project.workspaceRoot,
        });
        if (nowMs - monitor.lastCheckedWriteAt >= LAST_CHECKED_WRITE_INTERVAL_MS) {
          monitor.lastCheckedWriteAt = nowMs;
          yield* updateRuntime(projectId, {
            lastCheckedAt: DateTime.formatIso(DateTime.makeUnsafe(nowMs)),
          });
        }
        return;
      }
    }
  });

  const reloadEnabledProjects = projectRepository.listAll().pipe(
    Effect.map((rows) => {
      enabledProjects.clear();
      for (const row of rows) {
        if (row.deletedAt === null && row.workspaceControl.monitoring.enabled) {
          enabledProjects.add(row.projectId);
        }
      }
    }),
    Effect.catchCause((cause) =>
      Effect.logWarning("Monitoring: could not list projects", { cause: conciseCause(cause) }),
    ),
  );

  // The sidecar only samples subtrees of its roots, so a `process` target
  // outside T3 Code's tree is invisible until registered. Pushed as one union
  // across projects whenever it changes; empty once the last monitor is off.
  let pushedExternalKey = "";
  const syncExternalProcesses = Effect.gen(function* () {
    const byPid = new Map<number, ResourceMonitorExternalProcess>();
    for (const monitor of monitors.values()) {
      for (const process of monitor.externalProcesses) byPid.set(process.pid, process);
    }
    const processes = [...byPid.values()].toSorted((left, right) => left.pid - right.pid);
    const key = processes.map((p) => `${p.pid}:${p.startTimeMs ?? ""}`).join(",");
    if (key === pushedExternalKey) return;
    pushedExternalKey = key;
    yield* telemetry.setMonitoredProcesses(processes);
  });

  const tickUnlocked = Effect.gen(function* () {
    if (enabledProjects.size === 0) {
      yield* syncExternalProcesses;
      yield* releaseTelemetry;
      return;
    }
    yield* ensureTelemetry;
    for (const projectId of Array.from(enabledProjects)) {
      yield* checkProject(projectId).pipe(
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
          return Effect.logWarning("Monitoring: project check failed", {
            projectId,
            cause: conciseCause(cause),
          });
        }),
      );
    }
    yield* syncExternalProcesses;
  });
  const tick = tickMutex
    .withPermit(tickUnlocked)
    .pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning("Monitoring tick failed", { cause: conciseCause(cause) }),
      ),
    );

  // Events only flip in-memory state; nothing heavy runs on the event path.
  const onEvent = (event: OrchestrationEvent): Effect.Effect<void> => {
    switch (event.type) {
      case "project.workspace-control-updated": {
        const monitoring = event.payload.workspaceControl.monitoring;
        if (monitoring.enabled) {
          enabledProjects.add(event.payload.projectId);
          // A fresh enable or 다시 분석 should be picked up on the next tick.
          const monitor = monitorFor(event.payload.projectId);
          if (monitoring.planStatus === "none") monitor.lastEvaluatedAt = 0;
        } else {
          enabledProjects.delete(event.payload.projectId);
          monitors.delete(event.payload.projectId);
        }
        return Effect.void;
      }
      case "project.deleted":
        enabledProjects.delete(event.payload.projectId);
        monitors.delete(event.payload.projectId);
        return Effect.void;
      case "project.program-upserted":
      case "project.program-removed": {
        const projectId =
          event.type === "project.program-upserted"
            ? event.payload.program.projectId
            : event.payload.projectId;
        if (!enabledProjects.has(projectId)) return Effect.void;
        const monitor = monitorFor(projectId);
        const programId =
          event.type === "project.program-upserted"
            ? event.payload.program.id
            : event.payload.programId;
        const known = monitor.knownProgramIds;
        const setChanged =
          event.type === "project.program-removed" || known === null || !known.has(programId);
        const next = new Set(known ?? []);
        if (event.type === "project.program-removed") next.delete(programId);
        else next.add(programId);
        monitor.knownProgramIds = next;
        // Only a real change to the program SET stales the plan; edits do not.
        return known !== null && setChanged
          ? updateRuntime(projectId, { planStatus: "stale" }).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("Monitoring: could not mark plan stale", {
                  projectId,
                  cause: conciseCause(cause),
                }),
              ),
            )
          : Effect.void;
      }
      default:
        return Effect.void;
    }
  };

  const seedKnownPrograms = Effect.forEach(
    [...enabledProjects],
    (projectId) =>
      programRepository.listPrograms(projectId).pipe(
        Effect.map((programs) => {
          monitorFor(projectId).knownProgramIds = new Set(programs.map((program) => program.id));
        }),
        Effect.catchCause(() => Effect.void),
      ),
    { discard: true },
  );

  const start: WorkspaceMonitoringReactorShape["start"] = Effect.fn("start")(function* () {
    runScope = yield* Effect.scope;
    yield* forkParked(Stream.runForEach(orchestrationEngine.streamDomainEvents, onEvent), {
      startImmediately: true,
    });
    yield* reloadEnabledProjects;
    yield* seedKnownPrograms;
    yield* forkParked(Effect.forever(tick.pipe(Effect.andThen(Effect.sleep(BASE_TICK)))));
  });

  const drain = tickMutex.withPermit(Effect.void);
  return { start, tick, drain } satisfies WorkspaceMonitoringReactorShape;
});

export const WorkspaceMonitoringReactorLive = Layer.effect(
  WorkspaceMonitoringReactor,
  makeWorkspaceMonitoringReactor,
);
