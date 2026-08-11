import type { WorkspaceTaskNode } from "@t3tools/contracts";

export interface WorkspaceTaskGraphColumn {
  readonly depth: number;
  readonly nodes: ReadonlyArray<WorkspaceTaskNode>;
  readonly unresolved: boolean;
}

export interface WorkspaceTaskGraphMissingDependency {
  readonly nodeId: string;
  readonly dependencyId: string;
}

export interface WorkspaceTaskGraphLayout {
  readonly columns: ReadonlyArray<WorkspaceTaskGraphColumn>;
  readonly nodeById: ReadonlyMap<string, WorkspaceTaskNode>;
  readonly depthByNodeId: ReadonlyMap<string, number>;
  readonly duplicateNodeIds: ReadonlyArray<string>;
  readonly missingDependencies: ReadonlyArray<WorkspaceTaskGraphMissingDependency>;
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

/**
 * Builds stable topological depth columns without trusting graph validity.
 *
 * Missing dependencies are surfaced but do not hide their dependent node.
 * Nodes involved in a cycle, plus nodes downstream from that cycle, are kept
 * visible in one final unresolved column instead of being dropped or recursed
 * indefinitely.
 */
export function layoutWorkspaceTaskGraph(
  sourceNodes: ReadonlyArray<WorkspaceTaskNode>,
): WorkspaceTaskGraphLayout {
  const orderedSource = sourceNodes.slice().sort(compareNodes);
  const nodeById = new Map<string, WorkspaceTaskNode>();
  const duplicateNodeIds: string[] = [];

  for (const node of orderedSource) {
    const nodeId = String(node.id);
    if (nodeById.has(nodeId)) {
      if (!duplicateNodeIds.includes(nodeId)) duplicateNodeIds.push(nodeId);
      continue;
    }
    nodeById.set(nodeId, node);
  }

  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  const missingDependencies: WorkspaceTaskGraphMissingDependency[] = [];

  for (const node of nodeById.values()) {
    const nodeId = String(node.id);
    const knownDependencies = new Set<string>();
    const seenDependencies = new Set<string>();

    for (const dependency of node.dependsOn) {
      const dependencyId = String(dependency);
      if (seenDependencies.has(dependencyId)) continue;
      seenDependencies.add(dependencyId);

      if (!nodeById.has(dependencyId)) {
        missingDependencies.push({ nodeId, dependencyId });
        continue;
      }
      knownDependencies.add(dependencyId);
    }

    indegree.set(nodeId, knownDependencies.size);
    for (const dependencyId of knownDependencies) {
      const next = dependents.get(dependencyId) ?? [];
      next.push(nodeId);
      dependents.set(dependencyId, next);
    }
  }

  const nodeComparator = (leftId: string, rightId: string) =>
    compareNodes(nodeById.get(leftId)!, nodeById.get(rightId)!);
  const ready = [...nodeById.keys()]
    .filter((nodeId) => indegree.get(nodeId) === 0)
    .sort(nodeComparator);
  const depthByNodeId = new Map<string, number>();
  const processed = new Set<string>();

  for (const nodeId of ready) depthByNodeId.set(nodeId, 0);

  while (ready.length > 0) {
    const nodeId = ready.shift()!;
    if (processed.has(nodeId)) continue;
    processed.add(nodeId);
    const nodeDepth = depthByNodeId.get(nodeId) ?? 0;

    for (const dependentId of dependents.get(nodeId) ?? []) {
      depthByNodeId.set(dependentId, Math.max(depthByNodeId.get(dependentId) ?? 0, nodeDepth + 1));
      const remaining = (indegree.get(dependentId) ?? 0) - 1;
      indegree.set(dependentId, remaining);
      if (remaining === 0) {
        ready.push(dependentId);
        ready.sort(nodeComparator);
      }
    }
  }

  const resolvedColumns = new Map<number, WorkspaceTaskNode[]>();
  for (const nodeId of processed) {
    const node = nodeById.get(nodeId);
    if (!node) continue;
    const depth = depthByNodeId.get(nodeId) ?? 0;
    const column = resolvedColumns.get(depth) ?? [];
    column.push(node);
    resolvedColumns.set(depth, column);
  }

  const columns: WorkspaceTaskGraphColumn[] = [...resolvedColumns.entries()]
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
    const lastResolvedDepth = columns.at(-1)?.depth ?? -1;
    columns.push({
      depth: lastResolvedDepth + 1,
      nodes: unresolvedNodes,
      unresolved: true,
    });
  }

  return {
    columns,
    nodeById,
    depthByNodeId,
    duplicateNodeIds,
    missingDependencies,
    unresolvedNodeIds,
    hasStructuralIssues:
      duplicateNodeIds.length > 0 || missingDependencies.length > 0 || unresolvedNodeIds.length > 0,
  };
}
