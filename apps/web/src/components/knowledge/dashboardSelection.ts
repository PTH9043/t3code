import type {
  ClientOrchestrationCommand,
  WorkspaceKnowledgeDashboard,
  WorkspaceKnowledgeDashboardFilters,
} from "@t3tools/contracts";

export type DashboardRow = WorkspaceKnowledgeDashboard["matching"]["items"][number];
export type SearchFilters = WorkspaceKnowledgeDashboardFilters;
export type BulkCommand = Extract<ClientOrchestrationCommand, { type: "project.knowledge.bulk" }>;
export type RowSelection = ReadonlyMap<DashboardRow["id"], DashboardRow>;
export const pageLabels = {
  matching: "문서 검색",
  candidates: "분류 대기",
  mostUsed: "많이 사용한 문서",
  unused: "미사용",
  duplicates: "중복 묶음",
} as const;
export type DashboardPage = keyof typeof pageLabels;

export function toggleRows(
  selected: RowSelection,
  rows: readonly DashboardRow[],
  include: boolean,
) {
  const next = new Map(selected);
  for (const row of rows) {
    if (!include) next.delete(row.id);
    else if (!next.has(row.id)) next.set(row.id, row);
  }
  return next;
}

export function bulkTargets(selection: RowSelection) {
  return Array.from(selection.values(), ({ id, updatedAt, revisionSequence }) => ({
    id,
    updatedAt,
    revisionSequence,
  }));
}
