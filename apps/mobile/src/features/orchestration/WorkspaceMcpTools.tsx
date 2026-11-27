import { useAtomValue } from "@effect/atom-react";
import {
  DEFAULT_SERVER_SETTINGS,
  type EnvironmentId,
  type McpToolCatalog,
  type McpToolCatalogEntry,
  type ManagedMcpServerConfig,
} from "@t3tools/contracts";
import { useState } from "react";
import { Pressable, Switch, View } from "react-native";
import { AppText as Text } from "../../components/AppText";
import { ErrorBanner } from "../../components/ErrorBanner";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { MobileMcpServerEditor } from "./MobileMcpServerEditor";

export function WorkspaceMcpTools({
  environmentId,
  workspaceRoot,
}: {
  environmentId: EnvironmentId;
  workspaceRoot?: string;
}) {
  const settings =
    useAtomValue(serverEnvironment.settingsValueAtom(environmentId)) ?? DEFAULT_SERVER_SETTINGS;
  const getTools = useAtomCommand(serverEnvironment.getMcpTools, { reportFailure: false });
  const update = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const [expanded, setExpanded] = useState(false);
  const [catalog, setCatalog] = useState<McpToolCatalog | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<ManagedMcpServerConfig | null | false>(false);
  const refresh = async (check: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const result = await getTools({
        environmentId,
        input: { check, ...(workspaceRoot ? { workspaceRoot } : {}) },
      });
      if (result._tag === "Success") setCatalog(result.value);
      else setError("MCP 도구를 확인하지 못했습니다. 연결을 확인하고 다시 시도하세요.");
    } finally {
      setBusy(false);
    }
  };
  const toggle = async (entry: McpToolCatalogEntry, enabled: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const config = settings.customMcpServers[entry.id.slice("custom:".length)];
      const enabledBuiltins = (catalog?.entries ?? []).flatMap((item) =>
        item.builtinId && (item.id === entry.id ? enabled : item.enabled) ? [item.builtinId] : [],
      );
      const result = await update({
        environmentId,
        input: {
          patch: entry.builtinId
            ? workspaceRoot
              ? {
                  mcpProjectProfilesToUpsert: {
                    [workspaceRoot]: { workspaceRoot, enabledBuiltins },
                  },
                }
              : { mcpTools: { [entry.builtinId]: enabled } }
            : config
              ? { customMcpServersToUpsert: { [config.name]: { ...config, enabled } } }
              : {},
        },
      });
      if (result._tag !== "Success") setError("MCP 설정을 저장하지 못했습니다.");
      else await refresh(false);
    } finally {
      setBusy(false);
    }
  };
  return (
    <View className="gap-3 rounded-xl border border-border bg-card p-4">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        onPress={() => {
          setExpanded(!expanded);
          if (!expanded && !catalog) void refresh(false);
        }}
      >
        <Text className="font-semibold text-foreground">
          MCP 도구 · {workspaceRoot ? "현재 프로젝트" : "현재 환경"} {expanded ? "⌃" : "⌄"}
        </Text>
      </Pressable>
      {expanded ? (
        <>
          <Text className="text-xs text-muted-foreground">
            T3 Code 내장 도구(t3-code · 협업 브라우저/기억/위임 26개)는 항상 1순위로 자동 연결되며,
            아래 설정은 새 AI 세션부터 적용됩니다.
          </Text>
          <Pressable
            accessibilityRole="button"
            disabled={busy}
            onPress={() => void refresh(true)}
            className="rounded-lg border border-border p-3"
          >
            <Text className="text-center text-foreground">{busy ? "확인 중…" : "연결 검사"}</Text>
          </Pressable>
          {error ? <ErrorBanner message={error} /> : null}
          {workspaceRoot && settings.mcpProjectProfiles[workspaceRoot] ? (
            <Pressable
              accessibilityRole="button"
              disabled={busy}
              onPress={() => {
                setBusy(true);
                void update({
                  environmentId,
                  input: { patch: { mcpProjectProfileRootsToRemove: [workspaceRoot] } },
                })
                  .then((result) => {
                    if (result._tag === "Success") void refresh(false);
                    else setError("환경 기본 설정 복원 실패");
                  })
                  .finally(() => setBusy(false));
              }}
            >
              <Text className="text-xs text-foreground">환경 기본 설정 사용</Text>
            </Pressable>
          ) : null}
          <Pressable accessibilityRole="button" disabled={busy} onPress={() => setEditing(null)}>
            <Text className="text-xs text-foreground">MCP 서버 등록</Text>
          </Pressable>
          {editing !== false ? (
            <MobileMcpServerEditor
              key={editing?.name ?? "new"}
              environmentId={environmentId}
              {...(workspaceRoot ? { workspaceRoot } : {})}
              {...(editing ? { initial: editing } : {})}
              onSaved={() => {
                setEditing(false);
                void refresh(false);
              }}
              onCancel={() => setEditing(false)}
            />
          ) : null}
          {catalog?.entries.map((entry) => (
            <View key={entry.id} className="gap-1 border-t border-border pt-3">
              <View className="flex-row items-center justify-between gap-3">
                <Text className="flex-1 font-medium text-foreground">{entry.name}</Text>
                <Switch
                  accessibilityLabel={`${entry.name} 사용`}
                  disabled={busy || !entry.installed}
                  value={entry.enabled}
                  onValueChange={(enabled) => void toggle(entry, enabled)}
                />
              </View>
              <Text className="text-xs text-muted-foreground">{entry.description}</Text>
              <Text className="text-xs text-muted-foreground">
                {entry.providers
                  .map((provider) =>
                    provider === "claudeAgent"
                      ? "Claude"
                      : provider === "gemini"
                        ? "Antigravity"
                        : provider === "grok"
                          ? "Grok"
                          : "Codex",
                  )
                  .join(" · ")}{" "}
                · {entry.scope === "project" ? "프로젝트 설정" : "환경 설정"}
              </Text>
              {entry.nativeRedundantProviders?.includes("gemini") ? (
                <Text className="text-xs text-muted-foreground">
                  {entry.scope === "project"
                    ? "Antigravity 프로젝트 강제 포함"
                    : "Antigravity 기본 제외 (내장 도구 중복 · 도구 예산 보호)"}
                </Text>
              ) : null}
              <Text className="text-xs text-muted-foreground">
                {entry.status === "ready"
                  ? `연결 확인 · 도구 ${entry.tools.length}개`
                  : entry.status === "missing"
                    ? "설치 필요"
                    : entry.status === "error"
                      ? "연결 오류"
                      : "검사 전"}
              </Text>
              {entry.error ? <Text className="text-xs text-destructive">{entry.error}</Text> : null}
              {entry.checkedAt ? (
                <Text className="text-xs text-muted-foreground">최근 검사 · {entry.checkedAt}</Text>
              ) : null}
              {!entry.builtinId && settings.customMcpServers[entry.id.slice("custom:".length)] ? (
                <View className="flex-row gap-4">
                  <Pressable
                    accessibilityRole="button"
                    onPress={() =>
                      setEditing(settings.customMcpServers[entry.id.slice("custom:".length)]!)
                    }
                  >
                    <Text className="text-xs text-foreground">수정</Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    disabled={busy}
                    onPress={() => {
                      setBusy(true);
                      void update({
                        environmentId,
                        input: {
                          patch: { customMcpServerIdsToRemove: [entry.id.slice("custom:".length)] },
                        },
                      })
                        .then((result) => {
                          if (result._tag === "Success") void refresh(false);
                          else setError("MCP 삭제 실패");
                        })
                        .finally(() => setBusy(false));
                    }}
                  >
                    <Text className="text-xs text-destructive">삭제</Text>
                  </Pressable>
                </View>
              ) : null}
            </View>
          ))}
        </>
      ) : null}
    </View>
  );
}
