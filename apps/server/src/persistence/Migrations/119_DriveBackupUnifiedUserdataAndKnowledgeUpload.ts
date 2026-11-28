import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Migration 119: 통합 T3 전체 데이터(userdata:all) + 다른 드라이브 지식 폴더('knowledge') 및
 * Google Drive T3-Knowledge 원본 업로드 선택 컬럼(`sync_local_to_drive_knowledge`) 추가.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const ensureColumn = (table: string, column: string, definition: string) =>
    Effect.gen(function* () {
      const cols = yield* sql<{ readonly name: string }>`PRAGMA table_info(${sql.unsafe(table)})`;
      if (cols.some((c) => c.name === column)) return;
      yield* sql.unsafe(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    });

  // 1. drive_backup_targets CHECK 제약 확장 ('knowledge' 허용) + sync_local_to_drive_knowledge 컬럼 추가
  const targetSchema = yield* sql<{ readonly sql: string }>`
    SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'drive_backup_targets' LIMIT 1
  `;
  const targetDdl = targetSchema[0]?.sql ?? "";
  if (targetDdl && !targetDdl.includes("'knowledge'")) {
    const cols = yield* sql<{ readonly name: string }>`PRAGMA table_info(drive_backup_targets)`;
    const hasUploadCol = cols.some((c) => c.name === "sync_local_to_drive_knowledge");
    yield* sql`CREATE TABLE drive_backup_targets_v119 (
      id                             TEXT PRIMARY KEY,
      kind                           TEXT NOT NULL CHECK (kind IN ('project', 'repo', 'core', 'userdata', 'knowledge')),
      project_id                     TEXT,
      display_name                   TEXT NOT NULL,
      root_path                      TEXT NOT NULL,
      enabled                        INTEGER NOT NULL DEFAULT 0,
      sync_files                     INTEGER NOT NULL DEFAULT 1,
      sync_t3_scope                  INTEGER NOT NULL DEFAULT 1,
      sync_drive_to_local_rag        INTEGER NOT NULL DEFAULT 0,
      sync_local_to_drive_knowledge  INTEGER NOT NULL DEFAULT 0,
      exclude_globs_json             TEXT NOT NULL DEFAULT '[]',
      last_backed_up_at_ms           INTEGER,
      updated_at_ms                  INTEGER NOT NULL
    )`;
    if (hasUploadCol) {
      yield* sql`INSERT INTO drive_backup_targets_v119 (
        id, kind, project_id, display_name, root_path,
        enabled, sync_files, sync_t3_scope, sync_drive_to_local_rag,
        sync_local_to_drive_knowledge, exclude_globs_json, last_backed_up_at_ms, updated_at_ms
      )
      SELECT
        id, kind, project_id, display_name, root_path,
        enabled, sync_files, sync_t3_scope, sync_drive_to_local_rag,
        sync_local_to_drive_knowledge, exclude_globs_json, last_backed_up_at_ms, updated_at_ms
      FROM drive_backup_targets`;
    } else {
      yield* sql`INSERT INTO drive_backup_targets_v119 (
        id, kind, project_id, display_name, root_path,
        enabled, sync_files, sync_t3_scope, sync_drive_to_local_rag,
        sync_local_to_drive_knowledge, exclude_globs_json, last_backed_up_at_ms, updated_at_ms
      )
      SELECT
        id, kind, project_id, display_name, root_path,
        enabled, sync_files, sync_t3_scope, sync_drive_to_local_rag,
        0, exclude_globs_json, last_backed_up_at_ms, updated_at_ms
      FROM drive_backup_targets`;
    }
    yield* sql`DROP TABLE drive_backup_targets`;
    yield* sql`ALTER TABLE drive_backup_targets_v119 RENAME TO drive_backup_targets`;
    yield* sql`CREATE INDEX IF NOT EXISTS idx_drive_backup_targets_project
      ON drive_backup_targets(project_id)`;
  } else {
    yield* ensureColumn(
      "drive_backup_targets",
      "sync_local_to_drive_knowledge",
      "INTEGER NOT NULL DEFAULT 0",
    );
  }
});
