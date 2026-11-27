// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off globalDate:off globalTimers:off
import { spawn, type ChildProcess } from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFs from "node:fs";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import { fileURLToPath } from "node:url";
import type { WorkerMessage, WorkerRequest } from "./drive-backup-worker.ts";

/**
 * 백업·지식 미러·PC↔VPS 교환소 작업을 전역 직렬(동시 1건)로 실행하는 코디네이터.
 */
export class DriveBackupSerialCoordinator {
  private chain: Promise<void> = Promise.resolve();
  private runningKind: string | null = null;

  get currentKind(): string | null {
    return this.runningKind;
  }

  async runExclusive<T>(kind: string, fn: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const prev = this.chain;
    this.chain = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prev;
    this.runningKind = kind;
    try {
      return await fn();
    } finally {
      this.runningKind = null;
      release();
    }
  }
}

export const sharedDriveBackupCoordinator = new DriveBackupSerialCoordinator();

/**
 * 번들(`dist/drive-backup-worker.mjs`) 또는 소스(`drive-backup-worker.ts`) 경로를 자동 해석한다.
 */
export function resolveDriveBackupWorkerScript(): string {
  const hereDir = NodePath.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // Production bundled server (dist/bin.mjs -> dist/drive-backup-worker.mjs)
    NodePath.join(hereDir, "drive-backup-worker.mjs"),
    NodePath.resolve(hereDir, "../../../dist/drive-backup-worker.mjs"),
    // Dev / Vitest direct TypeScript execution (Node 22 strip-types)
    NodePath.join(hereDir, "drive-backup-worker.ts"),
  ];
  for (const candidate of candidates) {
    if (NodeFs.existsSync(candidate)) {
      return candidate;
    }
  }
  return NodePath.join(hereDir, "drive-backup-worker.ts");
}

export interface SnapshotWorkerResult {
  readonly outputPath: string;
  readonly snapshotBytes: number;
  readonly walBytesBefore: number;
  readonly walBytesAfter: number;
  readonly walGrowthBytes: number;
  readonly quickCheck: string;
  readonly peakRssBytes: number;
  readonly elapsedMs: number;
  readonly workerPid: number;
  readonly prioritySet: boolean;
  readonly cpuUserMs?: number;
  readonly cpuSystemMs?: number;
}

export class SnapshotPausedError extends Error {
  readonly reason: string;
  readonly walGrowthBytes: number;
  constructor(reason: string, walGrowthBytes: number) {
    super(`SQLite 스냅샷이 일시정지되었습니다: ${reason}`);
    this.name = "SnapshotPausedError";
    this.reason = reason;
    this.walGrowthBytes = walGrowthBytes;
  }
}

/**
 * 독립 자식 프로세스(`windowsHide: true`, `PRIORITY_LOW`)에서 읽기 전용 SQLite 스냅샷을 실행한다.
 * - 메인 서버 이벤트 루프를 차단하지 않는다.
 * - `VACUUM INTO` / `PRAGMA quick_check` 실패 시 오류를 절대 삼키지 않고 예외를 던진다.
 * - `signal`이 abort되면 즉시 워커에 `pause`를 전송하고 4초 내 미응답 시 프로세스를 종료한다.
 */
export async function runSqliteSnapshotInWorker(input: {
  readonly dbPath: string;
  readonly outputPath: string;
  readonly rssLimitMb?: number;
  readonly signal?: AbortSignal;
  readonly onTelemetry?: (t: { readonly rssBytes: number; readonly peakRssBytes: number }) => void;
  readonly workerScriptPath?: string;
}): Promise<SnapshotWorkerResult> {
  if (input.signal?.aborted) {
    throw new SnapshotPausedError(String(input.signal.reason ?? "aborted"), 0);
  }

  const scriptPath = input.workerScriptPath ?? resolveDriveBackupWorkerScript();
  const child: ChildProcess = spawn(process.execPath, [scriptPath], {
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const workerPid = child.pid ?? 0;
  let prioritySet = false;
  let stderrText = "";
  let settled = false;
  let killTimer: ReturnType<typeof setTimeout> | null = null;

  child.stderr?.on("data", (chunk: Buffer) => {
    if (stderrText.length < 2_000) stderrText += chunk.toString("utf8");
  });

  const sendReq = (req: WorkerRequest): void => {
    try {
      child.stdin?.write(`${JSON.stringify(req)}\n`);
    } catch {
      // ignore if pipe closed
    }
  };

  const cleanup = () => {
    if (killTimer) {
      clearTimeout(killTimer);
      killTimer = null;
    }
    input.signal?.removeEventListener("abort", onAbort);
    try {
      sendReq({ type: "shutdown" });
      child.stdin?.end();
    } catch {
      // ignore
    }
  };

  let abortReject: ((err: Error) => void) | null = null;

  const onAbort = () => {
    const reason = String(input.signal?.reason ?? "pause_requested");
    sendReq({ type: "pause", reason });
    // VACUUM INTO는 동기 C 호출이라 최대 3초 내 응답이 없으면 강제 종료해 ≤ 5초 일시정지 보장
    killTimer = setTimeout(() => {
      try {
        if (child.pid && !child.killed) {
          child.kill();
        }
      } catch {
        // ignore
      }
      if (!settled && abortReject) {
        settled = true;
        abortReject(new SnapshotPausedError(reason, 0));
      }
    }, 2_500);
    killTimer.unref();
  };

  input.signal?.addEventListener("abort", onAbort, { once: true });

  return await new Promise<SnapshotWorkerResult>((resolve, reject) => {
    abortReject = reject;
    const reqId = `snap_${NodeCrypto.randomUUID().slice(0, 10)}`;
    const rl = NodeReadline.createInterface({ input: child.stdout!, crlfDelay: Infinity });

    const finishResolve = (val: SnapshotWorkerResult) => {
      if (settled) return;
      settled = true;
      rl.close();
      cleanup();
      resolve(val);
    };

    const finishReject = (err: Error) => {
      if (settled) return;
      settled = true;
      rl.close();
      cleanup();
      reject(err);
    };

    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let msg: WorkerMessage;
      try {
        msg = JSON.parse(trimmed) as WorkerMessage;
      } catch {
        return;
      }
      if (msg.type === "ready") {
        prioritySet = msg.prioritySet;
        sendReq({
          type: "snapshot",
          id: reqId,
          dbPath: input.dbPath,
          outputPath: input.outputPath,
          ...(input.rssLimitMb !== undefined ? { rssLimitMb: input.rssLimitMb } : {}),
        });
        return;
      }
      if (msg.type === "telemetry") {
        input.onTelemetry?.({ rssBytes: msg.rssBytes, peakRssBytes: msg.peakRssBytes });
        return;
      }
      if (msg.type === "snapshot_result" && msg.id === reqId) {
        if (msg.ok) {
          finishResolve({
            outputPath: msg.outputPath,
            snapshotBytes: msg.snapshotBytes,
            walBytesBefore: msg.walBytesBefore,
            walBytesAfter: msg.walBytesAfter,
            walGrowthBytes: msg.walGrowthBytes,
            quickCheck: msg.quickCheck,
            peakRssBytes: msg.peakRssBytes,
            elapsedMs: msg.elapsedMs,
            workerPid,
            prioritySet,
            ...(msg.cpuUserMs !== undefined ? { cpuUserMs: msg.cpuUserMs } : {}),
            ...(msg.cpuSystemMs !== undefined ? { cpuSystemMs: msg.cpuSystemMs } : {}),
          });
        } else if (msg.paused) {
          finishReject(new SnapshotPausedError(msg.error, msg.walGrowthBytes));
        } else {
          finishReject(new Error(msg.error));
        }
      }
    });

    child.on("error", (err) => {
      finishReject(new Error(`SQLite 스냅샷 워커 실행 실패: ${err.message}`));
    });

    child.on("exit", (code, sig) => {
      if (!settled) {
        if (input.signal?.aborted) {
          finishReject(new SnapshotPausedError(String(input.signal.reason ?? "aborted"), 0));
        } else {
          finishReject(
            new Error(
              `SQLite 스냅샷 워커가 비정상 종료되었습니다 (code=${String(code)}, signal=${String(sig)}): ${stderrText.trim()}`,
            ),
          );
        }
      }
    });
  });
}

export interface PackWorkerResult {
  readonly outputPath: string;
  readonly encrypted: boolean;
  readonly fileCount: number;
  readonly rawBytes: number;
  readonly archiveBytes: number;
  readonly manifestSha256: string;
  readonly peakRssBytes: number;
  readonly elapsedMs: number;
  readonly workerPid: number;
  readonly cpuUserMs?: number;
  readonly cpuSystemMs?: number;
}

/**
 * 독립 자식 프로세스(`windowsHide: true`, `PRIORITY_LOW`)에서 T3ARC2+T3ENC2 스트리밍 패킹·암호화를 실행한다.
 */
export async function runPackAndEncryptInWorker(input: {
  readonly targetId: string;
  readonly targetDisplayName: string;
  readonly entries: ReadonlyArray<{
    readonly archivePath: string;
    readonly filePath?: string;
    readonly contentBase64?: string;
  }>;
  readonly outputPath: string;
  readonly createdAtIso: string;
  readonly encryptionPassphrase?: string | null;
  readonly readLimitMBps?: number;
  readonly rssLimitMb?: number;
  readonly signal?: AbortSignal;
  readonly workerScriptPath?: string;
}): Promise<PackWorkerResult> {
  if (input.signal?.aborted) {
    throw new SnapshotPausedError(String(input.signal.reason ?? "aborted"), 0);
  }

  const scriptPath = input.workerScriptPath ?? resolveDriveBackupWorkerScript();
  const child: ChildProcess = spawn(process.execPath, [scriptPath], {
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const workerPid = child.pid ?? 0;
  let stderrText = "";
  let settled = false;
  let killTimer: ReturnType<typeof setTimeout> | null = null;

  child.stderr?.on("data", (chunk: Buffer) => {
    if (stderrText.length < 2_000) stderrText += chunk.toString("utf8");
  });

  const sendReq = (req: WorkerRequest): void => {
    try {
      child.stdin?.write(`${JSON.stringify(req)}\n`);
    } catch {
      // ignore
    }
  };

  let abortReject: ((err: Error) => void) | null = null;
  const onAbort = () => {
    const reason = String(input.signal?.reason ?? "pause_requested");
    sendReq({ type: "pause", reason });
    killTimer = setTimeout(() => {
      try {
        if (child.pid && !child.killed) child.kill();
      } catch {
        // ignore
      }
      if (!settled && abortReject) {
        settled = true;
        abortReject(new SnapshotPausedError(reason, 0));
      }
    }, 2_500);
    killTimer.unref();
  };
  input.signal?.addEventListener("abort", onAbort, { once: true });

  const cleanup = () => {
    if (killTimer) {
      clearTimeout(killTimer);
      killTimer = null;
    }
    input.signal?.removeEventListener("abort", onAbort);
    try {
      sendReq({ type: "shutdown" });
      child.stdin?.end();
    } catch {
      // ignore
    }
  };

  return await new Promise<PackWorkerResult>((resolve, reject) => {
    abortReject = reject;
    const reqId = `pack_${NodeCrypto.randomUUID().slice(0, 10)}`;
    const rl = NodeReadline.createInterface({ input: child.stdout!, crlfDelay: Infinity });

    const finishResolve = (val: PackWorkerResult) => {
      if (settled) return;
      settled = true;
      rl.close();
      cleanup();
      resolve(val);
    };
    const finishReject = (err: Error) => {
      if (settled) return;
      settled = true;
      rl.close();
      cleanup();
      reject(err);
    };

    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let msg: WorkerMessage;
      try {
        msg = JSON.parse(trimmed) as WorkerMessage;
      } catch {
        return;
      }
      if (msg.type === "ready") {
        sendReq({
          type: "pack_and_encrypt",
          id: reqId,
          targetId: input.targetId,
          targetDisplayName: input.targetDisplayName,
          entries: input.entries,
          outputPath: input.outputPath,
          createdAtIso: input.createdAtIso,
          encryptionPassphrase: input.encryptionPassphrase ?? null,
          ...(input.readLimitMBps !== undefined ? { readLimitMBps: input.readLimitMBps } : {}),
          ...(input.rssLimitMb !== undefined ? { rssLimitMb: input.rssLimitMb } : {}),
        });
        return;
      }
      if (msg.type === "pack_result" && msg.id === reqId) {
        if (msg.ok) {
          finishResolve({
            outputPath: msg.outputPath,
            encrypted: msg.encrypted,
            fileCount: msg.fileCount,
            rawBytes: msg.rawBytes,
            archiveBytes: msg.archiveBytes,
            manifestSha256: msg.manifestSha256,
            peakRssBytes: msg.peakRssBytes,
            elapsedMs: msg.elapsedMs,
            workerPid,
            ...(msg.cpuUserMs !== undefined ? { cpuUserMs: msg.cpuUserMs } : {}),
            ...(msg.cpuSystemMs !== undefined ? { cpuSystemMs: msg.cpuSystemMs } : {}),
          });
        } else if (msg.paused) {
          finishReject(new SnapshotPausedError(msg.error, 0));
        } else {
          finishReject(new Error(msg.error));
        }
      }
    });

    child.on("error", (err) => {
      finishReject(new Error(`아카이브 패킹 워커 실행 실패: ${err.message}`));
    });
    child.on("exit", (code, sig) => {
      if (!settled) {
        if (input.signal?.aborted) {
          finishReject(new SnapshotPausedError(String(input.signal.reason ?? "aborted"), 0));
        } else {
          finishReject(
            new Error(
              `아카이브 패킹 워커 비정상 종료 (code=${String(code)}, signal=${String(sig)}): ${stderrText.trim()}`,
            ),
          );
        }
      }
    });
  });
}
