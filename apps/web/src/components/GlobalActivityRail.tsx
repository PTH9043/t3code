import { useAtomValue } from "@effect/atom-react";
import { useLocation, useNavigate, useParams } from "@tanstack/react-router";
import {
  ActivityIcon,
  BookOpenIcon,
  BrainCircuitIcon,
  MessageSquareIcon,
  SettingsIcon,
  type LucideIcon,
} from "lucide-react";
import { memo, useCallback, useMemo } from "react";

import { cn } from "~/lib/utils";
import { useEnvironments } from "~/state/environments";
import { primaryServerProvidersAtom } from "~/state/server";
import { useWorkspaceTabStore } from "~/workspaceTabStore";
import { navigateToTabView } from "./tabs/navigateToTabView";
import { Tooltip, TooltipPopup, TooltipProvider, TooltipTrigger } from "./ui/tooltip";

export const GLOBAL_ACTIVITY_RAIL_WIDTH_PX = 48;

export type GlobalActivityRailItemId =
  | "chat"
  | "control-center"
  | "knowledge"
  | "diagnostics"
  | "settings";

export type DiagnosticsAlertLevel = "warning" | "error" | null;

export interface ActiveRailProjectRef {
  readonly environmentId: string;
  readonly projectId: string;
}

export interface GlobalActivityRailItem {
  readonly id: GlobalActivityRailItemId;
  readonly label: string;
  readonly tooltip: string;
  readonly href: string;
  readonly icon: LucideIcon;
  readonly placement: "top" | "bottom";
  readonly alertLevel?: DiagnosticsAlertLevel;
}

const KNOWLEDGE_ROUTE_PATTERN = /^\/control-center\/[^/]+\/[^/]+\/knowledge(?:\/|$)/;
const CONTROL_CENTER_ROUTE_PATTERN = /^\/control-center(?:\/|$)/;
const DIAGNOSTICS_ROUTE_PATTERN = /^\/settings\/diagnostics(?:\/|$)/;
const SETTINGS_ROUTE_PATTERN = /^\/settings(?:\/|$)/;

/**
 * Resolve which top-level rail destination is active for the current pathname.
 */
export function resolveActiveActivityRailItem(pathname: string): GlobalActivityRailItemId {
  if (KNOWLEDGE_ROUTE_PATTERN.test(pathname)) {
    return "knowledge";
  }
  if (CONTROL_CENTER_ROUTE_PATTERN.test(pathname)) {
    return "control-center";
  }
  if (DIAGNOSTICS_ROUTE_PATTERN.test(pathname)) {
    return "diagnostics";
  }
  if (SETTINGS_ROUTE_PATTERN.test(pathname)) {
    return "settings";
  }
  return "chat";
}

/**
 * Parse a `environmentId:projectId` workspace tab key into its components.
 */
export function parseProjectKey(
  projectKey: string | null | undefined,
): ActiveRailProjectRef | null {
  if (!projectKey) return null;
  const separatorIndex = projectKey.indexOf(":");
  if (separatorIndex <= 0 || separatorIndex >= projectKey.length - 1) {
    return null;
  }
  const environmentId = projectKey.slice(0, separatorIndex).trim();
  const projectId = projectKey.slice(separatorIndex + 1).trim();
  if (!environmentId || !projectId) {
    return null;
  }
  return { environmentId, projectId };
}

/**
 * Resolve the currently active project for the Knowledge & RAG rail shortcut.
 */
export function resolveActiveProjectForRail(input: {
  readonly routeEnvironmentId?: string | undefined;
  readonly routeProjectId?: string | undefined;
  readonly activeTabProjectKey?: string | null | undefined;
}): ActiveRailProjectRef | null {
  if (input.routeEnvironmentId && input.routeProjectId) {
    return {
      environmentId: input.routeEnvironmentId,
      projectId: input.routeProjectId,
    };
  }
  return parseProjectKey(input.activeTabProjectKey);
}

/**
 * Derive a lightweight system diagnostics alert badge without subscribing to
 * high-frequency live resource telemetry polling.
 */
export function detectSystemDiagnosticsAlert(input: {
  readonly networkStatus?: string | undefined;
  readonly environmentPhases?: ReadonlyArray<string> | undefined;
  readonly providerStatuses?:
    | ReadonlyArray<{
        readonly enabled: boolean;
        readonly status: string;
      }>
    | undefined;
}): DiagnosticsAlertLevel {
  if (input.networkStatus === "offline") {
    return "error";
  }
  let hasWarning = false;
  for (const phase of input.environmentPhases ?? []) {
    if (phase === "error") {
      return "error";
    }
    if (phase === "disconnected" || phase === "reconnecting") {
      hasWarning = true;
    }
  }
  for (const provider of input.providerStatuses ?? []) {
    if (!provider.enabled) continue;
    if (provider.status === "error") {
      return "error";
    }
    if (provider.status === "warning") {
      hasWarning = true;
    }
  }
  return hasWarning ? "warning" : null;
}

export function resolveGlobalActivityRailItems(options: {
  readonly activeProject: ActiveRailProjectRef | null;
  readonly diagnosticsAlert: DiagnosticsAlertLevel;
}): ReadonlyArray<GlobalActivityRailItem> {
  const knowledgeHref = options.activeProject
    ? `/control-center/${encodeURIComponent(options.activeProject.environmentId)}/${encodeURIComponent(options.activeProject.projectId)}/knowledge/manage`
    : "/control-center";

  const diagnosticsTooltip =
    options.diagnosticsAlert === "error"
      ? "시스템 진단 (오류 확인 필요)"
      : options.diagnosticsAlert === "warning"
        ? "시스템 진단 (상태 확인 필요)"
        : "시스템 진단";

  return [
    {
      id: "chat",
      label: "대화",
      tooltip: "대화",
      href: "/",
      icon: MessageSquareIcon,
      placement: "top",
    },
    {
      id: "control-center",
      label: "AI 제어센터",
      tooltip: "AI 제어센터",
      href: "/control-center",
      icon: BrainCircuitIcon,
      placement: "top",
    },
    {
      id: "knowledge",
      label: "지식·RAG",
      tooltip: options.activeProject ? "지식·RAG" : "지식·RAG (프로젝트 선택)",
      href: knowledgeHref,
      icon: BookOpenIcon,
      placement: "top",
    },
    {
      id: "diagnostics",
      label: "시스템 진단",
      tooltip: diagnosticsTooltip,
      href: "/settings/diagnostics",
      icon: ActivityIcon,
      placement: "top",
      alertLevel: options.diagnosticsAlert,
    },
    {
      id: "settings",
      label: "환경 설정",
      tooltip: "환경 설정",
      href: "/settings/general",
      icon: SettingsIcon,
      placement: "bottom",
    },
  ];
}

export interface GlobalActivityRailViewProps {
  readonly pathname: string;
  readonly activeProject: ActiveRailProjectRef | null;
  readonly diagnosticsAlert: DiagnosticsAlertLevel;
  readonly topInset?: boolean;
  readonly onSelectItem: (item: GlobalActivityRailItem) => void;
}

export const GlobalActivityRailView = memo(function GlobalActivityRailView({
  pathname,
  activeProject,
  diagnosticsAlert,
  topInset = false,
  onSelectItem,
}: GlobalActivityRailViewProps) {
  const activeItemId = resolveActiveActivityRailItem(pathname);
  const items = useMemo(
    () => resolveGlobalActivityRailItems({ activeProject, diagnosticsAlert }),
    [activeProject, diagnosticsAlert],
  );
  const topItems = useMemo(() => items.filter((item) => item.placement === "top"), [items]);
  const bottomItems = useMemo(() => items.filter((item) => item.placement === "bottom"), [items]);

  const renderItem = (item: GlobalActivityRailItem) => {
    const Icon = item.icon;
    const isActive = activeItemId === item.id;
    const hasAlert = item.alertLevel === "error" || item.alertLevel === "warning";

    return (
      <Tooltip key={item.id}>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label={item.label}
              aria-current={isActive ? "page" : undefined}
              data-rail-item={item.id}
              data-rail-href={item.href}
              data-active={isActive ? "true" : "false"}
              onClick={() => onSelectItem(item)}
              className={cn(
                "group/rail-btn relative flex size-9 cursor-pointer items-center justify-center rounded-lg outline-hidden ring-ring transition-colors [-webkit-app-region:no-drag] focus-visible:ring-2",
                isActive
                  ? "bg-sidebar-row-selected text-sidebar-foreground"
                  : "text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
              )}
            />
          }
        >
          {isActive ? (
            <span
              aria-hidden="true"
              data-rail-active-indicator="true"
              className="pointer-events-none absolute -left-1.5 top-1.5 bottom-1.5 w-[3px] rounded-r-full bg-primary"
            />
          ) : null}
          <Icon className="size-[18px] shrink-0" aria-hidden="true" />
          {hasAlert ? (
            <span
              aria-hidden="true"
              data-status-badge={item.alertLevel ?? undefined}
              className={cn(
                "pointer-events-none absolute right-1.5 top-1.5 size-2 rounded-full ring-2 ring-sidebar",
                item.alertLevel === "error"
                  ? "bg-[var(--status-danger)]"
                  : "bg-[var(--status-warning)]",
              )}
            />
          ) : null}
        </TooltipTrigger>
        <TooltipPopup side="right" sideOffset={8}>
          {item.tooltip}
        </TooltipPopup>
      </Tooltip>
    );
  };

  return (
    <TooltipProvider delay={150} closeDelay={0} timeout={300}>
      <nav
        aria-label="전역 탐색"
        data-slot="global-activity-rail"
        className={cn(
          "relative z-30 hidden h-full w-12 shrink-0 flex-col items-center justify-between border-r border-sidebar-border bg-sidebar py-2 text-sidebar-foreground select-none md:flex",
          topInset && "pt-[var(--workspace-topbar-height)]",
        )}
      >
        <div className="flex flex-col items-center gap-1.5">{topItems.map(renderItem)}</div>
        <div className="mt-auto flex flex-col items-center gap-1.5">
          {bottomItems.map(renderItem)}
        </div>
      </nav>
    </TooltipProvider>
  );
});

export function GlobalActivityRail({
  topInset = false,
  diagnosticsAlertOverride,
}: {
  readonly topInset?: boolean;
  readonly diagnosticsAlertOverride?: DiagnosticsAlertLevel;
}) {
  const navigate = useNavigate();
  const pathname = useLocation({ select: (location) => location.pathname });
  const params = useParams({ strict: false });
  const activeTabProjectKey = useWorkspaceTabStore((state) => {
    const activeTab = state.tabs.find((tab) => tab.id === state.activeTabId);
    return activeTab?.projectKey ?? null;
  });
  const { environments, networkStatus } = useEnvironments();
  const providers = useAtomValue(primaryServerProvidersAtom);

  const activeProject = useMemo(
    () =>
      resolveActiveProjectForRail({
        routeEnvironmentId:
          typeof params.environmentId === "string" ? params.environmentId : undefined,
        routeProjectId: typeof params.projectId === "string" ? params.projectId : undefined,
        activeTabProjectKey,
      }),
    [activeTabProjectKey, params.environmentId, params.projectId],
  );

  const derivedDiagnosticsAlert = useMemo(
    () =>
      detectSystemDiagnosticsAlert({
        networkStatus,
        environmentPhases: environments.map((env) => env.connection.phase),
        providerStatuses: providers.map((provider) => ({
          enabled: provider.enabled,
          status: provider.status,
        })),
      }),
    [environments, networkStatus, providers],
  );

  const diagnosticsAlert =
    diagnosticsAlertOverride !== undefined ? diagnosticsAlertOverride : derivedDiagnosticsAlert;

  const handleSelectItem = useCallback(
    (item: GlobalActivityRailItem) => {
      switch (item.id) {
        case "chat": {
          const lastChatView = useWorkspaceTabStore.getState().lastChatView;
          if (lastChatView) {
            navigateToTabView(navigate, lastChatView);
            return;
          }
          void navigate({ to: "/" });
          return;
        }
        case "control-center":
          void navigate({ to: "/control-center" });
          return;
        case "knowledge":
          if (activeProject) {
            void navigate({
              to: "/control-center/$environmentId/$projectId/knowledge/manage",
              params: {
                environmentId: activeProject.environmentId,
                projectId: activeProject.projectId,
              },
            });
            return;
          }
          void navigate({ to: "/control-center" });
          return;
        case "diagnostics":
          void navigate({ to: "/settings/diagnostics" });
          return;
        case "settings":
          void navigate({ to: "/settings/general" });
          return;
      }
    },
    [activeProject, navigate],
  );

  return (
    <GlobalActivityRailView
      pathname={pathname}
      activeProject={activeProject}
      diagnosticsAlert={diagnosticsAlert}
      topInset={topInset}
      onSelectItem={handleSelectItem}
    />
  );
}

/**
 * Mobile (<768px) bottom tab bar mirroring the 5 Global Activity Rail
 * destinations so compact viewports (430×932) never lose navigation access.
 */
export function MobileActivityTabBar({
  diagnosticsAlertOverride,
}: {
  readonly diagnosticsAlertOverride?: DiagnosticsAlertLevel;
}) {
  const navigate = useNavigate();
  const pathname = useLocation({ select: (location) => location.pathname });
  const params = useParams({ strict: false });
  const activeTabProjectKey = useWorkspaceTabStore((state) => {
    const activeTab = state.tabs.find((tab) => tab.id === state.activeTabId);
    return activeTab?.projectKey ?? null;
  });
  const { environments, networkStatus } = useEnvironments();
  const providers = useAtomValue(primaryServerProvidersAtom);

  const activeProject = useMemo(
    () =>
      resolveActiveProjectForRail({
        routeEnvironmentId:
          typeof params.environmentId === "string" ? params.environmentId : undefined,
        routeProjectId: typeof params.projectId === "string" ? params.projectId : undefined,
        activeTabProjectKey,
      }),
    [activeTabProjectKey, params.environmentId, params.projectId],
  );

  const derivedDiagnosticsAlert = useMemo(
    () =>
      detectSystemDiagnosticsAlert({
        networkStatus,
        environmentPhases: environments.map((env) => env.connection.phase),
        providerStatuses: providers.map((provider) => ({
          enabled: provider.enabled,
          status: provider.status,
        })),
      }),
    [environments, networkStatus, providers],
  );

  const diagnosticsAlert =
    diagnosticsAlertOverride !== undefined ? diagnosticsAlertOverride : derivedDiagnosticsAlert;
  const activeId = resolveActiveActivityRailItem(pathname);
  const items = useMemo(
    () => resolveGlobalActivityRailItems({ activeProject, diagnosticsAlert }),
    [activeProject, diagnosticsAlert],
  );

  const handleSelectItem = useCallback(
    (item: GlobalActivityRailItem) => {
      switch (item.id) {
        case "chat": {
          const lastChatView = useWorkspaceTabStore.getState().lastChatView;
          if (lastChatView) {
            navigateToTabView(navigate, lastChatView);
            return;
          }
          void navigate({ to: "/" });
          return;
        }
        case "control-center":
          void navigate({ to: "/control-center" });
          return;
        case "knowledge":
          if (activeProject) {
            void navigate({
              to: "/control-center/$environmentId/$projectId/knowledge/manage",
              params: {
                environmentId: activeProject.environmentId,
                projectId: activeProject.projectId,
              },
            });
            return;
          }
          void navigate({ to: "/control-center" });
          return;
        case "diagnostics":
          void navigate({ to: "/settings/diagnostics" });
          return;
        case "settings":
          void navigate({ to: "/settings/general" });
          return;
      }
    },
    [activeProject, navigate],
  );

  return (
    <nav
      aria-label="모바일 전역 탐색"
      data-slot="mobile-activity-tabbar"
      className="fixed inset-x-0 bottom-0 z-40 flex items-center justify-around border-t border-sidebar-border bg-sidebar/95 px-1 pt-1 pb-[max(0.375rem,env(safe-area-inset-bottom))] text-sidebar-foreground backdrop-blur-md select-none md:hidden"
    >
      {items.map((item) => {
        const Icon = item.icon;
        const active = item.id === activeId;
        return (
          <button
            key={item.id}
            type="button"
            aria-label={item.label}
            aria-current={active ? "page" : undefined}
            data-mobile-rail-item={item.id}
            onClick={() => handleSelectItem(item)}
            className={cn(
              "relative flex min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-md px-1 py-1 text-[10px] font-medium transition-colors",
              active ? "text-primary" : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon className="size-4 shrink-0" />
            <span className="truncate">{item.label}</span>
            {item.alertLevel ? (
              <span
                aria-hidden="true"
                className={cn(
                  "absolute top-1 right-1/4 size-1.5 rounded-full",
                  item.alertLevel === "error" ? "bg-destructive" : "bg-amber-500",
                )}
              />
            ) : null}
          </button>
        );
      })}
    </nav>
  );
}
