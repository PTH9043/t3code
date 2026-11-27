import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Migration 116: 선택형(Opt-In) Google Drive 백업 & 양방향 지식 미러 스키마.
 *
 * 4 tables:
 *   1. drive_backup_config  (전송 방식·로컬 드라이브 경로·암호화 지문·롤링 세대 설정)
 *   2. drive_backup_targets (사용자가 선택한 프로젝트 폴더·Git 저장소별 3종 토글)
 *   3. drive_backup_runs    (백업·복구검증·지식미러 실행 원장 및 SHA-256 매니페스트)
 *   4. drive_mirror_objects (Google Drive /T3-Knowledge -> 로컬 미러 증분 상태)
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`CREATE TABLE IF NOT EXISTS drive_backup_config (
    id                           TEXT PRIMARY KEY,
    transport_mode               TEXT NOT NULL DEFAULT 'gdrive_api' CHECK (transport_mode IN ('gdrive_api', 'local_drive_folder')),
    local_drive_root             TEXT,
    gdrive_folder_name           TEXT NOT NULL DEFAULT 'T3-Backup',
    gdrive_knowledge_folder_name TEXT NOT NULL DEFAULT 'T3-Knowledge',
    gdrive_connected_email       TEXT,
    encryption_enabled           INTEGER NOT NULL DEFAULT 1,
    key_fingerprint              TEXT,
    retention_count              INTEGER NOT NULL DEFAULT 7,
    include_core_settings        INTEGER NOT NULL DEFAULT 1,
    include_core_sqlite_snapshot INTEGER NOT NULL DEFAULT 0,
    include_event_archives       INTEGER NOT NULL DEFAULT 0,
    auto_sync_idle_only          INTEGER NOT NULL DEFAULT 1,
    updated_at_ms                INTEGER NOT NULL
  )`;

  yield* sql`CREATE TABLE IF NOT EXISTS drive_backup_targets (
    id                      TEXT PRIMARY KEY,
    kind                    TEXT NOT NULL CHECK (kind IN ('project', 'repo', 'core')),
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

  yield* sql`CREATE INDEX IF NOT EXISTS idx_drive_backup_targets_project
    ON drive_backup_targets(project_id)`;

  yield* sql`CREATE TABLE IF NOT EXISTS drive_backup_runs (
    run_id                      TEXT PRIMARY KEY,
    kind                        TEXT NOT NULL CHECK (kind IN ('backup', 'restore_verify', 'knowledge_mirror')),
    status                      TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'partial', 'failed', 'skipped_busy')),
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
    finished_at_ms              INTEGER
  )`;

  yield* sql`CREATE INDEX IF NOT EXISTS idx_drive_backup_runs_started
    ON drive_backup_runs(started_at_ms DESC)`;

  yield* sql`CREATE TABLE IF NOT EXISTS drive_mirror_objects (
    object_id     TEXT PRIMARY KEY,
    remote_name   TEXT NOT NULL,
    local_path    TEXT NOT NULL,
    sha256        TEXT NOT NULL,
    size_bytes    INTEGER NOT NULL DEFAULT 0,
    synced_at_ms  INTEGER NOT NULL
  )`;
});
