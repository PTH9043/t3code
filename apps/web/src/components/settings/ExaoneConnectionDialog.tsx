import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { ProviderDriverKind, ProviderInstanceId, type EnvironmentId } from "@t3tools/contracts";
import { LoaderIcon } from "lucide-react";
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
import { withOpenCodeApiConnection } from "./OpenCodeApiSettings";

export function buildExaoneInstance(displayName: string, apiKey: string) {
  if (!displayName.trim() || !apiKey.trim()) throw new Error("계정 이름과 API 키를 입력하세요.");
  return withOpenCodeApiConnection(
    { driver: ProviderDriverKind.make("opencode"), displayName: displayName.trim(), enabled: true },
    {
      providerId: "t3_exaone",
      baseUrl: "https://api.exaone.ai/v1",
      protocol: "chat-completions",
      models: ["k-exaone_v2.5"],
      contextTokens: 524288,
      outputTokens: 32000,
    },
    apiKey,
  );
}

export function ExaoneConnectionDialog({
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
  const update = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const [instanceId] = useState(() => ProviderInstanceId.make(`exaone_${randomUUID()}`));
  const [displayName, setDisplayName] = useState("EXAONE");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canSave = !!displayName.trim() && !!apiKey.trim() && !busy;

  const submit = async () => {
    if (!canSave) return;
    setBusy(true);
    setError(null);
    try {
      const instance = buildExaoneInstance(displayName, apiKey);
      const result = await update({
        environmentId,
        input: { patch: { providerInstancesToUpsert: { [instanceId]: instance } } },
      });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          const cause = squashAtomCommandFailure(result);
          setError(cause instanceof Error ? cause.message : "EXAONE 계정을 저장하지 못했습니다.");
        }
        return;
      }
      setApiKey("");
      toastManager.add({ type: "success", title: "EXAONE 계정을 추가했습니다" });
      onOpenChange(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "EXAONE 계정을 저장하지 못했습니다.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogPopup className="max-w-lg overflow-hidden">
        <DialogHeader>
          <DialogTitle>EXAONE 계정 연결</DialogTitle>
          <DialogDescription>
            EXAONE API 키를 별도의 OpenCode 계정으로 저장합니다.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 px-6 py-5">
          <label className="grid gap-2 text-sm">
            계정 이름
            <Input
              value={displayName}
              disabled={busy}
              onChange={(event) => setDisplayName(event.target.value)}
            />
          </label>
          <label className="grid gap-2 text-sm">
            EXAONE API 키
            <Input
              type="password"
              autoComplete="new-password"
              maxLength={4096}
              value={apiKey}
              disabled={busy}
              onChange={(event) => setApiKey(event.target.value)}
            />
          </label>
          <p className="text-xs text-muted-foreground">
            K-EXAONE 2.5를 선택할 수 있습니다. 키의 유효성은 실제 사용 시 확인됩니다. 키는 서버의
            민감 환경 변수로 저장되며 로컬 설정 파일은 암호화되지 않습니다.
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
            disabled={busy}
            onClick={() => (onBack ? onBack() : onOpenChange(false))}
          >
            {onBack ? "이전" : "취소"}
          </Button>
          <Button disabled={!canSave} onClick={submit}>
            {busy ? <LoaderIcon className="animate-spin" /> : null}
            {busy ? "저장 중" : "계정 추가"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
