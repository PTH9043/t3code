#!/usr/bin/env node
/**
 * D항 작업 방해 금지 정량 증명 벤치마크 (격리된 임시 DB·임시 파일·로컬 Mock 서버 사용, 운영 무접촉)
 *
 * 측정 항목:
 * 1. 백업 전(Baseline) vs 백업 중(Active):
 *    - 메인 서버 이벤트 루프 지연 p50 / p99 (perf_hooks.monitorEventLoopDelay) -> 기준: p99 증가 <= 20 ms
 *    - 경량 T3 HTTP 서버 응답 시간 p50 / p99
 * 2. 자식 프로세스 워커(PRIORITY_LOW, windowsHide: true):
 *    - 최대 메모리 RSS (MB) -> 기준: <= 300 MB
 *    - 자식 CPU 사용률 (평균 %, OS 기준 CPU 시간)
 *    - WAL 모드 동시 쓰기 중 VACUUM INTO 스냅샷 WAL 증가량(bytes) 및 PRAGMA quick_check
 * 3. TokenBucket 업로드 속도 제한(20 Mbps):
 *    - Resumable 청크 업로드 실측 속도 (Mbps)
 * 4. 일시정지 반응 시간:
 *    - 자식 워커 패킹 중 AbortSignal -> 워커 종료 응답 시간 (ms) -> 기준: <= 5,000 ms
 *    - Resumable 업로드 중 AbortSignal -> 체크포인트 저장 후 정지 시간 (ms) -> 기준: <= 5,000 ms
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import {
  runPackAndEncryptInWorker,
  runSqliteSnapshotInWorker,
  SnapshotPausedError,
} from "../apps/server/src/t3x/driveBackup/DriveBackupWorkerHost.ts";
import {
  ResumableUploadPausedError,
  uploadFileResumableToGoogleDriveApi,
} from "../apps/server/src/t3x/driveBackup/DriveTransportAdapter.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER_SCRIPT = path.resolve(
  __dirname,
  "../apps/server/src/t3x/driveBackup/drive-backup-worker.ts",
);

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

async function startT3LikeHttpServer() {
  const server = http.createServer((req, res) => {
    if (req.url === "/.well-known/t3/environment") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, status: "healthy", ts: Date.now() }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  return { server, url: `http://127.0.0.1:${addr.port}/.well-known/t3/environment` };
}

async function startMockResumableDriveServer() {
  const folders = new Map();
  const sessions = new Map();
  let seq = 1;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const chunks = [];
    for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
    const body = Buffer.concat(chunks);

    if (url.pathname === "/token") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ access_token: "bench-tok" }));
      return;
    }
    if (url.pathname === "/drive/v3/files" && req.method === "GET") {
      const q = url.searchParams.get("q") ?? "";
      const m = /name = '([^']+)'/.exec(q);
      const id = m?.[1] ? folders.get(m[1]) : null;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ files: id ? [{ id, name: m[1] }] : [] }));
      return;
    }
    if (url.pathname === "/drive/v3/files" && req.method === "POST") {
      const parsed = JSON.parse(body.toString("utf8"));
      const id = `fld-${seq++}`;
      folders.set(parsed.name, id);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id, name: parsed.name }));
      return;
    }
    if (url.pathname === "/upload/drive/v3/files" && req.method === "POST") {
      const parsed = JSON.parse(body.toString("utf8"));
      const total = Number(req.headers["x-upload-content-length"] ?? "0");
      const sid = `sid-${seq++}`;
      sessions.set(sid, { name: parsed.name, total, received: 0 });
      const addr = server.address();
      res.writeHead(200, { location: `http://127.0.0.1:${addr.port}/upload/session/${sid}` });
      res.end();
      return;
    }
    if (url.pathname.startsWith("/upload/session/") && req.method === "PUT") {
      const sid = url.pathname.slice("/upload/session/".length);
      const s = sessions.get(sid);
      if (!s) {
        res.writeHead(404);
        res.end();
        return;
      }
      s.received += body.byteLength;
      if (s.received < s.total) {
        res.writeHead(308, { range: `bytes=0-${s.received - 1}` });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: `up-${seq++}`, name: s.name }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  return { server, baseUrl: `http://127.0.0.1:${addr.port}` };
}

function makeRedirectFetcher(baseUrl) {
  return (rawUrl, init) => {
    const s = String(rawUrl)
      .replace("https://oauth2.googleapis.com", baseUrl)
      .replace("https://www.googleapis.com", baseUrl);
    return fetch(s, init);
  };
}

async function probeHttpDuring(url, stopSignal) {
  const latencies = [];
  while (!stopSignal.stopped) {
    const t0 = performance.now();
    try {
      const r = await fetch(url);
      await r.text();
      latencies.push(performance.now() - t0);
    } catch {
      // ignore
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  latencies.sort((a, b) => a - b);
  return {
    samples: latencies.length,
    p50Ms: Number(percentile(latencies, 50).toFixed(2)),
    p99Ms: Number(percentile(latencies, 99).toFixed(2)),
  };
}

function seedWalSqliteDb(dbPath, targetMb = 48) {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
  db.exec("CREATE TABLE bench_blobs (id INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT NOT NULL);");
  const insert = db.prepare("INSERT INTO bench_blobs (body) VALUES (?)");
  const chunk = "T3-DRIVE-BENCH-DATA-".repeat(2048); // ~40 KB per row
  const rows = Math.max(100, Math.floor((targetMb * 1024 * 1024) / chunk.length));
  db.exec("BEGIN");
  for (let i = 0; i < rows; i += 1) {
    insert.run(`${i}:${chunk}`);
  }
  db.exec("COMMIT");
  return db;
}

function createRandomDataFile(filePath, sizeMb) {
  const fd = fs.openSync(filePath, "w");
  const block = crypto.randomBytes(1024 * 1024); // 1 MiB incompressible -> realistic I/O & AES load
  try {
    for (let i = 0; i < sizeMb; i += 1) {
      fs.writeSync(fd, block, 0, block.byteLength);
    }
  } finally {
    fs.closeSync(fd);
  }
}

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-drive-bench-"));
  const t3Http = await startT3LikeHttpServer();
  const mockDrive = await startMockResumableDriveServer();
  const dbPath = path.join(tmpDir, "bench-state.sqlite");
  const snapPath = path.join(tmpDir, "snap.sqlite");
  const archivePath = path.join(tmpDir, "bench-out.t3enc");
  const bigFile1 = path.join(tmpDir, "payload-64m.bin");
  const uploadSampleFile = path.join(tmpDir, "upload-8m.t3enc");

  let db = null;
  try {
    // 1. 픽스처 생성 (48 MB WAL SQLite + 64 MB 바이너리 + 8 MB 업로드 샘플)
    db = seedWalSqliteDb(dbPath, 48);
    createRandomDataFile(bigFile1, 64);
    createRandomDataFile(uploadSampleFile, 8);

    // 2. Phase 1: 백업 전 Baseline 측정 (2.0초)
    const eldBefore = monitorEventLoopDelay({ resolution: 10 });
    eldBefore.enable();
    const baseStop = { stopped: false };
    const baseHttpPromise = probeHttpDuring(t3Http.url, baseStop);
    await new Promise((r) => setTimeout(r, 2000));
    baseStop.stopped = true;
    const httpBefore = await baseHttpPromise;
    eldBefore.disable();
    const elBeforeP50 = Number((eldBefore.percentile(50) / 1e6).toFixed(2));
    const elBeforeP99 = Number((eldBefore.percentile(99) / 1e6).toFixed(2));

    // 3. Phase 2: 백업 중 측정 (자식 워커 VACUUM INTO + T3ARC2/T3ENC2 암호화 + 동시 WAL 쓰기 + HTTP 서빙)
    const eldDuring = monitorEventLoopDelay({ resolution: 10 });
    eldDuring.enable();
    const activeStop = { stopped: false };
    const activeHttpPromise = probeHttpDuring(t3Http.url, activeStop);

    // 동시 SQLite WAL 쓰기 시뮬레이션 (사용자 턴 기록 모사)
    const insertStmt = db.prepare("INSERT INTO bench_blobs (body) VALUES (?)");
    const walWriter = setInterval(() => {
      try {
        insertStmt.run(`live-turn-${Date.now()}-${"x".repeat(4096)}`);
      } catch {
        // ignore
      }
    }, 100);

    let peakWorkerRssBytes = 0;
    const cpuBeforeAll = os.cpus();

    const snapRes = await runSqliteSnapshotInWorker({
      dbPath,
      outputPath: snapPath,
      rssLimitMb: 300,
      workerScriptPath: WORKER_SCRIPT,
      onTelemetry: (t) => {
        if (t.peakRssBytes > peakWorkerRssBytes) peakWorkerRssBytes = t.peakRssBytes;
      },
    });
    if (snapRes.peakRssBytes > peakWorkerRssBytes) peakWorkerRssBytes = snapRes.peakRssBytes;

    const packRes = await runPackAndEncryptInWorker({
      targetId: "bench-target",
      targetDisplayName: "BenchTarget",
      entries: [
        { archivePath: "db/bench-state.sqlite", filePath: snapPath },
        { archivePath: "files/payload-64m.bin", filePath: bigFile1 },
      ],
      outputPath: archivePath,
      createdAtIso: new Date().toISOString(),
      encryptionPassphrase: "BenchPassphrase!2026",
      readLimitMBps: 50,
      rssLimitMb: 300,
      workerScriptPath: WORKER_SCRIPT,
    });
    if (packRes.peakRssBytes > peakWorkerRssBytes) peakWorkerRssBytes = packRes.peakRssBytes;

    clearInterval(walWriter);
    const cpuAfterAll = os.cpus();

    // Resumable 업로드 속도 제한(20 Mbps = 2.5 MB/s) 실측 (8 MiB 샘플)
    const upStart = performance.now();
    await uploadFileResumableToGoogleDriveApi(
      { clientId: "cid", clientSecret: "sec", refreshToken: "1//ref" },
      "T3-Backup",
      {
        subFolder: "bench",
        fileName: "upload-8m.t3enc",
        filePath: uploadSampleFile,
        retentionCount: 2,
        chunkSizeBytes: 512 * 1024,
        uploadLimitMbps: 20,
        fetcher: makeRedirectFetcher(mockDrive.baseUrl),
      },
    );
    const upElapsedSec = (performance.now() - upStart) / 1000;
    const uploadMbps = Number(((8 * 1024 * 1024 * 8) / 1_000_000 / upElapsedSec).toFixed(2));

    activeStop.stopped = true;
    const httpDuring = await activeHttpPromise;
    eldDuring.disable();

    const elDuringP50 = Number((eldDuring.percentile(50) / 1e6).toFixed(2));
    const elDuringP99 = Number((eldDuring.percentile(99) / 1e6).toFixed(2));
    const elP99DeltaMs = Number((elDuringP99 - elBeforeP99).toFixed(2));

    // 시스템 CPU 평균 점유율 계산 (Phase 2 구간)
    let idleDelta = 0;
    let totalDelta = 0;
    for (let i = 0; i < cpuBeforeAll.length; i += 1) {
      const b = cpuBeforeAll[i].times;
      const a = cpuAfterAll[i].times;
      const dIdle = a.idle - b.idle;
      const dTotal =
        a.user - b.user + (a.nice - b.nice) + (a.sys - b.sys) + (a.irq - b.irq) + dIdle;
      idleDelta += dIdle;
      totalDelta += dTotal;
    }
    const systemCpuBusyPct =
      totalDelta > 0 ? Number((((totalDelta - idleDelta) / totalDelta) * 100).toFixed(1)) : 0;

    // 4. Phase 3: 일시정지 반응 시간 실측 (① 워커 패킹 중 abort, ② Resumable 업로드 중 abort)
    const packPauseController = new AbortController();
    const pauseOutPath = path.join(tmpDir, "paused-out.t3enc");
    let workerPauseStart = 0;
    const workerPauseTimer = setTimeout(() => {
      workerPauseStart = performance.now();
      packPauseController.abort("user_input_resumed");
    }, 350);
    let workerPauseMs = -1;
    try {
      await runPackAndEncryptInWorker({
        targetId: "bench-pause",
        targetDisplayName: "BenchPause",
        entries: [{ archivePath: "files/payload-64m.bin", filePath: bigFile1 }],
        outputPath: pauseOutPath,
        createdAtIso: new Date().toISOString(),
        encryptionPassphrase: "BenchPassphrase!2026",
        readLimitMBps: 20, // 느리게 읽어 중단 시점 확보
        rssLimitMb: 300,
        signal: packPauseController.signal,
        workerScriptPath: WORKER_SCRIPT,
      });
    } catch (err) {
      if (err instanceof SnapshotPausedError || packPauseController.signal.aborted) {
        workerPauseMs = Number((performance.now() - workerPauseStart).toFixed(1));
      } else {
        throw err;
      }
    } finally {
      clearTimeout(workerPauseTimer);
    }

    const upPauseController = new AbortController();
    let uploadPauseStart = 0;
    let savedCheckpointOffset = 0;
    const uploadPauseTimer = setTimeout(() => {
      uploadPauseStart = performance.now();
      upPauseController.abort("active_turn_started");
    }, 500);
    let uploadPauseMs = -1;
    try {
      await uploadFileResumableToGoogleDriveApi(
        { clientId: "cid", clientSecret: "sec", refreshToken: "1//ref" },
        "T3-Backup",
        {
          subFolder: "bench-pause",
          fileName: "upload-pause.t3enc",
          filePath: uploadSampleFile,
          retentionCount: 2,
          chunkSizeBytes: 256 * 1024,
          uploadLimitMbps: 10, // ~1.25 MB/s -> 8MB는 ~6.4초 소요
          signal: upPauseController.signal,
          onCheckpoint: (cp) => {
            savedCheckpointOffset = cp.offsetBytes;
          },
          fetcher: makeRedirectFetcher(mockDrive.baseUrl),
        },
      );
    } catch (err) {
      if (err instanceof ResumableUploadPausedError || upPauseController.signal.aborted) {
        uploadPauseMs = Number((performance.now() - uploadPauseStart).toFixed(1));
      } else {
        throw err;
      }
    } finally {
      clearTimeout(uploadPauseTimer);
    }

    const peakRssMb = Number((peakWorkerRssBytes / (1024 * 1024)).toFixed(2));
    const maxPauseMs = Math.max(workerPauseMs, uploadPauseMs);

    const cpuCores = Math.max(1, os.cpus().length);
    const workerTotalCpuMs = Number(
      (
        (snapRes.cpuUserMs ?? 0) +
        (snapRes.cpuSystemMs ?? 0) +
        (packRes.cpuUserMs ?? 0) +
        (packRes.cpuSystemMs ?? 0)
      ).toFixed(2),
    );
    const workerWallMs = Math.max(1, snapRes.elapsedMs + packRes.elapsedMs);
    const workerSingleCoreCpuPct = Number(((workerTotalCpuMs / workerWallMs) * 100).toFixed(1));
    const workerHostTotalCpuPct = Number(
      ((workerTotalCpuMs / (workerWallMs * cpuCores)) * 100).toFixed(2),
    );

    const report = {
      passed:
        elP99DeltaMs <= 20 &&
        peakRssMb <= 300 &&
        workerPauseMs >= 0 &&
        workerPauseMs <= 5000 &&
        uploadPauseMs >= 0 &&
        uploadPauseMs <= 5000 &&
        snapRes.quickCheck === "ok",
      criteria: {
        eventLoopP99DeltaMaxMs: 20,
        workerPeakRssMaxMb: 300,
        pauseResponseMaxMs: 5000,
        configuredUploadLimitMbps: 20,
      },
      eventLoopDelayMs: {
        before: { p50: elBeforeP50, p99: elBeforeP99 },
        during: { p50: elDuringP50, p99: elDuringP99 },
        p99DeltaMs: elP99DeltaMs,
      },
      httpLatencyMs: {
        before: httpBefore,
        during: httpDuring,
      },
      worker: {
        prioritySet: snapRes.prioritySet,
        peakRssMb,
        cpuCores,
        workerCpuUserMs: Number(((snapRes.cpuUserMs ?? 0) + (packRes.cpuUserMs ?? 0)).toFixed(2)),
        workerCpuSystemMs: Number(
          ((snapRes.cpuSystemMs ?? 0) + (packRes.cpuSystemMs ?? 0)).toFixed(2),
        ),
        workerSingleCoreCpuPct,
        workerHostTotalCpuPct,
        systemCpuBusyPct,
        snapshotBytes: snapRes.snapshotBytes,
        snapshotElapsedMs: snapRes.elapsedMs,
        walGrowthBytes: snapRes.walGrowthBytes,
        quickCheck: snapRes.quickCheck,
        packRawBytes: packRes.rawBytes,
        packArchiveBytes: packRes.archiveBytes,
        packElapsedMs: packRes.elapsedMs,
      },
      uploadThrottle: {
        targetLimitMbps: 20,
        measuredMbps: uploadMbps,
        sampleBytes: 8 * 1024 * 1024,
        elapsedSec: Number(upElapsedSec.toFixed(2)),
      },
      pauseLatencyMs: {
        workerPackPauseMs: workerPauseMs,
        resumableUploadPauseMs: uploadPauseMs,
        savedCheckpointOffsetBytes: savedCheckpointOffset,
        maxPauseMs,
      },
    };

    console.log(JSON.stringify(report, null, 2));
    if (!report.passed) {
      process.exitCode = 1;
    }
  } finally {
    if (db) {
      try {
        db.close();
      } catch {
        // ignore
      }
    }
    await new Promise((r) => t3Http.server.close(r));
    await new Promise((r) => mockDrive.server.close(r));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error("[bench-drive-backup-impact] FAILED:", err);
  process.exit(1);
});
