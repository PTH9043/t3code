import * as NodeCrypto from "node:crypto";
import * as NodeNet from "node:net";

import {
  CommandId,
  MessageId,
  ThreadId,
  WorkspaceCollaborationRunId,
  WorkspaceIncidentId,
  WorkspaceProgramId,
  WorkspaceProgramRunId,
  type OrchestrationEvent,
  type ProjectId,
  type WorkspaceCollaborationRun,
  type WorkspaceHealthCheckFailure,
  type WorkspaceIncident,
  type WorkspaceProgram,
  type WorkspaceProgramCandidate,
  type WorkspaceProgramHealthCheck,
  type WorkspaceProgramIntegrity,
  type WorkspaceProgramRun,
} from "@t3tools/contracts";
import { makeDrainableWorker, type DrainableWorker } from "@t3tools/shared/DrainableWorker";
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import { ProjectionWorkspaceAgentRoleRepository } from "../../persistence/Services/ProjectionWorkspaceAgentRoles.ts";
import { ProjectionWorkspaceCollaborationRunRepository } from "../../persistence/Services/ProjectionWorkspaceCollaborationRuns.ts";
import { ProjectionWorkspaceProgramRepository } from "../../persistence/Services/ProjectionWorkspacePrograms.ts";
import { forkParked } from "../../serverActivation.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import * as PtyAdapter from "../../terminal/PtyAdapter.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { OrchestrationTurnWait } from "../Services/OrchestrationTurnWait.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  HUB_COMMAND_ENV,
  HUB_YIELD_EXIT_CODE,
  hubEnvironment,
  windowsJobGuardCandidates,
} from "../hubMemoryGuard.ts";
import {
  buildWorkspaceProgramIntegrityTask,
  evaluateWorkspaceProgramIntegrityRun,
} from "../workspaceProgramIntegrity.ts";
import {
  WorkspaceProgramSupervisor,
  type WorkspaceProgramSupervisorShape,
} from "../Services/WorkspaceProgramSupervisor.ts";

const MAX_LOG_CHARS = 65_536;
const LOG_PERSIST_INTERVAL_MS = 1_000;
const STOP_SIGNAL_GRACE = Duration.seconds(2);
const STOP_TIMEOUT = Duration.seconds(5);
/** How long a program that yielded its hub slot waits before it is started again. */
const HUB_YIELD_RETRY = Duration.seconds(60);
const ANSI_PATTERN = /\u001B\[[0-?]*[ -/]*[@-~]/g;
const SECRET_NAME_PATTERN = /(token|secret|password|passwd|api.?key|auth|cookie)/i;

export function isWorkspaceRepairRunApproved(
  run: Pick<WorkspaceCollaborationRun, "graph" | "finalOutput">,
): boolean {
  if (run.graph === null) {
    return run.finalOutput?.includes("[T3_RESTART_APPROVED]") === true;
  }
  const nodes = new Map(run.graph.nodes.map((node) => [String(node.id), node]));
  const activeValidations = run.graph.nodes.filter((node) => {
    if (node.kind !== "validation" || node.validation === null) return false;
    const target = nodes.get(String(node.validation.targetNodeId));
    return target?.status === "completed";
  });
  return (
    run.graph.repairApproved === true &&
    run.graph.overallConfidence !== null &&
    run.graph.overallConfidence !== "low" &&
    activeValidations.length > 0 &&
    activeValidations.every(
      (node) => node.validation?.verdict === "pass" && node.validation.confidence !== "low",
    )
  );
}

const PackageManifest = Schema.Struct({
  name: Schema.optionalKey(Schema.String),
  scripts: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});
const decodePackageManifest = Schema.decodeUnknownEffect(Schema.fromJsonString(PackageManifest));

export class WorkspaceHealthCheckError extends Data.TaggedError("WorkspaceHealthCheckError")<{
  readonly message: string;
  readonly reason: "timeout" | "connection" | "unexpected-status";
  readonly cause?: unknown;
}> {}

/**
 * A timed-out probe that took this much longer than its limit was not timed
 * by a running event loop: the loop was stalled (a dev build, a GC pause) and
 * the timer fired late, before any answer that arrived meanwhile could be
 * seen. Such a result says nothing about the program.
 */
const HEALTH_CHECK_STALL_TOLERANCE_MS = 1_500;

export function classifyHealthFailure(input: {
  readonly failure: WorkspaceHealthCheckError;
  readonly timeoutSeconds: number;
  readonly elapsedMs: number;
  readonly checkedAt: string;
}): WorkspaceHealthCheckFailure {
  const limitMs = input.timeoutSeconds * 1_000;
  const stalled =
    input.failure.reason === "timeout" &&
    input.elapsedMs > limitMs + HEALTH_CHECK_STALL_TOLERANCE_MS;
  const seconds = (ms: number) => `${(ms / 1_000).toFixed(1)}초`;
  const causeMessage =
    input.failure.cause instanceof Error && input.failure.cause.message
      ? `: ${input.failure.cause.message.slice(0, 300)}`
      : "";
  const detail = stalled
    ? `${input.failure.message} — 한도 ${seconds(limitMs)}인데 검사에 ${seconds(input.elapsedMs)}가 걸렸습니다. 감시하는 서버 자체가 멈춰 있던 구간이라 프로그램 상태로 보지 않습니다.`
    : input.failure.reason === "timeout"
      ? `${input.failure.message} (한도 ${seconds(limitMs)}, 경과 ${seconds(input.elapsedMs)})`
      : `${input.failure.message}${causeMessage} (경과 ${seconds(input.elapsedMs)})`;
  return {
    reason: stalled ? "inconclusive" : input.failure.reason,
    detail,
    elapsedMs: Math.max(0, Math.round(input.elapsedMs)),
    checkedAt: input.checkedAt,
  };
}

type ProcessExit = PtyAdapter.PtyExitEvent;

interface LiveProgram {
  readonly program: WorkspaceProgram;
  readonly process: PtyAdapter.PtyProcess;
  readonly exit: Deferred.Deferred<ProcessExit>;
  run: WorkspaceProgramRun;
  intentionalStop: boolean;
  lastPersistedAt: number;
  logFlushScheduled: boolean;
  unsubscribeData: () => void;
  unsubscribeExit: () => void;
}

type WorkItem =
  | {
      readonly type: "start";
      readonly program: WorkspaceProgram;
      readonly incidentId?: WorkspaceIncidentId;
    }
  | { readonly type: "stop"; readonly projectId: ProjectId; readonly programId: WorkspaceProgramId }
  | { readonly type: "hub-ready"; readonly key: string; readonly runId: WorkspaceProgramRunId }
  | { readonly type: "program-updated"; readonly program: WorkspaceProgram }
  | { readonly type: "stop-project"; readonly projectId: ProjectId }
  | {
      readonly type: "restart";
      readonly program: WorkspaceProgram;
      readonly incidentId?: WorkspaceIncidentId;
    }
  | { readonly type: "output"; readonly key: string; readonly pid: number; readonly data: string }
  | { readonly type: "flush-logs"; readonly key: string; readonly runId: WorkspaceProgramRunId }
  | {
      readonly type: "exit";
      readonly key: string;
      readonly pid: number;
      readonly event: ProcessExit;
    }
  | { readonly type: "health"; readonly key: string; readonly pid: number }
  | {
      readonly type: "repair";
      readonly projectId: ProjectId;
      readonly incidentId: WorkspaceIncidentId;
      readonly instruction: string;
    }
  | {
      readonly type: "resolve";
      readonly projectId: ProjectId;
      readonly incidentId: WorkspaceIncidentId;
    }
  | {
      readonly type: "repair-run";
      readonly projectId: ProjectId;
      readonly runId: WorkspaceCollaborationRunId;
    }
  | {
      readonly type: "integrity-start";
      readonly projectId: ProjectId;
      readonly programId: WorkspaceProgramId;
    }
  | {
      readonly type: "integrity-stop";
      readonly projectId: ProjectId;
      readonly programId: WorkspaceProgramId;
    }
  | {
      readonly type: "integrity-cycle";
      readonly projectId: ProjectId;
      readonly programId: WorkspaceProgramId;
    }
  | {
      readonly type: "integrity-run";
      readonly projectId: ProjectId;
      readonly programId: WorkspaceProgramId;
      readonly runId: WorkspaceCollaborationRunId;
    };

const keyOf = (projectId: ProjectId, programId: WorkspaceProgramId) => `${projectId}:${programId}`;
const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

function conciseCause(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause);
  return (error instanceof Error ? error.message : String(error)).slice(0, 4_000);
}

function conciseFailure(failure: unknown): string {
  return (failure instanceof Error ? failure.message : String(failure)).slice(0, 4_000);
}

function normalizeLog(data: string): string {
  return data.replace(ANSI_PATTERN, "").replaceAll("\u0000", "");
}

function appendLog(current: string, next: string): string {
  const combined = current + normalizeLog(next);
  return combined.length <= MAX_LOG_CHARS ? combined : combined.slice(-MAX_LOG_CHARS);
}

function matchesErrorPattern(pattern: string, text: string): boolean {
  try {
    return new RegExp(pattern, "i").test(text);
  } catch {
    return text.toLowerCase().includes(pattern.toLowerCase());
  }
}

function slug(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 56);
  return normalized.length > 0 ? normalized : "program";
}

function fingerprint(parts: ReadonlyArray<string>): string {
  return NodeCrypto.createHash("sha256").update(parts.join("\n")).digest("hex");
}

function shellFor(platform: NodeJS.Platform, command: string): { shell: string; args: string[] } {
  if (platform === "win32") {
    return { shell: process.env.ComSpec?.trim() || "cmd.exe", args: ["/d", "/s", "/c", command] };
  }
  return { shell: process.env.SHELL?.trim() || "/bin/sh", args: ["-lc", command] };
}

function programEnvironment(
  program: WorkspaceProgram,
  hubVariables: Readonly<Record<string, string>> = {},
): NodeJS.ProcessEnv {
  const retained = [
    "PATH",
    "Path",
    "PATHEXT",
    "SystemRoot",
    "ComSpec",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "HOME",
    "SHELL",
    "LANG",
    "LC_ALL",
    "TERM",
  ];
  const names = new Set([...retained, ...program.environmentVariableNames]);
  return {
    ...Object.fromEntries(
      [...names].flatMap((name) => {
        const value = process.env[name];
        return value === undefined ? [] : [[name, value]];
      }),
    ),
    // Hub-computed values (shared dataset paths, commit cap) are the one thing
    // the allowlist cannot express: they exist nowhere in the server's own env.
    ...hubVariables,
  };
}

function redactSecrets(value: string, program: WorkspaceProgram): string {
  const values = Object.entries(process.env).flatMap(([name, secret]) =>
    secret !== undefined &&
    secret.length >= 4 &&
    (SECRET_NAME_PATTERN.test(name) || program.environmentVariableNames.includes(name))
      ? [secret]
      : [],
  );
  return values.reduce((text, secret) => text.replaceAll(secret, "[비밀 값 숨김]"), value);
}

function healthCheckEffect(
  check: WorkspaceProgramHealthCheck,
  httpClient: HttpClient.HttpClient,
): Effect.Effect<string, WorkspaceHealthCheckError> {
  if (check.kind === "http") {
    return httpClient.execute(HttpClientRequest.get(check.url)).pipe(
      Effect.flatMap((response) =>
        response.stream.pipe(Stream.take(1), Stream.runDrain, Effect.as(response.status)),
      ),
      Effect.timeoutOption(Duration.seconds(check.timeoutSeconds)),
      Effect.mapError(
        (cause) =>
          new WorkspaceHealthCheckError({
            message: "HTTP 상태검사 연결 실패",
            reason: "connection",
            cause,
          }),
      ),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new WorkspaceHealthCheckError({
                message: "HTTP 상태검사 시간 초과",
                reason: "timeout",
              }),
            ),
          onSome: (status) =>
            status >= check.expectedStatusMin && status <= check.expectedStatusMax
              ? Effect.succeed(`HTTP ${status}`)
              : Effect.fail(
                  new WorkspaceHealthCheckError({
                    message: `예상하지 않은 HTTP ${status}`,
                    reason: "unexpected-status",
                  }),
                ),
        }),
      ),
    );
  }
  return Effect.callback<string, WorkspaceHealthCheckError>((resume) => {
    const socket = NodeNet.createConnection({ host: check.host, port: check.port });
    let settled = false;
    const done = (effect: Effect.Effect<string, WorkspaceHealthCheckError>) => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      resume(effect);
    };
    socket.setTimeout(check.timeoutSeconds * 1_000);
    socket.once("connect", () => done(Effect.succeed(`TCP ${check.host}:${check.port}`)));
    socket.once("timeout", () =>
      done(
        Effect.fail(
          new WorkspaceHealthCheckError({ message: "TCP 상태검사 시간 초과", reason: "timeout" }),
        ),
      ),
    );
    socket.once("error", (cause) =>
      done(
        Effect.fail(
          new WorkspaceHealthCheckError({
            message: "TCP 상태검사 연결 실패",
            reason: "connection",
            cause,
          }),
        ),
      ),
    );
    return Effect.sync(() => socket.destroy());
  });
}

export const makeWorkspaceProgramSupervisor = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const turnWait = yield* OrchestrationTurnWait;
  const snapshotQuery = yield* ProjectionSnapshotQuery;
  const programRepository = yield* ProjectionWorkspaceProgramRepository;
  const roleRepository = yield* ProjectionWorkspaceAgentRoleRepository;
  const collaborationRepository = yield* ProjectionWorkspaceCollaborationRunRepository;
  const httpClient = yield* HttpClient.HttpClient;
  const ptyAdapter = yield* PtyAdapter.PtyAdapter;
  const serverSettings = yield* ServerSettingsService;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcessPlatform;
  const architecture = yield* HostProcessArchitecture;
  const crypto = yield* Crypto.Crypto;
  const randomUUID = crypto.randomUUIDv4;
  const context = yield* Effect.context<never>();
  const runFork = Effect.runForkWith(context);
  const livePrograms = new Map<string, LiveProgram>();
  let shuttingDown = false;
  /** Starts waiting for a hub concurrency slot, keyed like livePrograms. */
  const queuedStarts = new Map<
    string,
    {
      program: WorkspaceProgram;
      incidentId: WorkspaceIncidentId | undefined;
      run: WorkspaceProgramRun;
      ready: boolean;
    }
  >();
  const incidentByFingerprint = new Map<string, WorkspaceIncident>();
  const restartIncidentByProgram = new Map<string, WorkspaceIncidentId>();
  /** Last time each (program, fingerprint) pair opened an incident, to coalesce repeats. */
  const incidentCoalesceAt = new Map<string, number>();
  const integrityProgramByRun = new Map<
    WorkspaceCollaborationRunId,
    { readonly projectId: ProjectId; readonly programId: WorkspaceProgramId }
  >();
  const readPermissions = serverSettings.getSettings.pipe(
    Effect.map((settings) => settings.workspaceProgramPermissions),
    Effect.catchCause((cause) =>
      Effect.logWarning("Workspace program permissions could not be read", {
        cause: conciseCause(cause),
      }).pipe(
        Effect.as({
          manualControl: false,
          collectLogs: false,
          autoStart: false,
          autoDiagnosis: false,
          autoRestartAfterRepair: false,
          monitoringAutoActions: false,
        } as const),
      ),
    ),
  );

  const dispatchRun = Effect.fn("WorkspaceProgramSupervisor.dispatchRun")(function* (
    run: WorkspaceProgramRun,
  ) {
    yield* orchestrationEngine.dispatch({
      type: "project.program.run.update",
      commandId: CommandId.make(yield* randomUUID),
      run,
    });
  });

  const dispatchIntegrity = Effect.fn("WorkspaceProgramSupervisor.dispatchIntegrity")(function* (
    projectId: ProjectId,
    programId: WorkspaceProgramId,
    integrity: WorkspaceProgramIntegrity,
  ) {
    yield* orchestrationEngine.dispatch({
      type: "project.program.integrity.update",
      commandId: CommandId.make(yield* randomUUID),
      projectId,
      programId,
      integrity,
    });
  });

  const updateProgramIntegrity = Effect.fn("WorkspaceProgramSupervisor.updateProgramIntegrity")(
    function* (program: WorkspaceProgram, patch: Partial<WorkspaceProgramIntegrity>) {
      const projected = yield* programRepository.getProgram({
        projectId: program.projectId,
        programId: program.id,
      });
      const current = Option.getOrElse(projected, () => program);
      const updatedAt = yield* nowIso;
      const integrity = {
        ...current.integrity,
        ...patch,
        updatedAt,
      } satisfies WorkspaceProgramIntegrity;
      yield* dispatchIntegrity(current.projectId, current.id, integrity);
      return { ...current, integrity } satisfies WorkspaceProgram;
    },
  );

  const dispatchIncident = Effect.fn("WorkspaceProgramSupervisor.dispatchIncident")(function* (
    incident: WorkspaceIncident,
  ) {
    yield* orchestrationEngine.dispatch({
      type: "project.program.incident.upsert",
      commandId: CommandId.make(yield* randomUUID),
      incident,
    });
  });

  const updateIncident = Effect.fn("WorkspaceProgramSupervisor.updateIncident")(function* (
    incident: WorkspaceIncident,
    patch: Partial<WorkspaceIncident>,
  ) {
    const projected = yield* programRepository.getIncident({
      projectId: incident.projectId,
      incidentId: incident.id,
    });
    const current = Option.getOrElse(projected, () => incident);
    if (current.status === "resolved" && patch.status !== "resolved") return current;
    const updatedAt = yield* nowIso;
    const updated = { ...current, ...patch, updatedAt } satisfies WorkspaceIncident;
    incidentByFingerprint.set(
      `${updated.projectId}:${updated.programId}:${updated.fingerprint}`,
      updated,
    );
    yield* dispatchIncident(updated);
    return updated;
  });

  const failRepairVerification = Effect.fn("WorkspaceProgramSupervisor.failRepairVerification")(
    function* (input: {
      readonly projectId: ProjectId;
      readonly incidentId: WorkspaceIncidentId;
      readonly detail: string;
    }) {
      const incident = yield* programRepository.getIncident(input);
      if (Option.isNone(incident)) return;
      yield* updateIncident(incident.value, {
        status: "awaiting-user",
        diagnosis: `${incident.value.diagnosis ?? ""}\n\n재시작 검증 실패: ${input.detail}`.trim(),
      });
      restartIncidentByProgram.delete(keyOf(input.projectId, incident.value.programId));
    },
  );

  const awaitDiagnosisOutput = Effect.fn("WorkspaceProgramSupervisor.awaitDiagnosisOutput")(
    function* (threadId: ThreadId, requestedAtOrAfter?: string) {
      const result = yield* turnWait.waitForSettledTurn({
        threadId,
        ...(requestedAtOrAfter === undefined ? {} : { requestedAtOrAfter }),
      });
      if (result.turn.state !== "completed") {
        return `자동 진단 실패: ${result.thread.session?.lastError ?? "자동 진단 작업이 완료되지 않았습니다."}`;
      }
      const assistantMessageId = result.turn.assistantMessageId;
      const message =
        (assistantMessageId === null
          ? undefined
          : result.thread.messages.find((candidate) => candidate.id === assistantMessageId)) ??
        result.thread.messages.filter((candidate) => candidate.role === "assistant").at(-1);
      return message?.text.trim() || "진단은 완료됐지만 텍스트 결과가 없습니다.";
    },
  );

  const diagnoseIncident = Effect.fn("WorkspaceProgramSupervisor.diagnoseIncident")(function* (
    incident: WorkspaceIncident,
    program: WorkspaceProgram,
  ) {
    const permissions = yield* readPermissions;
    if (!permissions.autoDiagnosis) {
      yield* updateIncident(incident, {
        status: "awaiting-user",
        diagnosis:
          "권한 설정에서 자동 AI 진단이 꺼져 있습니다. 수집된 증거를 확인한 뒤 수정 작업을 지시할 수 있습니다.",
      });
      return;
    }
    const bindings = yield* roleRepository.listByProjectId(incident.projectId);
    const binding =
      bindings.find((candidate) => candidate.role === "operator" && candidate.enabled) ??
      bindings.find((candidate) => candidate.role === "coordinator" && candidate.enabled);
    if (binding === undefined) {
      yield* updateIncident(incident, {
        status: "awaiting-user",
        diagnosis: "자동 진단을 실행할 운영 담당 또는 조정자 AI 계정이 설정되지 않았습니다.",
      });
      return;
    }
    const threadId = ThreadId.make(yield* randomUUID);
    const diagnosing = yield* updateIncident(incident, {
      status: "diagnosing",
      diagnosisThreadId: threadId,
      diagnosis: null,
    });
    const createdAt = yield* nowIso;
    const prompt = [
      "# 프로그램 오류 자동 진단",
      "읽기 전용으로 진단하세요. 파일을 수정하거나 프로그램을 실행·중지하지 마세요.",
      "관찰된 사실과 추정을 구분하고, 원인 후보·영향·수정 방향·검증 절차를 한국어로 작성하세요.",
      `프로그램: ${program.name}`,
      `실행 명령: ${redactSecrets(program.command, program)}`,
      `오류 종류: ${incident.kind}`,
      `요약: ${incident.summary}`,
      "## 수집된 증거",
      redactSecrets(incident.evidence, program),
    ].join("\n\n");
    yield* orchestrationEngine.dispatch({
      type: "thread.create",
      commandId: CommandId.make(yield* randomUUID),
      threadId,
      projectId: incident.projectId,
      title: `오류 진단 · ${program.name}`,
      modelSelection: binding.modelSelection,
      runtimeMode: "approval-required",
      interactionMode: "plan",
      branch: null,
      worktreePath: null,
      createdAt,
    });
    const turnRequestedAt = yield* nowIso;
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
      modelSelection: binding.modelSelection,
      runtimeMode: "approval-required",
      interactionMode: "plan",
      createdAt: turnRequestedAt,
    });
    const diagnosis = yield* awaitDiagnosisOutput(threadId, turnRequestedAt).pipe(
      Effect.catch((error) => Effect.succeed(`자동 진단 실패: ${String(error)}`)),
    );
    yield* updateIncident(diagnosing, { status: "awaiting-user", diagnosis });
  });

  const resumeIncidentDiagnosis = Effect.fn("WorkspaceProgramSupervisor.resumeIncidentDiagnosis")(
    function* (incident: WorkspaceIncident, program: WorkspaceProgram) {
      if (incident.diagnosisThreadId === null) {
        yield* diagnoseIncident(incident, program);
        return;
      }
      const diagnosis = yield* awaitDiagnosisOutput(incident.diagnosisThreadId).pipe(
        Effect.catch((error) => Effect.succeed(`자동 진단 실패: ${String(error)}`)),
      );
      yield* updateIncident(incident, { status: "awaiting-user", diagnosis });
    },
  );

  const openIncident = Effect.fn("WorkspaceProgramSupervisor.openIncident")(function* (input: {
    readonly program: WorkspaceProgram;
    readonly run: WorkspaceProgramRun | null;
    readonly kind: WorkspaceIncident["kind"];
    readonly severity: WorkspaceIncident["severity"];
    readonly fingerprint: string;
    readonly summary: string;
    readonly evidence: string;
  }) {
    const cacheKey = `${input.program.projectId}:${input.program.id}:${input.fingerprint}`;
    const cached = incidentByFingerprint.get(cacheKey);
    const activeCached = cached?.status === "resolved" ? undefined : cached;
    const projected =
      activeCached === undefined
        ? yield* programRepository.findOpenIncidentByFingerprint({
            projectId: input.program.projectId,
            programId: input.program.id,
            fingerprint: input.fingerprint,
          })
        : Option.some(activeCached);
    const occurredAt = yield* nowIso;
    if (Option.isSome(projected)) {
      const current = projected.value;
      const updated = {
        ...current,
        runId: input.run?.id ?? current.runId,
        severity: input.severity,
        summary: input.summary,
        evidence: input.evidence.slice(-MAX_LOG_CHARS),
        occurrenceCount: current.occurrenceCount + 1,
        lastOccurredAt: occurredAt,
        updatedAt: occurredAt,
      } satisfies WorkspaceIncident;
      incidentByFingerprint.set(cacheKey, updated);
      yield* dispatchIncident(updated);
      return updated;
    }
    const incident: WorkspaceIncident = {
      id: WorkspaceIncidentId.make(yield* randomUUID),
      projectId: input.program.projectId,
      programId: input.program.id,
      runId: input.run?.id ?? null,
      kind: input.kind,
      severity: input.severity,
      status: "open",
      fingerprint: input.fingerprint,
      summary: input.summary,
      evidence: input.evidence.slice(-MAX_LOG_CHARS),
      occurrenceCount: 1,
      firstOccurredAt: occurredAt,
      lastOccurredAt: occurredAt,
      diagnosisThreadId: null,
      diagnosis: null,
      repairRunId: null,
      resolvedAt: null,
      updatedAt: occurredAt,
    };
    incidentByFingerprint.set(cacheKey, incident);
    yield* dispatchIncident(incident);
    yield* forkParked(
      diagnoseIncident(incident, input.program).pipe(
        Effect.catchCause((cause) =>
          updateIncident(incident, {
            status: "awaiting-user",
            diagnosis: `자동 진단 실패: ${conciseCause(cause)}`,
          }).pipe(
            Effect.tap(() =>
              Effect.logWarning("Workspace program automatic diagnosis failed", {
                incidentId: incident.id,
                cause: conciseCause(cause),
              }),
            ),
            Effect.asVoid,
          ),
        ),
      ),
    );
    return incident;
  });

  const persistLiveRun = Effect.fn("WorkspaceProgramSupervisor.persistLiveRun")(function* (
    state: LiveProgram,
  ) {
    if (state.logFlushScheduled) return;
    const at = yield* nowIso;
    const remaining = LOG_PERSIST_INTERVAL_MS - (Date.parse(at) - state.lastPersistedAt);
    if (remaining > 0) {
      state.logFlushScheduled = true;
      yield* forkParked(
        Effect.sleep(Duration.millis(remaining)).pipe(
          Effect.andThen(
            worker.enqueue({
              type: "flush-logs",
              key: keyOf(state.program.projectId, state.program.id),
              runId: state.run.id,
            }),
          ),
        ),
      );
      return;
    }
    state.lastPersistedAt = Date.parse(at);
    state.run = { ...state.run, updatedAt: at };
    yield* dispatchRun(state.run);
  });

  const resolveIncident = Effect.fn("WorkspaceProgramSupervisor.resolveIncident")(function* (
    projectId: ProjectId,
    incidentId: WorkspaceIncidentId,
  ) {
    const option = yield* programRepository.getIncident({ projectId, incidentId });
    if (Option.isNone(option)) return;
    const at = yield* nowIso;
    yield* updateIncident(option.value, { status: "resolved", resolvedAt: at });
    restartIncidentByProgram.delete(keyOf(projectId, option.value.programId));
  });

  let worker: DrainableWorker<WorkItem>;

  const startHealthLoop = (state: LiveProgram) => {
    const check = state.program.healthCheck;
    if (check === null) return Effect.void;
    return forkParked(
      Effect.gen(function* () {
        while (true) {
          yield* Effect.sleep(Duration.seconds(check.intervalSeconds));
          const current = livePrograms.get(keyOf(state.program.projectId, state.program.id));
          if (current === undefined || current.process.pid !== state.process.pid) return;
          yield* worker.enqueue({
            type: "health",
            key: keyOf(state.program.projectId, state.program.id),
            pid: state.process.pid,
          });
        }
      }),
    );
  };

  const queueStart = Effect.fn("WorkspaceProgramSupervisor.queueStart")(function* (
    program: WorkspaceProgram,
    incidentId?: WorkspaceIncidentId,
    ready = true,
  ) {
    const key = keyOf(program.projectId, program.id);
    if (!program.enabled || shuttingDown) return;
    const pending = queuedStarts.get(key);
    if (pending !== undefined) {
      pending.ready = ready;
      pending.program = program;
      pending.incidentId = incidentId;
      return;
    }
    const at = yield* nowIso;
    const run: WorkspaceProgramRun = {
      id: WorkspaceProgramRunId.make(yield* randomUUID),
      projectId: program.projectId,
      programId: program.id,
      status: "starting",
      pid: null,
      startedAt: at,
      stoppedAt: null,
      exitCode: null,
      exitSignal: null,
      healthStatus: "unknown",
      consecutiveHealthFailures: 0,
      lastHealthCheckAt: null,
      lastHealthFailure: null,
      recentLogTail: ready
        ? program.hubMemory.concurrencyGroup === null
          ? ""
          : "허브 실행 슬롯 대기 중\n"
        : "허브 대기 양보: 60초 후 다시 시작합니다.\n",
      updatedAt: at,
    };
    queuedStarts.set(key, { program, incidentId, run, ready });
    if (!ready || program.hubMemory.concurrencyGroup !== null || livePrograms.has(key)) {
      yield* dispatchRun(run);
    }
    if (!ready) {
      yield* forkParked(
        Effect.sleep(HUB_YIELD_RETRY).pipe(
          Effect.andThen(worker.enqueue({ type: "hub-ready", key, runId: run.id })),
        ),
      );
    }
  });

  const startProgram = Effect.fn("WorkspaceProgramSupervisor.startProgram")(function* (
    program: WorkspaceProgram,
    queuedRun: WorkspaceProgramRun,
    incidentId?: WorkspaceIncidentId,
  ) {
    const key = keyOf(program.projectId, program.id);
    if (!program.enabled || livePrograms.has(key)) return;
    const project = yield* snapshotQuery.getProjectShellById(program.projectId);
    if (Option.isNone(project)) return;
    const cwd = path.resolve(project.value.workspaceRoot, program.relativeDirectory || ".");
    const root = path.resolve(project.value.workspaceRoot);
    const relative = path.relative(root, cwd).replaceAll("\\", "/");
    if (relative === ".." || relative.startsWith("../") || path.isAbsolute(relative)) {
      const stoppedAt = yield* nowIso;
      yield* dispatchRun({
        ...queuedRun,
        status: "failed",
        stoppedAt,
        updatedAt: stoppedAt,
        recentLogTail: "프로그램 실행 경로가 프로젝트 폴더 밖을 가리킵니다.",
      });
      return yield* Effect.logWarning("Workspace program directory escaped its project", {
        projectId: program.projectId,
        programId: program.id,
      });
    }
    const hub = hubEnvironment(program, root, path);
    if (hub.rejectedDatasets.length > 0) {
      yield* Effect.logWarning("Workspace program shared datasets escaped the project root", {
        projectId: program.projectId,
        programId: program.id,
        datasets: hub.rejectedDatasets,
      });
    }
    const startedAt = yield* nowIso;
    let run: WorkspaceProgramRun = {
      ...queuedRun,
      startedAt,
      recentLogTail: "",
      updatedAt: startedAt,
    };
    yield* dispatchRun(run);
    // A commit cap needs a Windows Job Object around the program; the guard
    // reads the command from the environment so nothing here re-quotes it.
    // Elsewhere the cap is advisory (published, not enforced).
    const guarded = platform === "win32" && program.hubMemory.commitLimitMb !== null;
    let shell = shellFor(platform, program.command);
    if (guarded) {
      const candidates = windowsJobGuardCandidates(path, architecture);
      // A missing binary fails through the normal spawn-failure path, never without a cap.
      let binary = candidates[0]!;
      for (const candidate of candidates) {
        if (yield* fileSystem.exists(candidate)) {
          binary = candidate;
          break;
        }
      }
      shell = { shell: binary, args: [] };
    }
    const spawned = yield* Effect.result(
      ptyAdapter.spawn({
        useConptyDll: platform === "win32",
        shell: shell.shell,
        args: shell.args,
        cwd,
        cols: 120,
        rows: 30,
        env: programEnvironment(program, {
          ...hub.env,
          ...(guarded ? { [HUB_COMMAND_ENV]: program.command } : {}),
        }),
      }),
    );
    if (spawned._tag === "Failure") {
      const failedAt = yield* nowIso;
      run = {
        ...run,
        status: "failed",
        stoppedAt: failedAt,
        recentLogTail: redactSecrets(conciseFailure(spawned.failure), program),
        updatedAt: failedAt,
      };
      yield* dispatchRun(run);
      if (incidentId === undefined) {
        yield* openIncident({
          program,
          run,
          kind: "spawn-failure",
          severity: "critical",
          fingerprint: fingerprint(["spawn-failure", program.command]),
          summary: `${program.name} 프로그램을 시작하지 못했습니다.`,
          evidence: run.recentLogTail,
        });
      } else {
        yield* failRepairVerification({
          projectId: program.projectId,
          incidentId,
          detail: `프로그램 시작 실패\n${run.recentLogTail}`,
        });
      }
      return;
    }
    const process = spawned.success;
    const exit = yield* Deferred.make<ProcessExit>();
    run = { ...run, status: "running", pid: process.pid, updatedAt: yield* nowIso };
    const state: LiveProgram = {
      program,
      process,
      exit,
      run,
      intentionalStop: false,
      lastPersistedAt: Date.parse(run.updatedAt),
      logFlushScheduled: false,
      unsubscribeData: () => undefined,
      unsubscribeExit: () => undefined,
    };
    state.unsubscribeData = process.onData((data) => {
      runFork(worker.enqueue({ type: "output", key, pid: process.pid, data }));
    });
    state.unsubscribeExit = process.onExit((event) => {
      runFork(
        Deferred.succeed(exit, event).pipe(
          Effect.andThen(worker.enqueue({ type: "exit", key, pid: process.pid, event })),
        ),
      );
    });
    livePrograms.set(key, state);
    if (incidentId !== undefined) restartIncidentByProgram.set(key, incidentId);
    yield* dispatchRun(run);
    if (program.healthCheck === null && incidentId !== undefined) {
      yield* resolveIncident(program.projectId, incidentId);
    }
    yield* startHealthLoop(state);
  });

  const cancelQueuedStart = Effect.fn("WorkspaceProgramSupervisor.cancelQueuedStart")(function* (
    projectId: ProjectId,
    programId: WorkspaceProgramId,
  ) {
    const key = keyOf(projectId, programId);
    const pending = queuedStarts.get(key);
    queuedStarts.delete(key);
    if (pending === undefined) return;
    const program = yield* programRepository.getProgram({ projectId, programId });
    if (Option.isNone(program)) return;
    const stoppedAt = yield* nowIso;
    yield* dispatchRun({ ...pending.run, status: "exited", stoppedAt, updatedAt: stoppedAt });
  });

  /** Re-read definitions at admission; a queued snapshot must not undo edits or removals. */
  const drainQueuedStarts = Effect.fn("WorkspaceProgramSupervisor.drainQueuedStarts")(function* () {
    if (shuttingDown) return;
    const definitions = new Map<ProjectId, ReadonlyArray<WorkspaceProgram>>();
    for (const [key, pending] of queuedStarts) {
      const projectId = pending.program.projectId;
      let programs = definitions.get(projectId);
      if (programs === undefined) {
        programs = yield* programRepository.listPrograms(projectId);
        definitions.set(projectId, programs);
      }
      const program = programs.find((candidate) => candidate.id === pending.program.id);
      if (program === undefined || !program.enabled) {
        yield* cancelQueuedStart(projectId, pending.program.id);
        continue;
      }
      if (!pending.ready || livePrograms.has(key)) continue;
      const group = program.hubMemory.concurrencyGroup;
      if (group !== null) {
        const running = [...livePrograms.values()].filter(
          (state) =>
            state.program.projectId === projectId &&
            state.program.hubMemory.concurrencyGroup === group,
        );
        // A group has one effective limit. Conflicting member settings use the strictest cap,
        // including the definitions of processes already running under an older setting.
        const slots = Math.min(
          ...[
            program,
            ...programs.filter((entry) => entry.enabled),
            ...running.map((state) => state.program),
          ]
            .filter((entry) => entry.hubMemory.concurrencyGroup === group)
            .map((entry) => entry.hubMemory.concurrencySlots ?? 1),
        );
        if (running.length >= slots) continue;
      }
      queuedStarts.delete(key);
      yield* startProgram(program, pending.run, pending.incidentId);
    }
  });

  /**
   * Sends one signal and never fails the caller. A signal to an already-dead pid throws,
   * which is the expected outcome of escalating after the process finally exited.
   */
  const signalProgram = Effect.fn("WorkspaceProgramSupervisor.signalProgram")(function* (
    state: LiveProgram,
    signal: "SIGTERM" | "SIGKILL",
  ) {
    yield* Effect.try({
      try: () => state.process.kill(signal),
      catch: (cause) => conciseFailure(cause),
    }).pipe(
      Effect.catch((detail) =>
        Effect.logDebug("Workspace program signal was rejected", {
          projectId: state.program.projectId,
          programId: state.program.id,
          pid: state.process.pid,
          signal,
          detail,
        }),
      ),
    );
  });

  const stopProgram = Effect.fn("WorkspaceProgramSupervisor.stopProgram")(function* (
    projectId: ProjectId,
    programId: WorkspaceProgramId,
  ) {
    const key = keyOf(projectId, programId);
    yield* cancelQueuedStart(projectId, programId);
    const state = livePrograms.get(key);
    if (state === undefined) return;
    state.intentionalStop = true;
    state.run = { ...state.run, status: "stopping", updatedAt: yield* nowIso };
    yield* dispatchRun(state.run);

    // Ask, then insist. A dev server that traps its shutdown needs more than one signal,
    // and a program that survives both must not be reported as stopped.
    yield* signalProgram(state, "SIGTERM");
    const graceful = yield* Deferred.await(state.exit).pipe(
      Effect.timeoutOption(STOP_SIGNAL_GRACE),
    );
    if (Option.isNone(graceful)) {
      yield* signalProgram(state, "SIGKILL");
      const forced = yield* Deferred.await(state.exit).pipe(Effect.timeoutOption(STOP_TIMEOUT));
      if (Option.isNone(forced)) {
        // The process outlived SIGKILL, or the adapter never reported its exit. Stay
        // subscribed and keep the live entry: the exit handler can still finish the job
        // later, and the user can ask again. Reporting "exited" here would claim a port
        // is free while the process still holds it, and the next start would spawn a
        // second instance behind the `livePrograms` guard.
        yield* Effect.logWarning("Workspace program survived the stop escalation", {
          projectId,
          programId,
          pid: state.process.pid,
        });
        return;
      }
    }

    // The `exit` work item owns teardown — it unsubscribes, drops the live entry, and
    // reports the terminal status. Repeating that here would race with it.
    restartIncidentByProgram.delete(key);
  });

  const startIntegrityCycle = Effect.fn("WorkspaceProgramSupervisor.startIntegrityCycle")(
    function* (projectId: ProjectId, programId: WorkspaceProgramId) {
      const option = yield* programRepository.getProgram({ projectId, programId });
      if (Option.isNone(option)) return;
      const program = option.value;
      if (!program.integrity.enabled) {
        yield* updateProgramIntegrity(program, {
          status: "disabled",
          activeRunId: null,
        });
        return;
      }
      if (
        program.integrity.status === "stopping" ||
        program.integrity.status === "stopped" ||
        program.integrity.status === "converged"
      )
        return;
      if (program.integrity.activeRunId !== null) {
        integrityProgramByRun.set(program.integrity.activeRunId, { projectId, programId });
        yield* worker.enqueue({
          type: "integrity-run",
          projectId,
          programId,
          runId: program.integrity.activeRunId,
        });
        return;
      }

      const bindings = yield* roleRepository.listByProjectId(projectId);
      const enabledBindings = bindings.filter((binding) => binding.enabled);
      const distinctInstances = new Set(
        enabledBindings
          .filter((binding) => ["coordinator", "implementer", "researcher"].includes(binding.role))
          .map((binding) => String(binding.modelSelection.instanceId)),
      );
      if (distinctInstances.size < 2) {
        yield* updateProgramIntegrity(program, {
          status: "failed",
          activeRunId: null,
          summary:
            "무결성 수렴에는 실제 작업 그래프에 참여할 서로 다른 등록 CLI 계정 2개 이상이 필요합니다. 조정자와 구현자 또는 조사자 역할에 서로 다른 계정을 배정한 뒤 다시 시작하세요.",
        });
        return;
      }

      const createdAt = yield* nowIso;
      const runId = WorkspaceCollaborationRunId.make(yield* randomUUID);
      const nextCycle = program.integrity.cycle + 1;
      const task = buildWorkspaceProgramIntegrityTask({
        program,
        cycle: nextCycle,
        bindings: enabledBindings,
        priorSummary: program.integrity.summary,
      });
      const trackedProgram = yield* updateProgramIntegrity(program, {
        status: "queued",
        cycle: nextCycle,
        activeRunId: runId,
        lastRunId: runId,
        startedAt: program.integrity.startedAt ?? createdAt,
        convergedAt: null,
        summary: `무결성 수렴 ${nextCycle}주기를 준비하고 있습니다.`,
      });
      integrityProgramByRun.set(runId, { projectId, programId });
      const requested = yield* Effect.result(
        orchestrationEngine.dispatch({
          type: "project.collaboration.run.request",
          commandId: CommandId.make(yield* randomUUID),
          runId,
          projectId,
          task,
          source: "integrity",
          createdAt,
        }),
      );
      if (requested._tag === "Failure") {
        integrityProgramByRun.delete(runId);
        yield* updateProgramIntegrity(trackedProgram, {
          status: "failed",
          activeRunId: null,
          summary: `무결성 협업 실행을 만들지 못했습니다: ${conciseFailure(requested.failure)}`,
        });
      }
    },
  );

  const resetIntegrity = Effect.fn("WorkspaceProgramSupervisor.resetIntegrity")(function* (
    projectId: ProjectId,
    programId: WorkspaceProgramId,
  ) {
    const option = yield* programRepository.getProgram({ projectId, programId });
    if (Option.isNone(option)) return;
    const program = option.value;
    if (!program.integrity.enabled) {
      yield* updateProgramIntegrity(program, {
        status: "failed",
        summary: "프로그램 등록 설정에서 AI 무결성 수렴을 먼저 활성화하세요.",
      });
      return;
    }
    if (program.integrity.activeRunId !== null) return;
    const startedAt = yield* nowIso;
    yield* updateProgramIntegrity(program, {
      status: "queued",
      cycle: 0,
      consecutiveCleanPasses: 0,
      activeRunId: null,
      lastRunId: null,
      summary: "사용자가 무결성 수렴을 시작했습니다.",
      startedAt,
      convergedAt: null,
    });
    yield* worker.enqueue({ type: "integrity-cycle", projectId, programId });
  });

  const stopIntegrity = Effect.fn("WorkspaceProgramSupervisor.stopIntegrity")(function* (
    projectId: ProjectId,
    programId: WorkspaceProgramId,
  ) {
    const option = yield* programRepository.getProgram({ projectId, programId });
    const tracked = [...integrityProgramByRun.entries()].find(
      ([, value]) => value.projectId === projectId && value.programId === programId,
    );
    const activeRunId = Option.isSome(option)
      ? (option.value.integrity.activeRunId ?? tracked?.[0] ?? null)
      : (tracked?.[0] ?? null);
    if (Option.isSome(option)) {
      yield* updateProgramIntegrity(option.value, {
        status: activeRunId === null ? "stopped" : "stopping",
        activeRunId,
        summary:
          activeRunId === null
            ? "무결성 수렴이 중지됐습니다."
            : "현재 CLI 작업을 취소한 뒤 무결성 수렴을 중지합니다.",
      });
    }
    if (activeRunId === null) return;
    const createdAt = yield* nowIso;
    yield* orchestrationEngine.dispatch({
      type: "project.collaboration.run.cancel",
      commandId: CommandId.make(yield* randomUUID),
      runId: activeRunId,
      projectId,
      createdAt,
    });
  });

  const handleIntegrityRun = Effect.fn("WorkspaceProgramSupervisor.handleIntegrityRun")(function* (
    projectId: ProjectId,
    programId: WorkspaceProgramId,
    runId: WorkspaceCollaborationRunId,
  ) {
    const programOption = yield* programRepository.getProgram({ projectId, programId });
    if (Option.isNone(programOption)) {
      integrityProgramByRun.delete(runId);
      return;
    }
    const program = programOption.value;
    if (program.integrity.activeRunId !== runId) {
      integrityProgramByRun.delete(runId);
      return;
    }
    const runOption = yield* collaborationRepository.getById({ projectId, runId });
    if (Option.isNone(runOption)) {
      integrityProgramByRun.delete(runId);
      if (program.integrity.status === "stopping") {
        yield* updateProgramIntegrity(program, {
          status: "stopped",
          activeRunId: null,
          summary: "중단된 협업 실행을 정리했습니다.",
        });
        return;
      }
      yield* updateProgramIntegrity(program, {
        status: "queued",
        activeRunId: null,
        summary: "이전 협업 실행을 찾지 못해 새 수렴 주기를 시작합니다.",
      });
      yield* worker.enqueue({ type: "integrity-cycle", projectId, programId });
      return;
    }
    const run = runOption.value;
    if (["queued", "running", "cancel-requested"].includes(run.status)) {
      const status =
        program.integrity.status === "stopping"
          ? "stopping"
          : run.status === "running"
            ? "running"
            : "queued";
      if (program.integrity.status !== status) {
        yield* updateProgramIntegrity(program, { status });
      }
      return;
    }

    integrityProgramByRun.delete(runId);
    if (program.integrity.status === "stopping" || run.status === "cancelled") {
      yield* updateProgramIntegrity(program, {
        status: "stopped",
        activeRunId: null,
        summary: "무결성 수렴이 중지됐습니다.",
      });
      return;
    }
    if (run.status === "failed") {
      yield* updateProgramIntegrity(program, {
        status: "failed",
        activeRunId: null,
        summary: `무결성 협업 실행이 실패했습니다: ${run.error ?? "원인 미상"}`,
      });
      return;
    }

    const evaluation = evaluateWorkspaceProgramIntegrityRun(run);
    const summary = [evaluation.summary, ...evaluation.reasons].filter(Boolean).join("\n\n");
    if (evaluation.converged) {
      const cleanPasses = program.integrity.consecutiveCleanPasses + 1;
      if (cleanPasses >= program.integrity.requiredCleanPasses) {
        const convergedAt = yield* nowIso;
        yield* updateProgramIntegrity(program, {
          status: "converged",
          consecutiveCleanPasses: cleanPasses,
          activeRunId: null,
          summary,
          convergedAt,
        });
        return;
      }
      yield* updateProgramIntegrity(program, {
        status: "queued",
        consecutiveCleanPasses: cleanPasses,
        activeRunId: null,
        summary: `독립 무결 판정 ${cleanPasses}/${program.integrity.requiredCleanPasses}회 통과\n\n${summary}`,
      });
      yield* worker.enqueue({ type: "integrity-cycle", projectId, programId });
      return;
    }

    yield* updateProgramIntegrity(program, {
      status: "queued",
      consecutiveCleanPasses: 0,
      activeRunId: null,
      summary,
    });
    yield* worker.enqueue({ type: "integrity-cycle", projectId, programId });
  });

  const processWork = Effect.fn("WorkspaceProgramSupervisor.processWork")(function* (
    item: WorkItem,
  ) {
    switch (item.type) {
      case "start":
        if (!livePrograms.has(keyOf(item.program.projectId, item.program.id))) {
          yield* queueStart(item.program, item.incidentId);
        }
        return;
      case "hub-ready": {
        const pending = queuedStarts.get(item.key);
        if (pending?.run.id === item.runId) pending.ready = true;
        return;
      }
      case "program-updated":
        if (!item.program.enabled) yield* stopProgram(item.program.projectId, item.program.id);
        return;
      case "stop-project":
        for (const [key, pending] of queuedStarts) {
          if (pending.program.projectId === item.projectId) queuedStarts.delete(key);
        }
        for (const state of livePrograms.values()) {
          if (state.program.projectId === item.projectId) {
            yield* stopProgram(item.projectId, state.program.id);
          }
        }
        return;
      case "stop":
        yield* stopProgram(item.projectId, item.programId);
        return;
      case "restart":
        yield* stopProgram(item.program.projectId, item.program.id);
        yield* queueStart(item.program, item.incidentId);
        return;
      case "flush-logs": {
        const state = livePrograms.get(item.key);
        if (state === undefined || state.run.id !== item.runId) return;
        state.logFlushScheduled = false;
        yield* persistLiveRun(state);
        return;
      }
      case "output": {
        const state = livePrograms.get(item.key);
        if (state === undefined || state.process.pid !== item.pid) return;
        const permissions = yield* readPermissions;
        if (!permissions.collectLogs) return;
        const clean = redactSecrets(normalizeLog(item.data), state.program);
        state.run = { ...state.run, recentLogTail: appendLog(state.run.recentLogTail, clean) };
        yield* persistLiveRun(state);
        for (const pattern of state.program.errorPatterns) {
          if (!matchesErrorPattern(pattern, clean)) continue;
          // A service failing under load prints its error line on every request. Every
          // command here carries up to 64KiB and crosses the single serial command queue
          // shared with the user's own turns, so repeats of the same finding coalesce.
          const incidentFingerprint = fingerprint(["log-pattern", pattern]);
          const coalesceKey = `${item.key}:${incidentFingerprint}`;
          const at = Date.parse(yield* nowIso);
          const lastOpenedAt = incidentCoalesceAt.get(coalesceKey);
          if (lastOpenedAt !== undefined && at - lastOpenedAt < LOG_PERSIST_INTERVAL_MS) continue;
          incidentCoalesceAt.set(coalesceKey, at);
          yield* openIncident({
            program: state.program,
            run: state.run,
            kind: "log-pattern",
            severity: "error",
            fingerprint: incidentFingerprint,
            summary: `${state.program.name} 로그에서 오류 패턴이 감지됐습니다.`,
            evidence: state.run.recentLogTail,
          });
        }
        return;
      }
      case "exit": {
        const state = livePrograms.get(item.key);
        if (state === undefined || state.process.pid !== item.pid) return;
        state.unsubscribeData();
        state.unsubscribeExit();
        livePrograms.delete(item.key);
        for (const key of incidentCoalesceAt.keys()) {
          if (key.startsWith(`${item.key}:`)) incidentCoalesceAt.delete(key);
        }
        const stoppedAt = yield* nowIso;
        // Exit 75 from a grouped program is a hub yield: it saved its state and
        // handed the slot back (hub_wait.pause). Not a failure, and it comes
        // back after the retry delay — behind any sibling already queued.
        const yielded =
          !state.intentionalStop &&
          item.event.exitCode === HUB_YIELD_EXIT_CODE &&
          state.program.hubMemory.concurrencyGroup !== null;
        state.run = {
          ...state.run,
          status: state.intentionalStop || yielded ? "exited" : "failed",
          pid: null,
          stoppedAt,
          exitCode: item.event.exitCode,
          exitSignal: item.event.signal,
          updatedAt: stoppedAt,
        };
        yield* dispatchRun(state.run);
        if (yielded) {
          yield* queueStart(state.program, undefined, false);
          state.intentionalStop = true;
        }
        if (!state.intentionalStop) {
          const repairIncidentId = restartIncidentByProgram.get(item.key);
          if (repairIncidentId !== undefined) {
            yield* failRepairVerification({
              projectId: state.program.projectId,
              incidentId: repairIncidentId,
              detail: `프로그램이 다시 종료됐습니다. 종료 코드: ${item.event.exitCode}\n${state.run.recentLogTail}`,
            });
            return;
          }
          yield* openIncident({
            program: state.program,
            run: state.run,
            kind: "process-exit",
            severity: item.event.exitCode === 0 ? "warning" : "critical",
            fingerprint: fingerprint([
              "process-exit",
              String(item.event.exitCode),
              String(item.event.signal),
            ]),
            summary: `${state.program.name} 프로그램이 예기치 않게 종료됐습니다.`,
            evidence: state.run.recentLogTail || `종료 코드: ${item.event.exitCode}`,
          });
        }
        return;
      }
      case "health": {
        const state = livePrograms.get(item.key);
        if (
          state === undefined ||
          state.process.pid !== item.pid ||
          state.program.healthCheck === null
        )
          return;
        const startedAtMs = DateTime.toEpochMillis(yield* DateTime.now);
        const result = yield* Effect.result(
          healthCheckEffect(state.program.healthCheck, httpClient),
        );
        const checkedAt = yield* nowIso;
        if (result._tag === "Success") {
          state.run = {
            ...state.run,
            healthStatus: "healthy",
            consecutiveHealthFailures: 0,
            lastHealthCheckAt: checkedAt,
            lastHealthFailure: null,
            updatedAt: checkedAt,
          };
          yield* dispatchRun(state.run);
          const incidentId = restartIncidentByProgram.get(item.key);
          if (incidentId !== undefined) yield* resolveIncident(state.program.projectId, incidentId);
          return;
        }
        const failure = classifyHealthFailure({
          failure: result.failure,
          timeoutSeconds: state.program.healthCheck.timeoutSeconds,
          elapsedMs: Date.parse(checkedAt) - startedAtMs,
          checkedAt,
        });
        if (failure.reason === "inconclusive") {
          // The watcher, not the program, was late. Keep the streak where it
          // was so a stalled server never reaches the threshold on its own.
          yield* Effect.logInfo("Program health check inconclusive: watcher stalled", {
            programId: state.program.id,
            elapsedMs: failure.elapsedMs,
          });
          state.run = {
            ...state.run,
            lastHealthCheckAt: checkedAt,
            lastHealthFailure: failure,
            updatedAt: checkedAt,
          };
          yield* dispatchRun(state.run);
          return;
        }
        const failures = state.run.consecutiveHealthFailures + 1;
        const threshold = state.program.healthCheck.failureThreshold;
        const crossedThreshold = failures >= threshold && state.run.healthStatus !== "unhealthy";
        state.run = {
          ...state.run,
          healthStatus: failures >= threshold ? "unhealthy" : "degraded",
          consecutiveHealthFailures: failures,
          lastHealthCheckAt: checkedAt,
          lastHealthFailure: failure,
          updatedAt: checkedAt,
        };
        yield* dispatchRun(state.run);
        if (crossedThreshold) {
          const detail = `실패 사유: ${failure.detail}`;
          const repairIncidentId = restartIncidentByProgram.get(item.key);
          if (repairIncidentId !== undefined) {
            yield* failRepairVerification({
              projectId: state.program.projectId,
              incidentId: repairIncidentId,
              detail: `${detail}\n\n최근 로그:\n${state.run.recentLogTail}`,
            });
            return;
          }
          yield* openIncident({
            program: state.program,
            run: state.run,
            kind: "health-check",
            severity: "critical",
            fingerprint: fingerprint([
              "health-check",
              state.program.healthCheck.kind,
              failure.reason,
            ]),
            summary: `${state.program.name} 상태검사가 ${threshold}회 연속 실패했습니다.`,
            evidence: `${detail}\n\n최근 로그:\n${state.run.recentLogTail}`,
          });
        }
        return;
      }
      case "repair": {
        const incident = yield* programRepository.getIncident({
          projectId: item.projectId,
          incidentId: item.incidentId,
        });
        if (Option.isNone(incident)) return;
        const runId = WorkspaceCollaborationRunId.make(yield* randomUUID);
        const current = yield* updateIncident(incident.value, {
          status: "repairing",
          repairRunId: runId,
          resolvedAt: null,
        });
        const createdAt = yield* nowIso;
        yield* orchestrationEngine.dispatch({
          type: "project.collaboration.run.incident",
          commandId: CommandId.make(yield* randomUUID),
          runId,
          incidentId: item.incidentId,
          projectId: item.projectId,
          task: [
            "# 프로그램 오류 수정",
            item.instruction,
            `사건 ID: ${current.id}`,
            `프로그램 ID: ${current.programId}`,
            `요약: ${current.summary}`,
            `자동 진단: ${current.diagnosis ?? "없음"}`,
            "수정 후 관련 검증을 수행하세요. 총괄 모델은 필수 검증이 모두 통과하고 신뢰도가 낮지 않을 때만 구조화된 최종 합성 결과의 repairApproved를 true로 설정해야 합니다.",
          ].join("\n\n"),
          createdAt,
        });
        return;
      }
      case "resolve":
        yield* resolveIncident(item.projectId, item.incidentId);
        return;
      case "repair-run": {
        const run = yield* collaborationRepository.getById({
          projectId: item.projectId,
          runId: item.runId,
        });
        if (Option.isNone(run) || run.value.source !== "incident" || run.value.incidentId === null)
          return;
        const incident = yield* programRepository.getIncident({
          projectId: run.value.projectId,
          incidentId: run.value.incidentId,
        });
        if (Option.isNone(incident)) return;
        if (run.value.status === "failed" || run.value.status === "cancelled") {
          yield* updateIncident(incident.value, {
            status: "awaiting-user",
            diagnosis:
              `${incident.value.diagnosis ?? ""}\n\n수정 작업 실패: ${run.value.error ?? run.value.status}`.trim(),
          });
          return;
        }
        if (run.value.status !== "completed") return;
        const approved = isWorkspaceRepairRunApproved(run.value);
        if (!approved) {
          yield* updateIncident(incident.value, {
            status: "awaiting-user",
            diagnosis:
              `${incident.value.diagnosis ?? ""}\n\n수정 검증이 통과되지 않아 자동 재시작하지 않았습니다.`.trim(),
          });
          return;
        }
        const program = yield* programRepository.getProgram({
          projectId: run.value.projectId,
          programId: incident.value.programId,
        });
        if (Option.isNone(program)) return;
        yield* updateIncident(incident.value, { status: "verifying" });
        const permissions = yield* readPermissions;
        if (!permissions.autoRestartAfterRepair) {
          yield* updateIncident(incident.value, {
            status: "awaiting-user",
            diagnosis:
              `${incident.value.diagnosis ?? ""}\n\n수정 검증은 통과했습니다. 권한 설정에서 자동 재시작이 꺼져 있으므로 프로그램을 직접 재시작한 뒤 해결 처리해 주세요.`.trim(),
          });
          return;
        }
        yield* worker.enqueue({
          type: "restart",
          program: program.value,
          incidentId: incident.value.id,
        });
        return;
      }
      case "integrity-start":
        yield* resetIntegrity(item.projectId, item.programId);
        return;
      case "integrity-stop":
        yield* stopIntegrity(item.projectId, item.programId);
        return;
      case "integrity-cycle":
        yield* startIntegrityCycle(item.projectId, item.programId);
        return;
      case "integrity-run":
        yield* handleIntegrityRun(item.projectId, item.programId, item.runId);
        return;
    }
  });

  worker = yield* makeDrainableWorker((item: WorkItem) =>
    processWork(item).pipe(
      Effect.andThen(
        item.type === "start" ||
          item.type === "stop" ||
          item.type === "restart" ||
          item.type === "exit" ||
          item.type === "hub-ready" ||
          item.type === "program-updated" ||
          item.type === "stop-project"
          ? drainQueuedStarts()
          : Effect.void,
      ),
      Effect.catchCause((cause) =>
        Effect.logError("Workspace program supervisor work item failed", {
          type: item.type,
          cause: conciseCause(cause),
        }),
      ),
    ),
  );

  const enqueueEvent = (event: OrchestrationEvent) => {
    switch (event.type) {
      case "project.program-upserted":
        return Effect.gen(function* () {
          const program = event.payload.program;
          yield* worker.enqueue({ type: "program-updated", program });
          if (program.integrity.enabled && program.integrity.status === "queued") {
            yield* worker.enqueue({
              type: "integrity-cycle",
              projectId: program.projectId,
              programId: program.id,
            });
          } else if (
            !program.integrity.enabled &&
            [...integrityProgramByRun.values()].some(
              (tracked) =>
                tracked.projectId === program.projectId && tracked.programId === program.id,
            )
          ) {
            yield* worker.enqueue({
              type: "integrity-stop",
              projectId: program.projectId,
              programId: program.id,
            });
          }
        });
      case "project.program-start-requested":
        return readPermissions.pipe(
          Effect.flatMap((permissions) =>
            permissions.manualControl
              ? programRepository.getProgram(event.payload).pipe(
                  Effect.flatMap(
                    Option.match({
                      onNone: () => Effect.void,
                      onSome: (program) => worker.enqueue({ type: "start", program }),
                    }),
                  ),
                )
              : Effect.void,
          ),
        );
      case "project.program-stop-requested":
        return readPermissions.pipe(
          Effect.flatMap((permissions) =>
            permissions.manualControl
              ? worker.enqueue({
                  type: "stop",
                  projectId: event.payload.projectId,
                  programId: event.payload.programId,
                })
              : Effect.void,
          ),
        );
      case "project.program-removed":
        return Effect.gen(function* () {
          yield* worker.enqueue({
            type: "integrity-stop",
            projectId: event.payload.projectId,
            programId: event.payload.programId,
          });
          yield* worker.enqueue({
            type: "stop",
            projectId: event.payload.projectId,
            programId: event.payload.programId,
          });
        });
      case "project.program-restart-requested":
        return readPermissions.pipe(
          Effect.flatMap((permissions) =>
            permissions.manualControl
              ? programRepository.getProgram(event.payload).pipe(
                  Effect.flatMap(
                    Option.match({
                      onNone: () => Effect.void,
                      onSome: (program) => worker.enqueue({ type: "restart", program }),
                    }),
                  ),
                )
              : Effect.void,
          ),
        );
      case "project.program-integrity-start-requested":
        return worker.enqueue({
          type: "integrity-start",
          projectId: event.payload.projectId,
          programId: event.payload.programId,
        });
      case "project.program-integrity-stop-requested":
        return worker.enqueue({
          type: "integrity-stop",
          projectId: event.payload.projectId,
          programId: event.payload.programId,
        });
      case "project.program-incident-repair-requested":
        return worker.enqueue({
          type: "repair",
          projectId: event.payload.projectId,
          incidentId: event.payload.incidentId,
          instruction: event.payload.instruction,
        });
      case "project.program-incident-resolve-requested":
        return worker.enqueue({
          type: "resolve",
          projectId: event.payload.projectId,
          incidentId: event.payload.incidentId,
        });
      case "project.collaboration-run-upserted":
        {
          const tracked = integrityProgramByRun.get(event.payload.run.id);
          if (tracked !== undefined) {
            return worker.enqueue({
              type: "integrity-run",
              projectId: tracked.projectId,
              programId: tracked.programId,
              runId: event.payload.run.id,
            });
          }
        }
        return event.payload.run.source === "incident" &&
          ["completed", "failed", "cancelled"].includes(event.payload.run.status)
          ? worker.enqueue({
              type: "repair-run",
              projectId: event.payload.run.projectId,
              runId: event.payload.run.id,
            })
          : Effect.void;
      case "project.deleted":
        return Effect.gen(function* () {
          yield* Effect.forEach(
            [...integrityProgramByRun.values()].filter(
              (tracked) => tracked.projectId === event.payload.projectId,
            ),
            (tracked) => worker.enqueue({ type: "integrity-stop", ...tracked }),
            { concurrency: 1, discard: true },
          );
          yield* worker.enqueue({ type: "stop-project", projectId: event.payload.projectId });
        });
      default:
        return Effect.void;
    }
  };

  let started = false;

  const discover: WorkspaceProgramSupervisorShape["discover"] = Effect.fn(
    "WorkspaceProgramSupervisor.discover",
  )(function* (projectId) {
    const project = yield* snapshotQuery.getProjectShellById(projectId);
    if (Option.isNone(project)) return { candidates: [] };
    const root = project.value.workspaceRoot;
    const candidates: WorkspaceProgramCandidate[] = project.value.scripts.map((script) => ({
      id: WorkspaceProgramId.make(slug(script.id)),
      name: script.name,
      command: script.command,
      relativeDirectory: "",
      source: "project-script",
      reason: "프로젝트에 저장된 실행 작업에서 발견했습니다.",
    }));
    const packagePath = path.join(root, "package.json");
    const packageExists = yield* fileSystem
      .exists(packagePath)
      .pipe(Effect.catchCause(() => Effect.succeed(false)));
    if (packageExists) {
      const manifest = yield* fileSystem
        .readFileString(packagePath)
        .pipe(Effect.flatMap(decodePackageManifest), Effect.option);
      if (Option.isSome(manifest)) {
        for (const name of ["dev", "start", "serve"] as const) {
          if (manifest.value.scripts?.[name] === undefined) continue;
          candidates.push({
            id: WorkspaceProgramId.make(slug(name)),
            name,
            command: `npm run ${name}`,
            relativeDirectory: "",
            source: "package-json",
            reason: `package.json의 ${name} 스크립트에서 발견했습니다.`,
          });
        }
      }
    }
    const staticCandidates: ReadonlyArray<{
      readonly files: ReadonlyArray<string>;
      readonly candidate: WorkspaceProgramCandidate;
    }> = [
      {
        files: ["compose.yml", "compose.yaml", "docker-compose.yml", "docker-compose.yaml"],
        candidate: {
          id: WorkspaceProgramId.make("docker-compose"),
          name: "Docker Compose",
          command: "docker compose up",
          relativeDirectory: "",
          source: "docker-compose",
          reason: "Docker Compose 설정 파일을 발견했습니다.",
        },
      },
      {
        files: ["pyproject.toml"],
        candidate: {
          id: WorkspaceProgramId.make("python-app"),
          name: "Python 애플리케이션",
          command: "python -m app",
          relativeDirectory: "",
          source: "python",
          reason: "pyproject.toml을 발견했습니다. 실행 명령을 확인한 뒤 등록하세요.",
        },
      },
      {
        files: ["Cargo.toml"],
        candidate: {
          id: WorkspaceProgramId.make("cargo-run"),
          name: "Rust 애플리케이션",
          command: "cargo run",
          relativeDirectory: "",
          source: "rust",
          reason: "Cargo.toml을 발견했습니다.",
        },
      },
    ];
    for (const entry of staticCandidates) {
      const exists = yield* Effect.forEach(entry.files, (file) =>
        fileSystem
          .exists(path.join(root, file))
          .pipe(Effect.catchCause(() => Effect.succeed(false))),
      );
      if (exists.some(Boolean)) {
        candidates.push(entry.candidate);
      }
    }
    const seen = new Set<string>();
    return {
      candidates: candidates.filter((candidate) => {
        const key = candidate.command.trim().toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }),
    };
  });

  const start: WorkspaceProgramSupervisorShape["start"] = Effect.fn("start")(function* () {
    if (started) return;
    started = true;
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        shuttingDown = true;
        queuedStarts.clear();
        yield* Effect.forEach(
          [...livePrograms.values()],
          (state) =>
            stopProgram(state.program.projectId, state.program.id).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("Workspace program shutdown failed", {
                  projectId: state.program.projectId,
                  programId: state.program.id,
                  cause: conciseCause(cause),
                }),
              ),
            ),
          { concurrency: 1, discard: true },
        );
      }),
    );
    yield* forkParked(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) =>
        enqueueEvent(event).pipe(
          Effect.catchCause((cause) =>
            Effect.logError("Workspace program event handling failed", {
              eventType: event.type,
              cause: conciseCause(cause),
            }),
          ),
        ),
      ),
      { startImmediately: true },
    );
    const integrityPrograms = yield* programRepository.listIntegrityPrograms().pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Workspace program integrity recovery lookup failed", {
          cause: conciseCause(cause),
        }).pipe(Effect.as([] as ReadonlyArray<WorkspaceProgram>)),
      ),
    );
    yield* Effect.forEach(
      integrityPrograms,
      (program) => {
        if (program.integrity.activeRunId !== null) {
          integrityProgramByRun.set(program.integrity.activeRunId, {
            projectId: program.projectId,
            programId: program.id,
          });
          return worker.enqueue({
            type: "integrity-run",
            projectId: program.projectId,
            programId: program.id,
            runId: program.integrity.activeRunId,
          });
        }
        return worker.enqueue({
          type: program.integrity.status === "stopping" ? "integrity-stop" : "integrity-cycle",
          projectId: program.projectId,
          programId: program.id,
        });
      },
      { concurrency: 1, discard: true },
    );
    yield* worker.drain;
    const recoverableIncidents = yield* programRepository.listRecoverableIncidents().pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Workspace program incident recovery lookup failed", {
          cause: conciseCause(cause),
        }).pipe(Effect.as([] as ReadonlyArray<WorkspaceIncident>)),
      ),
    );
    const interruptedRuns = yield* programRepository.listActiveRuns().pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Workspace program run recovery lookup failed", {
          cause: conciseCause(cause),
        }).pipe(Effect.as([] as ReadonlyArray<WorkspaceProgramRun>)),
      ),
    );
    yield* Effect.forEach(
      interruptedRuns,
      (run) =>
        Effect.gen(function* () {
          const stoppedAt = yield* nowIso;
          const wasStopping =
            run.status === "stopping" || (run.status === "starting" && run.pid === null);
          const recoveredRun: WorkspaceProgramRun = {
            ...run,
            status: wasStopping ? "exited" : "failed",
            pid: null,
            stoppedAt,
            exitCode: null,
            exitSignal: null,
            updatedAt: stoppedAt,
          };
          yield* dispatchRun(recoveredRun);
          if (wasStopping) return;
          const program = yield* programRepository.getProgram({
            projectId: run.projectId,
            programId: run.programId,
          });
          if (Option.isNone(program)) return;
          yield* openIncident({
            program: program.value,
            run: recoveredRun,
            kind: "process-exit",
            severity: "critical",
            fingerprint: fingerprint(["process-ownership-lost"]),
            summary: `${program.value.name} 프로그램 추적이 서버 재시작으로 중단됐습니다.`,
            evidence:
              recoveredRun.recentLogTail ||
              "이전 T3 서버가 종료되어 해당 프로세스의 소유 상태를 안전하게 이어받지 않았습니다.",
          });
        }),
      { concurrency: 1, discard: true },
    ).pipe(
      Effect.catchCause((cause) =>
        Effect.logError("Workspace program run recovery failed", {
          cause: conciseCause(cause),
        }),
      ),
    );
    yield* Effect.forEach(
      recoverableIncidents,
      (incident) =>
        Effect.gen(function* () {
          const program = yield* programRepository.getProgram({
            projectId: incident.projectId,
            programId: incident.programId,
          });
          if (Option.isNone(program)) return;
          if (incident.status === "open") {
            yield* forkParked(
              diagnoseIncident(incident, program.value).pipe(
                Effect.catchCause((cause) =>
                  updateIncident(incident, {
                    status: "awaiting-user",
                    diagnosis: `자동 진단 실패: ${conciseCause(cause)}`,
                  }).pipe(Effect.asVoid),
                ),
              ),
            );
            return;
          }
          if (incident.status === "diagnosing") {
            yield* forkParked(
              resumeIncidentDiagnosis(incident, program.value).pipe(
                Effect.catchCause((cause) =>
                  updateIncident(incident, {
                    status: "awaiting-user",
                    diagnosis: `자동 진단 복구 실패: ${conciseCause(cause)}`,
                  }).pipe(Effect.asVoid),
                ),
              ),
            );
            return;
          }
          const permissions = yield* readPermissions;
          if (permissions.autoRestartAfterRepair && program.value.enabled) {
            yield* worker.enqueue({
              type: "restart",
              program: program.value,
              incidentId: incident.id,
            });
            return;
          }
          yield* updateIncident(incident, {
            status: "awaiting-user",
            diagnosis:
              `${incident.diagnosis ?? ""}\n\n서버 재시작으로 프로그램 검증이 중단됐습니다. 직접 재시작해 확인하거나 자동 재시작 권한을 켠 뒤 수정·검증을 다시 요청해 주세요.`.trim(),
          });
        }),
      { concurrency: 1, discard: true },
    ).pipe(
      Effect.catchCause((cause) =>
        Effect.logError("Workspace program incident recovery failed", {
          cause: conciseCause(cause),
        }),
      ),
    );
    const permissions = yield* readPermissions;
    if (permissions.autoStart) {
      const programs = yield* programRepository.listAutoStartPrograms().pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Workspace program auto-start lookup failed", {
            cause: conciseCause(cause),
          }).pipe(Effect.as([] as ReadonlyArray<WorkspaceProgram>)),
        ),
      );
      yield* Effect.forEach(programs, (program) => worker.enqueue({ type: "start", program }), {
        concurrency: 1,
        discard: true,
      });
      yield* worker.drain;
    }
  });

  return { start, drain: worker.drain, discover } satisfies WorkspaceProgramSupervisorShape;
});

export const WorkspaceProgramSupervisorLive = Layer.effect(
  WorkspaceProgramSupervisor,
  makeWorkspaceProgramSupervisor,
);
