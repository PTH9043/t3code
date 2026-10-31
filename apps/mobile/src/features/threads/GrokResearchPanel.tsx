import { useMemo, useState } from "react";
import { Linking, Pressable, TextInput, View } from "react-native";
import type { EnvironmentId, ThreadId, WorkspaceResearchInput } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { AppText as Text } from "../../components/AppText";
import { useThreadShell } from "../../state/entities";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useAtomCommand } from "../../state/use-atom-command";
import { useEnvironmentQuery } from "../../state/query";
import { uuidv4 } from "../../lib/uuid";

export function GrokResearchPanel(props: { environmentId: EnvironmentId; threadId: ThreadId }) {
  const ref = useMemo(
    () => scopeThreadRef(props.environmentId, props.threadId),
    [props.environmentId, props.threadId],
  );
  const thread = useThreadShell(ref);
  const [open, setOpen] = useState(false);
  const status = useEnvironmentQuery(
    open && thread
      ? orchestrationEnvironment.workspaceResearch({
          environmentId: props.environmentId,
          input: { projectId: thread.projectId },
        })
      : null,
  );
  const run = useAtomCommand(orchestrationEnvironment.runWorkspaceResearch, {
    reportFailure: false,
  });
  const configure = useAtomCommand(orchestrationEnvironment.configureResearchKey, {
    reportFailure: false,
  });
  const [query, setQuery] = useState("");
  const [key, setKey] = useState("");
  const [source, setSource] = useState<WorkspaceResearchInput["source"]>("both");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const research = async () => {
    if (!thread) return;
    setBusy(true);
    setError(null);
    try {
      const result = await run({
        environmentId: props.environmentId,
        input: { projectId: thread.projectId, requestId: uuidv4(), query: query.trim(), source },
      });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      status.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "조사를 완료하지 못했습니다.");
      status.refresh();
    } finally {
      setBusy(false);
    }
  };
  const saveKey = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await configure({
        environmentId: props.environmentId,
        input: { apiKey: key.trim() || null },
      });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      setKey("");
      status.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "키를 저장하지 못했습니다.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <View className="gap-3 border-t border-border pt-3">
      <Pressable accessibilityRole="button" onPress={() => setOpen(!open)}>
        <Text className="font-t3-bold">Grok 조사 · 실제 비용 {open ? "접기" : "열기"}</Text>
      </Pressable>
      {open && (
        <>
          <Text className="text-xs">
            질문과 Grok 조사만 xAI로 전송하고 출처·날짜를 프로젝트 RAG에 저장합니다. 문서는 서버에서
            로컬 검색·OCR로 처리합니다.
          </Text>
          <Text className="text-xs">
            {status.data?.apiKeyReady ? "API 연결됨" : "Grok 조사 API 키 연결 필요"}
          </Text>
          <TextInput
            accessibilityLabel="Grok API 키"
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="XAI_API_KEY (빈 값 저장 시 삭제)"
            value={key}
            onChangeText={setKey}
            className="rounded border border-border p-2 text-foreground"
          />
          <Pressable accessibilityRole="button" disabled={busy} onPress={() => void saveKey()}>
            <Text>API 키 저장 / 삭제</Text>
          </Pressable>
          {status.data && (
            <Text className="text-xs">
              오늘 보고 비용 ${status.data.reportedTodayUsd.toFixed(6)} · 미확인 호출{" "}
              {status.data.unreportedCalls}개 · UTC 하루 상한{" "}
              {status.data.dailyLimitUsd === null ? "없음" : `$${status.data.dailyLimitUsd}`}
            </Text>
          )}
          <Text className="text-xs">
            검색·압축 호출 비용이며 CLI 구독 비용은 제외됩니다. 필터·추가 조사·상한 설정은
            웹/데스크톱의 지식·RAG 화면에서 관리합니다.
          </Text>
          <View className="flex-row gap-4">
            {(["both", "web", "x"] as const).map((choice) => (
              <Pressable key={choice} accessibilityRole="button" onPress={() => setSource(choice)}>
                <Text>
                  {source === choice ? "● " : "○ "}
                  {choice === "both" ? "웹 + X" : choice === "web" ? "웹" : "X"}
                </Text>
              </Pressable>
            ))}
          </View>
          <TextInput
            accessibilityLabel="Grok 조사 질문"
            multiline
            placeholder="최신 정보 조사 질문"
            value={query}
            onChangeText={setQuery}
            className="min-h-20 rounded border border-border p-2 text-foreground"
          />
          <Pressable
            accessibilityRole="button"
            disabled={busy || status.data?.busy || !status.data?.apiKeyReady || !query.trim()}
            onPress={() => void research()}
          >
            <Text>{busy ? "조사 처리 중…" : "조사 후 RAG 저장"}</Text>
          </Pressable>
          <Pressable accessibilityRole="button" onPress={status.refresh}>
            <Text>비용·결과 새로고침</Text>
          </Pressable>
          {(error || status.error) && (
            <Text accessibilityRole="alert">{error ?? status.error}</Text>
          )}
          {status.data?.calls
            .filter((call) => call.kind === "research")
            .slice(0, 5)
            .map((call) => (
              <View key={call.requestId} className="gap-2 border-t border-border pt-2">
                <Text className="font-t3-bold">{call.query}</Text>
                <Text className="text-xs">
                  {call.createdAt} ·{" "}
                  {call.costTicks === null
                    ? "비용 미확인"
                    : `$${(call.costTicks / 1e10).toFixed(6)}`}
                </Text>
                <Text selectable>{call.text.slice(0, 6000)}</Text>
                {call.sources.map((url) => (
                  <Pressable key={url} onPress={() => void Linking.openURL(url)}>
                    <Text className="text-xs text-blue-600">{url}</Text>
                  </Pressable>
                ))}
              </View>
            ))}
        </>
      )}
    </View>
  );
}
