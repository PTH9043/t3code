import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { ProviderDriverKind, ProviderInstanceId, type EnvironmentId } from "@t3tools/contracts";
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
import { withOpenCodeApiConnection } from "./OpenCodeApiSettings";

export type GlmAccountType = "standard" | "coding";

/** Preserve the account and model choices supplied by the user. */
export function buildGlmInstance(input: {
  accountType: GlmAccountType;
  displayName: string;
  models: string;
  apiKey: string;
}) {
  const displayName = input.displayName.trim();
  const apiKey = input.apiKey.trim();
  const models = [
    ...new Set(
      input.models
        .split(/[,\n]/)
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];
  if (
    (input.accountType !== "coding" && input.accountType !== "standard") ||
    !displayName ||
    !apiKey ||
    models.length === 0
  )
    throw new Error("계정 이름, API 키와 사용할 모델 ID를 입력하세요.");
  return withOpenCodeApiConnection(
    { driver: ProviderDriverKind.make("opencode"), displayName, enabled: true },
    {
      providerId: "t3_glm",
      baseUrl:
        input.accountType === "coding"
          ? "https://api.z.ai/api/coding/paas/v4"
          : "https://api.z.ai/api/paas/v4",
      protocol: "chat-completions",
      models,
    },
    apiKey,
  );
}

export function GlmConnectionDialog({
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
  const [instanceId] = useState(() => ProviderInstanceId.make(`glm_${randomUUID()}`));
  const [displayName, setDisplayName] = useState("GLM");
  const [accountType, setAccountType] = useState<GlmAccountType | "">("");
  const [models, setModels] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canSave =
    !!accountType && !!displayName.trim() && !!models.trim() && !!apiKey.trim() && !busy;

  const submit = async () => {
    if (!canSave || !accountType) return;
    setBusy(true);
    setError(null);
    try {
      const instance = buildGlmInstance({ accountType, displayName, models, apiKey });
      const result = await update({
        environmentId,
        input: { patch: { providerInstancesToUpsert: { [instanceId]: instance } } },
      });
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          const cause = squashAtomCommandFailure(result);
          setError(cause instanceof Error ? cause.message : "GLM 계정을 저장하지 못했습니다.");
        }
        return;
      }
      setApiKey("");
      toastManager.add({
        type: "success",
        title: "GLM 계정을 추가했습니다",
        description: "선택한 모델은 연결된 OpenCode에서 사용합니다.",
      });
      onOpenChange(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "GLM 계정을 저장하지 못했습니다.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogPopup className="max-w-lg overflow-hidden">
        <DialogHeader>
          <DialogTitle>GLM 계정 연결</DialogTitle>
          <DialogDescription>Z.AI API 키와 모델을 OpenCode 계정으로 연결합니다.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 px-6 py-5">
          <Button
            variant="outline"
            render={
              <a
                href="https://z.ai/manage-apikey/apikey-list"
                target="_blank"
                rel="noopener noreferrer"
              />
            }
          >
            <ExternalLinkIcon /> Z.AI API 키 관리
          </Button>
          <label className="grid gap-2 text-sm">
            계정 이름
            <Input
              value={displayName}
              disabled={busy}
              onChange={(event) => setDisplayName(event.target.value)}
            />
          </label>
          <label className="grid gap-2 text-sm">
            API 계정 유형
            <select
              value={accountType}
              disabled={busy}
              className="rounded-md border border-input bg-background p-2"
              onChange={(event) => setAccountType(event.target.value as GlmAccountType | "")}
            >
              <option value="">사용 중인 유형을 선택하세요</option>
              <option value="coding">GLM Coding Plan</option>
              <option value="standard">일반 Z.AI API</option>
            </select>
          </label>
          <label className="grid gap-2 text-sm">
            사용할 모델 ID (쉼표로 구분)
            <Input
              value={models}
              disabled={busy}
              placeholder="예: glm-5.3"
              onChange={(event) => setModels(event.target.value)}
            />
          </label>
          <label className="grid gap-2 text-sm">
            Z.AI API 키
            <Input
              type="password"
              autoComplete="off"
              maxLength={4096}
              value={apiKey}
              disabled={busy}
              onChange={(event) => setApiKey(event.target.value)}
            />
          </label>
          <p className="text-xs text-muted-foreground">
            계정 유형에 맞는 키를 사용하세요. 연결 정보만 저장하며 API 키의 유효성과 사용 가능한
            모델은 실제 사용 전 확인하지 않습니다.
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
