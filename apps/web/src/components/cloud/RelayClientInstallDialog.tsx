import { DownloadIcon } from "lucide-react";
import { useSyncExternalStore } from "react";
import type { RelayClientInstallProgressStage } from "@t3tools/contracts";

import {
  completeRelayClientInstallDialogClose,
  readRelayClientInstallDialogState,
  respondToRelayClientInstallConfirmation,
  subscribeRelayClientInstallDialog,
} from "../../cloud/relayClientInstallDialog";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
const installSteps: ReadonlyArray<{
  readonly stage: RelayClientInstallProgressStage;
  readonly label: string;
}> = [
  { stage: "checking", label: "현재 설치 상태 확인 중" },
  { stage: "waiting_for_lock", label: "설치 프로그램 대기 중" },
  { stage: "downloading", label: "릴레이 클라이언트 다운로드 중" },
  { stage: "verifying", label: "다운로드 확인 중" },
  { stage: "installing", label: "릴레이 클라이언트 설치 중" },
  { stage: "validating", label: "실행 파일 확인 중" },
  { stage: "activating", label: "설치 활성화 중" },
];

export function RelayClientInstallDialog() {
  const state = useSyncExternalStore(
    subscribeRelayClientInstallDialog,
    readRelayClientInstallDialogState,
    readRelayClientInstallDialogState,
  );
  const view = state.status === "closing" ? state.view : state;
  const isConfirming = view.status === "confirming";
  const isInstalling = view.status === "installing";
  const activeStepIndex = isInstalling
    ? installSteps.findIndex(({ stage }) => stage === view.stage)
    : -1;
  const activeStep = installSteps[activeStepIndex];

  return (
    <Dialog
      open={state.status === "confirming" || state.status === "installing"}
      onOpenChange={(open) => {
        if (!open && isConfirming) {
          respondToRelayClientInstallConfirmation(false);
        }
      }}
      onOpenChangeComplete={(open) => {
        if (!open) {
          completeRelayClientInstallDialogClose();
        }
      }}
    >
      <DialogPopup className="max-w-md" showCloseButton={isConfirming}>
        <DialogHeader>
          <div className="flex size-9 items-center justify-center rounded-lg border border-border/70 bg-muted/60">
            <DownloadIcon aria-hidden className="size-4.5 text-muted-foreground" />
          </div>
          <DialogTitle>
            {isInstalling ? "릴레이 클라이언트 설치 중" : "릴레이 클라이언트를 설치할까요?"}
          </DialogTitle>
          <DialogDescription>
            {isInstalling
              ? "T3 Connect를 통해 이 실행 환경에 안전하게 접근할 수 있도록 준비하고 있습니다."
              : "이 실행 환경을 T3 Connect에서 사용하려면 릴레이 클라이언트가 필요합니다."}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel scrollFade={false}>
          {isInstalling ? (
            <div className="space-y-2.5">
              <div className="flex items-center justify-between gap-3 text-sm">
                <p aria-live="polite" className="font-medium text-foreground">
                  {activeStep?.label}
                </p>
                <p className="shrink-0 tabular-nums text-muted-foreground">
                  {installSteps.length}단계 중 {activeStepIndex + 1}단계
                </p>
              </div>
              <progress
                aria-label="릴레이 클라이언트 설치 진행률"
                className="h-2 w-full appearance-none overflow-hidden rounded-full bg-muted [&::-moz-progress-bar]:rounded-full [&::-moz-progress-bar]:bg-primary [&::-webkit-progress-bar]:rounded-full [&::-webkit-progress-bar]:bg-muted [&::-webkit-progress-value]:rounded-full [&::-webkit-progress-value]:bg-primary"
                max={installSteps.length}
                value={activeStepIndex + 1}
              />
              <p className="text-xs leading-relaxed text-muted-foreground">
                릴레이 클라이언트를 설치하는 동안 T3 Code를 열어 두세요.
              </p>
            </div>
          ) : (
            <div className="rounded-xl border border-border/70 bg-muted/35 p-3">
              <p className="text-sm font-medium text-foreground">관리형 릴레이 클라이언트</p>
              <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                T3 Code가 버전 {view.status === "confirming" ? view.version : ""}을(를) 이 컴퓨터에
                다운로드하고 설치합니다.
              </p>
            </div>
          )}
        </DialogPanel>
        {isConfirming ? (
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => respondToRelayClientInstallConfirmation(false)}
            >
              취소
            </Button>
            <Button onClick={() => respondToRelayClientInstallConfirmation(true)}>
              다운로드 및 설치
            </Button>
          </DialogFooter>
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}
