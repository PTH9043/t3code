import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import {
  CLAUDE_API_KEY_ENV,
  CLAUDE_API_WORKSPACE_ENV,
  ProviderDriverKind,
  ProviderInstanceId,
  type EnvironmentId,
} from "@t3tools/contracts";
import { ExternalLinkIcon, LoaderIcon } from "lucide-react";
import { useState } from "react";
import { randomUUID } from "../../lib/utils";
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
import { Input } from "../ui/input";
import { toastManager } from "../ui/toast";

export function buildClaudeApiInstance(displayName: string, apiKey: string, workspaceId = "") {
  if (!displayName.trim() || !apiKey.trim()) throw new Error("연결 이름과 API 키를 입력하세요.");
  if (workspaceId.trim() && !/^wrkspc_[A-Za-z0-9_-]{1,128}$/.test(workspaceId.trim()))
    throw new Error("워크스페이스 ID 형식을 확인하세요.");
  return {
    driver: ProviderDriverKind.make("claudeAgent"),
    displayName: displayName.trim(),
    enabled: true,
    config: { authMode: "api-key" },
    environment: [
      { name: CLAUDE_API_KEY_ENV, value: apiKey.trim(), sensitive: true },
      ...(workspaceId.trim()
        ? [{ name: CLAUDE_API_WORKSPACE_ENV, value: workspaceId.trim(), sensitive: false }]
        : []),
    ],
  };
}

export function ClaudeApiConnectionDialog({
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
  const [instanceId] = useState(() => ProviderInstanceId.make(`claude_api_${randomUUID()}`));
  const [displayName, setDisplayName] = useState("Claude API");
  const [apiKey, setApiKey] = useState("");
  const [workspaceId, setWorkspaceId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const workspaceValid =
    !workspaceId.trim() || /^wrkspc_[A-Za-z0-9_-]{1,128}$/.test(workspaceId.trim());
  const canSave = Boolean(displayName.trim() && apiKey.trim()) && workspaceValid && !busy;

  const submit = async () => {
    if (!canSave) return;
    setBusy(true);
    setError(null);
    try {
      const instance = buildClaudeApiInstance(displayName, apiKey, workspaceId);
      const result = await update({
        environmentId,
        input: { patch: { providerInstancesToUpsert: { [instanceId]: instance } } },
      });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) setError("Claude API 연결을 저장하지 못했습니다.");
        return;
      }
      setApiKey("");
      toastManager.add({ type: "success", title: "Claude API 연결을 추가했습니다" });
      onOpenChange(false);
    } catch {
      setError("Claude API 연결을 저장하지 못했습니다.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogPopup className="max-w-lg overflow-hidden">
        <DialogHeader>
          <DialogTitle>Claude API 크레딧 연결</DialogTitle>
          <DialogDescription>
            크레딧이 있는 Claude Console 조직의 API 키로 별도 연결을 추가합니다.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 px-6 py-5">
          <Button
            variant="outline"
            render={
              <a
                href="https://platform.claude.com/settings/keys"
                target="_blank"
                rel="noopener noreferrer"
              />
            }
          >
            <ExternalLinkIcon /> Claude API 키 발급
          </Button>
          <label className="grid gap-2 text-sm">
            연결 이름
            <Input
              value={displayName}
              disabled={busy}
              onChange={(event) => setDisplayName(event.target.value)}
            />
          </label>
          <label className="grid gap-2 text-sm">
            Claude Console API 키
            <Input
              type="password"
              autoComplete="off"
              maxLength={4096}
              value={apiKey}
              disabled={busy}
              onChange={(event) => {
                setApiKey(event.target.value);
                setError(null);
              }}
            />
          </label>
          <label className="grid gap-2 text-sm">
            워크스페이스 ID (조직 전체 키를 사용하는 경우)
            <Input
              value={workspaceId}
              disabled={busy}
              placeholder="wrkspc_..."
              onChange={(event) => {
                setWorkspaceId(event.target.value);
                setError(null);
              }}
            />
          </label>
          <p className="text-xs text-muted-foreground">
            특정 워크스페이스에 연결된 키라면 ID를 입력하지 않아도 됩니다.
          </p>
          {!workspaceValid ? (
            <p role="alert" className="text-sm text-destructive">
              워크스페이스 ID 형식을 확인하세요.
            </p>
          ) : null}
          <p className="text-xs text-muted-foreground">
            기존 Claude 구독 계정과 선택한 모델은 바뀌지 않습니다. 새 연결을 선택한 요청만 API를
            사용합니다. 키의 유효성은 실제 요청에서 확인됩니다. 키는 서버의 로컬 비밀 저장소에
            보관되며, Windows 서버에서는 해당 Windows 사용자 계정으로 암호화됩니다.
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
            {busy ? "저장 중" : "연결 추가"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
