import type { EnvironmentId, ServerSelfUpdateCapability } from "@t3tools/contracts";
import type { ServerUpdateStage, ServerUpdateState } from "@t3tools/client-runtime/state/server";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";

import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { manualServerUpdateCommand } from "~/versionSkew";
import { Button } from "./ui/button";
import { toastManager } from "./ui/toast";

// The wire "installing" stage is a sub-second launcher handoff, so the UI
// folds it into the download phase; everything after the handoff is the
// restart the user is actually waiting through.
const UPDATE_STAGE_LABELS: Record<ServerUpdateStage, string> = {
  downloading: "다운로드 중…",
  installing: "다운로드 중…",
  resuming: "다시 시작 중…",
};
const pendingUpdateEnvironmentIds = new Set<EnvironmentId>();

export function serverUpdateStageLabel(stage: ServerUpdateStage): string {
  return UPDATE_STAGE_LABELS[stage];
}

function updateFailureMessage(): string {
  return "서버 업데이트에 실패했습니다.";
}

/**
 * One-row status for an in-flight server update: "Downloading…" then
 * "Restarting…". The update is a wait, not a warning: a single pulsing dot
 * and label, no step rail, no versions. Failure turns the row red with the
 * rollback reason.
 */
export function ServerUpdateProgress({
  state,
}: {
  readonly state: Exclude<ServerUpdateState, { status: "idle" }>;
}) {
  if (state.status === "failed") {
    return (
      <div className="mt-1 flex min-w-0 items-center gap-2 text-xs text-destructive" role="alert">
        <span className="size-1.5 shrink-0 rounded-full bg-destructive" aria-hidden="true" />
        <span className="min-w-0 truncate" title="서버 업데이트에 실패했습니다.">
          서버 업데이트에 실패했습니다.
        </span>
      </div>
    );
  }
  return (
    <div className="mt-1 flex items-center gap-2 text-xs font-medium text-foreground">
      <span
        className="size-1.5 shrink-0 animate-status-pulse rounded-full bg-foreground"
        aria-hidden="true"
      />
      <span>{serverUpdateStageLabel(state.stage)}</span>
    </div>
  );
}

/**
 * Offers the update path advertised by a version-skewed server. Self-updates
 * delegate their full lifecycle to client-runtime so this component can
 * unmount during reconnect without losing operation state.
 */
export function ServerUpdateAction({
  environmentId,
  serverLabel,
  selfUpdate,
  targetVersion,
  label = "업데이트",
}: {
  readonly environmentId: EnvironmentId;
  readonly serverLabel: string;
  readonly selfUpdate: ServerSelfUpdateCapability | null;
  readonly targetVersion: string;
  readonly label?: string;
}) {
  const updateServer = useAtomCommand(serverEnvironment.updateServer, {
    reportFailure: false,
  });
  const { copyToClipboard } = useCopyToClipboard<{ command: string }>({
    target: "업데이트 명령",
    onCopy: ({ command }) => {
      toastManager.add({
        type: "success",
        title: "업데이트 명령을 복사했습니다",
        description: `${serverLabel}에서 \`${command}\` 명령을 실행해 업데이트하세요.`,
      });
    },
    onError: () => {
      toastManager.add({
        type: "error",
        title: "업데이트 명령을 복사하지 못했습니다",
        description: "클립보드 접근 권한을 확인한 뒤 다시 시도하세요.",
      });
    },
  });

  const handleUpdate = async () => {
    if (pendingUpdateEnvironmentIds.has(environmentId)) {
      return;
    }
    pendingUpdateEnvironmentIds.add(environmentId);
    try {
      const result = await updateServer({
        environmentId,
        input: { targetVersion },
      });
      if (result._tag === "Failure") {
        if (isAtomCommandInterrupted(result)) {
          return;
        }
        toastManager.add({
          type: "error",
          title: "서버 업데이트 실패",
          description: updateFailureMessage(),
        });
        return;
      }
      toastManager.add({
        type: "success",
        title: `${serverLabel} 업데이트 완료`,
        description: `t3@${result.value.targetVersion} 버전으로 다시 연결했습니다.`,
      });
    } finally {
      pendingUpdateEnvironmentIds.delete(environmentId);
    }
  };

  if (selfUpdate === "desktop-managed") {
    return (
      <span className="text-muted-foreground text-xs">
        이 서버를 업데이트하려면 해당 컴퓨터의 데스크톱 앱을 업데이트하세요.
      </span>
    );
  }

  if (selfUpdate === null) {
    const command = manualServerUpdateCommand(targetVersion);
    return (
      <Button size="xs" variant="outline" onClick={() => copyToClipboard(command, { command })}>
        업데이트 명령 복사
      </Button>
    );
  }

  return (
    <Button size="xs" onClick={() => void handleUpdate()}>
      {label}
    </Button>
  );
}
