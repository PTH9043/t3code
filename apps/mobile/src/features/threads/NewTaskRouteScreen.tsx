import { NativeHeaderToolbar, NativeStackScreenOptions } from "../../native/StackHeader";
import { useIsFocused, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { SymbolView } from "../../components/AppSymbol";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, Platform, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useThemeColor } from "../../lib/useThemeColor";
import { cn } from "../../lib/cn";

import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text } from "../../components/AppText";
import { ProjectFavicon } from "../../components/ProjectFavicon";
import { useProjects } from "../../state/entities";
import type { WorkspaceState } from "../../state/workspaceModel";
import { useWorkspaceState } from "../../state/workspace";
import { scopedProjectKey } from "../../lib/scopedEntities";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import { useIncomingShare } from "../sharing/IncomingShareProvider";
import { useNewTaskFlow } from "./new-task-flow-provider";

type NewTaskRouteParams = {
  readonly incomingShareId?: string | string[];
};

function deriveProjectEmptyState(catalogState: WorkspaceState): {
  readonly title: string;
  readonly detail: string;
  readonly loading: boolean;
} {
  if (catalogState.isLoadingConnections) {
    return {
      title: "연결 환경을 불러오는 중",
      detail: "이 기기에 저장된 연결 환경을 확인하고 있습니다.",
      loading: true,
    };
  }

  if (!catalogState.hasConnections) {
    return {
      title: "연결된 환경이 없습니다",
      detail: "작업을 만들기 전에 연결 환경을 추가하세요.",
      loading: false,
    };
  }

  if (
    (catalogState.connectionState === "available" ||
      catalogState.connectionState === "offline" ||
      catalogState.connectionState === "error") &&
    !catalogState.hasLoadedShellSnapshot
  ) {
    return {
      title: "연결 환경을 사용할 수 없습니다",
      detail:
        catalogState.connectionError ??
        "저장된 환경이 오프라인입니다. 주소를 확인하거나 환경을 시작한 뒤 다시 시도하세요.",
      loading: false,
    };
  }

  if (
    catalogState.hasConnectingEnvironment &&
    !catalogState.hasLoadedShellSnapshot &&
    catalogState.connectionError === null
  ) {
    return {
      title: "연결 환경에 접속 중",
      detail: "저장된 환경에서 프로젝트를 불러오고 있습니다.",
      loading: true,
    };
  }

  return {
    title: "프로젝트가 없습니다",
    detail: "연결된 환경에서 등록된 프로젝트를 찾지 못했습니다.",
    loading: false,
  };
}

export function NewTaskRouteScreen({ route }: StaticScreenProps<NewTaskRouteParams | undefined>) {
  const projects = useProjects();
  const { projectScopes } = useNewTaskFlow();
  const { state: catalogState } = useWorkspaceState();
  const navigation = useNavigation();
  const isFocused = useIsFocused();
  const { layout } = useAdaptiveWorkspaceLayout();
  const insets = useSafeAreaInsets();
  const chevronColor = useThemeColor("--color-chevron");
  const accentColor = useThemeColor("--color-icon-muted");
  const [expandedGroupKeys, setExpandedGroupKeys] = useState<ReadonlySet<string>>(() => new Set());
  const { getShare, releaseShareReservation } = useIncomingShare();
  const routeShareId = Array.isArray(route.params?.incomingShareId)
    ? route.params.incomingShareId[0]
    : route.params?.incomingShareId;
  const incomingShare = routeShareId ? getShare(routeShareId) : null;
  const incomingShareSubtitle = incomingShare
    ? incomingShare.attachments.length === 0
      ? "공유한 내용을 사용할 프로젝트를 선택하세요"
      : incomingShare.attachments.length === 1
        ? "공유한 이미지를 사용할 프로젝트를 선택하세요"
        : `공유한 이미지 ${incomingShare.attachments.length}개를 사용할 프로젝트를 선택하세요`
    : null;
  const screenTitle = incomingShare ? "작업 시작" : "프로젝트 선택";
  const projectEmptyState = deriveProjectEmptyState(catalogState);
  const resumedDestinationKeyRef = useRef<string | null>(null);
  const reservedDestinationProject = incomingShare?.destination
    ? (projects.find(
        (project) =>
          project.environmentId === incomingShare.destination?.environmentId &&
          project.id === incomingShare.destination?.projectId,
      ) ?? null)
    : null;

  async function selectProject(project: EnvironmentProject): Promise<void> {
    if (incomingShare?.destination && !reservedDestinationProject) {
      try {
        await releaseShareReservation(incomingShare.id, incomingShare.destination);
      } catch (error) {
        Alert.alert(
          "Could not change project",
          error instanceof Error
            ? error.message
            : "The shared content reservation could not be updated.",
        );
        return;
      }
    }
    navigation.navigate("NewTaskSheet", {
      screen: "NewTaskDraft",
      params: {
        environmentId: project.environmentId,
        projectId: project.id,
        title: project.title,
        incomingShareId: incomingShare?.id,
      },
    });
  }

  function toggleGroup(groupKey: string): void {
    setExpandedGroupKeys((current) => {
      const next = new Set(current);
      if (next.has(groupKey)) {
        next.delete(groupKey);
      } else {
        next.add(groupKey);
      }
      return next;
    });
  }

  useEffect(() => {
    const destination = incomingShare?.destination;
    if (!destination) {
      resumedDestinationKeyRef.current = null;
      return;
    }
    if (!isFocused) {
      // Returning from the reserved draft is a fresh resume attempt. Keeping
      // this latch set would leave every project row disabled with no route.
      resumedDestinationKeyRef.current = null;
      return;
    }
    const destinationKey = `${incomingShare.id}:${destination.environmentId}:${destination.projectId}`;
    if (resumedDestinationKeyRef.current === destinationKey) {
      return;
    }
    if (!reservedDestinationProject) {
      return;
    }
    resumedDestinationKeyRef.current = destinationKey;
    navigation.navigate("NewTaskSheet", {
      screen: "NewTaskDraft",
      params: {
        environmentId: reservedDestinationProject.environmentId,
        projectId: reservedDestinationProject.id,
        title: reservedDestinationProject.title,
        incomingShareId: incomingShare.id,
      },
    });
  }, [incomingShare, isFocused, navigation, reservedDestinationProject]);

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      {Platform.OS === "android" ? (
        <>
          {/* Android renders its own in-screen header instead of the native bar. */}
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader
            title={screenTitle}
            subtitle={incomingShareSubtitle}
            onBack={layout.usesSplitView ? () => navigation.goBack() : undefined}
            actions={
              catalogState.hasReadyEnvironment
                ? [
                    {
                      accessibilityLabel: "프로젝트 추가",
                      icon: "plus",
                      onPress: () => navigation.navigate("NewTaskSheet", { screen: "AddProject" }),
                    },
                  ]
                : []
            }
          />
        </>
      ) : (
        <>
          <NativeStackScreenOptions
            options={{
              title: screenTitle,
              unstable_headerSubtitle: incomingShareSubtitle ?? undefined,
            }}
          />
          <NativeHeaderToolbar placement="right">
            {layout.usesSplitView ? (
              <NativeHeaderToolbar.Button
                accessibilityLabel="새 작업 닫기"
                icon="xmark"
                onPress={() => navigation.goBack()}
                separateBackground
              />
            ) : null}
            {catalogState.hasReadyEnvironment ? (
              <NativeHeaderToolbar.Button
                icon="plus"
                onPress={() => navigation.navigate("NewTaskSheet", { screen: "AddProject" })}
                separateBackground
              />
            ) : null}
          </NativeHeaderToolbar>
        </>
      )}

      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerStyle={{
          gap: 12,
          paddingBottom: Math.max(insets.bottom, 18) + 18,
          paddingHorizontal: 20,
          paddingTop: 8,
        }}
      >
        {projectScopes.length === 0 ? (
          <View collapsable={false} className="items-center gap-3 rounded-[24px] bg-card px-6 py-8">
            {projectEmptyState.loading ? <ActivityIndicator color={accentColor} /> : null}
            <Text className="text-center text-lg font-t3-bold text-foreground">
              {projectEmptyState.title}
            </Text>
            <Text className="text-center text-sm leading-normal text-foreground-muted">
              {projectEmptyState.detail}
            </Text>
            {!catalogState.hasReadyEnvironment ? (
              <Pressable
                className="mt-1 rounded-full bg-primary px-4 py-2.5 active:opacity-70"
                onPress={() => navigation.navigate("ConnectionsNew")}
              >
                <Text className="text-sm font-t3-bold text-primary-foreground">
                  Add environment
                </Text>
              </Pressable>
            ) : (
              <Pressable
                className="mt-1 rounded-full bg-primary px-4 py-2.5 active:opacity-70"
                onPress={() => navigation.navigate("NewTaskSheet", { screen: "AddProject" })}
              >
                <Text className="text-sm font-t3-bold text-primary-foreground">
                  Add new project
                </Text>
              </Pressable>
            )}
          </View>
        ) : (
          <View collapsable={false} className="overflow-hidden rounded-[24px] bg-card">
            {projectScopes.map((scope, scopeIndex) => {
              const hasMultipleProjects = scope.projects.length > 1;
              const expanded = expandedGroupKeys.has(scope.key);
              const singleProject = hasMultipleProjects ? null : scope.projects[0];
              return (
                <View
                  key={scope.key}
                  className={cn(scopeIndex > 0 && "border-t border-border-subtle")}
                >
                  <Pressable
                    disabled={singleProject !== null && reservedDestinationProject !== null}
                    onPress={() => {
                      if (singleProject) {
                        void selectProject(singleProject);
                      } else {
                        toggleGroup(scope.key);
                      }
                    }}
                    className="flex-row items-center gap-3 bg-card px-4 py-3.5"
                  >
                    <View className="h-7 w-7 items-center justify-center">
                      <ProjectFavicon
                        environmentId={scope.representative.environmentId}
                        size={20}
                        projectTitle={scope.title}
                        workspaceRoot={scope.representative.workspaceRoot}
                      />
                    </View>
                    <View className="min-w-0 flex-1">
                      <Text className="text-base leading-snug font-t3-bold">{scope.title}</Text>
                      <Text
                        className="text-xs leading-snug text-foreground-muted"
                        ellipsizeMode="middle"
                        numberOfLines={1}
                      >
                        {hasMultipleProjects
                          ? `${scope.projects.length} workspaces`
                          : singleProject?.workspaceRoot}
                      </Text>
                    </View>
                    <SymbolView
                      name={hasMultipleProjects && expanded ? "chevron.down" : "chevron.right"}
                      size={14}
                      tintColor={chevronColor}
                      type="monochrome"
                    />
                  </Pressable>
                  {hasMultipleProjects && expanded
                    ? scope.projects.map((project) => (
                        <Pressable
                          key={scopedProjectKey(project.environmentId, project.id)}
                          disabled={reservedDestinationProject !== null}
                          onPress={() => void selectProject(project)}
                          className="flex-row items-center gap-3 border-t border-border-subtle bg-card py-3 pr-4 pl-10"
                        >
                          <ProjectFavicon
                            environmentId={project.environmentId}
                            size={18}
                            projectTitle={project.title}
                            workspaceRoot={project.workspaceRoot}
                          />
                          <View className="min-w-0 flex-1">
                            <Text className="text-sm font-t3-bold text-foreground">
                              {project.title}
                            </Text>
                            <Text
                              className="text-xs text-foreground-muted"
                              ellipsizeMode="middle"
                              numberOfLines={1}
                            >
                              {project.workspaceRoot}
                            </Text>
                          </View>
                          <SymbolView
                            name="chevron.right"
                            size={14}
                            tintColor={chevronColor}
                            type="monochrome"
                          />
                        </Pressable>
                      ))
                    : null}
                </View>
              );
            })}
          </View>
        )}
      </ScrollView>
    </View>
  );
}
