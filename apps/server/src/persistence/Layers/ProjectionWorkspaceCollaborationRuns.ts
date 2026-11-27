import {
  ProjectId,
  WorkspaceCollaborationRun,
  WorkspaceCollaborationRunId,
  WorkspaceCollaborationRunListInput,
  WorkspaceCollaborationStep,
  WorkspaceMeeting,
  WorkspaceMeetingInterjection,
  WorkspaceOrchestraSettings,
  WorkspaceRunControl,
  WorkspaceRunContext,
  WorkspaceTaskGraph,
  WorkspaceWorkflowContext,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import {
  PersistenceDecodeError,
  type ProjectionRepositoryError,
  toPersistenceDecodeError,
  toPersistenceSqlError,
} from "../Errors.ts";
import { reviewWorkspaceOrchestraRun } from "../../orchestration/workspaceOrchestraReview.ts";
import {
  ProjectionWorkspaceCollaborationRunRepository,
  type ProjectionWorkspaceCollaborationRunRepositoryShape,
} from "../Services/ProjectionWorkspaceCollaborationRuns.ts";

import { controlWorkflowRun } from "../../orchestration/workspaceWorkflow.ts";
import { make as makeWorkflowStore } from "../WorkspaceWorkflowStore.ts";

const WorkflowColumn = Schema.NullOr(Schema.fromJsonString(WorkspaceWorkflowContext));
const RunControlColumn = Schema.NullOr(Schema.fromJsonString(WorkspaceRunControl));
const RunContextColumn = Schema.NullOr(Schema.fromJsonString(WorkspaceRunContext));
const MeetingColumn = Schema.NullOr(Schema.fromJsonString(WorkspaceMeeting));
// NULL is both "recorded before the orchestra" and "never opted in".
const OrchestraColumn = Schema.NullOr(Schema.fromJsonString(WorkspaceOrchestraSettings));
const DbRow = WorkspaceCollaborationRun.mapFields(
  Struct.assign({
    steps: Schema.fromJsonString(Schema.Array(WorkspaceCollaborationStep)),
    graph: Schema.NullOr(Schema.fromJsonString(WorkspaceTaskGraph)),
    meeting: MeetingColumn,
    orchestra: OrchestraColumn,
    workflow: WorkflowColumn,
    runControl: RunControlColumn,
    runContext: RunContextColumn,
  }),
);
const RunLookup = Schema.Struct({ projectId: ProjectId, runId: WorkspaceCollaborationRunId });
const encodeSteps = Schema.encodeUnknownSync(
  Schema.fromJsonString(Schema.Array(WorkspaceCollaborationStep)),
);
const encodeGraph = Schema.encodeUnknownSync(
  Schema.NullOr(Schema.fromJsonString(WorkspaceTaskGraph)),
);
const encodeWorkflow = Schema.encodeUnknownSync(WorkflowColumn);
const encodeRunControl = Schema.encodeUnknownSync(RunControlColumn);
const encodeRunContext = Schema.encodeUnknownSync(RunContextColumn);
const encodeMeeting = Schema.encodeUnknownSync(MeetingColumn);
const encodeOrchestra = Schema.encodeUnknownSync(OrchestraColumn);
const decodeMeeting = Schema.decodeUnknownSync(MeetingColumn);
const decodeWorkflow = Schema.decodeUnknownEffect(WorkflowColumn);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const LIST_CACHE_TTL_MS = 5_000;
  const listCache = new Map<
    string,
    {
      readonly runs: ReadonlyArray<WorkspaceCollaborationRun>;
      readonly expiresAtMs: number;
    }
  >();
  const inFlightLists = new Map<
    string,
    Deferred.Deferred<ReadonlyArray<WorkspaceCollaborationRun>, ProjectionRepositoryError>
  >();
  const invalidateListCache = (projectId?: string) => {
    if (!projectId) {
      listCache.clear();
      return;
    }
    for (const key of listCache.keys()) {
      if (key.startsWith(`${projectId}\u0000`)) {
        listCache.delete(key);
      }
    }
  };
  const workflowStore = yield* makeWorkflowStore;
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
    meeting_json AS meeting,
    orchestra_json AS orchestra,
    workflow_json AS workflow,
    run_control_json AS "runControl",
    run_context_json AS "runContext",
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
    Request: WorkspaceCollaborationRunListInput,
    Result: DbRow,
    execute: ({ projectId, workflowOnly, runId }) =>
      sql`SELECT ${selectColumns} FROM projection_workspace_collaboration_runs
          WHERE project_id = ${projectId}
            AND ${workflowOnly ? sql`workflow_json IS NOT NULL` : sql`1=1`}
            AND ${runId ? sql`run_id=${runId}` : sql`1=1`}
          ORDER BY created_at DESC, run_id DESC`,
  });
  // Interjections live in their own table (see migration 055): the reactor
  // rewrites meeting_json wholesale from its own snapshot, so the person's
  // remarks are stored out of its reach and grafted back on every read. The
  // copy inside meeting_json is ignored.
  const listInterjectionRows = SqlSchema.findAll({
    Request: RunLookup,
    Result: WorkspaceMeetingInterjection,
    execute: ({ projectId, runId }) =>
      sql`SELECT
            text,
            round_index AS "roundIndex",
            after_statements AS "afterStatements",
            said_at AS "saidAt"
          FROM projection_workspace_collaboration_interjections
          WHERE project_id = ${projectId} AND run_id = ${runId}
          ORDER BY id ASC`,
  });
  const hydrateInterjections = (run: WorkspaceCollaborationRun) => {
    const meeting = run.meeting;
    if (meeting === null) return Effect.succeed(run);
    return listInterjectionRows({ projectId: run.projectId, runId: run.id }).pipe(
      Effect.map(
        (interjections): WorkspaceCollaborationRun => ({
          ...run,
          meeting: { ...meeting, interjections },
        }),
      ),
    );
  };

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
    sql<{ workflow: string | null }>`
      INSERT INTO projection_workspace_collaboration_runs (
        run_id, project_id, source, schedule_id, incident_id, task, status, steps_json, graph_json,
        meeting_json, orchestra_json, workflow_json, run_control_json, run_context_json, final_output, error, created_at, updated_at
      ) VALUES (
        ${run.id}, ${run.projectId}, ${run.source}, ${run.scheduleId}, ${run.incidentId},
        ${run.task}, ${run.status}, ${encodeSteps(run.steps)}, ${encodeGraph(run.graph)},
        ${encodeMeeting(run.meeting)}, ${encodeOrchestra(run.orchestra)}, ${encodeWorkflow(run.workflow ?? null)}, ${encodeRunControl(run.runControl ?? null)}, ${encodeRunContext(run.runContext ?? null)},
        ${run.finalOutput}, ${run.error}, ${run.createdAt}, ${run.updatedAt}
      )
      ON CONFLICT(run_id) DO UPDATE SET
        source = excluded.source,
        schedule_id = excluded.schedule_id,
        incident_id = excluded.incident_id,
        task = excluded.task,
        status = CASE
          WHEN excluded.status = 'completed' AND excluded.meeting_json IS NOT NULL
            AND (SELECT count(*) FROM projection_workspace_collaboration_interjections
              WHERE project_id = excluded.project_id AND run_id = excluded.run_id)
              > COALESCE(json_extract(excluded.meeting_json, '$.supervisorReviewedInterjections'), 0)
          THEN 'running'
          ELSE excluded.status
        END,
        steps_json = excluded.steps_json,
        graph_json = excluded.graph_json,
        meeting_json = CASE
          WHEN excluded.status = 'completed' AND excluded.meeting_json IS NOT NULL
            AND (SELECT count(*) FROM projection_workspace_collaboration_interjections
              WHERE project_id = excluded.project_id AND run_id = excluded.run_id)
              > COALESCE(json_extract(excluded.meeting_json, '$.supervisorReviewedInterjections'), 0)
          THEN json_set(
            excluded.meeting_json,
            '$.phase', 'executing',
            '$.pendingSupervisorReview', json('true'),
            '$.answers', json(CASE
              WHEN COALESCE(json_array_length(json_extract(projection_workspace_collaboration_runs.meeting_json, '$.answers')), 0)
                > COALESCE(json_array_length(json_extract(excluded.meeting_json, '$.answers')), 0)
              THEN json_extract(projection_workspace_collaboration_runs.meeting_json, '$.answers')
              ELSE json_extract(excluded.meeting_json, '$.answers') END),
            '$.pendingQuestion', json(CASE
              WHEN COALESCE(json_array_length(json_extract(projection_workspace_collaboration_runs.meeting_json, '$.answers')), 0)
                > COALESCE(json_array_length(json_extract(excluded.meeting_json, '$.answers')), 0)
              THEN json_extract(projection_workspace_collaboration_runs.meeting_json, '$.pendingQuestion')
              ELSE json_extract(excluded.meeting_json, '$.pendingQuestion') END)
          )
          WHEN excluded.meeting_json IS NOT NULL
            AND projection_workspace_collaboration_runs.meeting_json IS NOT NULL
            AND COALESCE(json_array_length(json_extract(projection_workspace_collaboration_runs.meeting_json, '$.answers')), 0)
              > COALESCE(json_array_length(json_extract(excluded.meeting_json, '$.answers')), 0)
          THEN json_set(
            excluded.meeting_json,
            '$.answers', json(json_extract(projection_workspace_collaboration_runs.meeting_json, '$.answers')),
            '$.pendingQuestion', json_extract(projection_workspace_collaboration_runs.meeting_json, '$.pendingQuestion')
          )
          ELSE excluded.meeting_json
        END,
        orchestra_json = excluded.orchestra_json,
        workflow_json = CASE WHEN excluded.workflow_json IS NULL OR COALESCE(json_extract(projection_workspace_collaboration_runs.workflow_json,'$.controlRevision'),0) > COALESCE(json_extract(excluded.workflow_json,'$.controlRevision'),0) THEN projection_workspace_collaboration_runs.workflow_json ELSE excluded.workflow_json END,
        run_control_json = CASE WHEN excluded.run_control_json IS NULL OR COALESCE(json_extract(projection_workspace_collaboration_runs.run_control_json,'$.controlRevision'),json_extract(projection_workspace_collaboration_runs.workflow_json,'$.controlRevision'),0) > COALESCE(json_extract(excluded.run_control_json,'$.controlRevision'),json_extract(excluded.workflow_json,'$.controlRevision'),0) THEN projection_workspace_collaboration_runs.run_control_json ELSE excluded.run_control_json END,
        run_context_json = COALESCE(projection_workspace_collaboration_runs.run_context_json, excluded.run_context_json),
        final_output = excluded.final_output,
        error = excluded.error,
        updated_at = excluded.updated_at
      WHERE projection_workspace_collaboration_runs.project_id = excluded.project_id
        AND COALESCE(json_extract(projection_workspace_collaboration_runs.run_control_json,'$.executionRevision'),json_extract(projection_workspace_collaboration_runs.workflow_json,'$.executionRevision'),0) = COALESCE(json_extract(excluded.run_control_json,'$.executionRevision'),json_extract(excluded.workflow_json,'$.executionRevision'),0)
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
      RETURNING workflow_json AS workflow
    `.pipe(
      Effect.flatMap((rows) =>
        rows[0]?.workflow
          ? decodeWorkflow(rows[0].workflow).pipe(
              Effect.flatMap((workflow) => workflowStore.projectRunSummary({ ...run, workflow })),
            )
          : Effect.void,
      ),
      Effect.tap(() => Effect.sync(() => invalidateListCache(run.projectId))),
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
      Effect.andThen(
        Effect.gen(function* () {
          invalidateListCache(input.projectId);
          const current = yield* getRow(input);
          if (Option.isSome(current) && current.value.workflow)
            yield* workflowStore.projectRunSummary(current.value);
        }),
      ),
      Effect.mapError(toPersistenceSqlError("ProjectionWorkspaceCollaborationRuns.requestCancel")),
    );

  const decodeError = (operation: string) => (cause: unknown) =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(`${operation}:decode`)(cause)
      : toPersistenceSqlError(`${operation}:query`)(cause);

  /**
   * Clears the question the run is parked on and appends the person's answer.
   *
   * Read-modify-write rather than a `json_set` expression: the answer has to be
   * matched against the question actually pending, so a client that was showing
   * a superseded question cannot answer the one that replaced it. A mismatch is
   * a no-op, not an error — the run has already moved on.
   */
  const recordAnswer: ProjectionWorkspaceCollaborationRunRepositoryShape["recordAnswer"] = (
    input,
  ) =>
    Effect.gen(function* () {
      const rows = yield* sql<{
        readonly meeting: string | null;
      }>`SELECT meeting_json AS meeting FROM projection_workspace_collaboration_runs
         WHERE project_id = ${input.projectId} AND run_id = ${input.runId}
           AND status IN ('queued', 'running') LIMIT 1`.pipe(
        Effect.mapError(
          toPersistenceSqlError("ProjectionWorkspaceCollaborationRuns.recordAnswer:select"),
        ),
      );
      const raw = rows[0]?.meeting;
      if (raw === undefined || raw === null) return;

      const meeting = yield* Effect.try({
        try: () => decodeMeeting(raw),
        catch: decodeError("ProjectionWorkspaceCollaborationRuns.recordAnswer"),
      });
      const pending = meeting?.pendingQuestion;
      if (meeting === null || pending == null || pending.question !== input.question) return;
      if (
        input.questionRef !== undefined &&
        (input.questionRef.nodeId !== pending.nodeId ||
          input.questionRef.askedAt !== pending.askedAt)
      )
        return;

      const next = {
        ...meeting,
        pendingQuestion: null,
        answers: [
          ...meeting.answers,
          {
            question: input.question,
            answer: input.answer,
            ...(input.imageReferences ? { imageReferences: input.imageReferences } : {}),
            answeredAt: input.answeredAt,
            nodeId: pending.nodeId,
          },
        ],
      };
      yield* sql`
        UPDATE projection_workspace_collaboration_runs
        SET meeting_json = ${encodeMeeting(next)}, updated_at = ${input.answeredAt}
        WHERE project_id = ${input.projectId} AND run_id = ${input.runId}
      `.pipe(
        Effect.asVoid,
        Effect.tap(() => Effect.sync(() => invalidateListCache(input.projectId))),
        Effect.mapError(
          toPersistenceSqlError("ProjectionWorkspaceCollaborationRuns.recordAnswer:update"),
        ),
      );
    });

  /**
   * Appends the person's remark, anchored to the transcript position the
   * stored snapshot shows. The anchor can trail the live discussion by the
   * turn in flight — close enough for "said around here" — but the row itself
   * can never be lost to the reactor's wholesale meeting_json rewrites.
   */
  const recordInterjection: ProjectionWorkspaceCollaborationRunRepositoryShape["recordInterjection"] =
    (input) =>
      Effect.gen(function* () {
        const rows = yield* sql<{
          readonly meeting: string | null;
          readonly status: string;
        }>`SELECT meeting_json AS meeting, status FROM projection_workspace_collaboration_runs
           WHERE project_id = ${input.projectId} AND run_id = ${input.runId} LIMIT 1`.pipe(
          Effect.mapError(
            toPersistenceSqlError("ProjectionWorkspaceCollaborationRuns.recordInterjection:select"),
          ),
        );
        const row = rows[0];
        if (row === undefined || row.meeting === null) return;
        if (!["queued", "running", "cancel-requested"].includes(row.status)) return;

        const meeting = yield* Effect.try({
          try: () => decodeMeeting(row.meeting),
          catch: decodeError("ProjectionWorkspaceCollaborationRuns.recordInterjection"),
        });
        if (meeting === null || meeting.phase === "done") return;

        const openRound = meeting.rounds.at(-1);
        yield* sql`
          INSERT INTO projection_workspace_collaboration_interjections (
            project_id, run_id, text, round_index, after_statements, said_at
          ) VALUES (
            ${input.projectId}, ${input.runId}, ${input.text},
            ${openRound?.index ?? meeting.rounds.length},
            ${openRound?.statements.length ?? 0},
            ${input.interjectedAt}
          )
        `.pipe(
          Effect.asVoid,
          Effect.tap(() => Effect.sync(() => invalidateListCache(input.projectId))),
          Effect.mapError(
            toPersistenceSqlError("ProjectionWorkspaceCollaborationRuns.recordInterjection:insert"),
          ),
        );
      });

  const getById: ProjectionWorkspaceCollaborationRunRepositoryShape["getById"] = (input) =>
    getRow(input).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.succeedNone,
          onSome: (run) => hydrateInterjections(run).pipe(Effect.map(Option.some)),
        }),
      ),
      Effect.mapError(decodeError("ProjectionWorkspaceCollaborationRuns.getById")),
    );

  const list: ProjectionWorkspaceCollaborationRunRepositoryShape["list"] = (input) =>
    Effect.gen(function* () {
      const cacheKey = `${input.projectId}\u0000${input.runId ?? ""}\u0000${input.workflowOnly ? "1" : "0"}\u0000${(input.statuses ?? []).slice().sort().join(",")}`;
      const nowMs = yield* Clock.currentTimeMillis;
      const cached = listCache.get(cacheKey);
      if (cached !== undefined && nowMs < cached.expiresAtMs) {
        return cached.runs;
      }
      const existingInFlight = inFlightLists.get(cacheKey);
      if (existingInFlight !== undefined) {
        return yield* Deferred.await(existingInFlight);
      }
      const deferred = yield* Deferred.make<
        ReadonlyArray<WorkspaceCollaborationRun>,
        ProjectionRepositoryError
      >();
      inFlightLists.set(cacheKey, deferred);
      return yield* listRows(input).pipe(
        Effect.map((runs) => {
          if (input.statuses === undefined) return runs;
          const statuses = new Set(input.statuses);
          return runs.filter((run) => statuses.has(run.status));
        }),
        Effect.flatMap((runs) => Effect.forEach(runs, hydrateInterjections)),
        Effect.mapError(decodeError("ProjectionWorkspaceCollaborationRuns.list")),
        Effect.tap((hydrated) =>
          Effect.gen(function* () {
            const doneMs = yield* Clock.currentTimeMillis;
            listCache.set(cacheKey, { runs: hydrated, expiresAtMs: doneMs + LIST_CACHE_TTL_MS });
            yield* Deferred.succeed(deferred, hydrated);
          }),
        ),
        Effect.tapError((cause) => Deferred.fail(deferred, cause).pipe(Effect.ignore)),
        Effect.ensuring(
          Effect.sync(() => {
            if (inFlightLists.get(cacheKey) === deferred) {
              inFlightLists.delete(cacheKey);
            }
          }),
        ),
      );
    });

  const listResumable: ProjectionWorkspaceCollaborationRunRepositoryShape["listResumable"] = () =>
    listResumableRows(undefined).pipe(
      Effect.flatMap((runs) => Effect.forEach(runs, hydrateInterjections)),
      Effect.mapError(decodeError("ProjectionWorkspaceCollaborationRuns.listResumable")),
    );

  const recordControl: ProjectionWorkspaceCollaborationRunRepositoryShape["recordControl"] = (
    input,
  ) =>
    Effect.gen(function* () {
      const current = yield* getById(input);
      if (Option.isNone(current))
        return yield* new PersistenceDecodeError({
          operation: "workflow.control",
          issue: "실행을 찾을 수 없습니다.",
        });
      if (
        input.action === "retry" &&
        input.nodeId &&
        !(yield* workflowStore.retrySafe(input.runId, input.nodeId, !current.value.workflow).pipe(
          Effect.mapError(
            (cause) =>
              new PersistenceDecodeError({
                operation: "workflow.control",
                issue: cause.message,
                cause,
              }),
          ),
        ))
      )
        return yield* new PersistenceDecodeError({
          operation: "workflow.control",
          issue: "이전 입력의 전달·종료가 미확인입니다. 원래 실행 상태를 먼저 대조하세요.",
        });
      const next = yield* Effect.try({
        try: () => controlWorkflowRun(current.value, input, input.createdAt),
        catch: (cause) =>
          new PersistenceDecodeError({
            operation: "workflow.control",
            issue: cause instanceof Error ? cause.message : String(cause),
            cause,
          }),
      });
      yield* sql`UPDATE projection_workspace_collaboration_runs SET status=${next.status}, graph_json=${encodeGraph(next.graph)}, workflow_json=${encodeWorkflow(next.workflow ?? null)}, run_control_json=${encodeRunControl(next.runControl ?? null)}, error=${next.error},updated_at=${next.updatedAt} WHERE project_id=${input.projectId} AND run_id=${input.runId}`.pipe(
        Effect.tap(() => Effect.sync(() => invalidateListCache(input.projectId))),
        Effect.mapError(toPersistenceSqlError("workflow.control")),
      );
      yield* workflowStore
        .projectRunSummary(next)
        .pipe(Effect.mapError(toPersistenceSqlError("workflow.control-summary")));
    });
  const recordReview: NonNullable<
    ProjectionWorkspaceCollaborationRunRepositoryShape["recordReview"]
  > = (input) =>
    Effect.gen(function* () {
      const current = yield* getRow(input).pipe(
        Effect.mapError(decodeError("ProjectionWorkspaceCollaborationRuns.recordReview")),
      );
      if (Option.isNone(current))
        return yield* new PersistenceDecodeError({
          operation: "recordReview",
          issue: "실행을 찾을 수 없습니다.",
        });
      const reviewed = yield* Effect.try({
        try: () => reviewWorkspaceOrchestraRun(current.value, input),
        catch: (cause) =>
          new PersistenceDecodeError({
            operation: "ProjectionWorkspaceCollaborationRuns.recordReview",
            issue: cause instanceof Error ? cause.message : String(cause),
            cause,
          }),
      });
      if (reviewed === null)
        return yield* new PersistenceDecodeError({
          operation: "recordReview",
          issue: "실행 계획이 변경되었거나 이미 시작되었습니다. 최신 계획을 확인하세요.",
        });
      yield* upsert(reviewed);
    });
  const requestVerification: NonNullable<
    ProjectionWorkspaceCollaborationRunRepositoryShape["requestVerification"]
  > = (input) =>
    Effect.gen(function* () {
      const current = yield* getRow(input);
      if (Option.isNone(current)) return;
      const run = current.value;
      if (
        run.status !== "running" ||
        run.graph?.status !== "completed" ||
        run.graph.delivery?.status === "verifying" ||
        run.orchestra === null
      )
        return;
      yield* upsert({
        ...run,
        orchestra: { ...run.orchestra, verificationCommands: input.verificationCommands },
        graph: {
          ...run.graph,
          delivery: {
            status: "verifying",
            detail: "검증을 다시 실행합니다.",
            checkedAt: null,
            fingerprint: null,
            worktrees: [],
            commands: [],
          },
        },
        updatedAt: input.requestedAt,
      });
    }).pipe(
      Effect.mapError(decodeError("ProjectionWorkspaceCollaborationRuns.requestVerification")),
    );

  return ProjectionWorkspaceCollaborationRunRepository.of({
    recordControl,
    recordReview,
    requestVerification,
    upsert,
    requestCancel,
    recordAnswer,
    recordInterjection,
    getById,
    list,
    listResumable,
  });
});

export const ProjectionWorkspaceCollaborationRunRepositoryLive = Layer.effect(
  ProjectionWorkspaceCollaborationRunRepository,
  make,
);
