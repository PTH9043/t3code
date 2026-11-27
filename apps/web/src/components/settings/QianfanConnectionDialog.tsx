import {
  OpenCodeApiConnection,
  OPENCODE_API_KEY_ENV,
  ProviderDriverKind,
  ProviderInstanceId,
  type EnvironmentId,
  type ProviderInstanceConfig,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ExternalLinkIcon } from "lucide-react";
import { useState } from "react";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { randomUUID } from "../../lib/utils";
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

export const QIANFAN_BASE_URL = "https://qianfan.baidubce.com/v2";

const decodeConnection = Schema.decodeSync(OpenCodeApiConnection);
const decodeExistingConnection = Schema.decodeUnknownOption(
  Schema.Struct({ apiConnection: OpenCodeApiConnection }),
);

/** Splits the comma- or newline-separated model field into unique model names. */
export function parseQianfanModels(text: string): ReadonlyArray<string> {
  return [
    ...new Set(
      text
        .split(/[,\n]/)
        .map((model) => model.trim())
        .filter(Boolean),
    ),
  ];
}

/**
 * Registers or edits a Baidu Qianfan (千帆) API account as an API-connected account, so
 * it can be picked as the "잡일용 하위 API" of a Claude or Codex account.
 */
export function QianfanConnectionDialog({
  open,
  environmentId,
  onOpenChange,
  onBack,
  existingInstanceId,
  existingInstance,
}: {
  readonly open: boolean;
  readonly environmentId: EnvironmentId;
  readonly onOpenChange: (open: boolean) => void;
  readonly onBack?: () => void;
  readonly existingInstanceId?: ProviderInstanceId;
  readonly existingInstance?: ProviderInstanceConfig;
}) {
  const isEditing = Boolean(existingInstanceId && existingInstance);
  const existingConn = existingInstance
    ? Option.getOrUndefined(decodeExistingConnection(existingInstance.config))?.apiConnection
    : undefined;
  const hasExistingKey = Boolean(
    existingInstance?.environment?.some((entry) => entry.name === OPENCODE_API_KEY_ENV),
  );
  const update = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const [saving, setSaving] = useState(false);
  const [instanceId] = useState(
    () => existingInstanceId ?? ProviderInstanceId.make(`qianfan_${randomUUID()}`),
  );
  const [displayName, setDisplayName] = useState(existingInstance?.displayName ?? "바이두 Qianfan");
  const [models, setModels] = useState(existingConn?.models.join(", ") ?? "");
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const modelNames = parseQianfanModels(models);
  const canSave =
    !!displayName.trim() &&
    modelNames.length > 0 &&
    (!!apiKey.trim() || (isEditing && hasExistingKey));
  const submit = async () => {
    if (!canSave || saving) return;
    if (apiKey.trim().startsWith("sk-or-v1-")) {
      setError("OpenRouter 키를 입력했습니다. 바이두 Qianfan 콘솔에서 발급한 API 키를 입력하세요.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const connection = decodeConnection({
        providerId: "t3_qianfan",
        baseUrl: QIANFAN_BASE_URL,
        protocol: "chat-completions",
        models: modelNames,
      });
      const baseInstance: ProviderInstanceConfig = existingInstance
        ? { ...existingInstance, displayName: displayName.trim(), enabled: true }
        : {
            driver: ProviderDriverKind.make("opencode"),
            enabled: true,
            displayName: displayName.trim(),
          };
      const instance = withOpenCodeApiConnection(baseInstance, connection, apiKey);
      const receipt = await update({
        environmentId,
        input: { patch: { providerInstancesToUpsert: { [instanceId]: instance } } },
      });
      if (receipt._tag !== "Success") {
        setError(
          "이 실행 환경에 바이두 계정을 저장하지 못했습니다. 연결 상태를 확인하고 다시 시도하세요.",
        );
        return;
      }
      setApiKey("");
      toastManager.add({
        type: "success",
        title: isEditing
          ? "바이두 Qianfan 계정을 수정했습니다"
          : "바이두 Qianfan 계정을 등록했습니다",
        description: "일반 설정의 검색 모델 목록에서 계정과 모델을 선택하고 순서를 저장하세요.",
      });
      onOpenChange(false);
    } catch {
      setError("바이두 계정을 저장하지 못했습니다.");
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={(next) => !saving && onOpenChange(next)}>
      <DialogPopup className="max-w-lg overflow-hidden">
        <DialogHeader>
          <DialogTitle>
            {isEditing
              ? "바이두 Qianfan(千帆) API 계정 수정"
              : "바이두 Qianfan(千帆) API 계정 연결"}
          </DialogTitle>
          <DialogDescription>
            바이두 클라우드 콘솔에 로그인해 발급한 Qianfan API 키와 사용할 모델 이름을 입력하세요.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 px-6 py-5">
          <Button
            variant="outline"
            render={
              <a
                href="https://console.bce.baidu.com/qianfan/"
                target="_blank"
                rel="noopener noreferrer"
              />
            }
          >
            <ExternalLinkIcon /> Qianfan 콘솔 / API 키 발급
          </Button>
          <label className="grid gap-2 text-sm">
            계정 이름
            <Input value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
          </label>
          <label className="grid gap-2 text-sm">
            모델 이름
            <Input
              value={models}
              placeholder="콘솔에 표시된 모델 이름 (여러 개는 쉼표로 구분)"
              spellCheck={false}
              onChange={(event) => {
                setModels(event.target.value);
                setError(null);
              }}
            />
          </label>
          <label className="grid gap-2 text-sm">
            Qianfan API 키
            <Input
              type="password"
              autoComplete="off"
              value={apiKey}
              maxLength={4096}
              placeholder={
                isEditing && hasExistingKey ? "등록됨 · 비워 두면 기존 키 유지" : undefined
              }
              onChange={(event) => {
                setApiKey(event.target.value);
                setError(null);
              }}
            />
          </label>
          <p className="text-xs text-muted-foreground">
            주소는 {QIANFAN_BASE_URL} 로 고정됩니다. 저장할 때 연결을 시험하지 않으므로, 모델 이름과
            키가 틀리면 처음 사용할 때 오류가 납니다. 등록 후 계정 카드에서 고칠 수 있습니다.
          </p>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </div>
        <DialogFooter variant="bare">
          <Button
            disabled={saving}
            variant="outline"
            onClick={() => (onBack ? onBack() : onOpenChange(false))}
          >
            {onBack ? "이전" : "취소"}
          </Button>
          <Button disabled={!canSave || saving} onClick={submit}>
            {saving ? "저장 중" : isEditing ? "수정 저장" : "등록"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
