import { useMemo, useState } from "react";
import { useLocation, useNavigate, useParams } from "@tanstack/react-router";
import { ArrowLeftIcon, BrainCircuitIcon, SettingsIcon } from "lucide-react";
import { scopeProjectRef, scopedProjectKey } from "@t3tools/client-runtime/environment";

import { useEnvironments } from "~/state/environments";
import { readThreadShells, useProjects } from "~/state/entities";
import { useWorkspaceTabStore } from "~/workspaceTabStore";
import { DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import { ProjectFavicon } from "../ProjectFavicon";
import { navigateToTabView } from "../tabs/navigateToTabView";
import { toastManager } from "../ui/toast";
import { resolveControlCenterChatView } from "./controlCenterNavigation";
import {
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "../ui/sidebar";

export function ControlCenterSidebarNav() {
  const navigate = useNavigate();
  const pathname = useLocation({ select: (location) => location.pathname });
  const projects = useProjects();
  const params = useParams({ strict: false });
  const project = projects.find(
    (candidate) =>
      candidate.environmentId === params.environmentId && candidate.id === params.projectId,
  );
  const isProjectCenter = params.projectId !== undefined;
  const handleNewThread = useNewThreadHandler();
  const [isReturning, setIsReturning] = useState(false);
  const { environments } = useEnvironments();
  const { isMobile, setOpenMobile } = useSidebar();
  const environmentLabels = useMemo(
    () =>
      new Map(environments.map((environment) => [environment.environmentId, environment.label])),
    [environments],
  );
  const sortedProjects = useMemo(
    () => [...projects].sort((left, right) => left.title.localeCompare(right.title)),
    [projects],
  );

  const go = (to: "/" | "/settings" | "/control-center", params?: Record<string, string>) => {
    if (isMobile) setOpenMobile(false);
    if (to === "/control-center" && params) {
      void navigate({
        to: "/control-center/$environmentId/$projectId",
        params: {
          environmentId: params.environmentId ?? "",
          projectId: params.projectId ?? "",
        },
      });
      return;
    }
    void navigate({ to });
  };

  const goBackToChat = async () => {
    if (isReturning || (isProjectCenter && !project)) return;
    if (isMobile) setOpenMobile(false);
    const { lastChatView, lastChatViewByProjectKey } = useWorkspaceTabStore.getState();
    if (!project) {
      if (lastChatView) navigateToTabView(navigate, lastChatView);
      else void navigate({ to: "/" });
      return;
    }
    const projectRef = scopeProjectRef(project.environmentId, project.id);
    const view = resolveControlCenterChatView({
      projectRef,
      preferredViews: [lastChatViewByProjectKey[scopedProjectKey(projectRef)], lastChatView],
      threads: readThreadShells(),
      getDraftProject: (draftId) => {
        const draft = useComposerDraftStore.getState().getDraftSession(DraftId.make(draftId));
        return draft ? scopeProjectRef(draft.environmentId, draft.projectId) : null;
      },
    });
    if (view) {
      navigateToTabView(navigate, view);
      return;
    }
    setIsReturning(true);
    try {
      await handleNewThread(projectRef);
    } catch {
      toastManager.add({ type: "error", title: "이 프로젝트의 대화를 열지 못했습니다." });
    } finally {
      setIsReturning(false);
    }
  };

  return (
    <>
      <SidebarContent className="overflow-x-hidden">
        <SidebarGroup className="gap-2 p-[var(--sidebar-content-inset)]">
          <SidebarGroupLabel>공용 제어센터</SidebarGroupLabel>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                isActive={pathname === "/control-center" || pathname === "/control-center/"}
                onClick={() => go("/control-center")}
              >
                <BrainCircuitIcon />
                <span>전체 현황</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroup>

        <SidebarGroup className="gap-2 p-[var(--sidebar-content-inset)] pt-0">
          <SidebarGroupLabel>폴더별 프로젝트</SidebarGroupLabel>
          <SidebarMenu>
            {sortedProjects.map((project) => {
              const targetPath = `/control-center/${project.environmentId}/${project.id}`;
              return (
                <SidebarMenuItem key={`${project.environmentId}:${project.id}`}>
                  <SidebarMenuButton
                    isActive={pathname === targetPath}
                    onClick={() =>
                      go("/control-center", {
                        environmentId: project.environmentId,
                        projectId: project.id,
                      })
                    }
                  >
                    <ProjectFavicon
                      environmentId={project.environmentId}
                      cwd={project.workspaceRoot}
                      className="size-4 shrink-0"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{project.title}</span>
                      <span className="block truncate text-[10px] text-sidebar-muted-foreground/70">
                        {environmentLabels.get(project.environmentId) ?? "현재 환경"}
                      </span>
                    </span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              );
            })}
            {sortedProjects.length === 0 ? (
              <li className="px-2 py-5 text-center text-xs text-sidebar-muted-foreground">
                등록된 프로젝트가 없습니다.
              </li>
            ) : null}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="p-[var(--sidebar-content-inset)]">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              onClick={() => void goBackToChat()}
              disabled={isReturning || (isProjectCenter && !project)}
            >
              <ArrowLeftIcon />
              <span>대화로 돌아가기</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton onClick={() => go("/settings")}>
              <SettingsIcon />
              <span>CLI 계정 설정</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </>
  );
}
