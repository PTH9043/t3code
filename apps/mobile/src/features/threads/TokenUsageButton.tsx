import { HandoffSettings } from "./HandoffSettings";
import { GrokResearchPanel } from "./GrokResearchPanel";
import type { EnvironmentId, ServerProvider, ThreadId } from "@t3tools/contracts";
import {
  formatTokenCount,
  hasExpiredQuotaWindow,
  providerQuotaSummary,
  providerQuotaWindows,
  tokenUsageCountLabels,
  tokenUsageIssueLabel,
  tokenUsagePhaseLabel,
  tokenUsageSummary,
  tokenUsageOutcomeLabel,
  tokenUsageDiagnosticRows,
} from "@t3tools/client-runtime/state/token-usage";
import { useCallback, useEffect, useRef, useState } from "react";
import { Modal, Pressable, ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { AppText as Text } from "../../components/AppText";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

function ProviderQuotaSection(props: {
  readonly title: string;
  readonly provider: ServerProvider;
}) {
  const windows = providerQuotaWindows(props.provider.usage);
  if (windows.length === 0) return null;
  return (
    <View className="gap-2 rounded-lg border border-border p-3">
      <View className="flex-row items-center justify-between gap-2">
        <Text className="font-t3-bold text-sm">{props.title}</Text>
        <Text className="text-xs text-muted-foreground">5시간 · 주간</Text>
      </View>
      {windows.map((window) => (
        <View key={window.id} className="gap-1">
          <View className="flex-row items-center justify-between gap-2">
            <Text className="text-xs font-medium">{window.label}</Text>
            <Text className="text-xs text-muted-foreground">{window.percentText}</Text>
          </View>
          <View className="h-1.5 overflow-hidden rounded-full bg-subtle">
            <View
              className="h-full rounded-full bg-foreground"
              style={{ width: `${window.usedPercent}%` }}
            />
          </View>
          {window.resetText ? (
            <Text className="text-[11px] text-muted-foreground">{window.resetText}</Text>
          ) : null}
        </View>
      ))}
    </View>
  );
}

export function TokenUsageButton(props: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  busy: boolean;
  selectedProvider?: ServerProvider | null | undefined;
  providers?: ReadonlyArray<ServerProvider> | undefined;
}) {
  const [open, setOpen] = useState(false);
  const [workId, setWorkId] = useState<string | undefined>();
  const [beforeSequence, setBeforeSequence] = useState<number | undefined>();
  const [isRefreshingQuota, setIsRefreshingQuota] = useState(false);
  const quotaRefreshInFlightRef = useRef(false);
  const lastAutoQuotaRefreshAtRef = useRef(0);
  const refreshServerProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const query = useEnvironmentQuery(
    orchestrationEnvironment.threadTokenUsage({
      environmentId: props.environmentId,
      input: {
        threadId: props.threadId,
        ...(workId ? { workId } : {}),
        ...(beforeSequence !== undefined ? { beforeSequence } : {}),
      },
    }),
  );
  const refreshQuota = useCallback(
    (force: boolean) => {
      const instanceId = props.selectedProvider?.instanceId;
      if (!instanceId || quotaRefreshInFlightRef.current) return;
      const nowMs = Date.now();
      if (!force) {
        if (nowMs - lastAutoQuotaRefreshAtRef.current < 30_000) return;
        const checkedAtMs = props.selectedProvider?.checkedAt
          ? Date.parse(props.selectedProvider.checkedAt)
          : NaN;
        const isStale = !Number.isFinite(checkedAtMs) || nowMs - checkedAtMs >= 2 * 60_000;
        const isExpired = hasExpiredQuotaWindow(props.selectedProvider?.usage, nowMs);
        if (!isStale && !isExpired) return;
        lastAutoQuotaRefreshAtRef.current = nowMs;
      }
      quotaRefreshInFlightRef.current = true;
      setIsRefreshingQuota(true);
      void (async () => {
        try {
          await refreshServerProviders({
            environmentId: props.environmentId,
            input: { instanceId },
          });
        } finally {
          quotaRefreshInFlightRef.current = false;
          setIsRefreshingQuota(false);
        }
      })();
    },
    [props.environmentId, props.selectedProvider, refreshServerProviders],
  );
  const lastBusy = useRef(props.busy);
  useEffect(() => {
    if (lastBusy.current !== props.busy) {
      lastBusy.current = props.busy;
      query.refresh();
    }
  }, [props.busy, query.refresh]);
  const report = query.data;
  const quotaSummary = providerQuotaSummary(props.selectedProvider?.usage);
  const workSummary = query.error ? "사용량 조회 실패" : tokenUsageSummary(report);
  const buttonLabel = quotaSummary ? `${quotaSummary} · ${workSummary}` : workSummary;
  const otherProvidersWithQuota = (props.providers ?? []).filter(
    (provider) =>
      provider.instanceId !== props.selectedProvider?.instanceId &&
      providerQuotaWindows(provider.usage).length > 0,
  );
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="작업 토큰 및 계정 한도 사용량 상세"
        className="self-end px-4 py-2"
        onPress={() => {
          setOpen(true);
          query.refresh();
          refreshQuota(false);
        }}
      >
        <Text className="text-xs text-muted-foreground" numberOfLines={1}>
          {buttonLabel}
        </Text>
      </Pressable>
      <Modal
        visible={open}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setOpen(false)}
      >
        <SafeAreaView className="flex-1 bg-background">
          <View className="flex-row items-center justify-between border-b border-border px-5 py-3">
            <Text className="font-t3-bold text-base">작업 토큰 · 계정 한도</Text>
            <Pressable
              accessibilityRole="button"
              onPress={() => setOpen(false)}
              className="px-3 py-2"
            >
              <Text>닫기</Text>
            </Pressable>
          </View>
          <ScrollView contentContainerStyle={{ padding: 20, gap: 16 }}>
            {props.selectedProvider ? (
              <ProviderQuotaSection
                title={`${props.selectedProvider.displayName} 계정 한도`}
                provider={props.selectedProvider}
              />
            ) : null}
            {otherProvidersWithQuota.map((provider) => (
              <ProviderQuotaSection
                key={provider.instanceId}
                title={`${provider.displayName} 계정 한도`}
                provider={provider}
              />
            ))}
            <HandoffSettings {...props} />
            <GrokResearchPanel {...props} />
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                query.refresh();
                refreshQuota(true);
              }}
              disabled={query.isPending || isRefreshingQuota}
            >
              <Text className="text-blue-600 dark:text-blue-400">
                {query.isPending || isRefreshingQuota ? "갱신 중" : "새로고침"}
              </Text>
            </Pressable>
            {query.error ? <Text accessibilityRole="alert">{query.error}</Text> : null}
            {!query.error && report ? (
              <>
                {report.work ? (
                  <Text className="text-xs">
                    선택 작업: {new Date(report.work.requestedAt).toLocaleString("ko-KR")}
                  </Text>
                ) : null}
                {report.coverage === "before-collection" ? (
                  <Text>계측 이전 기록입니다. 과거 사용량은 복원하지 않습니다.</Text>
                ) : (
                  <>
                    <View className="gap-2">
                      {tokenUsageCountLabels.map(({ key, label }) => (
                        <View key={key} className="flex-row justify-between gap-4">
                          <Text className="text-sm text-muted-foreground">{label}</Text>
                          <Text className="text-sm">{formatTokenCount(report.counts[key])}</Text>
                        </View>
                      ))}
                    </View>
                    <Text className="text-xs">
                      {tokenUsageOutcomeLabel[report.outcome]} ·{" "}
                      {report.finality === "final" ? "보고 종료" : "잠정 집계"} · 품질 판정 별도
                    </Text>
                    <View className="gap-2 rounded-lg border border-border p-3">
                      {tokenUsageDiagnosticRows(report).map((row) => (
                        <View key={row.label} className="flex-row justify-between gap-3">
                          <Text className="text-xs text-muted-foreground">{row.label}</Text>
                          <Text className="text-xs">{row.value}</Text>
                        </View>
                      ))}
                    </View>
                    {report.breakdown.length > 0 ? (
                      <View className="gap-3">
                        <Text className="font-t3-bold text-sm">모델·단계·시도별 확인된 사용량</Text>
                        {report.breakdown.map((row) => (
                          <View
                            key={`${row.provider}:${row.model}:${row.phase}:${row.attempt}`}
                            className="gap-1 border-b border-border pb-3"
                          >
                            <Text className="text-sm">
                              {row.model} · {row.provider}
                            </Text>
                            <View className="flex-row justify-between gap-4">
                              <Text className="text-xs text-muted-foreground">
                                {tokenUsagePhaseLabel[row.phase]}
                                {row.attempt > 1 ? ` · 재시도 ${row.attempt - 1}` : ""}
                              </Text>
                              <Text className="text-sm">
                                {formatTokenCount(row.counts.total)}
                                {row.issues.length ? " *" : ""}
                              </Text>
                            </View>
                          </View>
                        ))}
                      </View>
                    ) : null}
                  </>
                )}
                {report.issues.map((issue) => (
                  <Text key={issue} className="text-xs text-muted-foreground">
                    {tokenUsageIssueLabel[issue]}
                  </Text>
                ))}
                <Text className="text-xs text-muted-foreground">
                  캐시·추론은 입력·출력에 포함됩니다. —는 미보고이며, 항목별 숫자는 보고된 범위의
                  합입니다. 모델은 실행 요청 당시 선택값입니다.
                </Text>
                <Text className="text-xs text-muted-foreground">
                  계측 시작: {new Date(report.collectedSince).toLocaleString("ko-KR")}
                </Text>
                <View className="gap-2">
                  <Text className="font-t3-bold text-sm">작업 선택</Text>
                  {report.recentWorks.map((work) => (
                    <Pressable
                      key={work.workId}
                      accessibilityRole="button"
                      accessibilityState={{ selected: report.work?.workId === work.workId }}
                      className="rounded-lg border border-border p-3"
                      onPress={() => setWorkId(work.workId)}
                    >
                      <Text className="text-sm">
                        {report.work?.workId === work.workId ? "✓ " : ""}
                        {new Date(work.requestedAt).toLocaleString("ko-KR")}
                      </Text>
                    </Pressable>
                  ))}
                  {beforeSequence !== undefined ? (
                    <Pressable
                      accessibilityRole="button"
                      className="py-2"
                      onPress={() => {
                        setBeforeSequence(undefined);
                        setWorkId(undefined);
                      }}
                    >
                      <Text>최근 작업</Text>
                    </Pressable>
                  ) : null}
                  {report.nextBeforeSequence !== null ? (
                    <Pressable
                      accessibilityRole="button"
                      className="py-2"
                      onPress={() => {
                        setBeforeSequence(report.nextBeforeSequence!);
                        setWorkId(undefined);
                      }}
                    >
                      <Text>이전 작업</Text>
                    </Pressable>
                  ) : null}
                </View>
              </>
            ) : null}
          </ScrollView>
        </SafeAreaView>
      </Modal>
    </>
  );
}
