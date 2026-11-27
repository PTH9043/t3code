// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off globalDate:off globalDateInEffect:off
import { execFile } from "node:child_process";
import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { afterEach, describe, expect, it } from "vite-plus/test";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { discoverUserdataCandidates, isUserdataHardExcluded } from "./DriveBackupFilter.ts";
import { GoogleDriveBackupService } from "./GoogleDriveBackupService.ts";
import { GoogleDriveBackupServiceLive } from "./GoogleDriveBackupServiceLive.ts";
import { packEntriesToArchive } from "./ProjectArchivePacker.ts";
import { verifyAndExtractArchiveFile } from "./StreamingArchivePacker.ts";

const execFileAsync = promisify(execFile);

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

describe("Stage 4: userdata discovery/hard-exclusions, incremental backup, event archives & standalone restore CLI", () => {
  const tempDirs: string[] = [];
  const mkTempDir = (prefix: string) => {
    const dir = NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  };

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!;
      try {
        NodeFs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  it("discovers userdata candidates, hard-excludes sensitive/runtime paths, backs up incrementally, snapshots watchdog-journal, and uploads only new event archives", async () => {
    const baseDir = mkTempDir("t3-s4-base-");
    const driveRoot = mkTempDir("t3-s4-drive-");
    const repoDir = mkTempDir("t3-s4-repo-");
    const stateDir = NodePath.join(baseDir, "userdata");

    // Seed userdata candidates + forbidden items
    NodeFs.mkdirSync(NodePath.join(stateDir, "memory-v2"), { recursive: true });
    NodeFs.writeFileSync(NodePath.join(stateDir, "memory-v2", "m1.md"), "memory one\n");
    NodeFs.writeFileSync(NodePath.join(stateDir, "memory-v2", "m2.md"), "memory two\n");
    NodeFs.mkdirSync(NodePath.join(stateDir, "secrets"), { recursive: true });
    NodeFs.writeFileSync(NodePath.join(stateDir, "secrets", "secret.bin"), "TOP-SECRET");
    NodeFs.mkdirSync(NodePath.join(stateDir, "logs"), { recursive: true });
    NodeFs.writeFileSync(NodePath.join(stateDir, "logs", "server.log"), "noisy log");
    NodeFs.mkdirSync(NodePath.join(stateDir, "desktop-profile"), { recursive: true });
    NodeFs.writeFileSync(NodePath.join(stateDir, "clerk-tokens.json"), "{}");
    NodeFs.writeFileSync(NodePath.join(stateDir, "state.sqlite-wal"), "wal");

    // Seed watchdog-journal.sqlite in WAL mode
    const wdPath = NodePath.join(stateDir, "watchdog-journal.sqlite");
    const wdDb = new DatabaseSync(wdPath);
    wdDb.exec(
      "PRAGMA journal_mode = WAL; CREATE TABLE j (id INTEGER PRIMARY KEY, msg TEXT); INSERT INTO j (msg) VALUES ('alive');",
    );
    wdDb.close();

    // Seed monthly event archive
    const archivesDir = NodePath.join(stateDir, "archives");
    NodeFs.mkdirSync(archivesDir, { recursive: true });
    const ev1Path = NodePath.join(archivesDir, "events-202611.sqlite");
    const ev1Db = new DatabaseSync(ev1Path);
    ev1Db.exec(
      "CREATE TABLE archived_orchestration_events (id INTEGER PRIMARY KEY, payload TEXT); INSERT INTO archived_orchestration_events (payload) VALUES ('nov-event');",
    );
    ev1Db.close();

    // Hard exclusion checks
    expect(isUserdataHardExcluded("secrets/foo.bin")).toBe(true);
    expect(isUserdataHardExcluded("provider-auth/tok")).toBe(true);
    expect(isUserdataHardExcluded("clerk-tokens.json")).toBe(true);
    expect(isUserdataHardExcluded("logs/server.log")).toBe(true);
    expect(isUserdataHardExcluded("desktop-profile/Cache")).toBe(true);
    expect(isUserdataHardExcluded("state.sqlite-wal")).toBe(true);
    expect(isUserdataHardExcluded("active-work.json")).toBe(true);
    expect(isUserdataHardExcluded("server-runtime.json")).toBe(true);

    const discovered = discoverUserdataCandidates(stateDir);
    const names = discovered.map((c) => c.name);
    expect(names).toContain("memory-v2");
    expect(names).toContain("watchdog-journal.sqlite");
    expect(names).not.toContain("secrets");
    expect(names).not.toContain("logs");
    expect(names).not.toContain("desktop-profile");

    const sqlite = SqlitePersistenceMemory.pipe(Layer.provide(NodeServices.layer));
    const config = ServerConfig.ServerConfig.layerTest(repoDir, baseDir).pipe(
      Layer.provide(NodeServices.layer),
    );
    const layer = GoogleDriveBackupServiceLive.pipe(
      Layer.provideMerge(sqlite),
      Layer.provideMerge(config),
      Layer.provideMerge(makeMemorySecretStoreLayer()),
    );

    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* GoogleDriveBackupService;
        const initState = yield* svc.getState({});

        const memTarget = initState.targets.find((t) => t.id === "userdata:memory-v2")!;
        const wdTarget = initState.targets.find(
          (t) => t.id === "userdata:watchdog-journal.sqlite",
        )!;
        expect(memTarget.enabled).toBe(false);
        expect(wdTarget.enabled).toBe(false);

        yield* svc.updateConfig({
          transportMode: "local_drive_folder",
          localDriveRoot: driveRoot,
          encryptionEnabled: true,
          encryptionPassphrase: "Stage4Passphrase!2026",
          passphraseBackupAcknowledged: true,
          includeCoreSettings: false,
          includeCoreSqliteSnapshot: false,
          includeEventArchives: true,
        });

        // Enable memory-v2 & watchdog-journal.sqlite
        yield* svc.upsertTarget({
          id: memTarget.id,
          kind: "userdata",
          displayName: memTarget.displayName,
          rootPath: memTarget.rootPath,
          enabled: true,
          syncFiles: true,
          syncT3Scope: false,
          syncDriveToLocalRag: false,
        });
        yield* svc.upsertTarget({
          id: wdTarget.id,
          kind: "userdata",
          displayName: wdTarget.displayName,
          rootPath: wdTarget.rootPath,
          enabled: true,
          syncFiles: true,
          syncT3Scope: false,
          syncDriveToLocalRag: false,
        });

        // Dry-run shows both userdata targets
        const dry = yield* svc.dryRun({});
        expect(dry.selectedTargetsCount).toBe(2);

        // Run #1: full memory-v2 (2 files + manifest) + watchdog-journal snapshot + events-202611.sqlite
        const run1 = yield* svc.runNow({});
        expect(run1.status).toBe("succeeded");

        // Run #2: modify only m2.md in memory-v2 (no new event archive) -> incremental uploads ONLY m2.md!
        NodeFs.writeFileSync(NodePath.join(stateDir, "memory-v2", "m2.md"), "memory two UPDATED\n");
        const run2 = yield* svc.runNow({ targetIds: [memTarget.id] });
        expect(run2.status).toBe("succeeded");
        // m2.md + manifest.json = 2 entries (m1.md was NOT re-uploaded!)
        expect(run2.fileCount).toBe(2);

        // Run #3: unchanged memory-v2 -> 0 files uploaded!
        const run3 = yield* svc.runNow({ targetIds: [memTarget.id] });
        expect(run3.status).toBe("succeeded");
        expect(run3.fileCount).toBe(0);

        // Run #4: add new monthly event archive events-202612.sqlite -> uploads only the new one
        const ev2Path = NodePath.join(archivesDir, "events-202612.sqlite");
        const ev2Db = new DatabaseSync(ev2Path);
        ev2Db.exec(
          "CREATE TABLE archived_orchestration_events (id INTEGER PRIMARY KEY, payload TEXT); INSERT INTO archived_orchestration_events (payload) VALUES ('dec-event');",
        );
        ev2Db.close();
        const run4 = yield* svc.runNow({ targetIds: [memTarget.id] });
        expect(run4.status).toBe("succeeded");
        // Only events-202612.sqlite (1 file) since memory-v2 is unchanged & events-202611.sqlite already backed up!
        expect(run4.fileCount).toBe(1);

        return { run1, run2, run4 };
      }).pipe(Effect.provide(layer)),
    );

    // Verify incremental Run #2 archive contains m2.md but NOT m1.md
    const unpackedInc = await verifyAndExtractArchiveFile({
      archivePath: outcome.run2.destinationPath!,
      passphrase: "Stage4Passphrase!2026",
    });
    const incPaths = unpackedInc.manifest.entries.map((e) => e.path);
    expect(incPaths.some((p) => p.endsWith("m2.md"))).toBe(true);
    expect(incPaths.some((p) => p.endsWith("m1.md"))).toBe(false);

    // Verify standalone CLI restores event-archive SQLite and passes PRAGMA quick_check === "ok"
    const cliPath = NodePath.resolve(process.cwd(), "../../scripts/t3-backup-restore.mjs");
    const cliOutDir = mkTempDir("t3-cli-restore-");
    const { stdout } = await execFileAsync(
      process.execPath,
      [
        cliPath,
        "restore",
        outcome.run4.destinationPath!,
        "--out",
        cliOutDir,
        "--passphrase",
        "Stage4Passphrase!2026",
      ],
      { windowsHide: true },
    );
    const cliJson = JSON.parse(stdout) as {
      ok: boolean;
      format: string;
      encryptionFormat: string;
      manifestSha256: string;
      sqliteQuickChecks: Array<{ file: string; quickCheck: string }>;
    };
    expect(cliJson.ok).toBe(true);
    expect(cliJson.format).toBe("T3ARC2");
    expect(cliJson.encryptionFormat).toBe("T3ENC2");
    expect(cliJson.manifestSha256).toBe(outcome.run4.manifestSha256);
    expect(cliJson.sqliteQuickChecks).toHaveLength(1);
    expect(cliJson.sqliteQuickChecks[0]?.quickCheck).toBe("ok");

    // Also verify standalone CLI restores legacy T3ARC1 + T3ENC1 archive
    const legacyDir = mkTempDir("t3-cli-legacy-");
    const legacyArc = packEntriesToArchive({
      targetId: "legacy-cli",
      targetDisplayName: "LegacyCLI",
      entries: [{ archivePath: "a/hello.txt", content: Buffer.from("legacy-ok", "utf8") }],
      createdAtIso: "2026-11-27T00:00:00.000Z",
      encryptionPassphrase: "LegacyCliPass!1",
    });
    const legacyFile = NodePath.join(legacyDir, "legacy.t3enc");
    NodeFs.writeFileSync(legacyFile, legacyArc.buffer);
    const legacyOut = NodePath.join(legacyDir, "out");
    const { stdout: legacyStdout } = await execFileAsync(
      process.execPath,
      [cliPath, "restore", legacyFile, "--out", legacyOut, "--passphrase", "LegacyCliPass!1"],
      { windowsHide: true },
    );
    const legacyParsed = JSON.parse(legacyStdout) as { ok: boolean; format: string };
    expect(legacyParsed.ok).toBe(true);
    expect(legacyParsed.format).toBe("T3ARC1");
    expect(NodeFs.readFileSync(NodePath.join(legacyOut, "a", "hello.txt"), "utf8")).toBe(
      "legacy-ok",
    );
  });
});
