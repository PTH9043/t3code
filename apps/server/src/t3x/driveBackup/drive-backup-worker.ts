// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off globalDate:off globalTimers:off
import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import { DatabaseSync } from "node:sqlite";
import {
  packFilesToT3Arc2File,
  type StreamingArchiveInputEntry,
} from "./StreamingArchivePacker.ts";
import { megaBytesPerSecToBytesPerSec, TokenBucket } from "./TokenBucket.ts";

/**
 * T3 무방해 Google Drive 백업 독립 자식 프로세스 워커.
 *
 * - 메인 서버 이벤트 루프와 완전히 분리되어 실행된다 (`windowsHide: true`).
 * - 시작 즉시 `os.setPriority(PRIORITY_LOW)`로 CPU 우선순위를 최저로 낮춘다.
 * - 읽기 전용 연결 + `VACUUM INTO`로 WAL 모드 쓰기를 막지 않고 스냅샷을 만들고,
 *   WAL 증가량(`walGrowthBytes`)과 `PRAGMA quick_check`를 실측 검증한다.
 * - 실패를 절대 삼키지 않고 구조화 오류 응답으로 부모에게 보고한다.
 * - `pause` 명령을 받으면 진행 중 작업을 즉시 중단·체크포인트 반환하고 종료한다.
 */

export type WorkerRequest =
  | {
      readonly type: "snapshot";
      readonly id: string;
      readonly dbPath: string;
      readonly outputPath: string;
      readonly rssLimitMb?: number;
    }
  | {
      readonly type: "pack_and_encrypt";
      readonly id: string;
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
    }
  | {
      readonly type: "pause";
      readonly reason?: string;
    }
  | {
      readonly type: "shutdown";
    };

export type WorkerMessage =
  | { readonly type: "ready"; readonly pid: number; readonly prioritySet: boolean }
  | {
      readonly type: "telemetry";
      readonly rssBytes: number;
      readonly peakRssBytes: number;
      readonly rssExceeded: boolean;
    }
  | {
      readonly type: "paused";
      readonly reason: string;
      readonly activeId: string | null;
      readonly elapsedMs: number;
    }
  | {
      readonly type: "snapshot_result";
      readonly id: string;
      readonly ok: true;
      readonly outputPath: string;
      readonly snapshotBytes: number;
      readonly walBytesBefore: number;
      readonly walBytesAfter: number;
      readonly walGrowthBytes: number;
      readonly quickCheck: string;
      readonly peakRssBytes: number;
      readonly elapsedMs: number;
      readonly cpuUserMs?: number;
      readonly cpuSystemMs?: number;
    }
  | {
      readonly type: "snapshot_result";
      readonly id: string;
      readonly ok: false;
      readonly error: string;
      readonly paused?: boolean;
      readonly walBytesBefore: number;
      readonly walBytesAfter: number;
      readonly walGrowthBytes: number;
      readonly peakRssBytes: number;
    }
  | {
      readonly type: "pack_result";
      readonly id: string;
      readonly ok: true;
      readonly outputPath: string;
      readonly encrypted: boolean;
      readonly fileCount: number;
      readonly rawBytes: number;
      readonly archiveBytes: number;
      readonly manifestSha256: string;
      readonly peakRssBytes: number;
      readonly elapsedMs: number;
      readonly cpuUserMs?: number;
      readonly cpuSystemMs?: number;
    }
  | {
      readonly type: "pack_result";
      readonly id: string;
      readonly ok: false;
      readonly error: string;
      readonly paused?: boolean;
      readonly peakRssBytes: number;
    };

function send(msg: WorkerMessage): void {
  try {
    process.stdout.write(`${JSON.stringify(msg)}\n`);
  } catch {
    // parent pipe closed
  }
}

function safeFileSize(filePath: string): number {
  try {
    return NodeFs.existsSync(filePath) ? NodeFs.statSync(filePath).size : 0;
  } catch {
    return 0;
  }
}

function safeUnlink(filePath: string): void {
  try {
    if (NodeFs.existsSync(filePath)) NodeFs.rmSync(filePath, { force: true });
  } catch {
    // ignore cleanup failure
  }
}

let prioritySet = false;
try {
  NodeOs.setPriority(process.pid, NodeOs.constants.priority.PRIORITY_LOW);
  prioritySet = true;
} catch {
  prioritySet = false;
}

let rssLimitBytes = 300 * 1024 * 1024;
let peakRssBytes = process.memoryUsage().rss;
let pauseRequested = false;
let pauseReason = "";
let activeAbortController: AbortController | null = null;
let activeId: string | null = null;
let activeTmpPath: string | null = null;

const rssTimer = setInterval(() => {
  const rss = process.memoryUsage().rss;
  if (rss > peakRssBytes) peakRssBytes = rss;
  const exceeded = rssLimitBytes > 0 && rss > rssLimitBytes;
  send({ type: "telemetry", rssBytes: rss, peakRssBytes, rssExceeded: exceeded });
}, 2_000);
rssTimer.unref();

async function handleSnapshot(
  req: Extract<WorkerRequest, { readonly type: "snapshot" }>,
): Promise<void> {
  const startedAt = Date.now();
  const cpuStart = process.cpuUsage();
  activeId = req.id;
  if (req.rssLimitMb && req.rssLimitMb > 0) {
    rssLimitBytes = req.rssLimitMb * 1024 * 1024;
  }

  const walPath = `${req.dbPath}-wal`;
  const walBytesBefore = safeFileSize(walPath);
  const tmpPath = `${req.outputPath}.${process.pid}.${Date.now()}.tmp`;
  activeTmpPath = tmpPath;

  try {
    if (pauseRequested) {
      throw Object.assign(new Error(`스냅샷 시작 전 일시정지됨: ${pauseReason}`), {
        isPaused: true,
      });
    }
    if (!req.dbPath || req.dbPath === ":memory:") {
      throw new Error("유효한 디스크 SQLite DB 경로가 아닙니다.");
    }
    if (!NodeFs.existsSync(req.dbPath)) {
      throw new Error(`SQLite DB 파일을 찾을 수 없습니다: ${req.dbPath}`);
    }

    NodeFs.mkdirSync(NodePath.dirname(req.outputPath), { recursive: true });
    safeUnlink(tmpPath);

    // WAL 모드 쓰기를 막지 않는 읽기 전용 연결로 VACUUM INTO 실행 (페이지 단위 online backup 금지)
    const escapedTmp = tmpPath.replace(/'/g, "''");
    const srcDb = new DatabaseSync(req.dbPath, { readOnly: true });
    try {
      srcDb.exec("PRAGMA busy_timeout = 5000");
      srcDb.exec(`VACUUM INTO '${escapedTmp}'`);
    } finally {
      srcDb.close();
    }

    const rssAfterVacuum = process.memoryUsage().rss;
    if (rssAfterVacuum > peakRssBytes) peakRssBytes = rssAfterVacuum;

    if (pauseRequested) {
      safeUnlink(tmpPath);
      throw Object.assign(new Error(`스냅샷 중 일시정지 요청됨: ${pauseReason}`), {
        isPaused: true,
      });
    }

    // 무결성 PRAGMA quick_check
    let quickCheck = "unknown";
    const verifyDb = new DatabaseSync(tmpPath, { readOnly: true });
    try {
      const row = verifyDb.prepare("PRAGMA quick_check").get() as
        | { readonly quick_check?: string }
        | undefined;
      quickCheck = String(row?.quick_check ?? "unknown");
      if (quickCheck !== "ok") {
        throw new Error(`SQLite quick_check 실패: ${quickCheck}`);
      }
    } finally {
      verifyDb.close();
    }

    // 원자적 배치
    safeUnlink(req.outputPath);
    NodeFs.renameSync(tmpPath, req.outputPath);
    activeTmpPath = null;

    const snapshotBytes = safeFileSize(req.outputPath);
    const walBytesAfter = safeFileSize(walPath);
    const walGrowthBytes = Math.max(0, walBytesAfter - walBytesBefore);
    const finalRss = process.memoryUsage().rss;
    if (finalRss > peakRssBytes) peakRssBytes = finalRss;
    const cpuDelta = process.cpuUsage(cpuStart);

    send({
      type: "snapshot_result",
      id: req.id,
      ok: true,
      outputPath: req.outputPath,
      snapshotBytes,
      walBytesBefore,
      walBytesAfter,
      walGrowthBytes,
      quickCheck,
      peakRssBytes,
      elapsedMs: Date.now() - startedAt,
      cpuUserMs: Number((cpuDelta.user / 1000).toFixed(2)),
      cpuSystemMs: Number((cpuDelta.system / 1000).toFixed(2)),
    });
  } catch (err) {
    safeUnlink(tmpPath);
    activeTmpPath = null;
    const walBytesAfter = safeFileSize(walPath);
    const walGrowthBytes = Math.max(0, walBytesAfter - walBytesBefore);
    const isPaused = Boolean((err as { readonly isPaused?: boolean } | null)?.isPaused);
    send({
      type: "snapshot_result",
      id: req.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      ...(isPaused ? { paused: true } : {}),
      walBytesBefore,
      walBytesAfter,
      walGrowthBytes,
      peakRssBytes,
    });
  } finally {
    activeId = null;
  }
}

async function handlePackAndEncrypt(
  req: Extract<WorkerRequest, { readonly type: "pack_and_encrypt" }>,
): Promise<void> {
  const startedAt = Date.now();
  const cpuStart = process.cpuUsage();
  activeId = req.id;
  if (req.rssLimitMb && req.rssLimitMb > 0) {
    rssLimitBytes = req.rssLimitMb * 1024 * 1024;
  }
  const ac = new AbortController();
  activeAbortController = ac;
  if (pauseRequested) ac.abort(pauseReason || "paused");

  try {
    const entries: StreamingArchiveInputEntry[] = req.entries.map((e) => ({
      archivePath: e.archivePath,
      ...(e.filePath ? { filePath: e.filePath } : {}),
      ...(e.contentBase64 ? { buffer: Buffer.from(e.contentBase64, "base64") } : {}),
    }));
    const readBucket =
      req.readLimitMBps && req.readLimitMBps > 0
        ? new TokenBucket({ bytesPerSecond: megaBytesPerSecToBytesPerSec(req.readLimitMBps) })
        : undefined;

    const result = await packFilesToT3Arc2File({
      targetId: req.targetId,
      targetDisplayName: req.targetDisplayName,
      entries,
      outputPath: req.outputPath,
      createdAtIso: req.createdAtIso,
      encryptionPassphrase: req.encryptionPassphrase ?? null,
      ...(readBucket ? { readBucket } : {}),
      signal: ac.signal,
    });
    const rss = process.memoryUsage().rss;
    if (rss > peakRssBytes) peakRssBytes = rss;
    const cpuDelta = process.cpuUsage(cpuStart);
    send({
      type: "pack_result",
      id: req.id,
      ok: true,
      outputPath: result.outputPath,
      encrypted: result.encrypted,
      fileCount: result.fileCount,
      rawBytes: result.rawBytes,
      archiveBytes: result.archiveBytes,
      manifestSha256: result.manifestSha256,
      peakRssBytes,
      elapsedMs: Date.now() - startedAt,
      cpuUserMs: Number((cpuDelta.user / 1000).toFixed(2)),
      cpuSystemMs: Number((cpuDelta.system / 1000).toFixed(2)),
    });
  } catch (err) {
    const rss = process.memoryUsage().rss;
    if (rss > peakRssBytes) peakRssBytes = rss;
    send({
      type: "pack_result",
      id: req.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      ...(pauseRequested || ac.signal.aborted ? { paused: true } : {}),
      peakRssBytes,
    });
  } finally {
    if (activeAbortController === ac) activeAbortController = null;
    activeId = null;
  }
}

const rl = NodeReadline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let req: WorkerRequest;
  try {
    req = JSON.parse(trimmed) as WorkerRequest;
  } catch {
    return;
  }
  if (req.type === "pause") {
    const t0 = Date.now();
    pauseRequested = true;
    pauseReason = req.reason ?? "pause_requested";
    activeAbortController?.abort(pauseReason);
    if (activeTmpPath) safeUnlink(activeTmpPath);
    send({
      type: "paused",
      reason: pauseReason,
      activeId,
      elapsedMs: Date.now() - t0,
    });
    return;
  }
  if (req.type === "shutdown") {
    clearInterval(rssTimer);
    rl.close();
    process.exit(0);
  }
  if (req.type === "snapshot") {
    void handleSnapshot(req);
  } else if (req.type === "pack_and_encrypt") {
    void handlePackAndEncrypt(req);
  }
});

rl.on("close", () => {
  clearInterval(rssTimer);
  process.exit(0);
});

send({ type: "ready", pid: process.pid, prioritySet });
