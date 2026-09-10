import { HandoffSettings } from "./HandoffSettings";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  formatTokenCount,
  tokenUsageCountLabels,
  tokenUsageIssueLabel,
  tokenUsagePhaseLabel,
  tokenUsageSummary,
  tokenUsageOutcomeLabel,
} from "@t3tools/client-runtime/state/token-usage";
import { useEffect, useRef, useState } from "react";
import { Modal, Pressable, ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { AppText as Text } from "../../components/AppText";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentQuery } from "../../state/query";

export function TokenUsageButton(props: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  busy: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [workId, setWorkId] = useState<string | undefined>();
  const [beforeSequence, setBeforeSequence] = useState<number | undefined>();
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
  const lastBusy = useRef(props.busy);
  useEffect(() => {
    if (lastBusy.current !== props.busy) {
      lastBusy.current = props.busy;
      query.refresh();
    }
  }, [props.busy, query.refresh]);
  const report = query.data;
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="작업 토큰 사용량 상세"
        className="self-end px-4 py-2"
        onPress={() => {
          setOpen(true);
          query.refresh();
        }}
      >
        <Text className="text-xs text-muted-foreground">
          {query.error ? "사용량 조회 실패" : tokenUsageSummary(report)}
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
            <Text className="font-t3-bold text-base">작업 토큰 사용량</Text>
            <Pressable
              accessibilityRole="button"
              onPress={() => setOpen(false)}
              className="px-3 py-2"
            >
              <Text>닫기</Text>
            </Pressable>
          </View>
          <ScrollView contentContainerStyle={{ padding: 20, gap: 16 }}>
            <HandoffSettings {...props} />
            <Pressable
              accessibilityRole="button"
              onPress={query.refresh}
              disabled={query.isPending}
            >
              <Text className="text-blue-600 dark:text-blue-400">
                {query.isPending ? "갱신 중" : "새로고침"}
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
