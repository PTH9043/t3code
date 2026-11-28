// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as HostPowerMonitor from "../../background/HostPowerMonitor.ts";
import { activeWorkRegistry } from "../../orchestration/ActiveWorkTracker.ts";
import * as DesktopTelemetryReceiver from "../../resourceTelemetry/DesktopTelemetryReceiver.ts";
import {
  checkFreeDiskSpaceBytes,
  evaluateDriveBackupPauseGate,
  evaluateDriveBackupStartGate,
  type StartGateDecision,
} from "./DriveBackupIdleGate.ts";
import { GoogleDriveBackupService } from "./GoogleDriveBackupService.ts";

/**
 * 무방해 Google Drive 자동 백업 스케줄러.
 *
 * - `BackgroundPolicy.shouldRunOpportunisticWork`를 절대 사용하지 않는다.
 * - `config.autoScheduleEnabled === true`일 때만 `HostPowerMonitor` + `activeWorkRegistry`를
 *   직접 검사해 모든 시작 조건(A)이 참이면 백업을 시작한다.
 * - 실행 중에는 `DesktopTelemetryReceiver`의 유휴 샘플링 주기를 1초로 승격하고,
 *   `activeWorkRegistry.subscribe` + `HostPowerMonitor.streamChanges`를 감시해
 *   중단 조건(B) 발생 즉시 `AbortController.abort()`를 호출해 ≤ 5초 내 일시정지한다.
 */

const SCHEDULER_POLL_INTERVAL = Duration.seconds(30);
const MIN_CHECK_GAP_MS = 60_000;

export interface SchedulerCycleOutcome {
  readonly action: "disabled" | "skipped" | "ran" | "paused" | "failed";
  readonly reason?: string;
  readonly runId?: string;
}

export const runDriveBackupSchedulerCycle = (input: {
  readonly backupService: GoogleDriveBackupService["Service"];
  readonly hostPowerMonitor: HostPowerMonitor.HostPowerMonitor["Service"];
  readonly telemetryReceiver?: DesktopTelemetryReceiver.DesktopTelemetryReceiver["Service"];
  readonly nowDate?: Date;
  readonly activeWorkCountOverride?: number;
  readonly minRequiredDiskBytes?: number;
}): Effect.Effect<SchedulerCycleOutcome, never> =>
  Effect.gen(function* () {
    const state = yield* input.backupService
      .getState({})
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (!state) return { action: "skipped" as const, reason: "state_unavailable" };

    const config = state.config;
    if (!config.autoScheduleEnabled) {
      return { action: "disabled" as const, reason: "auto_schedule_off" };
    }

    const hasEnabledTargets =
      state.targets.some((t) => t.enabled) ||
      config.includeCoreSettings ||
      config.includeCoreSqliteSnapshot ||
      config.includeEventArchives;
    if (!hasEnabledTargets) {
      return { action: "skipped" as const, reason: "no_targets_selected" };
    }

    const hostPower = yield* input.hostPowerMonitor.snapshot;
    const activeWorkCount =
      input.activeWorkCountOverride ?? activeWorkRegistry.snapshot().totalActive;
    const freeDiskBytes = yield* Effect.tryPromise({
      try: () => checkFreeDiskSpaceBytes(state.localStagingDir),
      catch: () => null,
    }).pipe(Effect.orElseSucceed(() => null));

    const startDecision: StartGateDecision = evaluateDriveBackupStartGate({
      config: {
        idleMinSeconds: config.idleMinSeconds,
        pauseOnBattery: config.pauseOnBattery,
        allowedWindowEnabled: config.allowedWindowEnabled,
        allowedWindowStartHour: config.allowedWindowStartHour,
        allowedWindowEndHour: config.allowedWindowEndHour,
        allowDuringActiveWork: true,
      },
      hostPower,
      activeWorkCount,
      ...(input.nowDate ? { nowDate: input.nowDate } : {}),
      freeDiskBytes,
      requiredDiskBytes: input.minRequiredDiskBytes ?? 256 * 1024 * 1024,
    });

    if (!startDecision.allowed) {
      return { action: "skipped" as const, reason: startDecision.reason };
    }

    // 백업 실행 중에만 유휴 텔레메트리를 1초로 승격해 입력 복귀 시 ≤ 5초 일시정지 보장
    if (input.telemetryReceiver) {
      yield* input.telemetryReceiver
        .setHostPowerIntervalsOverride({ activeIntervalMs: 1_000, idleIntervalMs: 1_000 })
        .pipe(Effect.ignore);
    }

    const abortController = new AbortController();
    let previousLocked = hostPower.locked;

    const triggerPauseIfNeeded = (nextPower: typeof hostPower, nextActiveCount: number): void => {
      if (abortController.signal.aborted) return;
      const decision = evaluateDriveBackupPauseGate({
        config: {
          pauseOnBattery: config.pauseOnBattery,
          idleMinSeconds: config.idleMinSeconds,
          allowDuringActiveWork: true,
        },
        hostPower: nextPower,
        previousLocked,
        activeWorkCount: nextActiveCount,
      });
      previousLocked = nextPower.locked;
      if (decision.pause) {
        abortController.abort(decision.reason);
      }
    };

    // 활성 작업이 실행 중이거나 새로 시작되어도 중단하지 않고 동적 저속 스로틀링으로 천천히 계속 진행한다.
    const powerWatchFiber = yield* input.hostPowerMonitor.streamChanges.pipe(
      Stream.runForEach((nextPower) =>
        Effect.sync(() => {
          triggerPauseIfNeeded(nextPower, activeWorkRegistry.snapshot().totalActive);
        }),
      ),
      Effect.forkChild,
    );

    try {
      const exec = input.backupService.runWithPauseSignal
        ? input.backupService.runWithPauseSignal({}, abortController.signal)
        : input.backupService.runNow({});
      const result = yield* exec.pipe(Effect.result);
      if (result._tag === "Success") {
        if (result.success.status === "paused") {
          return { action: "paused" as const, runId: result.success.runId };
        }
        return { action: "ran" as const, runId: result.success.runId };
      }
      if (result.failure.code === "BUSY_DEFERRED" || abortController.signal.aborted) {
        return { action: "paused" as const, reason: result.failure.message };
      }
      return { action: "failed" as const, reason: result.failure.message };
    } finally {
      yield* Fiber.interrupt(powerWatchFiber).pipe(Effect.ignore);
      if (input.telemetryReceiver) {
        yield* input.telemetryReceiver.setHostPowerIntervalsOverride(null).pipe(Effect.ignore);
      }
    }
  });

export const DriveBackupSchedulerLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const backupService = yield* GoogleDriveBackupService;
    const hostPowerMonitor = yield* HostPowerMonitor.HostPowerMonitor;
    const telemetryReceiverOpt = yield* Effect.serviceOption(
      DesktopTelemetryReceiver.DesktopTelemetryReceiver,
    );
    const lastAttemptAtMsRef = yield* Ref.make(0);

    yield* Effect.forever(
      Effect.sleep(SCHEDULER_POLL_INTERVAL).pipe(
        Effect.andThen(
          Effect.gen(function* () {
            const now = Date.now();
            const last = yield* Ref.get(lastAttemptAtMsRef);
            if (now - last < MIN_CHECK_GAP_MS) return;
            const outcome = yield* runDriveBackupSchedulerCycle({
              backupService,
              hostPowerMonitor,
              ...(Option.isSome(telemetryReceiverOpt)
                ? { telemetryReceiver: telemetryReceiverOpt.value }
                : {}),
            });
            if (
              outcome.action === "ran" ||
              outcome.action === "paused" ||
              outcome.action === "failed"
            ) {
              yield* Ref.set(lastAttemptAtMsRef, Date.now());
            }
          }),
        ),
        Effect.catchCause(() => Effect.void),
      ),
    ).pipe(Effect.forkScoped);
  }),
);
