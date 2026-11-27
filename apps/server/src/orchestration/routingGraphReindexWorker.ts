// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off
import * as NodeChildProcess from "node:child_process";
import * as NodeOs from "node:os";
import { activeWorkRegistry } from "./ActiveWorkTracker.ts";

/**
 * Wave 4-A2: Unobtrusive background gate & low-priority child-process runner
 * for incremental Korean normalization + bigram FTS backfill of `WorkspaceRoutingGraph`.
 *
 * Rules strictly enforced:
 * - Only runs when `activeWorkRegistry.snapshot().totalActive === 0`.
 * - Only runs when `HostPowerMonitor` confirms user is away (locked OR idle >= minIdleSeconds),
 *   monitor is not stale, host is not suspended, and thermal state is healthy.
 * - Spawns worker child process with `windowsHide: true` and `PRIORITY_LOW` (zero focus theft).
 * - Immediately pauses/aborts when the user returns or any active work begins.
 */

export interface ReindexHostPowerSnapshot {
  readonly idle: boolean;
  readonly idleSeconds: number;
  readonly locked: boolean;
  readonly suspended: boolean;
  readonly onBattery?: boolean | undefined;
  readonly lowPowerMode?: boolean | undefined;
  readonly thermalState?: string | undefined;
  readonly stale: boolean;
}

export interface ReindexGateOptions {
  readonly minIdleSeconds?: number | undefined;
  readonly pauseOnBattery?: boolean | undefined;
  readonly activeWorkCount?: number | undefined;
}

export interface ReindexGateResult {
  readonly allowed: boolean;
  readonly reason:
    | "allowed"
    | "active_work_running"
    | "power_monitor_stale"
    | "host_suspended"
    | "thermal_pressure"
    | "low_power_mode"
    | "on_battery"
    | "user_present";
}

export function evaluateRoutingReindexIdleGate(
  power: ReindexHostPowerSnapshot | undefined,
  options?: ReindexGateOptions,
): ReindexGateResult {
  const activeCount = options?.activeWorkCount ?? activeWorkRegistry.snapshot().totalActive;
  if (activeCount > 0) {
    return { allowed: false, reason: "active_work_running" };
  }
  if (!power || power.stale) {
    return { allowed: false, reason: "power_monitor_stale" };
  }
  if (power.suspended) {
    return { allowed: false, reason: "host_suspended" };
  }
  if (power.thermalState === "serious" || power.thermalState === "critical") {
    return { allowed: false, reason: "thermal_pressure" };
  }
  if (power.lowPowerMode === true) {
    return { allowed: false, reason: "low_power_mode" };
  }
  if (options?.pauseOnBattery !== false && power.onBattery === true) {
    return { allowed: false, reason: "on_battery" };
  }
  const minIdle = options?.minIdleSeconds ?? 300;
  const userAway = power.locked === true || (power.idle === true && power.idleSeconds >= minIdle);
  if (!userAway) {
    return { allowed: false, reason: "user_present" };
  }
  return { allowed: true, reason: "allowed" };
}

export interface SpawnLowPriorityReindexOptions {
  readonly scriptPath: string;
  readonly args: ReadonlyArray<string>;
  readonly getPowerSnapshot: () => ReindexHostPowerSnapshot | undefined;
  readonly gateOptions?: ReindexGateOptions | undefined;
  readonly pollPauseIntervalMs?: number | undefined;
  readonly timeoutMs?: number | undefined;
}

export interface SpawnLowPriorityReindexResult {
  readonly status: "completed" | "paused_user_returned" | "skipped_gate" | "failed";
  readonly gateReason?: string | undefined;
  readonly exitCode?: number | null | undefined;
  readonly stdout?: string | undefined;
}

/**
 * Spawns a single low-priority, hidden-window child process batch for incremental reindexing
 * and monitors the idle gate every `pollPauseIntervalMs` so it yields immediately if the user returns.
 */
export async function runLowPriorityReindexBatchChild(
  options: SpawnLowPriorityReindexOptions,
): Promise<SpawnLowPriorityReindexResult> {
  const initialGate = evaluateRoutingReindexIdleGate(
    options.getPowerSnapshot(),
    options.gateOptions,
  );
  if (!initialGate.allowed) {
    return { status: "skipped_gate", gateReason: initialGate.reason };
  }

  return new Promise((resolve) => {
    const child = NodeChildProcess.spawn(process.execPath, [options.scriptPath, ...options.args], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });

    if (typeof child.pid === "number" && child.pid > 0) {
      try {
        NodeOs.setPriority(child.pid, NodeOs.constants.priority.PRIORITY_LOW);
      } catch {
        // Best-effort OS priority lowering.
      }
    }

    let stdout = "";
    let settled = false;
    let pausedByUser = false;

    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < 16_384) stdout += chunk.toString("utf8");
    });

    const finish = (result: SpawnLowPriorityReindexResult) => {
      if (settled) return;
      settled = true;
      clearInterval(watchTimer);
      clearTimeout(timeoutTimer);
      resolve(result);
    };

    const watchTimer = setInterval(() => {
      const check = evaluateRoutingReindexIdleGate(options.getPowerSnapshot(), options.gateOptions);
      if (!check.allowed) {
        pausedByUser = true;
        try {
          child.kill("SIGTERM");
        } catch {
          // ignore
        }
        finish({ status: "paused_user_returned", gateReason: check.reason, stdout });
      }
    }, options.pollPauseIntervalMs ?? 1_500);

    const timeoutTimer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
      finish({ status: "failed", gateReason: "timeout", stdout });
    }, options.timeoutMs ?? 60_000);

    child.on("error", () => finish({ status: "failed", stdout }));
    child.on("close", (code) => {
      if (pausedByUser) return;
      finish({
        status: code === 0 ? "completed" : "failed",
        exitCode: code,
        stdout,
      });
    });
  });
}
