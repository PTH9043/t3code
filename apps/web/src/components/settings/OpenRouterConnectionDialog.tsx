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

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

export const OPENROUTER_RECOMMENDED_SEARCH_MODELS = [
  "perplexity/sonar",
  "perplexity/sonar-pro",
  "openai/gpt-4o-mini:online",
  "google/gemini-2.5-flash:online",
  "baidu/ernie-4.5-8b",
  "baidu/ernie-4.5-300b-a47b:online",
] as const;

const decodeConnection = Schema.decodeSync(OpenCodeApiConnection);
const decodeExistingConnection = Schema.decodeUnknownOption(
  Schema.Struct({ apiConnection: OpenCodeApiConnection }),
);

export function parseOpenRouterModels(text: string): ReadonlyArray<string> {
  return [
    ...new Set(
      text
        .split(/[,\n]/)
        .map((model) => model.trim())
        .filter(Boolean),
    ),
  ];
}

export function OpenRouterConnectionDialog({
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
    () => existingInstanceId ?? ProviderInstanceId.make(`openrouter_${randomUUID()}`),
  );
  const [displayName, setDisplayName] = useState(existingInstance?.displayName ?? "OpenRouter");
  const [models, setModels] = useState(
    existingConn?.models.length
      ? existingConn.models.join(", ")
      : "perplexity/sonar, openai/gpt-4o-mini:online",
  );
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const modelNames = parseOpenRouterModels(models);
  const canSave =
    !!displayName.trim() &&
    modelNames.length > 0 &&
    (!!apiKey.trim() || (isEditing && hasExistingKey));

  const toggleRecommended = (modelId: string) => {
    const current = parseOpenRouterModels(models);
    const next = current.includes(modelId)
      ? current.filter((item) => item !== modelId)
      : [...current, modelId];
    setModels(next.join(", "));
    setError(null);
  };

  const submit = async () => {
    if (!canSave || saving) return;
    setSaving(true);
    setError(null);
    try {
      const connection = decodeConnection({
        providerId: "t3_openrouter",
        baseUrl: OPENROUTER_BASE_URL,
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
          "이 실행 환경에 OpenRouter 계정을 저장하지 못했습니다. 연결 상태를 확인하고 다시 시도하세요.",
        );
        return;
      }
      setApiKey("");
      toastManager.add({
        type: "success",
        title: isEditing ? "OpenRouter 계정을 수정했습니다" : "OpenRouter 계정을 등록했습니다",
        description: "검색용 모델 목록에서 모델 ID를 선택하거나 직접 수정한 뒤 저장하세요.",
      });
      onOpenChange(false);
    } catch {
      setError("OpenRouter 계정을 저장하지 못했습니다.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !saving && onOpenChange(next)}>
      <DialogPopup className="max-w-lg overflow-hidden">
        <DialogHeader>
          <DialogTitle>
            {isEditing ? "OpenRouter API 계정 수정" : "OpenRouter API 계정 연결"}
          </DialogTitle>
          <DialogDescription>
            바이두 Qianfan 계정이 없어도 OpenRouter API 키 하나로 Perplexity Sonar, GPT, Gemini,
            ERNIE 등 웹 검색 지원 모델을 사용할 수 있습니다.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 px-6 py-5">
          <Button
            variant="outline"
            render={
              <a href="https://openrouter.ai/keys" target="_blank" rel="noopener noreferrer" />
            }
          >
            <ExternalLinkIcon /> OpenRouter API 키 발급
          </Button>
          <label className="grid gap-2 text-sm">
            계정 이름
            <Input value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
          </label>
          <label className="grid gap-2 text-sm">
            기본 검색 모델 목록
            <Input
              value={models}
              placeholder="예: perplexity/sonar, openai/gpt-4o-mini:online (쉼표로 구분)"
              spellCheck={false}
              onChange={(event) => {
                setModels(event.target.value);
                setError(null);
              }}
            />
          </label>
          <div className="flex flex-wrap gap-1.5">
            {OPENROUTER_RECOMMENDED_SEARCH_MODELS.map((preset) => {
              const active = modelNames.includes(preset);
              return (
                <Button
                  key={preset}
                  type="button"
                  size="sm"
                  variant={active ? "secondary" : "outline"}
                  onClick={() => toggleRecommended(preset)}
                >
                  {active ? "✓ " : "+ "}
                  {preset}
                </Button>
              );
            })}
          </div>
          <label className="grid gap-2 text-sm">
            OpenRouter API 키
            <Input
              type="password"
              autoComplete="off"
              value={apiKey}
              maxLength={4096}
              placeholder={
                isEditing && hasExistingKey ? "등록됨 · 비워 두면 기존 키 유지" : "sk-or-v1-..."
              }
              onChange={(event) => {
                setApiKey(event.target.value);
                setError(null);
              }}
            />
          </label>
          <p className="text-xs text-muted-foreground">
            주소는 {OPENROUTER_BASE_URL} 로 고정됩니다. 일반 모델은 자동으로 OpenRouter 웹 검색
            플러그인(<code>web</code>)을 켜서 호출하며, <code>:online</code>이나{" "}
            <code>perplexity/sonar</code> 모델은 자체 검색을 사용합니다.
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
