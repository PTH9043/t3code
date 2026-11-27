import type { WorkspaceOrchestraPlanEdit } from "@t3tools/contracts";

/** Returns one dependency cycle, including its repeated starting node, if present. */
export function findOrchestraPlanCycle(
  edits: ReadonlyArray<Pick<WorkspaceOrchestraPlanEdit, "nodeId" | "dependsOn">>,
): readonly string[] | null {
  const dependencies = new Map<string, readonly string[]>(
    edits.map((edit) => [edit.nodeId, edit.dependsOn]),
  );
  const done = new Set<string>();
  const path: string[] = [];
  const visiting = new Set<string>();
  const visit = (id: string): readonly string[] | null => {
    if (visiting.has(id)) return [...path.slice(path.indexOf(id)), id];
    if (done.has(id)) return null;
    visiting.add(id);
    path.push(id);
    for (const dependency of dependencies.get(id) ?? []) {
      const cycle = visit(dependency);
      if (cycle) return cycle;
    }
    path.pop();
    visiting.delete(id);
    done.add(id);
    return null;
  };
  for (const edit of edits) {
    const cycle = visit(edit.nodeId);
    if (cycle) return cycle;
  }
  return null;
}

/** Checking a dependency must not create a path back to the current task. */
export function orchestraPlanDependencyWouldCycle(
  edits: ReadonlyArray<Pick<WorkspaceOrchestraPlanEdit, "nodeId" | "dependsOn">>,
  nodeId: string,
  dependencyId: string,
): boolean {
  const dependencies = new Map<string, readonly string[]>(
    edits.map((edit) => [edit.nodeId, edit.dependsOn]),
  );
  const seen = new Set<string>();
  const pending = [dependencyId];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current === nodeId) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    pending.push(...(dependencies.get(current) ?? []));
  }
  return false;
}
