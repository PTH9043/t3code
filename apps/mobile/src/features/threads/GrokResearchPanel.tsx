import { Fragment, useMemo, useState } from "react";
import { Linking, Modal, Pressable, ScrollView, TextInput, View } from "react-native";
import type {
  EnvironmentId,
  ThreadId,
  WorkspaceResearchInput,
  WorkspaceResearchProvider,
  WorkspaceResearchCall,
} from "@t3tools/contracts";
import { WebView } from "react-native-webview";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { AppText as Text } from "../../components/AppText";
import { useThreadShell } from "../../state/entities";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useAtomCommand } from "../../state/use-atom-command";
import { useEnvironmentQuery } from "../../state/query";
import { uuidv4 } from "../../lib/uuid";
import {
  researchCitationMarkers,
  researchCitationSegments,
} from "@t3tools/shared/researchCitations";
import { researchErrorMessage } from "@t3tools/shared/researchErrors";

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
  const [provider, setProvider] = useState<WorkspaceResearchProvider>("xai");
  const [model, setModel] = useState("");
  const [apiInstanceId, setApiInstanceId] = useState("");
  const [geminiMode, setGeminiMode] = useState<"google" | "analysis">("analysis");
  const [customMode, setCustomMode] = useState<"search" | "analysis">("search");
  const [followUpId, setFollowUpId] = useState("");
  const [googleReport, setGoogleReport] = useState<WorkspaceResearchCall | null>(null);
  const [googleSuggestionsReady, setGoogleSuggestionsReady] = useState(false);
  const [key, setKey] = useState("");
  const [source, setSource] = useState<WorkspaceResearchInput["source"]>("both");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const research = async () => {
    if (!thread) return;
    setBusy(true);
    setError(null);
    setGoogleReport(null);
    setGoogleSuggestionsReady(false);
    try {
      const result = await run({
        environmentId: props.environmentId,
        input: {
          projectId: thread.projectId,
          requestId: uuidv4(),
          query: query.trim(),
          source,
          ...(provider === "xai" ? {} : { provider, model: model.trim() }),
          ...(provider === "gemini" ? { geminiMode } : {}),
          ...(provider === "custom" ? { apiInstanceId } : {}),
          ...(provider === "custom" ? { customMode } : {}),
          ...(followUpId && !(provider === "gemini" && geminiMode === "google")
            ? { followUpId }
            : {}),
        },
      });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      if (result.value.displayOnly) setGoogleReport(result.value);
      status.refresh();
    } catch (cause) {
      setError(researchErrorMessage(cause, "조사를 완료하지 못했습니다."));
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
        input: { apiKey: key.trim() || null, ...(provider === "xai" ? {} : { provider }) },
      });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      setKey("");
      status.refresh();
    } catch (cause) {
      setError(researchErrorMessage(cause, "키를 저장하지 못했습니다."));
    } finally {
      setBusy(false);
    }
  };
  return (
    <View className="gap-3 border-t border-border pt-3">
      <Pressable
        accessibilityRole="button"
        onPress={() => {
          setOpen(!open);
          if (open) setGoogleReport(null);
        }}
      >
        <Text className="font-t3-bold">API 조사 · 실제 비용 {open ? "접기" : "열기"}</Text>
      </Pressable>
      {open && (
        <>
          <Text className="text-xs">
            질문과 선택한 자료를 해당 API에 보냅니다. Gemini Google 검색 보고서는 화면에만 표시하고,
            다른 조사 결과는 프로젝트 RAG에 저장합니다.
          </Text>
          <View className="flex-row gap-4">
            {(["xai", "openai", "anthropic", "gemini", "custom"] as const).map((choice) => (
              <Pressable
                key={choice}
                accessibilityRole="button"
                disabled={choice !== "xai" && !status.data?.providerKeys}
                onPress={() => {
                  setProvider(choice);
                  setKey("");
                  setModel("");
                  setApiInstanceId("");
                  setFollowUpId("");
                  setGoogleReport(null);
                  if (choice !== "xai") setSource("web");
                }}
              >
                <Text>
                  {provider === choice ? "● " : "○ "}
                  {choice === "xai"
                    ? "Grok"
                    : choice === "openai"
                      ? "OpenAI"
                      : choice === "anthropic"
                        ? "Claude"
                        : choice === "gemini"
                          ? "Gemini"
                          : "사용자 지정"}
                </Text>
              </Pressable>
            ))}
          </View>
          {provider === "gemini" && (
            <View className="gap-2">
              {(["analysis", "google"] as const).map((choice) => (
                <Pressable
                  key={choice}
                  accessibilityRole="button"
                  onPress={() => {
                    setGeminiMode(choice);
                    setFollowUpId("");
                    setGoogleReport(null);
                  }}
                >
                  <Text>
                    {geminiMode === choice ? "● " : "○ "}
                    {choice === "analysis"
                      ? "다른 API 조사 분석 후 RAG 저장"
                      : "Google 검색 보고서 (화면 표시만)"}
                  </Text>
                </Pressable>
              ))}
            </View>
          )}
          {provider === "custom" && (
            <View className="gap-2">
              {(["search", "analysis"] as const).map((choice) => (
                <Pressable
                  key={choice}
                  accessibilityRole="button"
                  onPress={() => {
                    setCustomMode(choice);
                    setFollowUpId("");
                  }}
                >
                  <Text>
                    {customMode === choice ? "● " : "○ "}
                    {choice === "search" ? "API 자체 웹 검색 (지원 필요)" : "다른 API 조사 분석"}
                  </Text>
                </Pressable>
              ))}
            </View>
          )}
          {provider === "custom" && (
            <View className="gap-2">
              <Text>등록된 API 계정</Text>
              {status.data?.customAccounts?.map((account) => (
                <Pressable
                  key={account.instanceId}
                  accessibilityRole="button"
                  onPress={() => {
                    setApiInstanceId(account.instanceId);
                    setModel("");
                  }}
                >
                  <Text>
                    {apiInstanceId === account.instanceId ? "● " : "○ "}
                    {account.displayName}
                  </Text>
                </Pressable>
              ))}
              {status.data?.customAccounts
                ?.find((account) => account.instanceId === apiInstanceId)
                ?.models.map((name) => (
                  <Pressable key={name} accessibilityRole="button" onPress={() => setModel(name)}>
                    <Text>
                      {model === name ? "● " : "○ "}
                      {name}
                    </Text>
                  </Pressable>
                ))}
            </View>
          )}
          {provider !== "xai" && provider !== "custom" && (
            <TextInput
              accessibilityLabel="조사 모델"
              autoCapitalize="none"
              value={model}
              onChangeText={setModel}
              placeholder="검색을 지원하는 모델 ID"
              className="rounded border border-border p-2 text-foreground"
            />
          )}
          {provider !== "custom" && (
            <Text className="text-xs">
              {(
                provider === "xai"
                  ? status.data?.apiKeyReady
                  : status.data?.providerKeys?.[provider]
              )
                ? "API 키 사용 가능"
                : "조사 API 키 연결 필요"}
            </Text>
          )}
          {provider !== "custom" && (
            <TextInput
              accessibilityLabel="조사 API 키"
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              placeholder="API 키 (빈 값 저장 시 삭제)"
              value={key}
              onChangeText={setKey}
              className="rounded border border-border p-2 text-foreground"
            />
          )}
          {provider !== "custom" && (
            <Pressable accessibilityRole="button" disabled={busy} onPress={() => void saveKey()}>
              <Text>API 키 저장 / 삭제</Text>
            </Pressable>
          )}
          {((provider === "custom" && customMode === "analysis") ||
            (provider === "gemini" && geminiMode === "analysis")) && (
            <View className="gap-2">
              <Text>분석할 완료된 검색 자료</Text>
              {status.data?.calls
                .filter(
                  (call) =>
                    call.kind === "research" &&
                    call.status === "complete" &&
                    !call.displayOnly &&
                    Boolean(call.text) &&
                    call.sources.length > 0,
                )
                .map((call) => (
                  <Pressable
                    key={call.requestId}
                    accessibilityRole="button"
                    onPress={() => setFollowUpId(call.requestId)}
                  >
                    <Text>
                      {followUpId === call.requestId ? "● " : "○ "}
                      {call.query.slice(0, 80)}
                    </Text>
                  </Pressable>
                ))}
            </View>
          )}
          {status.data && (
            <Text className="text-xs">
              오늘 보고 비용 ${status.data.reportedTodayUsd.toFixed(6)} · 미확인 호출{" "}
              {status.data.unreportedCalls}개 · UTC 하루 상한{" "}
              {status.data.dailyLimitUsd === null ? "없음" : `$${status.data.dailyLimitUsd}`}
            </Text>
          )}
          <Text className="text-xs">
            제공자가 비용을 보고하지 않으면 미확인으로 표시합니다. 하루 상한이 설정되어 있으면
            미확인 호출 후 다음 유료 호출을 중지합니다. CLI 구독 비용은 제외됩니다.
          </Text>
          <View className="flex-row gap-4">
            {(provider === "xai" ? (["both", "web", "x"] as const) : (["web"] as const)).map(
              (choice) => (
                <Pressable
                  key={choice}
                  accessibilityRole="button"
                  onPress={() => setSource(choice)}
                >
                  <Text>
                    {source === choice ? "● " : "○ "}
                    {choice === "both" ? "웹 + X" : choice === "web" ? "웹" : "X"}
                  </Text>
                </Pressable>
              ),
            )}
          </View>
          <TextInput
            accessibilityLabel="조사 질문"
            multiline
            placeholder="최신 정보 조사 질문"
            value={query}
            onChangeText={setQuery}
            className="min-h-20 rounded border border-border p-2 text-foreground"
          />
          <Pressable
            accessibilityRole="button"
            disabled={
              busy ||
              status.data?.busy ||
              !(provider === "custom"
                ? Boolean(apiInstanceId)
                : provider === "xai"
                  ? status.data?.apiKeyReady
                  : status.data?.providerKeys?.[provider]) ||
              !query.trim() ||
              (provider !== "xai" && !model.trim()) ||
              (((provider === "custom" && customMode === "analysis") ||
                (provider === "gemini" && geminiMode === "analysis")) &&
                !followUpId)
            }
            onPress={() => void research()}
          >
            <Text>
              {busy
                ? "조사 처리 중…"
                : provider === "gemini" && geminiMode === "google"
                  ? "Google 검색 보고서 보기"
                  : "조사 후 RAG 저장"}
            </Text>
          </Pressable>
          <Pressable accessibilityRole="button" onPress={status.refresh}>
            <Text>비용·결과 새로고침</Text>
          </Pressable>
          {(error || status.error) && (
            <Text accessibilityRole="alert">{error ?? status.error}</Text>
          )}
          {googleReport?.searchSuggestionsHtml && (
            <Modal
              visible
              onRequestClose={() => setGoogleReport(null)}
              presentationStyle="pageSheet"
            >
              <View className="flex-1 bg-background p-4">
                <View className="flex-row items-center justify-between">
                  <Text className="font-t3-bold">Gemini Google 검색 보고서</Text>
                  <Pressable accessibilityRole="button" onPress={() => setGoogleReport(null)}>
                    <Text>닫기</Text>
                  </Pressable>
                </View>
                <WebView
                  originWhitelist={["*"]}
                  javaScriptEnabled={false}
                  allowFileAccess={false}
                  setSupportMultipleWindows={false}
                  source={{
                    html: `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'">${googleReport.searchSuggestionsHtml}`,
                  }}
                  onShouldStartLoadWithRequest={(request) => {
                    if (request.url === "about:blank") return true;
                    try {
                      const url = new URL(request.url);
                      if (
                        url.protocol === "https:" &&
                        !url.username &&
                        !url.password &&
                        !url.port &&
                        [
                          "vertexaisearch.cloud.google.com",
                          "www.google.com",
                          "google.com",
                        ].includes(url.hostname)
                      )
                        void Linking.openURL(url.href).catch(() =>
                          setError("Google 검색 결과를 열지 못했습니다."),
                        );
                    } catch {}
                    return false;
                  }}
                  onLoad={() => setGoogleSuggestionsReady(true)}
                  onError={() => {
                    setGoogleSuggestionsReady(false);
                    setError("Google 검색 제안을 표시하지 못했습니다.");
                  }}
                  style={{ height: 110, flex: 0, backgroundColor: "transparent" }}
                />
                {error && <Text accessibilityRole="alert">{error}</Text>}
                {googleSuggestionsReady && (
                  <ScrollView className="flex-1" contentContainerStyle={{ gap: 8 }}>
                    <Text selectable>
                      {researchCitationMarkers(
                        googleReport.text,
                        googleReport.citations,
                        googleReport.sources,
                      ).map((part) => (
                        <Fragment key={part.end}>
                          {part.text}
                          {part.links.map(({ url, number }) => (
                            <Text
                              key={url}
                              className="text-blue-600"
                              accessibilityRole="link"
                              onPress={() => void Linking.openURL(url)}
                            >
                              [{number}]
                            </Text>
                          ))}
                        </Fragment>
                      ))}
                    </Text>
                    {googleReport.sources.map((url, index) => (
                      <Pressable key={url} onPress={() => void Linking.openURL(url)}>
                        <Text className="text-xs text-blue-600">
                          [{index + 1}] {url}
                        </Text>
                      </Pressable>
                    ))}
                    <Text className="text-xs">
                      이 보고서는 화면에만 표시되며 프로젝트 RAG와 조사 기록에 저장되지 않습니다.
                    </Text>
                  </ScrollView>
                )}
              </View>
            </Modal>
          )}
          {!googleReport &&
            status.data?.calls
              .filter((call) => call.kind === "research")
              .slice(0, 5)
              .map((call) => (
                <View key={call.requestId} className="gap-2 border-t border-border pt-2">
                  <Text className="font-t3-bold">{call.query}</Text>
                  <Text className="text-xs">
                    {call.createdAt} · {call.provider ?? "xai"} ·{" "}
                    {call.researchModel ?? "모델 미기록"} ·{" "}
                    {call.displayOnly ? "화면 전용 · 본문 미저장 · " : ""}
                    {call.costTicks === null
                      ? "비용 미확인"
                      : `$${(call.costTicks / 1e10).toFixed(6)}`}
                  </Text>
                  <Text selectable>
                    {researchCitationSegments(call.text.slice(0, 6000), call.citations).map(
                      (part) =>
                        part.url ? (
                          <Text
                            key={part.start}
                            className="text-blue-600"
                            onPress={() => void Linking.openURL(part.url!)}
                          >
                            {part.text}
                          </Text>
                        ) : (
                          part.text
                        ),
                    )}
                  </Text>
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
