// @effect-diagnostics nodeBuiltinImport:off - Deterministic job ids hash the turn-start event id.
import { createHash } from "node:crypto";
import {
  CommandId,
  EventId,
  MessageId,
  ProviderExecutionId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  WorkspaceCollaborationRunId,
  WorkspaceTaskNodeId,
  type ModelSelection,
  type OrchestrationEvent,
  type OrchestrationSession,
  type ProviderDriverKind,
  type ProviderInstanceConfig,
  type ProviderSendTurnInput,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type { ServerConfig } from "../config.ts";
import { upgradeRoomIds } from "../upgradeRoom.ts";
import {
  beginWatchdogProjection,
  drainWatchdogProjection,
  type ProjectionInput,
} from "./Layers/WatchdogEventProjection.ts";
import type { OrchestrationEngineShape } from "./Services/OrchestrationEngine.ts";
import type { CheckpointReactorShape } from "./Services/CheckpointReactor.ts";
import type { ProjectionSnapshotQueryShape } from "./Services/ProjectionSnapshotQuery.ts";
import type { WorkspaceAgentExecutionInput } from "./Services/WorkspaceAgentExecutor.ts";
import { resumeDetachedWatchdog, watchdogWorkerEntrypoint } from "./WatchdogExecutor.ts";
import {
  WATCHDOG_PROJECTION_CONSUMER,
  type UpgradeRoomJobRecord,
  type UpgradeRoomQuestionRecord,
  type WatchdogJobState,
  type WatchdogJournal,
} from "./WatchdogJournal.ts";
import { launchWatchdogExecution } from "./WatchdogLaunch.ts";
import { workspaceExecutionMessageId } from "./workspaceFormatRepair.ts";
import { isTextQuestionTurn, parseTextQuestions, textQuestionSummary } from "./textQuestions.ts";
import { unifiedExecutionLedger } from "../t3x/executionLedger/UnifiedExecutionLedger.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

export const UPGRADE_ROOM_RUN_ID = "upgrade-room";
export const UPGRADE_ROOM_OFFLINE_WORK_KIND = "upgrade-room.offline-work";
const UNCLAIMED_LAUNCH_TIMEOUT_MS = 30_000;

/** The one ownership check: the primary T3's fixed room runs through detached workers. */
export function isDetachedUpgradeRoomThread(upgradeRoom: unknown, threadId: string): boolean {
  return !upgradeRoom && threadId === upgradeRoomIds.threadId;
}

/** The same turn-start event always maps to the same job, so a retry cannot submit twice. */
export function upgradeRoomTurnIds(turnEventId: string) {
  const hash = createHash("sha256").update(turnEventId, "utf8").digest("hex").slice(0, 32);
  return { jobId: `upgrade-room-turn-${hash}`, nodeId: `turn-${hash}` };
}

export function upgradeRoomRequestLine(text: string): string {
  const line =
    text
      .split(/\r?\n/)
      .find((entry) => entry.trim())
      ?.trim() ?? "";
  return (line || "업그레이드 작업").slice(0, 120);
}

export function upgradeRoomOfflineQuestionPolicy(settings: unknown): "decide" | "wait" {
  const value = (settings as { upgradeRoomOfflineQuestions?: unknown } | undefined)
    ?.upgradeRoomOfflineQuestions;
  return value === "wait" ? "wait" : "decide";
}

export interface UpgradeRoomContinuity {
  readonly continuity: "resumed" | "fresh";
  readonly resumeCursor?: unknown;
  readonly note?: "first-turn" | "no-cursor" | "instance-changed";
  readonly detachedSession: {
    readonly contextHandoff: boolean;
    readonly hasNativeHistory: boolean;
  };
}

/** Resume only the previous job's own provider conversation; otherwise hand off context. */
export function chooseUpgradeRoomContinuity(
  latest: ReturnType<WatchdogJournal["latestUpgradeRoomResume"]>,
  providerInstanceId: string,
  hasEarlierMessage: boolean,
): UpgradeRoomContinuity {
  const fresh = (note: NonNullable<UpgradeRoomContinuity["note"]>): UpgradeRoomContinuity => ({
    continuity: "fresh",
    note,
    detachedSession: { contextHandoff: hasEarlierMessage, hasNativeHistory: false },
  });
  if (!latest) return fresh(hasEarlierMessage ? "no-cursor" : "first-turn");
  if (latest.cursor === undefined) return fresh("no-cursor");
  if (latest.providerInstanceId !== providerInstanceId) return fresh("instance-changed");
  let resumeCursor: unknown;
  try {
    resumeCursor = decodeJson(latest.cursor);
  } catch {
    return fresh("no-cursor");
  }
  return {
    continuity: "resumed",
    resumeCursor,
    detachedSession: { contextHandoff: false, hasNativeHistory: true },
  };
}

export type UpgradeRoomAdmission = "duplicate" | "queued" | "start";

/** One room job at a time; later requests wait in arrival order. */
export function decideUpgradeRoomAdmission(input: {
  readonly jobExists: boolean;
  readonly state: "queued" | "started" | "dropped" | undefined;
  readonly busy: boolean;
  readonly unsettled: number;
  readonly olderPending: number;
}): UpgradeRoomAdmission {
  if (input.jobExists || input.state === "dropped") return "duplicate";
  if (input.state === "started" && input.busy) return "duplicate";
  if (input.busy || input.unsettled > 0 || input.olderPending > 0) return "queued";
  return "start";
}

export interface UpgradeRoomOfflineItem {
  readonly jobId: string;
  readonly request: string;
  readonly status: "completed" | "failed" | "cancelled" | "running" | "unknown";
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly questions?: ReadonlyArray<{
    readonly question: string;
    readonly handledAs: "decided" | "waiting";
  }>;
}

const iso = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis));

/** Pure summary of room work that ran or finished while the backend was away. */
export function buildUpgradeRoomOfflineSummary(input: {
  readonly from: number;
  readonly to: number;
  readonly jobs: ReadonlyArray<{
    readonly record: UpgradeRoomJobRecord;
    readonly state: WatchdogJobState | undefined;
    readonly outcome?: { readonly outcome: string; readonly recordedAt: number };
    readonly unsettledAtStartup: boolean;
    readonly questions: ReadonlyArray<UpgradeRoomQuestionRecord>;
  }>;
}) {
  const items: UpgradeRoomOfflineItem[] = [];
  for (const job of input.jobs) {
    if (!job.unsettledAtStartup && !(job.outcome && job.outcome.recordedAt >= input.from)) continue;
    const status: UpgradeRoomOfflineItem["status"] =
      job.state === "completed" || job.state === "failed" || job.state === "cancelled"
        ? job.state
        : job.outcome === undefined
          ? "running"
          : "unknown";
    const questions = job.questions.map((question) => ({
      question: question.question,
      handledAs: question.handledAs,
    }));
    items.push({
      jobId: job.record.jobId,
      request: job.record.request,
      status,
      startedAt: iso(job.record.createdAt),
      ...(job.outcome ? { finishedAt: iso(job.outcome.recordedAt) } : {}),
      ...(questions.length > 0 ? { questions } : {}),
    });
  }
  return { from: iso(input.from), to: iso(input.to), items };
}

type TurnStartEvent = Extract<OrchestrationEvent, { type: "thread.turn-start-requested" }>;
type RoomTurnRequest = { readonly messageId: MessageId; readonly requestedAt: string };

export interface UpgradeRoomTurnsDeps {
  readonly journal: WatchdogJournal;
  readonly engine: OrchestrationEngineShape;
  readonly queries: Pick<ProjectionSnapshotQueryShape, "getThreadRuntimeContext">;
  readonly serverConfig: ServerConfig["Service"];
  /** Re-submits a released turn-start to the per-thread command worker. */
  readonly enqueue: (event: OrchestrationEvent) => Effect.Effect<void>;
  readonly launch?: typeof launchWatchdogExecution;
  readonly resume?: typeof resumeDetachedWatchdog;
  readonly captureCheckpoint?: CheckpointReactorShape["captureDetachedTurn"];
  readonly entry?: string;
}

export interface UpgradeRoomLaunchInput {
  readonly event: TurnStartEvent;
  readonly messageText: string;
  readonly request: Omit<ProviderSendTurnInput, "threadId"> & {
    readonly modelSelection: ModelSelection;
  };
  readonly cwd: string;
  readonly settings: ServerSettings;
  readonly instance: ProviderInstanceConfig;
  readonly continuity: UpgradeRoomContinuity;
}

const roomThreadId = upgradeRoomIds.threadId;
const nowIso = Effect.map(Clock.currentTimeMillis, iso);
const logged = <A, E, R>(label: string, effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.asVoid,
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : Effect.logWarning(label, { cause: Cause.pretty(cause) }),
    ),
  );

export function makeUpgradeRoomTurns(deps: UpgradeRoomTurnsDeps) {
  const { journal, engine } = deps;
  const released = new Set<string>();
  let busy = false;

  const unsettledJobs = () =>
    journal.listUnsettledForRun(roomThreadId, UPGRADE_ROOM_RUN_ID, WATCHDOG_PROJECTION_CONSUMER);
  const pendingTurns = () =>
    journal.listPendingUpgradeRoomTurns((eventId) => upgradeRoomTurnIds(eventId).jobId);

  const activity = (input: {
    readonly id: string;
    readonly kind: string;
    readonly tone: "info" | "error";
    readonly summary: string;
    readonly payload: unknown;
  }) =>
    Effect.gen(function* () {
      const createdAt = yield* nowIso;
      yield* engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make(input.id),
        threadId: roomThreadId,
        createdAt,
        activity: {
          id: EventId.make(input.id),
          kind: input.kind,
          tone: input.tone,
          summary: input.summary,
          payload: input.payload,
          turnId: null,
          createdAt,
        },
      });
    });

  const setSession = (input: {
    readonly jobId: string;
    readonly status: OrchestrationSession["status"];
    readonly provider: string;
    readonly providerInstanceId: string;
    readonly lastError?: string;
    readonly recoveryAt?: number;
    readonly turnRequest?: RoomTurnRequest;
  }) =>
    Effect.gen(function* () {
      const updatedAt = yield* nowIso;
      yield* engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make(
          `upgrade-room-session:${input.jobId}:${input.status}${input.recoveryAt === undefined ? "" : `:${input.recoveryAt}`}`,
        ),
        threadId: roomThreadId,
        ...(input.turnRequest ? { turnRequest: input.turnRequest } : {}),
        session: {
          threadId: roomThreadId,
          status: input.status,
          providerName: input.provider,
          providerInstanceId: ProviderInstanceId.make(input.providerInstanceId),
          runtimeMode: "full-access",
          activeTurnId:
            input.status === "running" ? TurnId.make(`upgrade-room:${input.jobId}`) : null,
          lastError: input.lastError ?? null,
          updatedAt,
        },
        createdAt: updatedAt,
      });
    });

  const expireUnclaimed = (jobId: string) =>
    Clock.currentTimeMillis.pipe(
      Effect.map((now) =>
        journal.expireUnclaimedUpgradeRoomJob(jobId, now - UNCLAIMED_LAUNCH_TIMEOUT_MS),
      ),
      Effect.asVoid,
    );

  /** Starts the oldest waiting turn once nothing in the room is unsettled. */
  const releaseNext: Effect.Effect<void> = Effect.gen(function* () {
    while (!busy && unsettledJobs().length === 0) {
      const next = pendingTurns()[0];
      if (!next) return;
      const found = yield* engine.readEvents(next.eventSequence - 1, 1).pipe(Stream.runHead);
      if (
        Option.isNone(found) ||
        found.value.eventId !== next.turnEventId ||
        found.value.type !== "thread.turn-start-requested" ||
        found.value.payload.threadId !== roomThreadId
      ) {
        journal.settleUpgradeRoomTurn(next.turnEventId, "dropped");
        continue;
      }
      released.add(next.turnEventId);
      yield* deps.enqueue(found.value);
      return;
    }
  }).pipe((effect) => logged("Could not release the next upgrade room turn", effect));

  /**
   * A room answer that ends with a question opens the same text-question card as an
   * ordinary conversation; answering it starts the next room request.
   */
  const openTextQuestion = (projection: ProjectionInput) =>
    Effect.gen(function* () {
      const turnId = projection.foregroundTurnId;
      if (
        !turnId ||
        !isTextQuestionTurn(projection.provider, projection.worker.modelSelection.model)
      )
        return;
      const owner = yield* deps.queries.getThreadRuntimeContext(roomThreadId, {
        messages: true,
        activityKinds: ["user-input.requested"],
      });
      if (Option.isNone(owner)) return;
      if (
        owner.value.activities.some(
          (activity) => activity.kind === "user-input.requested" && activity.turnId === turnId,
        )
      )
        return;
      const messageId = workspaceExecutionMessageId(projection.worker.execution);
      const message = owner.value.messages.find((entry) => entry.id === messageId);
      const questions = message ? parseTextQuestions(projection.provider, message.text) : null;
      if (!questions) return;
      const createdAt = yield* nowIso;
      const id = `text-question-open:${roomThreadId}:${turnId}`;
      yield* engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make(id),
        threadId: roomThreadId,
        createdAt,
        activity: {
          id: EventId.make(id),
          kind: "user-input.requested",
          tone: "info",
          summary: textQuestionSummary(projection.provider),
          payload: { requestId: `text-question:${turnId}`, questions },
          turnId,
          createdAt,
        },
      });
    });

  /** Projects a running job into the room until its stream is settled. */
  const settle = (
    projection: ProjectionInput,
    result:
      | { readonly status: "finished" }
      | { readonly status: "unknown"; readonly outcome: string; readonly stopped?: true },
  ) =>
    Effect.gen(function* () {
      const identity = {
        jobId: projection.jobId,
        provider: projection.provider,
        providerInstanceId: projection.providerInstanceId,
      };
      if (result.status === "unknown") {
        if (projection.foregroundTurnId) {
          yield* engine.dispatch({
            type: "thread.message.assistant.complete",
            commandId: CommandId.make(`upgrade-room-unknown-reply:${projection.jobId}`),
            threadId: roomThreadId,
            messageId: workspaceExecutionMessageId(projection.worker.execution),
            turnId: projection.foregroundTurnId,
            createdAt: yield* nowIso,
          });
        }
        yield* logged(
          "Could not mark the upgrade room session",
          setSession(
            result.stopped
              ? { ...identity, status: "interrupted" }
              : {
                  ...identity,
                  status: "error",
                  lastError: `작업 결과를 확인하지 못했습니다 (${result.outcome}). 중복 실행하지 않고 기록을 보존합니다.`,
                },
          ),
        );
        const finalized = journal.finalizeUncertainUpgradeRoomJob(
          projection.jobId,
          projection.consumer,
        );
        unifiedExecutionLedger.finish({
          executionId: projection.jobId,
          executionKind: "upgrade_room",
          status: result.stopped ? "cancelled" : "failed",
          errorMessage: result.stopped
            ? "업그레이드 방 작업이 중단되었습니다."
            : `작업 결과를 확인하지 못했습니다 (${result.outcome}).`,
        });
        busy = false;
        if (finalized) yield* releaseNext;
        return;
      }
      const state = journal.get(projection.jobId)?.state;
      const submitted = journal.getSubmission(projection.jobId) !== undefined;
      if (submitted && deps.captureCheckpoint) {
        const capture = deps.captureCheckpoint({
          threadId: roomThreadId,
          turnId: TurnId.make(`upgrade-room:${projection.jobId}`),
          assistantMessageId: MessageId.make(
            workspaceExecutionMessageId(projection.worker.execution),
          ),
          completedAt: yield* nowIso,
        });
        yield* capture.pipe(
          Effect.catch((error) =>
            Effect.logWarning("Upgrade room checkpoint failed; retrying", {
              jobId: projection.jobId,
              error,
            }).pipe(
              Effect.andThen(
                capture.pipe(
                  Effect.delay("10 seconds"),
                  Effect.retry(Schedule.spaced("10 seconds")),
                ),
              ),
            ),
          ),
        );
      }
      const lastError = !submitted
        ? "실행을 시작하지 못했습니다. 요청을 자동으로 다시 보내지 않았습니다."
        : state === "failed"
          ? "업그레이드 작업이 실패했습니다."
          : undefined;
      if (state === "completed")
        yield* logged(
          "Could not open the upgrade room question card",
          openTextQuestion(projection),
        );
      yield* setSession({
        ...identity,
        status: lastError ? "error" : "ready",
        ...(lastError ? { lastError } : {}),
      });
      journal.completeUpgradeRoomFinalization(projection.jobId);
      unifiedExecutionLedger.finish({
        executionId: projection.jobId,
        executionKind: "upgrade_room",
        status: !submitted
          ? "failed"
          : state === "completed"
            ? "completed"
            : state === "cancelled"
              ? "cancelled"
              : "failed",
        errorMessage: lastError ?? null,
      });
      busy = false;
      yield* releaseNext;
    });

  const follow = (projection: ProjectionInput) =>
    Effect.gen(function* () {
      while (true) {
        yield* expireUnclaimed(projection.jobId);
        const progress = yield* drainWatchdogProjection(projection);
        if (progress.status === "finished") return yield* settle(projection, progress);
        if (progress.status === "unknown") return yield* settle(projection, progress);
        if (progress.applied === 0) yield* Effect.sleep("250 millis");
      }
    }).pipe(
      Effect.catchCause((cause) => {
        const interrupted = Cause.hasInterruptsOnly(cause);
        unifiedExecutionLedger.finish({
          executionId: projection.jobId,
          executionKind: "upgrade_room",
          status: interrupted ? "cancelled" : "failed",
          errorMessage: interrupted ? "업그레이드 방 추적이 중단되었습니다." : Cause.pretty(cause),
        });
        return interrupted
          ? Effect.failCause(cause)
          : Effect.logWarning("Upgrade room projection stopped", {
              cause: Cause.pretty(cause),
            }).pipe(Effect.andThen(Effect.sync(() => (busy = false))));
      }),
    );

  /** Records the turn durably and decides whether it may start now. */
  const admit = (event: TurnStartEvent) =>
    Effect.gen(function* () {
      const { jobId } = upgradeRoomTurnIds(event.eventId);
      const queuedAt = yield* Clock.currentTimeMillis;
      let rewind: Promise<void> | undefined;
      while ((rewind = journal.upgradeRoomRewindPending())) {
        const currentRewind = rewind;
        yield* Effect.promise(() => currentRewind);
      }
      const decision = decideUpgradeRoomAdmission({
        jobExists: journal.get(jobId) !== undefined,
        state: journal.upgradeRoomTurnState(event.eventId),
        busy,
        unsettled: unsettledJobs().length,
        olderPending: pendingTurns().filter(
          (turn) => turn.turnEventId !== event.eventId && turn.eventSequence < event.sequence,
        ).length,
      });
      if (decision === "duplicate") return decision;
      journal.admitUpgradeRoomTurn({
        turnEventId: event.eventId,
        eventSequence: event.sequence,
        messageId: event.payload.messageId,
        queuedAt,
        state: decision === "start" ? "started" : "queued",
      });
      if (decision === "start") {
        journal.settleUpgradeRoomTurn(event.eventId, "started");
        busy = true;
        return decision;
      }
      yield* logged(
        "Could not record a queued upgrade room turn",
        activity({
          id: `upgrade-room-queued:${event.eventId}`,
          kind: "upgrade-room.turn-queued",
          tone: "info",
          summary: "진행 중인 작업이 끝나면 이 요청을 이어서 시작합니다.",
          payload: { messageId: event.payload.messageId },
        }),
      );
      return decision;
    });

  /** A turn handled outside the detached path must never be replayed by recovery. */
  const markHandledElsewhere = (event: TurnStartEvent) =>
    Effect.gen(function* () {
      journal.admitUpgradeRoomTurn({
        turnEventId: event.eventId,
        eventSequence: event.sequence,
        messageId: event.payload.messageId,
        queuedAt: yield* Clock.currentTimeMillis,
        state: "dropped",
      });
      journal.settleUpgradeRoomTurn(event.eventId, "dropped");
    });

  const fail = (event: TurnStartEvent, detail: string, provider: string, instanceId: string) =>
    Effect.gen(function* () {
      const { jobId } = upgradeRoomTurnIds(event.eventId);
      yield* logged(
        "Could not record an upgrade room start failure",
        activity({
          id: `upgrade-room-start-failed:${event.eventId}`,
          kind: "provider.turn.start.failed",
          tone: "error",
          summary: "업그레이드 작업을 시작하지 못했습니다",
          payload: { detail, messageId: event.payload.messageId },
        }),
      );
      yield* logged(
        "Could not mark the upgrade room session",
        setSession({
          jobId,
          status: "error",
          provider,
          providerInstanceId: instanceId,
          lastError: detail,
        }),
      );
    });

  const launch = (input: UpgradeRoomLaunchInput) =>
    Effect.gen(function* () {
      const { event, request, instance } = input;
      const { jobId, nodeId } = upgradeRoomTurnIds(event.eventId);
      const modelSelection = request.modelSelection;
      const instanceId = modelSelection.instanceId;
      const provider = instance.driver as ProviderDriverKind;
      const execution = {
        executionId: ProviderExecutionId.make(jobId),
        ownerThreadId: roomThreadId,
        runId: WorkspaceCollaborationRunId.make(UPGRADE_ROOM_RUN_ID),
        nodeId: WorkspaceTaskNodeId.make(nodeId),
        attempt: 1,
      };
      const startedAt = yield* nowIso;
      const interactionMode = request.interactionMode ?? "default";
      const title = upgradeRoomRequestLine(input.messageText);
      const turnRequest = {
        messageId: event.payload.messageId,
        requestedAt: event.payload.createdAt,
      };
      const worker: WorkspaceAgentExecutionInput = {
        execution,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode,
        cwd: input.cwd,
        prompt: "",
        title,
        displayName: modelSelection.model || "업그레이드 작업",
        role: "implementer",
        kind: "implementation",
        startedAt,
      };
      const projection: ProjectionInput = {
        engine,
        queries: deps.queries,
        journal,
        jobId,
        consumer: WATCHDOG_PROJECTION_CONSUMER,
        provider,
        providerInstanceId: instanceId,
        worker,
        foregroundTurnId: TurnId.make(`upgrade-room:${jobId}`),
      };
      const sessionId = ThreadId.make(jobId);
      yield* unifiedExecutionLedger.beginEffect({
        executionId: jobId,
        executionKind: "upgrade_room",
        threadId: roomThreadId,
        parentRunId: UPGRADE_ROOM_RUN_ID,
        summary: `업그레이드 방: ${title.slice(0, 80)}`,
        provider,
        model: modelSelection.model,
      });
      yield* logged(
        "Could not mark the upgrade room session",
        setSession({
          jobId,
          status: "running",
          provider,
          providerInstanceId: instanceId,
          turnRequest,
        }),
      );
      const createdAt = yield* Clock.currentTimeMillis;
      const result = yield* (deps.launch ?? launchWatchdogExecution)({
        journal,
        jobId,
        entry: deps.entry ?? watchdogWorkerEntrypoint(),
        signal: AbortSignal.timeout(10_000),
        serverConfig: deps.serverConfig,
        settings: input.settings,
        instance,
        providerInstanceId: instanceId,
        execution,
        start: {
          threadId: sessionId,
          execution,
          provider,
          providerInstanceId: instanceId,
          cwd: input.cwd,
          runtimeMode: "full-access",
          modelSelection,
          ...(input.continuity.resumeCursor === undefined
            ? {}
            : { resumeCursor: input.continuity.resumeCursor }),
        },
        turn: {
          ...request,
          threadId: sessionId,
          modelSelection,
          interactionMode,
        },
        separateProcessTree: true,
        upgradeRoomJob: {
          turnEventId: event.eventId,
          turnSequence: event.sequence,
          request: title,
          offlineQuestions: upgradeRoomOfflineQuestionPolicy(input.settings),
          continuity: input.continuity.continuity,
          projection: encodeJson({ ...worker, turnRequest }),
          createdAt,
        },
        beforeSpawn: beginWatchdogProjection(projection).pipe(Effect.asVoid, Effect.orDie),
      }).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : Effect.succeed({ status: "not-started" as const, detail: Cause.pretty(cause) }),
        ),
      );
      if (result.status === "unsettled") {
        journal.settleUpgradeRoomTurn(event.eventId, "queued");
        unifiedExecutionLedger.finish({
          executionId: jobId,
          executionKind: "upgrade_room",
          status: "cancelled",
          errorMessage: "이전 작업 미정산으로 시작이 보류되었습니다.",
        });
        busy = false;
        yield* fail(
          event,
          "이전 작업의 결과가 아직 반영되지 않아 시작하지 않았습니다. 이전 작업이 정리되면 이어서 시작합니다.",
          provider,
          instanceId,
        );
        return;
      }
      if (result.status === "not-started") {
        journal.settleUpgradeRoomTurn(event.eventId, "dropped");
        if (journal.upgradeRoomJob(jobId) && journal.isSealed(jobId)) {
          yield* follow(projection);
          return;
        }
        unifiedExecutionLedger.finish({
          executionId: jobId,
          executionKind: "upgrade_room",
          status: "failed",
          errorMessage: "작업 프로세스를 시작하지 못했습니다.",
        });
        busy = false;
        yield* fail(
          event,
          "작업 프로세스를 시작하지 못했습니다. 선택한 모델과 도구 연결 상태를 확인하세요.",
          provider,
          instanceId,
        );
        yield* releaseNext;
        return;
      }
      if (input.continuity.note === "instance-changed" || input.continuity.note === "no-cursor")
        yield* logged(
          "Could not record upgrade room continuity",
          activity({
            id: `upgrade-room-fresh:${jobId}`,
            kind: "upgrade-room.fresh-session",
            tone: "info",
            summary:
              input.continuity.note === "instance-changed"
                ? "선택한 AI 연결이 바뀌어 새 대화로 시작하고 이전 대화 내용을 인계했습니다."
                : "이어갈 공급자 대화가 없어 새 대화로 시작하고 이전 대화 내용을 인계했습니다.",
            payload: { jobId, note: input.continuity.note },
          }),
        );
      yield* follow(projection);
    });

  /** Stop requests are durable; the worker observes them and stops its provider session. */
  const interrupt = Effect.sync(() => {
    const jobs = journal.listActiveForRun(roomThreadId, UPGRADE_ROOM_RUN_ID);
    for (const job of jobs) journal.requestCancel(job.id);
    return jobs.length;
  });

  const reattach = (jobId: string) =>
    Effect.gen(function* () {
      const record = journal.upgradeRoomJob(jobId);
      const identity = journal.executionProvider(jobId);
      if (!record || !identity) {
        yield* Effect.logWarning("Upgrade room job has no recorded projection", { jobId });
        return;
      }
      const worker = decodeJson(record.projection) as WorkspaceAgentExecutionInput & {
        readonly turnRequest?: RoomTurnRequest;
      };
      if (String(worker.execution?.executionId) !== jobId)
        throw new Error("Upgrade room projection does not match its job.");
      const projection: ProjectionInput = {
        engine,
        queries: deps.queries,
        journal,
        jobId,
        consumer: WATCHDOG_PROJECTION_CONSUMER,
        provider: identity.provider as ProviderDriverKind,
        providerInstanceId: worker.modelSelection.instanceId,
        worker,
        // Jobs created before the change keep their original projection until they settle.
        ...(worker.turnRequest ? { foregroundTurnId: TurnId.make(`upgrade-room:${jobId}`) } : {}),
      };
      busy = true;
      const result = yield* (deps.resume ?? resumeDetachedWatchdog)({
        ...projection,
        activate: Effect.gen(function* () {
          yield* logged(
            "Could not restore the running upgrade room session",
            setSession({
              jobId,
              provider: projection.provider,
              providerInstanceId: projection.providerInstanceId,
              status: "running",
              ...(worker.turnRequest ? { turnRequest: worker.turnRequest } : {}),
              recoveryAt: yield* Clock.currentTimeMillis,
            }),
          );
        }),
        deactivate: Effect.void,
        beforeRead: expireUnclaimed(jobId),
      });
      yield* settle(projection, result);
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("Could not reattach an upgrade room job", {
              jobId,
              cause: Cause.pretty(cause),
            }).pipe(Effect.andThen(Effect.sync(() => (busy = false)))),
      ),
    );

  /** Room turn-starts persisted after the last recorded one were never admitted. */
  const admitMissedTurns = Effect.gen(function* () {
    const latest = journal.latestUpgradeRoomTurnSequence();
    if (latest === undefined) return;
    const queuedAt = yield* Clock.currentTimeMillis;
    yield* engine.readEvents(latest, 10_000).pipe(
      Stream.runForEach((event) =>
        Effect.sync(() => {
          if (
            event.type !== "thread.turn-start-requested" ||
            event.payload.threadId !== roomThreadId ||
            journal.upgradeRoomTurnState(event.eventId) !== undefined
          )
            return;
          journal.admitUpgradeRoomTurn({
            turnEventId: event.eventId,
            eventSequence: event.sequence,
            messageId: event.payload.messageId,
            queuedAt,
            state: "queued",
          });
        }),
      ),
    );
  });

  const offlineSummary = (from: number, to: number, unsettled: ReadonlySet<string>) =>
    buildUpgradeRoomOfflineSummary({
      from,
      to,
      jobs: journal.listUpgradeRoomJobs().map((record) => {
        const outcome = journal.workerOutcome(record.jobId);
        return {
          record,
          state: journal.get(record.jobId)?.state,
          ...(outcome ? { outcome } : {}),
          unsettledAtStartup: unsettled.has(record.jobId),
          questions: journal.listUpgradeRoomQuestions(record.jobId),
        };
      }),
    });

  /**
   * Restore the queue before reattaching jobs: a terminal job may release
   * the oldest waiting turn immediately.
   */
  const startup = (options?: { readonly importOfflineMemory?: Effect.Effect<void> }) =>
    Effect.gen(function* () {
      const previous = journal.upgradeRoomBackendHeartbeat();
      const now = yield* Clock.currentTimeMillis;
      const contexts = journal
        .listReconciliationContexts(WATCHDOG_PROJECTION_CONSUMER)
        .filter((entry) => entry.threadId === roomThreadId && entry.runId === UPGRADE_ROOM_RUN_ID);
      const summary =
        previous === undefined
          ? undefined
          : offlineSummary(previous, now, new Set(contexts.map((entry) => entry.id)));
      journal.writeUpgradeRoomBackendHeartbeat(now);
      yield* Effect.forkScoped(
        Effect.forever(
          Effect.sleep("10 seconds").pipe(
            Effect.andThen(Clock.currentTimeMillis),
            Effect.flatMap((at) => Effect.sync(() => journal.writeUpgradeRoomBackendHeartbeat(at))),
            (effect) => logged("Could not write the upgrade room heartbeat", effect),
          ),
        ),
      );
      if (options?.importOfflineMemory)
        yield* logged("Could not import offline upgrade room memory", options.importOfflineMemory);
      if (summary && summary.items.length > 0)
        yield* logged(
          "Could not record the upgrade room offline summary",
          activity({
            id: `upgrade-room-offline:${previous}`,
            kind: UPGRADE_ROOM_OFFLINE_WORK_KIND,
            tone: "info",
            summary: "T3가 꺼져 있는 동안 진행된 업그레이드 작업",
            payload: summary,
          }),
        );
      yield* logged("Could not recover missed upgrade room turns", admitMissedTurns);
      for (const context of contexts) yield* Effect.forkScoped(reattach(context.id));
      if (contexts.length === 0) yield* releaseNext;
    });

  /** A started turn that failed before its job existed frees the room for the next one. */
  const abandon = (event: TurnStartEvent) =>
    Effect.gen(function* () {
      if (journal.get(upgradeRoomTurnIds(event.eventId).jobId) !== undefined) return;
      if (journal.upgradeRoomTurnState(event.eventId) !== "started") return;
      journal.settleUpgradeRoomTurn(event.eventId, "dropped");
      busy = false;
      yield* releaseNext;
    });

  return {
    admit,
    abandon,
    continuity: (providerInstanceId: string, hasEarlierMessage: boolean) =>
      chooseUpgradeRoomContinuity(
        journal.latestUpgradeRoomResume(),
        providerInstanceId,
        hasEarlierMessage,
      ),
    launch,
    interrupt,
    startup,
    markHandledElsewhere,
    fail,
    /** A released turn bypasses the recent turn-start dedupe exactly once. */
    takeReleased: (eventId: string) => released.delete(eventId),
    isBusy: () => busy,
  };
}

export type UpgradeRoomTurns = ReturnType<typeof makeUpgradeRoomTurns>;
