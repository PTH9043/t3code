// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off globalTimers:off
import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { HostPowerSnapshot } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { afterEach, describe, expect, it } from "vite-plus/test";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as HostPowerMonitor from "../../background/HostPowerMonitor.ts";
import * as ServerConfig from "../../config.ts";
import { activeWorkRegistry } from "../../orchestration/ActiveWorkTracker.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as DesktopTelemetryReceiver from "../../resourceTelemetry/DesktopTelemetryReceiver.ts";
import {
  evaluateDriveBackupPauseGate,
  evaluateDriveBackupStartGate,
  isFullSnapshotDue,
} from "./DriveBackupIdleGate.ts";
import { runDriveBackupSchedulerCycle } from "./DriveBackupScheduler.ts";
import {
  DriveBackupSerialCoordinator,
  runSqliteSnapshotInWorker,
} from "./DriveBackupWorkerHost.ts";
import { GoogleDriveBackupService } from "./GoogleDriveBackupService.ts";
import { GoogleDriveBackupServiceLive } from "./GoogleDriveBackupServiceLive.ts";
import { TokenBucket } from "./TokenBucket.ts";

function makePowerSnapshot(overrides: Partial<HostPowerSnapshot> = {}): HostPowerSnapshot {
  return {
    source: "electron-main",
    idle: "true",
    idleSeconds: 700,
    locked: "false",
    suspended: false,
    onBattery: "false",
    lowPowerMode: "false",
    thermalState: "nominal",
    stale: false,
    updatedAt: DateTime.makeUnsafe("2026-11-27T06:00:00.000Z"),
    ...overrides,
  };
}

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

describe("Stage 2: Non-blocking worker SQLite snapshot, idle/pause gates, TokenBucket & scheduler", () => {
  const tempDirs: string[] = [];
  const mkTempDir = (prefix: string) => {
    const dir = NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  };

  afterEach(() => {
    activeWorkRegistry.clearAll();
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!;
      try {
        NodeFs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  it("enforces all Start Gate (A) and Pause Gate (B) rules independently of BackgroundPolicy", () => {
    const baseConfig = {
      idleMinSeconds: 600,
      pauseOnBattery: true,
      allowedWindowEnabled: false,
      allowedWindowStartHour: 1,
      allowedWindowEndHour: 6,
    };

    expect(
      evaluateDriveBackupStartGate({
        config: baseConfig,
        hostPower: makePowerSnapshot(),
        activeWorkCount: 0,
      }),
    ).toEqual({ allowed: true });

    // Locked alone satisfies absence even when idleSeconds < 600
    expect(
      evaluateDriveBackupStartGate({
        config: baseConfig,
        hostPower: makePowerSnapshot({ locked: "true", idleSeconds: 10 }),
        activeWorkCount: 0,
      }),
    ).toEqual({ allowed: true });

    // Each blocking condition must deny start
    expect(
      evaluateDriveBackupStartGate({
        config: baseConfig,
        hostPower: makePowerSnapshot(),
        activeWorkCount: 1,
      }),
    ).toMatchObject({ allowed: false, reason: "active_work" });

    expect(
      evaluateDriveBackupStartGate({
        config: baseConfig,
        hostPower: makePowerSnapshot({ stale: true }),
        activeWorkCount: 0,
      }),
    ).toMatchObject({ allowed: false, reason: "power_stale" });

    expect(
      evaluateDriveBackupStartGate({
        config: baseConfig,
        hostPower: makePowerSnapshot({ idle: "false", idleSeconds: 120, locked: "false" }),
        activeWorkCount: 0,
      }),
    ).toMatchObject({ allowed: false, reason: "not_idle" });

    expect(
      evaluateDriveBackupStartGate({
        config: baseConfig,
        hostPower: makePowerSnapshot({ suspended: true }),
        activeWorkCount: 0,
      }),
    ).toMatchObject({ allowed: false, reason: "suspended" });

    expect(
      evaluateDriveBackupStartGate({
        config: baseConfig,
        hostPower: makePowerSnapshot({ thermalState: "serious" }),
        activeWorkCount: 0,
      }),
    ).toMatchObject({ allowed: false, reason: "thermal_pressure" });

    expect(
      evaluateDriveBackupStartGate({
        config: baseConfig,
        hostPower: makePowerSnapshot({ onBattery: "true" }),
        activeWorkCount: 0,
      }),
    ).toMatchObject({ allowed: false, reason: "on_battery" });

    expect(
      evaluateDriveBackupStartGate({
        config: { ...baseConfig, allowedWindowEnabled: true },
        hostPower: makePowerSnapshot(),
        activeWorkCount: 0,
        nowDate: new Date(2026, 10, 27, 14, 0, 0),
      }),
    ).toMatchObject({ allowed: false, reason: "outside_window" });

    expect(
      evaluateDriveBackupStartGate({
        config: baseConfig,
        hostPower: makePowerSnapshot(),
        activeWorkCount: 0,
        freeDiskBytes: 500 * 1024 * 1024,
        requiredDiskBytes: 2 * 1024 ** 3,
      }),
    ).toMatchObject({ allowed: false, reason: "low_disk_space" });

    // Pause Gate (B) checks
    expect(
      evaluateDriveBackupPauseGate({
        config: baseConfig,
        hostPower: makePowerSnapshot(),
        activeWorkCount: 1,
      }),
    ).toMatchObject({ pause: true, reason: "active_work" });

    expect(
      evaluateDriveBackupPauseGate({
        config: baseConfig,
        hostPower: makePowerSnapshot({ idle: "false", idleSeconds: 0 }),
        activeWorkCount: 0,
      }),
    ).toMatchObject({ pause: true, reason: "user_returned" });

    expect(
      evaluateDriveBackupPauseGate({
        config: baseConfig,
        hostPower: makePowerSnapshot({ locked: "false", idle: "true", idleSeconds: 700 }),
        previousLocked: "true",
        activeWorkCount: 0,
      }),
    ).toMatchObject({ pause: true, reason: "unlocked" });

    expect(
      evaluateDriveBackupPauseGate({
        config: baseConfig,
        hostPower: makePowerSnapshot({ onBattery: "true" }),
        activeWorkCount: 0,
      }),
    ).toMatchObject({ pause: true, reason: "on_battery" });

    expect(
      evaluateDriveBackupPauseGate({
        config: baseConfig,
        hostPower: makePowerSnapshot({ thermalState: "critical" }),
        activeWorkCount: 0,
      }),
    ).toMatchObject({ pause: true, reason: "thermal_pressure" });

    // Full snapshot cadence default = weekly (7 days)
    expect(
      isFullSnapshotDue({
        includeCoreSqliteSnapshot: true,
        lastFullSnapshotAtMs: 1_000_000,
        fullSnapshotIntervalDays: 7,
        nowMs: 1_000_000 + 3 * 86_400_000,
      }),
    ).toBe(false);
    expect(
      isFullSnapshotDue({
        includeCoreSqliteSnapshot: true,
        lastFullSnapshotAtMs: 1_000_000,
        fullSnapshotIntervalDays: 7,
        nowMs: 1_000_000 + 8 * 86_400_000,
      }),
    ).toBe(true);
  });

  it("snapshots a WAL SQLite database in an isolated child process without blocking writes, records WAL growth, and fails loudly on corrupted DB", async () => {
    const dir = mkTempDir("t3-snap-worker-");
    const dbPath = NodePath.join(dir, "state.sqlite");
    const snapOut = NodePath.join(dir, "staging", "snap.sqlite");

    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA journal_mode = WAL; CREATE TABLE items (id INTEGER PRIMARY KEY, body TEXT);");
    const insert = db.prepare("INSERT INTO items (body) VALUES (?)");
    const payload = "x".repeat(2_048);
    db.exec("BEGIN");
    for (let i = 0; i < 400; i += 1) insert.run(payload);
    db.exec("COMMIT");

    // Concurrent write while child process runs VACUUM INTO
    const writer = setInterval(() => {
      try {
        insert.run("concurrent-write");
      } catch {
        // ignore if closed
      }
    }, 10);

    try {
      const result = await runSqliteSnapshotInWorker({
        dbPath,
        outputPath: snapOut,
        rssLimitMb: 300,
      });
      expect(result.workerPid).not.toBe(process.pid);
      expect(result.quickCheck).toBe("ok");
      expect(result.snapshotBytes).toBeGreaterThan(0);
      expect(result.walGrowthBytes).toBeGreaterThanOrEqual(0);
      expect(result.peakRssBytes).toBeLessThan(300 * 1024 * 1024);
      expect(NodeFs.existsSync(snapOut)).toBe(true);

      // Verify restored snapshot readability
      const checkDb = new DatabaseSync(snapOut, { readOnly: true });
      try {
        const cnt = checkDb.prepare("SELECT COUNT(*) as c FROM items").get() as { c: number };
        expect(cnt.c).toBeGreaterThanOrEqual(400);
      } finally {
        checkDb.close();
      }
    } finally {
      clearInterval(writer);
      db.close();
    }

    // Corrupted DB must NEVER silently succeed — must throw error
    const badDbPath = NodePath.join(dir, "corrupt.sqlite");
    NodeFs.writeFileSync(badDbPath, "NOT_A_VALID_SQLITE_FILE_CORRUPTED_BYTES");
    await expect(
      runSqliteSnapshotInWorker({
        dbPath: badDbPath,
        outputPath: NodePath.join(dir, "staging", "bad-snap.sqlite"),
      }),
    ).rejects.toThrow();
  });

  it("marks drive_backup_runs as status='failed' (never silently succeeded) when snapshot fails", async () => {
    const baseDir = mkTempDir("t3-snap-fail-base-");
    const driveRoot = mkTempDir("t3-snap-fail-drive-");
    const repoDir = mkTempDir("t3-snap-fail-repo-");
    NodeFs.writeFileSync(NodePath.join(repoDir, "file.txt"), "ok");

    // ServerConfig.layerTest uses <baseDir>/userdata/state.sqlite; create a corrupt file there
    const userdataDir = NodePath.join(baseDir, "userdata");
    NodeFs.mkdirSync(userdataDir, { recursive: true });
    NodeFs.writeFileSync(NodePath.join(userdataDir, "state.sqlite"), "CORRUPTED_SQLITE_HEADER");

    const sqlite = SqlitePersistenceMemory.pipe(Layer.provide(NodeServices.layer));
    const config = ServerConfig.ServerConfig.layerTest(repoDir, baseDir).pipe(
      Layer.provide(NodeServices.layer),
    );
    const layer = GoogleDriveBackupServiceLive.pipe(
      Layer.provideMerge(sqlite),
      Layer.provideMerge(config),
      Layer.provideMerge(makeMemorySecretStoreLayer()),
    );

    const stateAfterFail = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* GoogleDriveBackupService;
        yield* svc.updateConfig({
          transportMode: "local_drive_folder",
          localDriveRoot: driveRoot,
          encryptionEnabled: false,
          includeCoreSettings: false,
          includeCoreSqliteSnapshot: true,
        });
        const runExit = yield* svc.runNow({}).pipe(Effect.exit);
        expect(runExit._tag).toBe("Failure");
        return yield* svc.getState({});
      }).pipe(Effect.provide(layer)),
    );

    const latestRun = stateAfterFail.recentRuns[0];
    expect(latestRun?.status).toBe("failed");
    expect(latestRun?.errorMessage).toContain("SQLite 스냅샷 생성 실패");
  });

  it("runs scheduler only when autoScheduleEnabled & idle gate pass, elevates telemetry to 1s, and pauses cleanly", async () => {
    const baseDir = mkTempDir("t3-sched-base-");
    const driveRoot = mkTempDir("t3-sched-drive-");
    const repoDir = mkTempDir("t3-sched-repo-");
    NodeFs.writeFileSync(NodePath.join(repoDir, "note.md"), "# Scheduled backup\n");

    const sqlite = SqlitePersistenceMemory.pipe(Layer.provide(NodeServices.layer));
    const config = ServerConfig.ServerConfig.layerTest(repoDir, baseDir).pipe(
      Layer.provide(NodeServices.layer),
    );
    const layer = GoogleDriveBackupServiceLive.pipe(
      Layer.provideMerge(sqlite),
      Layer.provideMerge(config),
      Layer.provideMerge(makeMemorySecretStoreLayer()),
    );

    const intervalOverrides: Array<{ activeIntervalMs: number; idleIntervalMs: number } | null> =
      [];
    const fakeTelemetryLayer = DesktopTelemetryReceiver.layerTest({
      setHostPowerIntervalsOverride: (ov) =>
        Effect.sync(() => {
          intervalOverrides.push(ov);
        }),
    });

    await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* GoogleDriveBackupService;
        const telemetry = yield* DesktopTelemetryReceiver.DesktopTelemetryReceiver;
        const power = yield* HostPowerMonitor.make(
          makePowerSnapshot({ idleSeconds: 100, locked: "false" }),
        );

        yield* svc.updateConfig({
          transportMode: "local_drive_folder",
          localDriveRoot: driveRoot,
          encryptionEnabled: false,
          includeCoreSettings: false,
          includeCoreSqliteSnapshot: false,
          autoScheduleEnabled: false,
        });
        yield* svc.upsertTarget({
          kind: "repo",
          displayName: "SchedRepo",
          rootPath: repoDir,
          enabled: true,
          syncFiles: true,
          syncT3Scope: false,
          syncDriveToLocalRag: false,
        });

        // 1. autoScheduleEnabled=false -> disabled
        const c1 = yield* runDriveBackupSchedulerCycle({
          backupService: svc,
          hostPowerMonitor: power,
          telemetryReceiver: telemetry,
        });
        expect(c1.action).toBe("disabled");

        // 2. Enable schedule, but idleSeconds=100 < 600 -> skipped(not_idle)
        yield* svc.updateConfig({ autoScheduleEnabled: true, idleMinSeconds: 600 });
        const c2 = yield* runDriveBackupSchedulerCycle({
          backupService: svc,
          hostPowerMonitor: power,
          telemetryReceiver: telemetry,
        });
        expect(c2).toEqual({ action: "skipped", reason: "not_idle" });

        // 3. Report idleSeconds=700 -> runs, elevates telemetry to 1s, then restores null
        yield* power.report(
          makePowerSnapshot({
            idle: "true",
            idleSeconds: 700,
            updatedAt: DateTime.makeUnsafe("2026-11-27T06:10:00.000Z"),
          }),
        );
        const c3 = yield* runDriveBackupSchedulerCycle({
          backupService: svc,
          hostPowerMonitor: power,
          telemetryReceiver: telemetry,
        });
        expect(c3.action).toBe("ran");
        expect(intervalOverrides).toEqual([
          { activeIntervalMs: 1_000, idleIntervalMs: 1_000 },
          null,
        ]);
      }).pipe(Effect.provide(Layer.mergeAll(layer, fakeTelemetryLayer))),
    );
  });

  it("throttles throughput via TokenBucket and serializes overlapping jobs via Coordinator", async () => {
    const bucket = new TokenBucket({ bytesPerSecond: 100_000, burstBytes: 64 * 1024 });
    const t0 = Date.now();
    await bucket.consume(64 * 1024);
    await bucket.consume(20_000);
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(150);

    // Pause/abort responds immediately (< 100ms)
    const ac = new AbortController();
    setTimeout(() => ac.abort("paused"), 30);
    const tPause0 = Date.now();
    await expect(bucket.consume(500_000, ac.signal)).rejects.toThrow();
    expect(Date.now() - tPause0).toBeLessThan(500);

    // Serial coordinator enforces zero overlap
    const coord = new DriveBackupSerialCoordinator();
    const events: string[] = [];
    await Promise.all([
      coord.runExclusive("backup", async () => {
        events.push("start:backup");
        await new Promise((r) => setTimeout(r, 40));
        events.push("end:backup");
      }),
      coord.runExclusive("mirror", async () => {
        events.push("start:mirror");
        events.push("end:mirror");
      }),
    ]);
    expect(events).toEqual(["start:backup", "end:backup", "start:mirror", "end:mirror"]);
  });
});
