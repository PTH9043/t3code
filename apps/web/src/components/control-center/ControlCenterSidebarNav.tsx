import { useMemo } from "react";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { ArrowLeftIcon, BrainCircuitIcon, SettingsIcon } from "lucide-react";

import { useEnvironments } from "~/state/environments";
import { useProjects } from "~/state/entities";
import { useLastChatView } from "~/workspaceTabStore";
import { ProjectFavicon } from "../ProjectFavicon";
import { navigateToTabView } from "../tabs/navigateToTabView";
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
  const { environments } = useEnvironments();
  const { isMobile, setOpenMobile } = useSidebar();
  const lastChatView = useLastChatView();
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

  /**
   * "돌아가기" means the conversation the person came from. The index route
   * is not that — it starts a fresh draft in whichever folder was touched
   * last — so it is only the fallback for having no conversation to return to.
   */
  const goBackToChat = () => {
    if (isMobile) setOpenMobile(false);
    if (lastChatView === null) {
      void navigate({ to: "/" });
      return;
    }
    navigateToTabView(navigate, lastChatView);
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
            <SidebarMenuButton onClick={goBackToChat}>
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
