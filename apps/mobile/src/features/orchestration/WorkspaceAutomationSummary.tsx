import { useEffect, useRef, useState } from "react";
import { Modal, Pressable, View } from "react-native";
import type { EnvironmentId, ProjectId, WorkspaceAutomationEvidenceRef } from "@t3tools/contracts";
import { AppText as Text } from "../../components/AppText";
import { ErrorBanner } from "../../components/ErrorBanner";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentQuery } from "../../state/query";
import { WorkspaceAutomationEvidencePreview } from "./WorkspaceAutomationEvidencePreview";
import { WorkspaceTaskInbox } from "./WorkspaceTaskInbox";

function Evidence({
  environmentId,
  projectId,
  evidence,
  close,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  evidence: WorkspaceAutomationEvidenceRef;
  close: () => void;
}) {
  const result = useEnvironmentQuery(
    orchestrationEnvironment.workspaceAutomationEvidence({
      environmentId,
      input: { projectId, ...evidence },
    }),
  );
  return (
    <Modal visible animationType="none" presentationStyle="pageSheet" onRequestClose={close}>
      <View className="flex-1 gap-3 bg-screen px-4 pb-8 pt-6">
        <Text className="text-lg font-semibold text-foreground">검증 실행 자료</Text>
        <Text className="text-sm text-foreground-muted">{evidence.label}</Text>
        <Pressable
          accessibilityRole="button"
          onPress={close}
          className="rounded-xl border border-border p-3"
        >
          <Text className="text-center text-foreground">닫기</Text>
        </Pressable>
        {result.error ? <ErrorBanner message={result.error} /> : null}
        {result.data ? (
          <WorkspaceAutomationEvidencePreview evidence={result.data} />
        ) : !result.error ? (
          <Text className="text-foreground-muted">검증 자료를 불러오는 중…</Text>
        ) : null}
      </View>
    </Modal>
  );
}
export function WorkspaceAutomationSummary({
  environmentId,
  projectId,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
}) {
  const [expanded, setExpanded] = useState(false);
  const [evidence, setEvidence] = useState<WorkspaceAutomationEvidenceRef | null>(null);
  const result = useEnvironmentQuery(
    orchestrationEnvironment.workspaceAutomation({ environmentId, input: { projectId } }),
  );
  const runtime = useEnvironmentQuery(
    orchestrationEnvironment.workspaceRuntime({ environmentId, input: { projectId } }),
  );
  const last = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (!runtime.data) return;
    const revision = runtime.data.operationsUpdatedAt;
    if (last.current !== undefined && last.current !== revision) result.refresh();
    last.current = revision;
  }, [runtime.data, result.refresh]);
  const overview = result.data;
  return (
    <View className="gap-3">
      <WorkspaceTaskInbox key={projectId} environmentId={environmentId} projectId={projectId} />
      <View className="gap-3 rounded-2xl border border-border bg-card p-4">
        <View className="flex-row items-center justify-between">
          <Text className="text-base font-semibold text-foreground">자동 작업 성과</Text>
          <Pressable accessibilityRole="button" onPress={result.refresh}>
            <Text className="text-sm text-primary">새로고침</Text>
          </Pressable>
        </View>
        {result.error ? <ErrorBanner message={result.error} /> : null}
        {overview ? (
          <>
            <Text className="text-sm text-foreground">
              완료 {overview.metrics.completed} · 명령 검증 통과 {overview.metrics.verified} · 진행{" "}
              {overview.metrics.active} · 실패 {overview.metrics.failed}
            </Text>
            <Text className="text-xs text-foreground-muted">
              최근 {overview.rows.length}/{overview.totalRows}건 · 재시도 없이 완료{" "}
              {overview.metrics.firstAttemptCompleted}건 · 재시도 {overview.metrics.retried}건 (기록{" "}
              {overview.metrics.knownAttemptRows}건) · 수집 토큰{" "}
              {overview.metrics.measuredTokens?.toLocaleString() ?? "없음"} (
              {overview.metrics.measuredRows}건, 부분 집계 포함)
            </Text>
            <Text className="text-xs text-foreground-muted">
              에이전트 통과 보고와 실제 명령 검증은 별도로 표시합니다. 예약{" "}
              {overview.totalSchedules}개
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ expanded }}
              onPress={() => setExpanded((value) => !value)}
              className="rounded-xl border border-border p-3"
            >
              <Text className="text-foreground">
                {expanded ? "작업 기록 접기" : "작업·검증 기록 펼치기"}
              </Text>
            </Pressable>
            {expanded
              ? overview.rows.map((row) => (
                  <View key={row.id} className="gap-2 border-t border-border pt-3">
                    <Text className="text-sm text-foreground">{row.title}</Text>
                    <Text className="text-xs text-foreground-muted">
                      {row.status} ·{" "}
                      {row.verification === "passed"
                        ? "명령 검증 통과"
                        : row.verification === "reported-pass"
                          ? "에이전트 통과 보고"
                          : row.verification === "failed"
                            ? "명령 검증 실패"
                            : row.verification === "stale"
                              ? "검증 갱신 필요"
                              : row.verification === "reported-fail"
                                ? "에이전트 검증 보류·실패"
                                : "검증 기록 없음"}{" "}
                      · 재시도 {row.retries ?? "미수집"} · 토큰{" "}
                      {row.measuredTokens?.toLocaleString() ?? "미수집"}
                    </Text>
                    {row.evidence.map((item) => (
                      <Pressable
                        key={`${item.kind}:${item.recordId}:${item.index}`}
                        accessibilityRole="button"
                        onPress={() => setEvidence(item)}
                        className="rounded-xl border border-border p-3"
                      >
                        <Text className="text-xs text-primary">{item.label}</Text>
                      </Pressable>
                    ))}
                  </View>
                ))
              : null}
          </>
        ) : !result.error ? (
          <Text className="text-sm text-foreground-muted">성과 기록을 불러오는 중…</Text>
        ) : null}
        {evidence ? (
          <Evidence
            environmentId={environmentId}
            projectId={projectId}
            evidence={evidence}
            close={() => setEvidence(null)}
          />
        ) : null}
      </View>
    </View>
  );
}
