import {
  WorkflowRunSummary,
  WorkspaceCollaborationRun,
  WorkspaceTaskGraph,
  WorkspaceWorkflowContext,
} from "@t3tools/contracts";
import { summarizeWorkflowRun } from "@t3tools/shared/workflow";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const Row = Schema.Struct({
  id: WorkspaceCollaborationRun.fields.id,
  projectId: WorkspaceCollaborationRun.fields.projectId,
  status: WorkspaceCollaborationRun.fields.status,
  createdAt: WorkspaceCollaborationRun.fields.createdAt,
  updatedAt: WorkspaceCollaborationRun.fields.updatedAt,
  error: WorkspaceCollaborationRun.fields.error,
  workflow: Schema.fromJsonString(WorkspaceWorkflowContext),
  graph: Schema.NullOr(Schema.fromJsonString(WorkspaceTaskGraph)),
});
const decode = Schema.decodeUnknownEffect(Row);
const encode = Schema.encodeEffect(Schema.fromJsonString(WorkflowRunSummary));

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE projection_workspace_workflow_run_summaries (
    project_id TEXT NOT NULL, run_id TEXT PRIMARY KEY, summary_json TEXT NOT NULL, updated_at TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX idx_workflow_run_summaries_project ON projection_workspace_workflow_run_summaries(project_id,updated_at,run_id)`;
  yield* sql`CREATE INDEX idx_workflow_runs_project ON projection_workspace_collaboration_runs(project_id,created_at,run_id) WHERE workflow_json IS NOT NULL`;
  const rows =
    yield* sql`SELECT run_id AS id, project_id AS "projectId", status, created_at AS "createdAt", updated_at AS "updatedAt", error,workflow_json AS workflow,graph_json AS graph FROM projection_workspace_collaboration_runs WHERE workflow_json IS NOT NULL`;
  for (const row of rows) {
    const summary = summarizeWorkflowRun(yield* decode(row));
    if (summary)
      yield* sql`INSERT INTO projection_workspace_workflow_run_summaries(project_id,run_id,summary_json,updated_at) VALUES(${summary.projectId},${summary.id},${yield* encode(summary)},${summary.updatedAt})`;
  }
});
