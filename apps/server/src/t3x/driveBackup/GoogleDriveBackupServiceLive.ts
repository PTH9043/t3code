// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off globalDate:off globalDateInEffect:off
import * as NodeCrypto from "node:crypto";
import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";
import {
  DriveBackupError,
  ProjectId,
  type DriveBackupAuthErrorCode,
  type DriveBackupConfig,
  type DriveBackupDeleteTargetInput,
  type DriveBackupDryRunInput,
  type DriveBackupDryRunResult,
  type DriveBackupDryRunTarget,
  type DriveBackupGetStateInput,
  type DriveBackupLiveProgress,
  type DriveBackupLiveProgressStage,
  type DriveBackupRunKind,
  type DriveBackupRunNowInput,
  type DriveBackupRunRecord,
  type DriveBackupRunStatus,
  type DriveBackupStateSnapshot,
  type DriveBackupSummaryStats,
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
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import { activeWorkRegistry } from "../../orchestration/ActiveWorkTracker.ts";
import { computeKeyFingerprint, sha256Hex } from "./DriveBackupCrypto.ts";
import {
  isForbiddenExchangeFile,
  syncKnowledgeMirrorViaGoogleDriveApi,
  type ExistingMirrorObjectState,
  type MirrorPersistedState,
} from "./DriveExchangeService.ts";
import {
  detectLocalGoogleDriveRoots,
  detectRiskWarningForFolder,
  scanSelectedDirectory,
  UNIFIED_USERDATA_DISPLAY_NAME,
  UNIFIED_USERDATA_TARGET_ID,
} from "./DriveBackupFilter.ts";
import {
  computeIncrementalDiff,
  parseIncrementalManifest,
  type IncrementalFileRecord,
  type IncrementalTargetManifest,
} from "./DriveBackupIncremental.ts";
import {
  buildProjectIdentity,
  discoverRelatedProjectMemoryFiles,
  resolveMatchingProjects,
  type ProjectCatalogRow,
  type RelatedMemoryDiscoveryResult,
} from "./DriveBackupProjectMemories.ts";
import {
  DAILY_QUOTA_STATE_KEY,
  DEFAULT_DAILY_UPLOAD_BUDGET_BYTES,
  DriveUploadQuotaExceededError,
  computeNextQuotaResumeAtMs,
  formatResumeTimeKst,
  getRolling24hUploadedBytes,
  markLedgerQuotaPaused,
  parseDailyUploadLedger,
  recordUploadedBytesInLedger,
  type DailyUploadLedger,
} from "./DriveBackupQuota.ts";
import {
  copyFileToLocalDriveFolder,
  copyKnowledgeFileToLocalDriveFolder,
  DEFAULT_MIRROR_MAX_FILE_BYTES,
  exchangeRefreshTokenForAccessToken,
  isInvalidGrantError,
  listLocalKnowledgeMirrorMetadata,
  OAuthTokenRefreshError,
  ResumableUploadPausedError,
  sanitizeKnowledgePathSegment,
  uploadFileResumableToGoogleDriveApi,
  uploadKnowledgeFileToGoogleDriveApi,
  type GdriveOAuthCredentials,
} from "./DriveTransportAdapter.ts";
import {
  GoogleDriveBackupService,
  type GoogleDriveBackupServiceShape,
} from "./GoogleDriveBackupService.ts";
import { checkFreeDiskSpaceBytes, isFullSnapshotDue } from "./DriveBackupIdleGate.ts";
import {
  runPackAndEncryptInWorker,
  runSqliteSnapshotInWorker,
  SnapshotPausedError,
} from "./DriveBackupWorkerHost.ts";
import { createGitBundleFileIfRepo } from "./ProjectArchivePacker.ts";
import { verifyAndExtractArchiveFile } from "./StreamingArchivePacker.ts";

const CONFIG_ROW_ID = "default";
const SECRET_PASSPHRASE_KEY = "drive_backup_passphrase";
const SECRET_GDRIVE_OAUTH_KEY = "drive_backup_gdrive_oauth";
const SECRET_GOOGLE_ACCOUNTS_KEY = "google-login-accounts";
const driveOAuthPerSubjectSecretKey = (subject: string) =>
  `${SECRET_GDRIVE_OAUTH_KEY}_${subject.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 64)}`;

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
  readonly last_auth_error_code?: DriveBackupAuthErrorCode | null;
  readonly last_auth_error_message?: string | null;
  readonly last_auth_error_at_ms?: number | null;
  readonly auto_schedule_enabled?: number;
  readonly idle_min_seconds?: number;
  readonly pause_on_battery?: number;
  readonly allowed_window_enabled?: number;
  readonly allowed_window_start_hour?: number;
  readonly allowed_window_end_hour?: number;
  readonly read_limit_mbps?: number;
  readonly upload_limit_mbps?: number;
  readonly worker_rss_limit_mb?: number;
  readonly full_snapshot_interval_days?: number;
  readonly snapshot_local_retention_count?: number;
  readonly last_full_snapshot_at_ms?: number | null;
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
  readonly sync_local_to_drive_knowledge?: number;
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
  readonly wal_growth_bytes?: number | null;
  readonly paused_count?: number;
  readonly resumed_from_checkpoint?: number;
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
    ...(row.wal_growth_bytes !== undefined
      ? {
          walGrowthBytes: row.wal_growth_bytes !== null ? Number(row.wal_growth_bytes) : null,
        }
      : {}),
    ...(row.paused_count !== undefined
      ? { pausedCount: Math.max(0, Number(row.paused_count ?? 0)) }
      : {}),
    ...(row.resumed_from_checkpoint !== undefined
      ? { resumedFromCheckpoint: Boolean(row.resumed_from_checkpoint) }
      : {}),
  };
}

function errMsg(cause: unknown): string {
  if (!(cause instanceof Error)) return String(cause);
  const parts: string[] = [cause.message || cause.name];
  let cur: unknown = (cause as Error & { readonly cause?: unknown }).cause;
  let depth = 0;
  while (cur && depth < 3) {
    depth += 1;
    if (cur instanceof Error) {
      const code = (cur as Error & { readonly code?: unknown }).code;
      const detail = [typeof code === "string" ? code : null, cur.message || null]
        .filter(Boolean)
        .join(" ");
      if (detail && !parts[0]!.includes(detail)) parts.push(detail);
      cur = (cur as Error & { readonly cause?: unknown }).cause;
    } else if (typeof cur === "object") {
      const rec = cur as Record<string, unknown>;
      const detail = [rec.code, rec.message].filter(Boolean).join(" ");
      if (detail && !parts[0]!.includes(detail)) parts.push(detail);
      break;
    } else {
      break;
    }
  }
  return parts.join(" ← ");
}

export const makeGoogleDriveBackupService = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const secretStore = yield* ServerSecretStore.ServerSecretStore;

  const mirrorLocalDir = NodePath.join(serverConfig.baseDir, "drive-mirror");
  const localStagingDir = NodePath.join(serverConfig.baseDir, "backups", "rolling");
  const snapshotStagingDir = NodePath.join(serverConfig.baseDir, "backups", "staging");
  // 백업·지식미러·교환소 동기화를 서버 인스턴스 내에서 단일 직렬(permit=1)로 보장
  const serialSemaphore = yield* Semaphore.make(1);

  const readSecretText = (name: string): Effect.Effect<string | null, never> =>
    secretStore.get(name).pipe(
      Effect.map((opt) => (Option.isSome(opt) ? Buffer.from(opt.value).toString("utf8") : null)),
      Effect.tapError((err) =>
        Effect.logWarning(`DriveBackup 시크릿 '${name}' 조회 실패: ${errMsg(err)}`),
      ),
      Effect.orElseSucceed(() => null),
    );

  const parseOAuthCredentialsJson = (
    raw: string | null,
    fallbackEmail?: string,
  ): (GdriveOAuthCredentials & { readonly connectedEmail?: string }) | null => {
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as Partial<
        GdriveOAuthCredentials & { readonly connectedEmail?: string }
      >;
      if (parsed.clientId && parsed.clientSecret && parsed.refreshToken) {
        const connectedEmail = parsed.connectedEmail ?? fallbackEmail;
        return {
          clientId: parsed.clientId,
          clientSecret: parsed.clientSecret,
          refreshToken: parsed.refreshToken,
          ...(connectedEmail ? { connectedEmail } : {}),
        };
      }
      return null;
    } catch {
      return null;
    }
  };

  const parseGoogleAccountsList = (
    raw: string | null,
  ): ReadonlyArray<{
    readonly subject?: string;
    readonly email?: string;
    readonly isDefault?: boolean;
    readonly driveBackupLinked?: boolean;
  }> => {
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  };

  const readOAuthCredentials = (): Effect.Effect<
    (GdriveOAuthCredentials & { readonly connectedEmail?: string }) | null,
    never
  > =>
    Effect.gen(function* () {
      const primary = parseOAuthCredentialsJson(yield* readSecretText(SECRET_GDRIVE_OAUTH_KEY));
      if (primary) return primary;

      // 주 키가 누락/손상된 경우 google-login-accounts의 계정별 Drive OAuth 시크릿에서 자동 복구
      const accounts = parseGoogleAccountsList(yield* readSecretText(SECRET_GOOGLE_ACCOUNTS_KEY));
      if (accounts.length === 0) return null;
      const candidates = [...accounts]
        .filter((a) => typeof a.subject === "string" && a.subject.length > 0)
        .sort((a, b) => {
          const score = (x: typeof a) => (x.driveBackupLinked ? 2 : 0) + (x.isDefault ? 1 : 0);
          return score(b) - score(a);
        });
      for (const acc of candidates) {
        const perSubjectRaw = yield* readSecretText(driveOAuthPerSubjectSecretKey(acc.subject!));
        const recovered = parseOAuthCredentialsJson(perSubjectRaw, acc.email);
        if (recovered) {
          yield* secretStore
            .set(
              SECRET_GDRIVE_OAUTH_KEY,
              Uint8Array.from(
                Buffer.from(
                  JSON.stringify({
                    ...recovered,
                    subject: acc.subject,
                  }),
                  "utf8",
                ),
              ),
            )
            .pipe(Effect.orElseSucceed(() => undefined));
          return recovered;
        }
      }
      return null;
    });

  const resolveDailyUploadBudgetBytes = (): number => {
    const raw = process.env.T3_DRIVE_BACKUP_DAILY_BUDGET_BYTES;
    if (raw) {
      const parsed = Number(raw);
      if (Number.isFinite(parsed) && parsed > 0) {
        return Math.floor(parsed);
      }
    }
    return DEFAULT_DAILY_UPLOAD_BUDGET_BYTES;
  };

  const loadDailyQuotaLedger = (nowMs = Date.now()): Effect.Effect<DailyUploadLedger, never> =>
    sql<{ readonly state_json: string }>`
      SELECT state_json FROM drive_exchange_state WHERE id = ${DAILY_QUOTA_STATE_KEY} LIMIT 1
    `.pipe(
      Effect.map((rows) => parseDailyUploadLedger(rows[0]?.state_json, nowMs)),
      Effect.orElseSucceed(() => parseDailyUploadLedger(null, nowMs)),
    );

  const saveDailyQuotaLedger = (ledger: DailyUploadLedger): Effect.Effect<void, never> =>
    sql`
      INSERT INTO drive_exchange_state (id, start_page_token, last_sync_at_ms, state_json)
      VALUES (${DAILY_QUOTA_STATE_KEY}, NULL, ${ledger.updatedAtMs}, ${JSON.stringify(ledger)})
      ON CONFLICT(id) DO UPDATE SET
        last_sync_at_ms = excluded.last_sync_at_ms,
        state_json = excluded.state_json
    `.pipe(
      Effect.asVoid,
      Effect.catch(() => Effect.void),
    );

  const recordDailyUploadedBytes = (bytes: number): Effect.Effect<void, never> =>
    Effect.gen(function* () {
      if (!Number.isFinite(bytes) || bytes <= 0) return;
      const now = Date.now();
      const current = yield* loadDailyQuotaLedger(now);
      const next = recordUploadedBytesInLedger(current, bytes, now);
      yield* saveDailyQuotaLedger(next);
    });

  const markDailyQuotaPaused = (retryAfterMs: number, reason: string): Effect.Effect<void, never> =>
    Effect.gen(function* () {
      const now = Date.now();
      const current = yield* loadDailyQuotaLedger(now);
      const next = markLedgerQuotaPaused(current, retryAfterMs, reason, now);
      yield* saveDailyQuotaLedger(next);
    });

  const checkDailyQuotaBeforeNewFile = (opts?: {
    readonly ignoreCooldown?: boolean;
  }): Effect.Effect<void, DriveBackupError> =>
    Effect.gen(function* () {
      const now = Date.now();
      const ledger = yield* loadDailyQuotaLedger(now);
      if (!opts?.ignoreCooldown && ledger.pausedUntilMs !== null && ledger.pausedUntilMs > now) {
        return yield* new DriveBackupError({
          code: "BUSY_DEFERRED",
          message:
            ledger.pauseReason ??
            `일일 750 GB 안전 한도 대기 중 — ${formatResumeTimeKst(ledger.pausedUntilMs)} 이후 남은 지점부터 자동 이어올리기`,
        });
      }
      const budgetBytes = resolveDailyUploadBudgetBytes();
      const usedBytes = getRolling24hUploadedBytes(ledger, now);
      if (usedBytes >= budgetBytes) {
        const retryAfterMs = computeNextQuotaResumeAtMs(ledger, budgetBytes, now);
        const quotaErr = new DriveUploadQuotaExceededError({
          kind: "daily_budget_reached",
          retryAfterMs,
          uploadedBytesInWindow: usedBytes,
        });
        yield* markDailyQuotaPaused(retryAfterMs, quotaErr.message);
        return yield* new DriveBackupError({
          code: "BUSY_DEFERRED",
          message: quotaErr.message,
        });
      }
    });

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
        gdriveConnectedEmail: row.gdrive_connected_email ?? oauth?.connectedEmail ?? null,
        gdriveHasCredentials: oauth !== null,
        encryptionEnabled: Boolean(row.encryption_enabled),
        keyFingerprint: row.key_fingerprint ?? null,
        retentionCount: Math.max(1, Number(row.retention_count ?? 7)),
        includeCoreSettings: Boolean(row.include_core_settings),
        includeCoreSqliteSnapshot: Boolean(row.include_core_sqlite_snapshot),
        includeEventArchives: Boolean(row.include_event_archives),
        autoSyncIdleOnly: Boolean(row.auto_sync_idle_only),
        lastAuthErrorCode: row.last_auth_error_code ?? null,
        lastAuthErrorMessage: row.last_auth_error_message ?? null,
        lastAuthErrorAtMs:
          row.last_auth_error_at_ms !== undefined && row.last_auth_error_at_ms !== null
            ? Number(row.last_auth_error_at_ms)
            : null,
        autoScheduleEnabled: Boolean(row.auto_schedule_enabled ?? 0),
        idleMinSeconds: Math.max(60, Number(row.idle_min_seconds ?? 600)),
        pauseOnBattery: Boolean(row.pause_on_battery ?? 1),
        allowedWindowEnabled: Boolean(row.allowed_window_enabled ?? 0),
        allowedWindowStartHour: Math.max(
          0,
          Math.min(23, Number(row.allowed_window_start_hour ?? 1)),
        ),
        allowedWindowEndHour: Math.max(0, Math.min(23, Number(row.allowed_window_end_hour ?? 6))),
        readLimitMBps: Math.max(0, Number(row.read_limit_mbps ?? 50)),
        uploadLimitMbps: Math.max(0, Number(row.upload_limit_mbps ?? 20)),
        workerRssLimitMb: Math.max(128, Number(row.worker_rss_limit_mb ?? 300)),
        fullSnapshotIntervalDays: Math.max(1, Number(row.full_snapshot_interval_days ?? 7)),
        snapshotLocalRetentionCount: Math.max(1, Number(row.snapshot_local_retention_count ?? 1)),
        lastFullSnapshotAtMs:
          row.last_full_snapshot_at_ms !== undefined && row.last_full_snapshot_at_ms !== null
            ? Number(row.last_full_snapshot_at_ms)
            : null,
        updatedAtMs: Number(row.updated_at_ms),
      };
    });

  const recordAuthError = (
    code: DriveBackupAuthErrorCode,
    message: string,
  ): Effect.Effect<void, never> => {
    const now = Date.now();
    return sql`
      UPDATE drive_backup_config SET
        last_auth_error_code = ${code},
        last_auth_error_message = ${message.slice(0, 500)},
        last_auth_error_at_ms = ${now},
        updated_at_ms = ${now}
      WHERE id = ${CONFIG_ROW_ID}
    `.pipe(
      Effect.asVoid,
      Effect.catch(() => Effect.void),
    );
  };

  const clearAuthError = (): Effect.Effect<void, never> =>
    sql`
      UPDATE drive_backup_config SET
        last_auth_error_code = NULL,
        last_auth_error_message = NULL,
        last_auth_error_at_ms = NULL
      WHERE id = ${CONFIG_ROW_ID}
    `.pipe(
      Effect.asVoid,
      Effect.catch(() => Effect.void),
    );

  const listProjectCatalog = (): Effect.Effect<ReadonlyArray<ProjectCatalogRow>, never> =>
    sql<ProjectCatalogRow>`
      SELECT project_id, title, workspace_root, deleted_at
      FROM projection_projects
    `.pipe(Effect.catch(() => Effect.succeed([] as ReadonlyArray<ProjectCatalogRow>)));

  interface TargetRelatedMemoriesSummary {
    readonly matchedProjectIds: ReadonlyArray<string>;
    readonly extraProjectRoots: ReadonlyArray<string>;
    readonly threadCount: number;
    readonly memoryCount: number;
    readonly knowledgeItemCount: number;
    readonly discovered: RelatedMemoryDiscoveryResult;
    readonly relatedMemorySources: ReadonlyArray<string>;
  }

  const EMPTY_DISCOVERED_MEMORIES: RelatedMemoryDiscoveryResult = {
    files: [],
    totalFiles: 0,
    totalBytes: 0,
    knowledgeEligibleFiles: 0,
    knowledgeEligibleBytes: 0,
    blockedSecretsCount: 0,
    blockedSecretsSample: [],
    sourceLabels: [],
    countsBySource: {
      t3MemoryV2: 0,
      t3GlobalMemory: 0,
      t3ColdArchive: 0,
      claude: 0,
      codex: 0,
      grok: 0,
    },
    warnings: [],
  };

  const summarizeTargetRelatedMemories = (
    row: Pick<TargetRow, "id" | "kind" | "project_id" | "display_name" | "root_path">,
    projectCatalog?: ReadonlyArray<ProjectCatalogRow>,
  ): Effect.Effect<TargetRelatedMemoriesSummary, never> =>
    Effect.gen(function* () {
      if (row.id === UNIFIED_USERDATA_TARGET_ID || row.kind === "userdata") {
        return {
          matchedProjectIds: [],
          extraProjectRoots: [],
          threadCount: 0,
          memoryCount: 0,
          knowledgeItemCount: 0,
          discovered: EMPTY_DISCOVERED_MEMORIES,
          relatedMemorySources: [],
        };
      }

      const catalog = projectCatalog ?? (yield* listProjectCatalog());
      const matchedRows = resolveMatchingProjects(
        {
          projectId: row.project_id,
          displayName: row.display_name,
          rootPath: row.root_path,
        },
        catalog,
      );
      const matchedProjectIds = [
        ...new Set([
          ...(row.project_id ? [row.project_id] : []),
          ...matchedRows.map((m) => m.project_id),
        ]),
      ];
      const extraProjectRoots = matchedRows
        .map((m) => m.workspace_root)
        .filter((p) => p && p.trim().length > 0);

      let threadCount = 0;
      let memoryCount = 0;
      let knowledgeItemCount = 0;
      for (const pid of matchedProjectIds) {
        threadCount += yield* sql<{ readonly cnt: number }>`
          SELECT COUNT(*) AS cnt FROM projection_threads
          WHERE project_id = ${pid} AND deleted_at IS NULL
        `.pipe(
          Effect.map((rows) => Math.max(0, Number(rows[0]?.cnt ?? 0))),
          Effect.catch(() => Effect.succeed(0)),
        );
        memoryCount += yield* sql<{ readonly cnt: number }>`
          SELECT COUNT(*) AS cnt FROM workspace_memory_v2
          WHERE project_id = ${pid}
        `.pipe(
          Effect.map((rows) => Math.max(0, Number(rows[0]?.cnt ?? 0))),
          Effect.catch(() => Effect.succeed(0)),
        );
        knowledgeItemCount += yield* sql<{ readonly cnt: number }>`
          SELECT COUNT(*) AS cnt FROM projection_workspace_knowledge_items
          WHERE project_id = ${pid}
        `.pipe(
          Effect.map((rows) => Math.max(0, Number(rows[0]?.cnt ?? 0))),
          Effect.catch(() => Effect.succeed(0)),
        );
      }

      const discovered = discoverRelatedProjectMemoryFiles({
        displayName: row.display_name,
        rootPath: row.root_path,
        matchedProjectIds,
        extraProjectRoots,
        stateDir: serverConfig.stateDir,
      });

      const sources: string[] = [];
      if (threadCount > 0 || memoryCount > 0 || knowledgeItemCount > 0) {
        sources.push("T3 DB");
      }
      for (const label of discovered.sourceLabels) {
        if (!sources.includes(label)) sources.push(label);
      }

      return {
        matchedProjectIds,
        extraProjectRoots,
        threadCount,
        memoryCount,
        knowledgeItemCount,
        discovered,
        relatedMemorySources: sources,
      };
    });

  const hydrateTarget = (
    row: TargetRow,
    projectCatalog?: ReadonlyArray<ProjectCatalogRow>,
  ): Effect.Effect<DriveBackupTarget, never> =>
    Effect.gen(function* () {
      const existsOnDisk = NodeFs.existsSync(row.root_path);
      const isGitRepo = existsOnDisk && NodeFs.existsSync(NodePath.join(row.root_path, ".git"));
      const summary = yield* summarizeTargetRelatedMemories(row, projectCatalog);
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
        syncLocalToDriveKnowledge: Boolean(row.sync_local_to_drive_knowledge ?? 0),
        excludeGlobs: parseJsonStringArray(row.exclude_globs_json),
        riskWarning: detectRiskWarningForFolder(row.display_name, row.root_path),
        threadCount: summary.threadCount,
        memoryCount: summary.memoryCount,
        knowledgeItemCount: summary.knowledgeItemCount,
        externalMemoryFilesCount: summary.discovered.totalFiles,
        relatedMemorySources: [...summary.relatedMemorySources],
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
                0, 1, 1, 0,
                '[]', NULL, ${now}
              )
            `.pipe(Effect.catch(() => Effect.void));
          }
        }
      }

      // 기존 10개로 쪼개져 있던 개별 userdata:* 후보군을 단일 통합 항목('userdata:all') 1개로 자동 정리·이관한다.
      // (시크릿·로그·데스크톱 프로필·WAL/SHM·백업 스테이징은 하드 제외, state.sqlite/watchdog-journal/월별 아카이브는 워커 스냅샷으로 안전 포함)
      const legacyUserdataRows = yield* sql<{
        readonly id: string;
        readonly enabled: number;
        readonly last_backed_up_at_ms: number | null;
      }>`
        SELECT id, enabled, last_backed_up_at_ms
        FROM drive_backup_targets
        WHERE id LIKE 'userdata:%' AND id != ${UNIFIED_USERDATA_TARGET_ID}
      `.pipe(
        Effect.catch(() =>
          Effect.succeed(
            [] as ReadonlyArray<{
              readonly id: string;
              readonly enabled: number;
              readonly last_backed_up_at_ms: number | null;
            }>,
          ),
        ),
      );
      let inheritedEnabled = false;
      let inheritedLastBackedUpAtMs: number | null = null;
      if (legacyUserdataRows.length > 0) {
        for (const lr of legacyUserdataRows) {
          if (lr.enabled) inheritedEnabled = true;
          if (
            lr.last_backed_up_at_ms !== null &&
            (inheritedLastBackedUpAtMs === null ||
              lr.last_backed_up_at_ms > inheritedLastBackedUpAtMs)
          ) {
            inheritedLastBackedUpAtMs = lr.last_backed_up_at_ms;
          }
        }
        yield* sql`
          DELETE FROM drive_backup_targets
          WHERE id LIKE 'userdata:%' AND id != ${UNIFIED_USERDATA_TARGET_ID}
        `.pipe(Effect.catch(() => Effect.void));
      }

      if (serverConfig.stateDir && NodeFs.existsSync(serverConfig.stateDir)) {
        const stateKey = normalizePathKey(serverConfig.stateDir);
        const existingUnified = yield* sql<{ readonly id: string; readonly enabled: number }>`
          SELECT id, enabled FROM drive_backup_targets WHERE id = ${UNIFIED_USERDATA_TARGET_ID} LIMIT 1
        `.pipe(
          Effect.catch(() =>
            Effect.succeed([] as ReadonlyArray<{ readonly id: string; readonly enabled: number }>),
          ),
        );
        if (!existingUnified[0]) {
          knownPaths.add(stateKey);
          yield* sql`
            INSERT OR IGNORE INTO drive_backup_targets (
              id, kind, project_id, display_name, root_path,
              enabled, sync_files, sync_t3_scope, sync_drive_to_local_rag,
              sync_local_to_drive_knowledge, exclude_globs_json, last_backed_up_at_ms, updated_at_ms
            ) VALUES (
              ${UNIFIED_USERDATA_TARGET_ID}, 'userdata', NULL, ${UNIFIED_USERDATA_DISPLAY_NAME}, ${serverConfig.stateDir},
              ${inheritedEnabled ? 1 : 0}, 1, 0, 0,
              0, '[]', ${inheritedLastBackedUpAtMs}, ${now}
            )
          `.pipe(Effect.catch(() => Effect.void));
        } else if (inheritedEnabled && !existingUnified[0].enabled) {
          yield* sql`
            UPDATE drive_backup_targets
            SET enabled = 1, updated_at_ms = ${now}
            WHERE id = ${UNIFIED_USERDATA_TARGET_ID}
          `.pipe(Effect.catch(() => Effect.void));
        }
      }
    });

  const exportRelatedT3ScopeJson = (input: {
    readonly targetId: string;
    readonly displayName: string;
    readonly rootPath: string;
    readonly summary: TargetRelatedMemoriesSummary;
  }): Effect.Effect<Buffer | null, never> =>
    Effect.gen(function* () {
      const { matchedProjectIds, discovered } = input.summary;
      if (matchedProjectIds.length === 0 && discovered.totalFiles === 0) {
        return null;
      }

      const projects: unknown[] = [];
      const threadRows: Array<{ readonly thread_id: string }> = [];
      const messages: unknown[] = [];
      const memories: unknown[] = [];
      const knowledgeItems: unknown[] = [];
      const wikiLinks: unknown[] = [];
      const wikiBindings: unknown[] = [];
      const routingNodes: unknown[] = [];
      const routingEdges: unknown[] = [];
      const missionRuns: unknown[] = [];
      const missionReports: unknown[] = [];

      for (const pid of matchedProjectIds) {
        const pRows = yield* sql`
          SELECT * FROM projection_projects WHERE project_id = ${pid}
        `.pipe(Effect.catch(() => Effect.succeed([] as ReadonlyArray<unknown>)));
        for (const r of pRows) projects.push(r);

        const tRows = yield* sql<{ readonly thread_id: string }>`
          SELECT * FROM projection_threads
          WHERE project_id = ${pid} AND deleted_at IS NULL
          ORDER BY updated_at DESC LIMIT 300
        `.pipe(
          Effect.catch(() => Effect.succeed([] as ReadonlyArray<{ readonly thread_id: string }>)),
        );
        for (const t of tRows) threadRows.push(t);

        const mRows = yield* sql`
          SELECT * FROM workspace_memory_v2
          WHERE project_id = ${pid}
          ORDER BY updated_at DESC LIMIT 50000
        `.pipe(Effect.catch(() => Effect.succeed([] as ReadonlyArray<unknown>)));
        for (const m of mRows) memories.push(m);

        const kRows = yield* sql`
          SELECT * FROM projection_workspace_knowledge_items
          WHERE project_id = ${pid}
          ORDER BY updated_at DESC LIMIT 10000
        `.pipe(Effect.catch(() => Effect.succeed([] as ReadonlyArray<unknown>)));
        for (const k of kRows) knowledgeItems.push(k);

        const wlRows = yield* sql`
          SELECT * FROM projection_workspace_wiki_links
          WHERE project_id = ${pid}
          LIMIT 5000
        `.pipe(Effect.catch(() => Effect.succeed([] as ReadonlyArray<unknown>)));
        for (const wl of wlRows) wikiLinks.push(wl);

        const wbRows = yield* sql`
          SELECT * FROM workspace_wiki_bindings
          WHERE project_id = ${pid}
          LIMIT 5000
        `.pipe(Effect.catch(() => Effect.succeed([] as ReadonlyArray<unknown>)));
        for (const wb of wbRows) wikiBindings.push(wb);

        const rnRows = yield* sql`
          SELECT node_id, project_id, node_kind, canonical_key, title, summary_moc,
                 body_ref_kind, body_ref_id, epistemic_state, stale_status,
                 file_path, start_line, end_line, updated_at
          FROM workspace_routing_nodes
          WHERE project_id = ${pid}
          ORDER BY updated_at DESC LIMIT 20000
        `.pipe(Effect.catch(() => Effect.succeed([] as ReadonlyArray<unknown>)));
        for (const rn of rnRows) routingNodes.push(rn);

        const reRows = yield* sql`
          SELECT * FROM workspace_routing_edges
          WHERE project_id = ${pid}
          LIMIT 30000
        `.pipe(Effect.catch(() => Effect.succeed([] as ReadonlyArray<unknown>)));
        for (const re of reRows) routingEdges.push(re);

        const mrRows = yield* sql`
          SELECT * FROM mission_runs WHERE project_id = ${pid}
          ORDER BY created_at_ms DESC LIMIT 200
        `.pipe(Effect.catch(() => Effect.succeed([] as ReadonlyArray<unknown>)));
        for (const mr of mrRows) missionRuns.push(mr);

        const repRows = yield* sql`
          SELECT * FROM mission_reports WHERE project_id = ${pid}
          ORDER BY created_at_ms DESC LIMIT 200
        `.pipe(Effect.catch(() => Effect.succeed([] as ReadonlyArray<unknown>)));
        for (const rep of repRows) missionReports.push(rep);
      }

      for (const th of threadRows.slice(0, 80)) {
        const rows = yield* sql`
          SELECT * FROM projection_thread_messages
          WHERE thread_id = ${th.thread_id}
          ORDER BY created_at ASC LIMIT 200
        `.pipe(Effect.catch(() => Effect.succeed([] as ReadonlyArray<unknown>)));
        for (const r of rows) messages.push(r);
      }

      const globalMemories = yield* sql`
        SELECT * FROM workspace_memory_v2
        WHERE scope = 'global'
        ORDER BY updated_at DESC LIMIT 2000
      `.pipe(Effect.catch(() => Effect.succeed([] as ReadonlyArray<unknown>)));

      const environmentKnowledge = yield* sql`
        SELECT * FROM projection_workspace_knowledge_items
        WHERE scope = 'environment'
        ORDER BY updated_at DESC LIMIT 1000
      `.pipe(Effect.catch(() => Effect.succeed([] as ReadonlyArray<unknown>)));

      // living_memories 중 전역/핀 고정 항목 또는 해당 프로젝트 이름·경로가 언급된 증류 기억 선별
      const identity = buildProjectIdentity({
        displayName: input.displayName,
        rootPath: input.rootPath,
        extraPaths: input.summary.extraProjectRoots,
      });
      const rawLiving = yield* sql<{
        readonly scope?: string | null;
        readonly is_pinned?: number | null;
        readonly content_distilled?: string | null;
        readonly morpheme_tokens?: string | null;
      }>`
        SELECT * FROM living_memories
        WHERE expired_at IS NULL
        ORDER BY importance DESC, created_at DESC LIMIT 1000
      `.pipe(
        Effect.catch(() =>
          Effect.succeed(
            [] as ReadonlyArray<{
              readonly scope?: string | null;
              readonly is_pinned?: number | null;
              readonly content_distilled?: string | null;
              readonly morpheme_tokens?: string | null;
            }>,
          ),
        ),
      );

      const livingMemories = rawLiving.filter((lm) => {
        if (lm.scope === "global" || Boolean(lm.is_pinned)) return true;
        const haystack = `${lm.content_distilled ?? ""} ${lm.morpheme_tokens ?? ""}`.toLowerCase();
        for (const slug of identity.slugCandidates) {
          if (slug.length >= 4 && haystack.includes(slug)) return true;
        }
        if (identity.basenameLower && identity.basenameLower.length >= 4) {
          if (haystack.includes(identity.basenameLower)) return true;
        }
        return false;
      });

      const hasAnyContent =
        projects.length > 0 ||
        threadRows.length > 0 ||
        memories.length > 0 ||
        globalMemories.length > 0 ||
        knowledgeItems.length > 0 ||
        environmentKnowledge.length > 0 ||
        livingMemories.length > 0 ||
        discovered.totalFiles > 0;
      if (!hasAnyContent) return null;

      const payload = {
        schemaVersion: 2,
        exportedAtIso: new Date().toISOString(),
        targetId: input.targetId,
        displayName: input.displayName,
        rootPath: input.rootPath,
        projectId: matchedProjectIds[0] ?? null,
        matchedProjectIds: [...matchedProjectIds],
        project: projects[0] ?? null,
        projects,
        threads: threadRows,
        messages,
        memories,
        globalMemories,
        knowledgeItems,
        environmentKnowledge,
        wikiLinks,
        wikiBindings,
        routingNodes,
        routingEdges,
        livingMemories,
        missionRuns,
        missionReports,
        relatedMemorySources: [...input.summary.relatedMemorySources],
        discoveredMemoryFiles: discovered.files.map((f) => ({
          sourceKind: f.sourceKind,
          sourceLabel: f.sourceLabel,
          archivePath: f.archivePath,
          sizeBytes: f.sizeBytes,
        })),
      };
      return Buffer.from(JSON.stringify(payload, null, 2), "utf8");
    });

  const createWorkerSqliteSnapshot = (input: {
    readonly runId: string;
    readonly rssLimitMb: number;
    readonly signal?: AbortSignal;
  }): Effect.Effect<
    {
      readonly snapshotPath: string;
      readonly snapshotBytes: number;
      readonly walGrowthBytes: number;
    },
    DriveBackupError
  > =>
    Effect.gen(function* () {
      if (!serverConfig.dbPath || serverConfig.dbPath === ":memory:") {
        return yield* new DriveBackupError({
          code: "INVALID_STATE",
          message: "메모리 DB는 SQLite 스냅샷을 생성할 수 없습니다.",
        });
      }
      if (!NodeFs.existsSync(serverConfig.dbPath)) {
        return yield* new DriveBackupError({
          code: "NOT_FOUND",
          message: `SQLite DB 파일을 찾을 수 없습니다: ${serverConfig.dbPath}`,
        });
      }

      const dbStatSize = (() => {
        try {
          return NodeFs.statSync(serverConfig.dbPath).size;
        } catch {
          return 0;
        }
      })();
      const freeBytes = yield* Effect.tryPromise({
        try: () => checkFreeDiskSpaceBytes(snapshotStagingDir),
        catch: () => null,
      }).pipe(Effect.orElseSucceed(() => null));
      const requiredBytes = Math.max(dbStatSize * 2 + 128 * 1024 * 1024, 256 * 1024 * 1024);
      if (freeBytes !== null && freeBytes < requiredBytes) {
        return yield* new DriveBackupError({
          code: "INVALID_STATE",
          message: `스냅샷용 디스크 여유 공간이 부족합니다 (가용 ${(freeBytes / 1024 ** 3).toFixed(2)} GiB < 필요 ${(requiredBytes / 1024 ** 3).toFixed(2)} GiB).`,
        });
      }

      const outputPath = NodePath.join(snapshotStagingDir, `snap-${input.runId}.sqlite`);
      const snapResult = yield* Effect.tryPromise({
        try: () =>
          runSqliteSnapshotInWorker({
            dbPath: serverConfig.dbPath,
            outputPath,
            rssLimitMb: input.rssLimitMb,
            ...(input.signal ? { signal: input.signal } : {}),
          }),
        catch: (e) => {
          if (e instanceof SnapshotPausedError) {
            return new DriveBackupError({
              code: "BUSY_DEFERRED",
              message: e.message,
            });
          }
          return new DriveBackupError({
            code: "UNAVAILABLE",
            message: `SQLite 스냅샷 생성 실패: ${errMsg(e)}`,
          });
        },
      });

      return {
        snapshotPath: snapResult.outputPath,
        snapshotBytes: snapResult.snapshotBytes,
        walGrowthBytes: snapResult.walGrowthBytes,
      };
    });

  const listTargetRows = (): Effect.Effect<ReadonlyArray<TargetRow>, DriveBackupError> =>
    sql<TargetRow>`
      SELECT * FROM drive_backup_targets
      ORDER BY
        CASE
          WHEN id = ${UNIFIED_USERDATA_TARGET_ID} THEN 0
          WHEN kind = 'knowledge' THEN 1
          ELSE 2
        END,
        enabled DESC,
        kind ASC,
        display_name ASC
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
        started_at_ms, finished_at_ms,
        wal_growth_bytes, paused_count, resumed_from_checkpoint
      ) VALUES (
        ${record.runId}, ${record.kind}, ${record.status}, ${record.transportMode},
        ${JSON.stringify(record.targetIds)},
        ${record.fileCount}, ${record.rawBytes}, ${record.archiveBytes},
        ${record.skippedSecretsCount}, ${JSON.stringify(record.skippedSecretsSample)},
        ${record.manifestSha256}, ${record.destinationPath}, ${record.errorMessage},
        ${record.startedAtMs}, ${record.finishedAtMs},
        ${record.walGrowthBytes ?? null}, ${record.pausedCount ?? 0}, ${record.resumedFromCheckpoint ? 1 : 0}
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
        finished_at_ms = excluded.finished_at_ms,
        wal_growth_bytes = excluded.wal_growth_bytes,
        paused_count = excluded.paused_count,
        resumed_from_checkpoint = excluded.resumed_from_checkpoint
    `.pipe(
      Effect.asVoid,
      Effect.catch(() => Effect.void),
    );

  interface MutableLiveProgress {
    runId: string;
    stage: DriveBackupLiveProgressStage;
    targetId: string | null;
    targetDisplayName: string | null;
    completedTargets: number;
    totalTargets: number;
    uploadedBytes: number;
    totalBytes: number;
    resumedFromBytes: number;
    completedFiles: number;
    totalFiles: number;
    startedAtMs: number;
    transferStartedAtMs: number | null;
    updatedAtMs: number;
    shouldThrottleWhenBusy: boolean;
    baseUploadLimitMbps: number;
    note: string | null;
  }

  let activeLiveProgress: MutableLiveProgress | null = null;

  const computePercent = (
    uploadedBytes: number,
    totalBytes: number,
    completedFiles: number,
    totalFiles: number,
    completedTargets: number,
    totalTargets: number,
  ): number | null => {
    if (totalBytes > 0) {
      return Math.min(100, Math.max(0, Math.round((uploadedBytes / totalBytes) * 1000) / 10));
    }
    if (totalFiles > 0) {
      return Math.min(100, Math.max(0, Math.round((completedFiles / totalFiles) * 1000) / 10));
    }
    if (totalTargets > 0 && completedTargets > 0) {
      return Math.min(100, Math.max(0, Math.round((completedTargets / totalTargets) * 1000) / 10));
    }
    return null;
  };

  const buildLiveProgressFromMemory = (
    cur: MutableLiveProgress,
    activeWorkCount: number,
  ): DriveBackupLiveProgress => {
    const throttledByActiveWork = cur.shouldThrottleWhenBusy && activeWorkCount > 0;
    const effectiveUploadLimitMbps = throttledByActiveWork
      ? cur.baseUploadLimitMbps > 0
        ? Math.min(cur.baseUploadLimitMbps, 5)
        : 5
      : cur.baseUploadLimitMbps;
    const percent = computePercent(
      cur.uploadedBytes,
      cur.totalBytes,
      cur.completedFiles,
      cur.totalFiles,
      cur.completedTargets,
      cur.totalTargets,
    );
    let bytesPerSec: number | null = null;
    let etaSeconds: number | null = null;
    if (
      cur.transferStartedAtMs !== null &&
      cur.totalBytes > 0 &&
      cur.uploadedBytes > cur.resumedFromBytes
    ) {
      const elapsedSec = Math.max(0.5, (cur.updatedAtMs - cur.transferStartedAtMs) / 1000);
      const sentBytes = cur.uploadedBytes - cur.resumedFromBytes;
      const rate = sentBytes / elapsedSec;
      if (Number.isFinite(rate) && rate > 0) {
        bytesPerSec = Math.round(rate);
        const remaining = Math.max(0, cur.totalBytes - cur.uploadedBytes);
        etaSeconds = Math.ceil(remaining / rate);
      }
    }
    return {
      runId: cur.runId,
      status: "running",
      stage: cur.stage,
      targetId: cur.targetId,
      targetDisplayName: cur.targetDisplayName,
      completedTargets: cur.completedTargets,
      totalTargets: cur.totalTargets,
      uploadedBytes: Math.max(0, Math.round(cur.uploadedBytes)),
      totalBytes: Math.max(0, Math.round(cur.totalBytes)),
      resumedFromBytes: Math.max(0, Math.round(cur.resumedFromBytes)),
      completedFiles: cur.completedFiles,
      totalFiles: cur.totalFiles,
      percent,
      bytesPerSec,
      etaSeconds,
      startedAtMs: cur.startedAtMs,
      updatedAtMs: cur.updatedAtMs,
      throttledByActiveWork,
      effectiveUploadLimitMbps,
      note: cur.note,
    };
  };

  const loadFallbackCheckpointProgress = (
    targets: ReadonlyArray<DriveBackupTarget>,
    recentRuns: ReadonlyArray<DriveBackupRunRecord>,
    config: DriveBackupConfig,
    activeWorkCount: number,
  ): Effect.Effect<DriveBackupLiveProgress | null, never> =>
    sql<{
      readonly run_id: string;
      readonly stage: string;
      readonly target_id: string | null;
      readonly archive_path: string | null;
      readonly uploaded_offset_bytes: number;
      readonly total_bytes: number;
      readonly updated_at_ms: number;
    }>`
      SELECT run_id, stage, target_id, archive_path, uploaded_offset_bytes, total_bytes, updated_at_ms
      FROM drive_backup_checkpoints
      WHERE total_bytes > 0
      ORDER BY updated_at_ms DESC
      LIMIT 1
    `.pipe(
      Effect.map((rows): DriveBackupLiveProgress | null => {
        const cp = rows[0];
        if (!cp) return null;
        if (Date.now() - Number(cp.updated_at_ms) > 24 * 3_600_000) return null;
        if (cp.archive_path && !NodeFs.existsSync(cp.archive_path)) return null;
        const matchedRun = recentRuns.find((r) => r.runId === cp.run_id);
        const isRunning = matchedRun?.status === "running";
        const uploadedBytes = Math.max(0, Math.round(Number(cp.uploaded_offset_bytes ?? 0)));
        const totalBytes = Math.max(0, Math.round(Number(cp.total_bytes ?? 0)));
        const targetObj = cp.target_id ? targets.find((t) => t.id === cp.target_id) : undefined;
        const targetDisplayName =
          targetObj?.displayName ??
          (cp.target_id === "core:event-archives"
            ? "이벤트 아카이브"
            : cp.target_id === "core:t3-state"
              ? "T3 코어 상태"
              : cp.target_id);
        const throttledByActiveWork = config.autoSyncIdleOnly && activeWorkCount > 0;
        const effectiveUploadLimitMbps = throttledByActiveWork
          ? config.uploadLimitMbps > 0
            ? Math.min(config.uploadLimitMbps, 5)
            : 5
          : config.uploadLimitMbps;
        return {
          runId: cp.run_id,
          status: isRunning ? "running" : "paused",
          stage: isRunning ? "uploading" : "paused_checkpoint",
          targetId: cp.target_id,
          targetDisplayName: targetDisplayName ?? null,
          completedTargets: 0,
          totalTargets: Math.max(1, matchedRun?.targetIds.length ?? 1),
          uploadedBytes,
          totalBytes,
          resumedFromBytes: uploadedBytes,
          completedFiles: 0,
          totalFiles: 0,
          percent: computePercent(uploadedBytes, totalBytes, 0, 0, 0, 1),
          bytesPerSec: null,
          etaSeconds: null,
          startedAtMs: matchedRun?.startedAtMs ?? Number(cp.updated_at_ms),
          updatedAtMs: Number(cp.updated_at_ms),
          throttledByActiveWork,
          effectiveUploadLimitMbps,
          note: isRunning
            ? "진행 중 체크포인트 기준 표시"
            : (matchedRun?.errorMessage ??
              "중단 지점 체크포인트 보존됨 — 다음 실행 시 자동 이어올리기"),
        };
      }),
      Effect.catch(() => Effect.succeed(null)),
    );

  const loadBackupSummaryStats = (): Effect.Effect<DriveBackupSummaryStats, never> =>
    Effect.gen(function* () {
      const aggRows = yield* sql<{
        readonly cnt: number;
        readonly sum_archive: number;
        readonly sum_raw: number;
        readonly sum_files: number;
      }>`
        SELECT
          COUNT(*) AS cnt,
          COALESCE(SUM(archive_bytes), 0) AS sum_archive,
          COALESCE(SUM(raw_bytes), 0) AS sum_raw,
          COALESCE(SUM(file_count), 0) AS sum_files
        FROM drive_backup_runs
        WHERE kind = 'backup' AND status = 'succeeded'
      `.pipe(
        Effect.catch(() => Effect.succeed([{ cnt: 0, sum_archive: 0, sum_raw: 0, sum_files: 0 }])),
      );
      const lastRows = yield* sql<{
        readonly finished_at_ms: number | null;
        readonly started_at_ms: number;
        readonly archive_bytes: number;
        readonly raw_bytes: number;
        readonly file_count: number;
      }>`
        SELECT finished_at_ms, started_at_ms, archive_bytes, raw_bytes, file_count
        FROM drive_backup_runs
        WHERE kind = 'backup' AND status = 'succeeded'
        ORDER BY COALESCE(finished_at_ms, started_at_ms) DESC
        LIMIT 1
      `.pipe(
        Effect.catch(() =>
          Effect.succeed(
            [] as ReadonlyArray<{
              readonly finished_at_ms: number | null;
              readonly started_at_ms: number;
              readonly archive_bytes: number;
              readonly raw_bytes: number;
              readonly file_count: number;
            }>,
          ),
        ),
      );
      const agg = aggRows[0];
      const last = lastRows[0];
      return {
        succeededBackupCount: Math.max(0, Math.round(Number(agg?.cnt ?? 0))),
        totalBackedUpArchiveBytes: Math.max(0, Math.round(Number(agg?.sum_archive ?? 0))),
        totalBackedUpRawBytes: Math.max(0, Math.round(Number(agg?.sum_raw ?? 0))),
        totalBackedUpFiles: Math.max(0, Math.round(Number(agg?.sum_files ?? 0))),
        lastSucceededAtMs: last ? Number(last.finished_at_ms ?? last.started_at_ms) : null,
        lastSucceededArchiveBytes: Math.max(0, Math.round(Number(last?.archive_bytes ?? 0))),
        lastSucceededRawBytes: Math.max(0, Math.round(Number(last?.raw_bytes ?? 0))),
        lastSucceededFileCount: Math.max(0, Math.round(Number(last?.file_count ?? 0))),
      };
    });

  const getState = (
    input: DriveBackupGetStateInput,
  ): Effect.Effect<DriveBackupStateSnapshot, DriveBackupError> =>
    Effect.gen(function* () {
      const cfgRow = yield* ensureConfigRow();
      yield* syncRegisteredProjectCandidates(Boolean(input.includeArchivedProjects));
      const config = yield* mapConfigRow(cfgRow);
      const targetRows = yield* listTargetRows();
      const projectCatalog = yield* listProjectCatalog();
      const targets = yield* Effect.forEach(
        targetRows,
        (row) => hydrateTarget(row, projectCatalog),
        { concurrency: 4 },
      );
      const recentRuns = yield* listRecentRuns(20);
      const quotaLedger = yield* loadDailyQuotaLedger();
      const activeWorkCount = activeWorkRegistry.snapshot().totalActive;
      const liveProgress = activeLiveProgress
        ? buildLiveProgressFromMemory(activeLiveProgress, activeWorkCount)
        : yield* loadFallbackCheckpointProgress(targets, recentRuns, config, activeWorkCount);
      const backupSummary = yield* loadBackupSummaryStats();
      return {
        config,
        detectedLocalDriveRoots: [...detectLocalGoogleDriveRoots()],
        mirrorLocalDir,
        localStagingDir,
        activeWorkCount,
        dailyUploadedBytes: getRolling24hUploadedBytes(quotaLedger),
        dailyUploadBudgetBytes: resolveDailyUploadBudgetBytes(),
        quotaPausedUntilMs: quotaLedger.pausedUntilMs,
        liveProgress,
        backupSummary,
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
        } else if (input.passphraseBackupAcknowledged !== true) {
          return yield* new DriveBackupError({
            code: "INVALID_INPUT",
            message:
              "백업 비밀번호는 T3 밖(비밀번호 관리자 등)에 별도로 보관해야 복구할 수 있습니다. 보관 확인 후 저장해 주세요.",
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
          yield* clearAuthError();
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
      const nextAutoSchedule =
        input.autoScheduleEnabled !== undefined
          ? input.autoScheduleEnabled
            ? 1
            : 0
          : (current.auto_schedule_enabled ?? 0);
      const nextIdleMinSeconds =
        input.idleMinSeconds !== undefined
          ? Math.max(60, Math.min(86_400, Math.floor(input.idleMinSeconds)))
          : (current.idle_min_seconds ?? 600);
      const nextPauseOnBattery =
        input.pauseOnBattery !== undefined
          ? input.pauseOnBattery
            ? 1
            : 0
          : (current.pause_on_battery ?? 1);
      const nextAllowedWindowEnabled =
        input.allowedWindowEnabled !== undefined
          ? input.allowedWindowEnabled
            ? 1
            : 0
          : (current.allowed_window_enabled ?? 0);
      const nextAllowedWindowStart =
        input.allowedWindowStartHour !== undefined
          ? Math.max(0, Math.min(23, Math.floor(input.allowedWindowStartHour)))
          : (current.allowed_window_start_hour ?? 1);
      const nextAllowedWindowEnd =
        input.allowedWindowEndHour !== undefined
          ? Math.max(0, Math.min(23, Math.floor(input.allowedWindowEndHour)))
          : (current.allowed_window_end_hour ?? 6);
      const nextReadLimitMBps =
        input.readLimitMBps !== undefined
          ? Math.max(0, Math.min(2_000, Math.floor(input.readLimitMBps)))
          : (current.read_limit_mbps ?? 50);
      const nextUploadLimitMbps =
        input.uploadLimitMbps !== undefined
          ? Math.max(0, Math.min(10_000, Math.floor(input.uploadLimitMbps)))
          : (current.upload_limit_mbps ?? 20);
      const nextWorkerRssLimitMb =
        input.workerRssLimitMb !== undefined
          ? Math.max(128, Math.min(2_048, Math.floor(input.workerRssLimitMb)))
          : (current.worker_rss_limit_mb ?? 300);
      const nextFullSnapshotIntervalDays =
        input.fullSnapshotIntervalDays !== undefined
          ? Math.max(1, Math.min(90, Math.floor(input.fullSnapshotIntervalDays)))
          : (current.full_snapshot_interval_days ?? 7);
      const nextSnapshotLocalRetention =
        input.snapshotLocalRetentionCount !== undefined
          ? Math.max(1, Math.min(10, Math.floor(input.snapshotLocalRetentionCount)))
          : (current.snapshot_local_retention_count ?? 1);
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
          auto_schedule_enabled = ${nextAutoSchedule},
          idle_min_seconds = ${nextIdleMinSeconds},
          pause_on_battery = ${nextPauseOnBattery},
          allowed_window_enabled = ${nextAllowedWindowEnabled},
          allowed_window_start_hour = ${nextAllowedWindowStart},
          allowed_window_end_hour = ${nextAllowedWindowEnd},
          read_limit_mbps = ${nextReadLimitMBps},
          upload_limit_mbps = ${nextUploadLimitMbps},
          worker_rss_limit_mb = ${nextWorkerRssLimitMb},
          full_snapshot_interval_days = ${nextFullSnapshotIntervalDays},
          snapshot_local_retention_count = ${nextSnapshotLocalRetention},
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
          sync_local_to_drive_knowledge, exclude_globs_json, last_backed_up_at_ms, updated_at_ms
        ) VALUES (
          ${targetId}, ${input.kind}, ${input.projectId ?? null}, ${input.displayName.trim()}, ${rootPath},
          ${input.enabled ? 1 : 0}, ${input.syncFiles ? 1 : 0}, ${input.syncT3Scope ? 1 : 0},
          ${input.syncDriveToLocalRag ? 1 : 0}, ${input.syncLocalToDriveKnowledge ? 1 : 0},
          ${excludeGlobsJson}, NULL, ${now}
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
          sync_local_to_drive_knowledge = excluded.sync_local_to_drive_knowledge,
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

  const loadTargetManifest = (targetId: string) =>
    sql<{ readonly manifest_json: string }>`
      SELECT manifest_json FROM drive_backup_manifests WHERE target_id = ${targetId} LIMIT 1
    `.pipe(
      Effect.map((rows) => parseIncrementalManifest(rows[0]?.manifest_json)),
      Effect.catch(() => Effect.succeed(null)),
    );

  const saveTargetManifest = (
    targetId: string,
    manifestJson: string,
    manifestSha256: string,
    remoteFileId: string | null = null,
  ) =>
    sql`
      INSERT INTO drive_backup_manifests (
        target_id, manifest_json, manifest_sha256, remote_file_id, updated_at_ms
      ) VALUES (
        ${targetId}, ${manifestJson}, ${manifestSha256}, ${remoteFileId}, ${Date.now()}
      )
      ON CONFLICT(target_id) DO UPDATE SET
        manifest_json = excluded.manifest_json,
        manifest_sha256 = excluded.manifest_sha256,
        remote_file_id = COALESCE(excluded.remote_file_id, drive_backup_manifests.remote_file_id),
        updated_at_ms = excluded.updated_at_ms
    `.pipe(
      Effect.asVoid,
      Effect.catch(() => Effect.void),
    );

  const uploadLocalKnowledgeForTarget = (opts: {
    readonly row: TargetRow;
    readonly config: DriveBackupConfig;
    readonly oauthCreds: GdriveOAuthCredentials | null;
    readonly accessToken?: string;
    readonly createdAtIso: string;
    readonly pauseSignal?: AbortSignal;
    readonly ignoreQuotaCooldown?: boolean;
    readonly projectCatalog?: ReadonlyArray<ProjectCatalogRow>;
    readonly onProgress?: (progress: {
      readonly completedFiles: number;
      readonly totalFiles: number;
      readonly uploadedBytes: number;
      readonly totalBytes: number;
    }) => void;
  }): Effect.Effect<
    {
      readonly uploadedCount: number;
      readonly skippedUnchangedCount: number;
      readonly uploadedBytes: number;
      readonly blockedSecretsCount: number;
      readonly blockedSecretsSample: ReadonlyArray<string>;
      readonly lastDestPath: string | null;
    },
    DriveBackupError
  > =>
    Effect.gen(function* () {
      const rootExists = NodeFs.existsSync(opts.row.root_path);
      const scanned = rootExists
        ? scanSelectedDirectory({
            rootPath: opts.row.root_path,
            customExcludeGlobs: parseJsonStringArray(opts.row.exclude_globs_json),
            maxSingleFileBytes: DEFAULT_MIRROR_MAX_FILE_BYTES,
            excludeSqliteFiles: true,
          })
        : {
            includedFiles: [],
            totalRawBytes: 0,
            blockedSecretsCount: 0,
            blockedSecretsSample: [],
            warnings: [],
          };

      const combinedFiles: Array<{
        readonly absolutePath: string;
        readonly relativePath: string;
        readonly sizeBytes: number;
        readonly mtimeMs: number;
      }> = [...scanned.includedFiles];
      let combinedBlockedSecretsCount = scanned.blockedSecretsCount;
      const combinedBlockedSecretsSample = [...scanned.blockedSecretsSample];

      if (opts.row.sync_t3_scope && opts.row.id !== UNIFIED_USERDATA_TARGET_ID) {
        const relSummary = yield* summarizeTargetRelatedMemories(opts.row, opts.projectCatalog);
        combinedBlockedSecretsCount += relSummary.discovered.blockedSecretsCount;
        for (const sample of relSummary.discovered.blockedSecretsSample) {
          if (combinedBlockedSecretsSample.length < 10) {
            combinedBlockedSecretsSample.push(sample);
          }
        }
        for (const mf of relSummary.discovered.files) {
          if (!mf.knowledgeRelativePath) continue;
          if (mf.sizeBytes > DEFAULT_MIRROR_MAX_FILE_BYTES) continue;
          combinedFiles.push({
            absolutePath: mf.absolutePath,
            relativePath: `_memories/${mf.knowledgeRelativePath}`,
            sizeBytes: mf.sizeBytes,
            mtimeMs: mf.mtimeMs,
          });
        }
      }

      if (combinedFiles.length === 0) {
        return {
          uploadedCount: 0,
          skippedUnchangedCount: 0,
          uploadedBytes: 0,
          blockedSecretsCount: combinedBlockedSecretsCount,
          blockedSecretsSample: combinedBlockedSecretsSample,
          lastDestPath: null,
        };
      }

      const manifestKey = `knowledge-upload:${opts.row.id}`;
      const prevManifest = yield* loadTargetManifest(manifestKey);
      const diff = yield* Effect.tryPromise({
        try: () =>
          computeIncrementalDiff({
            targetId: manifestKey,
            files: combinedFiles,
            previousManifest: prevManifest,
            nowIso: opts.createdAtIso,
            ...(opts.pauseSignal ? { signal: opts.pauseSignal } : {}),
          }),
        catch: (e) =>
          new DriveBackupError({
            code: opts.pauseSignal?.aborted ? "BUSY_DEFERRED" : "UNAVAILABLE",
            message: `지식 폴더 증분 비교 실패 (${opts.row.display_name}): ${errMsg(e)}`,
          }),
      });

      const skippedUnchangedCount = Math.max(0, combinedFiles.length - diff.changedFiles.length);
      if (diff.changedFiles.length === 0) {
        yield* saveTargetManifest(manifestKey, diff.nextManifestJson, diff.nextManifestSha256);
        return {
          uploadedCount: 0,
          skippedUnchangedCount,
          uploadedBytes: 0,
          blockedSecretsCount: combinedBlockedSecretsCount,
          blockedSecretsSample: combinedBlockedSecretsSample,
          lastDestPath: null,
        };
      }

      const folderPrefix = sanitizeKnowledgePathSegment(opts.row.display_name || opts.row.id);
      let cachedAccessToken = opts.accessToken;
      if (opts.config.transportMode === "gdrive_api" && !cachedAccessToken) {
        if (!opts.oauthCreds) {
          return yield* new DriveBackupError({
            code: "AUTH_REQUIRED",
            message: "Google Drive API OAuth2 자격증명이 연결되어 있지 않습니다.",
          });
        }
        cachedAccessToken = yield* Effect.tryPromise({
          try: () => exchangeRefreshTokenForAccessToken(opts.oauthCreds!),
          catch: (e) =>
            new DriveBackupError({
              code: "AUTH_REQUIRED",
              message: errMsg(e),
            }),
        }).pipe(
          Effect.tapError((err) =>
            recordAuthError(
              isInvalidGrantError(err.message) ? "invalid_grant" : "auth_failed",
              err.message,
            ),
          ),
        );
      }

      let uploadedCount = 0;
      let uploadedBytes = 0;
      let lastDestPath: string | null = null;
      const runQuotaEffect = Effect.runPromiseWith(yield* Effect.context<never>());
      // 파일 1건 업로드 완료 즉시 점진 매니페스트를 갱신해 중간 한도 도달/끊김 시 앞선 파일 재전송을 0건으로 막는다.
      const rollingFiles: Record<string, IncrementalFileRecord> = {
        ...(prevManifest?.files ?? {}),
      };
      const persistIncrementalFile = (file: (typeof diff.changedFiles)[number]) => {
        rollingFiles[file.relativePath] = {
          path: file.relativePath,
          sizeBytes: file.sizeBytes,
          mtimeMs: Math.floor(file.mtimeMs),
          sha256: file.sha256,
        };
        const partialManifest: IncrementalTargetManifest = {
          schemaVersion: 1,
          targetId: manifestKey,
          updatedAtIso: opts.createdAtIso,
          files: { ...rollingFiles },
        };
        const partialJson = JSON.stringify(partialManifest);
        return saveTargetManifest(manifestKey, partialJson, sha256Hex(partialJson));
      };

      for (const file of diff.changedFiles) {
        if (isForbiddenExchangeFile(file.relativePath)) continue;
        const relPosix = file.relativePath.replace(/\\/g, "/");
        const slashIdx = relPosix.lastIndexOf("/");
        const dirPart = slashIdx >= 0 ? relPosix.slice(0, slashIdx) : "";
        const fileName = slashIdx >= 0 ? relPosix.slice(slashIdx + 1) : relPosix;
        const subFolder = dirPart ? `${folderPrefix}/${dirPart}` : folderPrefix;

        if (opts.config.transportMode === "local_drive_folder") {
          if (!opts.config.localDriveRoot) {
            return yield* new DriveBackupError({
              code: "INVALID_STATE",
              message: "로컬 Google Drive 폴더 경로가 설정되어 있지 않습니다.",
            });
          }
          const copied = yield* Effect.tryPromise({
            try: () =>
              copyKnowledgeFileToLocalDriveFolder(
                opts.config.localDriveRoot!,
                opts.config.gdriveKnowledgeFolderName,
                {
                  subFolder,
                  fileName,
                  filePath: file.absolutePath,
                  uploadLimitMbps: opts.config.uploadLimitMbps,
                  getUploadLimitMbps: () => {
                    const base = opts.config.uploadLimitMbps;
                    if (
                      opts.config.autoSyncIdleOnly &&
                      activeWorkRegistry.snapshot().totalActive > 0
                    ) {
                      return base > 0 ? Math.min(base, 5) : 5;
                    }
                    return base;
                  },
                  ...(opts.pauseSignal ? { signal: opts.pauseSignal } : {}),
                },
              ),
            catch: (e) =>
              new DriveBackupError({
                code: opts.pauseSignal?.aborted ? "BUSY_DEFERRED" : "TRANSPORT_ERROR",
                message: `지식 파일 로컬 복사 실패 (${file.relativePath}): ${errMsg(e)}`,
              }),
          });
          uploadedCount += 1;
          uploadedBytes += copied.bytesCopied;
          lastDestPath = copied.destinationPath;
          yield* persistIncrementalFile(file);
        } else {
          // 다음 새 파일 시작 전 24시간 안전 업로드 예산(기본 700 GiB) 검사
          yield* checkDailyQuotaBeforeNewFile({
            ignoreCooldown: Boolean(opts.ignoreQuotaCooldown),
          });
          let remoteQuotaPause: DriveUploadQuotaExceededError | null = null;
          const uploaded = yield* Effect.tryPromise({
            try: () =>
              uploadKnowledgeFileToGoogleDriveApi(
                opts.oauthCreds!,
                opts.config.gdriveKnowledgeFolderName,
                {
                  subFolder,
                  fileName,
                  filePath: file.absolutePath,
                  uploadLimitMbps: opts.config.uploadLimitMbps,
                  getUploadLimitMbps: () => {
                    const base = opts.config.uploadLimitMbps;
                    if (
                      opts.config.autoSyncIdleOnly &&
                      activeWorkRegistry.snapshot().totalActive > 0
                    ) {
                      return base > 0 ? Math.min(base, 5) : 5;
                    }
                    return base;
                  },
                  ...(cachedAccessToken ? { accessToken: cachedAccessToken } : {}),
                  onChunkUploaded: (bytes) => runQuotaEffect(recordDailyUploadedBytes(bytes)),
                  ...(opts.pauseSignal ? { signal: opts.pauseSignal } : {}),
                },
              ),
            catch: (e) => {
              if (e instanceof DriveUploadQuotaExceededError) {
                remoteQuotaPause = e;
                return new DriveBackupError({
                  code: "BUSY_DEFERRED",
                  message: e.message,
                });
              }
              return new DriveBackupError({
                code:
                  e instanceof OAuthTokenRefreshError
                    ? "AUTH_REQUIRED"
                    : opts.pauseSignal?.aborted
                      ? "BUSY_DEFERRED"
                      : "TRANSPORT_ERROR",
                message:
                  e instanceof OAuthTokenRefreshError
                    ? e.message
                    : `지식 파일 업로드 실패 (${file.relativePath}): ${errMsg(e)}`,
              });
            },
          }).pipe(
            Effect.tapError((err) =>
              remoteQuotaPause
                ? markDailyQuotaPaused(remoteQuotaPause.retryAfterMs, remoteQuotaPause.message)
                : err.code === "AUTH_REQUIRED"
                  ? recordAuthError(
                      isInvalidGrantError(err.message) ? "invalid_grant" : "auth_failed",
                      err.message,
                    )
                  : Effect.void,
            ),
            Effect.tap(() => clearAuthError()),
          );
          uploadedCount += 1;
          uploadedBytes += uploaded.bytesUploaded;
          lastDestPath = uploaded.destinationPath;
          opts.onProgress?.({
            completedFiles: uploadedCount,
            totalFiles: diff.changedFiles.length,
            uploadedBytes,
            totalBytes: diff.changedFiles.reduce((acc, f) => acc + f.sizeBytes, 0),
          });
          yield* persistIncrementalFile(file);
        }
      }

      yield* saveTargetManifest(manifestKey, diff.nextManifestJson, diff.nextManifestSha256);
      const doneMs = Date.now();
      yield* sql`
        UPDATE drive_backup_targets
        SET last_backed_up_at_ms = ${doneMs}, updated_at_ms = ${doneMs}
        WHERE id = ${opts.row.id}
      `.pipe(Effect.catch(() => Effect.void));

      return {
        uploadedCount,
        skippedUnchangedCount,
        uploadedBytes,
        blockedSecretsCount: combinedBlockedSecretsCount,
        blockedSecretsSample: combinedBlockedSecretsSample,
        lastDestPath,
      };
    });

  const dryRun = (
    input: DriveBackupDryRunInput,
  ): Effect.Effect<DriveBackupDryRunResult, DriveBackupError> =>
    Effect.gen(function* () {
      const cfgRow = yield* ensureConfigRow();
      const config = yield* mapConfigRow(cfgRow);
      const allRows = yield* listTargetRows();
      const projectCatalog = yield* listProjectCatalog();
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

        const isUnifiedUserdata = row.id === UNIFIED_USERDATA_TARGET_ID;
        const uploadToKnowledge = Boolean(row.sync_local_to_drive_knowledge ?? 0);

        if (row.sync_files || uploadToKnowledge) {
          const scanned = scanSelectedDirectory({
            rootPath: row.root_path,
            customExcludeGlobs: excludeGlobs,
            unlimited: row.kind === "userdata",
            excludeSqliteFiles: isUnifiedUserdata || (!row.sync_files && uploadToKnowledge),
            ...(row.kind === "knowledge" || uploadToKnowledge
              ? { maxSingleFileBytes: DEFAULT_MIRROR_MAX_FILE_BYTES }
              : {}),
          });
          includedFilesCount = scanned.includedFiles.length;
          estimatedRawBytes = scanned.totalRawBytes;
          blockedSecretsCount = scanned.blockedSecretsCount;
          blockedSecretsSample = scanned.blockedSecretsSample;
          for (const w of scanned.warnings) warnings.push(w);
        }

        if (isUnifiedUserdata) {
          const addFileIfExists = (filePath: string) => {
            try {
              if (filePath && filePath !== ":memory:" && NodeFs.existsSync(filePath)) {
                const st = NodeFs.statSync(filePath);
                if (st.isFile()) {
                  includedFilesCount += 1;
                  estimatedRawBytes += st.size;
                }
              }
            } catch {
              // ignore
            }
          };
          addFileIfExists(NodePath.join(serverConfig.stateDir, "watchdog-journal.sqlite"));
          addFileIfExists(serverConfig.dbPath);
          addFileIfExists(serverConfig.settingsPath);
          addFileIfExists(serverConfig.keybindingsConfigPath);
          const archivesDir = NodePath.join(serverConfig.stateDir, "archives");
          if (NodeFs.existsSync(archivesDir)) {
            try {
              for (const d of NodeFs.readdirSync(archivesDir, { withFileTypes: true })) {
                if (d.isFile() && /^events-\d{6}\.sqlite$/i.test(d.name)) {
                  addFileIfExists(NodePath.join(archivesDir, d.name));
                }
              }
            } catch {
              // ignore
            }
          }
          warnings.push(
            "통합 백업: userdata 안전 폴더 + state.sqlite · watchdog-journal · 월별 아카이브 워커 스냅샷 + 설정 (시크릿·로그 자동 제외)",
          );
        }

        if (uploadToKnowledge) {
          const safeFolder = sanitizeKnowledgePathSegment(row.display_name || row.id);
          warnings.push(
            `원본 지식 업로드: Google Drive '${config.gdriveKnowledgeFolderName}/${safeFolder}'에 원본 파일 그대로 증분 업로드`,
          );
        }

        const relatedSummary =
          row.sync_t3_scope && !isUnifiedUserdata
            ? yield* summarizeTargetRelatedMemories(row, projectCatalog)
            : null;
        if (relatedSummary) {
          const hasDbScope =
            relatedSummary.matchedProjectIds.length > 0 || relatedSummary.discovered.totalFiles > 0;
          if (hasDbScope) {
            includedFilesCount += 1; // t3-scope/project-scope.json
            estimatedRawBytes +=
              relatedSummary.threadCount * 4_096 +
              relatedSummary.memoryCount * 512 +
              relatedSummary.knowledgeItemCount * 1_024;
          }
          includedFilesCount += relatedSummary.discovered.totalFiles;
          estimatedRawBytes += relatedSummary.discovered.totalBytes;
          if (relatedSummary.discovered.blockedSecretsCount > 0) {
            blockedSecretsCount += relatedSummary.discovered.blockedSecretsCount;
            blockedSecretsSample = [
              ...blockedSecretsSample,
              ...relatedSummary.discovered.blockedSecretsSample,
            ].slice(0, 10);
          }
          for (const w of relatedSummary.discovered.warnings) warnings.push(w);
          if (relatedSummary.relatedMemorySources.length > 0) {
            warnings.push(
              `연관 기억 통합 포함 (${relatedSummary.relatedMemorySources.join(" · ")}): DB 기억 ${relatedSummary.memoryCount.toLocaleString()}건 · 위키·지식 ${relatedSummary.knowledgeItemCount.toLocaleString()}건 · 기억 파일 ${relatedSummary.discovered.totalFiles.toLocaleString()}개`,
            );
          }
        }

        const isGitRepo =
          NodeFs.existsSync(row.root_path) &&
          NodeFs.existsSync(NodePath.join(row.root_path, ".git"));
        const estimatedArchiveBytes =
          !row.sync_files && uploadToKnowledge
            ? estimatedRawBytes
            : Math.max(0, Math.round(estimatedRawBytes * 0.35));

        targetResults.push({
          targetId: row.id,
          displayName: row.display_name,
          rootPath: row.root_path,
          enabled: Boolean(row.enabled),
          includedFilesCount,
          estimatedRawBytes,
          estimatedArchiveBytes,
          isGitRepo,
          t3ScopeThreadsCount: relatedSummary?.threadCount ?? 0,
          t3ScopeMemoriesCount: relatedSummary?.memoryCount ?? 0,
          t3ScopeKnowledgeCount: relatedSummary?.knowledgeItemCount ?? 0,
          relatedMemoryFilesCount: relatedSummary?.discovered.totalFiles ?? 0,
          relatedMemoryBytes: relatedSummary?.discovered.totalBytes ?? 0,
          relatedMemorySources: [...(relatedSummary?.relatedMemorySources ?? [])],
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

  const runBackupInternal = (
    input: DriveBackupRunNowInput,
    pauseSignal?: AbortSignal,
  ): Effect.Effect<DriveBackupRunRecord, DriveBackupError> =>
    serialSemaphore.withPermits(1)(
      Effect.gen(function* () {
        const cfgRow = yield* ensureConfigRow();
        const config = yield* mapConfigRow(cfgRow);
        const allRows = yield* listTargetRows();
        const projectCatalog = yield* listProjectCatalog();
        const filterSet =
          input.targetIds && input.targetIds.length > 0 ? new Set(input.targetIds) : null;
        const selectedRows = allRows.filter((row) =>
          filterSet ? filterSet.has(row.id) : Boolean(row.enabled),
        );

        const hasUnifiedUserdata = selectedRows.some((r) => r.id === UNIFIED_USERDATA_TARGET_ID);
        const hasRealDbFile = Boolean(
          serverConfig.dbPath &&
          serverConfig.dbPath !== ":memory:" &&
          NodeFs.existsSync(serverConfig.dbPath),
        );
        const effectiveIncludeCoreSettings = config.includeCoreSettings || hasUnifiedUserdata;
        const effectiveIncludeCoreSqliteSnapshot =
          config.includeCoreSqliteSnapshot || (hasUnifiedUserdata && hasRealDbFile);
        const effectiveIncludeEventArchives = config.includeEventArchives || hasUnifiedUserdata;

        const hasCoreWork =
          effectiveIncludeCoreSettings ||
          effectiveIncludeCoreSqliteSnapshot ||
          effectiveIncludeEventArchives;
        if (selectedRows.length === 0 && !hasCoreWork) {
          return yield* new DriveBackupError({
            code: "INVALID_STATE",
            message:
              "백업 대상으로 선택(ON)된 폴더나 저장소가 없습니다. 먼저 1개 이상의 대상을 활성화하세요.",
          });
        }

        const startedAtMs = Date.now();
        const runId = `drvrun_${formatStamp(startedAtMs)}_${NodeCrypto.randomUUID().slice(0, 6)}`;
        const targetIds = selectedRows.map((r) => r.id);

        // 활성 작업이 실행 중이어도 백업을 중단/양보하지 않고 저속 백그라운드 모드로 천천히 실행한다.
        // - 활성 작업 >= 1건 & autoSyncIdleOnly=true & !forceWhenBusy: 읽기 ≤10 MB/s · 업로드 ≤5 Mbps 동적 제한
        // - 활성 작업 0건으로 내려오면 즉시 원래 설정 속도(기본 50 MB/s · 20 Mbps)로 자동 복귀
        const shouldThrottleWhenBusy = config.autoSyncIdleOnly && !input.forceWhenBusy;
        const resolveEffectiveReadLimitMBps = (): number => {
          const base = config.readLimitMBps;
          if (!shouldThrottleWhenBusy) return base;
          if (activeWorkRegistry.snapshot().totalActive <= 0) return base;
          return base > 0 ? Math.min(base, 10) : 10;
        };
        const resolveEffectiveUploadLimitMbps = (): number => {
          const base = config.uploadLimitMbps;
          if (!shouldThrottleWhenBusy) return base;
          if (activeWorkRegistry.snapshot().totalActive <= 0) return base;
          return base > 0 ? Math.min(base, 5) : 5;
        };

        // 암호화 비밀번호 확인 (원본 지식 업로드만 수행하는 경우는 비밀번호 없이도 허용)
        const needsArchiveEncryption =
          hasCoreWork ||
          selectedRows.some(
            (r) =>
              Boolean(r.sync_files) ||
              (Boolean(r.sync_t3_scope) && r.id !== UNIFIED_USERDATA_TARGET_ID),
          );
        let passphrase: string | null = null;
        if (config.encryptionEnabled && needsArchiveEncryption) {
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

        // 일일 750 GB 안전 한도/403 쿨다운 대기 중이면 에러 대신 paused 상태로 깨끗하게 대기
        if (config.transportMode === "gdrive_api" && !input.forceWhenBusy) {
          const preQuota = yield* loadDailyQuotaLedger(startedAtMs);
          if (preQuota.pausedUntilMs !== null && preQuota.pausedUntilMs > startedAtMs) {
            const pausedRun: DriveBackupRunRecord = {
              runId,
              kind: "backup",
              status: "paused",
              transportMode: config.transportMode,
              targetIds,
              fileCount: 0,
              rawBytes: 0,
              archiveBytes: 0,
              skippedSecretsCount: 0,
              skippedSecretsSample: [],
              manifestSha256: null,
              destinationPath: null,
              errorMessage:
                preQuota.pauseReason ??
                `일일 750 GB 업로드 한도 대기 중 — ${formatResumeTimeKst(preQuota.pausedUntilMs)} 이후 남은 지점부터 자동 이어올리기`,
              startedAtMs,
              finishedAtMs: Date.now(),
              pausedCount: 1,
            };
            yield* recordRun(pausedRun);
            return pausedRun;
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

        activeLiveProgress = {
          runId,
          stage: "scanning",
          targetId: selectedRows[0]?.id ?? null,
          targetDisplayName: selectedRows[0]?.display_name ?? null,
          completedTargets: 0,
          totalTargets: selectedRows.length,
          uploadedBytes: 0,
          totalBytes: 0,
          resumedFromBytes: 0,
          completedFiles: 0,
          totalFiles: 0,
          startedAtMs,
          transferStartedAtMs: null,
          updatedAtMs: startedAtMs,
          shouldThrottleWhenBusy,
          baseUploadLimitMbps: config.uploadLimitMbps,
          note: null,
        };

        const updateLiveProgress = (patch: Partial<MutableLiveProgress>) => {
          if (!activeLiveProgress || activeLiveProgress.runId !== runId) return;
          Object.assign(activeLiveProgress, patch, { updatedAtMs: Date.now() });
        };

        let totalFiles = 0;
        let totalRawBytes = 0;
        let totalArchiveBytes = 0;
        let totalBlockedSecrets = 0;
        let totalWalGrowthBytes: number | null = null;
        let resumedFromCheckpoint = false;
        const blockedSamples: string[] = [];
        let lastManifestSha256: string | null = null;
        let lastDestPath: string | null = null;
        const stamp = formatStamp(startedAtMs);
        const createdAtIso = new Date(startedAtMs).toISOString();
        const runCheckpointEffect = Effect.runPromiseWith(yield* Effect.context<never>());

        const uploadArchiveFile = async (opts: {
          readonly targetId: string;
          readonly subFolder: string;
          readonly fileName: string;
          readonly stagedArchivePath: string;
          readonly localRetentionOverride?: number;
          readonly resumeSessionUri?: string | null;
          readonly resumeOffsetBytes?: number;
          readonly onCheckpoint?: (cp: {
            readonly sessionUri: string;
            readonly offsetBytes: number;
            readonly totalBytes: number;
          }) => Promise<void> | void;
        }) => {
          const localKeep = Math.max(
            1,
            opts.localRetentionOverride ?? Math.min(3, config.retentionCount),
          );
          // 1차: 로컬 롤링 백업(스냅샷은 별도 snapshotLocalRetentionCount 적용, 스트리밍 복사)
          const localCopy = await copyFileToLocalDriveFolder(localStagingDir, "local-rolling", {
            subFolder: opts.subFolder,
            fileName: opts.fileName,
            filePath: opts.stagedArchivePath,
            retentionCount: localKeep,
            ...(pauseSignal ? { signal: pauseSignal } : {}),
          });
          if (config.transportMode === "local_drive_folder") {
            return copyFileToLocalDriveFolder(config.localDriveRoot!, config.gdriveFolderName, {
              subFolder: opts.subFolder,
              fileName: opts.fileName,
              filePath: opts.stagedArchivePath,
              retentionCount: config.retentionCount,
              uploadLimitMbps: config.uploadLimitMbps,
              getUploadLimitMbps: resolveEffectiveUploadLimitMbps,
              ...(pauseSignal ? { signal: pauseSignal } : {}),
            });
          }
          const remote = await uploadFileResumableToGoogleDriveApi(
            oauthCreds!,
            config.gdriveFolderName,
            {
              subFolder: opts.subFolder,
              fileName: opts.fileName,
              filePath: opts.stagedArchivePath,
              retentionCount: config.retentionCount,
              uploadLimitMbps: config.uploadLimitMbps,
              getUploadLimitMbps: resolveEffectiveUploadLimitMbps,
              ...(opts.resumeSessionUri ? { resumeSessionUri: opts.resumeSessionUri } : {}),
              ...(opts.resumeOffsetBytes !== undefined
                ? { resumeOffsetBytes: opts.resumeOffsetBytes }
                : {}),
              ...(opts.onCheckpoint ? { onCheckpoint: opts.onCheckpoint } : {}),
              onChunkUploaded: (bytes) => runCheckpointEffect(recordDailyUploadedBytes(bytes)),
              ...(pauseSignal ? { signal: pauseSignal } : {}),
            },
          );
          return {
            destinationPath: `${remote.destinationPath} | local:${localCopy.destinationPath}`,
            prunedCount: remote.prunedCount,
          };
        };

        const saveCheckpoint = (cp: {
          readonly stage: string;
          readonly targetId: string | null;
          readonly snapshotPath?: string | null;
          readonly archivePath?: string | null;
          readonly uploadedOffsetBytes?: number;
          readonly totalBytes?: number;
          readonly resumableSessionUri?: string | null;
          readonly manifestSha256?: string | null;
        }) => {
          if (activeLiveProgress && activeLiveProgress.runId === runId) {
            const nextStage: DriveBackupLiveProgressStage =
              cp.stage === "snapshot" ? "snapshot" : "uploading";
            const nextUploaded =
              cp.uploadedOffsetBytes !== undefined
                ? Math.max(0, cp.uploadedOffsetBytes)
                : activeLiveProgress.uploadedBytes;
            const nextTotal =
              cp.totalBytes !== undefined && cp.totalBytes > 0
                ? cp.totalBytes
                : activeLiveProgress.totalBytes;
            updateLiveProgress({
              stage: nextStage,
              ...(cp.targetId ? { targetId: cp.targetId } : {}),
              uploadedBytes: nextUploaded,
              totalBytes: nextTotal,
              ...(nextStage === "uploading" && activeLiveProgress.transferStartedAtMs === null
                ? { transferStartedAtMs: Date.now(), resumedFromBytes: nextUploaded }
                : {}),
            });
          }
          return sql`
          INSERT INTO drive_backup_checkpoints (
            run_id, stage, target_id, snapshot_path, archive_path,
            entry_index, chunk_index, uploaded_offset_bytes, total_bytes,
            resumable_session_uri, session_expires_at_ms, manifest_sha256,
            payload_json, updated_at_ms
          ) VALUES (
            ${runId}, ${cp.stage}, ${cp.targetId}, ${cp.snapshotPath ?? null}, ${cp.archivePath ?? null},
            0, 0, ${cp.uploadedOffsetBytes ?? 0}, ${cp.totalBytes ?? 0},
            ${cp.resumableSessionUri ?? null}, ${cp.resumableSessionUri ? Date.now() + 6 * 86_400_000 : null},
            ${cp.manifestSha256 ?? null}, '{}', ${Date.now()}
          )
          ON CONFLICT(run_id) DO UPDATE SET
            stage = excluded.stage,
            target_id = excluded.target_id,
            snapshot_path = COALESCE(excluded.snapshot_path, drive_backup_checkpoints.snapshot_path),
            archive_path = COALESCE(excluded.archive_path, drive_backup_checkpoints.archive_path),
            uploaded_offset_bytes = excluded.uploaded_offset_bytes,
            total_bytes = excluded.total_bytes,
            resumable_session_uri = excluded.resumable_session_uri,
            session_expires_at_ms = excluded.session_expires_at_ms,
            manifest_sha256 = COALESCE(excluded.manifest_sha256, drive_backup_checkpoints.manifest_sha256),
            updated_at_ms = excluded.updated_at_ms
        `.pipe(
            Effect.asVoid,
            Effect.catch(() => Effect.void),
          );
        };

        const clearCheckpoint = () =>
          sql`DELETE FROM drive_backup_checkpoints WHERE run_id = ${runId}`.pipe(
            Effect.asVoid,
            Effect.catch(() => Effect.void),
          );

        const loadResumableArchiveCheckpoint = (targetId: string, expectedExt: string) =>
          sql<{
            readonly run_id: string;
            readonly archive_path: string | null;
            readonly uploaded_offset_bytes: number;
            readonly total_bytes: number;
            readonly resumable_session_uri: string | null;
            readonly manifest_sha256: string | null;
            readonly updated_at_ms: number;
          }>`
            SELECT run_id, archive_path, uploaded_offset_bytes, total_bytes,
                   resumable_session_uri, manifest_sha256, updated_at_ms
            FROM drive_backup_checkpoints
            WHERE target_id = ${targetId} AND stage = 'uploading'
            ORDER BY updated_at_ms DESC
            LIMIT 1
          `.pipe(
            Effect.map((rows) => {
              const cp = rows[0];
              if (!cp || !cp.archive_path) return null;
              if (!cp.archive_path.endsWith(`.${expectedExt}`)) return null;
              if (Date.now() - Number(cp.updated_at_ms) > 24 * 3_600_000) return null;
              if (!NodeFs.existsSync(cp.archive_path)) return null;
              return cp;
            }),
            Effect.catch(() => Effect.succeed(null)),
          );

        const deleteCheckpointsForTarget = (targetId: string) =>
          sql`DELETE FROM drive_backup_checkpoints WHERE target_id = ${targetId}`.pipe(
            Effect.asVoid,
            Effect.catch(() => Effect.void),
          );

        const executionResult = yield* Effect.gen(function* () {
          let processedTargets = 0;
          for (const row of selectedRows) {
            updateLiveProgress({
              stage: "scanning",
              targetId: row.id,
              targetDisplayName: row.display_name,
              completedTargets: processedTargets,
              uploadedBytes: 0,
              totalBytes: 0,
              resumedFromBytes: 0,
              completedFiles: 0,
              totalFiles: 0,
              transferStartedAtMs: null,
              note: null,
            });
            const isUnifiedUserdataPre = row.id === UNIFIED_USERDATA_TARGET_ID;
            const expectedExtPre = passphrase ? "t3enc" : "t3arc";
            const resumableCp = row.sync_files
              ? yield* loadResumableArchiveCheckpoint(row.id, expectedExtPre)
              : null;
            if (resumableCp && resumableCp.archive_path) {
              // 직전 업로드 중단/실패로 스테이징에 이미 완성된 .t3enc/.t3arc가 남아 있으면 재해싱·재패킹 없이 즉시 업로드 재개
              const safeFolder = isUnifiedUserdataPre
                ? "t3-all-userdata"
                : sanitizeSegment(row.display_name || row.id);
              const subFolderPrefix =
                row.kind === "userdata"
                  ? `userdata/${safeFolder}`
                  : row.kind === "knowledge"
                    ? `knowledge/${safeFolder}`
                    : `projects/${safeFolder}`;
              const resumedPath = resumableCp.archive_path;
              const resumedFileName = `${stamp}_${safeFolder}.${expectedExtPre}`;
              const resumedBytes = (() => {
                try {
                  return NodeFs.statSync(resumedPath).size;
                } catch {
                  return Math.max(0, Number(resumableCp.total_bytes ?? 0));
                }
              })();
              const resumeOffset = Math.max(0, Number(resumableCp.uploaded_offset_bytes ?? 0));
              updateLiveProgress({
                stage: "uploading",
                targetId: row.id,
                targetDisplayName: row.display_name,
                uploadedBytes: resumeOffset,
                totalBytes: resumedBytes,
                resumedFromBytes: resumeOffset,
                transferStartedAtMs: Date.now(),
                note: resumeOffset > 0 ? "이전 중단 체크포인트에서 이어올리기 중" : null,
              });
              if (config.transportMode === "gdrive_api" && resumeOffset === 0) {
                yield* checkDailyQuotaBeforeNewFile({
                  ignoreCooldown: Boolean(input.forceWhenBusy),
                });
              }
              let resumedQuotaPause: DriveUploadQuotaExceededError | null = null;
              const uploadedResumed = yield* Effect.tryPromise({
                try: () =>
                  uploadArchiveFile({
                    targetId: row.id,
                    subFolder: subFolderPrefix,
                    fileName: resumedFileName,
                    stagedArchivePath: resumedPath,
                    ...(resumableCp.resumable_session_uri
                      ? { resumeSessionUri: resumableCp.resumable_session_uri }
                      : {}),
                    resumeOffsetBytes: resumeOffset,
                    onCheckpoint: (cp) =>
                      runCheckpointEffect(
                        saveCheckpoint({
                          stage: "uploading",
                          targetId: row.id,
                          archivePath: resumedPath,
                          uploadedOffsetBytes: cp.offsetBytes,
                          totalBytes: cp.totalBytes,
                          resumableSessionUri: cp.sessionUri,
                          manifestSha256: resumableCp.manifest_sha256,
                        }),
                      ),
                  }),
                catch: (e) => {
                  if (e instanceof DriveUploadQuotaExceededError) {
                    resumedQuotaPause = e;
                    return new DriveBackupError({ code: "BUSY_DEFERRED", message: e.message });
                  }
                  if (e instanceof ResumableUploadPausedError) {
                    return new DriveBackupError({ code: "BUSY_DEFERRED", message: e.message });
                  }
                  return new DriveBackupError({
                    code: e instanceof OAuthTokenRefreshError ? "AUTH_REQUIRED" : "TRANSPORT_ERROR",
                    message:
                      e instanceof OAuthTokenRefreshError
                        ? e.message
                        : `대상 '${row.display_name}' 체크포인트 재개 업로드 실패: ${errMsg(e)}`,
                  });
                },
              }).pipe(
                Effect.tapError((err) =>
                  resumedQuotaPause
                    ? markDailyQuotaPaused(
                        resumedQuotaPause.retryAfterMs,
                        resumedQuotaPause.message,
                      )
                    : err.code === "AUTH_REQUIRED"
                      ? recordAuthError(
                          isInvalidGrantError(err.message) ? "invalid_grant" : "auth_failed",
                          err.message,
                        )
                      : Effect.void,
                ),
                Effect.tap(() =>
                  config.transportMode === "gdrive_api" ? clearAuthError() : Effect.void,
                ),
              );

              resumedFromCheckpoint = true;
              totalFiles += 1;
              totalRawBytes += resumedBytes;
              totalArchiveBytes += resumedBytes;
              if (resumableCp.manifest_sha256) lastManifestSha256 = resumableCp.manifest_sha256;
              lastDestPath = uploadedResumed.destinationPath;
              yield* deleteCheckpointsForTarget(row.id);
              try {
                if (NodeFs.existsSync(resumedPath)) NodeFs.rmSync(resumedPath, { force: true });
              } catch {
                // ignore
              }
              const doneMs = Date.now();
              yield* sql`
                UPDATE drive_backup_targets
                SET last_backed_up_at_ms = ${doneMs}, updated_at_ms = ${doneMs}
                WHERE id = ${row.id}
              `.pipe(Effect.catch(() => Effect.void));
              processedTargets += 1;
              updateLiveProgress({
                completedTargets: processedTargets,
                uploadedBytes: resumedBytes,
                totalBytes: resumedBytes,
              });
              continue;
            }
            const workerEntries: Array<{
              readonly archivePath: string;
              readonly filePath?: string;
              readonly contentBase64?: string;
            }> = [];
            let blockedSecretsCount = 0;
            let blockedSecretsSample: ReadonlyArray<string> = [];
            const tempFilesToClean: string[] = [];
            const pendingManifests: Array<{
              readonly targetId: string;
              readonly json: string;
              readonly sha256: string;
            }> = [];
            const isUnifiedUserdata = row.id === UNIFIED_USERDATA_TARGET_ID;
            let shouldPackArchive = Boolean(
              row.sync_files || (row.sync_t3_scope && !isUnifiedUserdata),
            );
            const isSingleSqliteUserdata =
              !isUnifiedUserdata &&
              row.kind === "userdata" &&
              row.root_path.toLowerCase().endsWith(".sqlite") &&
              NodeFs.existsSync(row.root_path) &&
              NodeFs.statSync(row.root_path).isFile();

            if (isUnifiedUserdata && row.sync_files && NodeFs.existsSync(row.root_path)) {
              const scanned = scanSelectedDirectory({
                rootPath: row.root_path,
                customExcludeGlobs: parseJsonStringArray(row.exclude_globs_json),
                unlimited: true,
                excludeSqliteFiles: true,
              });
              blockedSecretsCount = scanned.blockedSecretsCount;
              blockedSecretsSample = scanned.blockedSecretsSample;

              const prevManifest = yield* loadTargetManifest(row.id);
              const diff = yield* Effect.tryPromise({
                try: () =>
                  computeIncrementalDiff({
                    targetId: row.id,
                    files: scanned.includedFiles,
                    previousManifest: prevManifest,
                    nowIso: createdAtIso,
                    ...(pauseSignal ? { signal: pauseSignal } : {}),
                  }),
                catch: (e) =>
                  new DriveBackupError({
                    code: pauseSignal?.aborted ? "BUSY_DEFERRED" : "UNAVAILABLE",
                    message: `통합 userdata 증분 매니페스트 계산 실패: ${errMsg(e)}`,
                  }),
              });
              pendingManifests.push({
                targetId: row.id,
                json: diff.nextManifestJson,
                sha256: diff.nextManifestSha256,
              });
              for (const file of diff.changedFiles) {
                workerEntries.push({
                  archivePath: `userdata/${file.relativePath}`,
                  filePath: file.absolutePath,
                });
              }

              let watchdogChanged = false;
              const wdPath = NodePath.join(serverConfig.stateDir, "watchdog-journal.sqlite");
              if (NodeFs.existsSync(wdPath) && NodeFs.statSync(wdPath).isFile()) {
                const wdStat = NodeFs.statSync(wdPath);
                const prevWd = yield* loadTargetManifest("userdata:watchdog-journal.sqlite");
                const wdDiff = yield* Effect.tryPromise({
                  try: () =>
                    computeIncrementalDiff({
                      targetId: "userdata:watchdog-journal.sqlite",
                      files: [
                        {
                          absolutePath: wdPath,
                          relativePath: "watchdog-journal.sqlite",
                          sizeBytes: wdStat.size,
                          mtimeMs: Math.floor(wdStat.mtimeMs),
                        },
                      ],
                      previousManifest: prevWd,
                      nowIso: createdAtIso,
                      ...(pauseSignal ? { signal: pauseSignal } : {}),
                    }),
                  catch: (e) =>
                    new DriveBackupError({
                      code: pauseSignal?.aborted ? "BUSY_DEFERRED" : "UNAVAILABLE",
                      message: `watchdog-journal 증분 비교 실패: ${errMsg(e)}`,
                    }),
                });
                pendingManifests.push({
                  targetId: "userdata:watchdog-journal.sqlite",
                  json: wdDiff.nextManifestJson,
                  sha256: wdDiff.nextManifestSha256,
                });
                if (wdDiff.changedFiles.length > 0) {
                  watchdogChanged = true;
                  const snapOut = NodePath.join(
                    snapshotStagingDir,
                    `udsnap-${runId}-watchdog-journal.sqlite`,
                  );
                  tempFilesToClean.push(snapOut);
                  const snap = yield* Effect.tryPromise({
                    try: () =>
                      runSqliteSnapshotInWorker({
                        dbPath: wdPath,
                        outputPath: snapOut,
                        rssLimitMb: config.workerRssLimitMb,
                        ...(pauseSignal ? { signal: pauseSignal } : {}),
                      }),
                    catch: (e) => {
                      if (e instanceof SnapshotPausedError) {
                        return new DriveBackupError({ code: "BUSY_DEFERRED", message: e.message });
                      }
                      return new DriveBackupError({
                        code: "UNAVAILABLE",
                        message: `watchdog-journal SQLite 스냅샷 실패: ${errMsg(e)}`,
                      });
                    },
                  });
                  totalWalGrowthBytes = (totalWalGrowthBytes ?? 0) + snap.walGrowthBytes;
                  workerEntries.push({
                    archivePath: "userdata/watchdog-journal.sqlite",
                    filePath: snap.outputPath,
                  });
                }
              }

              if (
                diff.changedFiles.length === 0 &&
                diff.deletedPaths.length === 0 &&
                !watchdogChanged
              ) {
                for (const pm of pendingManifests) {
                  yield* saveTargetManifest(pm.targetId, pm.json, pm.sha256);
                }
                const doneMs = Date.now();
                yield* sql`
                  UPDATE drive_backup_targets
                  SET last_backed_up_at_ms = ${doneMs}, updated_at_ms = ${doneMs}
                  WHERE id = ${row.id}
                `.pipe(Effect.catch(() => Effect.void));
                shouldPackArchive = false;
              } else {
                workerEntries.push({
                  archivePath: `manifests/${sanitizeSegment(row.id)}.manifest.json`,
                  contentBase64: Buffer.from(diff.nextManifestJson, "utf8").toString("base64"),
                });
              }
            } else if (isSingleSqliteUserdata && row.sync_files) {
              const snapOut = NodePath.join(
                snapshotStagingDir,
                `udsnap-${runId}-${sanitizeSegment(NodePath.basename(row.root_path))}`,
              );
              tempFilesToClean.push(snapOut);
              const snap = yield* Effect.tryPromise({
                try: () =>
                  runSqliteSnapshotInWorker({
                    dbPath: row.root_path,
                    outputPath: snapOut,
                    rssLimitMb: config.workerRssLimitMb,
                    ...(pauseSignal ? { signal: pauseSignal } : {}),
                  }),
                catch: (e) => {
                  if (e instanceof SnapshotPausedError) {
                    return new DriveBackupError({ code: "BUSY_DEFERRED", message: e.message });
                  }
                  return new DriveBackupError({
                    code: "UNAVAILABLE",
                    message: `userdata SQLite 스냅샷 실패 (${row.display_name}): ${errMsg(e)}`,
                  });
                },
              });
              totalWalGrowthBytes = (totalWalGrowthBytes ?? 0) + snap.walGrowthBytes;
              workerEntries.push({
                archivePath: `userdata/${NodePath.basename(row.root_path)}`,
                filePath: snap.outputPath,
              });
            } else if (row.sync_files && NodeFs.existsSync(row.root_path)) {
              const scanned = scanSelectedDirectory({
                rootPath: row.root_path,
                customExcludeGlobs: parseJsonStringArray(row.exclude_globs_json),
                unlimited: row.kind === "userdata",
                ...(row.kind === "knowledge"
                  ? { maxSingleFileBytes: DEFAULT_MIRROR_MAX_FILE_BYTES }
                  : {}),
              });
              blockedSecretsCount = scanned.blockedSecretsCount;
              blockedSecretsSample = scanned.blockedSecretsSample;

              if (row.kind === "userdata") {
                const prevManifest = yield* loadTargetManifest(row.id);
                const diff = yield* Effect.tryPromise({
                  try: () =>
                    computeIncrementalDiff({
                      targetId: row.id,
                      files: scanned.includedFiles,
                      previousManifest: prevManifest,
                      nowIso: createdAtIso,
                      ...(pauseSignal ? { signal: pauseSignal } : {}),
                    }),
                  catch: (e) =>
                    new DriveBackupError({
                      code: pauseSignal?.aborted ? "BUSY_DEFERRED" : "UNAVAILABLE",
                      message: `증분 매니페스트 계산 실패 (${row.display_name}): ${errMsg(e)}`,
                    }),
                });
                pendingManifests.push({
                  targetId: row.id,
                  json: diff.nextManifestJson,
                  sha256: diff.nextManifestSha256,
                });
                for (const file of diff.changedFiles) {
                  workerEntries.push({
                    archivePath: `userdata/${sanitizeSegment(NodePath.basename(row.root_path))}/${file.relativePath}`,
                    filePath: file.absolutePath,
                  });
                }
                if (diff.changedFiles.length === 0 && diff.deletedPaths.length === 0) {
                  yield* saveTargetManifest(row.id, diff.nextManifestJson, diff.nextManifestSha256);
                  const doneMs = Date.now();
                  yield* sql`
                    UPDATE drive_backup_targets
                    SET last_backed_up_at_ms = ${doneMs}, updated_at_ms = ${doneMs}
                    WHERE id = ${row.id}
                  `.pipe(Effect.catch(() => Effect.void));
                  shouldPackArchive = false;
                } else {
                  workerEntries.push({
                    archivePath: `manifests/${sanitizeSegment(row.id)}.manifest.json`,
                    contentBase64: Buffer.from(diff.nextManifestJson, "utf8").toString("base64"),
                  });
                }
              } else {
                for (const file of scanned.includedFiles) {
                  workerEntries.push({
                    archivePath: `workspace/${file.relativePath}`,
                    filePath: file.absolutePath,
                  });
                }
                const gitBundlePath = NodePath.join(
                  snapshotStagingDir,
                  `git-${runId}-${sanitizeSegment(row.id)}.bundle`,
                );
                const createdBundle = yield* Effect.tryPromise({
                  try: () => createGitBundleFileIfRepo(row.root_path, gitBundlePath),
                  catch: () => null,
                }).pipe(Effect.orElseSucceed(() => null));
                if (createdBundle) {
                  tempFilesToClean.push(createdBundle);
                  workerEntries.push({
                    archivePath: "git/repository.bundle",
                    filePath: createdBundle,
                  });
                }
              }
            }

            if (row.sync_t3_scope && !isUnifiedUserdata) {
              const relatedSummary = yield* summarizeTargetRelatedMemories(row, projectCatalog);
              if (relatedSummary.discovered.blockedSecretsCount > 0) {
                blockedSecretsCount += relatedSummary.discovered.blockedSecretsCount;
                blockedSecretsSample = [
                  ...blockedSecretsSample,
                  ...relatedSummary.discovered.blockedSecretsSample,
                ].slice(0, 10);
              }
              for (const mf of relatedSummary.discovered.files) {
                workerEntries.push({
                  archivePath: mf.archivePath,
                  filePath: mf.absolutePath,
                });
              }
              const scopeBuf = yield* exportRelatedT3ScopeJson({
                targetId: row.id,
                displayName: row.display_name,
                rootPath: row.root_path,
                summary: relatedSummary,
              });
              if (scopeBuf) {
                workerEntries.push({
                  archivePath: "t3-scope/project-scope.json",
                  contentBase64: scopeBuf.toString("base64"),
                });
              }
              if (!row.sync_files && workerEntries.length === 0) {
                shouldPackArchive = false;
              }
            }

            if (shouldPackArchive) {
              if (config.transportMode === "gdrive_api") {
                yield* checkDailyQuotaBeforeNewFile({
                  ignoreCooldown: Boolean(input.forceWhenBusy),
                });
              }
              const safeFolder = isUnifiedUserdata
                ? "t3-all-userdata"
                : sanitizeSegment(row.display_name || row.id);
              const subFolderPrefix =
                row.kind === "userdata"
                  ? `userdata/${safeFolder}`
                  : row.kind === "knowledge"
                    ? `knowledge/${safeFolder}`
                    : `projects/${safeFolder}`;
              const ext = passphrase ? "t3enc" : "t3arc";
              const fileName = `${stamp}_${safeFolder}.${ext}`;
              const stagedArchivePath = NodePath.join(
                snapshotStagingDir,
                `arc-${runId}-${fileName}`,
              );
              tempFilesToClean.push(stagedArchivePath);

              let preserveArchiveForResume = false;
              try {
                updateLiveProgress({
                  stage: "packing",
                  targetId: row.id,
                  targetDisplayName: row.display_name,
                  totalFiles: workerEntries.length,
                  completedFiles: 0,
                  uploadedBytes: 0,
                  totalBytes: 0,
                  resumedFromBytes: 0,
                  transferStartedAtMs: null,
                  note: null,
                });
                const built = yield* Effect.tryPromise({
                  try: () =>
                    runPackAndEncryptInWorker({
                      targetId: row.id,
                      targetDisplayName: row.display_name,
                      entries: workerEntries,
                      outputPath: stagedArchivePath,
                      createdAtIso,
                      encryptionPassphrase: passphrase,
                      readLimitMBps: resolveEffectiveReadLimitMBps(),
                      rssLimitMb: config.workerRssLimitMb,
                      ...(pauseSignal ? { signal: pauseSignal } : {}),
                    }),
                  catch: (e) => {
                    if (e instanceof SnapshotPausedError) {
                      return new DriveBackupError({ code: "BUSY_DEFERRED", message: e.message });
                    }
                    return new DriveBackupError({
                      code: "TRANSPORT_ERROR",
                      message: `대상 '${row.display_name}' 스트리밍 패킹 실패: ${errMsg(e)}`,
                    });
                  },
                });

                updateLiveProgress({
                  stage: "uploading",
                  targetId: row.id,
                  targetDisplayName: row.display_name,
                  uploadedBytes: 0,
                  totalBytes: built.archiveBytes,
                  resumedFromBytes: 0,
                  completedFiles: built.fileCount,
                  totalFiles: built.fileCount,
                  transferStartedAtMs: Date.now(),
                  note: null,
                });
                yield* saveCheckpoint({
                  stage: "uploading",
                  targetId: row.id,
                  archivePath: stagedArchivePath,
                  totalBytes: built.archiveBytes,
                  manifestSha256: built.manifestSha256,
                });

                let uploadQuotaPause: DriveUploadQuotaExceededError | null = null;
                const uploaded = yield* Effect.tryPromise({
                  try: () =>
                    uploadArchiveFile({
                      targetId: row.id,
                      subFolder: subFolderPrefix,
                      fileName,
                      stagedArchivePath,
                      onCheckpoint: (cp) =>
                        runCheckpointEffect(
                          saveCheckpoint({
                            stage: "uploading",
                            targetId: row.id,
                            archivePath: stagedArchivePath,
                            uploadedOffsetBytes: cp.offsetBytes,
                            totalBytes: cp.totalBytes,
                            resumableSessionUri: cp.sessionUri,
                            manifestSha256: built.manifestSha256,
                          }),
                        ),
                    }),
                  catch: (e) => {
                    if (e instanceof DriveUploadQuotaExceededError) {
                      preserveArchiveForResume = true;
                      uploadQuotaPause = e;
                      return new DriveBackupError({ code: "BUSY_DEFERRED", message: e.message });
                    }
                    if (e instanceof ResumableUploadPausedError) {
                      preserveArchiveForResume = true;
                      return new DriveBackupError({ code: "BUSY_DEFERRED", message: e.message });
                    }
                    // 403·네트워크 끊김 등 전송 실패 시에도 완성된 스테이징 아카이브와 체크포인트를 보존해 재패킹 없이 이어올린다.
                    if (!(e instanceof OAuthTokenRefreshError)) {
                      preserveArchiveForResume = true;
                    }
                    return new DriveBackupError({
                      code:
                        e instanceof OAuthTokenRefreshError ? "AUTH_REQUIRED" : "TRANSPORT_ERROR",
                      message:
                        e instanceof OAuthTokenRefreshError
                          ? e.message
                          : `대상 '${row.display_name}' 업로드 실패: ${errMsg(e)}`,
                    });
                  },
                }).pipe(
                  Effect.tapError((err) =>
                    uploadQuotaPause
                      ? markDailyQuotaPaused(
                          uploadQuotaPause.retryAfterMs,
                          uploadQuotaPause.message,
                        )
                      : err.code === "AUTH_REQUIRED"
                        ? recordAuthError(
                            isInvalidGrantError(err.message) ? "invalid_grant" : "auth_failed",
                            err.message,
                          )
                        : Effect.void,
                  ),
                  Effect.tap(() =>
                    config.transportMode === "gdrive_api" ? clearAuthError() : Effect.void,
                  ),
                );

                for (const pm of pendingManifests) {
                  yield* saveTargetManifest(pm.targetId, pm.json, pm.sha256);
                }

                totalFiles += built.fileCount;
                totalRawBytes += built.rawBytes;
                totalArchiveBytes += built.archiveBytes;
                totalBlockedSecrets += blockedSecretsCount;
                for (const sample of blockedSecretsSample) {
                  if (blockedSamples.length < 15)
                    blockedSamples.push(`${row.display_name}:${sample}`);
                }
                lastManifestSha256 = built.manifestSha256;
                lastDestPath = uploaded.destinationPath;

                const doneMs = Date.now();
                yield* sql`
                  UPDATE drive_backup_targets
                  SET last_backed_up_at_ms = ${doneMs}, updated_at_ms = ${doneMs}
                  WHERE id = ${row.id}
                `.pipe(Effect.catch(() => Effect.void));
              } finally {
                for (const tmp of tempFilesToClean) {
                  if (preserveArchiveForResume && tmp === stagedArchivePath) continue;
                  try {
                    if (NodeFs.existsSync(tmp)) NodeFs.rmSync(tmp, { force: true });
                  } catch {
                    // ignore
                  }
                }
              }
            }

            const liveKnowledgeFlag = yield* sql<{
              readonly sync_local_to_drive_knowledge: number;
            }>`
              SELECT sync_local_to_drive_knowledge
              FROM drive_backup_targets
              WHERE id = ${row.id}
              LIMIT 1
            `.pipe(
              Effect.map((r) => Boolean(r[0]?.sync_local_to_drive_knowledge ?? 0)),
              Effect.catch(() => Effect.succeed(Boolean(row.sync_local_to_drive_knowledge ?? 0))),
            );
            if (liveKnowledgeFlag) {
              updateLiveProgress({
                stage: "knowledge_upload",
                targetId: row.id,
                targetDisplayName: row.display_name,
                uploadedBytes: 0,
                totalBytes: 0,
                resumedFromBytes: 0,
                completedFiles: 0,
                totalFiles: 0,
                transferStartedAtMs: Date.now(),
                note: "T3-Knowledge 원본 파일 동기화 중",
              });
              const kRes = yield* uploadLocalKnowledgeForTarget({
                row,
                config,
                oauthCreds,
                createdAtIso,
                projectCatalog,
                ...(pauseSignal ? { pauseSignal } : {}),
                ignoreQuotaCooldown: Boolean(input.forceWhenBusy),
                onProgress: (kp) =>
                  updateLiveProgress({
                    stage: "knowledge_upload",
                    completedFiles: kp.completedFiles,
                    totalFiles: kp.totalFiles,
                    uploadedBytes: kp.uploadedBytes,
                    totalBytes: kp.totalBytes,
                  }),
              });
              totalFiles += kRes.uploadedCount;
              totalRawBytes += kRes.uploadedBytes;
              totalArchiveBytes += kRes.uploadedBytes;
              if (!shouldPackArchive) {
                totalBlockedSecrets += kRes.blockedSecretsCount;
                for (const sample of kRes.blockedSecretsSample) {
                  if (blockedSamples.length < 15)
                    blockedSamples.push(`${row.display_name}:${sample}`);
                }
              }
              if (kRes.lastDestPath && !lastDestPath) {
                lastDestPath = kRes.lastDestPath;
              }
            }
            processedTargets += 1;
            updateLiveProgress({ completedTargets: processedTargets });
          }

          // 선택적 월별 이벤트 아카이브 증분 백업 (includeEventArchives 또는 통합 userdata:all ON일 때 신규/변경분만 업로드)
          if (effectiveIncludeEventArchives) {
            const archivesDir = NodePath.join(serverConfig.stateDir, "archives");
            if (NodeFs.existsSync(archivesDir)) {
              const eventFiles = NodeFs.readdirSync(archivesDir, { withFileTypes: true })
                .filter((d) => d.isFile() && /^events-\d{6}\.sqlite$/i.test(d.name))
                .map((d) => {
                  const abs = NodePath.join(archivesDir, d.name);
                  const st = NodeFs.statSync(abs);
                  return {
                    absolutePath: abs,
                    relativePath: d.name,
                    sizeBytes: st.size,
                    mtimeMs: Math.floor(st.mtimeMs),
                  };
                });
              if (eventFiles.length > 0) {
                const prevEvManifest = yield* loadTargetManifest("core:event-archives");
                const evDiff = yield* Effect.tryPromise({
                  try: () =>
                    computeIncrementalDiff({
                      targetId: "core:event-archives",
                      files: eventFiles,
                      previousManifest: prevEvManifest,
                      nowIso: createdAtIso,
                      ...(pauseSignal ? { signal: pauseSignal } : {}),
                    }),
                  catch: (e) =>
                    new DriveBackupError({
                      code: pauseSignal?.aborted ? "BUSY_DEFERRED" : "UNAVAILABLE",
                      message: `이벤트 아카이브 증분 비교 실패: ${errMsg(e)}`,
                    }),
                });
                if (evDiff.changedFiles.length > 0) {
                  const evTemps: string[] = [];
                  const evEntries: Array<{
                    readonly archivePath: string;
                    readonly filePath?: string;
                    readonly contentBase64?: string;
                  }> = [];
                  try {
                    for (const evFile of evDiff.changedFiles) {
                      const snapOut = NodePath.join(
                        snapshotStagingDir,
                        `evsnap-${runId}-${sanitizeSegment(evFile.relativePath)}`,
                      );
                      evTemps.push(snapOut);
                      const snap = yield* Effect.tryPromise({
                        try: () =>
                          runSqliteSnapshotInWorker({
                            dbPath: evFile.absolutePath,
                            outputPath: snapOut,
                            rssLimitMb: config.workerRssLimitMb,
                            ...(pauseSignal ? { signal: pauseSignal } : {}),
                          }),
                        catch: (e) => {
                          if (e instanceof SnapshotPausedError) {
                            return new DriveBackupError({
                              code: "BUSY_DEFERRED",
                              message: e.message,
                            });
                          }
                          return new DriveBackupError({
                            code: "UNAVAILABLE",
                            message: `이벤트 아카이브 스냅샷 실패 (${evFile.relativePath}): ${errMsg(e)}`,
                          });
                        },
                      });
                      totalWalGrowthBytes = (totalWalGrowthBytes ?? 0) + snap.walGrowthBytes;
                      evEntries.push({
                        archivePath: `event-archives/${evFile.relativePath}`,
                        filePath: snap.outputPath,
                      });
                    }
                    const ext = passphrase ? "t3enc" : "t3arc";
                    const evFileName = `${stamp}_event-archives.${ext}`;
                    const stagedEvPath = NodePath.join(
                      snapshotStagingDir,
                      `arc-${runId}-${evFileName}`,
                    );
                    evTemps.push(stagedEvPath);

                    if (config.transportMode === "gdrive_api") {
                      yield* checkDailyQuotaBeforeNewFile({
                        ignoreCooldown: Boolean(input.forceWhenBusy),
                      });
                    }
                    let preserveEvArchiveForResume = false;
                    let evQuotaPause: DriveUploadQuotaExceededError | null = null;
                    try {
                      const packedEv = yield* Effect.tryPromise({
                        try: () =>
                          runPackAndEncryptInWorker({
                            targetId: "core:event-archives",
                            targetDisplayName: "T3 월별 이벤트 아카이브",
                            entries: evEntries,
                            outputPath: stagedEvPath,
                            createdAtIso,
                            encryptionPassphrase: passphrase,
                            readLimitMBps: resolveEffectiveReadLimitMBps(),
                            rssLimitMb: config.workerRssLimitMb,
                            ...(pauseSignal ? { signal: pauseSignal } : {}),
                          }),
                        catch: (e) =>
                          new DriveBackupError({
                            code:
                              e instanceof SnapshotPausedError
                                ? "BUSY_DEFERRED"
                                : "TRANSPORT_ERROR",
                            message: `이벤트 아카이브 패킹 실패: ${errMsg(e)}`,
                          }),
                      });
                      yield* saveCheckpoint({
                        stage: "uploading",
                        targetId: "core:event-archives",
                        archivePath: stagedEvPath,
                        totalBytes: packedEv.archiveBytes,
                        manifestSha256: packedEv.manifestSha256,
                      });
                      const uploadedEv = yield* Effect.tryPromise({
                        try: () =>
                          uploadArchiveFile({
                            targetId: "core:event-archives",
                            subFolder: "event-archives",
                            fileName: evFileName,
                            stagedArchivePath: stagedEvPath,
                            localRetentionOverride: config.snapshotLocalRetentionCount,
                            onCheckpoint: (cp) =>
                              runCheckpointEffect(
                                saveCheckpoint({
                                  stage: "uploading",
                                  targetId: "core:event-archives",
                                  archivePath: stagedEvPath,
                                  uploadedOffsetBytes: cp.offsetBytes,
                                  totalBytes: cp.totalBytes,
                                  resumableSessionUri: cp.sessionUri,
                                  manifestSha256: packedEv.manifestSha256,
                                }),
                              ),
                          }),
                        catch: (e) => {
                          if (e instanceof DriveUploadQuotaExceededError) {
                            preserveEvArchiveForResume = true;
                            evQuotaPause = e;
                            return new DriveBackupError({
                              code: "BUSY_DEFERRED",
                              message: e.message,
                            });
                          }
                          if (e instanceof ResumableUploadPausedError) {
                            preserveEvArchiveForResume = true;
                            return new DriveBackupError({
                              code: "BUSY_DEFERRED",
                              message: e.message,
                            });
                          }
                          if (!(e instanceof OAuthTokenRefreshError)) {
                            preserveEvArchiveForResume = true;
                          }
                          return new DriveBackupError({
                            code:
                              e instanceof OAuthTokenRefreshError
                                ? "AUTH_REQUIRED"
                                : "TRANSPORT_ERROR",
                            message:
                              e instanceof OAuthTokenRefreshError
                                ? e.message
                                : `이벤트 아카이브 업로드 실패: ${errMsg(e)}`,
                          });
                        },
                      }).pipe(
                        Effect.tapError(() =>
                          evQuotaPause
                            ? markDailyQuotaPaused(evQuotaPause.retryAfterMs, evQuotaPause.message)
                            : Effect.void,
                        ),
                      );
                      yield* saveTargetManifest(
                        "core:event-archives",
                        evDiff.nextManifestJson,
                        evDiff.nextManifestSha256,
                      );
                      totalFiles += packedEv.fileCount;
                      totalRawBytes += packedEv.rawBytes;
                      totalArchiveBytes += packedEv.archiveBytes;
                      if (!lastManifestSha256) lastManifestSha256 = packedEv.manifestSha256;
                      if (!lastDestPath) lastDestPath = uploadedEv.destinationPath;
                    } finally {
                      for (const tmp of evTemps) {
                        if (preserveEvArchiveForResume && tmp === stagedEvPath) continue;
                        try {
                          if (NodeFs.existsSync(tmp)) NodeFs.rmSync(tmp, { force: true });
                        } catch {
                          // ignore
                        }
                      }
                    }
                  } finally {
                    // evTemps already cleaned above
                  }
                }
              }
            }
          }

          // 선택적 T3 코어 설정 / 읽기 전용 SQLite 스냅샷 백업 (완전 스트리밍 — >2GiB 메모리 버퍼 0건!)
          if (effectiveIncludeCoreSettings || effectiveIncludeCoreSqliteSnapshot) {
            const coreWorkerEntries: Array<{
              readonly archivePath: string;
              readonly filePath?: string;
              readonly contentBase64?: string;
            }> = [];
            if (effectiveIncludeCoreSettings) {
              if (NodeFs.existsSync(serverConfig.settingsPath)) {
                try {
                  const rawJson = JSON.parse(
                    NodeFs.readFileSync(serverConfig.settingsPath, "utf8"),
                  );
                  coreWorkerEntries.push({
                    archivePath: "core/settings.redacted.json",
                    contentBase64: Buffer.from(
                      JSON.stringify(redactSettingsSecrets(rawJson), null, 2),
                      "utf8",
                    ).toString("base64"),
                  });
                } catch {
                  // skip invalid settings
                }
              }
              if (NodeFs.existsSync(serverConfig.keybindingsConfigPath)) {
                try {
                  coreWorkerEntries.push({
                    archivePath: "core/keybindings.json",
                    filePath: serverConfig.keybindingsConfigPath,
                  });
                } catch {
                  // skip
                }
              }
            }
            let snapshotPathToCleanup: string | null = null;
            const snapshotDue = isFullSnapshotDue({
              includeCoreSqliteSnapshot: effectiveIncludeCoreSqliteSnapshot,
              lastFullSnapshotAtMs: config.lastFullSnapshotAtMs,
              fullSnapshotIntervalDays: config.fullSnapshotIntervalDays,
              nowMs: startedAtMs,
              forceFullSnapshot: Boolean(input.forceWhenBusy),
            });
            if (snapshotDue) {
              const snap = yield* createWorkerSqliteSnapshot({
                runId,
                rssLimitMb: config.workerRssLimitMb,
                ...(pauseSignal ? { signal: pauseSignal } : {}),
              });
              snapshotPathToCleanup = snap.snapshotPath;
              totalWalGrowthBytes = (totalWalGrowthBytes ?? 0) + snap.walGrowthBytes;
              yield* saveCheckpoint({
                stage: "snapshot_ready",
                targetId: "core:t3-state",
                snapshotPath: snap.snapshotPath,
                totalBytes: snap.snapshotBytes,
              });
              coreWorkerEntries.push({
                archivePath: "core/state.snapshot.sqlite",
                filePath: snap.snapshotPath,
              });
            }

            if (coreWorkerEntries.length > 0) {
              const ext = passphrase ? "t3enc" : "t3arc";
              const coreFileName = `${stamp}_t3-core.${ext}`;
              const stagedCorePath = NodePath.join(
                snapshotStagingDir,
                `arc-${runId}-${coreFileName}`,
              );
              let preserveForResume = false;
              try {
                const packedCore = yield* Effect.tryPromise({
                  try: () =>
                    runPackAndEncryptInWorker({
                      targetId: "core:t3-state",
                      targetDisplayName: "T3 코어 설정·스냅샷",
                      entries: coreWorkerEntries,
                      outputPath: stagedCorePath,
                      createdAtIso,
                      encryptionPassphrase: passphrase,
                      readLimitMBps: resolveEffectiveReadLimitMBps(),
                      rssLimitMb: config.workerRssLimitMb,
                      ...(pauseSignal ? { signal: pauseSignal } : {}),
                    }),
                  catch: (e) => {
                    if (e instanceof SnapshotPausedError) {
                      return new DriveBackupError({ code: "BUSY_DEFERRED", message: e.message });
                    }
                    return new DriveBackupError({
                      code: "TRANSPORT_ERROR",
                      message: `T3 코어 스트리밍 패킹 실패: ${errMsg(e)}`,
                    });
                  },
                });
                yield* saveCheckpoint({
                  stage: "uploading",
                  targetId: "core:t3-state",
                  snapshotPath: snapshotPathToCleanup,
                  archivePath: stagedCorePath,
                  totalBytes: packedCore.archiveBytes,
                  manifestSha256: packedCore.manifestSha256,
                });
                if (config.transportMode === "gdrive_api") {
                  yield* checkDailyQuotaBeforeNewFile({
                    ignoreCooldown: Boolean(input.forceWhenBusy),
                  });
                }
                let coreQuotaPause: DriveUploadQuotaExceededError | null = null;
                const uploadedCore = yield* Effect.tryPromise({
                  try: () =>
                    uploadArchiveFile({
                      targetId: "core:t3-state",
                      subFolder: "core",
                      fileName: coreFileName,
                      stagedArchivePath: stagedCorePath,
                      ...(snapshotDue
                        ? { localRetentionOverride: config.snapshotLocalRetentionCount }
                        : {}),
                      onCheckpoint: (cp) =>
                        runCheckpointEffect(
                          saveCheckpoint({
                            stage: "uploading",
                            targetId: "core:t3-state",
                            archivePath: stagedCorePath,
                            uploadedOffsetBytes: cp.offsetBytes,
                            totalBytes: cp.totalBytes,
                            resumableSessionUri: cp.sessionUri,
                            manifestSha256: packedCore.manifestSha256,
                          }),
                        ),
                    }),
                  catch: (e) => {
                    if (e instanceof DriveUploadQuotaExceededError) {
                      preserveForResume = true;
                      coreQuotaPause = e;
                      return new DriveBackupError({ code: "BUSY_DEFERRED", message: e.message });
                    }
                    if (e instanceof ResumableUploadPausedError) {
                      preserveForResume = true;
                      return new DriveBackupError({ code: "BUSY_DEFERRED", message: e.message });
                    }
                    if (!(e instanceof OAuthTokenRefreshError)) {
                      preserveForResume = true;
                    }
                    return new DriveBackupError({
                      code:
                        e instanceof OAuthTokenRefreshError ? "AUTH_REQUIRED" : "TRANSPORT_ERROR",
                      message:
                        e instanceof OAuthTokenRefreshError
                          ? e.message
                          : `T3 코어 백업 업로드 실패: ${errMsg(e)}`,
                    });
                  },
                }).pipe(
                  Effect.tapError((err) =>
                    coreQuotaPause
                      ? markDailyQuotaPaused(coreQuotaPause.retryAfterMs, coreQuotaPause.message)
                      : err.code === "AUTH_REQUIRED"
                        ? recordAuthError(
                            isInvalidGrantError(err.message) ? "invalid_grant" : "auth_failed",
                            err.message,
                          )
                        : Effect.void,
                  ),
                  Effect.tap(() =>
                    config.transportMode === "gdrive_api" ? clearAuthError() : Effect.void,
                  ),
                );
                totalFiles += packedCore.fileCount;
                totalRawBytes += packedCore.rawBytes;
                totalArchiveBytes += packedCore.archiveBytes;
                if (!lastManifestSha256) lastManifestSha256 = packedCore.manifestSha256;
                if (!lastDestPath) lastDestPath = uploadedCore.destinationPath;
                if (snapshotDue) {
                  const snapDoneMs = Date.now();
                  yield* sql`
                  UPDATE drive_backup_config SET last_full_snapshot_at_ms = ${snapDoneMs}
                  WHERE id = ${CONFIG_ROW_ID}
                `.pipe(Effect.catch(() => Effect.void));
                }
              } finally {
                for (const p of [stagedCorePath, snapshotPathToCleanup]) {
                  if (!p) continue;
                  if (preserveForResume && p === stagedCorePath) continue;
                  try {
                    if (NodeFs.existsSync(p)) NodeFs.rmSync(p, { force: true });
                  } catch {
                    // ignore cleanup failure
                  }
                }
              }
            }
          }
          yield* clearCheckpoint();
        }).pipe(Effect.result);

        if (activeLiveProgress?.runId === runId) {
          activeLiveProgress = null;
        }

        if (executionResult._tag === "Failure") {
          const failedRun: DriveBackupRunRecord = {
            ...initialRun,
            status: executionResult.failure.code === "BUSY_DEFERRED" ? "paused" : "failed",
            fileCount: totalFiles,
            rawBytes: totalRawBytes,
            archiveBytes: totalArchiveBytes,
            skippedSecretsCount: totalBlockedSecrets,
            skippedSecretsSample: blockedSamples,
            manifestSha256: lastManifestSha256,
            destinationPath: lastDestPath,
            errorMessage: executionResult.failure.message,
            finishedAtMs: Date.now(),
            walGrowthBytes: totalWalGrowthBytes,
            pausedCount: executionResult.failure.code === "BUSY_DEFERRED" ? 1 : 0,
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
          walGrowthBytes: totalWalGrowthBytes,
          resumedFromCheckpoint,
        };
        yield* recordRun(succeededRun);
        return succeededRun;
      }),
    );

  const runNow = (
    input: DriveBackupRunNowInput,
  ): Effect.Effect<DriveBackupRunRecord, DriveBackupError> => runBackupInternal(input);

  const runWithPauseSignal = (
    input: DriveBackupRunNowInput,
    signal: AbortSignal,
  ): Effect.Effect<DriveBackupRunRecord, DriveBackupError> => runBackupInternal(input, signal);

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

      const verifiedResult = yield* Effect.tryPromise({
        try: () =>
          verifyAndExtractArchiveFile({
            archivePath: candidatePath,
            passphrase,
          }),
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
        fileCount: v.verifiedFilesCount,
        rawBytes: v.totalRawBytes,
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
        verifiedFilesCount: v.verifiedFilesCount,
        manifestSha256: v.manifestSha256,
        message: `복구 무결성 검증 통과 (${v.format}): ${v.verifiedFilesCount}개 파일 SHA-256 일치${v.encrypted ? ` (${v.encryptionFormat} 복호화 확인)` : ""}`,
      };
    });

  const syncKnowledgeMirror = (
    input: DriveBackupSyncMirrorInput,
  ): Effect.Effect<DriveBackupSyncMirrorResult, DriveBackupError> =>
    serialSemaphore.withPermits(1)(
      Effect.gen(function* () {
        const cfgRow = yield* ensureConfigRow();
        const config = yield* mapConfigRow(cfgRow);
        const startedAtMs = Date.now();
        const runId = `drvmir_${formatStamp(startedAtMs)}_${NodeCrypto.randomUUID().slice(0, 6)}`;

        NodeFs.mkdirSync(mirrorLocalDir, { recursive: true });
        const resolvedMirrorRoot = NodePath.resolve(mirrorLocalDir);

        // 기존 미러 메타데이터 일괄 로드 (다운로드 전 md5Checksum/modifiedTime 사전 비교용)
        const existingRows = yield* sql<{
          readonly object_id: string;
          readonly sha256: string;
          readonly local_path: string;
          readonly size_bytes: number;
          readonly md5_checksum?: string | null;
          readonly modified_time?: string | null;
        }>`
        SELECT object_id, sha256, local_path, size_bytes, md5_checksum, modified_time
        FROM drive_mirror_objects
      `.pipe(
          Effect.orElseSucceed(
            () =>
              [] as ReadonlyArray<{
                readonly object_id: string;
                readonly sha256: string;
                readonly local_path: string;
                readonly size_bytes: number;
                readonly md5_checksum?: string | null;
                readonly modified_time?: string | null;
              }>,
          ),
        );
        const existingByObjectId = new Map<string, ExistingMirrorObjectState>();
        for (const row of existingRows) {
          existingByObjectId.set(row.object_id, {
            objectId: row.object_id,
            sha256: row.sha256,
            localPath: row.local_path,
            sizeBytes: Math.max(0, Number(row.size_bytes ?? 0)),
            md5Checksum: row.md5_checksum ?? null,
            modifiedTime: row.modified_time ?? null,
          });
        }

        let syncedCount = 0;
        let skippedUnchangedCount = 0;
        let totalBytes = 0;
        let uploadedCount = 0;
        let uploadedSkippedUnchangedCount = 0;
        let uploadedBytes = 0;

        const allTargetRows = yield* listTargetRows();
        const knowledgeUploadTargets = allTargetRows.filter(
          (row) => Boolean(row.enabled) && Boolean(row.sync_local_to_drive_knowledge ?? 0),
        );
        const oauthForKnowledge =
          config.transportMode === "gdrive_api" ? yield* readOAuthCredentials() : null;
        if (knowledgeUploadTargets.length > 0) {
          const uploadCreatedAtIso = new Date(startedAtMs).toISOString();
          const mirrorProjectCatalog = yield* listProjectCatalog();
          for (const kRow of knowledgeUploadTargets) {
            const up = yield* uploadLocalKnowledgeForTarget({
              row: kRow,
              config,
              oauthCreds: oauthForKnowledge,
              createdAtIso: uploadCreatedAtIso,
              projectCatalog: mirrorProjectCatalog,
            });
            uploadedCount += up.uploadedCount;
            uploadedSkippedUnchangedCount += up.skippedUnchangedCount;
            uploadedBytes += up.uploadedBytes;
          }
        }

        if (config.transportMode === "local_drive_folder") {
          if (!config.localDriveRoot) {
            return yield* new DriveBackupError({
              code: "INVALID_STATE",
              message: "로컬 Google Drive 폴더 경로가 설정되어 있지 않습니다.",
            });
          }
          const metas = listLocalKnowledgeMirrorMetadata(
            config.localDriveRoot,
            config.gdriveKnowledgeFolderName,
          );
          for (const meta of metas) {
            if (isForbiddenExchangeFile(meta.remoteName)) continue;
            const safeRel = meta.remoteName
              .replace(/\\/g, "/")
              .split("/")
              .filter((seg) => seg.length > 0 && seg !== "." && seg !== "..")
              .map((seg) => seg.replace(/[<>:"|?*]/g, "_"))
              .join(NodePath.sep);
            if (!safeRel) continue;
            const destPath = NodePath.resolve(mirrorLocalDir, safeRel);
            if (!destPath.startsWith(resolvedMirrorRoot)) continue;

            const existing = existingByObjectId.get(meta.objectId);
            if (
              !input.force &&
              existing &&
              existing.modifiedTime === meta.modifiedTime &&
              existing.sizeBytes === meta.sizeBytes &&
              NodeFs.existsSync(existing.localPath)
            ) {
              skippedUnchangedCount += 1;
              continue;
            }

            // 스트리밍 복사 + 동시 SHA-256 계산 (25MB 초과 파일도 O(1) 메모리)
            const copied = yield* Effect.tryPromise({
              try: async () => {
                NodeFs.mkdirSync(NodePath.dirname(destPath), { recursive: true });
                const tmpPath = `${destPath}.${NodeCrypto.randomUUID().slice(0, 8)}.tmp`;
                const hasher = NodeCrypto.createHash("sha256");
                let written = 0;
                try {
                  const rs = NodeFs.createReadStream(meta.sourcePath, {
                    highWaterMark: 256 * 1024,
                  });
                  const ws = NodeFs.createWriteStream(tmpPath, { highWaterMark: 256 * 1024 });
                  for await (const raw of rs) {
                    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
                    written += chunk.byteLength;
                    hasher.update(chunk);
                    if (!ws.write(chunk)) {
                      await new Promise<void>((res, rej) => {
                        ws.once("drain", res);
                        ws.once("error", rej);
                      });
                    }
                  }
                  await new Promise<void>((res, rej) => {
                    ws.end(() => res());
                    ws.once("error", rej);
                  });
                  const hash = hasher.digest("hex");
                  if (
                    !input.force &&
                    existing &&
                    existing.sha256 === hash &&
                    NodeFs.existsSync(existing.localPath)
                  ) {
                    NodeFs.rmSync(tmpPath, { force: true });
                    return { unchanged: true, sha256: hash, bytes: written };
                  }
                  if (NodeFs.existsSync(destPath)) NodeFs.rmSync(destPath, { force: true });
                  NodeFs.renameSync(tmpPath, destPath);
                  return { unchanged: false, sha256: hash, bytes: written };
                } finally {
                  if (NodeFs.existsSync(tmpPath)) {
                    try {
                      NodeFs.rmSync(tmpPath, { force: true });
                    } catch {
                      // ignore
                    }
                  }
                }
              },
              catch: (e) =>
                new DriveBackupError({
                  code: "TRANSPORT_ERROR",
                  message: `로컬 지식 미러 복사 실패 (${meta.remoteName}): ${errMsg(e)}`,
                }),
            });

            if (copied.unchanged) {
              skippedUnchangedCount += 1;
              continue;
            }

            const now = Date.now();
            yield* sql`
            INSERT INTO drive_mirror_objects (
              object_id, remote_name, local_path, sha256, size_bytes, synced_at_ms, md5_checksum, modified_time
            ) VALUES (
              ${meta.objectId}, ${meta.remoteName}, ${destPath}, ${copied.sha256}, ${copied.bytes}, ${now}, NULL, ${meta.modifiedTime}
            )
            ON CONFLICT(object_id) DO UPDATE SET
              remote_name = excluded.remote_name,
              local_path = excluded.local_path,
              sha256 = excluded.sha256,
              size_bytes = excluded.size_bytes,
              synced_at_ms = excluded.synced_at_ms,
              modified_time = excluded.modified_time
          `.pipe(Effect.catch(() => Effect.void));

            syncedCount += 1;
            totalBytes += copied.bytes;
          }
        } else {
          const oauth = yield* readOAuthCredentials();
          if (!oauth) {
            return yield* new DriveBackupError({
              code: "AUTH_REQUIRED",
              message: "Google Drive API OAuth2 자격증명이 연결되어 있지 않습니다.",
            });
          }

          const exchangeStateKey = `knowledge_mirror:${config.gdriveKnowledgeFolderName}`;
          const exchangeStateRows = yield* sql<{
            readonly start_page_token: string | null;
            readonly state_json: string;
          }>`
          SELECT start_page_token, state_json
          FROM drive_exchange_state
          WHERE id = ${exchangeStateKey}
          LIMIT 1
        `.pipe(
            Effect.orElseSucceed(
              () =>
                [] as ReadonlyArray<{
                  readonly start_page_token: string | null;
                  readonly state_json: string;
                }>,
            ),
          );
          const startPageToken = exchangeStateRows[0]?.start_page_token ?? null;
          let persistedState: MirrorPersistedState | null = null;
          if (exchangeStateRows[0]?.state_json) {
            try {
              persistedState = JSON.parse(exchangeStateRows[0].state_json) as MirrorPersistedState;
            } catch {
              persistedState = null;
            }
          }

          const apiResult = yield* Effect.tryPromise({
            try: () =>
              syncKnowledgeMirrorViaGoogleDriveApi({
                creds: oauth,
                knowledgeFolderName: config.gdriveKnowledgeFolderName,
                mirrorLocalDir,
                existingByObjectId,
                startPageToken,
                persistedState,
                ...(input.force !== undefined ? { force: input.force } : {}),
              }),
            catch: (e) =>
              new DriveBackupError({
                code: e instanceof OAuthTokenRefreshError ? "AUTH_REQUIRED" : "TRANSPORT_ERROR",
                message:
                  e instanceof OAuthTokenRefreshError
                    ? e.message
                    : `드라이브 지식 폴더 동기화 실패: ${errMsg(e)}`,
              }),
          }).pipe(
            Effect.tapError((err) =>
              err.code === "AUTH_REQUIRED"
                ? recordAuthError(
                    isInvalidGrantError(err.message) ? "invalid_grant" : "auth_failed",
                    err.message,
                  )
                : Effect.void,
            ),
            Effect.tap(() => clearAuthError()),
          );

          const now = Date.now();
          for (const obj of apiResult.syncedObjects) {
            yield* sql`
            INSERT INTO drive_mirror_objects (
              object_id, remote_name, local_path, sha256, size_bytes, synced_at_ms, md5_checksum, modified_time
            ) VALUES (
              ${obj.objectId}, ${obj.remoteName}, ${obj.localPath}, ${obj.sha256},
              ${obj.sizeBytes}, ${now}, ${obj.md5Checksum}, ${obj.modifiedTime}
            )
            ON CONFLICT(object_id) DO UPDATE SET
              remote_name = excluded.remote_name,
              local_path = excluded.local_path,
              sha256 = excluded.sha256,
              size_bytes = excluded.size_bytes,
              synced_at_ms = excluded.synced_at_ms,
              md5_checksum = excluded.md5_checksum,
              modified_time = excluded.modified_time
          `.pipe(Effect.catch(() => Effect.void));
          }

          yield* sql`
          INSERT INTO drive_exchange_state (id, start_page_token, last_sync_at_ms, state_json)
          VALUES (
            ${exchangeStateKey},
            ${apiResult.nextStartPageToken},
            ${now},
            ${JSON.stringify(apiResult.nextState)}
          )
          ON CONFLICT(id) DO UPDATE SET
            start_page_token = excluded.start_page_token,
            last_sync_at_ms = excluded.last_sync_at_ms,
            state_json = excluded.state_json
        `.pipe(Effect.catch(() => Effect.void));

          syncedCount = apiResult.syncedObjects.length;
          skippedUnchangedCount = apiResult.skippedUnchangedCount;
          totalBytes = apiResult.totalBytes;
        }

        yield* recordRun({
          runId,
          kind: "knowledge_mirror",
          status: "succeeded",
          transportMode: config.transportMode,
          targetIds: knowledgeUploadTargets.map((t) => t.id),
          fileCount: syncedCount + uploadedCount,
          rawBytes: totalBytes + uploadedBytes,
          archiveBytes: totalBytes + uploadedBytes,
          skippedSecretsCount: 0,
          skippedSecretsSample: [],
          manifestSha256: null,
          destinationPath: mirrorLocalDir,
          errorMessage: null,
          startedAtMs,
          finishedAtMs: Date.now(),
        });

        const msgParts: string[] = [];
        if (uploadedCount > 0) {
          msgParts.push(
            `로컬 지식 ${uploadedCount}개 문서를 '${config.gdriveKnowledgeFolderName}'에 업로드`,
          );
        }
        if (syncedCount > 0) {
          msgParts.push(
            `'${config.gdriveKnowledgeFolderName}'에서 ${syncedCount}개 문서를 로컬 미러로 내려받음`,
          );
        }
        const message =
          msgParts.length > 0
            ? `${msgParts.join(" · ")} (미변경 생략: 업로드 ${uploadedSkippedUnchangedCount}건 / 내려받기 ${skippedUnchangedCount}건).`
            : `새로운 변경 문서가 없습니다 (미변경 생략: 업로드 ${uploadedSkippedUnchangedCount}건 / 내려받기 ${skippedUnchangedCount}건).`;

        return {
          syncedCount,
          skippedUnchangedCount,
          totalBytes,
          uploadedCount,
          uploadedSkippedUnchangedCount,
          uploadedBytes,
          mirrorLocalDir,
          message,
        };
      }),
    );

  const service: GoogleDriveBackupServiceShape = {
    getState,
    updateConfig,
    upsertTarget,
    deleteTarget,
    dryRun,
    runNow,
    verifyRestore,
    syncKnowledgeMirror,
    runWithPauseSignal,
  };

  return service;
});

export const GoogleDriveBackupServiceLive = Layer.effect(
  GoogleDriveBackupService,
  makeGoogleDriveBackupService,
);
