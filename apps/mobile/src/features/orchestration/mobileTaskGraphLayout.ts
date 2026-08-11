import type { WorkspaceTaskNode } from "@t3tools/contracts";

export interface MobileTaskGraphLevel {
  readonly depth: number;
  readonly nodes: ReadonlyArray<WorkspaceTaskNode>;
  readonly unresolved: boolean;
}

export interface MobileTaskGraphLayout {
  readonly levels: ReadonlyArray<MobileTaskGraphLevel>;
  readonly nodeById: ReadonlyMap<string, WorkspaceTaskNode>;
  readonly duplicateNodeIds: ReadonlyArray<string>;
  readonly missingDependencies: ReadonlyArray<{
    readonly nodeId: string;
    readonly dependencyId: string;
  }>;
  readonly unresolvedNodeIds: ReadonlyArray<string>;
  readonly hasStructuralIssues: boolean;
}

function compareNodes(left: WorkspaceTaskNode, right: WorkspaceTaskNode): number {
  return (
    left.order - right.order ||
    right.priority - left.priority ||
    left.title.localeCompare(right.title) ||
    String(left.id).localeCompare(String(right.id))
  );
}

/** Stable vertical levels for a narrow screen, tolerant of malformed graph data. */
export function layoutMobileTaskGraph(
  sourceNodes: ReadonlyArray<WorkspaceTaskNode>,
): MobileTaskGraphLayout {
  const nodeById = new Map<string, WorkspaceTaskNode>();
  const duplicateNodeIds: string[] = [];
  for (const node of sourceNodes.slice().sort(compareNodes)) {
    const nodeId = String(node.id);
    if (nodeById.has(nodeId)) {
      if (!duplicateNodeIds.includes(nodeId)) duplicateNodeIds.push(nodeId);
      continue;
    }
    nodeById.set(nodeId, node);
  }

  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  const missingDependencies: Array<{ nodeId: string; dependencyId: string }> = [];
  for (const node of nodeById.values()) {
    const nodeId = String(node.id);
    const dependencies = new Set(node.dependsOn.map((dependencyId) => String(dependencyId)));
    let knownCount = 0;
    for (const dependencyId of dependencies) {
      if (!nodeById.has(dependencyId)) {
        missingDependencies.push({ nodeId, dependencyId });
        continue;
      }
      knownCount += 1;
      const next = dependents.get(dependencyId) ?? [];
      next.push(nodeId);
      dependents.set(dependencyId, next);
    }
    indegree.set(nodeId, knownCount);
  }

  const compareIds = (left: string, right: string) =>
    compareNodes(nodeById.get(left)!, nodeById.get(right)!);
  const ready = [...nodeById.keys()]
    .filter((nodeId) => indegree.get(nodeId) === 0)
    .sort(compareIds);
  const depthById = new Map<string, number>();
  const processed = new Set<string>();
  for (const nodeId of ready) depthById.set(nodeId, 0);

  while (ready.length > 0) {
    const nodeId = ready.shift()!;
    if (processed.has(nodeId)) continue;
    processed.add(nodeId);
    const depth = depthById.get(nodeId) ?? 0;
    for (const dependentId of dependents.get(nodeId) ?? []) {
      depthById.set(dependentId, Math.max(depthById.get(dependentId) ?? 0, depth + 1));
      const remaining = (indegree.get(dependentId) ?? 0) - 1;
      indegree.set(dependentId, remaining);
      if (remaining === 0) {
        ready.push(dependentId);
        ready.sort(compareIds);
      }
    }
  }

  const grouped = new Map<number, WorkspaceTaskNode[]>();
  for (const nodeId of processed) {
    const node = nodeById.get(nodeId);
    if (!node) continue;
    const depth = depthById.get(nodeId) ?? 0;
    const nodes = grouped.get(depth) ?? [];
    nodes.push(node);
    grouped.set(depth, nodes);
  }
  const levels: MobileTaskGraphLevel[] = [...grouped.entries()]
    .sort(([left], [right]) => left - right)
    .map(([depth, nodes]) => ({
      depth,
      nodes: nodes.slice().sort(compareNodes),
      unresolved: false,
    }));
  const unresolvedNodes = [...nodeById.values()]
    .filter((node) => !processed.has(String(node.id)))
    .sort(compareNodes);
  const unresolvedNodeIds = unresolvedNodes.map((node) => String(node.id));
  if (unresolvedNodes.length > 0) {
    levels.push({
      depth: (levels.at(-1)?.depth ?? -1) + 1,
      nodes: unresolvedNodes,
      unresolved: true,
    });
  }

  return {
    levels,
    nodeById,
    duplicateNodeIds,
    missingDependencies,
    unresolvedNodeIds,
    hasStructuralIssues:
      duplicateNodeIds.length > 0 || missingDependencies.length > 0 || unresolvedNodeIds.length > 0,
  };
}
