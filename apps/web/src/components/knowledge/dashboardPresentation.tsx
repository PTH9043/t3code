import type { EnvironmentId, ProjectId, WorkspaceKnowledgeStatus } from "@t3tools/contracts";

export { KNOWLEDGE_KIND_LABELS as kindLabels } from "./knowledgeKinds";

export const statusLabels = {
  candidate: "후보",
  active: "활성",
  superseded: "대체됨",
  archived: "보관",
} satisfies Record<WorkspaceKnowledgeStatus, string>;

export const number = new Intl.NumberFormat("ko-KR");
export type DashboardScope = { environmentId: EnvironmentId; projectId: ProjectId };
