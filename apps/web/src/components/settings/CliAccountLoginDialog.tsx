import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { LoaderIcon } from "lucide-react";
import { useState } from "react";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { toastManager } from "../ui/toast";

const DRIVER_LABEL: Record<string, string> = {
  codex: "Codex",
  claudeAgent: "Claude",
  cursor: "Cursor",
  grok: "Grok",
  gemini: "Gemini",
  opencode: "OpenCode",
};

export function CliAccountLoginDialog({
  open,
  environmentId,
  driver,
  onOpenChange,
  onBack,
}: {
  readonly open: boolean;
  readonly environmentId: EnvironmentId;
  readonly driver: "codex" | "claudeAgent" | "cursor" | "grok" | "gemini" | "opencode";
  readonly onOpenChange: (open: boolean) => void;
  readonly onBack?: () => void;
}) {
  const login = useAtomCommand(serverEnvironment.loginProviderAccount, { reportFailure: false });
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setIsLoggingIn(true);
    setError(null);
    const result = await login({
      environmentId,
      input: { driver },
    });
    setIsLoggingIn(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const cause = squashAtomCommandFailure(result);
        setError(cause instanceof Error ? cause.message : "로그인을 완료하지 못했습니다.");
      }
      return;
    }
    toastManager.add({
      type: "success",
      title: `${DRIVER_LABEL[driver]} 계정을 로그인했습니다`,
      description: `${result.value.email ?? result.value.instanceId}이(가) 새 인스턴스로 등록되었습니다.`,
    });
    onOpenChange(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!isLoggingIn) onOpenChange(next);
      }}
    >
      <DialogPopup className="max-w-lg overflow-hidden">
        <DialogHeader>
          <DialogTitle>{DRIVER_LABEL[driver]} 계정 추가</DialogTitle>
          <DialogDescription>
            버튼을 누르면 기본 브라우저에서 {DRIVER_LABEL[driver]} 로그인 페이지가 열립니다. 거기서
            Google 계정으로 로그인하면 인증 정보가 이 인스턴스 전용 홈에 저장됩니다.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 px-6 py-5">
          <p className="text-xs text-muted-foreground">
            로그인이 끝나면 이 창으로 돌아올 필요 없이 자동으로 계정이 등록됩니다.
          </p>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </div>
        <DialogFooter variant="bare">
          <Button
            variant="outline"
            disabled={isLoggingIn}
            onClick={() => (onBack ? onBack() : onOpenChange(false))}
          >
            {onBack ? "이전" : "취소"}
          </Button>
          <Button disabled={isLoggingIn} onClick={submit}>
            {isLoggingIn ? <LoaderIcon className="animate-spin" /> : null}
            {isLoggingIn ? "로그인 대기 중" : "브라우저 로그인 시작"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
