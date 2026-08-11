import {
  ProjectId,
  WorkspaceIncident,
  WorkspaceIncidentId,
  WorkspaceIncidentStatus,
  WorkspaceProgram,
  WorkspaceProgramHealthCheck,
  WorkspaceProgramId,
  WorkspaceProgramIntegrity,
  WorkspaceProgramRun,
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
  ProjectionWorkspaceProgramRepository,
  type ProjectionWorkspaceProgramRepositoryShape,
} from "../Services/ProjectionWorkspacePrograms.ts";

const ProgramDbRow = WorkspaceProgram.mapFields(
  Struct.assign({
    environmentVariableNames: Schema.fromJsonString(Schema.Array(Schema.String)),
    healthCheck: Schema.NullOr(Schema.fromJsonString(WorkspaceProgramHealthCheck)),
    errorPatterns: Schema.fromJsonString(Schema.Array(Schema.String)),
    integrity: Schema.fromJsonString(WorkspaceProgramIntegrity),
    enabled: Schema.Number,
  }),
);
const RunDbRow = WorkspaceProgramRun;
const IncidentDbRow = WorkspaceIncident;
const ProgramLookup = Schema.Struct({ projectId: ProjectId, programId: WorkspaceProgramId });
const ProjectLookup = Schema.Struct({ projectId: ProjectId });
const RunListLookup = Schema.Struct({
  projectId: ProjectId,
  programId: Schema.NullOr(WorkspaceProgramId),
  limit: Schema.Int,
});
const IncidentLookup = Schema.Struct({ projectId: ProjectId, incidentId: WorkspaceIncidentId });
const IncidentFingerprintLookup = Schema.Struct({
  projectId: ProjectId,
  programId: WorkspaceProgramId,
  fingerprint: Schema.String,
});
const IncidentListLookup = Schema.Struct({
  projectId: ProjectId,
  programId: Schema.NullOr(WorkspaceProgramId),
  statusesJson: Schema.String,
  statusCount: Schema.Int,
  limit: Schema.Int,
});

const encodeStringArray = Schema.encodeUnknownSync(
  Schema.fromJsonString(Schema.Array(Schema.String)),
);
const encodeHealthCheck = Schema.encodeUnknownSync(
  Schema.fromJsonString(WorkspaceProgramHealthCheck),
);
const encodeIntegrity = Schema.encodeUnknownSync(Schema.fromJsonString(WorkspaceProgramIntegrity));
const encodeStatuses = Schema.encodeUnknownSync(
  Schema.fromJsonString(Schema.Array(WorkspaceIncidentStatus)),
);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const programColumns = sql`
    program_id AS "id", project_id AS "projectId", name, command,
    relative_directory AS "relativeDirectory",
    environment_variable_names_json AS "environmentVariableNames",
    start_policy AS "startPolicy", health_check_json AS "healthCheck",
    error_patterns_json AS "errorPatterns", enabled, integrity_json AS "integrity",
    created_at AS "createdAt", updated_at AS "updatedAt"
  `;
  const runColumns = sql`
    run_id AS "id", project_id AS "projectId", program_id AS "programId",
    status, pid, started_at AS "startedAt", stopped_at AS "stoppedAt",
    exit_code AS "exitCode", exit_signal AS "exitSignal",
    health_status AS "healthStatus",
    consecutive_health_failures AS "consecutiveHealthFailures",
    last_health_check_at AS "lastHealthCheckAt", recent_log_tail AS "recentLogTail",
    updated_at AS "updatedAt"
  `;
  const incidentColumns = sql`
    incident_id AS "id", project_id AS "projectId", program_id AS "programId",
    run_id AS "runId", kind, severity, status, fingerprint, summary, evidence,
    occurrence_count AS "occurrenceCount", first_occurred_at AS "firstOccurredAt",
    last_occurred_at AS "lastOccurredAt", diagnosis_thread_id AS "diagnosisThreadId",
    diagnosis, repair_run_id AS "repairRunId", resolved_at AS "resolvedAt",
    updated_at AS "updatedAt"
  `;

  const getProgramRow = SqlSchema.findOneOption({
    Request: ProgramLookup,
    Result: ProgramDbRow,
    execute: ({ projectId, programId }) =>
      sql`SELECT ${programColumns} FROM projection_workspace_programs
          WHERE project_id = ${projectId} AND program_id = ${programId} LIMIT 1`,
  });
  const listProgramRows = SqlSchema.findAll({
    Request: ProjectLookup,
    Result: ProgramDbRow,
    execute: ({ projectId }) =>
      sql`SELECT ${programColumns} FROM projection_workspace_programs
          WHERE project_id = ${projectId} ORDER BY name ASC, program_id ASC`,
  });
  const listAutoStartRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProgramDbRow,
    execute: () =>
      sql`SELECT ${programColumns} FROM projection_workspace_programs
          WHERE enabled = 1 AND start_policy = 'server-start'
          ORDER BY project_id ASC, name ASC, program_id ASC`,
  });
  const listIntegrityRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProgramDbRow,
    execute: () =>
      sql`SELECT ${programColumns} FROM projection_workspace_programs
          WHERE json_extract(integrity_json, '$.enabled') = 1
            AND json_extract(integrity_json, '$.status') IN ('queued', 'running', 'stopping')
          ORDER BY project_id ASC, name ASC, program_id ASC`,
  });
  const listRunRows = SqlSchema.findAll({
    Request: RunListLookup,
    Result: RunDbRow,
    execute: ({ projectId, programId, limit }) =>
      sql`SELECT ${runColumns} FROM projection_workspace_program_runs
          WHERE project_id = ${projectId}
            AND (${programId} IS NULL OR program_id = ${programId})
          ORDER BY started_at DESC, run_id DESC LIMIT ${limit}`,
  });
  const listActiveRunRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: RunDbRow,
    execute: () =>
      sql`SELECT ${runColumns} FROM projection_workspace_program_runs
          WHERE status IN ('starting', 'running', 'stopping')
          ORDER BY started_at ASC, run_id ASC`,
  });
  const getIncidentRow = SqlSchema.findOneOption({
    Request: IncidentLookup,
    Result: IncidentDbRow,
    execute: ({ projectId, incidentId }) =>
      sql`SELECT ${incidentColumns} FROM projection_workspace_incidents
          WHERE project_id = ${projectId} AND incident_id = ${incidentId} LIMIT 1`,
  });
  const findOpenIncidentRow = SqlSchema.findOneOption({
    Request: IncidentFingerprintLookup,
    Result: IncidentDbRow,
    execute: ({ projectId, programId, fingerprint }) =>
      sql`SELECT ${incidentColumns} FROM projection_workspace_incidents
          WHERE project_id = ${projectId} AND program_id = ${programId}
            AND fingerprint = ${fingerprint} AND status <> 'resolved'
          ORDER BY last_occurred_at DESC LIMIT 1`,
  });
  const listIncidentRows = SqlSchema.findAll({
    Request: IncidentListLookup,
    Result: IncidentDbRow,
    execute: ({ projectId, programId, statusesJson, statusCount, limit }) =>
      sql`SELECT ${incidentColumns} FROM projection_workspace_incidents
          WHERE project_id = ${projectId}
            AND (${programId} IS NULL OR program_id = ${programId})
            AND (${statusCount} = 0 OR status IN (SELECT value FROM json_each(${statusesJson})))
          ORDER BY last_occurred_at DESC, incident_id DESC LIMIT ${limit}`,
  });
  const listRecoverableIncidentRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: IncidentDbRow,
    execute: () =>
      sql`SELECT ${incidentColumns} FROM projection_workspace_incidents
          WHERE status IN ('open', 'diagnosing', 'verifying')
          ORDER BY last_occurred_at ASC, incident_id ASC`,
  });

  const mapProgram = (row: typeof ProgramDbRow.Type): WorkspaceProgram => ({
    ...row,
    enabled: row.enabled === 1,
  });
  const mapReadError = (operation: string) => (cause: unknown) =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(`${operation}:decode`)(cause)
      : toPersistenceSqlError(`${operation}:query`)(cause);

  const upsertProgram: ProjectionWorkspaceProgramRepositoryShape["upsertProgram"] = (program) =>
    sql`
      INSERT INTO projection_workspace_programs (
        program_id, project_id, name, command, relative_directory,
        environment_variable_names_json, start_policy, health_check_json,
        error_patterns_json, enabled, integrity_json, created_at, updated_at
      ) VALUES (
        ${program.id}, ${program.projectId}, ${program.name}, ${program.command},
        ${program.relativeDirectory}, ${encodeStringArray(program.environmentVariableNames)},
        ${program.startPolicy}, ${program.healthCheck === null ? null : encodeHealthCheck(program.healthCheck)},
        ${encodeStringArray(program.errorPatterns)}, ${program.enabled ? 1 : 0},
        ${encodeIntegrity(program.integrity)},
        ${program.createdAt}, ${program.updatedAt}
      )
      ON CONFLICT(project_id, program_id) DO UPDATE SET
        name = excluded.name, command = excluded.command,
        relative_directory = excluded.relative_directory,
        environment_variable_names_json = excluded.environment_variable_names_json,
        start_policy = excluded.start_policy, health_check_json = excluded.health_check_json,
        error_patterns_json = excluded.error_patterns_json, enabled = excluded.enabled,
        integrity_json = excluded.integrity_json,
        updated_at = excluded.updated_at
    `.pipe(
      Effect.asVoid,
      Effect.mapError(toPersistenceSqlError("ProjectionWorkspacePrograms.upsertProgram")),
    );

  const removeProgram: ProjectionWorkspaceProgramRepositoryShape["removeProgram"] = (input) =>
    sql`DELETE FROM projection_workspace_programs
        WHERE project_id = ${input.projectId} AND program_id = ${input.programId}`.pipe(
      Effect.asVoid,
      Effect.mapError(toPersistenceSqlError("ProjectionWorkspacePrograms.removeProgram")),
    );
  const removeByProjectId: ProjectionWorkspaceProgramRepositoryShape["removeByProjectId"] = (
    projectId,
  ) =>
    sql`DELETE FROM projection_workspace_programs WHERE project_id = ${projectId}`.pipe(
      Effect.asVoid,
      Effect.mapError(toPersistenceSqlError("ProjectionWorkspacePrograms.removeByProjectId")),
    );
  const getProgram: ProjectionWorkspaceProgramRepositoryShape["getProgram"] = (input) =>
    getProgramRow(input).pipe(
      Effect.map(Option.map(mapProgram)),
      Effect.mapError(mapReadError("ProjectionWorkspacePrograms.getProgram")),
    );
  const listPrograms: ProjectionWorkspaceProgramRepositoryShape["listPrograms"] = (projectId) =>
    listProgramRows({ projectId }).pipe(
      Effect.map((rows) => rows.map(mapProgram)),
      Effect.mapError(mapReadError("ProjectionWorkspacePrograms.listPrograms")),
    );
  const listAutoStartPrograms: ProjectionWorkspaceProgramRepositoryShape["listAutoStartPrograms"] =
    () =>
      listAutoStartRows(undefined).pipe(
        Effect.map((rows) => rows.map(mapProgram)),
        Effect.mapError(mapReadError("ProjectionWorkspacePrograms.listAutoStartPrograms")),
      );
  const updateIntegrity: ProjectionWorkspaceProgramRepositoryShape["updateIntegrity"] = (input) =>
    sql`UPDATE projection_workspace_programs
        SET integrity_json = ${encodeIntegrity(input.integrity)},
            updated_at = COALESCE(${input.integrity.updatedAt}, updated_at)
        WHERE project_id = ${input.projectId} AND program_id = ${input.programId}`.pipe(
      Effect.asVoid,
      Effect.mapError(toPersistenceSqlError("ProjectionWorkspacePrograms.updateIntegrity")),
    );
  const listIntegrityPrograms: ProjectionWorkspaceProgramRepositoryShape["listIntegrityPrograms"] =
    () =>
      listIntegrityRows(undefined).pipe(
        Effect.map((rows) => rows.map(mapProgram)),
        Effect.mapError(mapReadError("ProjectionWorkspacePrograms.listIntegrityPrograms")),
      );

  const upsertRun: ProjectionWorkspaceProgramRepositoryShape["upsertRun"] = (run) =>
    sql`
      INSERT INTO projection_workspace_program_runs (
        run_id, project_id, program_id, status, pid, started_at, stopped_at,
        exit_code, exit_signal, health_status, consecutive_health_failures,
        last_health_check_at, recent_log_tail, updated_at
      ) VALUES (
        ${run.id}, ${run.projectId}, ${run.programId}, ${run.status}, ${run.pid},
        ${run.startedAt}, ${run.stoppedAt}, ${run.exitCode}, ${run.exitSignal},
        ${run.healthStatus}, ${run.consecutiveHealthFailures}, ${run.lastHealthCheckAt},
        ${run.recentLogTail}, ${run.updatedAt}
      )
      ON CONFLICT(run_id) DO UPDATE SET
        status = excluded.status, pid = excluded.pid, stopped_at = excluded.stopped_at,
        exit_code = excluded.exit_code, exit_signal = excluded.exit_signal,
        health_status = excluded.health_status,
        consecutive_health_failures = excluded.consecutive_health_failures,
        last_health_check_at = excluded.last_health_check_at,
        recent_log_tail = excluded.recent_log_tail, updated_at = excluded.updated_at
      WHERE projection_workspace_program_runs.project_id = excluded.project_id
        AND projection_workspace_program_runs.program_id = excluded.program_id
    `.pipe(
      Effect.asVoid,
      Effect.mapError(toPersistenceSqlError("ProjectionWorkspacePrograms.upsertRun")),
    );
  const listRuns: ProjectionWorkspaceProgramRepositoryShape["listRuns"] = (input) =>
    listRunRows({
      projectId: input.projectId,
      programId: input.programId ?? null,
      limit: input.limit ?? 50,
    }).pipe(
      Effect.map((rows) => {
        const latestPrograms = new Set<string>();
        return rows.map((run) => {
          if (latestPrograms.has(run.programId)) return { ...run, recentLogTail: "" };
          latestPrograms.add(run.programId);
          return { ...run, recentLogTail: run.recentLogTail.slice(-8_192) };
        });
      }),
      Effect.mapError(mapReadError("ProjectionWorkspacePrograms.listRuns")),
    );
  const listActiveRuns: ProjectionWorkspaceProgramRepositoryShape["listActiveRuns"] = () =>
    listActiveRunRows(undefined).pipe(
      Effect.mapError(mapReadError("ProjectionWorkspacePrograms.listActiveRuns")),
    );

  const upsertIncident: ProjectionWorkspaceProgramRepositoryShape["upsertIncident"] = (incident) =>
    sql`
      INSERT INTO projection_workspace_incidents (
        incident_id, project_id, program_id, run_id, kind, severity, status,
        fingerprint, summary, evidence, occurrence_count, first_occurred_at,
        last_occurred_at, diagnosis_thread_id, diagnosis, repair_run_id,
        resolved_at, updated_at
      ) VALUES (
        ${incident.id}, ${incident.projectId}, ${incident.programId}, ${incident.runId},
        ${incident.kind}, ${incident.severity}, ${incident.status}, ${incident.fingerprint},
        ${incident.summary}, ${incident.evidence}, ${incident.occurrenceCount},
        ${incident.firstOccurredAt}, ${incident.lastOccurredAt}, ${incident.diagnosisThreadId},
        ${incident.diagnosis}, ${incident.repairRunId}, ${incident.resolvedAt}, ${incident.updatedAt}
      )
      ON CONFLICT(incident_id) DO UPDATE SET
        run_id = excluded.run_id, kind = excluded.kind, severity = excluded.severity,
        status = excluded.status, fingerprint = excluded.fingerprint,
        summary = excluded.summary, evidence = excluded.evidence,
        occurrence_count = excluded.occurrence_count,
        last_occurred_at = excluded.last_occurred_at,
        diagnosis_thread_id = excluded.diagnosis_thread_id,
        diagnosis = excluded.diagnosis, repair_run_id = excluded.repair_run_id,
        resolved_at = excluded.resolved_at, updated_at = excluded.updated_at
      WHERE projection_workspace_incidents.project_id = excluded.project_id
        AND projection_workspace_incidents.program_id = excluded.program_id
    `.pipe(
      Effect.asVoid,
      Effect.mapError(toPersistenceSqlError("ProjectionWorkspacePrograms.upsertIncident")),
    );
  const getIncident: ProjectionWorkspaceProgramRepositoryShape["getIncident"] = (input) =>
    getIncidentRow(input).pipe(
      Effect.mapError(mapReadError("ProjectionWorkspacePrograms.getIncident")),
    );
  const findOpenIncidentByFingerprint: ProjectionWorkspaceProgramRepositoryShape["findOpenIncidentByFingerprint"] =
    (input) =>
      findOpenIncidentRow(input).pipe(
        Effect.mapError(mapReadError("ProjectionWorkspacePrograms.findOpenIncidentByFingerprint")),
      );
  const listIncidents: ProjectionWorkspaceProgramRepositoryShape["listIncidents"] = (input) => {
    const statuses = input.statuses ?? [];
    return listIncidentRows({
      projectId: input.projectId,
      programId: input.programId ?? null,
      statusesJson: encodeStatuses(statuses),
      statusCount: statuses.length,
      limit: input.limit ?? 100,
    }).pipe(
      Effect.map((rows) =>
        rows.map((incident) => ({
          ...incident,
          evidence: incident.evidence.slice(-4_096),
          diagnosis: incident.diagnosis?.slice(-8_192) ?? null,
        })),
      ),
      Effect.mapError(mapReadError("ProjectionWorkspacePrograms.listIncidents")),
    );
  };
  const listRecoverableIncidents: ProjectionWorkspaceProgramRepositoryShape["listRecoverableIncidents"] =
    () =>
      listRecoverableIncidentRows(undefined).pipe(
        Effect.mapError(mapReadError("ProjectionWorkspacePrograms.listRecoverableIncidents")),
      );

  return ProjectionWorkspaceProgramRepository.of({
    upsertProgram,
    removeProgram,
    removeByProjectId,
    getProgram,
    listPrograms,
    listAutoStartPrograms,
    updateIntegrity,
    listIntegrityPrograms,
    upsertRun,
    listRuns,
    listActiveRuns,
    upsertIncident,
    getIncident,
    findOpenIncidentByFingerprint,
    listIncidents,
    listRecoverableIncidents,
  });
});

export const ProjectionWorkspaceProgramRepositoryLive = Layer.effect(
  ProjectionWorkspaceProgramRepository,
  make,
);
