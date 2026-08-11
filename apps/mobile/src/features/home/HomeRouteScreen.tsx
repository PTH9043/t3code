import * as Arr from "effect/Array";
import * as Order from "effect/Order";
import { useNavigation } from "@react-navigation/native";
import { useCallback, useEffect, useMemo, useState } from "react";

import { NativeHeaderToolbar, NativeStackScreenOptions } from "../../native/StackHeader";
import { useProjects, useThreadShells } from "../../state/entities";
import { usePendingNewTasks } from "../../state/use-pending-new-tasks";
import { useWorkspaceState } from "../../state/workspace";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import { WorkspaceEmptyDetail } from "../layout/WorkspaceEmptyDetail";
import { WorkspaceSidebarToolbar } from "../layout/workspace-sidebar-toolbar";
import { checkForAppUpdateOnLaunch } from "../updates/app-updates";
import { AndroidHomeFabLayout } from "./AndroidHomeFab";
import { HomeScreen } from "./HomeScreen";
import { HomeHeader } from "./HomeHeader";
import { useHomeListOptions } from "./home-list-options";
import { buildHomeProjectScopes, resolveRequiredHomeProjectScopeKey } from "./homeThreadList";
import { usePendingTaskListActions } from "./usePendingTaskListActions";
import { useThreadListActions } from "./useThreadListActions";
import { getConnectionAwareBrandHeaderOptions } from "./WorkspaceConnectionTitle";

/* ─── Route screen ───────────────────────────────────────────────────── */

export function HomeRouteScreen() {
  const { layout } = useAdaptiveWorkspaceLayout();
  const projects = useProjects();
  const threads = useThreadShells();
  const { environments: workspaceEnvironments, state: catalogState } = useWorkspaceState();
  const { savedConnectionsById } = useSavedRemoteConnections();
  const navigation = useNavigation();
  const [searchQuery, setSearchQuery] = useState("");

  useEffect(() => {
    void checkForAppUpdateOnLaunch();
  }, []);

  const {
    archiveThread,
    confirmDeleteThread,
    settleThread,
    snoozeThread,
    unsnoozeThread,
    pinThread,
    unpinThread,
    movePinnedThread,
    unsettleThread,
  } = useThreadListActions();
  const pendingTasks = usePendingNewTasks();
  const { openPendingTask, confirmDeletePendingTask } = usePendingTaskListActions();
  const environments = useMemo(() => {
    const connectionStateByEnvironmentId = new Map(
      workspaceEnvironments.map(
        (environment) => [environment.environmentId, environment.connectionState] as const,
      ),
    );
    return Arr.sort(
      Object.values(savedConnectionsById).map((connection) => ({
        environmentId: connection.environmentId,
        label: connection.environmentLabel,
        connectionState:
          connectionStateByEnvironmentId.get(connection.environmentId) ?? "available",
      })),
      Order.mapInput(Order.String, (environment: { readonly label: string }) => environment.label),
    );
  }, [savedConnectionsById, workspaceEnvironments]);
  const availableEnvironmentIds = useMemo(
    () => new Set(environments.map((environment) => environment.environmentId)),
    [environments],
  );
  const {
    options: listOptions,
    setSelectedEnvironmentId,
    setProjectSortOrder,
    setThreadSortOrder,
  } = useHomeListOptions(availableEnvironmentIds);
  const selectedEnvironmentId = listOptions.selectedEnvironmentId;
  const [selectedProjectKey, setSelectedProjectKey] = useState<string | null>(null);
  const projectScopes = useMemo(
    () =>
      buildHomeProjectScopes({
        projects,
        environmentId: selectedEnvironmentId,
        projectGroupingMode: listOptions.projectGroupingMode,
      }),
    [listOptions.projectGroupingMode, projects, selectedEnvironmentId],
  );
  const effectiveSelectedProjectKey = useMemo(
    () => resolveRequiredHomeProjectScopeKey(projectScopes, selectedProjectKey),
    [projectScopes, selectedProjectKey],
  );
  const projectFilterOptions = useMemo(
    () =>
      projectScopes.map((scope) => ({
        key: scope.key,
        label: scope.title,
      })),
    [projectScopes],
  );
  useEffect(() => {
    if (selectedProjectKey !== effectiveSelectedProjectKey) {
      setSelectedProjectKey(effectiveSelectedProjectKey);
    }
  }, [effectiveSelectedProjectKey, selectedProjectKey]);
  const selectedProjectScope = useMemo(
    () =>
      effectiveSelectedProjectKey === null
        ? null
        : (projectScopes.find((scope) => scope.key === effectiveSelectedProjectKey) ?? null),
    [effectiveSelectedProjectKey, projectScopes],
  );
  const openNewConversation = useCallback(() => {
    const project = selectedProjectScope?.representative;
    if (!project) {
      navigation.navigate("NewTaskSheet", { screen: "NewTask" });
      return;
    }
    navigation.navigate("NewTaskSheet", {
      screen: "NewTaskDraft",
      params: {
        environmentId: String(project.environmentId),
        projectId: String(project.id),
        title: project.title,
      },
    });
  }, [navigation, selectedProjectScope]);

  // In split layouts the persistent sidebar IS the thread list — Home becomes
  // an empty detail pane so selecting a thread never transitions layouts.
  if (layout.usesSplitView) {
    return (
      <>
        <NativeStackScreenOptions
          options={{ title: "", headerTitle: "", unstable_headerLeftItems: () => [] }}
        />
        <WorkspaceSidebarToolbar
          afterSidebarButton={
            <NativeHeaderToolbar.Button
              accessibilityLabel="새 대화"
              icon="square.and.pencil"
              onPress={openNewConversation}
            />
          }
        />
        <WorkspaceEmptyDetail onStartNewTask={openNewConversation} />
      </>
    );
  }

  return (
    <AndroidHomeFabLayout onStartNewTask={openNewConversation}>
      <>
        {/* Restore the compact title after the split branch blanks the detail
            header. The brand slot doubles as the connection status surface:
            while an environment reconnects, the lockup fades to a status label
            in place (no layout shift in the list below). */}
        <NativeStackScreenOptions
          options={getConnectionAwareBrandHeaderOptions({
            onOpenEnvironments: () =>
              navigation.navigate("SettingsSheet", { screen: "SettingsEnvironments" }),
          })}
        />
        <HomeHeader
          environments={environments}
          projects={projectFilterOptions}
          searchQuery={searchQuery}
          selectedEnvironmentId={selectedEnvironmentId}
          selectedProjectKey={effectiveSelectedProjectKey}
          projectSortOrder={listOptions.projectSortOrder}
          threadSortOrder={listOptions.threadSortOrder}
          onEnvironmentChange={setSelectedEnvironmentId}
          onProjectChange={setSelectedProjectKey}
          onOpenEnvironments={() =>
            navigation.navigate("SettingsSheet", { screen: "SettingsEnvironments" })
          }
          onOpenSettings={() => navigation.navigate("SettingsSheet", { screen: "Settings" })}
          onProjectSortOrderChange={setProjectSortOrder}
          onSearchQueryChange={setSearchQuery}
          onStartNewTask={openNewConversation}
          onThreadSortOrderChange={setThreadSortOrder}
        />

        <HomeScreen
          catalogState={catalogState}
          environments={environments}
          onAddConnection={() =>
            navigation.navigate("SettingsSheet", { screen: "SettingsEnvironmentNew" })
          }
          onArchiveThread={archiveThread}
          onDeleteThread={confirmDeleteThread}
          onSettleThread={settleThread}
          onSnoozeThread={snoozeThread}
          onUnsnoozeThread={unsnoozeThread}
          onUnsettleThread={unsettleThread}
          onPinThread={pinThread}
          onUnpinThread={unpinThread}
          onMovePinnedThread={movePinnedThread}
          onEnvironmentChange={setSelectedEnvironmentId}
          onProjectChange={setSelectedProjectKey}
          onOpenSettings={() => navigation.navigate("SettingsSheet", { screen: "Settings" })}
          onProjectSortOrderChange={setProjectSortOrder}
          onSearchQueryChange={setSearchQuery}
          onSelectThread={(thread) => {
            // Settled threads are live shells: opening one is plain
            // navigation, and sending a message un-settles server-side.
            navigation.navigate("Thread", {
              environmentId: thread.environmentId,
              threadId: thread.id,
            });
          }}
          onSelectPendingTask={openPendingTask}
          onDeletePendingTask={confirmDeletePendingTask}
          onNewThreadInProject={(project) => {
            navigation.navigate("NewTaskSheet", {
              screen: "NewTaskDraft",
              params: {
                environmentId: String(project.environmentId),
                projectId: String(project.id),
                title: project.title,
              },
            });
          }}
          onOpenCollaborationRuns={(project) =>
            navigation.navigate("WorkspaceCollaborationRuns", {
              environmentId: String(project.environmentId),
              projectId: String(project.id),
            })
          }
          onStartNewTask={openNewConversation}
          onThreadSortOrderChange={setThreadSortOrder}
          pendingTasks={pendingTasks}
          projectGroupingMode={listOptions.projectGroupingMode}
          projects={projects}
          projectSortOrder={listOptions.projectSortOrder}
          savedConnectionsById={savedConnectionsById}
          searchQuery={searchQuery}
          selectedEnvironmentId={selectedEnvironmentId}
          selectedProjectKey={effectiveSelectedProjectKey}
          threads={threads}
          threadSortOrder={listOptions.threadSortOrder}
        />
      </>
    </AndroidHomeFabLayout>
  );
}
