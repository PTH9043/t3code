import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_workspace_programs (
      program_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      command TEXT NOT NULL,
      relative_directory TEXT NOT NULL,
      environment_variable_names_json TEXT NOT NULL,
      start_policy TEXT NOT NULL CHECK (start_policy IN ('manual', 'server-start')),
      health_check_json TEXT,
      error_patterns_json TEXT NOT NULL,
      enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (project_id, program_id),
      FOREIGN KEY (project_id) REFERENCES projection_projects(project_id)
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_workspace_programs_project
    ON projection_workspace_programs(project_id, name ASC, program_id ASC)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_workspace_programs_autostart
    ON projection_workspace_programs(enabled, start_policy, project_id)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_workspace_program_runs (
      run_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      program_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('starting', 'running', 'stopping', 'exited', 'failed')),
      pid INTEGER,
      started_at TEXT NOT NULL,
      stopped_at TEXT,
      exit_code INTEGER,
      exit_signal INTEGER,
      health_status TEXT NOT NULL CHECK (health_status IN ('unknown', 'healthy', 'degraded', 'unhealthy')),
      consecutive_health_failures INTEGER NOT NULL,
      last_health_check_at TEXT,
      recent_log_tail TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projection_projects(project_id),
      FOREIGN KEY (project_id, program_id)
        REFERENCES projection_workspace_programs(project_id, program_id) ON DELETE CASCADE
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_workspace_program_runs_project
    ON projection_workspace_program_runs(project_id, started_at DESC, run_id DESC)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_workspace_program_runs_program
    ON projection_workspace_program_runs(program_id, started_at DESC, run_id DESC)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_workspace_incidents (
      incident_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      program_id TEXT NOT NULL,
      run_id TEXT,
      kind TEXT NOT NULL CHECK (kind IN ('spawn-failure', 'process-exit', 'log-pattern', 'health-check')),
      severity TEXT NOT NULL CHECK (severity IN ('warning', 'error', 'critical')),
      status TEXT NOT NULL CHECK (status IN ('open', 'diagnosing', 'awaiting-user', 'repairing', 'verifying', 'resolved')),
      fingerprint TEXT NOT NULL,
      summary TEXT NOT NULL,
      evidence TEXT NOT NULL,
      occurrence_count INTEGER NOT NULL,
      first_occurred_at TEXT NOT NULL,
      last_occurred_at TEXT NOT NULL,
      diagnosis_thread_id TEXT,
      diagnosis TEXT,
      repair_run_id TEXT,
      resolved_at TEXT,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projection_projects(project_id),
      FOREIGN KEY (project_id, program_id)
        REFERENCES projection_workspace_programs(project_id, program_id) ON DELETE CASCADE,
      FOREIGN KEY (run_id) REFERENCES projection_workspace_program_runs(run_id) ON DELETE SET NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_workspace_incidents_project
    ON projection_workspace_incidents(project_id, last_occurred_at DESC, incident_id DESC)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_workspace_incidents_open_fingerprint
    ON projection_workspace_incidents(project_id, program_id, fingerprint, status)
  `;
});
