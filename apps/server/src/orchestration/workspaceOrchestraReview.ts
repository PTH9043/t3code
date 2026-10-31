import type {
  OrchestrationEvent,
  WorkspaceCollaborationRun,
  WorkspaceTaskGraph,
  WorkspaceTaskNodeId,
} from "@t3tools/contracts";
import { refreshWorkspaceTaskGraphQueue, WorkspaceTaskGraphError } from "./workspaceTaskGraph.ts";

type Review = Extract<
  OrchestrationEvent,
  { type: "project.collaboration-run-reviewed" }
>["payload"];
export function reviewWorkspaceOrchestraPlan(
  run: WorkspaceCollaborationRun,
  input: Review,
): WorkspaceTaskGraph | null {
  const graph = run.graph;
  if (
    run.status !== "running" ||
    graph?.planReview?.status !== "pending" ||
    graph.planReview.revision !== input.expectedRevision
  )
    return null;
  const editable = graph.nodes.filter(
    (node) =>
      node.id !== "plan" &&
      ["orchestration", "research", "implementation", "debug"].includes(node.kind),
  );
  if (
    editable.some((node) => node.attempts.length > 0) ||
    graph.nodes.some((node) => node.status === "running")
  )
    return null;
  const edits = new Map(input.edits.map((edit) => [edit.nodeId, edit]));
  const reject = (message: string): never => {
    throw new WorkspaceTaskGraphError(message);
  };
  if (edits.size !== input.edits.length) reject("같은 작업을 두 번 수정할 수 없습니다.");
  for (const edit of input.edits) {
    if (!editable.some((node) => node.id === edit.nodeId))
      reject("실행 전 작업만 수정할 수 있습니다.");
    if (run.meeting === null && edit.participantId !== null)
      reject("역할 기반 작업에는 참가자를 임의로 추가할 수 없습니다.");
    if (
      run.meeting !== null &&
      !run.meeting.participants.some((seat) => seat.id === edit.participantId)
    )
      reject("선택한 참가자에게만 작업을 배정할 수 있습니다.");
    if (new Set(edit.dependsOn).size !== edit.dependsOn.length)
      reject("선행 작업이 중복되었습니다.");
    for (const id of edit.dependsOn)
      if (!editable.some((node) => node.id === id)) reject("선행 작업을 찾을 수 없습니다.");
  }
  const gate = new Map(
    graph.nodes.flatMap((node) =>
      node.validationTargetId === null ? [] : [[node.validationTargetId, node.id] as const],
    ),
  );
  const anchor = graph.nodes.find((node) => node.id === "plan");
  if (!anchor) return reject("원래 실행 계획을 찾을 수 없습니다.");
  const nodes = graph.nodes.map((node) => {
    const edit = edits.get(node.id);
    if (!edit) return node;
    return {
      ...node,
      title: edit.title,
      participantId: edit.participantId,
      handoff: { ...node.handoff, task: edit.task },
      dependsOn:
        edit.dependsOn.length === 0 ? [anchor.id] : edit.dependsOn.map((id) => gate.get(id) ?? id),
    };
  });
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index]!;
    if (node.kind === "synthesis")
      nodes[index] = {
        ...node,
        dependsOn: editable.map((producer) => gate.get(producer.id) ?? producer.id),
      };
  }
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const visiting = new Set<WorkspaceTaskNodeId>();
  const done = new Set<WorkspaceTaskNodeId>();
  const visit = (id: WorkspaceTaskNodeId): void => {
    if (done.has(id)) return;
    if (visiting.has(id)) reject("선행 작업이 서로를 기다리는 순환 관계입니다.");
    const node = byId.get(id);
    if (!node) return reject("선행 작업을 찾을 수 없습니다.");
    visiting.add(id);
    node.dependsOn.forEach(visit);
    visiting.delete(id);
    done.add(id);
  };
  nodes.forEach((node) => visit(node.id));
  return refreshWorkspaceTaskGraphQueue({
    ...graph,
    nodes,
    planReview: {
      revision: graph.planReview.revision + 1,
      status: input.approve ? "approved" : "pending",
      updatedAt: input.reviewedAt,
    },
  });
}
