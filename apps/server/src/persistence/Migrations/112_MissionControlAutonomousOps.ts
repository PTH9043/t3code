import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Migration 112: NewAutoUsage (T3) 자율 미션 컨트롤 통합 대시보드 스키마.
 *
 * 기존 `109_WorkerEngineMailbox` (`worker_tasks`, `worker_mailbox_messages`, `worker_decision_gates`),
 * `106_CcrToolOutputs` (`ccr_tool_outputs`), `104_HostAuditAndSpecPin` (`host_audit_chain`, `pinned_task_specs`)을
 * SSOT로 재사용하고, 미션·크루·보고서·예산 원장 및 안전 컬럼 확장만 추가한다.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const ensureColumn = (tableName: string, columnName: string, columnDef: string) =>
    Effect.gen(function* () {
      const cols = yield* sql<{
        readonly name: string;
      }>`PRAGMA table_info(${sql.unsafe(tableName)})`;
      if (cols.some((c) => c.name === columnName)) return;
      yield* sql`ALTER TABLE ${sql.unsafe(tableName)} ADD COLUMN ${sql.unsafe(columnName)} ${sql.unsafe(columnDef)}`;
    });

  // 1. mission_runs (토큰 가드레일 통합 + 실제 대화창 thread_id 바인딩)
  yield* sql`CREATE TABLE IF NOT EXISTS mission_runs (
    id                      TEXT PRIMARY KEY,
    project_id              TEXT NOT NULL,
    thread_id               TEXT,
    title                   TEXT NOT NULL,
    goal_prompt             TEXT NOT NULL,
    done_criteria_json      TEXT NOT NULL DEFAULT '[]',
    status                  TEXT NOT NULL CHECK (status IN (
      'CREATED','PLANNING','EXECUTING','VERIFYING','AWAITING_APPROVAL','COMPLETED','FAILED','CANCELLED'
    )),
    active_role_id          TEXT,
    planner_task_id         TEXT,
    active_task_id          TEXT,
    worktree_path           TEXT,
    worktree_branch         TEXT,
    assigned_roles_json     TEXT NOT NULL DEFAULT '[]',
    dag_steps_json          TEXT NOT NULL DEFAULT '[]',
    require_final_approval  INTEGER NOT NULL DEFAULT 1,
    auto_merge_on_approve   INTEGER NOT NULL DEFAULT 0,
    hop_count               INTEGER NOT NULL DEFAULT 0,
    rework_count            INTEGER NOT NULL DEFAULT 0,
    turn_count              INTEGER NOT NULL DEFAULT 0,
    total_tokens_used       INTEGER NOT NULL DEFAULT 0,
    total_cached_tokens     INTEGER NOT NULL DEFAULT 0,
    total_cost_usd          REAL NOT NULL DEFAULT 0.0,
    budget_limit_usd        REAL NOT NULL DEFAULT 1.5,
    circuit_breaker_state   TEXT NOT NULL DEFAULT 'OK' CHECK (circuit_breaker_state IN (
      'OK','THROTTLED','TRIPPED_TO_INBOX'
    )),
    last_error_hash         TEXT,
    repeat_error_count      INTEGER NOT NULL DEFAULT 0,
    lease_owner             TEXT,
    lease_epoch             INTEGER NOT NULL DEFAULT 1,
    lease_expires_at_ms     INTEGER,
    digest_line             TEXT,
    created_at_ms           INTEGER NOT NULL,
    updated_at_ms           INTEGER NOT NULL,
    completed_at_ms         INTEGER
  )`;

  yield* sql`CREATE INDEX IF NOT EXISTS idx_mission_runs_project_status
    ON mission_runs(project_id, status, updated_at_ms DESC)`;

  yield* sql`CREATE INDEX IF NOT EXISTS idx_mission_runs_thread
    ON mission_runs(thread_id, updated_at_ms DESC)`;

  // 2. mission_crew_roles (유동 프로바이더·모델·폴백·티어·허용 도구)
  yield* sql`CREATE TABLE IF NOT EXISTS mission_crew_roles (
    id                    TEXT PRIMARY KEY,
    project_id            TEXT NOT NULL,
    role_key              TEXT NOT NULL,
    display_name          TEXT NOT NULL,
    description           TEXT NOT NULL DEFAULT '',
    provider_instance_id  TEXT NOT NULL,
    model_slug            TEXT NOT NULL,
    model_tier            TEXT NOT NULL CHECK (model_tier IN ('TIER_S','TIER_A','TIER_B')),
    fallback_instance_id  TEXT,
    fallback_model_slug   TEXT,
    system_directive      TEXT NOT NULL DEFAULT '',
    allowed_tools_json    TEXT NOT NULL DEFAULT '[]',
    current_status        TEXT NOT NULL DEFAULT 'IDLE' CHECK (current_status IN (
      'IDLE','WORKING','BLOCKED','ERROR','RATE_LIMITED'
    )),
    active_mission_id     TEXT,
    active_task_id        TEXT,
    context_percent       REAL NOT NULL DEFAULT 0,
    turn_count            INTEGER NOT NULL DEFAULT 0,
    max_turns             INTEGER NOT NULL DEFAULT 12,
    last_heartbeat_at_ms  INTEGER,
    enabled               INTEGER NOT NULL DEFAULT 1,
    updated_at_ms         INTEGER NOT NULL,
    UNIQUE(project_id, role_key)
  )`;

  yield* sql`CREATE INDEX IF NOT EXISTS idx_mission_crew_roles_project
    ON mission_crew_roles(project_id, role_key)`;

  // 3. mission_reports (미션 완료 / 일일 브리핑 / 긴급 경보 — Map-Reduce 증분 요약)
  yield* sql`CREATE TABLE IF NOT EXISTS mission_reports (
    id                 TEXT PRIMARY KEY,
    project_id         TEXT NOT NULL,
    mission_id         TEXT,
    thread_id          TEXT,
    scope              TEXT NOT NULL CHECK (scope IN ('MISSION_DONE','DAILY_DIGEST','CRITICAL_ALERT')),
    title              TEXT NOT NULL,
    body_md            TEXT NOT NULL,
    summary_3lines_json TEXT NOT NULL DEFAULT '[]',
    dedup_fingerprint  TEXT UNIQUE,
    delivered_telegram INTEGER NOT NULL DEFAULT 0,
    created_at_ms      INTEGER NOT NULL
  )`;

  yield* sql`CREATE INDEX IF NOT EXISTS idx_mission_reports_project
    ON mission_reports(project_id, created_at_ms DESC)`;

  // 4. mission_budget_ledger (토큰·캐시 히트율·비용·429·Zero-Token 스킵 원장)
  yield* sql`CREATE TABLE IF NOT EXISTS mission_budget_ledger (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id           TEXT NOT NULL,
    mission_id           TEXT,
    role_key             TEXT,
    provider_instance_id TEXT,
    model_slug           TEXT,
    prompt_tokens        INTEGER NOT NULL DEFAULT 0,
    cached_tokens        INTEGER NOT NULL DEFAULT 0,
    completion_tokens    INTEGER NOT NULL DEFAULT 0,
    cost_usd             REAL NOT NULL DEFAULT 0.0,
    latency_ms           INTEGER NOT NULL DEFAULT 0,
    provider_error_code  TEXT,
    circuit_breaker_flag TEXT,
    zero_token_skip      INTEGER NOT NULL DEFAULT 0,
    created_at_ms        INTEGER NOT NULL
  )`;

  yield* sql`CREATE INDEX IF NOT EXISTS idx_mission_budget_project_day
    ON mission_budget_ledger(project_id, created_at_ms DESC)`;

  // 5. mission_activity_log (Zone 4 좌측 활동 로그)
  yield* sql`CREATE TABLE IF NOT EXISTS mission_activity_log (
    id                 TEXT PRIMARY KEY,
    project_id         TEXT NOT NULL,
    mission_id         TEXT,
    thread_id          TEXT,
    role_key           TEXT,
    role_display_name  TEXT NOT NULL,
    level              TEXT NOT NULL CHECK (level IN ('info','warn','error','success')),
    message            TEXT NOT NULL,
    artifact_id        TEXT,
    created_at_ms      INTEGER NOT NULL
  )`;

  yield* sql`CREATE INDEX IF NOT EXISTS idx_mission_activity_project
    ON mission_activity_log(project_id, created_at_ms DESC)`;

  // 6. mission_control_state (프로젝트별 Kill Switch 및 일일 예산 상한)
  yield* sql`CREATE TABLE IF NOT EXISTS mission_control_state (
    project_id         TEXT PRIMARY KEY,
    kill_switch_active INTEGER NOT NULL DEFAULT 0,
    kill_switch_reason TEXT,
    daily_limit_usd    REAL NOT NULL DEFAULT 10.0,
    updated_at_ms      INTEGER NOT NULL
  )`;

  // 7. 기존 109 테이블 무손실 컬럼 확장 (중복 테이블 신설 방지)
  yield* ensureColumn("worker_tasks", "mission_id", "TEXT");
  yield* ensureColumn("worker_tasks", "dag_node_id", "TEXT");
  yield* ensureColumn("worker_tasks", "role_id", "TEXT");

  yield* ensureColumn("worker_decision_gates", "mission_id", "TEXT");
  yield* ensureColumn("worker_decision_gates", "project_id", "TEXT");
  yield* ensureColumn("worker_decision_gates", "escalation_tier", "TEXT DEFAULT 'TIER_2'");
  yield* ensureColumn(
    "worker_decision_gates",
    "trigger_reason",
    "TEXT DEFAULT 'FINAL_MERGE_CONFIRM'",
  );
  yield* ensureColumn("worker_decision_gates", "context_3lines_md", "TEXT");
  yield* ensureColumn("worker_decision_gates", "ai_recommendation", "TEXT");
  yield* ensureColumn("worker_decision_gates", "risk_cost_json", "TEXT");
  yield* ensureColumn("worker_decision_gates", "diff_uri", "TEXT");
  yield* ensureColumn("worker_decision_gates", "checkpoint_payload_json", "TEXT");
  yield* ensureColumn("worker_decision_gates", "decision_note", "TEXT");
  yield* ensureColumn("worker_decision_gates", "decided_by", "TEXT");
  yield* ensureColumn("worker_decision_gates", "telegram_message_id", "TEXT");
  yield* ensureColumn("worker_decision_gates", "snoozed_until_ms", "INTEGER");

  yield* sql`CREATE INDEX IF NOT EXISTS idx_worker_tasks_mission
    ON worker_tasks(mission_id, updated_at_ms DESC)`;

  yield* sql`CREATE INDEX IF NOT EXISTS idx_worker_gates_mission_status
    ON worker_decision_gates(project_id, status, created_at_ms DESC)`;
});
