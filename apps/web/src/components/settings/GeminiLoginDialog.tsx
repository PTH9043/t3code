import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { ExternalLinkIcon, LoaderIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Gemini } from "../Icons";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { toastManager } from "../ui/toast";

interface GeminiLoginDialogProps {
  readonly open: boolean;
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly displayName: string;
  readonly onAuthenticated: () => void;
  readonly onOpenChange: (open: boolean) => void;
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Google 로그인을 완료하지 못했습니다.";
}

export function GeminiLoginDialog({
  open,
  environmentId,
  instanceId,
  displayName,
  onAuthenticated,
  onOpenChange,
}: GeminiLoginDialogProps) {
  const beginAuth = useAtomCommand(serverEnvironment.beginGeminiAuth, { reportFailure: false });
  const completeAuth = useAtomCommand(serverEnvironment.completeGeminiAuth, {
    reportFailure: false,
  });
  const cancelAuth = useAtomCommand(serverEnvironment.cancelGeminiAuth, {
    reportFailure: false,
  });
  const activeRef = useRef(true);
  const sessionIdRef = useRef<string | null>(null);
  const [authorizationUrl, setAuthorizationUrl] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isStarting, setIsStarting] = useState(false);
  const [isCompleting, setIsCompleting] = useState(false);

  const cancelCurrentSession = useCallback(() => {
    const sessionId = sessionIdRef.current;
    sessionIdRef.current = null;
    if (!sessionId) return;
    void cancelAuth({ environmentId, input: { sessionId } });
  }, [cancelAuth, environmentId]);

  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
      cancelCurrentSession();
    };
  }, [cancelCurrentSession]);

  const start = async () => {
    setIsStarting(true);
    setError(null);
    const result = await beginAuth({ environmentId, input: { instanceId } });
    if (!activeRef.current) {
      if (result._tag === "Success") {
        void cancelAuth({ environmentId, input: { sessionId: result.value.sessionId } });
      }
      return;
    }
    setIsStarting(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        setError(failureMessage(squashAtomCommandFailure(result)));
      }
      return;
    }
    sessionIdRef.current = result.value.sessionId;
    setAuthorizationUrl(result.value.authorizationUrl);
  };

  const complete = async () => {
    const sessionId = sessionIdRef.current;
    if (!sessionId || !code.trim()) return;
    setIsCompleting(true);
    setError(null);
    const result = await completeAuth({
      environmentId,
      input: { sessionId, code: code.trim() },
    });
    if (!activeRef.current) return;
    setIsCompleting(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        setError(failureMessage(squashAtomCommandFailure(result)));
      }
      cancelCurrentSession();
      setAuthorizationUrl(null);
      setCode("");
      return;
    }
    sessionIdRef.current = null;
    toastManager.add({
      type: "success",
      title: "Google 계정을 연결했습니다",
      description: result.value.email
        ? `${result.value.email} 계정으로 Gemini를 사용할 수 있습니다.`
        : `${displayName} 계정으로 Gemini를 사용할 수 있습니다.`,
    });
    onAuthenticated();
    onOpenChange(false);
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) cancelCurrentSession();
    onOpenChange(nextOpen);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogPopup className="max-w-lg overflow-hidden">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Gemini className="size-4" aria-hidden />
            Google로 Gemini 연결
          </DialogTitle>
          <DialogDescription>
            {displayName} 전용 Google 로그인을 시작합니다. Gmail이나 Drive 데이터 연동이 아니라,
            Gemini CLI가 요청하는 Google 계정 및 Google Cloud 권한으로 인증합니다.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 bg-zinc-25/80 px-6 py-5 ring-1 ring-black/5 dark:bg-white/2 dark:ring-white/5">
          {authorizationUrl === null ? (
            <div className="space-y-3">
              <p className="text-sm leading-relaxed text-muted-foreground">
                계정별 인증 정보는 이 실행 환경 안의 분리된 Gemini 홈에 저장됩니다. 다른 Gemini
                계정의 로그인과 세션에는 영향을 주지 않습니다.
              </p>
              <Button type="button" className="w-full" disabled={isStarting} onClick={start}>
                {isStarting ? <LoaderIcon className="animate-spin" /> : <Gemini />}
                {isStarting ? "로그인 준비 중" : "Google 로그인 시작"}
              </Button>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="rounded-lg border border-border/70 bg-background p-3">
                <p className="text-sm font-medium text-foreground">
                  1. Google에서 계정을 선택하세요
                </p>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  아래 버튼은 현재 브라우저에서 Google 공식 로그인 페이지를 엽니다.
                </p>
                <Button
                  type="button"
                  variant="outline"
                  className="mt-3 w-full"
                  onClick={() => window.open(authorizationUrl, "_blank", "noopener,noreferrer")}
                >
                  <ExternalLinkIcon />
                  Google 로그인 페이지 열기
                </Button>
              </div>
              <label className="grid gap-2">
                <span className="text-sm font-medium text-foreground">
                  2. Google이 표시한 인증 코드
                </span>
                <Input
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                  placeholder="인증 코드를 붙여 넣으세요"
                  autoComplete="one-time-code"
                  disabled={isCompleting}
                />
                <span className="text-xs text-muted-foreground">
                  인증 코드는 이 로그인 세션에 한 번만 사용되며 T3 Code 설정에 저장되지 않습니다.
                </span>
              </label>
            </div>
          )}

          {error ? (
            <p
              role="alert"
              className="rounded-lg bg-destructive/8 px-3 py-2 text-sm text-destructive"
            >
              {error}
            </p>
          ) : null}
        </div>

        <DialogFooter variant="bare">
          <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
            취소
          </Button>
          {authorizationUrl !== null ? (
            <Button type="button" disabled={!code.trim() || isCompleting} onClick={complete}>
              {isCompleting ? <LoaderIcon className="animate-spin" /> : <Gemini />}
              {isCompleting ? "연결 확인 중" : "Google 계정 연결"}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
