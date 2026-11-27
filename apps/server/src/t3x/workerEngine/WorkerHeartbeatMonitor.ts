import { WORKER_HEARTBEAT_ABORT_MS, WORKER_HEARTBEAT_STALL_MS } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schedule from "effect/Schedule";

import type { WorkerEngineStore } from "./WorkerEngineStore.ts";
import type { WorkerMailboxService } from "./WorkerMailboxService.ts";

export interface WorkerTimeoutAbortMeta {
  readonly kind: "max_wall_time" | "max_idle";
  readonly elapsedMs: number;
  readonly idleMs: number;
  readonly extendedMs: number;
}

export interface TrackedWorkerDispatch {
  readonly taskId: string;
  readonly dispatchId: string;
  readonly runId: string;
  readonly threadId: string;
  readonly fencingToken: number;
  readonly toActor: string;
  readonly startedAtMs: number;
  lastActivityAtMs: number;
  lastDbPersistAtMs: number;
  readonly heartbeatTimeoutMs: number;
  readonly maxIdleMs: number;
  readonly maxWallTimeMs: number | null;
  readonly maxWallExtensionMs: number;
  readonly streamingGraceWindowMs: number;
  wallExtensionAppliedMs: number;
  stalledNotified: boolean;
  readonly onTimeoutAbort: (reason: string, meta?: WorkerTimeoutAbortMeta) => Effect.Effect<void>;
}

export interface WorkerHeartbeatMonitorOptions {
  readonly sweepIntervalMs?: number | undefined;
  readonly dbDebounceMs?: number | undefined;
  readonly startBackgroundFiber?: boolean | undefined;
  /** Maximum extra wall time granted while streaming/tool activity keeps arriving (default: min(180s, maxWallTimeMs)). */
  readonly maxWallExtensionMs?: number | undefined;
  /** Recent activity window that qualifies a dispatch for wall-time streaming grace (default: min(60s, maxWallTimeMs/2)). */
  readonly streamingGraceWindowMs?: number | undefined;
}

/**
 * Monitors running worker dispatches using Effect `Clock` (works identically
 * under live clock and `TestClock`):
 *  - Debounces DB heartbeat writes during active tool/text streaming.
 *  - At `heartbeatTimeoutMs` (default 5 min, Orca standard): transitions
 *    dispatch `running -> stalled` and emits one `escalation` mailbox message.
 *  - At `maxWallTimeMs`: if recent streaming/tool activity is actively arriving,
 *    grants bounded streaming grace extensions up to `maxWallTimeMs + maxWallExtensionMs`
 *    instead of cutting off live output mid-stream.
 *  - At `maxIdleMs` (default 15 min) or wall-time ceiling: triggers timeout failure
 *    via `onTimeoutAbort` (preserving partial output, never auto-retrying).
 */
export const makeWorkerHeartbeatMonitor = Effect.fn("WorkerHeartbeatMonitor.make")(function* (
  store: WorkerEngineStore,
  mailbox: WorkerMailboxService,
  options?: WorkerHeartbeatMonitorOptions,
) {
  const tracked = new Map<string, TrackedWorkerDispatch>();
  const dbDebounceMs = options?.dbDebounceMs ?? 30_000;
  const sweepIntervalMs = options?.sweepIntervalMs ?? 15_000;

  const register = (input: {
    readonly taskId: string;
    readonly dispatchId: string;
    readonly runId: string;
    readonly threadId: string;
    readonly fencingToken: number;
    readonly toActor: string;
    readonly heartbeatTimeoutMs?: number | undefined;
    readonly maxIdleMs?: number | undefined;
    readonly maxWallTimeMs?: number | null | undefined;
    readonly maxWallExtensionMs?: number | undefined;
    readonly streamingGraceWindowMs?: number | undefined;
    readonly onTimeoutAbort: (reason: string, meta?: WorkerTimeoutAbortMeta) => Effect.Effect<void>;
  }) =>
    Effect.gen(function* () {
      const nowMs = yield* Clock.currentTimeMillis;
      const baseWallMs = input.maxWallTimeMs ?? null;
      const maxWallExtensionMs =
        baseWallMs === null
          ? 0
          : Math.max(
              0,
              input.maxWallExtensionMs ??
                options?.maxWallExtensionMs ??
                Math.min(180_000, baseWallMs),
            );
      const streamingGraceWindowMs =
        baseWallMs === null
          ? 60_000
          : Math.max(
              1_000,
              input.streamingGraceWindowMs ??
                options?.streamingGraceWindowMs ??
                Math.min(60_000, Math.floor(baseWallMs / 2)),
            );
      tracked.set(input.dispatchId, {
        taskId: input.taskId,
        dispatchId: input.dispatchId,
        runId: input.runId,
        threadId: input.threadId,
        fencingToken: input.fencingToken,
        toActor: input.toActor,
        startedAtMs: nowMs,
        lastActivityAtMs: nowMs,
        lastDbPersistAtMs: nowMs,
        heartbeatTimeoutMs: input.heartbeatTimeoutMs ?? WORKER_HEARTBEAT_STALL_MS,
        maxIdleMs: input.maxIdleMs ?? WORKER_HEARTBEAT_ABORT_MS,
        maxWallTimeMs: baseWallMs,
        maxWallExtensionMs,
        streamingGraceWindowMs,
        wallExtensionAppliedMs: 0,
        stalledNotified: false,
        onTimeoutAbort: input.onTimeoutAbort,
      });
    });

  const unregister = (dispatchId: string) =>
    Effect.sync(() => {
      tracked.delete(dispatchId);
    });

  const touchActivity = (dispatchId: string, toolSummary?: string | null) =>
    Effect.gen(function* () {
      const entry = tracked.get(dispatchId);
      if (!entry) return;
      const nowMs = yield* Clock.currentTimeMillis;
      entry.lastActivityAtMs = nowMs;
      const shouldPersist =
        entry.stalledNotified || nowMs - entry.lastDbPersistAtMs >= dbDebounceMs;
      entry.stalledNotified = false;
      if (shouldPersist) {
        entry.lastDbPersistAtMs = nowMs;
        yield* store
          .recordHeartbeat(entry.dispatchId, entry.fencingToken, toolSummary)
          .pipe(Effect.ignore);
      }
    });

  const sweepOnce = (): Effect.Effect<{
    readonly stalled: ReadonlyArray<string>;
    readonly aborted: ReadonlyArray<string>;
  }> =>
    Effect.gen(function* () {
      const nowMs = yield* Clock.currentTimeMillis;
      const stalled: string[] = [];
      const aborted: string[] = [];

      for (const entry of [...tracked.values()]) {
        const idleMs = nowMs - entry.lastActivityAtMs;
        const wallMs = nowMs - entry.startedAtMs;

        if (
          entry.maxWallTimeMs !== null &&
          wallMs >= entry.maxWallTimeMs + entry.wallExtensionAppliedMs
        ) {
          const hasActiveStreaming =
            entry.lastActivityAtMs > entry.startedAtMs &&
            idleMs < entry.streamingGraceWindowMs &&
            entry.wallExtensionAppliedMs < entry.maxWallExtensionMs;
          if (hasActiveStreaming) {
            const stepMs = Math.min(
              entry.streamingGraceWindowMs,
              entry.maxWallExtensionMs - entry.wallExtensionAppliedMs,
            );
            entry.wallExtensionAppliedMs += Math.max(1_000, stepMs);
            continue;
          }
          tracked.delete(entry.dispatchId);
          aborted.push(entry.dispatchId);
          const effectiveLimitSec = Math.round(
            (entry.maxWallTimeMs + entry.wallExtensionAppliedMs) / 1000,
          );
          const reason = `시간 초과 실패: 작업자 실행 시간 상한(${effectiveLimitSec}초)을 초과했습니다.`;
          yield* entry
            .onTimeoutAbort(reason, {
              kind: "max_wall_time",
              elapsedMs: wallMs,
              idleMs,
              extendedMs: entry.wallExtensionAppliedMs,
            })
            .pipe(Effect.ignore);
          continue;
        }

        if (idleMs >= entry.maxIdleMs) {
          tracked.delete(entry.dispatchId);
          aborted.push(entry.dispatchId);
          const reason = `시간 초과 실패: 작업자가 ${Math.round(idleMs / 1000)}초 동안 무응답 상태였습니다.`;
          yield* entry
            .onTimeoutAbort(reason, {
              kind: "max_idle",
              elapsedMs: wallMs,
              idleMs,
              extendedMs: entry.wallExtensionAppliedMs,
            })
            .pipe(Effect.ignore);
          continue;
        }

        if (!entry.stalledNotified && idleMs >= entry.heartbeatTimeoutMs) {
          entry.stalledNotified = true;
          stalled.push(entry.dispatchId);
          yield* store
            .markDispatchStalled(entry.dispatchId, entry.fencingToken)
            .pipe(Effect.ignore);
          yield* mailbox
            .postMessage({
              runId: entry.runId,
              threadId: entry.threadId,
              taskId: entry.taskId,
              dispatchId: entry.dispatchId,
              fencingToken: entry.fencingToken,
              fromActor: `dispatch:${entry.dispatchId}`,
              toActor: entry.toActor,
              type: "escalation",
              subject: `작업자 하트비트 지연 (stalled): ${entry.taskId}`,
              body: `작업자 디스패치 ${entry.dispatchId}가 ${Math.round(idleMs / 1000)}초 동안 활동 신호가 없어 stalled 상태로 전환되었습니다.`,
              payload: {
                kind: "heartbeat_stalled",
                idleMs,
                heartbeatTimeoutMs: entry.heartbeatTimeoutMs,
              },
            })
            .pipe(Effect.ignore);
        }
      }

      return { stalled, aborted };
    });

  if (options?.startBackgroundFiber !== false) {
    const fiber = yield* sweepOnce().pipe(
      Effect.repeat(Schedule.spaced(Duration.millis(sweepIntervalMs))),
      Effect.forkScoped,
    );
    yield* Effect.addFinalizer(() => Fiber.interrupt(fiber).pipe(Effect.ignore));
  }

  return {
    register,
    unregister,
    touchActivity,
    sweepOnce,
    trackedCount: () => tracked.size,
  };
});

export type WorkerHeartbeatMonitor = Effect.Success<ReturnType<typeof makeWorkerHeartbeatMonitor>>;
