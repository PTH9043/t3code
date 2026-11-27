import NodeProcess from "node:process";
import { isDeepStrictEqual } from "node:util";
import {
  CommandId,
  EventId,
  ProviderRuntimeEvent,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type TurnId,
  type WorkspaceOrchestraBlock,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { OrchestrationEngineShape } from "../Services/OrchestrationEngine.ts";
import type { ProjectionSnapshotQueryShape } from "../Services/ProjectionSnapshotQuery.ts";
import type { WorkspaceAgentExecutionInput } from "../Services/WorkspaceAgentExecutor.ts";
import { workspaceExecutionMessageId } from "../workspaceFormatRepair.ts";
import type { WatchdogJournal } from "../WatchdogJournal.ts";
import { decodeWatchdogEvent } from "../WatchdogEventReplay.ts";
import { projectWorkspaceAgentActivities } from "./WorkspaceAgentActivities.ts";
import { captureWorkspaceResearch } from "./WorkspaceResearchCapture.ts";

const decodeEvent = Schema.decodeUnknownSync(Schema.fromJsonString(ProviderRuntimeEvent));

export interface ProjectionInput {
  readonly engine: OrchestrationEngineShape;
  readonly queries: Pick<ProjectionSnapshotQueryShape, "getThreadRuntimeContext">;
  readonly journal: WatchdogJournal;
  readonly jobId: string;
  readonly consumer: string;
  readonly provider: ProviderDriverKind;
  readonly providerInstanceId: ProviderInstanceId;
  readonly worker: WorkspaceAgentExecutionInput;
  readonly foregroundTurnId?: TurnId;
  /** Whether a process with this PID exists. Defaults to asking the operating system. */
  readonly workerExists?: (pid: number) => boolean;
}

/** Three missed 10-second heartbeats before the worker's process is looked up. */
const WORKER_EXIT_GRACE_MS = 30_000;

function processExists(pid: number): boolean {
  try {
    NodeProcess.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: unknown }).code !== "ESRCH";
  }
}

/**
 * A worker killed from outside leaves no seal and no outcome, and its job would wait forever.
 * Only a missing process is proof of exit; a stale heartbeat alone is not. A reused PID reads
 * as alive, which keeps waiting rather than failing a live job.
 */
const recordVanishedWorker = Effect.fn("recordVanishedWorker")(function* (input: ProjectionInput) {
  const worker = input.journal.worker(input.jobId);
  if (!worker) return undefined;
  const now = yield* Clock.currentTimeMillis;
  if (now - worker.lastHeartbeatAt <= WORKER_EXIT_GRACE_MS) return undefined;
  if ((input.workerExists ?? processExists)(worker.pid)) return undefined;
  // The process is gone, so nothing below can change after it is read.
  if (input.journal.read(input.jobId, input.journal.cursor(input.jobId, input.consumer), 1).length)
    return undefined;
  if (!input.journal.recordWorkerExit(input.jobId, worker.workerId, now)) return undefined;
  yield* Effect.logWarning("Watchdog worker process exited without closing its stream", {
    jobId: input.jobId,
    pid: worker.pid,
  });
  return input.journal.workerOutcome(input.jobId);
});

function context(input: ProjectionInput) {
  const { execution } = input.worker;
  const job = input.journal.get(input.jobId);
  if (
    job?.executionId !== execution.executionId ||
    job.threadId !== execution.ownerThreadId ||
    input.worker.modelSelection.instanceId !== input.providerInstanceId
  )
    throw new Error("Watchdog projection does not match its owning execution.");
  const messageId = workspaceExecutionMessageId(execution);
  const blockKey = `${execution.executionId}:${execution.attempt}`;
  const block: WorkspaceOrchestraBlock = {
    ...execution,
    ...(input.worker.usageWorkId === undefined ? {} : { usageWorkId: input.worker.usageWorkId }),
    messageId,
    title: input.worker.title,
    displayName: input.worker.displayName,
    ...(input.worker.instruction === undefined ? {} : { instruction: input.worker.instruction }),
    role: input.worker.role,
    kind: input.worker.kind,
    ...(input.worker.usagePhase === undefined ? {} : { usagePhase: input.worker.usagePhase }),
    modelSelection: input.worker.modelSelection,
    status: "running",
  };
  return { execution, job, messageId, blockKey, block };
}

/** Create the same conversation block and message used by in-process orchestra execution. */
export const beginWatchdogProjection = Effect.fn("beginWatchdogProjection")(function* (
  input: ProjectionInput,
) {
  const { execution, messageId, blockKey, block } = context(input);
  if (!input.foregroundTurnId)
    yield* input.engine.dispatch({
      type: "thread.activity.append",
      threadId: execution.ownerThreadId,
      commandId: CommandId.make(`watchdog-block:${blockKey}:begin`),
      createdAt: input.worker.startedAt,
      activity: {
        id: EventId.make(`orchestra-block:${blockKey}`),
        kind: "orchestra.block",
        tone: "info",
        summary: input.worker.title,
        payload: block,
        turnId: null,
        createdAt: input.worker.startedAt,
      },
    });
  yield* input.engine.dispatch({
    type: "thread.message.assistant.delta",
    threadId: execution.ownerThreadId,
    commandId: CommandId.make(`watchdog-message:${blockKey}:begin`),
    messageId,
    ...(input.foregroundTurnId ? { turnId: input.foregroundTurnId } : {}),
    delta: "",
    createdAt: input.worker.startedAt,
  });
});

/** Apply one replayed provider event with deterministic command IDs. */
export const projectWatchdogEvent = Effect.fn("projectWatchdogEvent")(function* (
  input: ProjectionInput,
  event: ProviderRuntimeEvent,
  sequence: number,
) {
  const { execution, messageId, blockKey, block } = context(input);
  if (
    event.threadId !== String(execution.executionId) ||
    event.provider !== input.provider ||
    event.providerInstanceId !== input.providerInstanceId ||
    !isDeepStrictEqual(event.execution, execution)
  )
    throw new Error("Watchdog event does not match its owning execution.");
  if (event.type === "item.completed" && event.payload.itemType === "web_search") {
    const owner = yield* input.queries.getThreadRuntimeContext(execution.ownerThreadId);
    if (Option.isNone(owner)) throw new Error("Watchdog owning conversation is unavailable.");
    yield* captureWorkspaceResearch({
      engine: input.engine,
      projectId: owner.value.projectId,
      execution,
      title: input.worker.title,
      modelSelection: input.worker.modelSelection,
      event,
      requirePersistence: true,
    });
  }
  const delta =
    event.type === "content.delta" && event.payload.streamKind === "assistant_text"
      ? event.payload.delta
      : event.type === "item.completed" &&
          event.payload.itemType === "assistant_message" &&
          event.payload.detail !== undefined &&
          !input.journal.hasAssistantOutputBefore(input.jobId, sequence)
        ? event.payload.detail
        : undefined;
  if (delta !== undefined)
    yield* input.engine.dispatch({
      type: "thread.message.assistant.delta",
      threadId: execution.ownerThreadId,
      commandId: CommandId.make(`watchdog-delta:${blockKey}:${event.eventId}`),
      messageId,
      ...(input.foregroundTurnId ? { turnId: input.foregroundTurnId } : {}),
      delta,
      createdAt: event.createdAt,
    });
  if (input.foregroundTurnId && event.type === "turn.started") {
    const id = `watchdog-assigned:${blockKey}:${event.eventId}`;
    yield* input.engine.dispatch({
      type: "thread.activity.append",
      threadId: execution.ownerThreadId,
      commandId: CommandId.make(id),
      createdAt: event.createdAt,
      activity: {
        id: EventId.make(id),
        kind: "conversation.turn-assigned",
        tone: "info",
        summary: "AI 모델에 요청 전달",
        payload: input.worker.modelSelection,
        turnId: input.foregroundTurnId,
        createdAt: event.createdAt,
      },
    });
  }
  yield* projectWorkspaceAgentActivities({
    engine: input.engine,
    execution,
    messageId,
    event,
    ...(input.foregroundTurnId ? { foregroundTurnId: input.foregroundTurnId } : {}),
  });
  if (input.foregroundTurnId) return;
  const status =
    event.type === "request.opened" || event.type === "user-input.requested"
      ? "awaiting-user"
      : event.type === "request.resolved" || event.type === "user-input.resolved"
        ? "running"
        : undefined;
  if (status)
    yield* input.engine.dispatch({
      type: "thread.activity.append",
      threadId: execution.ownerThreadId,
      commandId: CommandId.make(`watchdog-status:${blockKey}:${event.eventId}`),
      createdAt: event.createdAt,
      activity: {
        id: EventId.make(`orchestra-block:${blockKey}`),
        kind: "orchestra.block",
        tone: "info",
        summary: input.worker.title,
        payload: { ...block, status },
        turnId: null,
        createdAt: input.worker.startedAt,
      },
    });
});

/** Complete only after the source explicitly closed and every event was applied. */
export const finishWatchdogProjection = Effect.fn("finishWatchdogProjection")(function* (
  input: ProjectionInput,
) {
  const { execution, job, messageId, blockKey, block } = context(input);
  if (
    !input.journal.isSealed(input.jobId) ||
    !["completed", "failed", "cancelled"].includes(job.state)
  )
    throw new Error("Watchdog event stream is not ready to finalize.");
  const cursor = input.journal.cursor(input.jobId, input.consumer);
  if (input.journal.read(input.jobId, cursor, 1).length > 0)
    throw new Error("Watchdog events remain unapplied.");
  const last = cursor === 0 ? undefined : input.journal.read(input.jobId, cursor - 1, 1)[0];
  if (cursor !== 0 && last?.sequence !== cursor) throw new Error("Watchdog cursor is invalid.");
  const createdAt = last ? decodeEvent(last.payload).createdAt : input.worker.startedAt;
  const status = job.state as "completed" | "failed" | "cancelled";
  yield* input.engine.dispatch({
    type: "thread.message.assistant.complete",
    threadId: execution.ownerThreadId,
    commandId: CommandId.make(`watchdog-message:${blockKey}:complete`),
    messageId,
    ...(input.foregroundTurnId ? { turnId: input.foregroundTurnId } : {}),
    createdAt,
  });
  if (input.foregroundTurnId) return;
  yield* input.engine.dispatch({
    type: "thread.activity.append",
    threadId: execution.ownerThreadId,
    commandId: CommandId.make(`watchdog-block:${blockKey}:${status}`),
    createdAt,
    activity: {
      id: EventId.make(`orchestra-block:${blockKey}`),
      kind: "orchestra.block",
      tone: status === "failed" ? "error" : "info",
      summary: input.worker.title,
      payload: { ...block, status },
      turnId: null,
      createdAt: input.worker.startedAt,
    },
  });
});

/** Apply one durable page; unknown worker outcomes remain visible and are never retried. */
export const drainWatchdogProjection = Effect.fn("drainWatchdogProjection")(function* (
  input: ProjectionInput,
  limit = 100,
) {
  const { execution } = context(input);
  const records = yield* Effect.sync(() =>
    input.journal.read(input.jobId, input.journal.cursor(input.jobId, input.consumer), limit),
  );
  for (const record of records) {
    const event = yield* Effect.sync(() =>
      decodeWatchdogEvent(
        { execution, provider: input.provider, providerInstanceId: input.providerInstanceId },
        record,
      ),
    );
    yield* projectWatchdogEvent(input, event, record.sequence);
    yield* Effect.sync(() =>
      input.journal.acknowledge(input.jobId, input.consumer, record.sequence),
    );
  }
  // The worker records its outcome after a normal seal. Read in reverse write
  // order so a newly sealed stream cannot look like an unsealed failure.
  const recorded = yield* Effect.sync(() => input.journal.workerOutcome(input.jobId));
  const sealed = yield* Effect.sync(() => input.journal.isSealed(input.jobId));
  const more = yield* Effect.sync(
    () =>
      input.journal.read(input.jobId, input.journal.cursor(input.jobId, input.consumer), 1).length >
      0,
  );
  if (more) return { status: "open" as const, applied: records.length };
  if (sealed) {
    yield* finishWatchdogProjection(input);
    return { status: "finished" as const, applied: records.length };
  }
  // Also run for a worker that recorded its own uncertain outcome: its job still reads as
  // live, and only a terminal state lets the room retire it and take the next request.
  const outcome = (yield* recordVanishedWorker(input)) ?? recorded;
  if (outcome) {
    const { blockKey } = context(input);
    const createdAt = DateTime.formatIso(DateTime.makeUnsafe(outcome.recordedAt));
    // After a stop the provider can still report the tools it was cutting off, so the worker
    // cannot prove the stream ended cleanly. The stop itself was delivered: that is a stop the
    // user asked for, not a failed job.
    const stopped =
      outcome.outcome === "drain-unknown" && input.journal.getStop(input.jobId)?.state === "sent";
    const summary = stopped
      ? "요청에 따라 작업을 중지했습니다. 중지 전까지의 기록은 보존되며 자동으로 다시 실행하지 않습니다."
      : outcome.outcome === "worker-error"
        ? "작업 프로세스가 결과를 남기지 않고 종료됐습니다. 기록을 보존하고 자동으로 다시 실행하지 않습니다."
        : outcome.outcome === "stop-sent"
          ? "감시 작업에 중지를 요청했지만 실제 종료 여부는 아직 확인되지 않았습니다."
          : outcome.outcome === "stop-unknown"
            ? "감시 작업의 중지 요청 전달 여부와 실제 종료 여부를 확인하지 못했습니다."
            : "감시 작업의 처리 결과를 확인하지 못했습니다. 기록을 보존하고 자동으로 다시 실행하지 않습니다.";
    yield* input.engine.dispatch({
      type: "thread.activity.append",
      threadId: execution.ownerThreadId,
      commandId: CommandId.make(`watchdog-uncertain:${blockKey}:${outcome.outcome}`),
      createdAt,
      activity: {
        id: EventId.make(`watchdog-uncertain:${blockKey}`),
        kind: "watchdog.uncertain",
        tone: stopped ? "info" : "error",
        summary,
        payload: {
          ...(!input.foregroundTurnId ? { executionId: execution.executionId } : {}),
          outcome: outcome.outcome,
        },
        turnId: input.foregroundTurnId ?? null,
        createdAt,
      },
    });
    return {
      status: "unknown" as const,
      applied: records.length,
      outcome: outcome.outcome,
      ...(stopped ? { stopped: true as const } : {}),
    };
  }
  return { status: "open" as const, applied: records.length };
});
