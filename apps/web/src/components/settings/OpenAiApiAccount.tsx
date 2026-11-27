import {
  configureOpenAiApiAccount,
  isValidOpenAiApiModelId,
  OPENAI_API_CONNECTION,
  OPENAI_API_RECOMMENDED_MODELS,
  OpenCodeSettings,
  ProviderInstanceId,
  type EnvironmentId,
  type ProviderInstanceConfig,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import * as Schema from "effect/Schema";
import { useRef, useState } from "react";
import { cn, randomUUID } from "../../lib/utils";
import { useAtomCommand } from "../../state/use-atom-command";
import { serverEnvironment } from "../../state/server";
import { Button } from "../ui/button";
import { Dialog, DialogDescription, DialogHeader, DialogPopup, DialogTitle } from "../ui/dialog";
import { Input } from "../ui/input";

const decodeSettings = Schema.decodeUnknownSync(OpenCodeSettings);

function parseModelList(raw: string): string[] {
  return [
    ...new Set(
      raw
        .split(/[,\n]/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

export function OpenAiApiAccountForm({
  environmentId,
  instanceId,
  instance,
  save,
  onBack,
}: {
  readonly environmentId?: EnvironmentId;
  readonly instanceId?: ProviderInstanceId;
  readonly instance?: ProviderInstanceConfig;
  readonly save: (value: ProviderInstanceConfig) => void | Promise<void>;
  readonly onBack?: () => void;
}) {
  const [displayName, setDisplayName] = useState(instance?.displayName ?? "OpenAI API");
  const [models, setModels] = useState(
    decodeSettings(instance?.config ?? {}).apiConnection?.models.join(", ") ?? "",
  );
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [fetchedModels, setFetchedModels] = useState<ReadonlyArray<string>>([]);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [fetchError, setFetchError] = useState("");
  const [modelFilter, setModelFilter] = useState("");
  const listOpenAiModels = useAtomCommand(serverEnvironment.listOpenAiApiModels, {
    reportFailure: false,
  });

  const selectedModels = parseModelList(models);
  const selectedModelSet = new Set(selectedModels);
  const invalidModels = selectedModels.filter((model) => !isValidOpenAiApiModelId(model));
  const query = modelFilter.trim().toLowerCase();
  const filteredFetchedModels = query
    ? fetchedModels.filter((model) => model.toLowerCase().includes(query))
    : fetchedModels;

  const toggleModel = (modelId: string) => {
    const current = parseModelList(models).filter((item) => isValidOpenAiApiModelId(item));
    const next = current.includes(modelId)
      ? current.filter((item) => item !== modelId)
      : [...current, modelId];
    setModels(next.join(", "));
    setError("");
  };

  const fetchModels = async () => {
    if (!environmentId) return;
    setFetchingModels(true);
    setFetchError("");
    const result = await listOpenAiModels({
      environmentId,
      input: {
        ...(key.trim() ? { apiKey: key.trim() } : {}),
        ...(instanceId ? { instanceId } : {}),
      },
    });
    setFetchingModels(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const cause = squashAtomCommandFailure(result);
        setFetchError(
          cause instanceof Error ? cause.message : "OpenAI 모델 목록을 불러오지 못했습니다.",
        );
      }
      return;
    }
    setFetchedModels(result.value.models);
  };

  const submit = async () => {
    setBusy(true);
    try {
      await save(
        configureOpenAiApiAccount({
          displayName,
          models: models.split(/[,\n]/),
          apiKey: key,
          ...(instance ? { existing: instance } : {}),
        }),
      );
      if (!instance) {
        setDisplayName("OpenAI API");
        setModels("");
        setFetchedModels([]);
      }
      setKey("");
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "OpenAI API 계정을 저장하지 못했습니다.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="grid gap-3" aria-label="OpenAI API 계정">
      <label className="grid gap-1 text-sm">
        계정 이름
        <Input
          value={displayName}
          disabled={busy}
          onChange={(e) => setDisplayName(e.target.value)}
        />
      </label>
      <label className="grid gap-1 text-sm">
        OpenAI API 키
        <Input
          type="password"
          autoComplete="new-password"
          maxLength={4096}
          value={key}
          disabled={busy}
          placeholder={instance ? "비워 두면 저장된 키 유지" : "sk-... API 키 입력"}
          onChange={(e) => setKey(e.target.value)}
        />
      </label>
      <div className="grid gap-1.5 text-sm">
        <div className="flex items-center justify-between gap-2">
          <label htmlFor="openai-api-models-input" className="text-sm">
            API 모델 ID (쉼표로 구분)
          </label>
          {environmentId ? (
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={busy || fetchingModels || (!key.trim() && !instanceId)}
              onClick={fetchModels}
            >
              {fetchingModels ? "불러오는 중..." : "모델 목록 불러오기"}
            </Button>
          ) : null}
        </div>
        <Input
          id="openai-api-models-input"
          value={models}
          disabled={busy}
          spellCheck={false}
          placeholder="예: gpt-5.4, gpt-5-mini, o3"
          onChange={(e) => setModels(e.target.value)}
        />
        {invalidModels.length > 0 ? (
          <p role="alert" className="text-xs text-destructive">
            유효하지 않은 모델 ID가 포함되어 있습니다({invalidModels.join(", ")}). 계정 이름이
            아니라 공백·슬래시 없는 실제 OpenAI 모델 ID를 입력하세요.
          </p>
        ) : null}
        <div className="flex flex-wrap gap-1 pt-0.5">
          {OPENAI_API_RECOMMENDED_MODELS.map((preset) => {
            const active = selectedModelSet.has(preset);
            return (
              <button
                key={preset}
                type="button"
                disabled={busy}
                onClick={() => toggleModel(preset)}
                className={cn(
                  "rounded-md border px-2 py-0.5 text-[11px] transition-colors",
                  active
                    ? "border-primary bg-primary/15 font-medium text-foreground"
                    : "border-border bg-muted/40 text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
              >
                {active ? "✓ " : "+ "}
                {preset}
              </button>
            );
          })}
        </div>
        {fetchError ? (
          <p role="alert" className="text-xs text-destructive">
            {fetchError}
          </p>
        ) : null}
        {fetchedModels.length > 0 ? (
          <div className="grid gap-1.5 rounded-lg border border-border/70 bg-muted/20 p-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-foreground">
                계정에서 조회된 모델 ({fetchedModels.length}개)
              </span>
              <Input
                value={modelFilter}
                onChange={(e) => setModelFilter(e.target.value)}
                placeholder="모델 필터..."
                className="h-6 max-w-40 text-xs"
              />
            </div>
            <div className="flex max-h-36 flex-wrap gap-1 overflow-y-auto">
              {filteredFetchedModels.map((modelId) => {
                const active = selectedModelSet.has(modelId);
                return (
                  <button
                    key={modelId}
                    type="button"
                    disabled={busy}
                    onClick={() => toggleModel(modelId)}
                    className={cn(
                      "rounded-md border px-2 py-0.5 text-[11px] transition-colors",
                      active
                        ? "border-primary bg-primary/15 font-medium text-foreground"
                        : "border-border bg-background text-muted-foreground hover:bg-muted hover:text-foreground",
                    )}
                  >
                    {active ? "✓ " : "+ "}
                    {modelId}
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">
        대화의 모델 선택기에서 이 계정과 모델을 선택하면 OpenAI API 사용료가 발생합니다. 연결 주소는{" "}
        {OPENAI_API_CONNECTION.baseUrl}입니다.
      </p>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        {onBack && (
          <Button type="button" variant="outline" disabled={busy} onClick={onBack}>
            이전
          </Button>
        )}
        <Button
          type="button"
          disabled={
            busy ||
            !displayName.trim() ||
            selectedModels.length === 0 ||
            invalidModels.length > 0 ||
            (!instance && !key.trim())
          }
          onClick={submit}
        >
          {instance ? "OpenAI API 변경 저장" : "계정 추가"}
        </Button>
      </div>
    </section>
  );
}

export function OpenAiApiConnectionDialog({
  environmentId,
  open,
  onOpenChange,
  onBack,
}: {
  readonly environmentId: EnvironmentId;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onBack: () => void;
}) {
  const update = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const pendingInstanceId = useRef<ProviderInstanceId | null>(null);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) pendingInstanceId.current = null;
        onOpenChange(next);
      }}
    >
      <DialogPopup className="max-w-lg overflow-hidden">
        <DialogHeader>
          <DialogTitle>OpenAI API 계정 연결</DialogTitle>
          <DialogDescription>
            ChatGPT 구독과 별도로 사용할 API 키와 모델 ID를 입력하세요.
          </DialogDescription>
        </DialogHeader>
        <div className="px-6 py-5">
          <OpenAiApiAccountForm
            environmentId={environmentId}
            onBack={onBack}
            save={async (instance) => {
              const instanceId = (pendingInstanceId.current ??= ProviderInstanceId.make(
                `openai_api_${randomUUID()}`,
              ));
              const result = await update({
                environmentId,
                input: { patch: { providerInstancesToUpsert: { [instanceId]: instance } } },
              });
              if (result._tag === "Failure") {
                if (isAtomCommandInterrupted(result)) throw new Error("저장이 중단되었습니다.");
                throw squashAtomCommandFailure(result);
              }
              if (pendingInstanceId.current === instanceId) {
                pendingInstanceId.current = null;
                onOpenChange(false);
              }
            }}
          />
        </div>
      </DialogPopup>
    </Dialog>
  );
}
