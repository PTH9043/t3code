import * as Schema from "effect/Schema";
import { NonNegativeInt, ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * NewAutoUsage (T3) 선택형(Opt-In) Google Drive 백업 & 양방향 지식 미러 계약 스키마.
 *
 * 핵심 원칙:
 * 1. Opt-In 선택 업로드: T3에 등록된 프로젝트 폴더 및 추가 지정 저장소 중
 *    사용자가 직접 활성화(enabled=true)한 항목만 패킹·암호화·업로드한다.
 * 2. 시크릿/대용량 자동 차단: .env, *.key, *.pem, wallet seed, node_modules, .t3 등은 기본 제외.
 * 3. Zero-Knowledge 로컬 암호화: 비밀번호/OAuth 토큰 원문은 절대 클라이언트 응답에 노출하지 않는다.
 */

export const DRIVE_BACKUP_WS_METHODS = {
  getState: "driveBackup.getState",
  updateConfig: "driveBackup.updateConfig",
  upsertTarget: "driveBackup.upsertTarget",
  deleteTarget: "driveBackup.deleteTarget",
  dryRun: "driveBackup.dryRun",
  runNow: "driveBackup.runNow",
  verifyRestore: "driveBackup.verifyRestore",
  syncKnowledgeMirror: "driveBackup.syncKnowledgeMirror",
} as const;

export const DriveBackupErrorCode = Schema.Literals([
  "NOT_FOUND",
  "INVALID_INPUT",
  "INVALID_STATE",
  "AUTH_REQUIRED",
  "ENCRYPTION_ERROR",
  "TRANSPORT_ERROR",
  "BUSY_DEFERRED",
  "UNAVAILABLE",
]);
export type DriveBackupErrorCode = typeof DriveBackupErrorCode.Type;

export class DriveBackupError extends Schema.TaggedErrorClass<DriveBackupError>()(
  "DriveBackupError",
  {
    code: DriveBackupErrorCode,
    message: Schema.String,
  },
) {}

export const DriveBackupTransportMode = Schema.Literals(["gdrive_api", "local_drive_folder"]);
export type DriveBackupTransportMode = typeof DriveBackupTransportMode.Type;

export const DriveBackupTargetKind = Schema.Literals(["project", "repo", "core", "userdata"]);
export type DriveBackupTargetKind = typeof DriveBackupTargetKind.Type;

export const DriveBackupRunKind = Schema.Literals([
  "backup",
  "restore_verify",
  "knowledge_mirror",
  "exchange_sync",
]);
export type DriveBackupRunKind = typeof DriveBackupRunKind.Type;

export const DriveBackupRunStatus = Schema.Literals([
  "running",
  "paused",
  "succeeded",
  "partial",
  "failed",
  "skipped_busy",
]);
export type DriveBackupRunStatus = typeof DriveBackupRunStatus.Type;

export const DriveBackupAuthErrorCode = Schema.Literals(["invalid_grant", "auth_failed"]);
export type DriveBackupAuthErrorCode = typeof DriveBackupAuthErrorCode.Type;

export const DriveBackupConfig = Schema.Struct({
  transportMode: DriveBackupTransportMode,
  /** 모드 A (로컬 Google Drive 데스크톱 마운트 폴더 경로, 예: G:\내 드라이브\T3-Backup) */
  localDriveRoot: Schema.NullOr(Schema.String),
  /** 모드 B (Google Drive API v3 루트 폴더명, 기본 T3-Backup) */
  gdriveFolderName: Schema.String,
  /** 모드 B 양방향 지식 미러 폴더명 (기본 T3-Knowledge) */
  gdriveKnowledgeFolderName: Schema.String,
  gdriveConnectedEmail: Schema.NullOr(Schema.String),
  gdriveHasCredentials: Schema.Boolean,
  encryptionEnabled: Schema.Boolean,
  /** 암호화 비밀번호의 SHA-256 12자리 지문만 노출 (원문 절대 미노출) */
  keyFingerprint: Schema.NullOr(Schema.String),
  retentionCount: NonNegativeInt,
  includeCoreSettings: Schema.Boolean,
  includeCoreSqliteSnapshot: Schema.Boolean,
  includeEventArchives: Schema.Boolean,
  autoSyncIdleOnly: Schema.Boolean,
  /** OAuth 갱신 실패 상태 (예: Testing 앱 7일 만료 invalid_grant) */
  lastAuthErrorCode: Schema.NullOr(DriveBackupAuthErrorCode),
  lastAuthErrorMessage: Schema.NullOr(Schema.String),
  lastAuthErrorAtMs: Schema.NullOr(Schema.Number),
  /** 무방해 유휴 자동 백업 스케줄 (기본 OFF — 수동 1회 + 복원 검증 후 활성화) */
  autoScheduleEnabled: Schema.Boolean,
  idleMinSeconds: NonNegativeInt,
  pauseOnBattery: Schema.Boolean,
  allowedWindowEnabled: Schema.Boolean,
  allowedWindowStartHour: NonNegativeInt,
  allowedWindowEndHour: NonNegativeInt,
  /** 디스크 읽기 속도 상한 (MB/s, 기본 50) */
  readLimitMBps: NonNegativeInt,
  /** 네트워크 업로드 속도 상한 (Mbps, 기본 20) */
  uploadLimitMbps: NonNegativeInt,
  /** 자식 프로세스 메모리 RSS 상한 (MB, 기본 300) */
  workerRssLimitMb: NonNegativeInt,
  /** 전체 SQLite 스냅샷 주기 (일, 기본 7) */
  fullSnapshotIntervalDays: NonNegativeInt,
  /** 대용량 SQLite 스냅샷 로컬 롤링 보존 세대 수 (기본 1) */
  snapshotLocalRetentionCount: NonNegativeInt,
  lastFullSnapshotAtMs: Schema.NullOr(Schema.Number),
  updatedAtMs: Schema.Number,
});
export type DriveBackupConfig = typeof DriveBackupConfig.Type;

export const DriveBackupTarget = Schema.Struct({
  id: Schema.String,
  kind: DriveBackupTargetKind,
  projectId: Schema.NullOr(ProjectId),
  displayName: Schema.String,
  rootPath: Schema.String,
  existsOnDisk: Schema.Boolean,
  isGitRepo: Schema.Boolean,
  /** true인 항목만 백업·업로드 (Opt-In 기본값 false) */
  enabled: Schema.Boolean,
  /** 로컬 폴더 파일 / Git bundle 업로드 */
  syncFiles: Schema.Boolean,
  /** 해당 프로젝트의 T3 대화·기억·위키·미션 스코프 추출 백업 */
  syncT3Scope: Schema.Boolean,
  /** Google Drive /T3-Knowledge -> 로컬 미러 동기화 대상 여부 */
  syncDriveToLocalRag: Schema.Boolean,
  excludeGlobs: Schema.Array(Schema.String),
  riskWarning: Schema.NullOr(Schema.String),
  threadCount: NonNegativeInt,
  memoryCount: NonNegativeInt,
  lastBackedUpAtMs: Schema.NullOr(Schema.Number),
  updatedAtMs: Schema.Number,
});
export type DriveBackupTarget = typeof DriveBackupTarget.Type;

export const DriveBackupRunRecord = Schema.Struct({
  runId: Schema.String,
  kind: DriveBackupRunKind,
  status: DriveBackupRunStatus,
  transportMode: DriveBackupTransportMode,
  targetIds: Schema.Array(Schema.String),
  fileCount: NonNegativeInt,
  rawBytes: NonNegativeInt,
  archiveBytes: NonNegativeInt,
  skippedSecretsCount: NonNegativeInt,
  skippedSecretsSample: Schema.Array(Schema.String),
  manifestSha256: Schema.NullOr(Schema.String),
  destinationPath: Schema.NullOr(Schema.String),
  errorMessage: Schema.NullOr(Schema.String),
  startedAtMs: Schema.Number,
  finishedAtMs: Schema.NullOr(Schema.Number),
  walGrowthBytes: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  pausedCount: Schema.optionalKey(NonNegativeInt),
  resumedFromCheckpoint: Schema.optionalKey(Schema.Boolean),
});
export type DriveBackupRunRecord = typeof DriveBackupRunRecord.Type;

export const DriveBackupDryRunTarget = Schema.Struct({
  targetId: Schema.String,
  displayName: Schema.String,
  rootPath: Schema.String,
  enabled: Schema.Boolean,
  includedFilesCount: NonNegativeInt,
  estimatedRawBytes: NonNegativeInt,
  estimatedArchiveBytes: NonNegativeInt,
  isGitRepo: Schema.Boolean,
  t3ScopeThreadsCount: NonNegativeInt,
  t3ScopeMemoriesCount: NonNegativeInt,
  blockedSecretsCount: NonNegativeInt,
  blockedSecretsSample: Schema.Array(Schema.String),
  warnings: Schema.Array(Schema.String),
});
export type DriveBackupDryRunTarget = typeof DriveBackupDryRunTarget.Type;

export const DriveBackupDryRunResult = Schema.Struct({
  generatedAtMs: Schema.Number,
  selectedTargetsCount: NonNegativeInt,
  totalFilesCount: NonNegativeInt,
  totalRawBytes: NonNegativeInt,
  totalEstimatedArchiveBytes: NonNegativeInt,
  totalBlockedSecretsCount: NonNegativeInt,
  targets: Schema.Array(DriveBackupDryRunTarget),
});
export type DriveBackupDryRunResult = typeof DriveBackupDryRunResult.Type;

export const DriveBackupStateSnapshot = Schema.Struct({
  config: DriveBackupConfig,
  detectedLocalDriveRoots: Schema.Array(Schema.String),
  mirrorLocalDir: Schema.String,
  localStagingDir: Schema.String,
  activeWorkCount: NonNegativeInt,
  targets: Schema.Array(DriveBackupTarget),
  recentRuns: Schema.Array(DriveBackupRunRecord),
});
export type DriveBackupStateSnapshot = typeof DriveBackupStateSnapshot.Type;

// ---------------------------------------------------------------------------
// RPC Inputs & Outputs
// ---------------------------------------------------------------------------

export const DriveBackupGetStateInput = Schema.Struct({
  includeArchivedProjects: Schema.optionalKey(Schema.Boolean),
});
export type DriveBackupGetStateInput = typeof DriveBackupGetStateInput.Type;

export const DriveBackupUpdateConfigInput = Schema.Struct({
  transportMode: Schema.optionalKey(DriveBackupTransportMode),
  localDriveRoot: Schema.optionalKey(Schema.NullOr(Schema.String.check(Schema.isMaxLength(500)))),
  gdriveFolderName: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(120))),
  gdriveKnowledgeFolderName: Schema.optionalKey(
    TrimmedNonEmptyString.check(Schema.isMaxLength(120)),
  ),
  /** 모드 B Google Drive API v3 OAuth2 자격증명 (ServerSecretStore 암호화 저장) */
  gdriveClientId: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(300))),
  gdriveClientSecret: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(300))),
  gdriveRefreshToken: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(1000))),
  gdriveConnectedEmail: Schema.optionalKey(
    Schema.NullOr(Schema.String.check(Schema.isMaxLength(200))),
  ),
  encryptionEnabled: Schema.optionalKey(Schema.Boolean),
  /** 설정 시 로컬 비밀 저장소에 보관하고 DB엔 SHA-256 지문만 저장 */
  encryptionPassphrase: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(300))),
  /** 비밀번호를 T3 밖(비밀번호 관리자 등)에 보관해야 복구 가능하다는 사용자 확인 */
  passphraseBackupAcknowledged: Schema.optionalKey(Schema.Boolean),
  retentionCount: Schema.optionalKey(Schema.Number),
  includeCoreSettings: Schema.optionalKey(Schema.Boolean),
  includeCoreSqliteSnapshot: Schema.optionalKey(Schema.Boolean),
  includeEventArchives: Schema.optionalKey(Schema.Boolean),
  autoSyncIdleOnly: Schema.optionalKey(Schema.Boolean),
  autoScheduleEnabled: Schema.optionalKey(Schema.Boolean),
  idleMinSeconds: Schema.optionalKey(Schema.Number),
  pauseOnBattery: Schema.optionalKey(Schema.Boolean),
  allowedWindowEnabled: Schema.optionalKey(Schema.Boolean),
  allowedWindowStartHour: Schema.optionalKey(Schema.Number),
  allowedWindowEndHour: Schema.optionalKey(Schema.Number),
  readLimitMBps: Schema.optionalKey(Schema.Number),
  uploadLimitMbps: Schema.optionalKey(Schema.Number),
  workerRssLimitMb: Schema.optionalKey(Schema.Number),
  fullSnapshotIntervalDays: Schema.optionalKey(Schema.Number),
  snapshotLocalRetentionCount: Schema.optionalKey(Schema.Number),
});
export type DriveBackupUpdateConfigInput = typeof DriveBackupUpdateConfigInput.Type;

export const DriveBackupUpsertTargetInput = Schema.Struct({
  id: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(140))),
  kind: DriveBackupTargetKind,
  projectId: Schema.optionalKey(Schema.NullOr(ProjectId)),
  displayName: TrimmedNonEmptyString.check(Schema.isMaxLength(160)),
  rootPath: TrimmedNonEmptyString.check(Schema.isMaxLength(600)),
  enabled: Schema.Boolean,
  syncFiles: Schema.Boolean,
  syncT3Scope: Schema.Boolean,
  syncDriveToLocalRag: Schema.Boolean,
  excludeGlobs: Schema.optionalKey(
    Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(120))),
  ),
});
export type DriveBackupUpsertTargetInput = typeof DriveBackupUpsertTargetInput.Type;

export const DriveBackupDeleteTargetInput = Schema.Struct({
  targetId: TrimmedNonEmptyString.check(Schema.isMaxLength(140)),
});
export type DriveBackupDeleteTargetInput = typeof DriveBackupDeleteTargetInput.Type;

export const DriveBackupDryRunInput = Schema.Struct({
  targetIds: Schema.optionalKey(Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(140)))),
});
export type DriveBackupDryRunInput = typeof DriveBackupDryRunInput.Type;

export const DriveBackupRunNowInput = Schema.Struct({
  targetIds: Schema.optionalKey(Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(140)))),
  /** true면 활성 작업이 있어도 수동 강제 실행 (읽기 전용 백업만 수행) */
  forceWhenBusy: Schema.optionalKey(Schema.Boolean),
});
export type DriveBackupRunNowInput = typeof DriveBackupRunNowInput.Type;

export const DriveBackupVerifyRestoreInput = Schema.Struct({
  runId: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(140))),
  archivePath: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(600))),
});
export type DriveBackupVerifyRestoreInput = typeof DriveBackupVerifyRestoreInput.Type;

export const DriveBackupVerifyRestoreResult = Schema.Struct({
  verified: Schema.Boolean,
  runId: Schema.NullOr(Schema.String),
  archivePath: Schema.String,
  encrypted: Schema.Boolean,
  verifiedFilesCount: NonNegativeInt,
  manifestSha256: Schema.String,
  message: Schema.String,
});
export type DriveBackupVerifyRestoreResult = typeof DriveBackupVerifyRestoreResult.Type;

export const DriveBackupSyncMirrorInput = Schema.Struct({
  force: Schema.optionalKey(Schema.Boolean),
});
export type DriveBackupSyncMirrorInput = typeof DriveBackupSyncMirrorInput.Type;

export const DriveBackupSyncMirrorResult = Schema.Struct({
  syncedCount: NonNegativeInt,
  skippedUnchangedCount: NonNegativeInt,
  totalBytes: NonNegativeInt,
  mirrorLocalDir: Schema.String,
  message: Schema.String,
});
export type DriveBackupSyncMirrorResult = typeof DriveBackupSyncMirrorResult.Type;
