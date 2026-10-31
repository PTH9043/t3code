import {
  WorkflowVersion,
  WorkflowRunSummary,
  AiTaskRunSummary,
  SkillBinding,
  WorkspaceWorkflowError,
  type OrchestrationEvent,
  type ProjectId,
} from "@t3tools/contracts";
import { summarizeWorkflowRun } from "@t3tools/shared/workflow";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(WorkflowVersion));
const encode = Schema.encodeSync(Schema.fromJsonString(WorkflowVersion));
const encodeRunSummary = Schema.encodeEffect(Schema.fromJsonString(WorkflowRunSummary));
const decodeRunSummary = Schema.decodeUnknownEffect(Schema.fromJsonString(WorkflowRunSummary));
const decodeAiTaskRunSummary = Schema.decodeUnknownEffect(AiTaskRunSummary);
const decodeBinding = Schema.decodeUnknownEffect(Schema.fromJsonString(SkillBinding));
const isWorkflowError = Schema.is(WorkspaceWorkflowError);
type SavedEvent = Extract<OrchestrationEvent, { type: "project.workflow-saved" }>;
type DeliveryEvent = Extract<OrchestrationEvent, { type: "project.workflow-delivery-recorded" }>;
const failure = (cause: unknown) =>
  isWorkflowError(cause)
    ? cause
    : new WorkspaceWorkflowError({ message: "워크플로 기록을 처리하지 못했습니다.", cause });

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const projectRunSummary = Effect.fn("WorkflowStore.projectRunSummary")(function* (
    run: Parameters<typeof summarizeWorkflowRun>[0],
  ) {
    const summary = summarizeWorkflowRun(run);
    if (!summary) return;
    const encoded = yield* encodeRunSummary(summary);
    yield* sql`INSERT INTO projection_workspace_workflow_run_summaries(project_id,run_id,summary_json,updated_at) VALUES(${run.projectId},${run.id},${encoded},${run.updatedAt}) ON CONFLICT(run_id) DO UPDATE SET summary_json=excluded.summary_json,updated_at=excluded.updated_at WHERE projection_workspace_workflow_run_summaries.project_id=excluded.project_id`;
  }, Effect.mapError(failure));
  const listRunSummaries = Effect.fn("WorkflowStore.listRunSummaries")(function* (
    projectId: ProjectId,
  ) {
    const rows = yield* sql<{
      summary_json: string;
    }>`SELECT summary_json FROM projection_workspace_workflow_run_summaries WHERE project_id=${projectId} ORDER BY updated_at DESC,run_id DESC`;
    return yield* Effect.forEach(rows, (row) => decodeRunSummary(row.summary_json));
  }, Effect.mapError(failure));
  const listAiTaskRuns = Effect.fn("WorkflowStore.listAiTaskRuns")(function* (
    projectId: ProjectId,
  ) {
    const rows = yield* sql<{
      id: string;
      projectId: string;
      status: string;
      createdAt: string;
      updatedAt: string;
      error: string | null;
      title: string;
      workflowRevision: number | null;
      control: string;
      controlRevision: number;
      total: number;
      completed: number;
      running: number;
      failed: number;
    }>`SELECT run_id AS id, project_id AS "projectId", status, created_at AS "createdAt", updated_at AS "updatedAt", error,
      substr(COALESCE(json_extract(workflow_json,'$.title'),task),1,200) AS title,
      json_extract(workflow_json,'$.definitionRevision') AS "workflowRevision",
      COALESCE(json_extract(run_control_json,'$.control'),json_extract(workflow_json,'$.control'),'active') AS control,
      COALESCE(json_extract(run_control_json,'$.controlRevision'),json_extract(workflow_json,'$.controlRevision'),0) AS "controlRevision",
      COALESCE(json_array_length(graph_json,'$.nodes'),0) AS total,
      (SELECT COUNT(*) FROM json_each(graph_json,'$.nodes') WHERE json_extract(value,'$.status')='completed') AS completed,
      (SELECT COUNT(*) FROM json_each(graph_json,'$.nodes') WHERE json_extract(value,'$.status')='running') AS running,
      (SELECT COUNT(*) FROM json_each(graph_json,'$.nodes') WHERE json_extract(value,'$.status')='failed') AS failed
      FROM projection_workspace_collaboration_runs WHERE project_id=${projectId} ORDER BY updated_at DESC,run_id DESC`;
    return yield* Effect.forEach(rows, (row) =>
      decodeAiTaskRunSummary({
        ...row,
        counts: {
          total: row.total,
          completed: row.completed,
          running: row.running,
          failed: row.failed,
        },
      }),
    );
  }, Effect.mapError(failure));
  const get = Effect.fn("WorkflowStore.get")(function* (
    projectId: ProjectId,
    id: string,
    revision?: number,
  ) {
    const rows =
      revision === undefined
        ? yield* sql<{
            definition_json: string;
          }>`SELECT definition_json FROM projection_workspace_workflow_versions WHERE project_id=${projectId} AND definition_id=${id} ORDER BY revision DESC LIMIT 1`
        : yield* sql<{
            definition_json: string;
          }>`SELECT definition_json FROM projection_workspace_workflow_versions WHERE project_id=${projectId} AND definition_id=${id} AND revision=${revision}`;
    return rows[0] ? yield* decode(rows[0].definition_json) : null;
  }, Effect.mapError(failure));
  const list = Effect.fn("WorkflowStore.list")(function* (projectId: ProjectId) {
    const rows = yield* sql<{
      definition_json: string;
    }>`SELECT v.definition_json FROM projection_workspace_workflow_versions v WHERE v.project_id=${projectId} AND v.revision=(SELECT MAX(n.revision) FROM projection_workspace_workflow_versions n WHERE n.project_id=v.project_id AND n.definition_id=v.definition_id) ORDER BY v.definition_id`;
    return yield* Effect.forEach(rows, (row) => decode(row.definition_json));
  }, Effect.mapError(failure));
  const retainedBinding = Effect.fn("WorkflowStore.retainedBinding")(function* (
    projectId: ProjectId,
    definitionId: string,
    binding: SkillBinding,
  ) {
    if (!binding.snapshotPath) return null;
    const rows = yield* sql<{
      binding_json: string;
    }>`SELECT s.value AS binding_json FROM projection_workspace_workflow_versions v, json_each(v.definition_json,'$.nodes') n, json_each(n.value,'$.skills') s WHERE v.project_id=${projectId} AND v.definition_id=${definitionId} AND json_extract(s.value,'$.digest')=${binding.digest} AND json_extract(s.value,'$.path')=${binding.path} AND json_extract(s.value,'$.provider')=${binding.provider} AND json_extract(s.value,'$.mode')=${binding.mode} AND json_extract(s.value,'$.snapshotPath')=${binding.snapshotPath} ORDER BY v.revision DESC LIMIT 1`;
    return rows[0] ? yield* decodeBinding(rows[0].binding_json) : null;
  }, Effect.mapError(failure));
  const projectSaved = Effect.fn("WorkflowStore.projectSaved")(function* (event: SavedEvent) {
    const { projectId, definition, expectedRevision } = event.payload;
    const existing = yield* get(projectId, definition.id, definition.revision);
    if (existing) {
      if (encode(existing) === encode(definition)) return;
      return yield* new WorkspaceWorkflowError({
        message: "기존 워크플로 버전을 변경할 수 없습니다.",
      });
    }
    const previous = yield* get(projectId, definition.id);
    if (
      (previous?.revision ?? 0) !== expectedRevision ||
      definition.revision !== expectedRevision + 1
    )
      return yield* new WorkspaceWorkflowError({
        message: "워크플로 버전이 바뀌었습니다. 최신 버전을 불러온 뒤 저장하세요.",
      });
    yield* sql`INSERT INTO projection_workspace_workflow_versions(project_id,definition_id,revision,definition_json) VALUES(${projectId},${definition.id},${definition.revision},${encode(definition)})`;
  }, Effect.mapError(failure));
  const delivery = Effect.fn("WorkflowStore.delivery")(function* (executionId: string) {
    const rows = yield* sql<{
      phase: string;
      stop_confirmed: number;
      intent_sequence: number;
    }>`SELECT phase,stop_confirmed,intent_sequence FROM projection_workspace_workflow_deliveries WHERE execution_id=${executionId}`;
    return rows[0] ?? null;
  }, Effect.mapError(failure));
  const projectDelivery = Effect.fn("WorkflowStore.projectDelivery")(function* (
    event: DeliveryEvent,
  ) {
    const p = event.payload;
    const previous = yield* delivery(p.executionId);
    if (p.phase === "submitting") {
      if (previous?.intent_sequence === event.sequence) return;
      if (previous)
        return yield* new WorkspaceWorkflowError({
          message:
            "이 단계 입력의 전달 기록이 있습니다. 원래 실행을 대조하기 전에는 재전송하지 않습니다.",
        });
      yield* sql`INSERT INTO projection_workspace_workflow_deliveries(execution_id,project_id,run_id,node_id,phase,stop_confirmed,intent_sequence,updated_at) VALUES(${p.executionId},${p.projectId},${p.runId},${p.nodeId},${p.phase},0,${event.sequence},${p.createdAt})`;
    } else if (previous) {
      if (previous.phase === "stopped" && p.phase === "accepted") return;
      yield* sql`UPDATE projection_workspace_workflow_deliveries SET phase=${p.phase},stop_confirmed=MAX(stop_confirmed,${p.confirmed ? 1 : 0}),updated_at=${p.createdAt} WHERE execution_id=${p.executionId}`;
    }
  }, Effect.mapError(failure));
  const retrySafe = Effect.fn("WorkflowStore.retrySafe")(function* (
    runId: string,
    nodeId: string,
    requireEvidence = false,
  ) {
    const rows = yield* sql<{
      phase: string;
      stop_confirmed: number;
    }>`SELECT phase,stop_confirmed FROM projection_workspace_workflow_deliveries WHERE run_id=${runId} AND node_id=${nodeId}`;
    return (
      (!requireEvidence || rows.length > 0) &&
      rows.every((row) => row.phase === "stopped" && row.stop_confirmed === 1)
    );
  }, Effect.mapError(failure));
  return {
    get,
    list,
    retainedBinding,
    projectSaved,
    delivery,
    projectDelivery,
    retrySafe,
    projectRunSummary,
    listRunSummaries,
    listAiTaskRuns,
  };
});
export class WorkspaceWorkflowStore extends Context.Service<
  WorkspaceWorkflowStore,
  Effect.Success<typeof make>
>()("t3/persistence/WorkspaceWorkflowStore") {}
export const layer = Layer.effect(WorkspaceWorkflowStore, make);
