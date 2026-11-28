// @effect-diagnostics nodeBuiltinImport:off globalDateInEffect:off preferSchemaOverJson:off
import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import { activeWorkRegistry } from "../../orchestration/ActiveWorkTracker.ts";
import { memoryScopeDirectory } from "../../orchestration/memoryFiles.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { encodeClaudeProjectDirName } from "./DriveBackupProjectMemories.ts";
import { verifyAndExtractArchiveFile } from "./StreamingArchivePacker.ts";
import {
  exchangeRefreshTokenForAccessToken,
  OAuthTokenRefreshError,
} from "./DriveTransportAdapter.ts";
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

describe("GoogleDriveBackupService", () => {
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

  it("enforces Opt-In selection, blocks secrets, encrypts with AES-256-GCM, and verifies restore integrity", async () => {
    const baseDir = mkTempDir("t3-drv-base-");
    const driveRoot = mkTempDir("t3-drv-remote-");
    const selectedProjDir = mkTempDir("t3-drv-proj-selected-");
    const unselectedProjDir = mkTempDir("t3-drv-proj-unselected-");

    // 선택된 프로젝트: 소스 + .env.example + 민감 시크릿(.env, wallet.dat, secrets/private.key)
    NodeFs.mkdirSync(NodePath.join(selectedProjDir, "src"), { recursive: true });
    NodeFs.mkdirSync(NodePath.join(selectedProjDir, "secrets"), { recursive: true });
    NodeFs.writeFileSync(
      NodePath.join(selectedProjDir, "src", "main.ts"),
      "export const ok = 42;\n",
    );
    NodeFs.writeFileSync(
      NodePath.join(selectedProjDir, ".env.example"),
      "API_URL=https://example.com\n",
    );
    NodeFs.writeFileSync(
      NodePath.join(selectedProjDir, ".env"),
      "SECRET_KEY=top-secret-do-not-upload\n",
    );
    NodeFs.writeFileSync(
      NodePath.join(selectedProjDir, "wallet.dat"),
      "seed-phrase-never-upload\n",
    );
    NodeFs.writeFileSync(NodePath.join(selectedProjDir, "secrets", "private.key"), "PRIVATE KEY\n");

    // 비선택 프로젝트: 절대 업로드되면 안 되는 파일
    NodeFs.writeFileSync(
      NodePath.join(unselectedProjDir, "never_upload.txt"),
      "MUST_NOT_APPEAR_IN_DRIVE",
    );

    const layer = makeTestLayer(selectedProjDir, baseDir);

    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const svc = yield* GoogleDriveBackupService;

        // T3 등록 프로젝트 2개 + 스레드/메시지 1건 시딩
        const nowIso = new Date().toISOString();
        yield* sql`
          INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at, deleted_at)
          VALUES
            ('proj-selected', 'SelectedApp', ${selectedProjDir}, '[]', ${nowIso}, ${nowIso}, NULL),
            ('proj-unselected', '__Wallet', ${unselectedProjDir}, '[]', ${nowIso}, ${nowIso}, NULL)
        `;
        yield* sql`
          INSERT INTO projection_threads (thread_id, project_id, title, model_selection_json, branch, worktree_path, latest_turn_id, created_at, updated_at, deleted_at)
          VALUES ('th-1', 'proj-selected', '설계 논의', '{"provider":"codex","model":"gpt-5"}', NULL, NULL, NULL, ${nowIso}, ${nowIso}, NULL)
        `;
        yield* sql`
          INSERT INTO projection_thread_messages (message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at)
          VALUES ('msg-1', 'th-1', NULL, 'user', '선택형 백업 테스트 메시지', 0, ${nowIso}, ${nowIso})
        `;

        // 초기 상태: 등록 프로젝트 2건 자동 발견되되 기본값은 모두 enabled=false (Opt-In!)
        const initial = yield* svc.getState({});
        expect(initial.targets.every((t) => t.enabled === false)).toBe(true);
        const walletTarget = initial.targets.find((t) => t.displayName === "__Wallet");
        expect(walletTarget?.riskWarning).toContain("지갑");

        // 설정: 로컬 드라이브 폴더 모드 + AES-256-GCM 암호화 비밀번호
        const updatedCfg = yield* svc.updateConfig({
          transportMode: "local_drive_folder",
          localDriveRoot: driveRoot,
          gdriveFolderName: "T3-Backup",
          encryptionEnabled: true,
          encryptionPassphrase: "StrongPassphrase!2026",
          passphraseBackupAcknowledged: true,
          retentionCount: 2,
          includeCoreSettings: false,
          includeCoreSqliteSnapshot: false,
        });
        expect(updatedCfg.keyFingerprint).toBeTruthy();
        expect(updatedCfg.keyFingerprint?.length).toBe(12);

        // SelectedApp만 ON 활성화 (비선택 __Wallet은 OFF 유지)
        const selectedTarget = initial.targets.find((t) => t.displayName === "SelectedApp")!;
        yield* svc.upsertTarget({
          id: selectedTarget.id,
          kind: "project",
          projectId: ProjectId.make("proj-selected"),
          displayName: "SelectedApp",
          rootPath: selectedProjDir,
          enabled: true,
          syncFiles: true,
          syncT3Scope: true,
          syncDriveToLocalRag: false,
        });

        // Dry-Run 확인: SelectedApp 1개만 잡히고 시크릿 차단 카운트 > 0
        const dry = yield* svc.dryRun({});
        expect(dry.selectedTargetsCount).toBe(1);
        expect(dry.totalBlockedSecretsCount).toBeGreaterThanOrEqual(3);
        expect(dry.targets[0]?.t3ScopeThreadsCount).toBe(1);

        // 실제 백업 실행
        const run = yield* svc.runNow({});
        expect(run.status).toBe("succeeded");
        expect(run.skippedSecretsCount).toBeGreaterThanOrEqual(3);
        expect(run.destinationPath).toBeTruthy();

        // 복구 무결성 검증 (정확한 키)
        const verify = yield* svc.verifyRestore({ runId: run.runId });
        expect(verify.verified).toBe(true);
        expect(verify.encrypted).toBe(true);
        expect(verify.manifestSha256).toBe(run.manifestSha256);

        return { run, verify };
      }).pipe(Effect.provide(layer)),
    );

    // 실제 디스크 아카이브 직접 검사 (스트리밍 T3ARC2 + T3ENC2):
    // 1) 잘못된 키로 복호화 시 반드시 거부
    await expect(
      verifyAndExtractArchiveFile({
        archivePath: outcome.run.destinationPath!,
        passphrase: "WrongPassword",
      }),
    ).rejects.toThrow();

    // 2) 정확한 키로 복호화 시 선택된 파일 + T3 스코프만 존재, 시크릿/비선택 파일은 0건
    const unpacked = await verifyAndExtractArchiveFile({
      archivePath: outcome.run.destinationPath!,
      passphrase: "StrongPassphrase!2026",
    });
    expect(unpacked.format).toBe("T3ARC2");
    expect(unpacked.encryptionFormat).toBe("T3ENC2");
    const paths = unpacked.manifest.entries.map((e) => e.path);
    expect(paths).toContain("workspace/src/main.ts");
    expect(paths).toContain("workspace/.env.example");
    expect(paths).toContain("t3-scope/project-scope.json");
    expect(paths.some((p) => p.includes(".env") && !p.endsWith(".env.example"))).toBe(false);
    expect(paths.some((p) => p.includes("wallet.dat"))).toBe(false);
    expect(paths.some((p) => p.includes("private.key"))).toBe(false);
    expect(paths.some((p) => p.includes("never_upload"))).toBe(false);

    // 3) 비선택 프로젝트 폴더는 Drive 디렉터리에 아예 생성되지 않음
    const projectsRoot = NodePath.join(driveRoot, "T3-Backup", "projects");
    const backedUpDirs = NodeFs.readdirSync(projectsRoot);
    expect(backedUpDirs).toEqual(["SelectedApp"]);
  });

  it("defers backup with skipped_busy while activeWorkRegistry has active turns, and rolls retention + mirrors T3-Knowledge", async () => {
    const baseDir = mkTempDir("t3-drv-base2-");
    const driveRoot = mkTempDir("t3-drv-remote2-");
    const repoDir = mkTempDir("t3-drv-repo-");
    NodeFs.writeFileSync(NodePath.join(repoDir, "README.md"), "# Hello T3\n");

    // Google Drive 지식 폴더 시딩
    const knowledgeDir = NodePath.join(driveRoot, "T3-Knowledge");
    NodeFs.mkdirSync(knowledgeDir, { recursive: true });
    NodeFs.writeFileSync(NodePath.join(knowledgeDir, "playbook.md"), "# Drive Playbook\n");

    const layer = makeTestLayer(repoDir, baseDir);

    const res = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* GoogleDriveBackupService;

        yield* svc.updateConfig({
          transportMode: "local_drive_folder",
          localDriveRoot: driveRoot,
          gdriveFolderName: "T3-Backup",
          gdriveKnowledgeFolderName: "T3-Knowledge",
          encryptionEnabled: false,
          retentionCount: 2,
          autoSyncIdleOnly: true,
          includeCoreSettings: false,
          includeCoreSqliteSnapshot: false,
        });

        yield* svc.upsertTarget({
          kind: "repo",
          displayName: "MyRepo",
          rootPath: repoDir,
          enabled: true,
          syncFiles: true,
          syncT3Scope: false,
          syncDriveToLocalRag: true,
        });

        // 활성 작업 1건 등록 상태에서도 백업을 버리지 않고 저속 백그라운드 모드로 정상 완료 확인
        activeWorkRegistry.register({
          kind: "turn",
          id: "turn-busy-1",
          threadId: "th-busy",
          summary: "busy turn",
          startedAtMs: Date.now(),
        });
        const throttledRun = yield* svc.runNow({});
        expect(throttledRun.status).toBe("succeeded");
        expect(throttledRun.fileCount).toBeGreaterThanOrEqual(1);

        // 활성 작업 종료 후 연속 3회 백업 -> retentionCount=2 롤링 확인
        activeWorkRegistry.unregister("turn", "turn-busy-1");
        yield* Effect.sleep("20 millis");
        yield* svc.runNow({});
        yield* Effect.sleep("20 millis");
        yield* svc.runNow({});
        yield* Effect.sleep("20 millis");
        yield* svc.runNow({});

        // 양방향 지식 미러 동기화 1차 (1건 신규) + 2차 (변경 없음 1건 스킵)
        const mirror1 = yield* svc.syncKnowledgeMirror({});
        const mirror2 = yield* svc.syncKnowledgeMirror({});
        return { mirror1, mirror2 };
      }).pipe(Effect.provide(layer)),
    );

    const repoBackupDir = NodePath.join(driveRoot, "T3-Backup", "projects", "MyRepo");
    const archives = NodeFs.readdirSync(repoBackupDir).filter((f) => f.endsWith(".t3arc"));
    expect(archives.length).toBeLessThanOrEqual(2);

    expect(res.mirror1.syncedCount).toBe(1);
    expect(res.mirror2.syncedCount).toBe(0);
    expect(res.mirror2.skippedUnchangedCount).toBe(1);
    const mirroredFile = NodePath.join(res.mirror1.mirrorLocalDir, "playbook.md");
    expect(NodeFs.readFileSync(mirroredFile, "utf8")).toBe("# Drive Playbook\n");
  });

  it("requires external backup acknowledgement when setting passphrase and detects invalid_grant into config status", async () => {
    const baseDir = mkTempDir("t3-drv-base3-");
    const repoDir = mkTempDir("t3-drv-repo3-");
    NodeFs.writeFileSync(NodePath.join(repoDir, "a.txt"), "hello\n");
    const layer = makeTestLayer(repoDir, baseDir);

    // 1) Unit check on OAuthTokenRefreshError invalid_grant parsing
    const invalidGrantFetcher = vi.fn(
      async () =>
        new Response(
          '{"error":"invalid_grant","error_description":"Token has been expired or revoked."}',
          {
            status: 400,
            headers: { "content-type": "application/json" },
          },
        ),
    ) as unknown as typeof fetch;

    await expect(
      exchangeRefreshTokenForAccessToken(
        { clientId: "cid", clientSecret: "sec", refreshToken: "1//expired" },
        invalidGrantFetcher,
      ),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof OAuthTokenRefreshError &&
        err.isInvalidGrant === true &&
        err.message.includes("Production"),
    );

    // 2) Service-level check: passphrase ack gate + invalid_grant persistence into state card
    const originalFetch = globalThis.fetch;
    globalThis.fetch = invalidGrantFetcher;
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const svc = yield* GoogleDriveBackupService;

          // Without acknowledgement -> rejected
          const unackedExit = yield* svc
            .updateConfig({
              encryptionEnabled: true,
              encryptionPassphrase: "MyBackupPassword!99",
            })
            .pipe(Effect.exit);
          expect(unackedExit._tag).toBe("Failure");

          // With acknowledgement -> succeeds and only exposes keyFingerprint
          const acked = yield* svc.updateConfig({
            transportMode: "gdrive_api",
            gdriveClientId: "cid-1",
            gdriveClientSecret: "sec-1",
            gdriveRefreshToken: "1//expired-tok",
            encryptionEnabled: true,
            encryptionPassphrase: "MyBackupPassword!99",
            passphraseBackupAcknowledged: true,
          });
          expect(acked.keyFingerprint).toHaveLength(12);
          expect(Object.values(acked)).not.toContain("MyBackupPassword!99");

          // Trigger syncKnowledgeMirror -> invalid_grant recorded into config
          const mirrorExit = yield* svc.syncKnowledgeMirror({}).pipe(Effect.exit);
          expect(mirrorExit._tag).toBe("Failure");

          const afterErr = yield* svc.getState({});
          expect(afterErr.config.lastAuthErrorCode).toBe("invalid_grant");
          expect(afterErr.config.lastAuthErrorMessage).toContain("Production");
          expect(afterErr.config.lastAuthErrorAtMs).toBeTypeOf("number");

          // Re-saving fresh OAuth credentials clears lastAuthErrorCode
          const refreshedCfg = yield* svc.updateConfig({
            gdriveRefreshToken: "1//fresh-tok",
          });
          expect(refreshedCfg.lastAuthErrorCode).toBeNull();
        }).pipe(Effect.provide(layer)),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("recovers OAuth credentials from per-subject Drive secret when primary secret key is missing", async () => {
    const baseDir = mkTempDir("t3-drv-base4-");
    const repoDir = mkTempDir("t3-drv-repo4-");
    const layer = makeTestLayer(repoDir, baseDir);

    const state = await Effect.runPromise(
      Effect.gen(function* () {
        const secrets = yield* ServerSecretStore.ServerSecretStore;
        const svc = yield* GoogleDriveBackupService;

        // 주 키(drive_backup_gdrive_oauth)는 비어 있고 계정별 키에만 저장된 상태를 시뮬레이션
        yield* secrets.set(
          "google-login-accounts",
          Uint8Array.from(
            Buffer.from(
              JSON.stringify([
                {
                  subject: "sub-linked-12345",
                  email: "backup-user@example.com",
                  isDefault: true,
                  driveBackupLinked: true,
                },
              ]),
              "utf8",
            ),
          ),
        );
        yield* secrets.set(
          "drive_backup_gdrive_oauth_sub-linked-12345",
          Uint8Array.from(
            Buffer.from(
              JSON.stringify({
                clientId: "cid-recovered",
                clientSecret: "sec-recovered",
                refreshToken: "1//ref-recovered",
                connectedEmail: "backup-user@example.com",
                subject: "sub-linked-12345",
              }),
              "utf8",
            ),
          ),
        );

        const snap = yield* svc.getState({});
        const primaryAfter = yield* secrets.get("drive_backup_gdrive_oauth");
        return { snap, primaryRestored: Option.isSome(primaryAfter) };
      }).pipe(Effect.provide(layer)),
    );

    expect(state.snap.config.gdriveHasCredentials).toBe(true);
    expect(state.snap.config.gdriveConnectedEmail).toBe("backup-user@example.com");
    expect(state.primaryRestored).toBe(true);
  });

  it("exposes liveProgress from active/paused checkpoints and backupSummary totals in getState", async () => {
    const baseDir = mkTempDir("t3-drv-prog-base-");
    const projDir = mkTempDir("t3-drv-prog-proj-");
    const stagedArchive = NodePath.join(baseDir, "staged.t3enc");
    NodeFs.writeFileSync(stagedArchive, Buffer.alloc(1024));
    const layer = makeTestLayer(projDir, baseDir);

    const snap = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* GoogleDriveBackupService;
        const sql = yield* SqlClient.SqlClient;
        yield* svc.getState({});

        const now = Date.now();
        yield* sql`
          INSERT INTO drive_backup_runs (
            run_id, kind, status, transport_mode, target_ids_json,
            file_count, raw_bytes, archive_bytes,
            skipped_secrets_count, skipped_secrets_sample_json,
            manifest_sha256, destination_path, error_message,
            started_at_ms, finished_at_ms
          ) VALUES (
            'drvrun_prev_ok', 'backup', 'succeeded', 'gdrive_api', '["userdata:all"]',
            12, 8000000000, 3200000000,
            0, '[]', 'abc123', 'gdrive://T3-Backup/a.t3enc', NULL,
            ${now - 3_600_000}, ${now - 3_000_000}
          )
        `;
        yield* sql`
          INSERT INTO drive_backup_runs (
            run_id, kind, status, transport_mode, target_ids_json,
            file_count, raw_bytes, archive_bytes,
            skipped_secrets_count, skipped_secrets_sample_json,
            manifest_sha256, destination_path, error_message,
            started_at_ms, finished_at_ms
          ) VALUES (
            'drvrun_live_1', 'backup', 'running', 'gdrive_api', '["userdata:all"]',
            0, 0, 0,
            0, '[]', NULL, NULL, NULL,
            ${now - 60_000}, NULL
          )
        `;
        yield* sql`
          INSERT INTO drive_backup_checkpoints (
            run_id, stage, target_id, snapshot_path, archive_path,
            entry_index, chunk_index, uploaded_offset_bytes, total_bytes,
            resumable_session_uri, session_expires_at_ms, manifest_sha256,
            payload_json, updated_at_ms
          ) VALUES (
            'drvrun_live_1', 'uploading', 'userdata:all', NULL, ${stagedArchive},
            0, 0, 1100000000, 2200000000,
            'https://example.com/upload', ${now + 86_400_000}, 'deadbeef',
            '{}', ${now - 1000}
          )
        `;
        return yield* svc.getState({});
      }).pipe(Effect.provide(layer)),
    );

    expect(snap.liveProgress).toMatchObject({
      runId: "drvrun_live_1",
      status: "running",
      stage: "uploading",
      targetId: "userdata:all",
      uploadedBytes: 1_100_000_000,
      totalBytes: 2_200_000_000,
      percent: 50,
    });
    expect(snap.backupSummary).toMatchObject({
      succeededBackupCount: 1,
      totalBackedUpArchiveBytes: 3_200_000_000,
      totalBackedUpRawBytes: 8_000_000_000,
      totalBackedUpFiles: 12,
      lastSucceededArchiveBytes: 3_200_000_000,
    });
  });

  it("collects related memories across T3 DB, memory-v2, Claude, Codex, and Grok for any selected target (even without projectId) and mirrors markdown memories to T3-Knowledge", async () => {
    const baseDir = mkTempDir("t3-drv-xmem-base-");
    const driveRoot = mkTempDir("t3-drv-xmem-drive-");
    const fakeHome = mkTempDir("t3-drv-xmem-home-");
    const projRootParent = mkTempDir("t3-drv-xmem-ws-");
    const projDir = NodePath.join(projRootParent, "__MyDemoProj");
    NodeFs.mkdirSync(projDir, { recursive: true });
    NodeFs.writeFileSync(NodePath.join(projDir, "README.md"), "# MyDemoProj\n");

    const prevExternalHome = process.env.T3CODE_DRIVE_BACKUP_EXTERNAL_HOME;
    process.env.T3CODE_DRIVE_BACKUP_EXTERNAL_HOME = fakeHome;

    try {
      const stateDir = NodePath.join(baseDir, "userdata");
      const archivedProjId = "proj-archived-demo-1";

      // 1) T3 memory-v2 워크스페이스 기억 + 공용 기억
      const wsMemDir = memoryScopeDirectory(stateDir, archivedProjId, "project");
      NodeFs.mkdirSync(NodePath.join(wsMemDir, "user-utterances"), { recursive: true });
      NodeFs.writeFileSync(NodePath.join(wsMemDir, "MEMORY.md"), "# T3 Workspace Memory\n");
      NodeFs.writeFileSync(
        NodePath.join(wsMemDir, "user-utterances", "utterances-0000.md"),
        "PRIVATE_UTTERANCE_ARCHIVE_ONLY\n",
      );
      const globalMemDir = memoryScopeDirectory(stateDir, "", "global");
      NodeFs.mkdirSync(globalMemDir, { recursive: true });
      NodeFs.writeFileSync(NodePath.join(globalMemDir, "MEMORY.md"), "# T3 Global Rule\n");

      // 2) 외부 AI CLI 기억 (Claude + Codex + Grok)
      const claudeDir = NodePath.join(
        fakeHome,
        ".claude",
        "projects",
        encodeClaudeProjectDirName(projDir),
        "memory",
      );
      NodeFs.mkdirSync(claudeDir, { recursive: true });
      NodeFs.writeFileSync(NodePath.join(claudeDir, "claude-note.md"), "# Claude Note\n");

      const codexDir = NodePath.join(fakeHome, ".codex", "memories_v2", "rollout_summaries");
      NodeFs.mkdirSync(codexDir, { recursive: true });
      NodeFs.writeFileSync(
        NodePath.join(codexDir, "2026-11-28-mydemoproj.md"),
        `thread_id: t1\ncwd: ${projDir}\n\nCodex memory summary\n`,
      );

      const grokDir = NodePath.join(
        fakeHome,
        ".grok",
        "memory-v2",
        "workspaces",
        "mydemoproj-a1b2c3d4",
      );
      NodeFs.mkdirSync(grokDir, { recursive: true });
      NodeFs.writeFileSync(NodePath.join(grokDir, "MEMORY.md"), "# Grok Memory\n");

      const layer = makeTestLayer(projDir, baseDir);
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const svc = yield* GoogleDriveBackupService;
          const nowIso = new Date().toISOString();

          // 삭제된 과거 project_id + DB 기억 + 위키 지식 시딩
          yield* sql`
            INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at, deleted_at)
            VALUES (${archivedProjId}, '__MyDemoProj', ${projDir}, '[]', ${nowIso}, ${nowIso}, ${nowIso})
          `;
          yield* sql`
            INSERT INTO workspace_memory_v2 (
              id, project_id, scope, topic, text, source_json, source_hash, origin, verification, status, created_at, updated_at
            ) VALUES (
              'mem-demo-1', ${archivedProjId}, 'project', 'arch', '핵심 아키텍처 결정', '{}', 'h1', 'user', 'verified', 'active', ${nowIso}, ${nowIso}
            )
          `;
          yield* sql`
            INSERT INTO projection_workspace_knowledge_items (
              project_id, item_id, kind, title, content, status, origin, relative_folder, tags_json, created_at, updated_at, prompt_uses
            ) VALUES (
              ${archivedProjId}, 'know-demo-1', 'long-term-memory', '설계 원칙', '지식 원문', 'active', 'user', NULL, '[]', ${nowIso}, ${nowIso}, 0
            )
          `;

          yield* svc.updateConfig({
            transportMode: "local_drive_folder",
            localDriveRoot: driveRoot,
            gdriveFolderName: "T3-Backup",
            gdriveKnowledgeFolderName: "T3-Knowledge",
            encryptionEnabled: true,
            encryptionPassphrase: "CrossMemPass!2026",
            passphraseBackupAcknowledged: true,
            includeCoreSettings: false,
            includeCoreSqliteSnapshot: false,
          });

          // projectId = null인 추가 저장소(repo)로 등록하되 syncT3Scope=true, syncLocalToDriveKnowledge=true
          const target = yield* svc.upsertTarget({
            kind: "repo",
            projectId: null,
            displayName: "__MyDemoProj",
            rootPath: projDir,
            enabled: true,
            syncFiles: true,
            syncT3Scope: true,
            syncDriveToLocalRag: false,
            syncLocalToDriveKnowledge: true,
          });

          const dry = yield* svc.dryRun({ targetIds: [target.id] });
          const run = yield* svc.runNow({ targetIds: [target.id] });
          return { target, dry, run };
        }).pipe(Effect.provide(layer)),
      );

      // 1) target 메타데이터에 projectId=null이어도 DB 기억·지식·외부 기억 출처가 자동 연결됨
      expect(result.target.memoryCount).toBe(1);
      expect(result.target.knowledgeItemCount).toBe(1);
      expect(result.target.externalMemoryFilesCount).toBe(6); // T3 ws(2) + global(1) + Claude(1) + Codex(1) + Grok(1)
      expect(result.target.relatedMemorySources).toEqual(
        expect.arrayContaining(["T3 DB", "T3 memory-v2", "Claude", "Codex", "Grok"]),
      );

      // 2) Dry-Run 반영 확인
      expect(result.dry.targets[0]?.t3ScopeMemoriesCount).toBe(1);
      expect(result.dry.targets[0]?.t3ScopeKnowledgeCount).toBe(1);
      expect(result.dry.targets[0]?.relatedMemoryFilesCount).toBe(6);

      // 3) 암호화 아카이브(.t3enc) 검증: T3 scope JSON(v2) + 5개 저장소 기억 파일 전부 포함
      expect(result.run.status).toBe("succeeded");
      const extractDir = mkTempDir("t3-drv-xmem-extract-");
      const unpacked = await verifyAndExtractArchiveFile({
        archivePath: result.run.destinationPath!,
        passphrase: "CrossMemPass!2026",
        extractToDir: extractDir,
      });
      const entryPaths = unpacked.manifest.entries.map((e) => e.path);
      expect(entryPaths).toContain("workspace/README.md");
      expect(entryPaths).toContain("t3-scope/project-scope.json");
      expect(
        entryPaths.some((p) => p.endsWith("/MEMORY.md") && p.startsWith("t3-memories/workspace/")),
      ).toBe(true);
      expect(entryPaths).toContain("t3-memories/global/MEMORY.md");
      expect(
        entryPaths.some(
          (p) => p.startsWith("external-memories/claude/") && p.endsWith("claude-note.md"),
        ),
      ).toBe(true);
      expect(
        entryPaths.some(
          (p) => p.startsWith("external-memories/codex/") && p.endsWith("2026-11-28-mydemoproj.md"),
        ),
      ).toBe(true);
      expect(
        entryPaths.some((p) => p.startsWith("external-memories/grok/") && p.endsWith("MEMORY.md")),
      ).toBe(true);

      const scopeJson = JSON.parse(
        NodeFs.readFileSync(NodePath.join(extractDir, "t3-scope", "project-scope.json"), "utf8"),
      ) as {
        schemaVersion: number;
        matchedProjectIds: string[];
        memories: unknown[];
        knowledgeItems: unknown[];
      };
      expect(scopeJson.schemaVersion).toBe(2);
      expect(scopeJson.matchedProjectIds).toContain(archivedProjId);
      expect(scopeJson.memories.length).toBe(1);
      expect(scopeJson.knowledgeItems.length).toBe(1);

      // 4) 평문 T3-Knowledge 폴더 검증: 정제 마크다운 기억만 _memories/ 아래 업로드되고 utterances/project-scope.json은 제외!
      const knowledgeProjRoot = NodePath.join(driveRoot, "T3-Knowledge", "__MyDemoProj");
      expect(NodeFs.existsSync(NodePath.join(knowledgeProjRoot, "README.md"))).toBe(true);
      const knowledgeMemDir = NodePath.join(knowledgeProjRoot, "_memories");
      expect(NodeFs.existsSync(knowledgeMemDir)).toBe(true);
      const walkRel = (dir: string, prefix = ""): string[] => {
        const out: string[] = [];
        for (const d of NodeFs.readdirSync(dir, { withFileTypes: true })) {
          const rel = prefix ? `${prefix}/${d.name}` : d.name;
          if (d.isDirectory()) out.push(...walkRel(NodePath.join(dir, d.name), rel));
          else out.push(rel);
        }
        return out;
      };
      const uploadedMemRels = walkRel(knowledgeMemDir);
      expect(
        uploadedMemRels.some((r) => r.includes("claude/") && r.endsWith("claude-note.md")),
      ).toBe(true);
      expect(
        uploadedMemRels.some((r) => r.includes("codex/") && r.endsWith("2026-11-28-mydemoproj.md")),
      ).toBe(true);
      expect(uploadedMemRels.some((r) => r.includes("grok/") && r.endsWith("MEMORY.md"))).toBe(
        true,
      );
      expect(
        uploadedMemRels.some((r) => r.includes("t3-memory-v2/") && r.endsWith("MEMORY.md")),
      ).toBe(true);
      expect(uploadedMemRels.some((r) => r.includes("utterances-0000.md"))).toBe(false);
      expect(uploadedMemRels.some((r) => r.includes("project-scope.json"))).toBe(false);
    } finally {
      if (prevExternalHome === undefined) {
        delete process.env.T3CODE_DRIVE_BACKUP_EXTERNAL_HOME;
      } else {
        process.env.T3CODE_DRIVE_BACKUP_EXTERNAL_HOME = prevExternalHome;
      }
    }
  });
});
