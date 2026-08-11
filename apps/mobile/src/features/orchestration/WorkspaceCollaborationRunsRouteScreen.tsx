import type {
  WorkspaceCollaborationRun,
  WorkspaceCollaborationRunStatus,
  WorkspaceFailureClassification,
  WorkspaceOrchestrationAgent,
  WorkspaceTaskAttempt,
  WorkspaceTaskGraphStatus,
  WorkspaceTaskNode,
  WorkspaceTaskNodeKind,
  WorkspaceTaskNodeStatus,
  WorkspaceValidationConfidence,
  WorkspaceRuntimeAttention,
  WorkspaceRuntimeEvidence,
  WorkspaceRuntimeLifecycleStatus,
  TerminalSummary,
} from "@t3tools/contracts";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, FlatList, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { ErrorBanner } from "../../components/ErrorBanner";
import { SymbolView } from "../../components/AppSymbol";
import { cn } from "../../lib/cn";
import { useThemeColor } from "../../lib/useThemeColor";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useProjects } from "../../state/entities";
import { orchestrationEnvironment } from "../../state/orchestration";
import { projectEnvironment } from "../../state/projects";
import { useEnvironmentQuery } from "../../state/query";
import { terminalEnvironment } from "../../state/terminal";
import { useAtomCommand } from "../../state/use-atom-command";
import { layoutMobileTaskGraph, type MobileTaskGraphLayout } from "./mobileTaskGraphLayout";

type RouteProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly projectId: string;
}>;

type TagTone = "neutral" | "info" | "success" | "warning" | "error";

const AGENT_LABELS: Readonly<Record<WorkspaceOrchestrationAgent, string>> = {
  fable: "페이블 · 총괄",
  codex: "코덱스 · 구현",
  grok: "그록 · 조사",
};

const NODE_KIND_LABELS: Readonly<Record<WorkspaceTaskNodeKind, string>> = {
  orchestration: "목표 분석·조정",
  research: "조사",
  implementation: "구현",
  debug: "오류 수정",
  validation: "검증",
  synthesis: "결과 종합",
};

const NODE_STATUS_LABELS: Readonly<Record<WorkspaceTaskNodeStatus, string>> = {
  blocked: "선행 작업 대기",
  queued: "실행 대기",
  running: "실행 중",
  "awaiting-validation": "검증 대기",
  completed: "완료",
  failed: "실패",
  cancelled: "취소",
  skipped: "건너뜀",
};

const RUN_STATUS_LABELS: Readonly<Record<WorkspaceCollaborationRunStatus, string>> = {
  queued: "실행 대기",
  running: "실행 중",
  "cancel-requested": "취소 요청됨",
  cancelled: "취소됨",
  completed: "완료",
  failed: "실패",
};

const GRAPH_STATUS_LABELS: Readonly<Record<WorkspaceTaskGraphStatus, string>> = {
  planning: "계획 수립 중",
  executing: "작업 실행 중",
  validating: "결과 검증 중",
  synthesizing: "결과 종합 중",
  completed: "완료",
  failed: "실패",
};

const CONFIDENCE_LABELS: Readonly<Record<WorkspaceValidationConfidence, string>> = {
  high: "신뢰도 높음",
  medium: "신뢰도 보통",
  low: "신뢰도 낮음",
};

const FAILURE_LABELS: Readonly<Record<WorkspaceFailureClassification, string>> = {
  information: "정보 부족",
  implementation: "구현 오류",
  tool: "도구 오류",
  assumption: "잘못된 가정",
  validation: "검증 실패",
};

function firstRouteParam(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function formatTimestamp(value: string | null): string {
  if (value === null) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("ko-KR");
}

function runTone(status: WorkspaceCollaborationRunStatus): TagTone {
  if (status === "completed") return "success";
  if (status === "failed") return "error";
  if (status === "running") return "info";
  if (status === "queued" || status === "cancel-requested") return "warning";
  return "neutral";
}

function lifecycleLabel(status: WorkspaceRuntimeLifecycleStatus): string {
  if (status === "working") return "실행 중";
  if (status === "failed") return "실행 오류";
  if (status === "idle") return "대기";
  return "확인 전";
}

function lifecycleTone(status: WorkspaceRuntimeLifecycleStatus): TagTone {
  if (status === "working") return "info";
  if (status === "failed") return "error";
  return "neutral";
}

function attentionLabel(attention: WorkspaceRuntimeAttention): string {
  if (attention === "error") return "오류 확인 필요";
  if (attention === "needs-input") return "내 입력 필요";
  if (attention === "completed-unseen") return "새 완료";
  return "새 알림 없음";
}

function attentionTone(attention: WorkspaceRuntimeAttention): TagTone {
  if (attention === "error") return "error";
  if (attention === "needs-input") return "warning";
  if (attention === "completed-unseen") return "success";
  return "neutral";
}

function evidenceSourceLabel(source: WorkspaceRuntimeEvidence["source"]): string {
  if (source === "thread") return "대화";
  if (source === "program") return "프로그램";
  if (source === "incident") return "장애";
  if (source === "collaboration") return "협업 실행";
  return "자동화";
}

function terminalStatusLabel(terminal: TerminalSummary): string {
  if (terminal.status === "running") {
    return terminal.hasRunningSubprocess ? "명령 실행 중" : "실행 중";
  }
  if (terminal.status === "starting") return "시작 중";
  if (terminal.status === "exited") return "종료됨";
  return "오류";
}

function terminalStatusTone(terminal: TerminalSummary): TagTone {
  if (terminal.status === "running") return terminal.hasRunningSubprocess ? "info" : "success";
  if (terminal.status === "starting") return "warning";
  if (terminal.status === "error") return "error";
  return "neutral";
}

function nodeTone(status: WorkspaceTaskNodeStatus): TagTone {
  if (status === "completed") return "success";
  if (status === "failed") return "error";
  if (status === "running") return "info";
  if (status === "blocked" || status === "awaiting-validation") return "warning";
  return "neutral";
}

function confidenceTone(confidence: WorkspaceValidationConfidence): TagTone {
  if (confidence === "high") return "success";
  if (confidence === "low") return "error";
  return "warning";
}

function Tag({ label, tone = "neutral" }: { readonly label: string; readonly tone?: TagTone }) {
  return (
    <View
      className={cn(
        "rounded-full px-2 py-1",
        tone === "neutral" && "bg-neutral-200/70 dark:bg-white/10",
        tone === "info" && "bg-sky-100 dark:bg-sky-400/15",
        tone === "success" && "bg-emerald-100 dark:bg-emerald-400/15",
        tone === "warning" && "bg-amber-100 dark:bg-amber-400/15",
        tone === "error" && "bg-rose-100 dark:bg-rose-400/15",
      )}
    >
      <Text
        className={cn(
          "text-2xs font-t3-bold",
          tone === "neutral" && "text-foreground-muted",
          tone === "info" && "text-sky-700 dark:text-sky-300",
          tone === "success" && "text-emerald-700 dark:text-emerald-300",
          tone === "warning" && "text-amber-800 dark:text-amber-300",
          tone === "error" && "text-rose-700 dark:text-rose-300",
        )}
      >
        {label}
      </Text>
    </View>
  );
}

function latestAttempt(node: WorkspaceTaskNode): WorkspaceTaskAttempt | null {
  return (
    node.attempts
      .slice()
      .sort(
        (left, right) =>
          left.number - right.number || left.startedAt.localeCompare(right.startedAt),
      )
      .at(-1) ?? null
  );
}

function nodeConfidence(node: WorkspaceTaskNode): WorkspaceValidationConfidence | null {
  return node.validation?.confidence ?? node.confidence ?? latestAttempt(node)?.confidence ?? null;
}

function nodeFailure(node: WorkspaceTaskNode): WorkspaceFailureClassification | null {
  return (
    node.validation?.failureClassification ??
    node.failureClassification ??
    latestAttempt(node)?.failureClassification ??
    null
  );
}

function AttemptRows({
  environmentId,
  node,
  onOpenThread,
}: {
  readonly environmentId: EnvironmentId;
  readonly node: WorkspaceTaskNode;
  readonly onOpenThread: (environmentId: EnvironmentId, attempt: WorkspaceTaskAttempt) => void;
}) {
  const attempts = node.attempts
    .slice()
    .sort(
      (left, right) => left.number - right.number || left.startedAt.localeCompare(right.startedAt),
    );
  if (attempts.length === 0) return null;

  return (
    <View className="gap-2 border-t border-border pt-3">
      <Text className="text-xs font-t3-bold text-foreground-muted">실행 시도</Text>
      {attempts.map((attempt) => (
        <View
          key={`${attempt.number}:${attempt.threadId}`}
          className="rounded-xl bg-fill px-3 py-2.5"
        >
          <View className="flex-row flex-wrap items-center gap-1.5">
            <Tag label={`${attempt.number}차`} />
            <Tag label={AGENT_LABELS[attempt.agent]} tone="info" />
            <Tag
              label={
                attempt.status === "completed"
                  ? "완료"
                  : attempt.status === "failed"
                    ? "실패"
                    : attempt.status === "cancelled"
                      ? "취소"
                      : "실행 중"
              }
              tone={
                attempt.status === "completed"
                  ? "success"
                  : attempt.status === "failed"
                    ? "error"
                    : attempt.status === "running"
                      ? "info"
                      : "neutral"
              }
            />
          </View>
          <Text className="mt-2 font-mono text-2xs text-foreground-muted" numberOfLines={2}>
            {attempt.modelSelection.instanceId} · {attempt.modelSelection.model}
          </Text>
          {attempt.error ? (
            <Text
              className="mt-2 text-xs leading-normal text-rose-700 dark:text-rose-300"
              numberOfLines={3}
            >
              {attempt.error}
            </Text>
          ) : null}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${attempt.number}차 시도 대화 열기`}
            className="mt-2 min-h-10 items-center justify-center rounded-xl border border-border bg-card px-3"
            onPress={() => onOpenThread(environmentId, attempt)}
            style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
          >
            <Text className="text-xs font-t3-bold text-foreground">대화 열기</Text>
          </Pressable>
        </View>
      ))}
    </View>
  );
}

function TaskNodeCard({
  environmentId,
  layout,
  node,
  parallel,
  unresolved,
  onOpenThread,
}: {
  readonly environmentId: EnvironmentId;
  readonly layout: MobileTaskGraphLayout;
  readonly node: WorkspaceTaskNode;
  readonly parallel: boolean;
  readonly unresolved: boolean;
  readonly onOpenThread: (environmentId: EnvironmentId, attempt: WorkspaceTaskAttempt) => void;
}) {
  const confidence = nodeConfidence(node);
  const failure = nodeFailure(node);
  const attempt = latestAttempt(node);
  const dependencies = [...new Set(node.dependsOn.map((dependencyId) => String(dependencyId)))];
  const missingDependencies = new Set(
    layout.missingDependencies
      .filter((entry) => entry.nodeId === String(node.id))
      .map((entry) => entry.dependencyId),
  );

  return (
    <View
      className={cn(
        "gap-3 rounded-2xl border bg-card p-3.5",
        unresolved || node.status === "failed"
          ? "border-rose-300/70 dark:border-rose-400/30"
          : "border-border",
      )}
    >
      <View className="flex-row flex-wrap items-center gap-1.5">
        {parallel ? <Tag label="병렬 작업" /> : null}
        <Tag label={NODE_KIND_LABELS[node.kind]} />
        <Tag label={NODE_STATUS_LABELS[node.status]} tone={nodeTone(node.status)} />
        <Tag label={AGENT_LABELS[node.agent]} tone="info" />
        {confidence ? (
          <Tag label={CONFIDENCE_LABELS[confidence]} tone={confidenceTone(confidence)} />
        ) : null}
        {failure ? <Tag label={FAILURE_LABELS[failure]} tone="error" /> : null}
      </View>

      <View className="gap-1">
        <Text className="text-base font-t3-bold text-foreground">{node.title}</Text>
        <Text className="text-sm leading-normal text-foreground-muted" numberOfLines={3}>
          {node.handoff.goal || node.handoff.task}
        </Text>
      </View>

      <View className="gap-1.5">
        <Text className="text-xs font-t3-bold text-foreground-muted">선행 작업</Text>
        {dependencies.length === 0 ? (
          <Text className="text-xs text-foreground-muted">바로 시작할 수 있는 작업</Text>
        ) : (
          <View className="flex-row flex-wrap gap-1.5">
            {dependencies.map((dependencyId) => (
              <Tag
                key={dependencyId}
                label={
                  missingDependencies.has(dependencyId)
                    ? `찾을 수 없음 · ${dependencyId}`
                    : (layout.nodeById.get(dependencyId)?.title ?? dependencyId)
                }
                tone={missingDependencies.has(dependencyId) ? "error" : "neutral"}
              />
            ))}
          </View>
        )}
      </View>

      {attempt ? (
        <View className="rounded-xl bg-fill px-3 py-2.5">
          <Text className="text-xs font-t3-bold text-foreground-muted">현재 실행 계정</Text>
          <Text className="mt-1 font-mono text-2xs text-foreground" numberOfLines={2}>
            {attempt.modelSelection.instanceId} · {attempt.modelSelection.model}
          </Text>
        </View>
      ) : null}

      {node.validation ? (
        <View className="gap-1.5 rounded-xl bg-fill px-3 py-2.5">
          <Text className="text-xs font-t3-bold text-foreground">검증 결과</Text>
          <Text className="text-xs leading-normal text-foreground-muted" numberOfLines={4}>
            {node.validation.summary}
          </Text>
          {node.validation.nextAction.trim() ? (
            <Text className="text-xs leading-normal text-foreground">
              다음 행동 · {node.validation.nextAction}
            </Text>
          ) : null}
        </View>
      ) : null}

      {node.error ? (
        <Text className="text-xs leading-normal text-rose-700 dark:text-rose-300" numberOfLines={4}>
          {node.error}
        </Text>
      ) : node.output ? (
        <Text className="text-xs leading-normal text-foreground-muted" numberOfLines={4}>
          {node.output}
        </Text>
      ) : null}

      <AttemptRows environmentId={environmentId} node={node} onOpenThread={onOpenThread} />
    </View>
  );
}

function MobileGraphSummary({
  environmentId,
  graph,
  onOpenThread,
}: {
  readonly environmentId: EnvironmentId;
  readonly graph: NonNullable<WorkspaceCollaborationRun["graph"]>;
  readonly onOpenThread: (environmentId: EnvironmentId, attempt: WorkspaceTaskAttempt) => void;
}) {
  const layout = useMemo(() => layoutMobileTaskGraph(graph.nodes), [graph.nodes]);

  return (
    <View className="gap-3">
      <View className="gap-2 rounded-2xl bg-fill p-3.5">
        <View className="flex-row flex-wrap items-center gap-1.5">
          <Tag
            label={GRAPH_STATUS_LABELS[graph.status]}
            tone={
              graph.status === "failed"
                ? "error"
                : graph.status === "completed"
                  ? "success"
                  : "info"
            }
          />
          <Tag label={`개정 ${graph.revision}`} />
          <Tag label={`작업 ${layout.nodeById.size}개`} />
        </View>
        <Text className="text-sm leading-normal text-foreground">
          <Text className="font-t3-bold">다음 행동 · </Text>
          {graph.nextAction.trim() || "다음 행동을 결정하는 중입니다."}
        </Text>
      </View>

      {layout.hasStructuralIssues ? (
        <ErrorBanner
          message={`그래프 일부를 안전하게 분리했습니다. 중복 ${layout.duplicateNodeIds.length}개 · 누락된 선행 작업 ${layout.missingDependencies.length}개 · 해결 불가 ${layout.unresolvedNodeIds.length}개`}
        />
      ) : null}

      {layout.levels.length === 0 ? (
        <View className="rounded-2xl border border-dashed border-border px-4 py-8">
          <Text className="text-center text-sm font-t3-bold text-foreground">
            작업 그래프를 만드는 중입니다.
          </Text>
        </View>
      ) : (
        layout.levels.map((level, levelIndex) => (
          <View key={`${level.depth}:${level.unresolved}`} className="gap-2.5">
            {levelIndex > 0 ? <View className="h-5 w-0.5 self-center bg-border" /> : null}
            <View className="flex-row items-center gap-2 px-1">
              <View
                className={cn(
                  "h-6 min-w-6 items-center justify-center rounded-full px-1.5",
                  level.unresolved
                    ? "bg-rose-100 dark:bg-rose-400/15"
                    : "bg-neutral-200/70 dark:bg-white/10",
                )}
              >
                <Text
                  className={cn(
                    "text-2xs font-t3-bold",
                    level.unresolved ? "text-rose-700 dark:text-rose-300" : "text-foreground-muted",
                  )}
                >
                  {level.unresolved ? "!" : level.depth + 1}
                </Text>
              </View>
              <Text className="flex-1 text-xs font-t3-bold text-foreground-muted">
                {level.unresolved ? "구조 확인 필요" : `${level.depth + 1}단계`}
              </Text>
              <Text className="text-2xs text-foreground-muted">
                {level.unresolved
                  ? `노드 ${level.nodes.length}개`
                  : level.nodes.length > 1
                    ? `병렬 ${level.nodes.length}개`
                    : "단일 작업"}
              </Text>
            </View>
            {level.nodes.map((node) => (
              <TaskNodeCard
                key={String(node.id)}
                environmentId={environmentId}
                layout={layout}
                node={node}
                parallel={level.nodes.length > 1}
                unresolved={level.unresolved}
                onOpenThread={onOpenThread}
              />
            ))}
          </View>
        ))
      )}
    </View>
  );
}

function LegacyRunSummary({ run }: { readonly run: WorkspaceCollaborationRun }) {
  return (
    <View className="gap-2 rounded-2xl bg-fill p-3.5">
      <Text className="text-xs font-t3-bold text-foreground-muted">이전 실행 형식</Text>
      {run.steps.map((step) => (
        <View key={step.index} className="flex-row items-center gap-2">
          <View className="h-2 w-2 rounded-full bg-neutral-400" />
          <Text className="flex-1 text-xs text-foreground" numberOfLines={1}>
            {step.index + 1}. {step.displayName}
          </Text>
          <Text className="text-2xs text-foreground-muted">
            {step.status === "completed"
              ? "완료"
              : step.status === "failed"
                ? "실패"
                : step.status === "running"
                  ? "실행 중"
                  : step.status === "cancelled"
                    ? "취소"
                    : "대기"}
          </Text>
        </View>
      ))}
      {run.error ? (
        <Text className="text-xs leading-normal text-rose-700 dark:text-rose-300" numberOfLines={4}>
          {run.error}
        </Text>
      ) : null}
    </View>
  );
}

function RunCard({
  cancelling,
  environmentId,
  run,
  onCancel,
  onOpenThread,
}: {
  readonly cancelling: boolean;
  readonly environmentId: EnvironmentId;
  readonly run: WorkspaceCollaborationRun;
  readonly onCancel: (run: WorkspaceCollaborationRun) => void;
  readonly onOpenThread: (environmentId: EnvironmentId, attempt: WorkspaceTaskAttempt) => void;
}) {
  const [expanded, setExpanded] = useState(run.status === "queued" || run.status === "running");
  const iconColor = useThemeColor("--color-icon-muted");
  const canCancel = run.status === "queued" || run.status === "running";

  return (
    <View className="overflow-hidden rounded-3xl border border-border bg-card">
      <View className="flex-row items-start gap-2 px-4 py-3.5">
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded }}
          accessibilityLabel={`${run.task}, ${RUN_STATUS_LABELS[run.status]}`}
          className="min-w-0 flex-1"
          onPress={() => setExpanded((value) => !value)}
          style={({ pressed }) => ({ opacity: pressed ? 0.65 : 1 })}
        >
          <View className="flex-row flex-wrap items-center gap-1.5">
            <Tag label={RUN_STATUS_LABELS[run.status]} tone={runTone(run.status)} />
            <Tag
              label={
                run.source === "user"
                  ? "사용자 요청"
                  : run.source === "schedule"
                    ? "예약 실행"
                    : run.source === "integrity"
                      ? "무결성 수렴"
                      : "장애 복구"
              }
            />
          </View>
          <Text
            className="mt-2 text-base font-t3-bold leading-tight text-foreground"
            numberOfLines={expanded ? 4 : 2}
          >
            {run.task}
          </Text>
          <Text className="mt-1 text-2xs text-foreground-muted">
            {formatTimestamp(run.createdAt)}
          </Text>
        </Pressable>
        <View className="items-end gap-2">
          <SymbolView
            name={expanded ? "chevron.up" : "chevron.down"}
            size={16}
            tintColor={iconColor}
            type="monochrome"
          />
          {canCancel ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="협업 실행 취소"
              disabled={cancelling}
              className="min-h-9 justify-center rounded-full border border-rose-300/70 px-3 dark:border-rose-400/30"
              onPress={() => onCancel(run)}
              style={({ pressed }) => ({ opacity: cancelling ? 0.4 : pressed ? 0.6 : 1 })}
            >
              <Text className="text-2xs font-t3-bold text-rose-700 dark:text-rose-300">
                {cancelling ? "취소 요청 중" : "실행 취소"}
              </Text>
            </Pressable>
          ) : null}
        </View>
      </View>

      {expanded ? (
        <View className="gap-3 border-t border-border px-3 py-3.5">
          {run.graph ? (
            <MobileGraphSummary
              environmentId={environmentId}
              graph={run.graph}
              onOpenThread={onOpenThread}
            />
          ) : (
            <LegacyRunSummary run={run} />
          )}
          {run.finalOutput ? (
            <View className="gap-1 rounded-2xl bg-fill p-3.5">
              <Text className="text-xs font-t3-bold text-foreground">최종 종합 결과</Text>
              <Text className="text-xs leading-normal text-foreground-muted" numberOfLines={8}>
                {run.finalOutput}
              </Text>
            </View>
          ) : null}
          {run.error ? (
            <Text
              className="px-1 text-xs leading-normal text-rose-700 dark:text-rose-300"
              numberOfLines={5}
            >
              {run.error}
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

export function WorkspaceCollaborationRunsRouteScreen(props: RouteProps) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const projects = useProjects();
  const iconColor = useThemeColor("--color-icon-muted");
  const environmentIdRaw = firstRouteParam(props.route.params.environmentId)?.trim() || null;
  const projectIdRaw = firstRouteParam(props.route.params.projectId)?.trim() || null;
  const environmentId = environmentIdRaw ? EnvironmentId.make(environmentIdRaw) : null;
  const projectId = projectIdRaw ? ProjectId.make(projectIdRaw) : null;
  const project =
    environmentId === null || projectId === null
      ? null
      : (projects.find(
          (candidate) => candidate.environmentId === environmentId && candidate.id === projectId,
        ) ?? null);
  const runsQuery = useEnvironmentQuery(
    environmentId !== null && projectId !== null
      ? orchestrationEnvironment.workspaceCollaborationRuns({
          environmentId,
          input: { projectId },
        })
      : null,
  );
  const runtimeQuery = useEnvironmentQuery(
    environmentId !== null && projectId !== null
      ? orchestrationEnvironment.workspaceRuntime({
          environmentId,
          input: { projectId },
        })
      : null,
  );
  const terminalsQuery = useEnvironmentQuery(
    environmentId === null
      ? null
      : terminalEnvironment.metadata({
          environmentId,
          input: null,
        }),
  );
  const markViewed = useAtomCommand(projectEnvironment.markWorkspaceRuntimeViewed, {
    label: "모바일 프로젝트 완료 상태 확인",
    reportFailure: false,
  });
  const cancelRun = useAtomCommand(projectEnvironment.cancelWorkspaceCollaborationRun, {
    label: "모바일 협업 실행 취소",
    reportFailure: false,
  });
  const [cancellingRunIds, setCancellingRunIds] = useState<ReadonlySet<string>>(new Set());
  const lastViewedReceiptRef = useRef<string | null>(null);
  const lastOperationsRevisionRef = useRef<string | null | undefined>(undefined);
  const runs = useMemo(
    () =>
      (runsQuery.data?.runs ?? [])
        .slice()
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
    [runsQuery.data?.runs],
  );
  const projectTerminals = useMemo(
    () =>
      (terminalsQuery.data ?? [])
        .filter((terminal) => terminal.projectId === String(projectId))
        .slice()
        .sort((left, right) => {
          const leftLive = left.status === "running" || left.status === "starting" ? 0 : 1;
          const rightLive = right.status === "running" || right.status === "starting" ? 0 : 1;
          return leftLive - rightLive || right.updatedAt.localeCompare(left.updatedAt);
        }),
    [projectId, terminalsQuery.data],
  );

  useEffect(() => {
    const snapshot = runtimeQuery.data;
    if (
      environmentId === null ||
      projectId === null ||
      snapshot?.attention !== "completed-unseen" ||
      snapshot.latestCompletionAt === null ||
      lastViewedReceiptRef.current === snapshot.latestCompletionAt
    ) {
      return;
    }
    lastViewedReceiptRef.current = snapshot.latestCompletionAt;
    void markViewed({
      environmentId,
      input: { projectId, viewedThrough: snapshot.latestCompletionAt },
    }).then((result) => {
      if (result._tag !== "Success") lastViewedReceiptRef.current = null;
    });
  }, [environmentId, markViewed, projectId, runtimeQuery.data]);

  useEffect(() => {
    if (runtimeQuery.data === null) return;
    const revision = runtimeQuery.data.operationsUpdatedAt;
    if (lastOperationsRevisionRef.current === undefined) {
      lastOperationsRevisionRef.current = revision;
      return;
    }
    if (lastOperationsRevisionRef.current === revision) return;
    lastOperationsRevisionRef.current = revision;
    runsQuery.refresh();
  }, [runsQuery.refresh, runtimeQuery.data]);

  const openEvidence = useCallback(
    (item: WorkspaceRuntimeEvidence) => {
      if (environmentId === null || item.source !== "thread") return;
      navigation.navigate("Thread", {
        environmentId: String(environmentId),
        threadId: item.sourceId,
      });
    },
    [environmentId, navigation],
  );

  const openAttemptThread = useCallback(
    (targetEnvironmentId: EnvironmentId, attempt: WorkspaceTaskAttempt) => {
      navigation.navigate("Thread", {
        environmentId: String(targetEnvironmentId),
        threadId: String(attempt.threadId),
      });
    },
    [navigation],
  );

  const openTerminal = useCallback(
    (terminal: TerminalSummary) => {
      if (environmentId === null) return;
      navigation.navigate("ThreadTerminal", {
        environmentId: String(environmentId),
        threadId: terminal.threadId,
        terminalId: terminal.terminalId,
      });
    },
    [environmentId, navigation],
  );

  const executeCancel = useCallback(
    async (run: WorkspaceCollaborationRun) => {
      if (environmentId === null || projectId === null) return;
      const runId = String(run.id);
      setCancellingRunIds((current) => new Set(current).add(runId));
      try {
        const result = await cancelRun({
          environmentId,
          input: { projectId, runId: run.id },
        });
        if (result._tag !== "Success") {
          Alert.alert("취소하지 못했습니다.", "서버에 취소 요청을 전달하지 못했습니다.");
          return;
        }
        runsQuery.refresh();
      } finally {
        setCancellingRunIds((current) => {
          const next = new Set(current);
          next.delete(runId);
          return next;
        });
      }
    },
    [cancelRun, environmentId, projectId, runsQuery],
  );

  const requestCancel = useCallback(
    (run: WorkspaceCollaborationRun) => {
      Alert.alert(
        "협업 실행을 취소할까요?",
        "실행 중인 에이전트 대화에도 취소 요청이 전달됩니다.",
        [
          { text: "계속 실행", style: "cancel" },
          { text: "실행 취소", style: "destructive", onPress: () => void executeCancel(run) },
        ],
      );
    },
    [executeCancel],
  );

  return (
    <View collapsable={false} className="flex-1 bg-screen">
      <NativeStackScreenOptions
        options={{ title: project ? `${project.title} 운영` : "프로젝트 운영" }}
      />
      <FlatList
        data={runs}
        keyExtractor={(run) => String(run.id)}
        initialNumToRender={4}
        showsVerticalScrollIndicator={false}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-3 px-4 pt-3"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 16) + 24 }}
        ListHeaderComponent={
          <View className="mb-1 gap-3">
            <View className="flex-row items-start gap-3 rounded-2xl bg-fill p-3.5">
              <View className="min-w-0 flex-1 gap-1">
                <Text className="text-lg font-t3-bold text-foreground">프로젝트 운영 현황</Text>
                <Text className="text-sm leading-normal text-foreground-muted">
                  대화·프로그램·장애·자동화와 협업 실행의 현재 상태를 한 프로젝트 안에서 확인합니다.
                </Text>
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="프로젝트 운영 상태 새로고침"
                className="h-10 w-10 items-center justify-center rounded-full border border-border bg-card"
                onPress={() => {
                  runtimeQuery.refresh();
                  runsQuery.refresh();
                  terminalsQuery.refresh();
                }}
                style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
              >
                <SymbolView
                  name="arrow.clockwise"
                  size={17}
                  tintColor={iconColor}
                  type="monochrome"
                />
              </Pressable>
            </View>
            {runtimeQuery.data ? (
              <View className="gap-3 rounded-2xl border border-border bg-card p-3.5">
                <View className="flex-row flex-wrap items-center gap-2">
                  <Tag
                    label={lifecycleLabel(runtimeQuery.data.lifecycleStatus)}
                    tone={lifecycleTone(runtimeQuery.data.lifecycleStatus)}
                  />
                  <Tag
                    label={attentionLabel(runtimeQuery.data.attention)}
                    tone={attentionTone(runtimeQuery.data.attention)}
                  />
                  <Text className="ml-auto text-xs text-foreground-muted">
                    {formatTimestamp(runtimeQuery.data.updatedAt)}
                  </Text>
                </View>
                <View className="flex-row flex-wrap gap-2">
                  {[
                    ["작업 중 대화", runtimeQuery.data.counts.workingThreadCount],
                    ["내 입력", runtimeQuery.data.counts.blockedThreadCount],
                    ["오류", runtimeQuery.data.counts.failedThreadCount],
                    ["프로그램", runtimeQuery.data.counts.activeProgramCount],
                    ["열린 장애", runtimeQuery.data.counts.openIncidentCount],
                    ["새 완료", runtimeQuery.data.counts.completedUnseenCount],
                  ].map(([label, value]) => (
                    <View key={label} className="min-w-[30%] flex-1 rounded-xl bg-fill px-3 py-2.5">
                      <Text className="text-2xs text-foreground-muted">{label}</Text>
                      <Text className="mt-0.5 text-lg font-t3-bold tabular-nums text-foreground">
                        {value}
                      </Text>
                    </View>
                  ))}
                </View>
                {runtimeQuery.data.evidence.slice(0, 6).map((item) => (
                  <Pressable
                    key={`${item.source}:${item.sourceId}:${item.status}`}
                    accessibilityRole={item.source === "thread" ? "button" : undefined}
                    accessibilityLabel={`${evidenceSourceLabel(item.source)} ${item.title}`}
                    disabled={item.source !== "thread"}
                    className="flex-row items-start gap-2 border-t border-border pt-3"
                    onPress={() => openEvidence(item)}
                    style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
                  >
                    <View className="min-w-0 flex-1 gap-0.5">
                      <Text className="text-sm font-t3-bold text-foreground" numberOfLines={1}>
                        {item.title}
                      </Text>
                      <Text className="text-xs text-foreground-muted" numberOfLines={2}>
                        {evidenceSourceLabel(item.source)} · {item.detail ?? "상세 정보 없음"}
                      </Text>
                    </View>
                    {item.source === "thread" ? (
                      <SymbolView
                        name="chevron.right"
                        size={13}
                        tintColor={iconColor}
                        type="monochrome"
                      />
                    ) : null}
                  </Pressable>
                ))}
              </View>
            ) : null}
            <View className="gap-2 rounded-2xl border border-border bg-card p-3.5">
              <View className="flex-row items-center justify-between gap-3">
                <View className="min-w-0 flex-1">
                  <Text className="text-base font-t3-bold text-foreground">프로젝트 터미널</Text>
                  <Text className="mt-0.5 text-xs leading-normal text-foreground-muted">
                    이 프로젝트에 속한 모든 터미널을 한곳에서 확인하고 다시 엽니다.
                  </Text>
                </View>
                <Tag label={`${projectTerminals.length}개`} />
              </View>
              {projectTerminals.length === 0 ? (
                <View className="rounded-xl border border-dashed border-border px-3 py-4">
                  <Text className="text-center text-xs text-foreground-muted">
                    아직 이 프로젝트에서 열린 터미널이 없습니다.
                  </Text>
                </View>
              ) : (
                projectTerminals.slice(0, 8).map((terminal) => (
                  <Pressable
                    key={`${terminal.threadId}:${terminal.terminalId}`}
                    accessibilityRole="button"
                    accessibilityLabel={`${terminal.label} 터미널 열기`}
                    className="flex-row items-center gap-3 rounded-xl bg-fill px-3 py-3"
                    onPress={() => openTerminal(terminal)}
                    style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
                  >
                    <SymbolView name="terminal" size={17} tintColor={iconColor} type="monochrome" />
                    <View className="min-w-0 flex-1 gap-0.5">
                      <Text className="text-sm font-t3-bold text-foreground" numberOfLines={1}>
                        {terminal.label}
                      </Text>
                      <Text className="text-xs text-foreground-muted" numberOfLines={1}>
                        {terminal.cwd} · {terminal.controllerAttached ? "조작 중" : "관찰 가능"}
                        {(terminal.observerCount ?? 0) > 0
                          ? ` · 관찰 ${terminal.observerCount ?? 0}명`
                          : ""}
                      </Text>
                    </View>
                    <Tag
                      label={terminalStatusLabel(terminal)}
                      tone={terminalStatusTone(terminal)}
                    />
                    <SymbolView
                      name="chevron.right"
                      size={13}
                      tintColor={iconColor}
                      type="monochrome"
                    />
                  </Pressable>
                ))
              )}
              {projectTerminals.length > 8 ? (
                <Text className="text-center text-xs text-foreground-muted">
                  최근 터미널 8개를 표시했습니다.
                </Text>
              ) : null}
            </View>
            {environmentId === null || projectId === null ? (
              <ErrorBanner message="프로젝트 경로가 올바르지 않습니다." />
            ) : runtimeQuery.error || runsQuery.error ? (
              <ErrorBanner message="프로젝트 운영 상태를 불러오지 못했습니다." />
            ) : runsQuery.isPending && runsQuery.data === null ? (
              <View className="rounded-2xl border border-dashed border-border px-4 py-6">
                <Text className="text-center text-sm text-foreground-muted">
                  실행 목록을 불러오는 중입니다.
                </Text>
              </View>
            ) : null}
          </View>
        }
        ListEmptyComponent={
          !runsQuery.isPending && runsQuery.error === null ? (
            <View className="rounded-2xl border border-dashed border-border px-4 py-10">
              <Text className="text-center text-base font-t3-bold text-foreground">
                아직 협업 실행이 없습니다.
              </Text>
              <Text className="mt-1 text-center text-sm text-foreground-muted">
                웹 또는 데스크톱의 프로젝트 운영 화면에서 새 협업 작업을 시작할 수 있습니다.
              </Text>
            </View>
          ) : null
        }
        renderItem={({ item }) => (
          <RunCard
            cancelling={cancellingRunIds.has(String(item.id))}
            environmentId={environmentId!}
            run={item}
            onCancel={requestCancel}
            onOpenThread={openAttemptThread}
          />
        )}
      />
    </View>
  );
}
