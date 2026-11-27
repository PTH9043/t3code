import { createFileRoute } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { WorkspaceKnowledgeItemId } from "@t3tools/contracts";
import { KnowledgeDocumentPage } from "~/components/knowledge/KnowledgeDocumentPage";
import { useProjects } from "~/state/entities";

const validId = Schema.is(WorkspaceKnowledgeItemId);

export const Route = createFileRoute(
  "/control-center/$environmentId/$projectId_/knowledge/docs/$itemId",
)({
  validateSearch: (search): { view?: "edit" | "history" } =>
    search.view === "edit" || search.view === "history" ? { view: search.view } : {},
  component: KnowledgeDocumentRoute,
});

function KnowledgeDocumentRoute() {
  const { environmentId, projectId, itemId } = Route.useParams();
  const { view } = Route.useSearch();
  const project = useProjects().find(
    (entry) => entry.environmentId === environmentId && entry.id === projectId,
  );
  if (!project)
    return (
      <main className="p-6" role="status">
        프로젝트를 불러올 수 없습니다.
      </main>
    );
  if (!validId(itemId))
    return (
      <main className="p-6" role="status">
        올바르지 않은 문서 주소입니다.
      </main>
    );
  return (
    <KnowledgeDocumentPage
      key={JSON.stringify([environmentId, projectId, itemId])}
      project={project}
      itemId={itemId}
      view={view ?? "read"}
    />
  );
}
