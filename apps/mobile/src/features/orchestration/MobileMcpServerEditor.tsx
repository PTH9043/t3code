import { useState } from "react";
import { Pressable, Switch, TextInput, View } from "react-native";
import {
  ManagedMcpServerConfig,
  type EnvironmentId,
  type ManagedMcpProvider,
} from "@t3tools/contracts";
import { Schema } from "effect";
import { AppText as Text } from "../../components/AppText";
import { ErrorBanner } from "../../components/ErrorBanner";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

const decodeConfig = Schema.decodeUnknownSync(ManagedMcpServerConfig);

export function MobileMcpServerEditor(props: {
  environmentId: EnvironmentId;
  workspaceRoot?: string;
  initial?: ManagedMcpServerConfig;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(props.initial?.name ?? "");
  const [label, setLabel] = useState(props.initial?.label ?? "");
  const [http, setHttp] = useState(props.initial?.transport !== "stdio");
  const [endpoint, setEndpoint] = useState(
    props.initial?.transport === "stdio" ? props.initial.command : (props.initial?.url ?? ""),
  );
  const [args, setArgs] = useState(
    props.initial?.transport === "stdio" ? JSON.stringify(props.initial.args) : "[]",
  );
  const [environment, setEnvironment] = useState(
    JSON.stringify(
      props.initial?.transport === "stdio" ? props.initial.env : (props.initial?.headers ?? {}),
    ),
  );
  const [providers, setProviders] = useState<readonly ManagedMcpProvider[]>(
    props.initial?.providers ?? ["grok", "codex", "claudeAgent", "gemini"],
  );
  const [scoped, setScoped] = useState(
    Boolean(props.initial ? props.initial.workspaceRoot : props.workspaceRoot),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const update = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const common = {
        name: name.trim(),
        label: label.trim() || name.trim(),
        enabled: props.initial?.enabled ?? true,
        providers,
        workspaceRoot: scoped
          ? (props.workspaceRoot ?? props.initial?.workspaceRoot ?? null)
          : null,
      };
      const config = decodeConfig({
        ...common,
        ...(http
          ? { transport: "http", url: endpoint.trim(), headers: JSON.parse(environment) as unknown }
          : {
              transport: "stdio",
              command: endpoint.trim(),
              args: JSON.parse(args) as unknown,
              env: JSON.parse(environment) as unknown,
            }),
      });
      const result = await update({
        environmentId: props.environmentId,
        input: { patch: { customMcpServersToUpsert: { [config.name]: config } } },
      });
      if (result._tag === "Success") props.onSaved();
      else setError("MCP 설정 저장 실패");
    } catch {
      setError("이름·주소와 JSON 형식을 확인하세요. 이름은 영문으로 시작해야 합니다.");
    } finally {
      setBusy(false);
    }
  };
  const inputClass = "rounded-lg border border-border p-2 text-xs text-foreground";
  return (
    <View className="gap-3 rounded-lg border border-border p-3">
      <Text className="font-t3-bold text-sm text-foreground">
        {props.initial ? "MCP 수정" : "MCP 등록"}
      </Text>
      <TextInput
        accessibilityLabel="MCP 이름"
        editable={!props.initial}
        value={name}
        onChangeText={setName}
        placeholder="server-name"
        className={inputClass}
      />
      <TextInput
        accessibilityLabel="MCP 표시 이름"
        value={label}
        onChangeText={setLabel}
        placeholder="표시 이름"
        className={inputClass}
      />
      <View className="flex-row justify-between">
        <Text className="text-xs text-foreground">HTTP 서버</Text>
        <Switch
          value={http}
          onValueChange={(value) => {
            setHttp(value);
            setEndpoint("");
            setEnvironment("{}");
          }}
        />
      </View>
      <TextInput
        accessibilityLabel={http ? "MCP HTTP 주소" : "MCP 실행 명령"}
        value={endpoint}
        onChangeText={setEndpoint}
        placeholder={http ? "https://example.com/mcp" : "서버의 실행 파일 절대 경로"}
        className={inputClass}
      />
      {!http ? (
        <TextInput
          accessibilityLabel="MCP 인자 JSON"
          value={args}
          onChangeText={setArgs}
          placeholder='["server.js"]'
          multiline
          className={inputClass}
        />
      ) : null}
      <TextInput
        accessibilityLabel={http ? "MCP 헤더 JSON" : "MCP 환경 변수 JSON"}
        value={environment}
        onChangeText={setEnvironment}
        placeholder='{"TOKEN":"${ENV_NAME}"}'
        multiline
        className={inputClass}
      />
      <Text className="text-xs text-foreground-muted">
        ${"{ENV_NAME}"}는 서버 환경 변수에서 읽습니다. 미설정 값은 연결 검사에 표시됩니다.
      </Text>
      {(["grok", "codex", "claudeAgent", "gemini"] as const).map((provider) => (
        <View key={provider} className="flex-row justify-between">
          <Text className="text-xs text-foreground">
            {provider === "claudeAgent"
              ? "Claude"
              : provider === "gemini"
                ? "Antigravity"
                : provider}
          </Text>
          <Switch
            value={providers.includes(provider)}
            onValueChange={(enabled) =>
              setProviders(
                enabled ? [...providers, provider] : providers.filter((item) => item !== provider),
              )
            }
          />
        </View>
      ))}
      {props.workspaceRoot ? (
        <View className="flex-row justify-between">
          <Text className="text-xs text-foreground">현재 프로젝트에만 적용</Text>
          <Switch value={scoped} onValueChange={setScoped} />
        </View>
      ) : null}
      <View className="flex-row gap-3">
        <Pressable
          accessibilityRole="button"
          disabled={busy || !name.trim() || !endpoint.trim() || !providers.length}
          onPress={() => void save()}
        >
          <Text className="text-xs text-foreground">저장</Text>
        </Pressable>
        <Pressable accessibilityRole="button" onPress={props.onCancel}>
          <Text className="text-xs text-foreground-muted">닫기</Text>
        </Pressable>
      </View>
      {error ? <ErrorBanner message={error} /> : null}
    </View>
  );
}
