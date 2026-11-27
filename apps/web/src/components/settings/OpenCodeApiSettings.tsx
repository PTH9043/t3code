import { useState } from "react";
import * as Schema from "effect/Schema";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  OPENAI_API_CONNECTION,
  OpenCodeApiConnection,
  OpenCodeSettings,
  OPENCODE_API_KEY_ENV,
  type ProviderInstanceConfig,
} from "@t3tools/contracts";
import { useAtomCommand } from "../../state/use-atom-command";
import { serverEnvironment } from "../../state/server";
import type { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { OpenAiApiAccountForm } from "./OpenAiApiAccount";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { toastManager } from "../ui/toast";

const decodeSettings = Schema.decodeSync(OpenCodeSettings);
const decodeConnection = Schema.decodeSync(OpenCodeApiConnection);

/** Keep redacted credentials intact when only the endpoint/model settings change. */
export function withOpenCodeApiConnection(
  instance: ProviderInstanceConfig,
  connection: OpenCodeApiConnection | null,
  apiKey: string,
): ProviderInstanceConfig {
  const config = { ...decodeSettings(instance.config ?? {}) };
  if (connection) {
    const url = new URL(connection.baseUrl);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new Error(
        "API 주소에는 HTTP(S) 주소만 입력하세요. 키·쿼리·비밀번호는 포함할 수 없습니다.",
      );
    }
    if (config.serverUrl.trim()) throw new Error("API 연결을 사용하려면 서버 URL을 비워 주세요.");
    config.apiConnection = connection;
  } else {
    delete config.apiConnection;
  }
  const environment = [...(instance.environment ?? [])];
  if (apiKey.trim()) {
    const index = environment.findIndex((entry) => entry.name === OPENCODE_API_KEY_ENV);
    const credential = { name: OPENCODE_API_KEY_ENV, value: apiKey.trim(), sensitive: true };
    if (index === -1) environment.push(credential);
    else environment[index] = credential;
  }
  return { ...instance, config, environment };
}

export function OpenCodeApiSettings({
  instanceId,
  instance,
  environmentId,
  onUpdate,
}: {
  instanceId?: ProviderInstanceId;
  instance: ProviderInstanceConfig;
  environmentId: EnvironmentId;
  onUpdate: (instance: ProviderInstanceConfig) => void;
}) {
  const settings = decodeSettings(instance.config ?? {});
  const connection = settings.apiConnection;
  const [providerId, setProviderId] = useState(connection?.providerId ?? "t3_api");
  const [baseUrl, setBaseUrl] = useState(connection?.baseUrl ?? "");
  const [protocol, setProtocol] = useState(connection?.protocol ?? "chat-completions");
  const [models, setModels] = useState(connection?.models.join(", ") ?? "");
  const [contextTokens, setContextTokens] = useState(String(connection?.contextTokens ?? 128000));
  const [outputTokens, setOutputTokens] = useState(
    connection?.outputTokens === undefined ? "" : String(connection.outputTokens),
  );
  const [apiKey, setApiKey] = useState("");
  const [goApiKey, setGoApiKey] = useState("");
  const [error, setError] = useState("");
  const [goError, setGoError] = useState("");
  const hasKey = instance.environment?.some((entry) => entry.name === OPENCODE_API_KEY_ENV);
  const connectGo = useAtomCommand(serverEnvironment.connectOpenCodeGo, { reportFailure: false });
  const [isConnectingGo, setIsConnectingGo] = useState(false);
  const [goKeyRegistered, setGoKeyRegistered] = useState<boolean | null>(null);

  // Probe auth.json on first render (and after each save) so the Go section
  // shows a persistent "key registered" state instead of an empty input. The
  // test harness only shims useState, so the once-guard reads the probed
  // state directly instead of relying on useEffect/useMemo/useRef.
  const [goStatusProbed, setGoStatusProbed] = useState(false);
  const isOpenAiApi = connection?.providerId === OPENAI_API_CONNECTION.providerId;
  if (!goStatusProbed && !isOpenAiApi) {
    setGoStatusProbed(true);
    void (async () => {
      const result = await connectGo({ environmentId, input: {} });
      if (result._tag === "Success") {
        setGoKeyRegistered(result.value.keyRegistered === true);
      }
    })();
  }

  if (isOpenAiApi)
    return (
      <OpenAiApiAccountForm
        environmentId={environmentId}
        {...(instanceId ? { instanceId } : {})}
        instance={instance}
        save={onUpdate}
      />
    );

  const save = () => {
    try {
      const next = decodeConnection({
        providerId,
        baseUrl,
        protocol,
        models: [
          ...new Set(
            models
              .split(/[,\n]/)
              .map((model) => model.trim())
              .filter(Boolean),
          ),
        ],
        ...(contextTokens.trim() ? { contextTokens: Number(contextTokens) } : {}),
        ...(outputTokens.trim() ? { outputTokens: Number(outputTokens) } : {}),
      });
      onUpdate(withOpenCodeApiConnection(instance, next, apiKey));
      setApiKey("");
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "API 연결 설정을 확인하세요.");
    }
  };

  const saveGo = async () => {
    setIsConnectingGo(true);
    setGoError("");
    const result = await connectGo({ environmentId, input: { apiKey: goApiKey } });
    setIsConnectingGo(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const cause = squashAtomCommandFailure(result);
        setGoError(
          cause instanceof Error ? cause.message : "OpenCode Go 키를 저장하지 못했습니다.",
        );
      }
      return;
    }
    setGoApiKey("");
    setGoError("");
    setGoKeyRegistered(true);
    toastManager.add({
      type: "success",
      title: "OpenCode Go 키를 저장했습니다",
      description: "모든 OpenCode 인스턴스에서 사용할 수 있습니다.",
    });
  };

  return (
    <section
      className="grid gap-3 rounded-lg border border-border/60 p-3"
      aria-label="API 모델 연결"
    >
      <div>
        <p className="text-sm font-medium">OpenCode 계정</p>
        <p className="mt-1 text-xs text-muted-foreground">
          OpenCode Go 구독 키와 OpenAI 호환 API 연결을 관리합니다.
        </p>
      </div>
      <div className="grid gap-2 rounded-lg border border-border/40 p-3">
        <p className="text-sm font-medium">OpenCode Go</p>
        <p className="mt-1 text-xs text-muted-foreground">
          OpenCode Zen/Go 구독의 API 키를 등록합니다. 키는 전역 OpenCode 인증 파일에 저장되며 모든
          OpenCode 인스턴스가 사용합니다.
        </p>
        {goKeyRegistered === true ? (
          <p className="text-xs text-emerald-600 dark:text-emerald-400">
            ✓ OpenCode Go 키가 등록되어 있습니다. 새 키를 저장하면 덮어씁니다.
          </p>
        ) : goKeyRegistered === false ? (
          <p className="text-xs text-muted-foreground">등록된 OpenCode Go 키가 없습니다.</p>
        ) : null}
        <label className="grid gap-1 text-xs">
          API 키
          <Input
            type="password"
            value={goApiKey}
            onChange={(event) => setGoApiKey(event.target.value)}
            placeholder={
              goKeyRegistered === true
                ? "등록됨 · 비워 두면 기존 키 유지"
                : "opencode.ai/auth에서 발급받은 키"
            }
            autoComplete="new-password"
          />
        </label>
        {goError ? (
          <p role="alert" className="text-xs text-destructive">
            {goError}
          </p>
        ) : null}
        <div className="flex gap-2">
          <Button
            type="button"
            size="sm"
            disabled={isConnectingGo || !goApiKey.trim()}
            onClick={saveGo}
          >
            {isConnectingGo ? "저장 중" : "OpenCode Go 키 저장"}
          </Button>
        </div>
      </div>
      <div className="border-t border-border/40 pt-3">
        <p className="text-sm font-medium">호환 API 연결</p>
        <p className="mt-1 text-xs text-muted-foreground">
          이 연결의 모델을 기존 대화와 지속 작업실에서 선택할 수 있습니다.
        </p>
      </div>
      <div className="flex gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => {
            setProviderId("t3_deepseek");
            setBaseUrl("https://api.deepseek.com");
            setModels("deepseek-flash, deepseek-v4-pro");
            setProtocol("chat-completions");
          }}
        >
          DeepSeek 기본값
        </Button>
      </div>
      <label className="grid gap-1 text-xs">
        API 식별자
        <Input
          value={providerId}
          onChange={(event) => setProviderId(event.target.value)}
          autoComplete="off"
        />
      </label>
      <label className="grid gap-1 text-xs">
        API 주소
        <Input
          value={baseUrl}
          onChange={(event) => setBaseUrl(event.target.value)}
          placeholder="https://api.example.com/v1"
          autoComplete="off"
        />
      </label>
      <label className="grid gap-1 text-xs">
        API 형식
        <select
          className="rounded-md border border-input bg-background p-2"
          value={protocol}
          onChange={(event) =>
            setProtocol(event.target.value === "responses" ? "responses" : "chat-completions")
          }
        >
          <option value="chat-completions">OpenAI Chat Completions 호환</option>
          <option value="responses">OpenAI Responses 호환</option>
        </select>
      </label>
      <label className="grid gap-1 text-xs">
        모델 ID (쉼표로 구분)
        <Input
          value={models}
          onChange={(event) => setModels(event.target.value)}
          placeholder="API에서 제공하는 실제 모델 ID"
          autoComplete="off"
        />
      </label>
      <div className="grid grid-cols-2 gap-2">
        <label className="grid gap-1 text-xs">
          입력 컨텍스트 한도
          <Input
            type="number"
            min={1}
            value={contextTokens}
            onChange={(event) => setContextTokens(event.target.value)}
          />
        </label>
        <label className="grid gap-1 text-xs">
          최대 출력 토큰
          <Input
            type="number"
            min={1}
            value={outputTokens}
            onChange={(event) => setOutputTokens(event.target.value)}
          />
        </label>
      </div>
      <p className="text-xs text-muted-foreground">
        토큰 한도는 사용하려는 모델 사양 이하로 설정하세요.
      </p>
      <label className="grid gap-1 text-xs">
        API 키
        <Input
          type="password"
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          placeholder={
            hasKey ? "등록됨 · 비워 두면 기존 키 유지" : "API 키 입력 (키가 없는 로컬 API는 생략)"
          }
          autoComplete="new-password"
        />
      </label>
      <p className="text-xs text-muted-foreground">
        키는 서버의 계정별 민감 환경 변수로 저장됩니다. 원격 화면에는 저장된 키를 보내지 않습니다.
        로컬 설정 파일은 암호화되지 않습니다.
      </p>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button type="button" size="sm" onClick={save}>
          API 연결 저장
        </Button>
        {connection ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              onUpdate(withOpenCodeApiConnection(instance, null, ""));
              setError("");
            }}
          >
            API 연결 해제
          </Button>
        ) : null}
      </div>
    </section>
  );
}
