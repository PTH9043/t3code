// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off globalDate:off globalDateInEffect:off globalFetch:off
import * as NodeCrypto from "node:crypto";
import * as NodeFs from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { afterEach, describe, expect, it } from "vite-plus/test";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as HostPowerMonitor from "../../background/HostPowerMonitor.ts";
import * as ServerConfig from "../../config.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import {
  computeNextQuotaResumeAtMs,
  createEmptyDailyUploadLedger,
  DriveUploadQuotaExceededError,
  getRolling24hUploadedBytes,
  HOUR_MS,
  isGoogleDriveDailyUploadQuotaResponse,
  markLedgerQuotaPaused,
  recordUploadedBytesInLedger,
} from "./DriveBackupQuota.ts";
import { runDriveBackupSchedulerCycle } from "./DriveBackupScheduler.ts";
import { uploadFileResumableToGoogleDriveApi } from "./DriveTransportAdapter.ts";
import { GoogleDriveBackupService } from "./GoogleDriveBackupService.ts";
import { GoogleDriveBackupServiceLive } from "./GoogleDriveBackupServiceLive.ts";

function makeMemorySecretStoreLayer() {
  const store = new Map<string, Uint8Array>();
  return Layer.succeed(ServerSecretStore.ServerSecretStore, {
    get: (name) => Effect.succeed(store.has(name) ? Option.some(store.get(name)!) : Option.none()),
    set: (name, value) =>
      Effect.sync(() => {
        store.set(name, Uint8Array.from(value));
      }),
    create: (name, value) =>
      Effect.sync(() => {
        store.set(name, Uint8Array.from(value));
      }),
    getOrCreateRandom: (name, bytes) =>
      Effect.sync(() => {
        const existing = store.get(name);
        if (existing) return existing;
        const fresh = new Uint8Array(bytes);
        store.set(name, fresh);
        return fresh;
      }),
    remove: (name) =>
      Effect.sync(() => {
        store.delete(name);
      }),
  });
}

function makeTestLayer(cwd: string, baseDir: string) {
  const sqlite = SqlitePersistenceMemory.pipe(Layer.provide(NodeServices.layer));
  const config = ServerConfig.ServerConfig.layerTest(cwd, baseDir).pipe(
    Layer.provide(NodeServices.layer),
  );
  const secrets = makeMemorySecretStoreLayer();
  return GoogleDriveBackupServiceLive.pipe(
    Layer.provideMerge(sqlite),
    Layer.provideMerge(config),
    Layer.provideMerge(secrets),
  );
}

describe("750 GB daily quota protection, incremental knowledge manifest & staging preservation", () => {
  const tempDirs: string[] = [];
  const origBudgetEnv = process.env.T3_DRIVE_BACKUP_DAILY_BUDGET_BYTES;
  const origFetch = globalThis.fetch;

  const mkTempDir = (prefix: string) => {
    const dir = NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  };

  afterEach(() => {
    globalThis.fetch = origFetch;
    if (origBudgetEnv === undefined) {
      delete process.env.T3_DRIVE_BACKUP_DAILY_BUDGET_BYTES;
    } else {
      process.env.T3_DRIVE_BACKUP_DAILY_BUDGET_BYTES = origBudgetEnv;
    }
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!;
      try {
        NodeFs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  it("tracks rolling 24h upload ledger, prunes expired hours, and classifies 403 daily quota vs storage full", () => {
    const t0 = 1_800_000_000_000;
    let ledger = createEmptyDailyUploadLedger(t0);
    ledger = recordUploadedBytesInLedger(ledger, 400 * 1024 ** 3, t0);
    ledger = recordUploadedBytesInLedger(ledger, 320 * 1024 ** 3, t0 + 2 * HOUR_MS);
    expect(getRolling24hUploadedBytes(ledger, t0 + 3 * HOUR_MS)).toBe(720 * 1024 ** 3);

    const budget = 700 * 1024 ** 3;
    const resumeAt = computeNextQuotaResumeAtMs(ledger, budget, t0 + 3 * HOUR_MS);
    expect(resumeAt).toBeGreaterThan(t0 + 23 * HOUR_MS);
    expect(getRolling24hUploadedBytes(ledger, resumeAt)).toBeLessThan(budget);

    const paused = markLedgerQuotaPaused(ledger, resumeAt, "quota", t0 + 3 * HOUR_MS);
    expect(paused.pausedUntilMs).toBe(resumeAt);

    expect(
      isGoogleDriveDailyUploadQuotaResponse(
        403,
        '{"error":{"errors":[{"reason":"userRateLimitExceeded"}]}}',
      ),
    ).toBe(true);
    expect(
      isGoogleDriveDailyUploadQuotaResponse(
        403,
        '{"error":{"errors":[{"reason":"dailyLimitExceeded"}]}}',
      ),
    ).toBe(true);
    // 실제 드라이브 용량 부족(storageQuotaExceeded)은 24시간 대기로 풀리지 않으므로 제외
    expect(
      isGoogleDriveDailyUploadQuotaResponse(
        403,
        '{"error":{"errors":[{"reason":"storageQuotaExceeded"}]}}',
      ),
    ).toBe(false);
  });

  it("converts 403 userRateLimitExceeded on chunk PUT into DriveUploadQuotaExceededError while preserving checkpoint", async () => {
    const dir = mkTempDir("t3-quota-chunk-");
    const filePath = NodePath.join(dir, "sample.t3enc");
    NodeFs.writeFileSync(filePath, NodeCrypto.randomBytes(600 * 1024));

    let putCalls = 0;
    const server = NodeHttp.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      req.on("end", () => {
        const u = new URL(req.url ?? "/", "http://127.0.0.1");
        if (u.pathname === "/token") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ access_token: "tok" }));
          return;
        }
        if (u.pathname === "/drive/v3/files") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ files: [{ id: "fld-1", name: "T3-Backup" }] }));
          return;
        }
        if (u.pathname === "/upload/drive/v3/files" && req.method === "POST") {
          res.writeHead(200, {
            location: `http://127.0.0.1:${(server.address() as { port: number }).port}/up/s1`,
          });
          res.end();
          return;
        }
        if (u.pathname === "/up/s1" && req.method === "PUT") {
          putCalls += 1;
          if (putCalls === 1) {
            res.writeHead(308, { range: "bytes=0-262143" });
            res.end();
            return;
          }
          res.writeHead(403, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              error: {
                code: 403,
                message: "User rate limit exceeded.",
                errors: [{ domain: "usageLimits", reason: "userRateLimitExceeded" }],
              },
            }),
          );
          return;
        }
        res.writeHead(404);
        res.end();
      });
    });

    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    const rewrittenFetch = ((url: string | URL | Request, init?: RequestInit) => {
      const s = String(url)
        .replace("https://oauth2.googleapis.com", `http://127.0.0.1:${port}`)
        .replace("https://www.googleapis.com", `http://127.0.0.1:${port}`);
      return origFetch(s, init);
    }) as typeof fetch;

    const checkpoints: Array<{ offsetBytes: number; sessionUri: string }> = [];
    const uploadedChunks: number[] = [];

    try {
      await expect(
        uploadFileResumableToGoogleDriveApi(
          { clientId: "c", clientSecret: "s", refreshToken: "r" },
          "T3-Backup",
          {
            subFolder: "userdata",
            fileName: "sample.t3enc",
            filePath,
            retentionCount: 2,
            chunkSizeBytes: 256 * 1024,
            onCheckpoint: (cp) => {
              checkpoints.push({ offsetBytes: cp.offsetBytes, sessionUri: cp.sessionUri });
            },
            onChunkUploaded: (b) => {
              uploadedChunks.push(b);
            },
            fetcher: rewrittenFetch,
          },
        ),
      ).rejects.toSatisfy(
        (err: unknown) =>
          err instanceof DriveUploadQuotaExceededError &&
          err.kind === "remote_quota_exceeded" &&
          err.offsetBytes === 256 * 1024,
      );

      // 403 일일 한도는 5회 재시도하지 않고 즉시 중단되어 총 2회(1청크 성공 + 2청크 403)만 호출
      expect(putCalls).toBe(2);
      expect(uploadedChunks).toEqual([256 * 1024]);
      expect(checkpoints.at(-1)?.offsetBytes).toBe(256 * 1024);
    } finally {
      server.close();
    }
  });

  it("persists T3-Knowledge manifest per uploaded file so resuming after 403 quota skips already uploaded files, and scheduler respects quota cooldown", async () => {
    const baseDir = mkTempDir("t3-quota-svc-base-");
    const knowDir = mkTempDir("t3-quota-know-");
    NodeFs.writeFileSync(NodePath.join(knowDir, "01-alpha.md"), "alpha content ".repeat(100));
    NodeFs.writeFileSync(NodePath.join(knowDir, "02-beta.md"), "beta content ".repeat(100));
    NodeFs.writeFileSync(NodePath.join(knowDir, "03-gamma.md"), "gamma content ".repeat(100));

    let failOnThird = true;
    const uploadedNames: string[] = [];
    let sessionSeq = 0;
    const sessionNames = new Map<string, string>();

    const server = NodeHttp.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      req.on("end", () => {
        const bodyText = Buffer.concat(chunks).toString("utf8");
        const u = new URL(req.url ?? "/", "http://127.0.0.1");
        if (u.pathname === "/token") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ access_token: "tok" }));
          return;
        }
        if (u.pathname === "/drive/v3/files") {
          const q = u.searchParams.get("q") ?? "";
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              files: q.includes("mimeType !=") ? [] : [{ id: "fld-know", name: "T3-Knowledge" }],
            }),
          );
          return;
        }
        if (u.pathname === "/upload/drive/v3/files" && req.method === "POST") {
          const meta = JSON.parse(bodyText || "{}") as { name?: string };
          const fname = meta.name ?? "unknown";
          if (failOnThird && fname === "03-gamma.md") {
            res.writeHead(403, { "content-type": "application/json" });
            res.end(
              JSON.stringify({
                error: { errors: [{ reason: "dailyLimitExceeded" }] },
              }),
            );
            return;
          }
          sessionSeq += 1;
          const sid = `k-${sessionSeq}`;
          sessionNames.set(sid, fname);
          res.writeHead(200, {
            location: `http://127.0.0.1:${(server.address() as { port: number }).port}/up/${sid}`,
          });
          res.end();
          return;
        }
        if (u.pathname.startsWith("/up/") && req.method === "PUT") {
          const sid = u.pathname.slice(4);
          const fname = sessionNames.get(sid) ?? "file";
          uploadedNames.push(fname);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ id: `id-${sid}`, name: fname }));
          return;
        }
        res.writeHead(404);
        res.end();
      });
    });

    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
      const s = String(url)
        .replace("https://oauth2.googleapis.com", `http://127.0.0.1:${port}`)
        .replace("https://www.googleapis.com", `http://127.0.0.1:${port}`);
      return origFetch(s, init);
    }) as typeof fetch;

    const layer = makeTestLayer(knowDir, baseDir);
    const fakePower: HostPowerMonitor.HostPowerMonitor["Service"] = {
      snapshot: Effect.succeed({
        source: "electron-main",
        idle: "true",
        idleSeconds: 900,
        locked: "false",
        suspended: false,
        onBattery: "false",
        lowPowerMode: "false",
        thermalState: "nominal",
        stale: false,
        updatedAt: DateTime.makeUnsafe("2026-11-28T06:00:00.000Z"),
      }),
      report: () => Effect.void,
      streamChanges: Stream.empty,
    };

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const svc = yield* GoogleDriveBackupService;
          yield* svc.updateConfig({
            transportMode: "gdrive_api",
            gdriveClientId: "cid",
            gdriveClientSecret: "sec",
            gdriveRefreshToken: "ref",
            encryptionEnabled: false,
            includeCoreSettings: false,
            includeCoreSqliteSnapshot: false,
            includeEventArchives: false,
            autoScheduleEnabled: true,
          });
          const target = yield* svc.upsertTarget({
            kind: "knowledge",
            displayName: "MyNotes",
            rootPath: knowDir,
            enabled: true,
            syncFiles: false,
            syncT3Scope: false,
            syncDriveToLocalRag: false,
            syncLocalToDriveKnowledge: true,
          });

          // 1차 실행: 01-alpha, 02-beta 업로드 성공 후 03-gamma에서 403 일일 한도 -> paused 전환!
          const firstExit = yield* svc.runNow({ targetIds: [target.id] }).pipe(Effect.exit);
          expect(firstExit._tag).toBe("Failure");
          expect(uploadedNames).toEqual(["01-alpha.md", "02-beta.md"]);

          const afterQuota = yield* svc.getState({});
          expect(afterQuota.recentRuns[0]?.status).toBe("paused");
          expect(afterQuota.quotaPausedUntilMs).toBeTypeOf("number");
          expect((afterQuota.dailyUploadedBytes ?? 0) > 0).toBe(true);

          // 쿨다운 중에는 스케줄러가 불필요한 API 호출 없이 quota_cooldown으로 조용히 대기
          const skippedOutcome = yield* runDriveBackupSchedulerCycle({
            backupService: svc,
            hostPowerMonitor: fakePower,
            nowDate: new Date(Date.now() + 60_000),
            activeWorkCountOverride: 0,
          });
          expect(skippedOutcome.action).toBe("skipped");
          expect(skippedOutcome.reason).toBe("quota_cooldown");

          // 다음 날(강제 재개 또는 쿨다운 만료 후): 01·02는 매니페스트 확정되어 0회 재전송, 03-gamma만 업로드!
          failOnThird = false;
          const resumed = yield* svc.runNow({ targetIds: [target.id], forceWhenBusy: true });
          expect(resumed.status).toBe("succeeded");
          expect(uploadedNames).toEqual(["01-alpha.md", "02-beta.md", "03-gamma.md"]);
        }).pipe(Effect.provide(layer)),
      );
    } finally {
      server.close();
    }
  });

  it("preserves staged archive and checkpoint on transport error so next run resumes without repacking", async () => {
    const baseDir = mkTempDir("t3-stage-preserve-base-");
    const repoDir = mkTempDir("t3-stage-preserve-repo-");
    NodeFs.writeFileSync(NodePath.join(repoDir, "big.bin"), NodeCrypto.randomBytes(64 * 1024));

    let failPutOnce = true;
    const server = NodeHttp.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      req.on("end", () => {
        const u = new URL(req.url ?? "/", "http://127.0.0.1");
        if (u.pathname === "/token") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ access_token: "tok" }));
          return;
        }
        if (u.pathname === "/drive/v3/files") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ files: [{ id: "fld-1", name: "T3-Backup" }] }));
          return;
        }
        if (u.pathname === "/upload/drive/v3/files" && req.method === "POST") {
          res.writeHead(200, {
            location: `http://127.0.0.1:${(server.address() as { port: number }).port}/up/s1`,
          });
          res.end();
          return;
        }
        if (u.pathname === "/up/s1" && req.method === "PUT") {
          const cr = String(req.headers["content-range"] ?? "");
          if (cr.startsWith("bytes */")) {
            res.writeHead(308);
            res.end();
            return;
          }
          if (failPutOnce) {
            res.writeHead(400);
            res.end("simulated transient failure");
            return;
          }
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ id: "file-s1", name: "repo.t3arc" }));
          return;
        }
        res.writeHead(404);
        res.end();
      });
    });

    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
      const s = String(url)
        .replace("https://oauth2.googleapis.com", `http://127.0.0.1:${port}`)
        .replace("https://www.googleapis.com", `http://127.0.0.1:${port}`);
      return origFetch(s, init);
    }) as typeof fetch;

    const layer = makeTestLayer(repoDir, baseDir);
    const stagingDir = NodePath.join(baseDir, "backups", "staging");

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const svc = yield* GoogleDriveBackupService;
          yield* svc.updateConfig({
            transportMode: "gdrive_api",
            gdriveClientId: "cid",
            gdriveClientSecret: "sec",
            gdriveRefreshToken: "ref",
            encryptionEnabled: false,
            includeCoreSettings: false,
            includeCoreSqliteSnapshot: false,
            includeEventArchives: false,
          });
          const target = yield* svc.upsertTarget({
            kind: "repo",
            displayName: "PreserveRepo",
            rootPath: repoDir,
            enabled: true,
            syncFiles: true,
            syncT3Scope: false,
            syncDriveToLocalRag: false,
          });

          // 1차: 업로드 실패 -> 스테이징 .t3arc가 삭제되지 않고 보존되어야 함
          const firstExit = yield* svc.runNow({ targetIds: [target.id] }).pipe(Effect.exit);
          expect(firstExit._tag).toBe("Failure");
          const stagedFiles = NodeFs.readdirSync(stagingDir).filter((f) => f.endsWith(".t3arc"));
          expect(stagedFiles.length).toBe(1);

          // 2차: 재실행 시 재패킹 없이 체크포인트에서 즉시 재개하여 성공 + 완료 후 스테이징 정리
          failPutOnce = false;
          const resumed = yield* svc.runNow({ targetIds: [target.id] });
          expect(resumed.status).toBe("succeeded");
          expect(resumed.resumedFromCheckpoint).toBe(true);
          const afterFiles = NodeFs.readdirSync(stagingDir).filter((f) => f.endsWith(".t3arc"));
          expect(afterFiles.length).toBe(0);
        }).pipe(Effect.provide(layer)),
      );
    } finally {
      server.close();
    }
  });

  it("pauses cleanly before hitting Google 750GB limit when rolling 24h safe budget is reached", async () => {
    const baseDir = mkTempDir("t3-budget-cap-base-");
    const knowDir = mkTempDir("t3-budget-cap-know-");
    // 파일 1: 4KB, 파일 2: 4KB -> 예산을 3KB로 설정하면 파일 1 완료 후 누적 4KB >= 3KB로 파일 2 전에 자동 일시정지
    NodeFs.writeFileSync(NodePath.join(knowDir, "01-first.md"), "A".repeat(4096));
    NodeFs.writeFileSync(NodePath.join(knowDir, "02-second.md"), "B".repeat(4096));
    process.env.T3_DRIVE_BACKUP_DAILY_BUDGET_BYTES = "3000";

    const uploadedNames: string[] = [];
    let seq = 0;
    const names = new Map<string, string>();
    const server = NodeHttp.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      req.on("end", () => {
        const bodyText = Buffer.concat(chunks).toString("utf8");
        const u = new URL(req.url ?? "/", "http://127.0.0.1");
        if (u.pathname === "/token") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ access_token: "tok" }));
          return;
        }
        if (u.pathname === "/drive/v3/files") {
          const q = u.searchParams.get("q") ?? "";
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              files: q.includes("mimeType !=") ? [] : [{ id: "fld-b", name: "T3-Knowledge" }],
            }),
          );
          return;
        }
        if (u.pathname === "/upload/drive/v3/files" && req.method === "POST") {
          const meta = JSON.parse(bodyText || "{}") as { name?: string };
          seq += 1;
          const sid = `b-${seq}`;
          names.set(sid, meta.name ?? "file");
          res.writeHead(200, {
            location: `http://127.0.0.1:${(server.address() as { port: number }).port}/up/${sid}`,
          });
          res.end();
          return;
        }
        if (u.pathname.startsWith("/up/") && req.method === "PUT") {
          const sid = u.pathname.slice(4);
          const fname = names.get(sid) ?? "file";
          uploadedNames.push(fname);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ id: `id-${sid}`, name: fname }));
          return;
        }
        res.writeHead(404);
        res.end();
      });
    });

    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
      const s = String(url)
        .replace("https://oauth2.googleapis.com", `http://127.0.0.1:${port}`)
        .replace("https://www.googleapis.com", `http://127.0.0.1:${port}`);
      return origFetch(s, init);
    }) as typeof fetch;

    const layer = makeTestLayer(knowDir, baseDir);
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const svc = yield* GoogleDriveBackupService;
          yield* svc.updateConfig({
            transportMode: "gdrive_api",
            gdriveClientId: "cid",
            gdriveClientSecret: "sec",
            gdriveRefreshToken: "ref",
            encryptionEnabled: false,
            includeCoreSettings: false,
            includeCoreSqliteSnapshot: false,
            includeEventArchives: false,
          });
          const target = yield* svc.upsertTarget({
            kind: "knowledge",
            displayName: "BudgetNotes",
            rootPath: knowDir,
            enabled: true,
            syncFiles: false,
            syncT3Scope: false,
            syncDriveToLocalRag: false,
            syncLocalToDriveKnowledge: true,
          });

          // 1차 실행: 01-first(4KB) 완료 후 예산(3KB) 도달 -> 02-second 시작 전 paused 전환
          const firstExit = yield* svc.runNow({ targetIds: [target.id] }).pipe(Effect.exit);
          expect(firstExit._tag).toBe("Failure");
          expect(uploadedNames).toEqual(["01-first.md"]);

          const state = yield* svc.getState({});
          expect(state.recentRuns[0]?.status).toBe("paused");
          expect(state.dailyUploadedBytes).toBe(4096);
          expect(state.quotaPausedUntilMs).toBeTypeOf("number");

          // 쿨다운 중 일반 runNow 호출 -> 에러 없이 paused 레코드 반환
          const secondPaused = yield* svc.runNow({ targetIds: [target.id] });
          expect(secondPaused.status).toBe("paused");
          expect(uploadedNames).toEqual(["01-first.md"]);
        }).pipe(Effect.provide(layer)),
      );
    } finally {
      server.close();
    }
  });
});
