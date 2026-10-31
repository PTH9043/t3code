import type { ProjectId, WorkspaceKnowledgeScope } from "@t3tools/contracts";

/** Match complete path segments so a folder never grants access to its sibling. */
export function knowledgeAppliesToContext(
  item: {
    readonly projectId: ProjectId;
    readonly scope?: WorkspaceKnowledgeScope;
    readonly appliesToFolder?: string | null;
  },
  context: {
    readonly projectId: ProjectId;
    readonly includeShared?: boolean;
    readonly contextPaths?: readonly string[];
  },
): boolean {
  const scope = item.scope ?? "project";
  if (scope === "environment") {
    return context.includeShared === true || item.projectId === context.projectId;
  }
  if (item.projectId !== context.projectId) return false;
  if (scope === "project") return (context.contextPaths?.length ?? 0) === 0;
  if (scope !== "folder") return true;
  const folder = item.appliesToFolder?.replaceAll("\\", "/");
  if (!folder) return false;
  return (context.contextPaths ?? []).some((value) => {
    const path = value.replaceAll("\\", "/");
    return path === folder || path.startsWith(`${folder}/`);
  });
}
