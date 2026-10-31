import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS workspace_task_recipes (
    project_id TEXT NOT NULL, recipe_id TEXT NOT NULL, revision INTEGER NOT NULL,
    recipe_json TEXT NOT NULL, PRIMARY KEY(project_id, recipe_id, revision)
  )`;
  yield* sql`CREATE TABLE IF NOT EXISTS workspace_task_inbox (
    task_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, source TEXT NOT NULL,
    external_id TEXT NOT NULL, status TEXT NOT NULL, monitor_key TEXT NOT NULL,
    created_at TEXT NOT NULL, ai_skipped INTEGER NOT NULL DEFAULT 0, task_json TEXT NOT NULL,
    UNIQUE(project_id, source, external_id)
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS workspace_task_inbox_pending
    ON workspace_task_inbox(status, created_at)`;
  yield* sql`CREATE INDEX IF NOT EXISTS workspace_task_inbox_project
    ON workspace_task_inbox(project_id, created_at)`;
  yield* sql`CREATE INDEX IF NOT EXISTS workspace_task_inbox_monitor
    ON workspace_task_inbox(project_id, monitor_key, created_at)`;
  yield* sql`CREATE TABLE IF NOT EXISTS workspace_task_inbox_events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL,
    status TEXT NOT NULL, attempt INTEGER NOT NULL, created_at TEXT NOT NULL, task_json TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS workspace_task_inbox_events_task ON workspace_task_inbox_events(task_id,sequence)`;
});
