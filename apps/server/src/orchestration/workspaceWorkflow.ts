import {
  extractForwardEdges,
  WorkflowGraphV2,
  WorkspaceMeetingParticipantId,
  type WorkspaceCollaborationRun,
  type WorkspaceTaskGraph,
  type WorkflowControl,
  type WorkflowGraphV2Draft,
  type WorkflowNodeV2,
} from "@t3tools/contracts";
import {
  previewWorkflow,
  validateWorkflowGraphV2Topology,
  withWorkspaceRunControl,
  workspaceRunControl,
} from "@t3tools/shared/workflow";
import * as Schema from "effect/Schema";
import { graphRevisionCap, MAX_NODE_ATTEMPTS } from "./workspaceGraphLimits.ts";
import {
  buildInitialWorkspaceTaskGraph,
  materializeWorkspaceTaskGraphPlan,
  refreshWorkspaceTaskGraphQueue,
  type WorkspaceTaskPlanNodeProposal,
  type WorkspaceTaskPlanProposal,
} from "./workspaceTaskGraph.ts";
import {
  interpolateWorkflowTemplate,
  resolveCapabilitySelection,
  type WorkflowEvaluationContext,
} from "./workflowV2Runtime.ts";

const decodeWorkflowGraphV2 = Schema.decodeUnknownSync(WorkflowGraphV2);

function v2NodeToProposal(
  node: WorkflowNodeV2,
  index: number,
  dependsOn: ReadonlyArray<string>,
  ctx: WorkflowEvaluationContext,
  goal: string,
  description: string,
  chair: WorkspaceMeetingParticipantId | undefined,
  assignments?: ReadonlyMap<string, WorkspaceMeetingParticipantId>,
): WorkspaceTaskPlanNodeProposal {
  const assignedParticipant = (
    participantId?: string | null,
  ): WorkspaceMeetingParticipantId | null =>
    participantId
      ? WorkspaceMeetingParticipantId.make(participantId)
      : (assignments?.get(node.id) ?? chair ?? null);

  switch (node.kind) {
    case "agent": {
      const routing = resolveCapabilitySelection(node.capability, node.routing);
      const task = interpolateWorkflowTemplate(node.promptTemplate, ctx);
      const criteria = node.advisoryCriteria.map((criterion) =>
        interpolateWorkflowTemplate(criterion, ctx),
      );
      const kind =
        node.legacyKind ??
        (routing.legacyAgent === "grok"
          ? "research"
          : routing.legacyAgent === "codex"
            ? "implementation"
            : "orchestration");
      return {
        id: node.id,
        title: node.title,
        kind,
        agent: routing.legacyAgent,
        participantId: assignedParticipant(node.participantId),
        task,
        goal,
        context: description,
        input: `v2 capability=${node.capability}, isolation=${node.isolation}, joinPolicy=${node.joinPolicy}`,
        constraints: [
          "현재 요청의 권한·질문·조건·계획 모드와 참가자를 유지한다.",
          ...(node.cleanContext ? ["깨끗한 핸드오프 컨텍스트 기준으로 작업한다."] : []),
        ],
        expectedOutput:
          node.outputSchema !== undefined
            ? "지정된 JSON 출력 스키마를 준수하는 구조화 결과"
            : "작업 결과와 직접 확인한 근거",
        successCriteria: criteria,
        dependsOn: [...dependsOn],
        priority: index,
      };
    }

    case "verifier":
      return {
        id: node.id,
        title: node.title,
        kind: "debug",
        agent: "codex",
        participantId: assignedParticipant(null),
        task: `[v2 Deterministic Verifier: ${node.verifier.type}] ${node.title}`,
        goal,
        context: description,
        input: JSON.stringify(node.verifier),
        constraints: ["LLM 호출 없이 결정론적 기계 검증 규칙으로 실행한다."],
        expectedOutput: "결정론적 검증 통과 여부(JSON) 및 실패 증거",
        successCriteria: [`verifier(${node.verifier.type}) passed == true`],
        dependsOn: [...dependsOn],
        priority: index,
      };

    case "router": {
      const routing = node.classifierCapability
        ? resolveCapabilitySelection(node.classifierCapability)
        : null;
      return {
        id: node.id,
        title: node.title,
        kind: "orchestration",
        agent: routing?.legacyAgent ?? "fable",
        participantId: assignedParticipant(null),
        task:
          node.mode === "llm_classifier" && node.classifierPrompt
            ? interpolateWorkflowTemplate(node.classifierPrompt, ctx)
            : `[v2 Router: ${node.mode}] 경로 선택 (${node.routes.map((r) => r.routeKey).join(", ")})`,
        goal,
        context: description,
        input: JSON.stringify({
          mode: node.mode,
          routes: node.routes,
          defaultRouteKey: node.defaultRouteKey,
        }),
        constraints: ["선언된 routeKey 중 정확히 하나를 선택한다."],
        expectedOutput: "선택된 routeKey와 활성화 대상 노드 목록",
        successCriteria: ["유효한 routeKey를 반환한다."],
        dependsOn: [...dependsOn],
        priority: index,
      };
    }

    case "human_gate":
      return {
        id: node.id,
        title: node.title,
        kind: "orchestration",
        agent: "fable",
        participantId: assignedParticipant(null),
        task: `[v2 Human Gate] ${interpolateWorkflowTemplate(node.instructions, ctx)}`,
        goal,
        context: description,
        input: JSON.stringify({
          reviewTargets: node.reviewTargets,
          allowedActions: node.allowedActions,
          revisionTargetNodeId: node.revisionTargetNodeId ?? null,
        }),
        constraints: ["사용자의 명시적 승인·수정·재작업·중단 결정을 대기한다."],
        expectedOutput: "사용자 승인 결정 및 수정 페이로드",
        successCriteria: ["허용된 HumanResolutionAction 중 하나로 결정된다."],
        dependsOn: [...dependsOn],
        priority: index,
      };

    case "map_fanout": {
      const capability =
        node.workerTemplate.targetKind === "inline_agent"
          ? node.workerTemplate.capability
          : "code-surgeon";
      const routing = resolveCapabilitySelection(capability);
      return {
        id: node.id,
        title: node.title,
        kind: "implementation",
        agent: routing.legacyAgent,
        participantId: assignedParticipant(null),
        task: `[v2 MapFanOut] ${node.itemsExpression} 원소별 병렬 처리 (max=${node.maxFanOut}, concurrency=${node.concurrencyLimit})`,
        goal,
        context: description,
        input: JSON.stringify({
          itemsExpression: node.itemsExpression,
          itemVariableName: node.itemVariableName,
          isolationPerItem: node.isolationPerItem,
          failurePolicy: node.failurePolicy,
        }),
        constraints: [`최대 팬아웃 ${node.maxFanOut}, 동시성 ${node.concurrencyLimit} 상한 준수.`],
        expectedOutput: "모든 팬아웃 항목 결과 집계 JSON",
        successCriteria: ["항목별 결과가 실패 정책에 맞게 집계된다."],
        dependsOn: [...dependsOn],
        priority: index,
      };
    }

    case "reconcile_worktrees":
      return {
        id: node.id,
        title: node.title,
        kind: "implementation",
        agent: "codex",
        participantId: assignedParticipant(null),
        task: `[v2 Reconcile Worktrees: ${node.strategy}] 병렬 워크트리 변경 병합`,
        goal,
        context: description,
        input: JSON.stringify({
          sourceNodeIds: node.sourceNodeIds,
          strategy: node.strategy,
          postMergeVerifyCommand: node.postMergeVerifyCommand ?? null,
        }),
        constraints: ["병합 충돌 발생 시 지정된 전략과 후속 검증을 준수한다."],
        expectedOutput: "병합 결과 트리 OID 및 검증 결과",
        successCriteria: ["워크트리 병합이 충돌 없이 완료된다."],
        dependsOn: [...dependsOn],
        priority: index,
      };

    case "subworkflow":
      return {
        id: node.id,
        title: node.title,
        kind: "orchestration",
        agent: "fable",
        participantId: assignedParticipant(null),
        task: `[v2 Subworkflow] ${node.targetDefinitionId}@v${node.pinnedRevision}`,
        goal,
        context: description,
        input: JSON.stringify({
          targetDefinitionId: node.targetDefinitionId,
          pinnedRevision: node.pinnedRevision,
          isolation: node.isolation,
          inputBindings: node.inputBindings,
        }),
        constraints: ["고정된 리비전 버전의 하위 워크플로만 실행한다."],
        expectedOutput: "하위 워크플로 최종 산출물",
        successCriteria: ["하위 워크플로 실행이 성공적으로 종료된다."],
        dependsOn: [...dependsOn],
        priority: index,
      };
  }
}

/**
 * 검증된 `WorkflowGraphV2`를 T3 실행 그래프(`WorkspaceTaskGraph`)로 컴파일한다.
 * Forward-DAG 엣지만 선행 의존성(`dependsOn`)으로 연결하고 `loop_back` 엣지는
 * 순환 루프 스펙(`loops`)으로 보존한다.
 */
export function compileWorkflowGraphV2(
  rawGraph: WorkflowGraphV2Draft,
  run: WorkspaceCollaborationRun,
  assignments?: ReadonlyMap<string, WorkspaceMeetingParticipantId>,
): WorkspaceTaskGraph {
  const workflow = run.workflow;
  if (!workflow) throw new Error("워크플로 정의가 없습니다.");

  const graphV2 = decodeWorkflowGraphV2(rawGraph);
  const topology = validateWorkflowGraphV2Topology(graphV2);
  if (!topology.valid) {
    throw new Error(topology.issues.map((issue) => issue.message).join("\n"));
  }

  const meeting = run.meeting;
  const chair = meeting?.chairParticipantId ?? meeting?.participants[0]?.id;
  if (meeting && workflow.roleModels)
    throw new Error("통합 작업에서 참가자 목록과 별도의 역할 모델을 함께 사용할 수 없습니다.");
  if (meeting && !chair) throw new Error("통합 작업의 감독 AI가 지정되지 않았습니다.");

  const forwardEdges = extractForwardEdges(graphV2);
  const dependsByNode = new Map<string, string[]>();
  for (const node of graphV2.nodes) {
    dependsByNode.set(node.id, []);
  }
  for (const edge of forwardEdges) {
    const list = dependsByNode.get(edge.to);
    if (list && !list.includes(edge.from)) {
      list.push(edge.from);
    }
  }

  const resolvedInputs: Record<string, unknown> = {};
  for (const param of graphV2.inputs) {
    if (param.key in workflow.values) {
      resolvedInputs[param.key] = workflow.values[param.key];
    } else if (param.defaultValue !== undefined) {
      resolvedInputs[param.key] = param.defaultValue;
    }
  }
  for (const [key, value] of Object.entries(workflow.values)) {
    if (!(key in resolvedInputs)) {
      resolvedInputs[key] = value;
    }
  }

  const evalCtx: WorkflowEvaluationContext = {
    inputs: resolvedInputs,
    nodes: {},
  };

  const seed = buildInitialWorkspaceTaskGraph(run.task);
  const baseGraph: WorkspaceTaskGraph = {
    ...seed,
    nodes: seed.nodes.map((node) => ({
      ...node,
      ...(chair ? { participantId: chair } : {}),
      status: "completed",
      output: "저장된 워크플로 v2 그래프의 실행 구조를 확인했습니다.",
      completedAt: run.createdAt,
    })),
  };

  const description = graphV2.description ?? workflow.definition.description;
  const proposal: WorkspaceTaskPlanProposal = {
    summary: `${graphV2.title ?? workflow.title} v${workflow.definitionRevision} (graph v2)`,
    nextAction: "저장된 워크플로 v2 단계를 실행합니다.",
    nodes: graphV2.nodes.map((node, index) =>
      v2NodeToProposal(
        node,
        index,
        dependsByNode.get(node.id) ?? [],
        evalCtx,
        run.task,
        description,
        chair,
        assignments,
      ),
    ),
  };

  return materializeWorkspaceTaskGraphPlan({
    graph: baseGraph,
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

export function compileWorkflowRun(
  run: WorkspaceCollaborationRun,
  assignments?: ReadonlyMap<string, WorkspaceMeetingParticipantId>,
): WorkspaceTaskGraph {
  const workflow = run.workflow;
  if (!workflow) throw new Error("워크플로 정의가 없습니다.");
  if (workflow.definition.graphV2 !== undefined) {
    return compileWorkflowGraphV2(workflow.definition.graphV2, run, assignments);
  }
  const preview = previewWorkflow(workflow.definition, workflow.values);
  if (!preview.valid) throw new Error(preview.issues.map((issue) => issue.message).join("\n"));
  const meeting = run.meeting;
  const chair = meeting?.chairParticipantId ?? meeting?.participants[0]?.id;
  if (meeting && workflow.roleModels)
    throw new Error("통합 작업에서 참가자 목록과 별도의 역할 모델을 함께 사용할 수 없습니다.");
  if (meeting && !chair) throw new Error("통합 작업의 감독 AI가 지정되지 않았습니다.");
  if (meeting && assignments !== undefined) {
    const unassigned = workflow.definition.nodes.filter((node) => node.participantId === null);
    const expected = new Set(unassigned.map((node) => node.id));
    if (
      assignments.size !== expected.size ||
      [...assignments.keys()].some((nodeId) => !expected.has(nodeId))
    )
      throw new Error("감독 AI의 작업자 배정이 미지정 단계와 일치하지 않습니다.");
  }
  const seed = buildInitialWorkspaceTaskGraph(run.task);
  const graph: WorkspaceTaskGraph = {
    ...seed,
    nodes: seed.nodes.map((node) => ({
      ...node,
      ...(chair ? { participantId: chair } : {}),
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
        : (assignments?.get(node.id) ?? chair ?? null),
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
