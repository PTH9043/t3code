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
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  discoverUserdataCandidates,
  isUserdataHardExcluded,
  UNIFIED_USERDATA_TARGET_ID,
} from "./DriveBackupFilter.ts";
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
        const sql = yield* SqlClient.SqlClient;
        const svc = yield* GoogleDriveBackupService;

        // 레거시 10개 userdata:* 행이 DB에 이미 존재하더라도 getState()에서 단일 userdata:all 1개로 통합·정리됨 검증
        const now = Date.now();
        yield* sql`
          INSERT INTO drive_backup_targets (
            id, kind, project_id, display_name, root_path,
            enabled, sync_files, sync_t3_scope, sync_drive_to_local_rag,
            sync_local_to_drive_knowledge, exclude_globs_json, last_backed_up_at_ms, updated_at_ms
          ) VALUES
            ('userdata:memory-v2', 'userdata', NULL, 'legacy mem', ${NodePath.join(stateDir, "memory-v2")}, 0, 1, 0, 0, 0, '[]', NULL, ${now}),
            ('userdata:attachments', 'userdata', NULL, 'legacy att', ${NodePath.join(stateDir, "attachments")}, 0, 1, 0, 0, 0, '[]', NULL, ${now})
        `;

        const initState = yield* svc.getState({});
        const userdataTargets = initState.targets.filter((t) => t.kind === "userdata");
        expect(userdataTargets).toHaveLength(1);
        const unifiedTarget = userdataTargets[0]!;
        expect(unifiedTarget.id).toBe(UNIFIED_USERDATA_TARGET_ID);
        expect(unifiedTarget.enabled).toBe(false);

        yield* svc.updateConfig({
          transportMode: "local_drive_folder",
          localDriveRoot: driveRoot,
          encryptionEnabled: true,
          encryptionPassphrase: "Stage4Passphrase!2026",
          passphraseBackupAcknowledged: true,
          includeCoreSettings: false,
          includeCoreSqliteSnapshot: false,
          includeEventArchives: false,
        });

        // 통합 userdata:all 1개만 ON -> memory-v2 + watchdog-journal.sqlite + events-202611.sqlite 전부 자동 포함!
        yield* svc.upsertTarget({
          id: unifiedTarget.id,
          kind: "userdata",
          displayName: unifiedTarget.displayName,
          rootPath: unifiedTarget.rootPath,
          enabled: true,
          syncFiles: true,
          syncT3Scope: false,
          syncDriveToLocalRag: false,
        });

        // Dry-run shows single unified userdata target with all subfiles + snapshots counted
        const dry = yield* svc.dryRun({});
        expect(dry.selectedTargetsCount).toBe(1);
        expect(dry.targets[0]?.targetId).toBe(UNIFIED_USERDATA_TARGET_ID);
        expect(dry.totalFilesCount).toBeGreaterThanOrEqual(4); // m1, m2, watchdog-journal, events-202611

        // Run #1: full unified userdata (m1, m2, watchdog-journal snapshot + manifest) + events-202611.sqlite
        const run1 = yield* svc.runNow({});
        expect(run1.status).toBe("succeeded");

        // Run #2: modify only m2.md in memory-v2 (watchdog & events unchanged) -> incremental uploads ONLY m2.md!
        NodeFs.writeFileSync(NodePath.join(stateDir, "memory-v2", "m2.md"), "memory two UPDATED\n");
        const run2 = yield* svc.runNow({ targetIds: [unifiedTarget.id] });
        expect(run2.status).toBe("succeeded");
        // m2.md + manifest.json = 2 entries (m1.md was NOT re-uploaded!)
        expect(run2.fileCount).toBe(2);

        // Run #3: unchanged unified userdata -> 0 files uploaded!
        const run3 = yield* svc.runNow({ targetIds: [unifiedTarget.id] });
        expect(run3.status).toBe("succeeded");
        expect(run3.fileCount).toBe(0);

        // Run #4: add new monthly event archive events-202612.sqlite -> uploads only the new one
        const ev2Path = NodePath.join(archivesDir, "events-202612.sqlite");
        const ev2Db = new DatabaseSync(ev2Path);
        ev2Db.exec(
          "CREATE TABLE archived_orchestration_events (id INTEGER PRIMARY KEY, payload TEXT); INSERT INTO archived_orchestration_events (payload) VALUES ('dec-event');",
        );
        ev2Db.close();
        const run4 = yield* svc.runNow({ targetIds: [unifiedTarget.id] });
        expect(run4.status).toBe("succeeded");
        // Only events-202612.sqlite (1 file) since memory-v2 & watchdog-journal are unchanged & events-202611.sqlite already backed up!
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

  it("uploads external drive knowledge folders to T3-Knowledge incrementally while blocking secrets and sqlite files", async () => {
    const baseDir = mkTempDir("t3-s4-know-base-");
    const driveRoot = mkTempDir("t3-s4-know-drive-");
    const repoDir = mkTempDir("t3-s4-know-repo-");
    const extKnowledgeDir = mkTempDir("t3-s4-ext-knowledge-");

    NodeFs.mkdirSync(NodePath.join(extKnowledgeDir, "트레이딩"), { recursive: true });
    NodeFs.writeFileSync(
      NodePath.join(extKnowledgeDir, "트레이딩", "전략노트.md"),
      "# 외부 드라이브 전략\n",
    );
    NodeFs.writeFileSync(NodePath.join(extKnowledgeDir, "개요.txt"), "외부 지식 개요\n");
    // 민감 파일 + sqlite 파일은 원본 지식 업로드에서 반드시 차단
    NodeFs.writeFileSync(NodePath.join(extKnowledgeDir, ".env"), "SECRET=blocked");
    NodeFs.writeFileSync(NodePath.join(extKnowledgeDir, "forbidden.sqlite"), "sqlite-raw");

    const sqlite = SqlitePersistenceMemory.pipe(Layer.provide(NodeServices.layer));
    const config = ServerConfig.ServerConfig.layerTest(repoDir, baseDir).pipe(
      Layer.provide(NodeServices.layer),
    );
    const layer = GoogleDriveBackupServiceLive.pipe(
      Layer.provideMerge(sqlite),
      Layer.provideMerge(config),
      Layer.provideMerge(makeMemorySecretStoreLayer()),
    );

    const res = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* GoogleDriveBackupService;
        yield* svc.updateConfig({
          transportMode: "local_drive_folder",
          localDriveRoot: driveRoot,
          gdriveFolderName: "T3-Backup",
          gdriveKnowledgeFolderName: "T3-Knowledge",
          encryptionEnabled: true,
          encryptionPassphrase: "KnowPassphrase!2026",
          passphraseBackupAcknowledged: true,
          includeCoreSettings: false,
          includeCoreSqliteSnapshot: false,
          includeEventArchives: false,
        });

        const added = yield* svc.upsertTarget({
          kind: "knowledge",
          displayName: "F드라이브 지식",
          rootPath: extKnowledgeDir,
          enabled: true,
          syncFiles: true,
          syncT3Scope: false,
          syncDriveToLocalRag: false,
          syncLocalToDriveKnowledge: true,
        });
        expect(added.kind).toBe("knowledge");
        expect(added.syncLocalToDriveKnowledge).toBe(true);

        const dry = yield* svc.dryRun({});
        expect(dry.selectedTargetsCount).toBe(1);
        expect(dry.targets[0]?.warnings.some((w) => w.includes("T3-Knowledge"))).toBe(true);

        // 1차 백업: T3-Backup 암호화 아카이브 + T3-Knowledge 원본 파일 2건 모두 생성
        const run1 = yield* svc.runNow({});
        expect(run1.status).toBe("succeeded");

        // 2차 지식 양방향 동기화: 변경 없음 -> 업로드 0건, 미변경 생략 2건
        const mirror1 = yield* svc.syncKnowledgeMirror({});
        expect(mirror1.uploadedCount).toBe(0);
        expect(mirror1.uploadedSkippedUnchangedCount).toBe(2);

        // 파일 1건 수정 후 지식 양방향 동기화 -> 수정된 1건만 증분 업로드
        NodeFs.writeFileSync(NodePath.join(extKnowledgeDir, "개요.txt"), "외부 지식 개요 v2\n");
        const mirror2 = yield* svc.syncKnowledgeMirror({});
        expect(mirror2.uploadedCount).toBe(1);
        expect(mirror2.uploadedSkippedUnchangedCount).toBe(1);

        return { mirror1, mirror2 };
      }).pipe(Effect.provide(layer)),
    );

    expect(res.mirror2.uploadedCount).toBe(1);
    const uploadedRoot = NodePath.join(driveRoot, "T3-Knowledge", "F드라이브 지식");
    expect(
      NodeFs.readFileSync(NodePath.join(uploadedRoot, "트레이딩", "전략노트.md"), "utf8"),
    ).toBe("# 외부 드라이브 전략\n");
    expect(NodeFs.readFileSync(NodePath.join(uploadedRoot, "개요.txt"), "utf8")).toBe(
      "외부 지식 개요 v2\n",
    );
    expect(NodeFs.existsSync(NodePath.join(uploadedRoot, ".env"))).toBe(false);
    expect(NodeFs.existsSync(NodePath.join(uploadedRoot, "forbidden.sqlite"))).toBe(false);
  });
});
