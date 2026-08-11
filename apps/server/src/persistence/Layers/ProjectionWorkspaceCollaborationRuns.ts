import {
  ProjectId,
  WorkspaceCollaborationRun,
  WorkspaceCollaborationRunId,
  WorkspaceCollaborationStep,
  WorkspaceTaskGraph,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceDecodeError, toPersistenceSqlError } from "../Errors.ts";
import {
  ProjectionWorkspaceCollaborationRunRepository,
  type ProjectionWorkspaceCollaborationRunRepositoryShape,
} from "../Services/ProjectionWorkspaceCollaborationRuns.ts";

const DbRow = WorkspaceCollaborationRun.mapFields(
  Struct.assign({
    steps: Schema.fromJsonString(Schema.Array(WorkspaceCollaborationStep)),
    graph: Schema.NullOr(Schema.fromJsonString(WorkspaceTaskGraph)),
  }),
);
const RunLookup = Schema.Struct({ projectId: ProjectId, runId: WorkspaceCollaborationRunId });
const ProjectLookup = Schema.Struct({ projectId: ProjectId });
const encodeSteps = Schema.encodeUnknownSync(
  Schema.fromJsonString(Schema.Array(WorkspaceCollaborationStep)),
);
const encodeGraph = Schema.encodeUnknownSync(
  Schema.NullOr(Schema.fromJsonString(WorkspaceTaskGraph)),
);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const selectColumns = sql`
    run_id AS "id",
    project_id AS "projectId",
    source,
    schedule_id AS "scheduleId",
    incident_id AS "incidentId",
    task,
    status,
    steps_json AS steps,
    graph_json AS graph,
    final_output AS "finalOutput",
    error,
    created_at AS "createdAt",
    updated_at AS "updatedAt"
  `;
  const getRow = SqlSchema.findOneOption({
    Request: RunLookup,
    Result: DbRow,
    execute: ({ projectId, runId }) =>
      sql`SELECT ${selectColumns} FROM projection_workspace_collaboration_runs
          WHERE project_id = ${projectId} AND run_id = ${runId} LIMIT 1`,
  });
  const listRows = SqlSchema.findAll({
    Request: ProjectLookup,
    Result: DbRow,
    execute: ({ projectId }) =>
      sql`SELECT ${selectColumns} FROM projection_workspace_collaboration_runs
          WHERE project_id = ${projectId}
          ORDER BY created_at DESC, run_id DESC`,
  });
  const listResumableRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: DbRow,
    execute: () =>
      // Runs belonging to a deleted project are not resumable: restarting them would create
      // fresh threads and turns under a project the user removed.
      sql`SELECT ${selectColumns} FROM projection_workspace_collaboration_runs AS runs
          WHERE runs.status IN ('queued', 'running', 'cancel-requested')
            AND EXISTS (
              SELECT 1 FROM projection_projects AS projects
              WHERE projects.project_id = runs.project_id AND projects.deleted_at IS NULL
            )
          ORDER BY runs.created_at ASC, runs.run_id ASC`,
  });

  const upsert: ProjectionWorkspaceCollaborationRunRepositoryShape["upsert"] = (run) =>
    sql`
      INSERT INTO projection_workspace_collaboration_runs (
        run_id, project_id, source, schedule_id, incident_id, task, status, steps_json, graph_json,
        final_output, error, created_at, updated_at
      ) VALUES (
        ${run.id}, ${run.projectId}, ${run.source}, ${run.scheduleId}, ${run.incidentId},
        ${run.task}, ${run.status}, ${encodeSteps(run.steps)}, ${encodeGraph(run.graph)},
        ${run.finalOutput}, ${run.error}, ${run.createdAt}, ${run.updatedAt}
      )
      ON CONFLICT(run_id) DO UPDATE SET
        source = excluded.source,
        schedule_id = excluded.schedule_id,
        incident_id = excluded.incident_id,
        task = excluded.task,
        status = excluded.status,
        steps_json = excluded.steps_json,
        graph_json = excluded.graph_json,
        final_output = excluded.final_output,
        error = excluded.error,
        updated_at = excluded.updated_at
      WHERE projection_workspace_collaboration_runs.project_id = excluded.project_id
        AND (
          projection_workspace_collaboration_runs.status = excluded.status
          OR (
            projection_workspace_collaboration_runs.status = 'queued'
            AND excluded.status IN ('running', 'cancelled', 'failed')
          )
          OR (
            projection_workspace_collaboration_runs.status = 'running'
            AND excluded.status IN (
              'cancel-requested', 'cancelled', 'completed', 'failed'
            )
          )
          OR (
            projection_workspace_collaboration_runs.status = 'cancel-requested'
            AND excluded.status = 'cancelled'
          )
        )
    `.pipe(
      Effect.asVoid,
      Effect.mapError(toPersistenceSqlError("ProjectionWorkspaceCollaborationRuns.upsert")),
    );

  const requestCancel: ProjectionWorkspaceCollaborationRunRepositoryShape["requestCancel"] = (
    input,
  ) =>
    sql`
        UPDATE projection_workspace_collaboration_runs
        SET status = CASE
          WHEN status = 'queued' THEN 'cancelled'
          WHEN status = 'running' THEN 'cancel-requested'
          ELSE status
        END,
        updated_at = ${input.cancelledAt}
        WHERE project_id = ${input.projectId} AND run_id = ${input.runId}
          AND status IN ('queued', 'running', 'cancel-requested')
      `.pipe(
      Effect.asVoid,
      Effect.mapError(toPersistenceSqlError("ProjectionWorkspaceCollaborationRuns.requestCancel")),
    );

  const decodeError = (operation: string) => (cause: unknown) =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(`${operation}:decode`)(cause)
      : toPersistenceSqlError(`${operation}:query`)(cause);

  const getById: ProjectionWorkspaceCollaborationRunRepositoryShape["getById"] = (input) =>
    getRow(input).pipe(
      Effect.mapError(decodeError("ProjectionWorkspaceCollaborationRuns.getById")),
    );

  const list: ProjectionWorkspaceCollaborationRunRepositoryShape["list"] = (input) =>
    listRows({ projectId: input.projectId }).pipe(
      Effect.map((runs) => {
        if (input.statuses === undefined) return runs;
        const statuses = new Set(input.statuses);
        return runs.filter((run) => statuses.has(run.status));
      }),
      Effect.mapError(decodeError("ProjectionWorkspaceCollaborationRuns.list")),
    );

  const listResumable: ProjectionWorkspaceCollaborationRunRepositoryShape["listResumable"] = () =>
    listResumableRows(undefined).pipe(
      Effect.mapError(decodeError("ProjectionWorkspaceCollaborationRuns.listResumable")),
    );

  return ProjectionWorkspaceCollaborationRunRepository.of({
    upsert,
    requestCancel,
    getById,
    list,
    listResumable,
  });
});

export const ProjectionWorkspaceCollaborationRunRepositoryLive = Layer.effect(
  ProjectionWorkspaceCollaborationRunRepository,
  make,
);
