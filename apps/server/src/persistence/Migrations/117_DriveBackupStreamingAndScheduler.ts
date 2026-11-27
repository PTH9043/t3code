import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Migration 117: 무방해·스트리밍 Google Drive 백업(T3ARC2/T3ENC2/Resumable),
 * 유휴 스케줄러·자원 제한·체크포인트, userdata 증분 매니페스트, PC↔VPS 교환소 스키마.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const ensureColumn = (table: string, column: string, definition: string) =>
    Effect.gen(function* () {
      const cols = yield* sql<{ readonly name: string }>`
        SELECT name FROM pragma_table_info(${table})
      `;
      if (cols.some((c) => c.name === column)) return;
      yield* sql.unsafe(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    });

  // 1. drive_backup_config 확장 (OAuth 오류 안내 · 유휴/자원 제한 · 스냅샷 주기 · 스냅샷 로컬 보존 분리)
  yield* ensureColumn("drive_backup_config", "last_auth_error_code", "TEXT");
  yield* ensureColumn("drive_backup_config", "last_auth_error_message", "TEXT");
  yield* ensureColumn("drive_backup_config", "last_auth_error_at_ms", "INTEGER");
  yield* ensureColumn("drive_backup_config", "auto_schedule_enabled", "INTEGER NOT NULL DEFAULT 0");
  yield* ensureColumn("drive_backup_config", "idle_min_seconds", "INTEGER NOT NULL DEFAULT 600");
  yield* ensureColumn("drive_backup_config", "pause_on_battery", "INTEGER NOT NULL DEFAULT 1");
  yield* ensureColumn(
    "drive_backup_config",
    "allowed_window_enabled",
    "INTEGER NOT NULL DEFAULT 0",
  );
  yield* ensureColumn(
    "drive_backup_config",
    "allowed_window_start_hour",
    "INTEGER NOT NULL DEFAULT 1",
  );
  yield* ensureColumn(
    "drive_backup_config",
    "allowed_window_end_hour",
    "INTEGER NOT NULL DEFAULT 6",
  );
  yield* ensureColumn("drive_backup_config", "read_limit_mbps", "INTEGER NOT NULL DEFAULT 50");
  yield* ensureColumn("drive_backup_config", "upload_limit_mbps", "INTEGER NOT NULL DEFAULT 20");
  yield* ensureColumn("drive_backup_config", "worker_rss_limit_mb", "INTEGER NOT NULL DEFAULT 300");
  yield* ensureColumn(
    "drive_backup_config",
    "full_snapshot_interval_days",
    "INTEGER NOT NULL DEFAULT 7",
  );
  yield* ensureColumn(
    "drive_backup_config",
    "snapshot_local_retention_count",
    "INTEGER NOT NULL DEFAULT 1",
  );
  yield* ensureColumn("drive_backup_config", "last_full_snapshot_at_ms", "INTEGER");

  // 2. drive_backup_targets CHECK 제약 확장 ('userdata' 허용, 기존 데이터 무손실 보존)
  const targetSchemaRow = yield* sql<{ readonly sql: string | null }>`
    SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'drive_backup_targets' LIMIT 1
  `;
  if (targetSchemaRow[0]?.sql && !targetSchemaRow[0].sql.includes("'userdata'")) {
    yield* sql`CREATE TABLE drive_backup_targets_v117 (
      id                      TEXT PRIMARY KEY,
      kind                    TEXT NOT NULL CHECK (kind IN ('project', 'repo', 'core', 'userdata')),
      project_id              TEXT,
      display_name            TEXT NOT NULL,
      root_path               TEXT NOT NULL,
      enabled                 INTEGER NOT NULL DEFAULT 0,
      sync_files              INTEGER NOT NULL DEFAULT 1,
      sync_t3_scope           INTEGER NOT NULL DEFAULT 1,
      sync_drive_to_local_rag INTEGER NOT NULL DEFAULT 0,
      exclude_globs_json      TEXT NOT NULL DEFAULT '[]',
      last_backed_up_at_ms    INTEGER,
      updated_at_ms           INTEGER NOT NULL,
      UNIQUE(root_path)
    )`;
    yield* sql`INSERT INTO drive_backup_targets_v117 SELECT * FROM drive_backup_targets`;
    yield* sql`DROP TABLE drive_backup_targets`;
    yield* sql`ALTER TABLE drive_backup_targets_v117 RENAME TO drive_backup_targets`;
    yield* sql`CREATE INDEX IF NOT EXISTS idx_drive_backup_targets_project
      ON drive_backup_targets(project_id)`;
  }

  // 3. drive_backup_runs CHECK 제약 확장 ('paused', 'exchange_sync') + WAL/일시정지 측정 컬럼
  const runsSchemaRow = yield* sql<{ readonly sql: string | null }>`
    SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'drive_backup_runs' LIMIT 1
  `;
  if (runsSchemaRow[0]?.sql && !runsSchemaRow[0].sql.includes("'paused'")) {
    yield* sql`CREATE TABLE drive_backup_runs_v117 (
      run_id                      TEXT PRIMARY KEY,
      kind                        TEXT NOT NULL CHECK (kind IN ('backup', 'restore_verify', 'knowledge_mirror', 'exchange_sync')),
      status                      TEXT NOT NULL CHECK (status IN ('running', 'paused', 'succeeded', 'partial', 'failed', 'skipped_busy')),
      transport_mode              TEXT NOT NULL CHECK (transport_mode IN ('gdrive_api', 'local_drive_folder')),
      target_ids_json             TEXT NOT NULL DEFAULT '[]',
      file_count                  INTEGER NOT NULL DEFAULT 0,
      raw_bytes                   INTEGER NOT NULL DEFAULT 0,
      archive_bytes               INTEGER NOT NULL DEFAULT 0,
      skipped_secrets_count       INTEGER NOT NULL DEFAULT 0,
      skipped_secrets_sample_json TEXT NOT NULL DEFAULT '[]',
      manifest_sha256             TEXT,
      destination_path            TEXT,
      error_message               TEXT,
      started_at_ms               INTEGER NOT NULL,
      finished_at_ms              INTEGER,
      wal_growth_bytes            INTEGER,
      paused_count                INTEGER NOT NULL DEFAULT 0,
      resumed_from_checkpoint     INTEGER NOT NULL DEFAULT 0
    )`;
    yield* sql`INSERT INTO drive_backup_runs_v117 (
      run_id, kind, status, transport_mode, target_ids_json,
      file_count, raw_bytes, archive_bytes, skipped_secrets_count, skipped_secrets_sample_json,
      manifest_sha256, destination_path, error_message, started_at_ms, finished_at_ms
    ) SELECT
      run_id, kind, status, transport_mode, target_ids_json,
      file_count, raw_bytes, archive_bytes, skipped_secrets_count, skipped_secrets_sample_json,
      manifest_sha256, destination_path, error_message, started_at_ms, finished_at_ms
    FROM drive_backup_runs`;
    yield* sql`DROP TABLE drive_backup_runs`;
    yield* sql`ALTER TABLE drive_backup_runs_v117 RENAME TO drive_backup_runs`;
    yield* sql`CREATE INDEX IF NOT EXISTS idx_drive_backup_runs_started
      ON drive_backup_runs(started_at_ms DESC)`;
  } else {
    yield* ensureColumn("drive_backup_runs", "wal_growth_bytes", "INTEGER");
    yield* ensureColumn("drive_backup_runs", "paused_count", "INTEGER NOT NULL DEFAULT 0");
    yield* ensureColumn(
      "drive_backup_runs",
      "resumed_from_checkpoint",
      "INTEGER NOT NULL DEFAULT 0",
    );
  }

  // 4. drive_mirror_objects 증분 사전 비교용 메타 컬럼 추가
  yield* ensureColumn("drive_mirror_objects", "md5_checksum", "TEXT");
  yield* ensureColumn("drive_mirror_objects", "modified_time", "TEXT");

  // 5. 신규 테이블: 일시정지/재개 체크포인트 · 증분 파일 매니페스트 · Drive 교환소 상태(Changes startPageToken)
  yield* sql`CREATE TABLE IF NOT EXISTS drive_backup_checkpoints (
    run_id                TEXT PRIMARY KEY,
    stage                 TEXT NOT NULL,
    target_id             TEXT,
    snapshot_path         TEXT,
    archive_path          TEXT,
    entry_index           INTEGER NOT NULL DEFAULT 0,
    chunk_index           INTEGER NOT NULL DEFAULT 0,
    uploaded_offset_bytes INTEGER NOT NULL DEFAULT 0,
    total_bytes           INTEGER NOT NULL DEFAULT 0,
    resumable_session_uri TEXT,
    session_expires_at_ms INTEGER,
    manifest_sha256       TEXT,
    payload_json          TEXT NOT NULL DEFAULT '{}',
    updated_at_ms         INTEGER NOT NULL
  )`;

  yield* sql`CREATE TABLE IF NOT EXISTS drive_backup_manifests (
    target_id      TEXT PRIMARY KEY,
    manifest_json  TEXT NOT NULL,
    manifest_sha256 TEXT NOT NULL,
    remote_file_id TEXT,
    updated_at_ms  INTEGER NOT NULL
  )`;

  yield* sql`CREATE TABLE IF NOT EXISTS drive_exchange_state (
    id               TEXT PRIMARY KEY,
    start_page_token TEXT,
    last_sync_at_ms  INTEGER,
    state_json       TEXT NOT NULL DEFAULT '{}'
  )`;
});
