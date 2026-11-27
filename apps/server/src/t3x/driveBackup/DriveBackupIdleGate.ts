// @effect-diagnostics nodeBuiltinImport:off globalDate:off
import * as NodeFs from "node:fs";
import * as NodePath from "node:path";
import type { HostPowerSnapshot } from "@t3tools/contracts";

/**
 * 무방해 Drive 백업 전용 유휴·일시정지 게이트.
 *
 * 주의: `BackgroundPolicy.shouldRunOpportunisticWork`는 사용자가 화면을 보고 있을 때
 * 참이 되는 구조이므로 백업 게이트로 절대 사용하지 않고,
 * `HostPowerMonitor`와 `activeWorkRegistry`를 직접 평가한다.
 */

export interface DriveBackupGateConfig {
  readonly idleMinSeconds: number;
  readonly pauseOnBattery: boolean;
  readonly allowedWindowEnabled: boolean;
  readonly allowedWindowStartHour: number;
  readonly allowedWindowEndHour: number;
}

export type StartGateDenyReason =
  | "active_work"
  | "power_stale"
  | "not_idle"
  | "suspended"
  | "thermal_pressure"
  | "on_battery"
  | "outside_window"
  | "low_disk_space";

export type StartGateDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: StartGateDenyReason; readonly detail: string };

export type PauseGateReason =
  | "active_work"
  | "user_returned"
  | "unlocked"
  | "on_battery"
  | "thermal_pressure"
  | "suspended";

export type PauseGateDecision =
  | { readonly pause: false }
  | { readonly pause: true; readonly reason: PauseGateReason; readonly detail: string };

export function isWithinAllowedWindow(hour: number, startHour: number, endHour: number): boolean {
  const h = ((hour % 24) + 24) % 24;
  const s = ((startHour % 24) + 24) % 24;
  const e = ((endHour % 24) + 24) % 24;
  if (s === e) return true;
  if (s < e) return h >= s && h < e;
  // 자정을 넘는 구간 (예: 23시 ~ 06시)
  return h >= s || h < e;
}

export function evaluateDriveBackupStartGate(input: {
  readonly config: DriveBackupGateConfig;
  readonly hostPower: HostPowerSnapshot;
  readonly activeWorkCount: number;
  readonly nowDate?: Date;
  readonly freeDiskBytes?: number | null;
  readonly requiredDiskBytes?: number;
}): StartGateDecision {
  if (input.activeWorkCount > 0) {
    return {
      allowed: false,
      reason: "active_work",
      detail: `진행 중인 T3 활성 작업 ${input.activeWorkCount}건이 있어 백업을 시작하지 않습니다.`,
    };
  }

  if (input.hostPower.stale) {
    return {
      allowed: false,
      reason: "power_stale",
      detail: "HostPowerMonitor 텔레메트리가 오래되어(stale) 자동 백업을 보류합니다.",
    };
  }

  if (input.hostPower.suspended) {
    return {
      allowed: false,
      reason: "suspended",
      detail: "시스템 절전 중이어서 백업을 시작하지 않습니다.",
    };
  }

  if (input.hostPower.thermalState === "serious" || input.hostPower.thermalState === "critical") {
    return {
      allowed: false,
      reason: "thermal_pressure",
      detail: `열 압박 상태(${input.hostPower.thermalState})여서 백업을 시작하지 않습니다.`,
    };
  }

  if (
    input.config.pauseOnBattery &&
    (input.hostPower.onBattery === "true" || input.hostPower.lowPowerMode === "true")
  ) {
    return {
      allowed: false,
      reason: "on_battery",
      detail: "배터리 또는 저전력 모드 사용 중이어서 백업을 시작하지 않습니다.",
    };
  }

  const minIdle = Math.max(60, input.config.idleMinSeconds);
  const isLocked = input.hostPower.locked === "true";
  const isIdleLongEnough =
    input.hostPower.idleSeconds !== null && input.hostPower.idleSeconds >= minIdle;
  if (!isLocked && !isIdleLongEnough) {
    return {
      allowed: false,
      reason: "not_idle",
      detail: `사용자 부재 조건 미충족(idleSeconds=${input.hostPower.idleSeconds ?? "null"} < ${minIdle}초, locked=${input.hostPower.locked}).`,
    };
  }

  if (input.config.allowedWindowEnabled) {
    const nowHour = (input.nowDate ?? new Date()).getHours();
    if (
      !isWithinAllowedWindow(
        nowHour,
        input.config.allowedWindowStartHour,
        input.config.allowedWindowEndHour,
      )
    ) {
      return {
        allowed: false,
        reason: "outside_window",
        detail: `허용 시간대(${input.config.allowedWindowStartHour}시~${input.config.allowedWindowEndHour}시) 밖입니다.`,
      };
    }
  }

  if (
    input.freeDiskBytes !== undefined &&
    input.freeDiskBytes !== null &&
    input.requiredDiskBytes !== undefined &&
    input.freeDiskBytes < input.requiredDiskBytes
  ) {
    const freeGiB = (input.freeDiskBytes / 1024 ** 3).toFixed(2);
    const reqGiB = (input.requiredDiskBytes / 1024 ** 3).toFixed(2);
    return {
      allowed: false,
      reason: "low_disk_space",
      detail: `임시 스냅샷 디스크 여유 공간 부족 (${freeGiB} GiB < 필요 ${reqGiB} GiB).`,
    };
  }

  return { allowed: true };
}

export function evaluateDriveBackupPauseGate(input: {
  readonly config: Pick<DriveBackupGateConfig, "pauseOnBattery" | "idleMinSeconds">;
  readonly hostPower: HostPowerSnapshot;
  readonly previousLocked?: HostPowerSnapshot["locked"];
  readonly activeWorkCount: number;
}): PauseGateDecision {
  if (input.activeWorkCount > 0) {
    return {
      pause: true,
      reason: "active_work",
      detail: `새 T3 작업(${input.activeWorkCount}건)이 시작되어 백업을 일시정지합니다.`,
    };
  }

  if (input.hostPower.suspended) {
    return {
      pause: true,
      reason: "suspended",
      detail: "시스템 절전 진입으로 백업을 일시정지합니다.",
    };
  }

  if (input.hostPower.thermalState === "serious" || input.hostPower.thermalState === "critical") {
    return {
      pause: true,
      reason: "thermal_pressure",
      detail: `열 압박(${input.hostPower.thermalState})으로 백업을 일시정지합니다.`,
    };
  }

  if (
    input.config.pauseOnBattery &&
    (input.hostPower.onBattery === "true" || input.hostPower.lowPowerMode === "true")
  ) {
    return {
      pause: true,
      reason: "on_battery",
      detail: "배터리/저전력 모드로 전환되어 백업을 일시정지합니다.",
    };
  }

  if (input.previousLocked === "true" && input.hostPower.locked === "false") {
    return {
      pause: true,
      reason: "unlocked",
      detail: "화면 잠금이 해제되어 백업을 일시정지합니다.",
    };
  }

  const isLocked = input.hostPower.locked === "true";
  if (!isLocked) {
    if (input.hostPower.idle === "false") {
      return {
        pause: true,
        reason: "user_returned",
        detail: "사용자 입력이 복귀하여 백업을 일시정지합니다.",
      };
    }
    if (
      input.hostPower.idleSeconds !== null &&
      input.hostPower.idleSeconds < Math.min(30, input.config.idleMinSeconds)
    ) {
      return {
        pause: true,
        reason: "user_returned",
        detail: `사용자 입력 감지(idleSeconds=${input.hostPower.idleSeconds}초)로 백업을 일시정지합니다.`,
      };
    }
  }

  return { pause: false };
}

export function isFullSnapshotDue(input: {
  readonly includeCoreSqliteSnapshot: boolean;
  readonly lastFullSnapshotAtMs: number | null;
  readonly fullSnapshotIntervalDays: number;
  readonly nowMs?: number;
  readonly forceFullSnapshot?: boolean;
}): boolean {
  if (!input.includeCoreSqliteSnapshot) return false;
  if (input.forceFullSnapshot) return true;
  if (input.lastFullSnapshotAtMs === null) return true;
  const intervalMs = Math.max(1, input.fullSnapshotIntervalDays) * 86_400_000;
  return (input.nowMs ?? Date.now()) - input.lastFullSnapshotAtMs >= intervalMs;
}

export async function checkFreeDiskSpaceBytes(targetDir: string): Promise<number | null> {
  let probe = NodePath.resolve(targetDir);
  while (!NodeFs.existsSync(probe)) {
    const parent = NodePath.dirname(probe);
    if (parent === probe) return null;
    probe = parent;
  }
  try {
    const stats = await NodeFs.promises.statfs(probe);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return null;
  }
}
