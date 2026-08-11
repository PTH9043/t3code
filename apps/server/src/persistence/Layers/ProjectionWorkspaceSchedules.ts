import {
  IsoDateTime,
  ProjectId,
  WorkspaceSchedule,
  WorkspaceScheduleId,
  WorkspaceScheduleTiming,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceDecodeError, toPersistenceSqlError } from "../Errors.ts";
import {
  ProjectionWorkspaceScheduleRepository,
  type ProjectionWorkspaceScheduleRepositoryShape,
} from "../Services/ProjectionWorkspaceSchedules.ts";

const DbRow = WorkspaceSchedule.mapFields(
  Struct.assign({
    timing: Schema.fromJsonString(WorkspaceScheduleTiming),
    enabled: Schema.Number,
  }),
);
const ScheduleLookup = Schema.Struct({
  projectId: ProjectId,
  scheduleId: WorkspaceScheduleId,
});
const ProjectLookup = Schema.Struct({ projectId: ProjectId });
const DueLookup = Schema.Struct({ now: IsoDateTime });
const encodeTiming = Schema.encodeUnknownSync(Schema.fromJsonString(WorkspaceScheduleTiming));

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const selectColumns = sql`
    schedule_id AS "id",
    project_id AS "projectId",
    title,
    task,
    enabled,
    timing_json AS timing,
    next_trigger_at AS "nextTriggerAt",
    last_triggered_at AS "lastTriggeredAt",
    last_run_id AS "lastRunId",
    last_error AS "lastError",
    created_at AS "createdAt",
    updated_at AS "updatedAt"
  `;
  const getRow = SqlSchema.findOneOption({
    Request: ScheduleLookup,
    Result: DbRow,
    execute: ({ projectId, scheduleId }) =>
      sql`SELECT ${selectColumns} FROM projection_workspace_schedules
          WHERE project_id = ${projectId} AND schedule_id = ${scheduleId} LIMIT 1`,
  });
  const listRows = SqlSchema.findAll({
    Request: ProjectLookup,
    Result: DbRow,
    execute: ({ projectId }) =>
      sql`SELECT ${selectColumns} FROM projection_workspace_schedules
          WHERE project_id = ${projectId}
          ORDER BY title ASC, schedule_id ASC`,
  });
  const listPendingRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: DbRow,
    execute: () =>
      sql`SELECT ${selectColumns} FROM projection_workspace_schedules
          WHERE enabled = 1 AND next_trigger_at IS NULL
          ORDER BY project_id ASC, created_at ASC, schedule_id ASC`,
  });
  const listDueRows = SqlSchema.findAll({
    Request: DueLookup,
    Result: DbRow,
    execute: ({ now }) =>
      sql`SELECT ${selectColumns} FROM projection_workspace_schedules
          WHERE enabled = 1 AND next_trigger_at IS NOT NULL AND next_trigger_at <= ${now}
          ORDER BY next_trigger_at ASC, project_id ASC, schedule_id ASC`,
  });

  const decodeRows = (operation: string) => (cause: unknown) =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(`${operation}:decode`)(cause)
      : toPersistenceSqlError(`${operation}:query`)(cause);
  const mapRow = (row: typeof DbRow.Type): WorkspaceSchedule => ({
    ...row,
    enabled: row.enabled === 1,
  });

  const upsertDefinition: ProjectionWorkspaceScheduleRepositoryShape["upsertDefinition"] = (
    definition,
  ) =>
    sql`
        INSERT INTO projection_workspace_schedules (
          schedule_id, project_id, title, task, enabled, timing_json,
          next_trigger_at, last_triggered_at, last_run_id, last_error,
          created_at, updated_at
        ) VALUES (
          ${definition.scheduleId}, ${definition.projectId}, ${definition.title},
          ${definition.task}, ${definition.enabled ? 1 : 0},
          ${encodeTiming(definition.timing)}, NULL, NULL, NULL, NULL,
          ${definition.updatedAt}, ${definition.updatedAt}
        )
        ON CONFLICT(schedule_id) DO UPDATE SET
          title = excluded.title,
          task = excluded.task,
          enabled = excluded.enabled,
          timing_json = excluded.timing_json,
          next_trigger_at = NULL,
          last_error = NULL,
          updated_at = excluded.updated_at
        WHERE projection_workspace_schedules.project_id = excluded.project_id
      `.pipe(
      Effect.asVoid,
      Effect.mapError(toPersistenceSqlError("ProjectionWorkspaceSchedules.upsertDefinition")),
    );

  const remove: ProjectionWorkspaceScheduleRepositoryShape["remove"] = (input) =>
    sql`DELETE FROM projection_workspace_schedules
        WHERE project_id = ${input.projectId} AND schedule_id = ${input.scheduleId}`.pipe(
      Effect.asVoid,
      Effect.mapError(toPersistenceSqlError("ProjectionWorkspaceSchedules.remove")),
    );

  const removeByProjectId: ProjectionWorkspaceScheduleRepositoryShape["removeByProjectId"] = (
    projectId,
  ) =>
    sql`DELETE FROM projection_workspace_schedules WHERE project_id = ${projectId}`.pipe(
      Effect.asVoid,
      Effect.mapError(toPersistenceSqlError("ProjectionWorkspaceSchedules.removeByProjectId")),
    );

  const updateRuntime: ProjectionWorkspaceScheduleRepositoryShape["updateRuntime"] = (runtime) =>
    sql`
      UPDATE projection_workspace_schedules
      SET next_trigger_at = ${runtime.nextTriggerAt},
          last_triggered_at = ${runtime.lastTriggeredAt},
          last_run_id = ${runtime.lastRunId},
          last_error = ${runtime.lastError},
          updated_at = ${runtime.updatedAt}
      WHERE project_id = ${runtime.projectId} AND schedule_id = ${runtime.scheduleId}
    `.pipe(
      Effect.asVoid,
      Effect.mapError(toPersistenceSqlError("ProjectionWorkspaceSchedules.updateRuntime")),
    );

  const getById: ProjectionWorkspaceScheduleRepositoryShape["getById"] = (input) =>
    getRow(input).pipe(
      Effect.map(Option.map(mapRow)),
      Effect.mapError(decodeRows("ProjectionWorkspaceSchedules.getById")),
    );

  const listByProjectId: ProjectionWorkspaceScheduleRepositoryShape["listByProjectId"] = (
    projectId,
  ) =>
    listRows({ projectId }).pipe(
      Effect.map((rows) => rows.map(mapRow)),
      Effect.mapError(decodeRows("ProjectionWorkspaceSchedules.listByProjectId")),
    );

  const listPendingReconciliation: ProjectionWorkspaceScheduleRepositoryShape["listPendingReconciliation"] =
    () =>
      listPendingRows(undefined).pipe(
        Effect.map((rows) => rows.map(mapRow)),
        Effect.mapError(decodeRows("ProjectionWorkspaceSchedules.listPendingReconciliation")),
      );

  const listDue: ProjectionWorkspaceScheduleRepositoryShape["listDue"] = (now) =>
    listDueRows({ now }).pipe(
      Effect.map((rows) => rows.map(mapRow)),
      Effect.mapError(decodeRows("ProjectionWorkspaceSchedules.listDue")),
    );

  return ProjectionWorkspaceScheduleRepository.of({
    upsertDefinition,
    remove,
    removeByProjectId,
    updateRuntime,
    getById,
    listByProjectId,
    listPendingReconciliation,
    listDue,
  });
});

export const ProjectionWorkspaceScheduleRepositoryLive = Layer.effect(
  ProjectionWorkspaceScheduleRepository,
  make,
);
