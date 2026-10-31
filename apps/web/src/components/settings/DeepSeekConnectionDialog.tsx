import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { ProviderInstanceId, type EnvironmentId } from "@t3tools/contracts";
import { ExternalLinkIcon, LoaderIcon } from "lucide-react";
import { useState } from "react";
import { serverEnvironment } from "../../state/server";
import { randomUUID } from "../../lib/utils";
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
import { Input } from "../ui/input";
import { toastManager } from "../ui/toast";

export function DeepSeekConnectionDialog({
  open,
  environmentId,
  onOpenChange,
  onBack,
}: {
  readonly open: boolean;
  readonly environmentId: EnvironmentId;
  readonly onOpenChange: (open: boolean) => void;
  readonly onBack?: () => void;
}) {
  const connect = useAtomCommand(serverEnvironment.connectDeepSeek, { reportFailure: false });
  const [instanceId] = useState(() => ProviderInstanceId.make(`deepseek_${randomUUID()}`));
  const [displayName, setDisplayName] = useState("DeepSeek");
  const [apiKey, setApiKey] = useState("");
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canConnect = !!displayName.trim() && !!apiKey.trim() && !isConnecting;
  const submit = async () => {
    if (!canConnect) return;
    setIsConnecting(true);
    setError(null);
    const result = await connect({
      environmentId,
      input: { instanceId, displayName: displayName.trim(), apiKey: apiKey.trim() },
    });
    setIsConnecting(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const cause = squashAtomCommandFailure(result);
        setError(cause instanceof Error ? cause.message : "DeepSeek 계정을 연결하지 못했습니다.");
      }
      return;
    }
    setApiKey("");
    toastManager.add({
      type: "success",
      title: "DeepSeek 계정을 연결했습니다",
      description: `${result.value.models.length}개 모델을 기존 대화창에서 선택할 수 있습니다.`,
    });
    onOpenChange(false);
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!isConnecting) onOpenChange(next);
      }}
    >
      <DialogPopup className="max-w-lg overflow-hidden">
        <DialogHeader>
          <DialogTitle>DeepSeek 계정 연결</DialogTitle>
          <DialogDescription>
            DeepSeek API 플랫폼 계정의 API 키로 연결합니다. 연결을 확인한 뒤 계정을 저장합니다.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 px-6 py-5">
          <Button
            variant="outline"
            render={
              <a
                href="https://platform.deepseek.com/api_keys"
                target="_blank"
                rel="noopener noreferrer"
              />
            }
          >
            <ExternalLinkIcon /> DeepSeek 로그인 / API 키 발급
          </Button>
          <label className="grid gap-2 text-sm">
            계정 이름
            <Input
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              disabled={isConnecting}
            />
          </label>
          <label className="grid gap-2 text-sm">
            DeepSeek API 키
            <Input
              type="password"
              autoComplete="off"
              value={apiKey}
              maxLength={4096}
              placeholder="sk-…"
              disabled={isConnecting}
              onChange={(event) => {
                setApiKey(event.target.value);
                setError(null);
              }}
            />
          </label>
          <p className="text-xs text-muted-foreground">
            연결하면 DeepSeek 모델이 현재 대화창의 모델 목록에 나타납니다. 계정을 여러 개 연결하거나
            설정에서 해제할 수 있습니다.
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
            disabled={isConnecting}
            onClick={() => (onBack ? onBack() : onOpenChange(false))}
          >
            {onBack ? "이전" : "취소"}
          </Button>
          <Button disabled={!canConnect} onClick={submit}>
            {isConnecting ? <LoaderIcon className="animate-spin" /> : null}
            {isConnecting ? "연결 확인 중" : "확인하고 연결"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
