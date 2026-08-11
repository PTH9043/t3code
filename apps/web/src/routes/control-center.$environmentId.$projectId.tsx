import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { FolderXIcon } from "lucide-react";

import { WorkspaceControlCenter } from "~/components/control-center/WorkspaceControlCenter";
import { Button } from "~/components/ui/button";
import { useProjects } from "~/state/entities";

function WorkspaceControlCenterRoute() {
  const navigate = useNavigate();
  const params = Route.useParams();
  const projects = useProjects();
  const project =
    projects.find(
      (candidate) =>
        candidate.environmentId === params.environmentId && candidate.id === params.projectId,
    ) ?? null;

  if (project === null) {
    return (
      <main className="flex min-h-0 flex-1 items-center justify-center p-6">
        <div className="max-w-md text-center">
          <FolderXIcon className="mx-auto size-10 text-muted-foreground" />
          <h1 className="mt-4 text-lg font-semibold">프로젝트를 찾을 수 없습니다.</h1>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            해당 폴더가 삭제되었거나 현재 환경의 동기화가 아직 끝나지 않았습니다.
          </p>
          <Button className="mt-5" onClick={() => void navigate({ to: "/control-center" })}>
            전체 현황으로 이동
          </Button>
        </div>
      </main>
    );
  }

  return (
    <WorkspaceControlCenter key={`${project.environmentId}:${project.id}`} project={project} />
  );
}

export const Route = createFileRoute("/control-center/$environmentId/$projectId")({
  component: WorkspaceControlCenterRoute,
});
