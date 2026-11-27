// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off globalDate:off globalDateInEffect:off
import * as NodeCrypto from "node:crypto";
import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";
import {
  DriveBackupError,
  ProjectId,
  type DriveBackupConfig,
  type DriveBackupDeleteTargetInput,
  type DriveBackupDryRunInput,
  type DriveBackupDryRunResult,
  type DriveBackupDryRunTarget,
  type DriveBackupGetStateInput,
  type DriveBackupRunKind,
  type DriveBackupRunNowInput,
  type DriveBackupRunRecord,
  type DriveBackupRunStatus,
  type DriveBackupStateSnapshot,
  type DriveBackupSyncMirrorInput,
  type DriveBackupSyncMirrorResult,
  type DriveBackupTarget,
  type DriveBackupTargetKind,
  type DriveBackupTransportMode,
  type DriveBackupUpdateConfigInput,
  type DriveBackupUpsertTargetInput,
  type DriveBackupVerifyRestoreInput,
  type DriveBackupVerifyRestoreResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import { activeWorkRegistry } from "../../orchestration/ActiveWorkTracker.ts";
import { computeKeyFingerprint, sha256Hex } from "./DriveBackupCrypto.ts";
import {
  detectLocalGoogleDriveRoots,
  detectRiskWarningForFolder,
  scanSelectedDirectory,
} from "./DriveBackupFilter.ts";
import {
  downloadKnowledgeMirrorFromGoogleDriveApi,
  listLocalKnowledgeMirrorFiles,
  uploadToGoogleDriveApi,
  uploadToLocalDriveFolder,
  type GdriveOAuthCredentials,
} from "./DriveTransportAdapter.ts";
import {
  GoogleDriveBackupService,
  type GoogleDriveBackupServiceShape,
} from "./GoogleDriveBackupService.ts";
import {
  buildSelectedTargetArchive,
  packEntriesToArchive,
  verifyAndUnpackArchive,
  type PackedArchiveInputEntry,
} from "./ProjectArchivePacker.ts";

const CONFIG_ROW_ID = "default";
const SECRET_PASSPHRASE_KEY = "drive_backup_passphrase";
const SECRET_GDRIVE_OAUTH_KEY = "drive_backup_gdrive_oauth";

interface ConfigRow {
  readonly id: string;
  readonly transport_mode: DriveBackupTransportMode;
  readonly local_drive_root: string | null;
  readonly gdrive_folder_name: string;
  readonly gdrive_knowledge_folder_name: string;
  readonly gdrive_connected_email: string | null;
  readonly encryption_enabled: number;
  readonly key_fingerprint: string | null;
  readonly retention_count: number;
  readonly include_core_settings: number;
  readonly include_core_sqlite_snapshot: number;
  readonly include_event_archives: number;
  readonly auto_sync_idle_only: number;
  readonly updated_at_ms: number;
}

interface TargetRow {
  readonly id: string;
  readonly kind: DriveBackupTargetKind;
  readonly project_id: string | null;
  readonly display_name: string;
  readonly root_path: string;
  readonly enabled: number;
  readonly sync_files: number;
  readonly sync_t3_scope: number;
  readonly sync_drive_to_local_rag: number;
  readonly exclude_globs_json: string;
  readonly last_backed_up_at_ms: number | null;
  readonly updated_at_ms: number;
}

interface RunRow {
  readonly run_id: string;
  readonly kind: DriveBackupRunKind;
  readonly status: DriveBackupRunStatus;
  readonly transport_mode: DriveBackupTransportMode;
  readonly target_ids_json: string;
  readonly file_count: number;
  readonly raw_bytes: number;
  readonly archive_bytes: number;
  readonly skipped_secrets_count: number;
  readonly skipped_secrets_sample_json: string;
  readonly manifest_sha256: string | null;
  readonly destination_path: string | null;
  readonly error_message: string | null;
  readonly started_at_ms: number;
  readonly finished_at_ms: number | null;
}

function parseJsonStringArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function normalizePathKey(p: string): string {
  const resolved = NodePath.resolve(p);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function sanitizeSegment(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80) || "target";
}

function formatStamp(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
}

function redactSettingsSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSettingsSecrets);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (/(?:secret|token|password|passphrase|api[_-]?key|private[_-]?key|cookie)/i.test(k)) {
        out[k] = "[REDACTED]";
      } else {
        out[k] = redactSettingsSecrets(v);
      }
    }
    return out;
  }
  return value;
}

function mapRunRow(row: RunRow): DriveBackupRunRecord {
  return {
    runId: row.run_id,
    kind: row.kind,
    status: row.status,
    transportMode: row.transport_mode,
    targetIds: parseJsonStringArray(row.target_ids_json),
    fileCount: Math.max(0, Number(row.file_count ?? 0)),
    rawBytes: Math.max(0, Number(row.raw_bytes ?? 0)),
    archiveBytes: Math.max(0, Number(row.archive_bytes ?? 0)),
    skippedSecretsCount: Math.max(0, Number(row.skipped_secrets_count ?? 0)),
    skippedSecretsSample: parseJsonStringArray(row.skipped_secrets_sample_json),
    manifestSha256: row.manifest_sha256 ?? null,
    destinationPath: row.destination_path ?? null,
    errorMessage: row.error_message ?? null,
    startedAtMs: Number(row.started_at_ms),
    finishedAtMs: row.finished_at_ms !== null ? Number(row.finished_at_ms) : null,
  };
}

function errMsg(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export const makeGoogleDriveBackupService = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const secretStore = yield* ServerSecretStore.ServerSecretStore;

  const mirrorLocalDir = NodePath.join(serverConfig.baseDir, "drive-mirror");
  const localStagingDir = NodePath.join(serverConfig.baseDir, "backups", "rolling");

  const readSecretText = (name: string): Effect.Effect<string | null, never> =>
    secretStore.get(name).pipe(
      Effect.map((opt) => (Option.isSome(opt) ? Buffer.from(opt.value).toString("utf8") : null)),
      Effect.catch(() => Effect.succeed(null)),
    );

  const readOAuthCredentials = (): Effect.Effect<GdriveOAuthCredentials | null, never> =>
    readSecretText(SECRET_GDRIVE_OAUTH_KEY).pipe(
      Effect.map((raw) => {
        if (!raw) return null;
        try {
          const parsed = JSON.parse(raw) as Partial<GdriveOAuthCredentials>;
          if (parsed.clientId && parsed.clientSecret && parsed.refreshToken) {
            return {
              clientId: parsed.clientId,
              clientSecret: parsed.clientSecret,
              refreshToken: parsed.refreshToken,
            };
          }
          return null;
        } catch {
          return null;
        }
      }),
    );

  const ensureConfigRow = (): Effect.Effect<ConfigRow, DriveBackupError> =>
    Effect.gen(function* () {
      const rows = yield* sql<ConfigRow>`
        SELECT * FROM drive_backup_config WHERE id = ${CONFIG_ROW_ID} LIMIT 1
      `.pipe(
        Effect.mapError(
          (e) =>
            new DriveBackupError({ code: "UNAVAILABLE", message: `설정 조회 실패: ${errMsg(e)}` }),
        ),
      );
      if (rows[0]) return rows[0];

      const now = Date.now();
      yield* sql`
        INSERT INTO drive_backup_config (
          id, transport_mode, local_drive_root, gdrive_folder_name, gdrive_knowledge_folder_name,
          gdrive_connected_email, encryption_enabled, key_fingerprint, retention_count,
          include_core_settings, include_core_sqlite_snapshot, include_event_archives,
          auto_sync_idle_only, updated_at_ms
        ) VALUES (
          ${CONFIG_ROW_ID}, 'gdrive_api', NULL, 'T3-Backup', 'T3-Knowledge',
          NULL, 1, NULL, 7,
          1, 0, 0,
          1, ${now}
        )
      `.pipe(
        Effect.mapError(
          (e) =>
            new DriveBackupError({
              code: "UNAVAILABLE",
              message: `기본 설정 초기화 실패: ${errMsg(e)}`,
            }),
        ),
      );

      const inserted = yield* sql<ConfigRow>`
        SELECT * FROM drive_backup_config WHERE id = ${CONFIG_ROW_ID} LIMIT 1
      `.pipe(
        Effect.mapError(
          (e) =>
            new DriveBackupError({
              code: "UNAVAILABLE",
              message: `설정 재조회 실패: ${errMsg(e)}`,
            }),
        ),
      );
      if (!inserted[0]) {
        return yield* new DriveBackupError({
          code: "UNAVAILABLE",
          message: "구글 드라이브 백업 설정 행을 초기화할 수 없습니다.",
        });
      }
      return inserted[0];
    });

  const mapConfigRow = (row: ConfigRow): Effect.Effect<DriveBackupConfig, never> =>
    Effect.gen(function* () {
      const oauth = yield* readOAuthCredentials();
      return {
        transportMode: row.transport_mode,
        localDriveRoot: row.local_drive_root ?? null,
        gdriveFolderName: row.gdrive_folder_name,
        gdriveKnowledgeFolderName: row.gdrive_knowledge_folder_name,
        gdriveConnectedEmail: row.gdrive_connected_email ?? null,
        gdriveHasCredentials: oauth !== null,
        encryptionEnabled: Boolean(row.encryption_enabled),
        keyFingerprint: row.key_fingerprint ?? null,
        retentionCount: Math.max(1, Number(row.retention_count ?? 7)),
        includeCoreSettings: Boolean(row.include_core_settings),
        includeCoreSqliteSnapshot: Boolean(row.include_core_sqlite_snapshot),
        includeEventArchives: Boolean(row.include_event_archives),
        autoSyncIdleOnly: Boolean(row.auto_sync_idle_only),
        updatedAtMs: Number(row.updated_at_ms),
      };
    });

  const countProjectT3Scope = (
    projectId: string | null,
  ): Effect.Effect<{ readonly threadCount: number; readonly memoryCount: number }, never> =>
    Effect.gen(function* () {
      if (!projectId) return { threadCount: 0, memoryCount: 0 };
      const threadCount = yield* sql<{ readonly cnt: number }>`
        SELECT COUNT(*) AS cnt FROM projection_threads
        WHERE project_id = ${projectId} AND deleted_at IS NULL
      `.pipe(
        Effect.map((rows) => Math.max(0, Number(rows[0]?.cnt ?? 0))),
        Effect.catch(() => Effect.succeed(0)),
      );
      const memoryCount = yield* sql<{ readonly cnt: number }>`
        SELECT COUNT(*) AS cnt FROM workspace_memory_v2
        WHERE project_id = ${projectId}
      `.pipe(
        Effect.map((rows) => Math.max(0, Number(rows[0]?.cnt ?? 0))),
        Effect.catch(() => Effect.succeed(0)),
      );
      return { threadCount, memoryCount };
    });

  const hydrateTarget = (row: TargetRow): Effect.Effect<DriveBackupTarget, never> =>
    Effect.gen(function* () {
      const existsOnDisk = NodeFs.existsSync(row.root_path);
      const isGitRepo = existsOnDisk && NodeFs.existsSync(NodePath.join(row.root_path, ".git"));
      const counts = yield* countProjectT3Scope(row.project_id);
      return {
        id: row.id,
        kind: row.kind,
        projectId: row.project_id ? ProjectId.make(row.project_id) : null,
        displayName: row.display_name,
        rootPath: row.root_path,
        existsOnDisk,
        isGitRepo,
        enabled: Boolean(row.enabled),
        syncFiles: Boolean(row.sync_files),
        syncT3Scope: Boolean(row.sync_t3_scope),
        syncDriveToLocalRag: Boolean(row.sync_drive_to_local_rag),
        excludeGlobs: parseJsonStringArray(row.exclude_globs_json),
        riskWarning: detectRiskWarningForFolder(row.display_name, row.root_path),
        threadCount: counts.threadCount,
        memoryCount: counts.memoryCount,
        lastBackedUpAtMs:
          row.last_backed_up_at_ms !== null ? Number(row.last_backed_up_at_ms) : null,
        updatedAtMs: Number(row.updated_at_ms),
      };
    });

  const syncRegisteredProjectCandidates = (
    includeArchivedProjects: boolean,
  ): Effect.Effect<void, never> =>
    Effect.gen(function* () {
      const existing = yield* sql<{ readonly root_path: string }>`
        SELECT root_path FROM drive_backup_targets
      `.pipe(
        Effect.catch(() => Effect.succeed([] as ReadonlyArray<{ readonly root_path: string }>)),
      );
      const knownPaths = new Set(existing.map((r) => normalizePathKey(r.root_path)));
      const now = Date.now();

      const projects = includeArchivedProjects
        ? yield* sql<{
            readonly project_id: string;
            readonly title: string;
            readonly workspace_root: string;
          }>`
            SELECT project_id, title, workspace_root FROM projection_projects
          `.pipe(
            Effect.catch(() =>
              Effect.succeed(
                [] as ReadonlyArray<{
                  readonly project_id: string;
                  readonly title: string;
                  readonly workspace_root: string;
                }>,
              ),
            ),
          )
        : yield* sql<{
            readonly project_id: string;
            readonly title: string;
            readonly workspace_root: string;
          }>`
            SELECT project_id, title, workspace_root FROM projection_projects
            WHERE deleted_at IS NULL
          `.pipe(
            Effect.catch(() =>
              Effect.succeed(
                [] as ReadonlyArray<{
                  readonly project_id: string;
                  readonly title: string;
                  readonly workspace_root: string;
                }>,
              ),
            ),
          );

      for (const proj of projects) {
        const key = normalizePathKey(proj.workspace_root);
        if (knownPaths.has(key)) continue;
        knownPaths.add(key);
        const targetId = `proj:${proj.project_id}`;
        yield* sql`
          INSERT OR IGNORE INTO drive_backup_targets (
            id, kind, project_id, display_name, root_path,
            enabled, sync_files, sync_t3_scope, sync_drive_to_local_rag,
            exclude_globs_json, last_backed_up_at_ms, updated_at_ms
          ) VALUES (
            ${targetId}, 'project', ${proj.project_id}, ${proj.title}, ${proj.workspace_root},
            0, 1, 1, 0,
            '[]', NULL, ${now}
          )
        `.pipe(Effect.catch(() => Effect.void));
      }

      // T3 본체 저장소(config.cwd)가 아직 목록에 없고 디스크에 존재하면 Opt-In 후보로 등록
      if (serverConfig.cwd && NodeFs.existsSync(serverConfig.cwd)) {
        const cwdKey = normalizePathKey(serverConfig.cwd);
        if (!knownPaths.has(cwdKey)) {
          const isGit = NodeFs.existsSync(NodePath.join(serverConfig.cwd, ".git"));
          if (isGit) {
            knownPaths.add(cwdKey);
            yield* sql`
              INSERT OR IGNORE INTO drive_backup_targets (
                id, kind, project_id, display_name, root_path,
                enabled, sync_files, sync_t3_scope, sync_drive_to_local_rag,
                exclude_globs_json, last_backed_up_at_ms, updated_at_ms
              ) VALUES (
                'core:t3-repo', 'core', NULL, 'T3 본체 저장소', ${serverConfig.cwd},
                0, 1, 0, 0,
                '[]', NULL, ${now}
              )
            `.pipe(Effect.catch(() => Effect.void));
          }
        }
      }
    });

  const exportProjectT3ScopeJson = (projectId: string): Effect.Effect<Buffer | null, never> =>
    Effect.gen(function* () {
      const projectRows = yield* sql`
        SELECT * FROM projection_projects WHERE project_id = ${projectId}
      `.pipe(Effect.catch(() => Effect.succeed([] as ReadonlyArray<unknown>)));

      const threadRows = yield* sql<{ readonly thread_id: string }>`
        SELECT * FROM projection_threads
        WHERE project_id = ${projectId} AND deleted_at IS NULL
        ORDER BY updated_at DESC LIMIT 200
      `.pipe(
        Effect.catch(() => Effect.succeed([] as ReadonlyArray<{ readonly thread_id: string }>)),
      );

      const messages: unknown[] = [];
      for (const th of threadRows.slice(0, 60)) {
        const rows = yield* sql`
          SELECT * FROM projection_thread_messages
          WHERE thread_id = ${th.thread_id}
          ORDER BY created_at ASC LIMIT 200
        `.pipe(Effect.catch(() => Effect.succeed([] as ReadonlyArray<unknown>)));
        for (const r of rows) messages.push(r);
      }

      const memories = yield* sql`
        SELECT * FROM workspace_memory_v2
        WHERE project_id = ${projectId}
        ORDER BY updated_at DESC LIMIT 5000
      `.pipe(Effect.catch(() => Effect.succeed([] as ReadonlyArray<unknown>)));

      const missionRuns = yield* sql`
        SELECT * FROM mission_runs WHERE project_id = ${projectId}
        ORDER BY created_at_ms DESC LIMIT 200
      `.pipe(Effect.catch(() => Effect.succeed([] as ReadonlyArray<unknown>)));

      const missionReports = yield* sql`
        SELECT * FROM mission_reports WHERE project_id = ${projectId}
        ORDER BY created_at_ms DESC LIMIT 200
      `.pipe(Effect.catch(() => Effect.succeed([] as ReadonlyArray<unknown>)));

      const payload = {
        schemaVersion: 1,
        exportedAtIso: new Date().toISOString(),
        projectId,
        project: projectRows[0] ?? null,
        threads: threadRows,
        messages,
        memories,
        missionRuns,
        missionReports,
      };
      return Buffer.from(JSON.stringify(payload, null, 2), "utf8");
    });

  const createReadOnlySqliteSnapshotBuffer = (): Effect.Effect<Buffer | null, never> =>
    Effect.tryPromise({
      try: async () => {
        if (!serverConfig.dbPath || serverConfig.dbPath === ":memory:") return null;
        if (!NodeFs.existsSync(serverConfig.dbPath)) return null;
        const tmpPath = NodePath.join(
          NodeOs.tmpdir(),
          `t3-drive-sqlite-snap-${NodeCrypto.randomUUID().slice(0, 12)}.sqlite`,
        );
        try {
          const { DatabaseSync } = await import("node:sqlite");
          const escaped = tmpPath.replace(/'/g, "''");
          const srcDb = new DatabaseSync(serverConfig.dbPath, { readOnly: true });
          try {
            srcDb.exec(`VACUUM INTO '${escaped}'`);
          } finally {
            srcDb.close();
          }
          const verifyDb = new DatabaseSync(tmpPath, { readOnly: true });
          try {
            const check = verifyDb.prepare("PRAGMA quick_check").get() as
              | { readonly quick_check?: string }
              | undefined;
            if (check?.quick_check !== "ok") {
              throw new Error(`SQLite quick_check 실패: ${String(check?.quick_check)}`);
            }
          } finally {
            verifyDb.close();
          }
          return NodeFs.readFileSync(tmpPath);
        } finally {
          try {
            if (NodeFs.existsSync(tmpPath)) NodeFs.rmSync(tmpPath, { force: true });
          } catch {
            // ignore cleanup failure
          }
        }
      },
      catch: () => null,
    }).pipe(Effect.catch(() => Effect.succeed(null)));

  const listTargetRows = (): Effect.Effect<ReadonlyArray<TargetRow>, DriveBackupError> =>
    sql<TargetRow>`
      SELECT * FROM drive_backup_targets
      ORDER BY enabled DESC, kind ASC, display_name ASC
    `.pipe(
      Effect.mapError(
        (e) =>
          new DriveBackupError({
            code: "UNAVAILABLE",
            message: `대상 목록 조회 실패: ${errMsg(e)}`,
          }),
      ),
    );

  const listRecentRuns = (
    limit = 20,
  ): Effect.Effect<ReadonlyArray<DriveBackupRunRecord>, DriveBackupError> =>
    sql<RunRow>`
      SELECT * FROM drive_backup_runs
      ORDER BY started_at_ms DESC LIMIT ${limit}
    `.pipe(
      Effect.map((rows) => rows.map(mapRunRow)),
      Effect.mapError(
        (e) =>
          new DriveBackupError({
            code: "UNAVAILABLE",
            message: `실행 이력 조회 실패: ${errMsg(e)}`,
          }),
      ),
    );

  const recordRun = (record: DriveBackupRunRecord): Effect.Effect<void, never> =>
    sql`
      INSERT INTO drive_backup_runs (
        run_id, kind, status, transport_mode, target_ids_json,
        file_count, raw_bytes, archive_bytes,
        skipped_secrets_count, skipped_secrets_sample_json,
        manifest_sha256, destination_path, error_message,
        started_at_ms, finished_at_ms
      ) VALUES (
        ${record.runId}, ${record.kind}, ${record.status}, ${record.transportMode},
        ${JSON.stringify(record.targetIds)},
        ${record.fileCount}, ${record.rawBytes}, ${record.archiveBytes},
        ${record.skippedSecretsCount}, ${JSON.stringify(record.skippedSecretsSample)},
        ${record.manifestSha256}, ${record.destinationPath}, ${record.errorMessage},
        ${record.startedAtMs}, ${record.finishedAtMs}
      )
      ON CONFLICT(run_id) DO UPDATE SET
        status = excluded.status,
        file_count = excluded.file_count,
        raw_bytes = excluded.raw_bytes,
        archive_bytes = excluded.archive_bytes,
        skipped_secrets_count = excluded.skipped_secrets_count,
        skipped_secrets_sample_json = excluded.skipped_secrets_sample_json,
        manifest_sha256 = excluded.manifest_sha256,
        destination_path = excluded.destination_path,
        error_message = excluded.error_message,
        finished_at_ms = excluded.finished_at_ms
    `.pipe(
      Effect.asVoid,
      Effect.catch(() => Effect.void),
    );

  const getState = (
    input: DriveBackupGetStateInput,
  ): Effect.Effect<DriveBackupStateSnapshot, DriveBackupError> =>
    Effect.gen(function* () {
      const cfgRow = yield* ensureConfigRow();
      yield* syncRegisteredProjectCandidates(Boolean(input.includeArchivedProjects));
      const config = yield* mapConfigRow(cfgRow);
      const targetRows = yield* listTargetRows();
      const targets = yield* Effect.forEach(targetRows, hydrateTarget, { concurrency: 4 });
      const recentRuns = yield* listRecentRuns(20);
      return {
        config,
        detectedLocalDriveRoots: [...detectLocalGoogleDriveRoots()],
        mirrorLocalDir,
        localStagingDir,
        activeWorkCount: activeWorkRegistry.snapshot().totalActive,
        targets,
        recentRuns: [...recentRuns],
      };
    });

  const updateConfig = (
    input: DriveBackupUpdateConfigInput,
  ): Effect.Effect<DriveBackupConfig, DriveBackupError> =>
    Effect.gen(function* () {
      const current = yield* ensureConfigRow();
      let nextKeyFingerprint = current.key_fingerprint;

      if (input.encryptionPassphrase !== undefined) {
        const trimmed = input.encryptionPassphrase;
        if (trimmed.length === 0) {
          yield* secretStore.remove(SECRET_PASSPHRASE_KEY).pipe(Effect.catch(() => Effect.void));
          nextKeyFingerprint = null;
        } else if (trimmed.length < 4) {
          return yield* new DriveBackupError({
            code: "INVALID_INPUT",
            message: "암호화 비밀번호는 4자 이상이어야 합니다.",
          });
        } else {
          yield* secretStore
            .set(SECRET_PASSPHRASE_KEY, Uint8Array.from(Buffer.from(trimmed, "utf8")))
            .pipe(
              Effect.mapError(
                (e) =>
                  new DriveBackupError({
                    code: "ENCRYPTION_ERROR",
                    message: `암호화 비밀번호 저장 실패: ${errMsg(e)}`,
                  }),
              ),
            );
          nextKeyFingerprint = computeKeyFingerprint(trimmed);
        }
      }

      if (
        input.gdriveClientId !== undefined ||
        input.gdriveClientSecret !== undefined ||
        input.gdriveRefreshToken !== undefined
      ) {
        const prev = yield* readOAuthCredentials();
        const clientId = (input.gdriveClientId ?? prev?.clientId ?? "").trim();
        const clientSecret = (input.gdriveClientSecret ?? prev?.clientSecret ?? "").trim();
        const refreshToken = (input.gdriveRefreshToken ?? prev?.refreshToken ?? "").trim();
        if (!clientId && !clientSecret && !refreshToken) {
          yield* secretStore.remove(SECRET_GDRIVE_OAUTH_KEY).pipe(Effect.catch(() => Effect.void));
        } else {
          yield* secretStore
            .set(
              SECRET_GDRIVE_OAUTH_KEY,
              Uint8Array.from(
                Buffer.from(JSON.stringify({ clientId, clientSecret, refreshToken }), "utf8"),
              ),
            )
            .pipe(
              Effect.mapError(
                (e) =>
                  new DriveBackupError({
                    code: "AUTH_REQUIRED",
                    message: `Google Drive OAuth 자격증명 저장 실패: ${errMsg(e)}`,
                  }),
              ),
            );
        }
      }

      const nextTransportMode = input.transportMode ?? current.transport_mode;
      const nextLocalDriveRoot =
        input.localDriveRoot !== undefined
          ? input.localDriveRoot && input.localDriveRoot.trim().length > 0
            ? input.localDriveRoot.trim()
            : null
          : current.local_drive_root;
      const nextFolderName = input.gdriveFolderName ?? current.gdrive_folder_name;
      const nextKnowledgeFolderName =
        input.gdriveKnowledgeFolderName ?? current.gdrive_knowledge_folder_name;
      const nextEmail =
        input.gdriveConnectedEmail !== undefined
          ? input.gdriveConnectedEmail
          : current.gdrive_connected_email;
      const nextEncryptionEnabled =
        input.encryptionEnabled !== undefined
          ? input.encryptionEnabled
            ? 1
            : 0
          : current.encryption_enabled;
      const nextRetention =
        input.retentionCount !== undefined
          ? Math.max(1, Math.min(90, Math.floor(input.retentionCount)))
          : current.retention_count;
      const nextIncludeCoreSettings =
        input.includeCoreSettings !== undefined
          ? input.includeCoreSettings
            ? 1
            : 0
          : current.include_core_settings;
      const nextIncludeSqlite =
        input.includeCoreSqliteSnapshot !== undefined
          ? input.includeCoreSqliteSnapshot
            ? 1
            : 0
          : current.include_core_sqlite_snapshot;
      const nextIncludeEventArchives =
        input.includeEventArchives !== undefined
          ? input.includeEventArchives
            ? 1
            : 0
          : current.include_event_archives;
      const nextAutoIdle =
        input.autoSyncIdleOnly !== undefined
          ? input.autoSyncIdleOnly
            ? 1
            : 0
          : current.auto_sync_idle_only;
      const now = Date.now();

      yield* sql`
        UPDATE drive_backup_config SET
          transport_mode = ${nextTransportMode},
          local_drive_root = ${nextLocalDriveRoot},
          gdrive_folder_name = ${nextFolderName},
          gdrive_knowledge_folder_name = ${nextKnowledgeFolderName},
          gdrive_connected_email = ${nextEmail},
          encryption_enabled = ${nextEncryptionEnabled},
          key_fingerprint = ${nextKeyFingerprint},
          retention_count = ${nextRetention},
          include_core_settings = ${nextIncludeCoreSettings},
          include_core_sqlite_snapshot = ${nextIncludeSqlite},
          include_event_archives = ${nextIncludeEventArchives},
          auto_sync_idle_only = ${nextAutoIdle},
          updated_at_ms = ${now}
        WHERE id = ${CONFIG_ROW_ID}
      `.pipe(
        Effect.mapError(
          (e) =>
            new DriveBackupError({ code: "UNAVAILABLE", message: `설정 저장 실패: ${errMsg(e)}` }),
        ),
      );

      const updated = yield* ensureConfigRow();
      return yield* mapConfigRow(updated);
    });

  const upsertTarget = (
    input: DriveBackupUpsertTargetInput,
  ): Effect.Effect<DriveBackupTarget, DriveBackupError> =>
    Effect.gen(function* () {
      const rootPath = input.rootPath.trim();
      if (!rootPath) {
        return yield* new DriveBackupError({
          code: "INVALID_INPUT",
          message: "폴더 또는 저장소 경로를 입력해 주세요.",
        });
      }
      const now = Date.now();
      const excludeGlobsJson = JSON.stringify(input.excludeGlobs ?? []);

      // 기존 ID 또는 동일 root_path 행 조회
      let targetId = input.id?.trim() || "";
      if (!targetId) {
        const byPath = yield* sql<{ readonly id: string }>`
          SELECT id FROM drive_backup_targets WHERE root_path = ${rootPath} LIMIT 1
        `.pipe(Effect.catch(() => Effect.succeed([] as ReadonlyArray<{ readonly id: string }>)));
        targetId = byPath[0]?.id ?? `target:${NodeCrypto.randomUUID().slice(0, 12)}`;
      }

      yield* sql`
        INSERT INTO drive_backup_targets (
          id, kind, project_id, display_name, root_path,
          enabled, sync_files, sync_t3_scope, sync_drive_to_local_rag,
          exclude_globs_json, last_backed_up_at_ms, updated_at_ms
        ) VALUES (
          ${targetId}, ${input.kind}, ${input.projectId ?? null}, ${input.displayName.trim()}, ${rootPath},
          ${input.enabled ? 1 : 0}, ${input.syncFiles ? 1 : 0}, ${input.syncT3Scope ? 1 : 0},
          ${input.syncDriveToLocalRag ? 1 : 0}, ${excludeGlobsJson}, NULL, ${now}
        )
        ON CONFLICT(id) DO UPDATE SET
          kind = excluded.kind,
          project_id = COALESCE(excluded.project_id, drive_backup_targets.project_id),
          display_name = excluded.display_name,
          root_path = excluded.root_path,
          enabled = excluded.enabled,
          sync_files = excluded.sync_files,
          sync_t3_scope = excluded.sync_t3_scope,
          sync_drive_to_local_rag = excluded.sync_drive_to_local_rag,
          exclude_globs_json = excluded.exclude_globs_json,
          updated_at_ms = excluded.updated_at_ms
      `.pipe(
        Effect.mapError(
          (e) =>
            new DriveBackupError({
              code: "UNAVAILABLE",
              message: `백업 대상 저장 실패: ${errMsg(e)}`,
            }),
        ),
      );

      const rows = yield* sql<TargetRow>`
        SELECT * FROM drive_backup_targets WHERE id = ${targetId} LIMIT 1
      `.pipe(
        Effect.mapError(
          (e) =>
            new DriveBackupError({
              code: "UNAVAILABLE",
              message: `대상 재조회 실패: ${errMsg(e)}`,
            }),
        ),
      );
      if (!rows[0]) {
        return yield* new DriveBackupError({
          code: "NOT_FOUND",
          message: "저장된 백업 대상을 찾을 수 없습니다.",
        });
      }
      return yield* hydrateTarget(rows[0]);
    });

  const deleteTarget = (
    input: DriveBackupDeleteTargetInput,
  ): Effect.Effect<{ readonly deleted: boolean; readonly targetId: string }, DriveBackupError> =>
    Effect.gen(function* () {
      const existing = yield* sql<{ readonly id: string }>`
        SELECT id FROM drive_backup_targets WHERE id = ${input.targetId} LIMIT 1
      `.pipe(
        Effect.mapError(
          (e) =>
            new DriveBackupError({ code: "UNAVAILABLE", message: `대상 조회 실패: ${errMsg(e)}` }),
        ),
      );
      if (!existing[0]) {
        return { deleted: false, targetId: input.targetId };
      }
      yield* sql`DELETE FROM drive_backup_targets WHERE id = ${input.targetId}`.pipe(
        Effect.mapError(
          (e) =>
            new DriveBackupError({ code: "UNAVAILABLE", message: `대상 삭제 실패: ${errMsg(e)}` }),
        ),
      );
      return { deleted: true, targetId: input.targetId };
    });

  const dryRun = (
    input: DriveBackupDryRunInput,
  ): Effect.Effect<DriveBackupDryRunResult, DriveBackupError> =>
    Effect.gen(function* () {
      const allRows = yield* listTargetRows();
      const filterSet =
        input.targetIds && input.targetIds.length > 0 ? new Set(input.targetIds) : null;
      const selected = allRows.filter((row) =>
        filterSet ? filterSet.has(row.id) : Boolean(row.enabled),
      );

      const targetResults: DriveBackupDryRunTarget[] = [];
      let totalFilesCount = 0;
      let totalRawBytes = 0;
      let totalEstimatedArchiveBytes = 0;
      let totalBlockedSecretsCount = 0;

      for (const row of selected) {
        const excludeGlobs = parseJsonStringArray(row.exclude_globs_json);
        const warnings: string[] = [];
        const risk = detectRiskWarningForFolder(row.display_name, row.root_path);
        if (risk) warnings.push(risk);

        let includedFilesCount = 0;
        let estimatedRawBytes = 0;
        let blockedSecretsCount = 0;
        let blockedSecretsSample: ReadonlyArray<string> = [];

        if (row.sync_files) {
          const scanned = scanSelectedDirectory({
            rootPath: row.root_path,
            customExcludeGlobs: excludeGlobs,
          });
          includedFilesCount = scanned.includedFiles.length;
          estimatedRawBytes = scanned.totalRawBytes;
          blockedSecretsCount = scanned.blockedSecretsCount;
          blockedSecretsSample = scanned.blockedSecretsSample;
          for (const w of scanned.warnings) warnings.push(w);
        }

        const counts = row.sync_t3_scope
          ? yield* countProjectT3Scope(row.project_id)
          : { threadCount: 0, memoryCount: 0 };
        if (row.sync_t3_scope && row.project_id) {
          includedFilesCount += 1; // t3-scope/project-scope.json
          estimatedRawBytes += counts.threadCount * 4_096 + counts.memoryCount * 512;
        }

        const isGitRepo =
          NodeFs.existsSync(row.root_path) &&
          NodeFs.existsSync(NodePath.join(row.root_path, ".git"));
        const estimatedArchiveBytes = Math.max(0, Math.round(estimatedRawBytes * 0.35));

        targetResults.push({
          targetId: row.id,
          displayName: row.display_name,
          rootPath: row.root_path,
          enabled: Boolean(row.enabled),
          includedFilesCount,
          estimatedRawBytes,
          estimatedArchiveBytes,
          isGitRepo,
          t3ScopeThreadsCount: counts.threadCount,
          t3ScopeMemoriesCount: counts.memoryCount,
          blockedSecretsCount,
          blockedSecretsSample: [...blockedSecretsSample],
          warnings,
        });

        totalFilesCount += includedFilesCount;
        totalRawBytes += estimatedRawBytes;
        totalEstimatedArchiveBytes += estimatedArchiveBytes;
        totalBlockedSecretsCount += blockedSecretsCount;
      }

      return {
        generatedAtMs: Date.now(),
        selectedTargetsCount: targetResults.length,
        totalFilesCount,
        totalRawBytes,
        totalEstimatedArchiveBytes,
        totalBlockedSecretsCount,
        targets: targetResults,
      };
    });

  const runNow = (
    input: DriveBackupRunNowInput,
  ): Effect.Effect<DriveBackupRunRecord, DriveBackupError> =>
    Effect.gen(function* () {
      const cfgRow = yield* ensureConfigRow();
      const config = yield* mapConfigRow(cfgRow);
      const allRows = yield* listTargetRows();
      const filterSet =
        input.targetIds && input.targetIds.length > 0 ? new Set(input.targetIds) : null;
      const selectedRows = allRows.filter((row) =>
        filterSet ? filterSet.has(row.id) : Boolean(row.enabled),
      );

      if (selectedRows.length === 0) {
        return yield* new DriveBackupError({
          code: "INVALID_STATE",
          message:
            "백업 대상으로 선택(ON)된 폴더나 저장소가 없습니다. 먼저 1개 이상의 대상을 활성화하세요.",
        });
      }

      const startedAtMs = Date.now();
      const runId = `drvrun_${formatStamp(startedAtMs)}_${NodeCrypto.randomUUID().slice(0, 6)}`;
      const targetIds = selectedRows.map((r) => r.id);

      // 유휴 양보 검사 (활성 턴·위임·오케스트라 진행 중 보호)
      const activeCount = activeWorkRegistry.snapshot().totalActive;
      if (config.autoSyncIdleOnly && !input.forceWhenBusy && activeCount > 0) {
        const skipped: DriveBackupRunRecord = {
          runId,
          kind: "backup",
          status: "skipped_busy",
          transportMode: config.transportMode,
          targetIds,
          fileCount: 0,
          rawBytes: 0,
          archiveBytes: 0,
          skippedSecretsCount: 0,
          skippedSecretsSample: [],
          manifestSha256: null,
          destinationPath: null,
          errorMessage: `활성 작업 ${activeCount}건이 실행 중이어서 유휴 시점까지 백업을 양보했습니다.`,
          startedAtMs,
          finishedAtMs: Date.now(),
        };
        yield* recordRun(skipped);
        return skipped;
      }

      // 암호화 비밀번호 확인
      let passphrase: string | null = null;
      if (config.encryptionEnabled) {
        passphrase = yield* readSecretText(SECRET_PASSPHRASE_KEY);
        if (!passphrase || passphrase.length < 4) {
          return yield* new DriveBackupError({
            code: "ENCRYPTION_ERROR",
            message:
              "AES-256-GCM 암호화가 활성화되어 있지만 암호화 비밀번호가 설정되지 않았습니다.",
          });
        }
      }

      // 전송 대상 사전 검증
      let oauthCreds: GdriveOAuthCredentials | null = null;
      if (config.transportMode === "local_drive_folder") {
        if (!config.localDriveRoot || config.localDriveRoot.trim().length === 0) {
          return yield* new DriveBackupError({
            code: "INVALID_STATE",
            message: "로컬 Google Drive 폴더 경로가 설정되어 있지 않습니다.",
          });
        }
      } else {
        oauthCreds = yield* readOAuthCredentials();
        if (!oauthCreds) {
          return yield* new DriveBackupError({
            code: "AUTH_REQUIRED",
            message:
              "Google Drive API v3 OAuth2 자격증명(Client ID / Secret / Refresh Token)이 연결되어 있지 않습니다.",
          });
        }
      }

      const initialRun: DriveBackupRunRecord = {
        runId,
        kind: "backup",
        status: "running",
        transportMode: config.transportMode,
        targetIds,
        fileCount: 0,
        rawBytes: 0,
        archiveBytes: 0,
        skippedSecretsCount: 0,
        skippedSecretsSample: [],
        manifestSha256: null,
        destinationPath: null,
        errorMessage: null,
        startedAtMs,
        finishedAtMs: null,
      };
      yield* recordRun(initialRun);

      let totalFiles = 0;
      let totalRawBytes = 0;
      let totalArchiveBytes = 0;
      let totalBlockedSecrets = 0;
      const blockedSamples: string[] = [];
      let lastManifestSha256: string | null = null;
      let lastDestPath: string | null = null;
      const stamp = formatStamp(startedAtMs);
      const createdAtIso = new Date(startedAtMs).toISOString();

      const uploadBuffer = async (subFolder: string, fileName: string, content: Buffer) => {
        // 1차: 로컬 롤링 백업(최대 3세대)은 항상 함께 보관하여 오프라인 복구 검증 지원
        const localCopy = uploadToLocalDriveFolder(localStagingDir, "local-rolling", {
          subFolder,
          fileName,
          content,
          retentionCount: Math.min(3, config.retentionCount),
        });
        if (config.transportMode === "local_drive_folder") {
          return uploadToLocalDriveFolder(config.localDriveRoot!, config.gdriveFolderName, {
            subFolder,
            fileName,
            content,
            retentionCount: config.retentionCount,
          });
        }
        const remote = await uploadToGoogleDriveApi(oauthCreds!, config.gdriveFolderName, {
          subFolder,
          fileName,
          content,
          retentionCount: config.retentionCount,
        });
        return {
          destinationPath: `${remote.destinationPath} | local:${localCopy.destinationPath}`,
          prunedCount: remote.prunedCount,
        };
      };

      const executionResult = yield* Effect.gen(function* () {
        for (const row of selectedRows) {
          const extraEntries: PackedArchiveInputEntry[] = [];
          if (row.sync_t3_scope && row.project_id) {
            const scopeBuf = yield* exportProjectT3ScopeJson(row.project_id);
            if (scopeBuf) {
              extraEntries.push({
                archivePath: "t3-scope/project-scope.json",
                content: scopeBuf,
              });
            }
          }

          const built = yield* Effect.tryPromise({
            try: () =>
              buildSelectedTargetArchive({
                targetId: row.id,
                targetDisplayName: row.display_name,
                rootPath: row.root_path,
                syncFiles: Boolean(row.sync_files),
                excludeGlobs: parseJsonStringArray(row.exclude_globs_json),
                extraEntries,
                createdAtIso,
                encryptionPassphrase: passphrase,
              }),
            catch: (e) =>
              new DriveBackupError({
                code: "TRANSPORT_ERROR",
                message: `대상 '${row.display_name}' 패킹 실패: ${errMsg(e)}`,
              }),
          });

          const safeFolder = sanitizeSegment(row.display_name || row.id);
          const ext = built.encrypted ? "t3enc" : "t3arc";
          const fileName = `${stamp}_${safeFolder}.${ext}`;
          const uploaded = yield* Effect.tryPromise({
            try: () => uploadBuffer(`projects/${safeFolder}`, fileName, built.buffer),
            catch: (e) =>
              new DriveBackupError({
                code: "TRANSPORT_ERROR",
                message: `대상 '${row.display_name}' 업로드 실패: ${errMsg(e)}`,
              }),
          });

          totalFiles += built.fileCount;
          totalRawBytes += built.rawBytes;
          totalArchiveBytes += built.archiveBytes;
          totalBlockedSecrets += built.blockedSecretsCount;
          for (const sample of built.blockedSecretsSample) {
            if (blockedSamples.length < 15) blockedSamples.push(`${row.display_name}:${sample}`);
          }
          lastManifestSha256 = built.manifestSha256;
          lastDestPath = uploaded.destinationPath;

          const doneMs = Date.now();
          yield* sql`
            UPDATE drive_backup_targets
            SET last_backed_up_at_ms = ${doneMs}, updated_at_ms = ${doneMs}
            WHERE id = ${row.id}
          `.pipe(Effect.catch(() => Effect.void));
        }

        // 선택적 T3 코어 설정 / 읽기 전용 SQLite 스냅샷 백업
        if (config.includeCoreSettings || config.includeCoreSqliteSnapshot) {
          const coreEntries: PackedArchiveInputEntry[] = [];
          if (config.includeCoreSettings) {
            if (NodeFs.existsSync(serverConfig.settingsPath)) {
              try {
                const rawJson = JSON.parse(NodeFs.readFileSync(serverConfig.settingsPath, "utf8"));
                coreEntries.push({
                  archivePath: "core/settings.redacted.json",
                  content: Buffer.from(
                    JSON.stringify(redactSettingsSecrets(rawJson), null, 2),
                    "utf8",
                  ),
                });
              } catch {
                // skip invalid settings
              }
            }
            if (NodeFs.existsSync(serverConfig.keybindingsConfigPath)) {
              try {
                coreEntries.push({
                  archivePath: "core/keybindings.json",
                  content: NodeFs.readFileSync(serverConfig.keybindingsConfigPath),
                });
              } catch {
                // skip
              }
            }
          }
          if (config.includeCoreSqliteSnapshot) {
            const snapBuf = yield* createReadOnlySqliteSnapshotBuffer();
            if (snapBuf) {
              coreEntries.push({
                archivePath: "core/state.snapshot.sqlite",
                content: snapBuf,
              });
            }
          }

          if (coreEntries.length > 0) {
            const packedCore = packEntriesToArchive({
              targetId: "core:t3-state",
              targetDisplayName: "T3 코어 설정·스냅샷",
              entries: coreEntries,
              createdAtIso,
              encryptionPassphrase: passphrase,
            });
            const ext = packedCore.encrypted ? "t3enc" : "t3arc";
            const uploadedCore = yield* Effect.tryPromise({
              try: () => uploadBuffer("core", `${stamp}_t3-core.${ext}`, packedCore.buffer),
              catch: (e) =>
                new DriveBackupError({
                  code: "TRANSPORT_ERROR",
                  message: `T3 코어 백업 업로드 실패: ${errMsg(e)}`,
                }),
            });
            totalFiles += packedCore.fileCount;
            totalRawBytes += packedCore.rawBytes;
            totalArchiveBytes += packedCore.archiveBytes;
            if (!lastDestPath) lastDestPath = uploadedCore.destinationPath;
          }
        }
      }).pipe(Effect.result);

      if (executionResult._tag === "Failure") {
        const failedRun: DriveBackupRunRecord = {
          ...initialRun,
          status: "failed",
          fileCount: totalFiles,
          rawBytes: totalRawBytes,
          archiveBytes: totalArchiveBytes,
          skippedSecretsCount: totalBlockedSecrets,
          skippedSecretsSample: blockedSamples,
          manifestSha256: lastManifestSha256,
          destinationPath: lastDestPath,
          errorMessage: executionResult.failure.message,
          finishedAtMs: Date.now(),
        };
        yield* recordRun(failedRun);
        return yield* executionResult.failure;
      }

      const succeededRun: DriveBackupRunRecord = {
        ...initialRun,
        status: "succeeded",
        fileCount: totalFiles,
        rawBytes: totalRawBytes,
        archiveBytes: totalArchiveBytes,
        skippedSecretsCount: totalBlockedSecrets,
        skippedSecretsSample: blockedSamples,
        manifestSha256: lastManifestSha256,
        destinationPath: lastDestPath,
        errorMessage: null,
        finishedAtMs: Date.now(),
      };
      yield* recordRun(succeededRun);
      return succeededRun;
    });

  const verifyRestore = (
    input: DriveBackupVerifyRestoreInput,
  ): Effect.Effect<DriveBackupVerifyRestoreResult, DriveBackupError> =>
    Effect.gen(function* () {
      const cfgRow = yield* ensureConfigRow();
      const config = yield* mapConfigRow(cfgRow);
      const passphrase = yield* readSecretText(SECRET_PASSPHRASE_KEY);

      let resolvedRunId: string | null = input.runId ?? null;
      let candidatePath = input.archivePath?.trim() || "";

      if (!candidatePath) {
        const runRow = resolvedRunId
          ? yield* sql<RunRow>`
              SELECT * FROM drive_backup_runs WHERE run_id = ${resolvedRunId} LIMIT 1
            `.pipe(Effect.catch(() => Effect.succeed([] as ReadonlyArray<RunRow>)))
          : yield* sql<RunRow>`
              SELECT * FROM drive_backup_runs
              WHERE kind = 'backup' AND status = 'succeeded' AND destination_path IS NOT NULL
              ORDER BY started_at_ms DESC LIMIT 1
            `.pipe(Effect.catch(() => Effect.succeed([] as ReadonlyArray<RunRow>)));

        if (runRow[0]) {
          resolvedRunId = runRow[0].run_id;
          const dest = runRow[0].destination_path ?? "";
          // "gdrive://... | local:C:\..." 포맷이면 로컬 사본 추출
          const localMarker = dest.indexOf("| local:");
          candidatePath =
            localMarker >= 0 ? dest.slice(localMarker + "| local:".length).trim() : dest;
        }
      }

      if (!candidatePath || !NodeFs.existsSync(candidatePath)) {
        return yield* new DriveBackupError({
          code: "NOT_FOUND",
          message: `복구 검증할 백업 아카이브 파일을 찾을 수 없습니다: ${candidatePath || "(기록 없음)"}`,
        });
      }

      const startedAtMs = Date.now();
      const verifyRunId = `drvver_${formatStamp(startedAtMs)}_${NodeCrypto.randomUUID().slice(0, 6)}`;

      const verifiedResult = yield* Effect.try({
        try: () => {
          const rawBuf = NodeFs.readFileSync(candidatePath);
          return verifyAndUnpackArchive(rawBuf, passphrase);
        },
        catch: (e) =>
          new DriveBackupError({
            code: "ENCRYPTION_ERROR",
            message: errMsg(e),
          }),
      }).pipe(Effect.result);

      if (verifiedResult._tag === "Failure") {
        yield* recordRun({
          runId: verifyRunId,
          kind: "restore_verify",
          status: "failed",
          transportMode: config.transportMode,
          targetIds: [],
          fileCount: 0,
          rawBytes: 0,
          archiveBytes: 0,
          skippedSecretsCount: 0,
          skippedSecretsSample: [],
          manifestSha256: null,
          destinationPath: candidatePath,
          errorMessage: verifiedResult.failure.message,
          startedAtMs,
          finishedAtMs: Date.now(),
        });
        return yield* verifiedResult.failure;
      }

      const v = verifiedResult.success;
      yield* recordRun({
        runId: verifyRunId,
        kind: "restore_verify",
        status: "succeeded",
        transportMode: config.transportMode,
        targetIds: [v.manifest.targetId],
        fileCount: v.entries.length,
        rawBytes: v.entries.reduce((sum, e) => sum + e.content.byteLength, 0),
        archiveBytes: NodeFs.statSync(candidatePath).size,
        skippedSecretsCount: 0,
        skippedSecretsSample: [],
        manifestSha256: v.manifestSha256,
        destinationPath: candidatePath,
        errorMessage: null,
        startedAtMs,
        finishedAtMs: Date.now(),
      });

      return {
        verified: true,
        runId: resolvedRunId,
        archivePath: candidatePath,
        encrypted: v.encrypted,
        verifiedFilesCount: v.entries.length,
        manifestSha256: v.manifestSha256,
        message: `복구 무결성 검증 통과: ${v.entries.length}개 파일 SHA-256 일치${v.encrypted ? " (AES-256-GCM 복호화 확인)" : ""}`,
      };
    });

  const syncKnowledgeMirror = (
    input: DriveBackupSyncMirrorInput,
  ): Effect.Effect<DriveBackupSyncMirrorResult, DriveBackupError> =>
    Effect.gen(function* () {
      const cfgRow = yield* ensureConfigRow();
      const config = yield* mapConfigRow(cfgRow);
      const startedAtMs = Date.now();
      const runId = `drvmir_${formatStamp(startedAtMs)}_${NodeCrypto.randomUUID().slice(0, 6)}`;

      const items = yield* Effect.gen(function* () {
        if (config.transportMode === "local_drive_folder") {
          if (!config.localDriveRoot) {
            return yield* new DriveBackupError({
              code: "INVALID_STATE",
              message: "로컬 Google Drive 폴더 경로가 설정되어 있지 않습니다.",
            });
          }
          return listLocalKnowledgeMirrorFiles(
            config.localDriveRoot,
            config.gdriveKnowledgeFolderName,
          );
        }
        const oauth = yield* readOAuthCredentials();
        if (!oauth) {
          return yield* new DriveBackupError({
            code: "AUTH_REQUIRED",
            message: "Google Drive API OAuth2 자격증명이 연결되어 있지 않습니다.",
          });
        }
        return yield* Effect.tryPromise({
          try: () =>
            downloadKnowledgeMirrorFromGoogleDriveApi(oauth, config.gdriveKnowledgeFolderName),
          catch: (e) =>
            new DriveBackupError({
              code: "TRANSPORT_ERROR",
              message: `드라이브 지식 폴더 동기화 실패: ${errMsg(e)}`,
            }),
        });
      });

      NodeFs.mkdirSync(mirrorLocalDir, { recursive: true });
      const resolvedMirrorRoot = NodePath.resolve(mirrorLocalDir);

      let syncedCount = 0;
      let skippedUnchangedCount = 0;
      let totalBytes = 0;

      for (const item of items) {
        const safeRel = item.remoteName
          .replace(/\\/g, "/")
          .split("/")
          .filter((seg) => seg.length > 0 && seg !== "." && seg !== "..")
          .map((seg) => seg.replace(/[<>:"|?*]/g, "_"))
          .join(NodePath.sep);
        if (!safeRel) continue;
        const destPath = NodePath.resolve(mirrorLocalDir, safeRel);
        if (!destPath.startsWith(resolvedMirrorRoot)) continue;

        const hash = sha256Hex(item.content);
        const existing = yield* sql<{ readonly sha256: string; readonly local_path: string }>`
          SELECT sha256, local_path FROM drive_mirror_objects WHERE object_id = ${item.objectId} LIMIT 1
        `.pipe(
          Effect.catch(() =>
            Effect.succeed(
              [] as ReadonlyArray<{ readonly sha256: string; readonly local_path: string }>,
            ),
          ),
        );

        if (
          !input.force &&
          existing[0] &&
          existing[0].sha256 === hash &&
          NodeFs.existsSync(existing[0].local_path)
        ) {
          skippedUnchangedCount += 1;
          continue;
        }

        NodeFs.mkdirSync(NodePath.dirname(destPath), { recursive: true });
        NodeFs.writeFileSync(destPath, item.content);
        const now = Date.now();
        yield* sql`
          INSERT INTO drive_mirror_objects (
            object_id, remote_name, local_path, sha256, size_bytes, synced_at_ms
          ) VALUES (
            ${item.objectId}, ${item.remoteName}, ${destPath}, ${hash}, ${item.content.byteLength}, ${now}
          )
          ON CONFLICT(object_id) DO UPDATE SET
            remote_name = excluded.remote_name,
            local_path = excluded.local_path,
            sha256 = excluded.sha256,
            size_bytes = excluded.size_bytes,
            synced_at_ms = excluded.synced_at_ms
        `.pipe(Effect.catch(() => Effect.void));

        syncedCount += 1;
        totalBytes += item.content.byteLength;
      }

      yield* recordRun({
        runId,
        kind: "knowledge_mirror",
        status: "succeeded",
        transportMode: config.transportMode,
        targetIds: [],
        fileCount: syncedCount,
        rawBytes: totalBytes,
        archiveBytes: totalBytes,
        skippedSecretsCount: 0,
        skippedSecretsSample: [],
        manifestSha256: null,
        destinationPath: mirrorLocalDir,
        errorMessage: null,
        startedAtMs,
        finishedAtMs: Date.now(),
      });

      return {
        syncedCount,
        skippedUnchangedCount,
        totalBytes,
        mirrorLocalDir,
        message:
          syncedCount > 0
            ? `Google Drive '${config.gdriveKnowledgeFolderName}'에서 ${syncedCount}개 문서를 로컬 지식 미러에 동기화했습니다 (변경 없음 ${skippedUnchangedCount}건).`
            : `새로운 변경 문서가 없습니다 (기존 동일 ${skippedUnchangedCount}건).`,
      };
    });

  const service: GoogleDriveBackupServiceShape = {
    getState,
    updateConfig,
    upsertTarget,
    deleteTarget,
    dryRun,
    runNow,
    verifyRestore,
    syncKnowledgeMirror,
  };

  return service;
});

export const GoogleDriveBackupServiceLive = Layer.effect(
  GoogleDriveBackupService,
  makeGoogleDriveBackupService,
);
