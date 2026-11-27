import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { createFileRoute } from "@tanstack/react-router";
import { KnowledgeDashboard } from "~/components/knowledge/KnowledgeDashboard";
import { useProject } from "~/state/entities";

export const Route = createFileRoute("/control-center/$environmentId/$projectId_/knowledge/manage")(
  {
    component: KnowledgeManagementPage,
  },
);

function KnowledgeManagementPage() {
  const params = Route.useParams();
  const environmentId = EnvironmentId.make(params.environmentId);
  const projectId = ProjectId.make(params.projectId);
  const project = useProject(scopeProjectRef(environmentId, projectId));
  return (
    <KnowledgeDashboard
      key={JSON.stringify([environmentId, projectId])}
      environmentId={environmentId}
      projectId={projectId}
      projectTitle={project?.title ?? projectId}
    />
  );
}
