import type { EnvironmentId } from "@t3tools/contracts";
import { connectionStatusTitle } from "@t3tools/client-runtime/connection";
import { GitBranchIcon, WifiOffIcon } from "lucide-react";
import { useMemo, type ComponentProps, type Dispatch, type SetStateAction } from "react";

import {
  dismissVersionMismatch,
  resolveServerConfigVersionMismatch,
  resolveServerSelfUpdateCapability,
  serverUpdateGuidance,
} from "../../versionSkew";
import { resolveLocalCheckoutBranchMismatch } from "../BranchToolbar.logic";
import {
  dismissBranchMismatchForSession,
  suppressEnvironmentReconnectBanner,
} from "../ChatView.logic";
import { ServerUpdateAction, ServerUpdateProgress } from "../ServerUpdateAction";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";
import type { EnvironmentUnavailableState } from "./chatViewHelpers";

export interface UseSystemComposerBannerItemsInput {
  readonly activeEnvironmentUnavailableState: EnvironmentUnavailableState | null;
  readonly reconnectWarningGraceElapsed: boolean;
  readonly recentAccountAutoSwitch: boolean;
  readonly localReconnect: boolean;
  readonly handleReconnectActiveEnvironment: (environmentId: EnvironmentId) => unknown;
  readonly navigate: (opts: { to: "/settings/connections" }) => unknown;
  readonly setDismissedVersionMismatchKey: (key: string | null) => void;
  readonly showVersionMismatchBanner: boolean;
  readonly serverUpdateState:
    | { readonly status: "idle" }
    | ComponentProps<typeof ServerUpdateProgress>["state"];
  readonly versionMismatch: ReturnType<typeof resolveServerConfigVersionMismatch>;
  readonly versionMismatchDismissKey: string | null;
  readonly serverUpdateEnvironmentId: EnvironmentId | null;
  readonly versionMismatchSelfUpdate: ReturnType<typeof resolveServerSelfUpdateCapability>;
  readonly versionMismatchServerLabel: string;
}

export function useSystemComposerBannerItems(
  input: UseSystemComposerBannerItemsInput,
): ComposerBannerStackItem[] {
  const {
    activeEnvironmentUnavailableState,
    reconnectWarningGraceElapsed,
    recentAccountAutoSwitch,
    localReconnect,
    handleReconnectActiveEnvironment,
    navigate,
    setDismissedVersionMismatchKey,
    showVersionMismatchBanner,
    serverUpdateState,
    versionMismatch,
    versionMismatchDismissKey,
    serverUpdateEnvironmentId,
    versionMismatchSelfUpdate,
    versionMismatchServerLabel,
  } = input;

  return useMemo<ComposerBannerStackItem[]>(() => {
    const items: ComposerBannerStackItem[] = [];
    const updateRunning = serverUpdateState.status === "running";
    const unavailableConnection = activeEnvironmentUnavailableState?.connection ?? null;
    const environmentReconnecting =
      unavailableConnection !== null &&
      (unavailableConnection.phase === "connecting" ||
        unavailableConnection.phase === "reconnecting");
    const reconnectingThroughVersionSkew =
      serverUpdateState.status === "idle" && environmentReconnecting && versionMismatch !== null;
    const suppressUnavailableBanner = suppressEnvironmentReconnectBanner({
      reconnecting: environmentReconnecting,
      localBackend: localReconnect,
      versionSkew: reconnectingThroughVersionSkew,
      recentAccountSwitch: recentAccountAutoSwitch,
      updateRunning,
      graceElapsed: reconnectWarningGraceElapsed,
    });
    if (activeEnvironmentUnavailableState && unavailableConnection && !suppressUnavailableBanner) {
      if (reconnectingThroughVersionSkew) {
        items.push({
          id: `environment-unavailable:${activeEnvironmentUnavailableState.environmentId}`,
          variant: "default",
          urgent: true,
          icon: (
            <span
              className="size-1.5 animate-status-pulse rounded-full bg-foreground"
              aria-hidden="true"
            />
          ),
          title: `${activeEnvironmentUnavailableState.label}에 ${unavailableConnection.phase === "connecting" ? "연결 중" : "다시 연결 중"}`,
          description: "업데이트를 마무리하는 중일 수 있습니다. 잠시만 기다려 주세요.",
        });
      } else {
        items.push({
          id: `environment-unavailable:${activeEnvironmentUnavailableState.environmentId}`,
          variant: unavailableConnection.phase === "error" ? "error" : "warning",
          icon: <WifiOffIcon />,
          title: `${activeEnvironmentUnavailableState.label}: ${connectionStatusTitle(unavailableConnection)}`,
          description: "메시지를 보내거나 작업을 실행하기 전에 이 실행 환경에 다시 연결하세요.",
          actions: (
            <>
              <Button
                size="xs"
                disabled={environmentReconnecting}
                onClick={() =>
                  void handleReconnectActiveEnvironment(
                    activeEnvironmentUnavailableState.environmentId,
                  )
                }
              >
                {environmentReconnecting ? "다시 연결 중..." : "다시 연결"}
              </Button>
              <Button
                size="xs"
                variant="outline"
                onClick={() => void navigate({ to: "/settings/connections" })}
              >
                연결
              </Button>
            </>
          ),
        });
      }
    }
    if (
      serverUpdateEnvironmentId &&
      !reconnectingThroughVersionSkew &&
      (serverUpdateState.status !== "idle" ||
        (showVersionMismatchBanner && versionMismatch && versionMismatchDismissKey))
    ) {
      const updateInProgress = serverUpdateState.status === "running";
      const updateFailed = serverUpdateState.status === "failed";
      items.push({
        id: `server-version:${serverUpdateEnvironmentId}`,
        variant: updateFailed ? "error" : "default",
        urgent: updateInProgress,
        icon:
          updateInProgress || updateFailed ? null : (
            <span
              className="size-1.5 rounded-full border border-muted-foreground/40"
              aria-hidden="true"
            />
          ),
        title:
          updateInProgress || updateFailed ? (
            `${versionMismatchServerLabel} ${updateFailed ? "업데이트 실패" : "업데이트 중"}`
          ) : versionMismatch ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <button type="button" className="cursor-help rounded-sm text-left">
                    서버 업데이트 사용 가능
                  </button>
                }
              />
              <TooltipPopup side="top">
                {versionMismatchServerLabel} {versionMismatch.serverVersion}{" "}
                <span aria-hidden="true">→</span> {versionMismatch.clientVersion}
              </TooltipPopup>
            </Tooltip>
          ) : (
            "서버 업데이트 사용 가능"
          ),
        description:
          updateInProgress || updateFailed ? (
            <ServerUpdateProgress state={serverUpdateState} />
          ) : versionMismatchSelfUpdate === "desktop-managed" ? (
            serverUpdateGuidance(versionMismatchSelfUpdate, versionMismatchServerLabel)
          ) : null,
        actions:
          updateInProgress ||
          !versionMismatch ||
          versionMismatchSelfUpdate === "desktop-managed" ? undefined : (
            <ServerUpdateAction
              environmentId={serverUpdateEnvironmentId}
              serverLabel={versionMismatchServerLabel}
              selfUpdate={versionMismatchSelfUpdate}
              targetVersion={versionMismatch.clientVersion}
              label={updateFailed ? "다시 시도" : "업데이트"}
            />
          ),
        ...(updateInProgress || updateFailed || !versionMismatchDismissKey
          ? {}
          : {
              dismissLabel: "업데이트 알림 닫기",
              onDismiss: () => {
                dismissVersionMismatch(versionMismatchDismissKey);
                setDismissedVersionMismatchKey(versionMismatchDismissKey);
              },
            }),
      });
    }
    return items;
  }, [
    activeEnvironmentUnavailableState,
    reconnectWarningGraceElapsed,
    recentAccountAutoSwitch,
    localReconnect,
    handleReconnectActiveEnvironment,
    navigate,
    setDismissedVersionMismatchKey,
    showVersionMismatchBanner,
    serverUpdateState,
    versionMismatch,
    versionMismatchDismissKey,
    serverUpdateEnvironmentId,
    versionMismatchSelfUpdate,
    versionMismatchServerLabel,
  ]);
}

export interface UseComposerBannerItemsInput {
  readonly systemComposerBannerItems: ReadonlyArray<ComposerBannerStackItem>;
  readonly orchestraNodeOriginBannerItem: ComposerBannerStackItem | null;
  readonly meetingRunBannerItem: ComposerBannerStackItem | null;
  readonly monitoringPlanBannerItem: ComposerBannerStackItem | null;
  readonly backgroundLivenessBannerItem: ComposerBannerStackItem | null;
  readonly backgroundWatchBannerItem: ComposerBannerStackItem | null;
  readonly wokeThreadBannerItem: ComposerBannerStackItem | null;
  readonly watcherBannerItem: ComposerBannerStackItem | null;
  readonly parkedThreadBannerItem: ComposerBannerStackItem | null;
  readonly localCheckoutBranchMismatch: ReturnType<typeof resolveLocalCheckoutBranchMismatch>;
  readonly showBranchMismatchBanner: boolean;
  readonly activeBranchMismatchKey: string | null;
  readonly isRestoringThreadBranch: boolean;
  readonly handleRestoreThreadBranch: () => void;
  readonly setBranchMismatchDismissTick: Dispatch<SetStateAction<number>>;
}

export function useComposerBannerItems(
  input: UseComposerBannerItemsInput,
): ComposerBannerStackItem[] {
  const {
    systemComposerBannerItems,
    orchestraNodeOriginBannerItem,
    meetingRunBannerItem,
    monitoringPlanBannerItem,
    backgroundLivenessBannerItem,
    backgroundWatchBannerItem,
    wokeThreadBannerItem,
    watcherBannerItem,
    parkedThreadBannerItem,
    localCheckoutBranchMismatch,
    showBranchMismatchBanner,
    activeBranchMismatchKey,
    isRestoringThreadBranch,
    handleRestoreThreadBranch,
    setBranchMismatchDismissTick,
  } = input;

  return useMemo<ComposerBannerStackItem[]>(() => {
    const isUrgentSystemItem = (item: ComposerBannerStackItem) =>
      item.urgent === true || item.variant === "error" || item.variant === "warning";
    const urgentSystemItems = systemComposerBannerItems.filter(isUrgentSystemItem);
    const calmSystemItems = systemComposerBannerItems.filter((item) => !isUrgentSystemItem(item));
    const meetingRunItems = [
      ...(orchestraNodeOriginBannerItem === null ? [] : [orchestraNodeOriginBannerItem]),
      ...(meetingRunBannerItem === null ? [] : [meetingRunBannerItem]),
    ];
    const monitoringPlanItems = monitoringPlanBannerItem === null ? [] : [monitoringPlanBannerItem];
    const backgroundLivenessItems = [
      ...(backgroundLivenessBannerItem === null ? [] : [backgroundLivenessBannerItem]),
      ...(backgroundWatchBannerItem === null ? [] : [backgroundWatchBannerItem]),
    ];
    const wokeThreadItems = wokeThreadBannerItem === null ? [] : [wokeThreadBannerItem];
    const watcherItems = watcherBannerItem === null ? [] : [watcherBannerItem];
    const parkedThreadItems = parkedThreadBannerItem === null ? [] : [parkedThreadBannerItem];
    if (!localCheckoutBranchMismatch || !showBranchMismatchBanner || !activeBranchMismatchKey) {
      return [
        ...urgentSystemItems,
        ...watcherItems,
        ...meetingRunItems,
        ...monitoringPlanItems,
        ...backgroundLivenessItems,
        ...calmSystemItems,
        ...wokeThreadItems,
        ...parkedThreadItems,
      ];
    }
    return [
      ...urgentSystemItems,
      ...watcherItems,
      ...meetingRunItems,
      ...monitoringPlanItems,
      ...backgroundLivenessItems,
      ...calmSystemItems,
      ...wokeThreadItems,
      {
        id: `branch-mismatch:${activeBranchMismatchKey}`,
        variant: "info",
        icon: <GitBranchIcon />,
        title: (
          <span className="flex min-w-0 items-baseline gap-1.5">
            <span className="shrink-0 font-normal text-muted-foreground">
              브랜치 변경됨 · 이전:
            </span>
            <Tooltip>
              <TooltipTrigger
                render={
                  <code className="min-w-0 truncate font-medium text-foreground">
                    {localCheckoutBranchMismatch.threadBranch}
                  </code>
                }
              />
              <TooltipPopup side="top" className="max-w-80">
                이 대화는 마지막으로 {localCheckoutBranchMismatch.threadBranch}에서 실행됐습니다.
                보내기를 누르면 {localCheckoutBranchMismatch.currentBranch}에서 계속합니다.
              </TooltipPopup>
            </Tooltip>
          </span>
        ),
        className: "dark:shadow-none",
        actions: (
          <Button
            size="xs"
            variant="ghost"
            disabled={isRestoringThreadBranch}
            onClick={handleRestoreThreadBranch}
          >
            {isRestoringThreadBranch ? "복원 중..." : "브랜치 복원"}
          </Button>
        ),
        dismissLabel: "브랜치 변경 알림 닫기",
        onDismiss: () => {
          dismissBranchMismatchForSession(activeBranchMismatchKey);
          setBranchMismatchDismissTick((tick) => tick + 1);
        },
      },
      ...parkedThreadItems,
    ];
  }, [
    monitoringPlanBannerItem,
    activeBranchMismatchKey,
    backgroundLivenessBannerItem,
    backgroundWatchBannerItem,
    handleRestoreThreadBranch,
    isRestoringThreadBranch,
    localCheckoutBranchMismatch,
    meetingRunBannerItem,
    orchestraNodeOriginBannerItem,
    parkedThreadBannerItem,
    showBranchMismatchBanner,
    systemComposerBannerItems,
    watcherBannerItem,
    wokeThreadBannerItem,
    setBranchMismatchDismissTick,
  ]);
}
