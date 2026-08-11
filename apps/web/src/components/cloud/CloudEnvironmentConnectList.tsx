import { findErrorTraceId } from "@t3tools/client-runtime/errors";
import {
  type EnvironmentConnectionPresentation,
  RelayConnectionRegistration,
  RelayConnectionTarget,
} from "@t3tools/client-runtime/connection";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import type { RelayClientEnvironmentRecord } from "@t3tools/contracts/relay";
import * as Option from "effect/Option";
import { type ReactNode, useCallback, useEffect, useState } from "react";

import { environmentCatalog } from "~/connection/catalog";
import { cn } from "~/lib/utils";
import { relayEnvironmentDiscovery } from "~/state/relay";
import { useRelayEnvironmentDiscovery } from "~/state/environments";
import { useAtomCommand } from "~/state/use-atom-command";
import { ConnectionStatusDot } from "../ConnectionStatusDot";
import { ITEM_ROW_CLASSNAME, ITEM_ROW_INNER_CLASSNAME } from "../settings/itemRows";
import { Button } from "../ui/button";
import { Skeleton } from "../ui/skeleton";
import { toastManager } from "../ui/toast";
import { presentSavedCloudEnvironmentConnection } from "./cloudEnvironmentConnectionPresentation";

export interface SavedCloudEnvironmentConnection {
  readonly environmentId: EnvironmentId;
  readonly connection: EnvironmentConnectionPresentation;
}

export function RemoteEnvironmentRowsSkeleton() {
  return (
    <div className={ITEM_ROW_CLASSNAME}>
      <div className={ITEM_ROW_INNER_CLASSNAME}>
        <div className="min-w-0 flex-1 space-y-2">
          <Skeleton className="h-4 w-32 rounded-full" />
          <Skeleton className="h-3 w-20 rounded-full" />
        </div>
        <Skeleton className="h-7 w-16 rounded-md" />
      </div>
    </div>
  );
}

/**
 * The user's T3 Connect environments from relay discovery, each with a
 * Connect button. The primary environment is always excluded; already-saved
 * environments are hidden unless `showSavedEnvironments` renders them with
 * their live connection state (used by onboarding, where the full device mesh
 * should be visible).
 */
export function CloudEnvironmentConnectRows({
  primaryEnvironmentId,
  savedEnvironments,
  showSavedEnvironments = false,
  empty = null,
}: {
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly savedEnvironments: ReadonlyArray<SavedCloudEnvironmentConnection>;
  readonly showSavedEnvironments?: boolean;
  readonly empty?: ReactNode;
}) {
  const environmentsState = useRelayEnvironmentDiscovery();
  const registerEnvironment = useAtomCommand(environmentCatalog.register, {
    reportFailure: false,
  });
  const refreshRelayEnvironments = useAtomCommand(relayEnvironmentDiscovery.refresh, {
    reportFailure: false,
  });
  const connectRelayEnvironment = useCallback(
    (environment: RelayClientEnvironmentRecord) =>
      registerEnvironment(
        new RelayConnectionRegistration({
          target: new RelayConnectionTarget({
            environmentId: environment.environmentId,
            label: environment.label,
          }),
        }),
      ),
    [registerEnvironment],
  );
  const [connectingEnvironmentId, setConnectingEnvironmentId] = useState<EnvironmentId | null>(
    null,
  );
  const savedById = new Map(
    savedEnvironments.map((environment) => [environment.environmentId, environment]),
  );

  useEffect(() => {
    void refreshRelayEnvironments();
  }, [refreshRelayEnvironments]);

  const connectEnvironment = async (environment: RelayClientEnvironmentRecord) => {
    setConnectingEnvironmentId(environment.environmentId);
    const result = await connectRelayEnvironment(environment);
    setConnectingEnvironmentId(null);
    if (result._tag === "Success") {
      toastManager.add({
        type: "success",
        title: "실행 환경을 추가했습니다",
        description: `T3 Connect를 통해 ${environment.label}에 연결하고 있습니다.`,
      });
      return;
    }
    if (isAtomCommandInterrupted(result)) {
      return;
    }
    const cause = squashAtomCommandFailure(result);
    const message =
      cause instanceof Error ? cause.message : "T3 Connect 실행 환경에 연결하지 못했습니다.";
    const traceId = findErrorTraceId(cause);
    console.error("[t3-connect] Could not connect environment", { message, traceId, cause });
    toastManager.add({
      type: "error",
      title: "실행 환경에 연결하지 못했습니다",
      description: "T3 Connect 연결을 확인한 뒤 다시 시도해 주세요.",
      data: traceId
        ? {
            secondaryActionProps: {
              children: "추적 ID 복사",
              onClick: () => void navigator.clipboard?.writeText(traceId),
            },
          }
        : undefined,
    });
  };

  const visibleEnvironments = [...environmentsState.environments.values()].filter(
    ({ environment }) =>
      environment.environmentId !== primaryEnvironmentId &&
      (showSavedEnvironments || !savedById.has(environment.environmentId)),
  );

  const standalone = showSavedEnvironments || savedEnvironments.length === 0;

  if (
    standalone &&
    visibleEnvironments.length === 0 &&
    environmentsState.refreshing &&
    environmentsState.environments.size === 0
  ) {
    return <RemoteEnvironmentRowsSkeleton />;
  }

  if (standalone && visibleEnvironments.length === 0) {
    // A failed or offline discovery is not "no environments" — misreporting it
    // as empty would read as the user's devices having disappeared.
    const discoveryProblem = environmentsState.offline
      ? "현재 오프라인 상태입니다."
      : Option.isSome(environmentsState.error)
        ? "T3 Connect 환경 정보를 불러오지 못했습니다."
        : null;
    if (discoveryProblem !== null && !environmentsState.refreshing) {
      return (
        <div className={ITEM_ROW_CLASSNAME}>
          <p className="text-sm font-medium text-destructive">
            T3 Connect 실행 환경을 불러오지 못했습니다
          </p>
          <p className="mt-1 text-xs text-muted-foreground">{discoveryProblem}</p>
          <Button
            size="sm"
            variant="outline"
            className="mt-3"
            onClick={() => void refreshRelayEnvironments()}
          >
            다시 시도
          </Button>
        </div>
      );
    }
    return empty;
  }

  return visibleEnvironments.map(({ environment, availability }) => {
    const savedEnvironment = savedById.get(environment.environmentId);
    const savedConnection = savedEnvironment
      ? presentSavedCloudEnvironmentConnection(savedEnvironment.connection)
      : null;
    const dotClassName = savedConnection
      ? savedConnection.tone === "connected"
        ? "bg-success"
        : savedConnection.tone === "connecting"
          ? "bg-warning"
          : savedConnection.tone === "error"
            ? "bg-destructive"
            : "bg-muted-foreground/35"
      : availability === "online"
        ? "bg-success"
        : availability === "error"
          ? "bg-destructive"
          : availability === "checking"
            ? "bg-warning"
            : "bg-muted-foreground/35";
    const statusText = savedConnection
      ? savedConnection.statusText
      : availability === "online"
        ? "사용 가능 · 릴레이 온라인"
        : availability === "offline"
          ? "사용 가능 · 릴레이 오프라인"
          : availability === "checking"
            ? "사용 가능 · 릴레이 상태 확인 중…"
            : "사용 가능 · 릴레이 상태를 확인할 수 없음";
    return (
      <div key={environment.environmentId} className={ITEM_ROW_CLASSNAME}>
        <div className={ITEM_ROW_INNER_CLASSNAME}>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <ConnectionStatusDot
                dotClassName={dotClassName}
                pingClassName={
                  savedConnection?.tone === "connecting" ||
                  (savedConnection === null && availability === "checking")
                    ? "bg-warning/60 duration-2000"
                    : null
                }
                tooltipText={
                  savedConnection
                    ? savedConnection.statusText
                    : availability === "online"
                      ? "릴레이 온라인"
                      : availability === "offline"
                        ? "릴레이 오프라인"
                        : availability === "checking"
                          ? "릴레이 상태 확인 중"
                          : "릴레이 상태를 확인할 수 없음"
                }
              />
              <p className="truncate text-sm font-medium">{environment.label}</p>
            </div>
            <p
              className={cn(
                "mt-1 truncate text-xs",
                savedConnection?.tone === "error" ||
                  (savedConnection?.tone === "connecting" && savedEnvironment?.connection.error) ||
                  (savedConnection === null && availability === "error")
                  ? "text-destructive"
                  : "text-muted-foreground",
              )}
            >
              {statusText}
            </p>
          </div>
          {savedConnection ? (
            <Button size="sm" variant="outline" disabled>
              {savedConnection.buttonLabel}
            </Button>
          ) : (
            <Button
              size="sm"
              disabled={connectingEnvironmentId !== null}
              onClick={() => void connectEnvironment(environment)}
            >
              {connectingEnvironmentId === environment.environmentId ? "연결 중…" : "연결"}
            </Button>
          )}
        </div>
      </div>
    );
  });
}
