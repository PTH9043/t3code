import type {
  WorkspaceMeetingParticipantId,
  WorkspaceCollaborationRun,
  WorkspaceTaskGraph,
} from "@t3tools/contracts";
import { previewWorkflow } from "@t3tools/shared/workflow";
import * as Schema from "effect/Schema";
import {
  NODE_REFUSAL_OPTIONS,
  nodeRefusalQuestion,
  renderMeetingRoster,
  renderMeetingTranscript,
  resolveChairParticipantId,
} from "./workspaceMeeting.ts";
import { compileWorkflowRun } from "./workspaceWorkflow.ts";
import { refreshWorkspaceTaskGraphQueue } from "./workspaceTaskGraph.ts";

const AssignmentOutput = Schema.fromJsonString(
  Schema.Struct({
    assignments: Schema.Array(
      Schema.Struct({ nodeId: Schema.String, participantId: Schema.String }),
    ),
  }),
);
const decodeAssignmentOutput = Schema.decodeUnknownSync(AssignmentOutput);

export function workflowNeedsAssignment(run: WorkspaceCollaborationRun): boolean {
  return (
    !!run.meeting &&
    run.meeting.participants.length > 1 &&
    !!run.workflow?.definition.nodes.some((node) => node.participantId === null)
  );
}

export function buildWorkflowAssignmentPrompt(
  run: WorkspaceCollaborationRun,
  workspacePrompt: string,
  preparedTranscript?: string,
): string {
  if (!run.workflow || !run.meeting) throw new Error("워크플로 또는 참가자 정보가 없습니다.");
  const preview = previewWorkflow(run.workflow.definition, run.workflow.values);
  if (!preview.valid) throw new Error(preview.issues.map((issue) => issue.message).join("\n"));
  const graph = run.graph;
  const pending = graph?.workflowAssignment;
  const pendingIds = new Set<string>(pending?.pendingNodeIds ?? []);
  const gates = new Map(
    graph?.nodes.flatMap((node) =>
      node.validationTargetId === null ? [] : [[String(node.id), node.validationTargetId] as const],
    ) ?? [],
  );
  const nodes = run.workflow.definition.nodes.map((node, index) => {
    const reviewed = pending ? graph?.nodes.find((entry) => entry.id === node.id) : undefined;
    if (pending && !reviewed) throw new Error("검토한 워크플로 단계를 찾을 수 없습니다.");
    return {
      id: node.id,
      title: reviewed?.title ?? node.title,
      task: reviewed?.handoff.task ?? preview.nodes[index]!.task,
      successCriteria: reviewed?.handoff.successCriteria ?? preview.nodes[index]!.successCriteria,
      dependsOn: reviewed
        ? reviewed.dependsOn
            .filter((id) => id !== pending?.gateNodeId)
            .map((id) => gates.get(id) ?? id)
        : node.dependsOn,
      participantId: reviewed
        ? pendingIds.has(node.id)
          ? null
          : reviewed.participantId
        : node.participantId,
    };
  });
  return [
    "# Saved Workflow Assignment",
    "You are the selected supervisor. Assign each unassigned step to a participant from the selected roster, including yourself when suitable.",
    "Respect the user-assigned roles first; assign other necessary work only when it serves the user's goal. Keep explicitly assigned steps unchanged.",
    "The current steps, including any user-reviewed changes, inputs, dependencies, and completion criteria are fixed. Do not add, remove, rewrite, or execute steps in this response.",
    "Describe work accurately; do not alter it to evade provider safety decisions.",
    `## User goal\n${run.task}`,
    `## Relevant context\n${workspacePrompt}`,
    `## Conversation\n${preparedTranscript ?? renderMeetingTranscript(run.meeting)}`,
    `## Selected roster\n${renderMeetingRoster(run.meeting)}`,
    `## Saved steps\n${JSON.stringify(nodes)}`,
    'Return only <t3_workflow_assignments>{"assignments":[{"nodeId":"step id","participantId":"selected roster id"}]}</t3_workflow_assignments> with exactly one entry for each unassigned step.',
    'If a decision truly requires the user, return only <t3_question>{"question":string,"options":string[],"context":string}</t3_question>.',
  ].join("\n\n");
}

export function parseWorkflowAssignments(
  run: WorkspaceCollaborationRun,
  output: string,
): ReadonlyMap<string, WorkspaceMeetingParticipantId> {
  if (!run.workflow || !run.meeting) throw new Error("워크플로 또는 참가자 정보가 없습니다.");
  const match = /<t3_workflow_assignments>\s*([\s\S]*?)\s*<\/t3_workflow_assignments>/u.exec(
    output,
  );
  if (!match) throw new Error("감독 AI의 작업자 배정 결과가 없습니다.");
  const parsed = decodeAssignmentOutput(match[1]);
  const missing = new Set<string>(
    run.graph?.workflowAssignment?.pendingNodeIds ??
      run.workflow.definition.nodes
        .filter((node) => node.participantId === null)
        .map((node) => node.id),
  );
  const participants = new Map(
    run.meeting.participants.map((entry) => [String(entry.id), entry.id]),
  );
  const result = new Map<string, WorkspaceMeetingParticipantId>();
  for (const assignment of parsed.assignments) {
    const participant = participants.get(assignment.participantId);
    if (!missing.has(assignment.nodeId) || !participant || result.has(assignment.nodeId))
      throw new Error("작업자 배정에 알 수 없는 단계, 중복 단계 또는 명단 밖 참가자가 있습니다.");
    result.set(assignment.nodeId, participant);
  }
  if (result.size !== missing.size) throw new Error("배정되지 않은 워크플로 단계가 있습니다.");
  return result;
}

/** Park the refused assignment while explicitly assigned independent steps proceed. */
export function parkRefusedWorkflowAssignment(
  run: WorkspaceCollaborationRun,
  error: string,
  askedAt: string,
) {
  if (!run.workflow || !run.meeting) throw new Error("워크플로 또는 참가자 정보가 없습니다.");
  const graph = compileWorkflowRun(run);
  const gate = graph.nodes.find((node) => node.id === "plan");
  if (!gate) throw new Error("워크플로 배정 단계를 찾을 수 없습니다.");
  const definitions = new Map(run.workflow.definition.nodes.map((node) => [String(node.id), node]));
  const pendingNodeIds = graph.nodes
    .filter((node) => definitions.get(node.id)?.participantId === null)
    .map((node) => node.id);
  const nodes = graph.nodes.map((node) => {
    if (node.id === gate.id)
      return {
        ...node,
        status: "awaiting-user" as const,
        error: error.slice(0, 6_000),
        output: null,
        completedAt: null,
      };
    const definition = definitions.get(node.id);
    if (!definition) return node;
    if (definition.participantId === null)
      return node.dependsOn.includes(gate.id)
        ? { ...node, participantId: null }
        : { ...node, participantId: null, dependsOn: [...node.dependsOn, gate.id] };
    return definition.dependsOn.length === 0
      ? { ...node, dependsOn: node.dependsOn.filter((id) => id !== gate.id) }
      : node;
  });
  const question = nodeRefusalQuestion(gate.title);
  return {
    graph: refreshWorkspaceTaskGraphQueue({
      ...graph,
      nodes,
      status: "executing",
      workflowAssignment: { gateNodeId: gate.id, pendingNodeIds },
      nextAction: question,
    }),
    question: {
      askedByParticipantId: resolveChairParticipantId(run.meeting),
      question,
      options: [...NODE_REFUSAL_OPTIONS],
      context: error.slice(0, 20_000),
      askedAt,
      nodeId: gate.id,
    },
  };
}

/** Skipping assignment cannot unblock steps that depended on missing work. */
export function skipPendingWorkflowAssignments(graph: WorkspaceTaskGraph, completedAt: string) {
  if (!graph.workflowAssignment) return graph;
  const skipped = new Set<string>(graph.workflowAssignment.pendingNodeIds);
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of graph.nodes) {
      if (
        node.kind !== "synthesis" &&
        node.id !== graph.workflowAssignment.gateNodeId &&
        !skipped.has(node.id) &&
        node.dependsOn.some((id) => skipped.has(id))
      ) {
        skipped.add(node.id);
        changed = true;
      }
    }
  }
  const { workflowAssignment: _assignment, ...remaining } = graph;
  return refreshWorkspaceTaskGraphQueue({
    ...remaining,
    workflowSkippedNodeIds: graph.nodes
      .filter(
        (node) =>
          skipped.has(node.id) &&
          ["orchestration", "research", "implementation", "debug"].includes(node.kind),
      )
      .map((node) => node.id),
    nodes: graph.nodes.map((node) =>
      skipped.has(node.id) && !["completed", "running"].includes(node.status)
        ? {
            ...node,
            status: "skipped" as const,
            output:
              "사용자가 미배정 단계의 건너뛰기를 선택해 이 단계와 그 종속 단계를 수행하지 않았습니다.",
            completedAt,
          }
        : node,
    ),
  });
}
