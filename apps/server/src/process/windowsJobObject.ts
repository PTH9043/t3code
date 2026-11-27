// @effect-diagnostics-next-line nodeBuiltinImport:off - Direct Node child_process execFile/execFileSync is required for hidden Windows taskkill.exe process-tree cleanup without PowerShell.
import * as NodeChildProcess from "node:child_process";

const DEFAULT_WINDOWS_TASKKILL_TIMEOUT_MS = 10_000;
const WINDOWS_TASKKILL_NOT_FOUND_EXIT_CODE = 128;

export type WindowsProcessTreeTerminateReason =
  | "terminated"
  | "already-exited"
  | "unsupported-platform"
  | "invalid-pid"
  | "error";

export interface WindowsProcessTreeTerminateResult {
  readonly pid: number;
  readonly attempted: boolean;
  readonly terminated: boolean;
  readonly reason: WindowsProcessTreeTerminateReason;
  readonly exitCode?: number | null;
  readonly error?: unknown;
}

export type WindowsExecFileError = Error & {
  readonly code?: number | string | undefined;
  readonly status?: number | undefined;
};

export type WindowsExecFile = (
  file: string,
  args: ReadonlyArray<string>,
  options: {
    readonly windowsHide: boolean;
    readonly timeout: number;
  },
  callback: (error: WindowsExecFileError | null) => void,
) => { readonly unref?: () => void } | void;

export type WindowsExecFileSync = (
  file: string,
  args: ReadonlyArray<string>,
  options: {
    readonly windowsHide: boolean;
    readonly timeout: number;
    readonly stdio: "ignore";
  },
) => unknown;

export interface TerminateWindowsProcessTreeOptions {
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  readonly currentPid?: number;
  readonly timeoutMs?: number;
  readonly execFile?: WindowsExecFile;
  readonly execFileSync?: WindowsExecFileSync;
  readonly unrefChild?: boolean;
}

export interface WindowsTerminalProcessGroup {
  readonly register: (pid: number, label?: string) => boolean;
  readonly unregister: (pid: number) => boolean;
  readonly has: (pid: number) => boolean;
  readonly listPids: () => ReadonlyArray<number>;
  readonly size: () => number;
  readonly terminatePid: (pid: number) => Promise<WindowsProcessTreeTerminateResult>;
  readonly terminateAll: () => Promise<ReadonlyArray<WindowsProcessTreeTerminateResult>>;
  readonly terminateAllSync: () => ReadonlyArray<WindowsProcessTreeTerminateResult>;
  readonly installExitHook: (targetProcess?: Pick<NodeJS.Process, "on" | "off">) => () => void;
  readonly dispose: () => void;
}

export interface CreateWindowsTerminalProcessGroupOptions extends TerminateWindowsProcessTreeOptions {
  readonly autoInstallExitHook?: boolean;
  readonly targetProcess?: Pick<NodeJS.Process, "on" | "off">;
}

/**
 * Resolves the canonical `%SystemRoot%\System32\taskkill.exe` path without
 * relying on PATH lookup or PowerShell.
 */
export function resolveWindowsTaskkillPath(env: NodeJS.ProcessEnv = process.env): string {
  const systemRoot = (env.SYSTEMROOT || env.SystemRoot || env.windir || String.raw`C:\Windows`)
    .trim()
    .replace(/[\\/]+$/g, "");
  return `${systemRoot || String.raw`C:\Windows`}\\System32\\taskkill.exe`;
}

export function isValidManagedWindowsPid(pid: number, currentPid: number = process.pid): boolean {
  return Number.isInteger(pid) && pid > 0 && pid !== currentPid;
}

function isTaskkillNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as {
    readonly code?: unknown;
    readonly status?: unknown;
    readonly message?: unknown;
  };
  if (
    candidate.code === WINDOWS_TASKKILL_NOT_FOUND_EXIT_CODE ||
    candidate.status === WINDOWS_TASKKILL_NOT_FOUND_EXIT_CODE
  ) {
    return true;
  }
  if (typeof candidate.message === "string" && /not found|없습니다/iu.test(candidate.message)) {
    return true;
  }
  return false;
}

function defaultExecFile(
  file: string,
  args: ReadonlyArray<string>,
  options: { readonly windowsHide: boolean; readonly timeout: number },
  callback: (error: WindowsExecFileError | null) => void,
) {
  return NodeChildProcess.execFile(file, args, options, (error) => {
    callback(error as WindowsExecFileError | null);
  });
}

function defaultExecFileSync(
  file: string,
  args: ReadonlyArray<string>,
  options: { readonly windowsHide: boolean; readonly timeout: number; readonly stdio: "ignore" },
) {
  return NodeChildProcess.execFileSync(file, args, options);
}

/**
 * Terminates a Windows process tree (`taskkill.exe /PID <pid> /T /F`) so
 * ConPTY `conhost.exe` and nested child shells do not survive as zombies.
 * Never spawns PowerShell.
 */
export function terminateWindowsProcessTree(
  pid: number,
  options: TerminateWindowsProcessTreeOptions = {},
): Promise<WindowsProcessTreeTerminateResult> {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    return Promise.resolve({
      pid,
      attempted: false,
      terminated: false,
      reason: "unsupported-platform",
    });
  }

  const currentPid = options.currentPid ?? process.pid;
  if (!isValidManagedWindowsPid(pid, currentPid)) {
    return Promise.resolve({
      pid,
      attempted: false,
      terminated: false,
      reason: "invalid-pid",
    });
  }

  const taskkillPath = resolveWindowsTaskkillPath(options.env);
  const timeout = options.timeoutMs ?? DEFAULT_WINDOWS_TASKKILL_TIMEOUT_MS;
  const execFile = options.execFile ?? defaultExecFile;

  return new Promise<WindowsProcessTreeTerminateResult>((resolve) => {
    try {
      const child = execFile(
        taskkillPath,
        ["/PID", String(pid), "/T", "/F"],
        { windowsHide: true, timeout },
        (error) => {
          if (!error) {
            resolve({
              pid,
              attempted: true,
              terminated: true,
              reason: "terminated",
              exitCode: 0,
            });
            return;
          }
          if (isTaskkillNotFoundError(error)) {
            resolve({
              pid,
              attempted: true,
              terminated: true,
              reason: "already-exited",
              exitCode: WINDOWS_TASKKILL_NOT_FOUND_EXIT_CODE,
            });
            return;
          }
          resolve({
            pid,
            attempted: true,
            terminated: false,
            reason: "error",
            exitCode: typeof error.code === "number" ? error.code : null,
            error,
          });
        },
      );
      if (options.unrefChild) {
        child?.unref?.();
      }
    } catch (error) {
      resolve({
        pid,
        attempted: true,
        terminated: false,
        reason: "error",
        error,
      });
    }
  });
}

/**
 * Synchronous process-tree termination used exclusively by Node's `exit`
 * safety-net hook when the event loop is tearing down.
 */
export function terminateWindowsProcessTreeSync(
  pid: number,
  options: TerminateWindowsProcessTreeOptions = {},
): WindowsProcessTreeTerminateResult {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    return {
      pid,
      attempted: false,
      terminated: false,
      reason: "unsupported-platform",
    };
  }

  const currentPid = options.currentPid ?? process.pid;
  if (!isValidManagedWindowsPid(pid, currentPid)) {
    return {
      pid,
      attempted: false,
      terminated: false,
      reason: "invalid-pid",
    };
  }

  const taskkillPath = resolveWindowsTaskkillPath(options.env);
  const timeout = options.timeoutMs ?? DEFAULT_WINDOWS_TASKKILL_TIMEOUT_MS;
  const execFileSync = options.execFileSync ?? defaultExecFileSync;

  try {
    execFileSync(taskkillPath, ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      timeout,
      stdio: "ignore",
    });
    return {
      pid,
      attempted: true,
      terminated: true,
      reason: "terminated",
      exitCode: 0,
    };
  } catch (error) {
    if (isTaskkillNotFoundError(error)) {
      return {
        pid,
        attempted: true,
        terminated: true,
        reason: "already-exited",
        exitCode: WINDOWS_TASKKILL_NOT_FOUND_EXIT_CODE,
      };
    }
    const status =
      error && typeof error === "object" && "status" in error && typeof error.status === "number"
        ? error.status
        : null;
    return {
      pid,
      attempted: true,
      terminated: false,
      reason: "error",
      exitCode: status,
      error,
    };
  }
}

/**
 * Tracks regular Windows terminal PTY PIDs and ensures their entire child
 * process trees (including `conhost.exe` and nested shells) are reaped on
 * terminal close, restart, or server exit. Detached upgrade-room watchdog
 * workers are intentionally excluded from this group.
 */
export function createWindowsTerminalProcessGroup(
  options: CreateWindowsTerminalProcessGroupOptions = {},
): WindowsTerminalProcessGroup {
  const platform = options.platform ?? process.platform;
  const currentPid = options.currentPid ?? process.pid;
  const trackedPids = new Map<number, { readonly label?: string; readonly sequence: number }>();
  const inFlightTerminations = new Map<number, Promise<WindowsProcessTreeTerminateResult>>();
  let nextSequence = 1;
  let uninstallExitHook: (() => void) | null = null;

  const installExitHook = (
    targetProcess: Pick<NodeJS.Process, "on" | "off"> = options.targetProcess ?? process,
  ): (() => void) => {
    if (uninstallExitHook !== null) {
      return uninstallExitHook;
    }
    const onExit = () => {
      terminateAllSync();
    };
    targetProcess.on("exit", onExit);
    const uninstall = () => {
      targetProcess.off("exit", onExit);
      if (uninstallExitHook === uninstall) {
        uninstallExitHook = null;
      }
    };
    uninstallExitHook = uninstall;
    return uninstall;
  };

  const register = (pid: number, label?: string): boolean => {
    if (platform !== "win32" || !isValidManagedWindowsPid(pid, currentPid)) {
      return false;
    }
    if (options.autoInstallExitHook !== false && uninstallExitHook === null) {
      installExitHook();
    }
    trackedPids.set(pid, {
      ...(label !== undefined ? { label } : {}),
      sequence: nextSequence++,
    });
    return true;
  };

  const unregister = (pid: number): boolean => trackedPids.delete(pid);

  const has = (pid: number): boolean => trackedPids.has(pid);

  const listPids = (): ReadonlyArray<number> => [...trackedPids.keys()];

  const size = (): number => trackedPids.size;

  const terminatePid = (pid: number): Promise<WindowsProcessTreeTerminateResult> => {
    trackedPids.delete(pid);
    const existing = inFlightTerminations.get(pid);
    if (existing) {
      return existing;
    }
    const promise = terminateWindowsProcessTree(pid, options).finally(() => {
      if (inFlightTerminations.get(pid) === promise) {
        inFlightTerminations.delete(pid);
      }
    });
    inFlightTerminations.set(pid, promise);
    return promise;
  };

  const terminateAll = async (): Promise<ReadonlyArray<WindowsProcessTreeTerminateResult>> => {
    const pids = [...trackedPids.keys()];
    trackedPids.clear();
    if (pids.length === 0) {
      return [];
    }
    return Promise.all(pids.map((pid) => terminatePid(pid)));
  };

  const terminateAllSync = (): ReadonlyArray<WindowsProcessTreeTerminateResult> => {
    const pids = [...trackedPids.keys()];
    trackedPids.clear();
    return pids.map((pid) => terminateWindowsProcessTreeSync(pid, options));
  };

  const dispose = (): void => {
    trackedPids.clear();
    uninstallExitHook?.();
    uninstallExitHook = null;
  };

  return {
    register,
    unregister,
    has,
    listPids,
    size,
    terminatePid,
    terminateAll,
    terminateAllSync,
    installExitHook,
    dispose,
  };
}

/**
 * Shared process-tree tracker for regular Windows terminal PTY sessions.
 */
export const windowsTerminalProcessGroup: WindowsTerminalProcessGroup =
  createWindowsTerminalProcessGroup({
    autoInstallExitHook: true,
    unrefChild: true,
  });
