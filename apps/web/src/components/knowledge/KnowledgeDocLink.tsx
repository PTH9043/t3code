import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import type { EnvironmentId, ProjectId, WorkspaceKnowledgeItemId } from "@t3tools/contracts";

export const knowledgeDocRoute = "/control-center/$environmentId/$projectId/knowledge/docs/$itemId";
export const knowledgeDashboardRoute = "/control-center/$environmentId/$projectId/knowledge/manage";

export function KnowledgeDocLink({
  environmentId,
  projectId,
  itemId,
  view,
  children,
  className,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  itemId: WorkspaceKnowledgeItemId;
  view?: "edit" | "history";
  children: ReactNode;
  className?: string;
}) {
  return (
    <Link
      to={knowledgeDocRoute}
      params={{ environmentId, projectId, itemId }}
      search={view ? { view } : {}}
      className={className ?? "text-primary underline underline-offset-2"}
    >
      {children}
    </Link>
  );
}
