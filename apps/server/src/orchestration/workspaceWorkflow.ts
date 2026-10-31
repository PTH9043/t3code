import {
  WorkspaceMeetingParticipantId,
  type WorkspaceCollaborationRun,
  type WorkspaceTaskGraph,
  type WorkflowControl,
} from "@t3tools/contracts";
import {
  previewWorkflow,
  withWorkspaceRunControl,
  workspaceRunControl,
} from "@t3tools/shared/workflow";
import { graphRevisionCap, MAX_NODE_ATTEMPTS } from "./workspaceGraphLimits.ts";
import {
  buildInitialWorkspaceTaskGraph,
  materializeWorkspaceTaskGraphPlan,
  refreshWorkspaceTaskGraphQueue,
  type WorkspaceTaskPlanProposal,
} from "./workspaceTaskGraph.ts";

export function compileWorkflowRun(run: WorkspaceCollaborationRun): WorkspaceTaskGraph {
  const workflow = run.workflow;
  if (!workflow) throw new Error("워크플로 정의가 없습니다.");
  const preview = previewWorkflow(workflow.definition, workflow.values);
  if (!preview.valid) throw new Error(preview.issues.map((issue) => issue.message).join("\n"));
  const seed = buildInitialWorkspaceTaskGraph(run.task);
  const graph: WorkspaceTaskGraph = {
    ...seed,
    nodes: seed.nodes.map((node) => ({
      ...node,
      status: "completed",
      output: "저장된 워크플로 버전의 실행 구조를 확인했습니다.",
      completedAt: run.createdAt,
    })),
  };
  const proposal: WorkspaceTaskPlanProposal = {
    summary: `${workflow.title} v${workflow.definitionRevision}`,
    nextAction: "저장된 워크플로 단계를 실행합니다.",
    nodes: workflow.definition.nodes.map((node, index) => ({
      id: node.id,
      title: node.title,
      kind: node.kind,
      agent: node.agent,
      participantId: node.participantId
        ? WorkspaceMeetingParticipantId.make(node.participantId)
        : null,
      task: preview.nodes[index]!.task,
      goal: run.task,
      context: workflow.definition.description,
      input: "이 단계의 입력은 저장된 작업 내용·완료 기준·스킬 인자에 적용되어 있다.",
      constraints: ["현재 요청의 권한·질문·조건·계획 모드와 참가자를 유지한다."],
      expectedOutput: "작업 결과와 직접 확인한 근거",
      successCriteria: preview.nodes[index]!.successCriteria,
      dependsOn: node.dependsOn,
      priority: index,
    })),
  };
  const meeting = run.meeting;
  const chair = meeting?.chairParticipantId ?? meeting?.participants[0]?.id;
  return materializeWorkspaceTaskGraphPlan({
    graph,
    proposal,
    bindings: workflow.roleBindings,
    ...(meeting && chair && !workflow.roleModels
      ? {
          meeting: {
            participantIds: meeting.participants.map((p) => p.id),
            chairParticipantId: chair,
          },
        }
      : {}),
    occurredAt: run.createdAt,
  });
}

export function controlWorkflowRun(
  run: WorkspaceCollaborationRun,
  request: WorkflowControl,
  now: string,
): WorkspaceCollaborationRun {
  const control = workspaceRunControl(run);
  if (control.controlRevision !== request.expectedRevision)
    throw new Error("실행 상태가 바뀌었습니다. 최신 상태를 확인하세요.");
  if (["completed", "cancelled", "cancel-requested"].includes(run.status))
    throw new Error("완료·취소된 실행을 변경할 수 없습니다. 새 실행을 시작하세요.");
  const context = { ...control, controlRevision: control.controlRevision + 1, updatedAt: now };
  if (request.action === "cancel") {
    if (run.status === "failed") throw new Error("실패로 종료된 실행입니다.");
    return withWorkspaceRunControl({ ...run, status: "cancel-requested", updatedAt: now }, context);
  }
  if (request.action === "pause") {
    if (run.status === "failed" || control.control !== "active")
      throw new Error("현재 상태에서는 일시정지할 수 없습니다.");
    return withWorkspaceRunControl(
      { ...run, updatedAt: now },
      { ...context, control: "pause-requested" },
    );
  }
  if (request.action === "resume") {
    if (run.status === "failed" || control.control === "active")
      throw new Error("일시정지된 실행만 재개할 수 있습니다.");
    return withWorkspaceRunControl({ ...run, updatedAt: now }, { ...context, control: "active" });
  }
  const graph = run.graph;
  const node = graph?.nodes.find((entry) => entry.id === request.nodeId);
  if (run.status !== "failed" || !graph || !node || node.status !== "failed")
    throw new Error("실패한 실행의 실패 단계만 재시도할 수 있습니다.");
  if (
    graph.nodes.some(
      (entry) => entry.status === "running" || entry.attempts.at(-1)?.status === "running",
    )
  )
    throw new Error("이전 단계가 아직 종료되지 않았습니다.");
  if (node.attempts.length >= MAX_NODE_ATTEMPTS)
    throw new Error("단계의 최대 시도 횟수에 도달했습니다.");
  if (graph.revision >= graphRevisionCap(run.meeting))
    throw new Error("현재 실행의 협업 수정 한도에 도달했습니다.");
  const reopened = refreshWorkspaceTaskGraphQueue({
    ...graph,
    status: "executing",
    revision: graph.revision + 1,
    nodes: graph.nodes.map((entry) =>
      entry.id === node.id
        ? {
            ...entry,
            status: "queued",
            maxAttempts: Math.max(entry.maxAttempts, entry.attempts.length + 1),
            error: null,
            completedAt: null,
          }
        : entry.attempts.length === 0 && ["failed", "cancelled"].includes(entry.status)
          ? { ...entry, status: "blocked", error: null, completedAt: null }
          : entry,
    ),
    changes: [
      ...graph.changes,
      {
        revision: graph.revision + 1,
        reason: "tool-failure",
        summary: `사용자가 실패 단계 ${node.id}의 재시도를 요청했습니다.`,
        addedNodeIds: [],
        supersededNodeIds: [],
        occurredAt: now,
      },
    ],
    nextAction: "확인된 실패 단계를 재시도합니다.",
  });
  return withWorkspaceRunControl(
    { ...run, graph: reopened, status: "running", error: null, updatedAt: now },
    {
      ...context,
      control: "active",
      executionRevision: (control.executionRevision ?? 0) + 1,
    },
  );
}
