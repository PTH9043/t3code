import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Migration 114 — 통합 자율 운영실(상하 지휘 + 지속 목표) + 감독자 주도 동등 합석 회의실
 * + 4계층 이기종 AI 메타 신경망(SMoA/MacNet/DyLAN/GPTSwarm) 시냅스 가중치 스키마.
 *
 * 기존 112 (`mission_runs`, `mission_crew_roles`) 및 067 (`workspace_development`) 데이터를
 * 100% 무손실 유지하면서 계층·회의·역전파 학습 테이블만 확장한다.
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

  // 1. mission_crew_roles: 상하 계층(org_tier), 보고선(reports_to_role_key), 전문 태그, 감독자 자격, DyLAN 기여도
  yield* ensureColumn("mission_crew_roles", "org_tier", "TEXT NOT NULL DEFAULT 'L2_SPECIALIST'");
  yield* ensureColumn("mission_crew_roles", "reports_to_role_key", "TEXT");
  yield* ensureColumn("mission_crew_roles", "specialty_tags_json", "TEXT NOT NULL DEFAULT '[]'");
  yield* ensureColumn("mission_crew_roles", "can_moderate", "INTEGER NOT NULL DEFAULT 0");
  yield* ensureColumn("mission_crew_roles", "importance_score", "REAL NOT NULL DEFAULT 0.5");

  // 기존 기본 크루의 상하 계층·보고선·전문 태그 무손실 보정
  yield* sql`UPDATE mission_crew_roles
    SET org_tier = 'L0_COMMANDER', can_moderate = 1,
        specialty_tags_json = CASE WHEN specialty_tags_json = '[]' THEN '["command","strategy","synthesis"]' ELSE specialty_tags_json END
    WHERE role_key = 'commander'`;

  yield* sql`UPDATE mission_crew_roles
    SET org_tier = 'L1_LEAD', can_moderate = 1,
        specialty_tags_json = CASE WHEN specialty_tags_json = '[]' THEN '["architecture","planning","decomposition"]' ELSE specialty_tags_json END
    WHERE role_key = 'planner'`;

  yield* sql`UPDATE mission_crew_roles
    SET org_tier = 'L1_LEAD', can_moderate = 1,
        specialty_tags_json = CASE WHEN specialty_tags_json = '[]' THEN '["review","security","verification","risk"]' ELSE specialty_tags_json END
    WHERE role_key = 'reviewer'`;

  yield* sql`UPDATE mission_crew_roles
    SET org_tier = 'L2_SPECIALIST',
        reports_to_role_key = COALESCE(reports_to_role_key, 'planner'),
        specialty_tags_json = CASE WHEN specialty_tags_json = '[]' THEN '["coding","implementation","testing"]' ELSE specialty_tags_json END
    WHERE role_key = 'coder'`;

  yield* sql`UPDATE mission_crew_roles
    SET org_tier = 'L3_SUPPORT',
        reports_to_role_key = COALESCE(reports_to_role_key, 'planner'),
        specialty_tags_json = CASE WHEN specialty_tags_json = '[]' THEN '["summary","briefing","documentation"]' ELSE specialty_tags_json END
    WHERE role_key = 'digest'`;

  // 2. mission_runs: 지속 작업실 장기 목표·검증 명령·회의 승격 연결 필드 확장
  yield* ensureColumn(
    "mission_runs",
    "execution_style",
    "TEXT NOT NULL DEFAULT 'hierarchical_ops'",
  );
  yield* ensureColumn("mission_runs", "max_steps", "INTEGER");
  yield* ensureColumn("mission_runs", "max_minutes", "INTEGER");
  yield* ensureColumn("mission_runs", "max_tokens", "INTEGER");
  yield* ensureColumn("mission_runs", "verification_commands_json", "TEXT NOT NULL DEFAULT '[]'");
  yield* ensureColumn("mission_runs", "source_meeting_id", "TEXT");

  // 3. mission_meetings: 감독자 주도 + 나머지 전원 동등 합석 회의실 원장
  yield* sql`CREATE TABLE IF NOT EXISTS mission_meetings (
    id                           TEXT PRIMARY KEY,
    project_id                   TEXT NOT NULL,
    thread_id                    TEXT,
    topic                        TEXT NOT NULL,
    moderator_role_key           TEXT NOT NULL,
    moderator_display_name       TEXT NOT NULL,
    participant_role_keys_json   TEXT NOT NULL DEFAULT '[]',
    pruned_role_keys_json        TEXT NOT NULL DEFAULT '[]',
    meeting_style                TEXT NOT NULL DEFAULT 'roundtable' CHECK (meeting_style IN ('roundtable','blind_audit')),
    max_rounds                   INTEGER NOT NULL DEFAULT 3,
    current_round                INTEGER NOT NULL DEFAULT 0,
    status                       TEXT NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('RUNNING','CONSENSUS_REACHED','COMPLETED','CANCELLED')),
    early_stop_reason            TEXT,
    final_synthesis_md           TEXT NOT NULL DEFAULT '',
    consensus_summary_lines_json TEXT NOT NULL DEFAULT '[]',
    linked_mission_id            TEXT,
    total_tokens                 INTEGER NOT NULL DEFAULT 0,
    estimated_saved_tokens       INTEGER NOT NULL DEFAULT 0,
    total_cost_usd               REAL NOT NULL DEFAULT 0.0,
    created_at_ms                INTEGER NOT NULL,
    completed_at_ms              INTEGER
  )`;

  yield* sql`CREATE INDEX IF NOT EXISTS idx_mission_meetings_project
    ON mission_meetings(project_id, created_at_ms DESC)`;

  yield* sql`CREATE INDEX IF NOT EXISTS idx_mission_meetings_thread
    ON mission_meetings(thread_id, created_at_ms DESC)`;

  // 4. mission_meeting_packets: MacNet/SMoA 150T 압축 시냅스 패킷 (하위자->상급자 동등 의견 전달 기록)
  yield* sql`CREATE TABLE IF NOT EXISTS mission_meeting_packets (
    id                      TEXT PRIMARY KEY,
    meeting_id              TEXT NOT NULL,
    project_id              TEXT NOT NULL,
    round_num               INTEGER NOT NULL,
    from_role_key           TEXT NOT NULL,
    from_display_name       TEXT NOT NULL,
    from_org_tier           TEXT NOT NULL DEFAULT 'L2_SPECIALIST',
    reply_to_json           TEXT NOT NULL DEFAULT '[]',
    upward_feedback         INTEGER NOT NULL DEFAULT 0,
    stance                  TEXT NOT NULL DEFAULT 'propose',
    claim                   TEXT NOT NULL,
    evidence_json           TEXT NOT NULL DEFAULT '[]',
    risk_or_counter         TEXT NOT NULL DEFAULT '',
    selected_for_next_round INTEGER NOT NULL DEFAULT 1,
    importance_contribution REAL NOT NULL DEFAULT 0.5,
    token_count             INTEGER NOT NULL DEFAULT 0,
    created_at_ms           INTEGER NOT NULL
  )`;

  yield* sql`CREATE INDEX IF NOT EXISTS idx_mission_meeting_packets_meeting
    ON mission_meeting_packets(meeting_id, round_num ASC, created_at_ms ASC)`;

  // 5. mission_synapse_weights: DyLAN Agent Importance Score 역전파 학습 테이블
  yield* sql`CREATE TABLE IF NOT EXISTS mission_synapse_weights (
    project_id           TEXT NOT NULL,
    domain_tag           TEXT NOT NULL,
    role_key             TEXT NOT NULL,
    provider_instance_id TEXT NOT NULL,
    model_slug           TEXT NOT NULL,
    importance_ema       REAL NOT NULL DEFAULT 0.5,
    token_efficiency_ema REAL NOT NULL DEFAULT 0.5,
    adoption_rate        REAL NOT NULL DEFAULT 0.5,
    sample_count         INTEGER NOT NULL DEFAULT 0,
    pruned               INTEGER NOT NULL DEFAULT 0,
    updated_at_ms        INTEGER NOT NULL,
    PRIMARY KEY (project_id, domain_tag, role_key, provider_instance_id, model_slug)
  ) WITHOUT ROWID`;

  // 6. mission_synapse_edges: GPTSwarm 역할 간 시냅스 연결망 학습 테이블
  yield* sql`CREATE TABLE IF NOT EXISTS mission_synapse_edges (
    project_id       TEXT NOT NULL,
    domain_tag       TEXT NOT NULL,
    from_role_key    TEXT NOT NULL,
    to_role_key      TEXT NOT NULL,
    edge_weight      REAL NOT NULL DEFAULT 0.5,
    helpful_handoffs INTEGER NOT NULL DEFAULT 0,
    updated_at_ms    INTEGER NOT NULL,
    PRIMARY KEY (project_id, domain_tag, from_role_key, to_role_key)
  ) WITHOUT ROWID`;
});
