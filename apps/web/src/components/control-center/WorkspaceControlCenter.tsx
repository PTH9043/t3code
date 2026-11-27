import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useMatch, useNavigate } from "@tanstack/react-router";
import {
  CommandId,
  DEFAULT_WORKSPACE_AGENT_KNOWLEDGE_SETTINGS,
  DEFAULT_WORKSPACE_CONVERSATION_RAG_SETTINGS,
  DEFAULT_WORKSPACE_ORCHESTRA_DEFAULTS,
  formatPdfSearchEditionLabel,
  ProviderInstanceId,
  ThreadId,
  WorkspaceKnowledgeItemId,
  WorkspaceScheduleId,
  WorkspaceCollaborationRunId,
  type ProviderInteractionMode,
  type RuntimeMode,
  type TerminalSummary,
  type WorkspaceAgentRole,
  type WorkspaceAgentRoleBinding,
  type WorkspaceKnowledgeKind,
  type WorkspaceKnowledgeItem,
  type WorkspaceKnowledgeScope,
  type WorkspaceRuntimeEvidence,
  type WorkspaceRuntimeAttention,
  type WorkspaceRuntimeLifecycleStatus,
  type WorkspaceRuntimeStatus,
  type WorkspaceSchedule,
  type WorkspaceScheduleTiming,
} from "@t3tools/contracts";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  AlarmClockIcon,
  ActivityIcon,
  AlertTriangleIcon,
  ArchiveIcon,
  BotIcon,
  CalendarClockIcon,
  CheckIcon,
  CrownIcon,
  DatabaseIcon,
  DownloadIcon,
  FileStackIcon,
  FolderCogIcon,
  PlusIcon,
  RefreshCcwIcon,
  SearchIcon,
  ShieldCheckIcon,
  SparklesIcon,
  TerminalIcon,
  Trash2Icon,
} from "lucide-react";

import {
  deriveProviderInstanceEntries,
  groupProviderInstanceEntriesByDriver,
} from "~/providerInstances";
import { randomUUID } from "~/lib/utils";
import { orchestrationEnvironment } from "~/state/orchestration";
import { projectEnvironment } from "~/state/projects";
import { terminalEnvironment } from "~/state/terminal";
import { useTerminalUiStateStore } from "~/terminalUiStateStore";
import { useServerConfigs } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "../ui/dialog";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { ProviderAccountUsage } from "../settings/ProviderAccountUsage";
import { McpToolsSection } from "../settings/McpToolsSection";
import { WorkspaceDesignReference } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { KNOWLEDGE_KIND_LABELS } from "../knowledge/knowledgeKinds";
import { KnowledgeDocLink, knowledgeDashboardRoute } from "../knowledge/KnowledgeDocLink";
import { KnowledgeExcerpt } from "../knowledge/StoredKnowledgeOriginal";
import { restoreWikiDocument } from "../knowledge/knowledgeApi";
import { DesignReferenceFields, DesignReferencePreview } from "./DesignReferenceFields";
import {
  CompletionAutomationSection,
  CompletionAutomationReceipts,
} from "./CompletionAutomationSection";
import { ConversationTransferSection } from "./ConversationTransferSection";
import { ExtensionsSection } from "../settings/ExtensionsSection";
import { WorkspaceMonitoringSection } from "./WorkspaceMonitoringSection";
import { WorkspaceProgramsSection } from "./WorkspaceProgramsSection";
import { CollaborationSection } from "./CollaborationSection";
import { WorkspaceAutomationSection } from "./WorkspaceAutomationSection";
import { WorkspacePromptDiagnostics, WorkspacePromptTokens } from "./WorkspacePromptDiagnostics";
import { WorkspaceResearchPanel } from "./WorkspaceResearchPanel";
import {
  renderWorkspaceKnowledgePrintView,
  serializeWorkspaceKnowledgeExport,
  serializeWorkspaceKnowledgeMarkdown,
  type KnowledgeExportScope,
} from "./workspaceKnowledgeExport";
import { ExecutionProfiles, ExecutionProfileSelect } from "./ExecutionProfiles";
import { AttentionInbox } from "./AttentionInbox";
import { MissionControlView } from "./missionControl/MissionControlView";
import {
  WorkspaceSectionNav,
  defaultSectionForDomain,
  getControlCenterSection,
  resolveControlCenterTabState,
  type ControlCenterDomainId,
  type ControlCenterSectionId,
} from "./WorkspaceSectionNav";
import { useEnvironmentSettings } from "~/hooks/useSettings";
import {
  ROLE_LABELS,
  SectionCard,
  formatTimestamp,
  notifyCommandFailure,
  notifySuccess,
  useOperationsRevisionRefresh,
} from "./controlCenterShared";

const decodeDesign = Schema.decodeUnknownSync(WorkspaceDesignReference);

const SELECT_CLASS =
  "h-9 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground outline-none transition-shadow focus:border-ring focus:ring-3 focus:ring-ring/20 dark:bg-input/32";

const ALL_ROLES = Object.keys(ROLE_LABELS) as WorkspaceAgentRole[];
const ALL_KNOWLEDGE_KINDS = Object.keys(KNOWLEDGE_KIND_LABELS) as WorkspaceKnowledgeKind[];

function providerStatusLabel(status: string): string {
  if (status === "ready") return "준비됨";
  if (status === "warning") return "주의";
  if (status === "error") return "오류";
  if (status === "disabled") return "사용 안 함";
  return status;
}

function runtimeStatusLabel(status: WorkspaceRuntimeStatus): string {
  if (status === "working") return "작업 중";
  if (status === "blocked") return "확인 필요";
  if (status === "failed") return "오류";
  if (status === "done") return "완료";
  if (status === "idle") return "유휴";
  return "확인 전";
}

function runtimeStatusVariant(
  status: WorkspaceRuntimeStatus,
): "success" | "warning" | "error" | "outline" | "info" {
  if (status === "done") return "success";
  if (status === "failed") return "error";
  if (status === "blocked") return "warning";
  if (status === "working") return "info";
  return "outline";
}

function runtimeLifecycleLabel(status: WorkspaceRuntimeLifecycleStatus): string {
  if (status === "working") return "실행 중";
  if (status === "failed") return "실행 오류";
  if (status === "idle") return "대기";
  return "확인 전";
}

function runtimeAttentionLabel(attention: WorkspaceRuntimeAttention): string {
  if (attention === "error") return "오류 확인 필요";
  if (attention === "needs-input") return "내 입력 필요";
  if (attention === "completed-unseen") return "새 완료";
  return "새 알림 없음";
}

function runtimeAttentionVariant(
  attention: WorkspaceRuntimeAttention,
): "success" | "warning" | "error" | "outline" {
  if (attention === "error") return "error";
  if (attention === "needs-input") return "warning";
  if (attention === "completed-unseen") return "success";
  return "outline";
}

function runtimeEvidenceSourceLabel(source: WorkspaceRuntimeEvidence["source"]): string {
  if (source === "thread") return "대화";
  if (source === "program") return "프로그램";
  if (source === "incident") return "장애 보고";
  if (source === "collaboration") return "작업 그래프";
  if (source === "monitoring") return "모니터링";
  return "스케줄";
}

function runtimeEvidenceAuthorityLabel(authority: WorkspaceRuntimeEvidence["authority"]): string {
  if (authority === "provider") return "에이전트 이벤트";
  if (authority === "program-supervisor") return "프로그램 감시기";
  if (authority === "scheduler") return "자동화 스케줄러";
  if (authority === "monitoring") return "프로그램 모니터링";
  return "프로젝트 오케스트레이션";
}

export interface RuntimeEvidenceSummary {
  readonly visibleItems: ReadonlyArray<WorkspaceRuntimeEvidence>;
  readonly totalCount: number;
  readonly attentionCount: number;
  readonly visibleAttentionCount: number;
}

export function selectRuntimeEvidenceSummary(
  evidence: ReadonlyArray<WorkspaceRuntimeEvidence>,
  limit = 12,
): RuntimeEvidenceSummary {
  const visibleItems = evidence.slice(0, limit);
  const isAttention = (item: WorkspaceRuntimeEvidence) =>
    item.status === "blocked" || item.status === "failed";
  const attentionCount = evidence.filter(isAttention).length;
  const visibleAttentionCount = visibleItems.filter(isAttention).length;
  return {
    visibleItems,
    totalCount: evidence.length,
    attentionCount,
    visibleAttentionCount,
  };
}

export interface RuntimeKpiCard {
  readonly id: string;
  readonly label: string;
  readonly value: number;
  readonly detail: string;
}

export function buildRuntimeKpiCards(
  counts:
    | {
        readonly workingThreadCount?: number;
        readonly blockedThreadCount?: number;
        readonly failedThreadCount?: number;
        readonly completedUnseenCount?: number;
        readonly activeProgramCount?: number;
        readonly unhealthyProgramCount?: number;
        readonly openIncidentCount?: number;
        readonly activeCollaborationCount?: number;
        readonly enabledScheduleCount?: number;
      }
    | undefined,
): ReadonlyArray<RuntimeKpiCard> {
  const workingThreads = counts?.workingThreadCount ?? 0;
  const blockedThreads = counts?.blockedThreadCount ?? 0;
  const failedThreads = counts?.failedThreadCount ?? 0;
  const completedUnseen = counts?.completedUnseenCount ?? 0;
  const activePrograms = counts?.activeProgramCount ?? 0;
  const unhealthyPrograms = counts?.unhealthyProgramCount ?? 0;
  const openIncidents = counts?.openIncidentCount ?? 0;
  const activeCollaborations = counts?.activeCollaborationCount ?? 0;
  const enabledSchedules = counts?.enabledScheduleCount ?? 0;

  return [
    {
      id: "active-work",
      label: "진행 중 작업",
      value: workingThreads + activeCollaborations,
      detail: `대화 ${workingThreads} · 작업 그래프 ${activeCollaborations}`,
    },
    {
      id: "attention-needed",
      label: "확인·오류 필요",
      value: blockedThreads + failedThreads + openIncidents,
      detail: `확인 ${blockedThreads} · 오류 ${failedThreads} · 장애 ${openIncidents}`,
    },
    {
      id: "completed-unseen",
      label: "새 완료",
      value: completedUnseen,
      detail: "미확인 완료 대화",
    },
    {
      id: "programs",
      label: "실행 프로그램",
      value: activePrograms,
      detail: `비정상 ${unhealthyPrograms} · 열린 장애 ${openIncidents}`,
    },
    {
      id: "schedules",
      label: "활성 스케줄",
      value: enabledSchedules,
      detail: "무인 예약 작업",
    },
  ];
}

function WorkspaceRuntimeSection({
  project,
  onSelectSection,
}: {
  project: EnvironmentProject;
  onSelectSection: (section: ControlCenterSectionId) => void;
}) {
  const navigate = useNavigate();
  const runtime = useEnvironmentQuery(
    orchestrationEnvironment.workspaceRuntime({
      environmentId: project.environmentId,
      input: { projectId: project.id },
    }),
  );
  const markViewed = useAtomCommand(projectEnvironment.markWorkspaceRuntimeViewed, {
    label: "프로젝트 완료 상태 확인",
    reportFailure: false,
  });
  const snapshot = runtime.data;
  const counts = snapshot?.counts;
  const lastViewedReceiptRef = useRef<string | null>(null);
  const kpiCards = useMemo(() => buildRuntimeKpiCards(counts), [counts]);
  const evidenceSummary = useMemo(
    () => selectRuntimeEvidenceSummary(snapshot?.evidence ?? []),
    [snapshot?.evidence],
  );

  useEffect(() => {
    if (snapshot?.attention !== "completed-unseen" || snapshot.latestCompletionAt === null) return;
    if (lastViewedReceiptRef.current === snapshot.latestCompletionAt) return;
    lastViewedReceiptRef.current = snapshot.latestCompletionAt;
    void markViewed({
      environmentId: project.environmentId,
      input: {
        projectId: project.id,
        viewedThrough: snapshot.latestCompletionAt,
      },
    }).then((result) => {
      if (result._tag !== "Success") {
        lastViewedReceiptRef.current = null;
      }
    });
  }, [
    markViewed,
    project.environmentId,
    project.id,
    snapshot?.attention,
    snapshot?.latestCompletionAt,
  ]);

  const openEvidence = (item: WorkspaceRuntimeEvidence) => {
    if (item.source === "thread") {
      void navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId: project.environmentId, threadId: item.sourceId },
      });
      return;
    }
    const sectionId: ControlCenterSectionId =
      item.source === "program" || item.source === "incident"
        ? "project-programs"
        : item.source === "collaboration"
          ? "project-runs"
          : item.source === "monitoring"
            ? "project-monitoring"
            : "project-automation";
    onSelectSection(sectionId);
  };

  return (
    <SectionCard
      id="project-status"
      icon={ActivityIcon}
      title="프로젝트 운영 상태"
      description="진행 중인 작업, 내 답변을 기다리는 요청, 새 완료와 오류를 한곳에서 확인하세요."
      action={
        <div className="flex items-center gap-2">
          <Badge
            variant={
              snapshot?.lifecycleStatus === "failed"
                ? "error"
                : snapshot?.lifecycleStatus === "working"
                  ? "info"
                  : "outline"
            }
          >
            {runtimeLifecycleLabel(snapshot?.lifecycleStatus ?? "unknown")}
          </Badge>
          <Badge variant={runtimeAttentionVariant(snapshot?.attention ?? "none")}>
            {runtimeAttentionLabel(snapshot?.attention ?? "none")}
          </Badge>
          <Button size="xs" variant="ghost" onClick={runtime.refresh}>
            <RefreshCcwIcon />
            새로고침
          </Button>
        </div>
      }
    >
      {runtime.error ? <p className="text-sm text-destructive">{runtime.error}</p> : null}
      {snapshot ? (
        <div className="grid gap-4">
          <div className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-2">
            {kpiCards.map((card) => (
              <div
                key={card.id}
                className="min-w-0 rounded-xl border border-border/65 bg-muted/20 p-3"
              >
                <p className="truncate text-[11px] text-muted-foreground">{card.label}</p>
                <p className="mt-1 text-xl font-semibold tabular-nums">{card.value}</p>
                <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{card.detail}</p>
              </div>
            ))}
          </div>

          <div className="rounded-xl border border-border/65">
            <div className="flex items-center justify-between gap-3 border-b border-border/60 px-4 py-3">
              <div>
                <h3 className="text-sm font-semibold">판정 근거</h3>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  확인 또는 오류 근거 {evidenceSummary.attentionCount}개 · 근거{" "}
                  {evidenceSummary.visibleItems.length}/{evidenceSummary.totalCount}건 · 갱신{" "}
                  {formatTimestamp(snapshot.updatedAt)}
                </p>
              </div>
              {evidenceSummary.attentionCount > 0 ? (
                <AlertTriangleIcon className="size-4 text-warning" />
              ) : (
                <CheckIcon className="size-4 text-success" />
              )}
            </div>
            <div className="divide-y divide-border/55">
              {evidenceSummary.visibleItems.map((item) => (
                <button
                  type="button"
                  key={`${item.source}:${item.sourceId}:${item.status}`}
                  className="flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => openEvidence(item)}
                >
                  <Badge variant={runtimeStatusVariant(item.status)} className="mt-0.5 shrink-0">
                    {runtimeStatusLabel(item.status)}
                  </Badge>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                      <p className="truncate text-sm font-medium">{item.title}</p>
                      <span className="text-[10px] text-muted-foreground">
                        {runtimeEvidenceSourceLabel(item.source)} ·{" "}
                        {runtimeEvidenceAuthorityLabel(item.authority)}
                      </span>
                    </div>
                    {item.detail ? (
                      <p className="mt-1 line-clamp-3 text-xs leading-relaxed text-muted-foreground">
                        {item.detail}
                      </p>
                    ) : null}
                  </div>
                  <time className="hidden shrink-0 text-[10px] text-muted-foreground sm:block">
                    {formatTimestamp(item.observedAt)}
                  </time>
                </button>
              ))}
              {evidenceSummary.visibleItems.length === 0 ? (
                <p className="px-4 py-8 text-center text-sm text-muted-foreground">
                  아직 실행 근거가 없습니다. 프로젝트는 유휴 상태입니다.
                </p>
              ) : null}
            </div>
          </div>
        </div>
      ) : runtime.error ? null : (
        <p className="text-sm text-muted-foreground">프로젝트 운영 상태를 불러오는 중입니다.</p>
      )}
    </SectionCard>
  );
}

function terminalStatusLabel(status: TerminalSummary["status"]): string {
  if (status === "starting") return "시작 중";
  if (status === "running") return "실행 중";
  if (status === "exited") return "종료됨";
  return "오류";
}

function terminalStatusVariant(
  status: TerminalSummary["status"],
): "success" | "warning" | "error" | "outline" {
  if (status === "running") return "success";
  if (status === "starting") return "warning";
  if (status === "error") return "error";
  return "outline";
}

function ProjectTerminalsSection({ project }: { project: EnvironmentProject }) {
  const navigate = useNavigate();
  const metadata = useEnvironmentQuery(
    terminalEnvironment.metadata({ environmentId: project.environmentId, input: null }),
  );
  const terminals = useMemo(
    () =>
      (metadata.data ?? [])
        .filter((terminal) => terminal.projectId === project.id)
        .slice()
        .sort(
          (left, right) =>
            Number(right.status === "running") - Number(left.status === "running") ||
            right.updatedAt.localeCompare(left.updatedAt) ||
            left.terminalId.localeCompare(right.terminalId),
        ),
    [metadata.data, project.id],
  );

  const openTerminal = (terminal: TerminalSummary) => {
    const threadRef = scopeThreadRef(project.environmentId, ThreadId.make(terminal.threadId));
    useTerminalUiStateStore.getState().ensureTerminal(threadRef, terminal.terminalId, {
      open: true,
      active: true,
    });
    void navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId: project.environmentId, threadId: terminal.threadId },
    });
  };

  return (
    <SectionCard
      id="project-terminals"
      icon={TerminalIcon}
      title="프로젝트 터미널"
      description="이 프로젝트의 대화에서 실행 중이거나 보존된 터미널을 한곳에서 추적합니다. 입력 제어자와 원격 관찰자 수도 서버 상태로 표시합니다."
      action={
        <Button size="xs" variant="ghost" onClick={metadata.refresh}>
          <RefreshCcwIcon />
          새로고침
        </Button>
      }
    >
      {metadata.error ? <p className="text-sm text-destructive">{metadata.error}</p> : null}
      <div className="divide-y divide-border/55 rounded-xl border border-border/65">
        {terminals.map((terminal) => (
          <button
            type="button"
            key={`${terminal.threadId}:${terminal.terminalId}`}
            className="flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => openTerminal(terminal)}
          >
            <TerminalIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-center gap-2">
                <span className="truncate text-sm font-medium">{terminal.label}</span>
                <Badge variant={terminalStatusVariant(terminal.status)}>
                  {terminalStatusLabel(terminal.status)}
                </Badge>
                {terminal.hasRunningSubprocess ? <Badge variant="info">명령 실행 중</Badge> : null}
              </span>
              <span className="mt-1 block truncate font-mono text-[11px] text-muted-foreground">
                {terminal.cwd}
              </span>
              <span className="mt-1 block text-[11px] text-muted-foreground">
                {terminal.controllerAttached ? "입력 제어 연결됨" : "입력 제어 없음"} · 관찰자{" "}
                {terminal.observerCount ?? 0}명 · {formatTimestamp(terminal.updatedAt)}
              </span>
            </span>
          </button>
        ))}
        {terminals.length === 0 && metadata.error === null ? (
          <p className="px-4 py-8 text-center text-sm text-muted-foreground">
            이 프로젝트에서 열린 터미널이 없습니다. 프로젝트 대화에서 터미널을 열면 여기에
            표시됩니다.
          </p>
        ) : null}
      </div>
    </SectionCard>
  );
}

function WorkspaceBoundarySection({ project }: { project: EnvironmentProject }) {
  const updateWorkspaceControl = useAtomCommand(projectEnvironment.updateWorkspaceControl, {
    label: "프로젝트 메모리 루트 업데이트",
    reportFailure: false,
  });
  const configuredRoot = project.workspaceControl?.longTermMemoryRoot ?? "";
  const configuredConversationRag =
    project.workspaceControl?.conversationRag ?? DEFAULT_WORKSPACE_CONVERSATION_RAG_SETTINGS;
  const configuredAgentKnowledge =
    project.workspaceControl?.agentKnowledge ?? DEFAULT_WORKSPACE_AGENT_KNOWLEDGE_SETTINGS;
  const configuredOrchestra =
    project.workspaceControl?.orchestra ?? DEFAULT_WORKSPACE_ORCHESTRA_DEFAULTS;
  const configuredContext = project.workspaceControl?.contextOptimization;
  const [relevantMemory, setRelevantMemory] = useState(
    configuredContext?.memoryMode === "relevant",
  );
  const [compactHandoffs, setCompactHandoffs] = useState(
    configuredContext?.compactHandoffs ?? false,
  );
  const [autoChatMemory, setAutoChatMemory] = useState(configuredContext?.autoChatMemory ?? true);
  const [contextTokens, setContextTokens] = useState(
    String(configuredContext?.maxContextTokens ?? ""),
  );
  const [memoryRoot, setMemoryRoot] = useState(configuredRoot);
  const [conversationRagEnabled, setConversationRagEnabled] = useState(
    configuredConversationRag.enabled,
  );
  const [redactSensitiveData, setRedactSensitiveData] = useState(
    configuredConversationRag.redactSensitiveData,
  );
  const [maxInputChars, setMaxInputChars] = useState(
    String(configuredConversationRag.maxInputChars),
  );
  const [agentKnowledgeEnabled, setAgentKnowledgeEnabled] = useState(
    configuredAgentKnowledge.enabled,
  );
  const [agentKnowledgeRedact, setAgentKnowledgeRedact] = useState(
    configuredAgentKnowledge.redactSensitiveData,
  );
  const [maxOutputChars, setMaxOutputChars] = useState(
    String(configuredAgentKnowledge.maxOutputChars),
  );
  const [orchestraEnabled, setOrchestraEnabled] = useState(configuredOrchestra.enabled);
  const [orchestraMaxParallel, setOrchestraMaxParallel] = useState(
    String(configuredOrchestra.maxParallel),
  );
  const [orchestraIsolate, setOrchestraIsolate] = useState(configuredOrchestra.isolateWorktrees);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setMemoryRoot(configuredRoot);
    setConversationRagEnabled(configuredConversationRag.enabled);
    setRedactSensitiveData(configuredConversationRag.redactSensitiveData);
    setMaxInputChars(String(configuredConversationRag.maxInputChars));
    setAgentKnowledgeEnabled(configuredAgentKnowledge.enabled);
    setAgentKnowledgeRedact(configuredAgentKnowledge.redactSensitiveData);
    setMaxOutputChars(String(configuredAgentKnowledge.maxOutputChars));
    setOrchestraEnabled(configuredOrchestra.enabled);
    setOrchestraMaxParallel(String(configuredOrchestra.maxParallel));
    setOrchestraIsolate(configuredOrchestra.isolateWorktrees);
    setRelevantMemory(configuredContext?.memoryMode === "relevant");
    setCompactHandoffs(configuredContext?.compactHandoffs ?? false);
    setAutoChatMemory(configuredContext?.autoChatMemory ?? true);
    setContextTokens(String(configuredContext?.maxContextTokens ?? ""));
  }, [
    configuredAgentKnowledge,
    configuredConversationRag,
    configuredOrchestra,
    configuredContext,
    configuredRoot,
    project.id,
  ]);

  const normalizedMaxInputChars = Math.min(
    120_000,
    Math.max(2_000, Number.parseInt(maxInputChars, 10) || configuredConversationRag.maxInputChars),
  );
  const normalizedMaxOutputChars = Math.min(
    120_000,
    Math.max(2_000, Number.parseInt(maxOutputChars, 10) || configuredAgentKnowledge.maxOutputChars),
  );
  const normalizedOrchestraMaxParallel = Math.min(
    6,
    Math.max(1, Number.parseInt(orchestraMaxParallel, 10) || configuredOrchestra.maxParallel),
  );
  const normalizedContextTokens =
    contextTokens.trim() === ""
      ? null
      : Math.min(120_000, Math.max(256, Number.parseInt(contextTokens, 10) || 256));
  const settingsChanged =
    normalizedContextTokens !== (configuredContext?.maxContextTokens ?? null) ||
    relevantMemory !== (configuredContext?.memoryMode === "relevant") ||
    compactHandoffs !== (configuredContext?.compactHandoffs ?? false) ||
    autoChatMemory !== (configuredContext?.autoChatMemory ?? true) ||
    memoryRoot !== configuredRoot ||
    conversationRagEnabled !== configuredConversationRag.enabled ||
    redactSensitiveData !== configuredConversationRag.redactSensitiveData ||
    normalizedMaxInputChars !== configuredConversationRag.maxInputChars ||
    agentKnowledgeEnabled !== configuredAgentKnowledge.enabled ||
    agentKnowledgeRedact !== configuredAgentKnowledge.redactSensitiveData ||
    normalizedMaxOutputChars !== configuredAgentKnowledge.maxOutputChars ||
    orchestraEnabled !== configuredOrchestra.enabled ||
    normalizedOrchestraMaxParallel !== configuredOrchestra.maxParallel ||
    orchestraIsolate !== configuredOrchestra.isolateWorktrees;

  const save = async () => {
    setSaving(true);
    try {
      const result = await updateWorkspaceControl({
        environmentId: project.environmentId,
        input: {
          projectId: project.id,
          longTermMemoryRoot: memoryRoot.trim() || null,
          contextOptimization: {
            memoryMode: relevantMemory ? "relevant" : "standard",
            compactHandoffs,
            autoChatMemory,
            maxContextTokens: normalizedContextTokens,
          },
          conversationRag: {
            enabled: conversationRagEnabled,
            redactSensitiveData,
            maxInputChars: normalizedMaxInputChars,
          },
          agentKnowledge: {
            enabled: agentKnowledgeEnabled,
            redactSensitiveData: agentKnowledgeRedact,
            maxOutputChars: normalizedMaxOutputChars,
          },
          orchestra: {
            enabled: orchestraEnabled,
            maxParallel: normalizedOrchestraMaxParallel,
            isolateWorktrees: orchestraIsolate,
          },
          createLongTermMemoryRootIfMissing: true,
        },
      });
      if (!notifyCommandFailure(result, "프로젝트 RAG 설정 저장 실패")) {
        notifySuccess(
          "프로젝트 RAG 설정을 저장했습니다.",
          conversationRagEnabled
            ? "새 사용자 입력을 자동 압축해 이 프로젝트의 RAG에 저장합니다."
            : "자동 입력 수집을 끄고 기존 자동 RAG 사본을 제거했습니다.",
        );
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <SectionCard
      id="project-memory"
      icon={ShieldCheckIcon}
      title="격리 경계와 물리 장기기억 위치"
      description="프로젝트와 폴더 기억은 지정된 범위에서 사용합니다. 공용으로 지정한 기억은 같은 환경의 다른 프로젝트에서도 사용할 수 있습니다."
      action={<Badge variant="success">엄격 격리</Badge>}
    >
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(17rem,0.42fr)]">
        <div className="grid gap-2">
          <label htmlFor="workspace-memory-root" className="text-sm font-medium">
            장기기억 실제 저장 루트
          </label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              id="workspace-memory-root"
              value={memoryRoot}
              onChange={(event) => setMemoryRoot(event.currentTarget.value)}
              placeholder="예: E:\\AI-Memory\\내작업공간"
              className="min-w-0 flex-1 font-mono"
            />
            <Button onClick={() => void save()} disabled={saving || !settingsChanged}>
              {saving ? <RefreshCcwIcon /> : <CheckIcon />}
              설정 저장
            </Button>
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">
            비워 두면 서버 관리 저장소를 사용합니다. 경로를 지정하면 해당 루트 안에 이 프로젝트의
            전용 저장 경계가 만들어지며, 장기기억 항목마다 별도의 상대 폴더도 지정할 수 있습니다.
          </p>
          <div className="mt-3 grid gap-3 rounded-xl border border-border/70 bg-muted/20 p-4">
            <p className="text-sm font-medium">AI 입력 최적화</p>
            <label className="flex items-center justify-between gap-3 text-sm">
              작업과 관련된 기억 선택
              <Switch checked={relevantMemory} onCheckedChange={setRelevantMemory} />
            </label>
            <label className="flex items-center justify-between gap-3 text-sm">
              원문을 보존하며 협업 인계 줄이기
              <Switch checked={compactHandoffs} onCheckedChange={setCompactHandoffs} />
            </label>
            <label className="flex items-center justify-between gap-3 text-sm">
              일반 채팅에도 프로젝트 기억 연결
              <Switch checked={autoChatMemory} onCheckedChange={setAutoChatMemory} />
            </label>
            <label className="grid gap-2 text-sm">
              프로젝트 문맥 토큰 예산 (선택)
              <Input
                type="number"
                min={256}
                max={120000}
                step={1}
                value={contextTokens}
                onChange={(event) => setContextTokens(event.currentTarget.value)}
                placeholder="제한 없음"
              />
            </label>
            <p className="text-xs text-muted-foreground">
              저장 후 새 입력에 적용합니다. 예산은 프로젝트 문맥의 추정 토큰에 적용하며, 선택 자료를
              항목 단위로 줄입니다. 현재 작업과 필수 사용자 지침은 초과해도 보존합니다. 비우면
              제한을 해제합니다. 실제 AI 소비량은 별도로 확인합니다.
            </p>
          </div>
          <div className="mt-3 grid gap-3 rounded-xl border border-border/70 bg-muted/20 p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium">대화 입력 자동 압축 RAG</p>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  직접 보낸 메시지만 압축·중복 제거하여 프로젝트 전용 검색 자료로 저장합니다.
                </p>
              </div>
              <Switch
                checked={conversationRagEnabled}
                onCheckedChange={setConversationRagEnabled}
                aria-label="대화 입력 자동 압축 RAG"
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="flex items-center gap-2 text-sm font-medium">
                <Switch
                  checked={redactSensitiveData}
                  onCheckedChange={setRedactSensitiveData}
                  disabled={!conversationRagEnabled}
                />
                토큰·키·암호 자동 마스킹
              </label>
              <label className="grid gap-1 text-xs font-medium">
                입력별 최대 저장 문자
                <Input
                  type="number"
                  min={2_000}
                  max={120_000}
                  step={1_000}
                  value={maxInputChars}
                  onChange={(event) => setMaxInputChars(event.currentTarget.value)}
                  disabled={!conversationRagEnabled}
                />
              </label>
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">
              원본 대화는 기존 기록에 그대로 남습니다. 이 기능을 끄면 자동 생성된 압축 RAG 사본만
              제거되며 직접 등록한 지식·RAG 자료는 유지됩니다.
            </p>
          </div>
          <div className="mt-3 grid gap-3 rounded-xl border border-border/70 bg-muted/20 p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium">에이전트 결과 자동 압축 등록</p>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  오케스트라 실행이 끝나면 각 작업의 결과를 빠짐없이 압축해 검색 자료로 등록합니다.
                </p>
              </div>
              <Switch
                checked={agentKnowledgeEnabled}
                onCheckedChange={setAgentKnowledgeEnabled}
                aria-label="에이전트 결과 자동 압축 등록"
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="flex items-center gap-2 text-sm font-medium">
                <Switch
                  checked={agentKnowledgeRedact}
                  onCheckedChange={setAgentKnowledgeRedact}
                  disabled={!agentKnowledgeEnabled}
                />
                토큰·키·암호 자동 마스킹
              </label>
              <label className="grid gap-1 text-xs font-medium">
                작업별 최대 저장 문자
                <Input
                  type="number"
                  min={2_000}
                  max={120_000}
                  step={1_000}
                  value={maxOutputChars}
                  onChange={(event) => setMaxOutputChars(event.currentTarget.value)}
                  disabled={!agentKnowledgeEnabled}
                />
              </label>
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">
              총괄 모델이 고른 기억 후보와 별개로, 조사·구현·검증 결과 자체가
              <span className="font-mono"> collaboration-outputs </span>
              폴더에 등록됩니다. 끄면 이후 실행부터 등록하지 않으며 이미 등록된 자료는 남습니다.
            </p>
          </div>
          <div className="grid gap-3 border-t border-border/50 pt-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium">무인 실행 오케스트라 기본값</p>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  스케줄·장애 복구처럼 사람이 보내지 않는 실행에 적용됩니다. 오케스트라에서 직접
                  보낸 실행은 전송 시 설정이 우선합니다.
                </p>
              </div>
              <Switch
                checked={orchestraEnabled}
                onCheckedChange={setOrchestraEnabled}
                aria-label="무인 실행 오케스트라 기본값"
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="grid gap-1 text-xs font-medium">
                병렬 폭 (1–6)
                <Input
                  type="number"
                  min={1}
                  max={6}
                  step={1}
                  value={orchestraMaxParallel}
                  onChange={(event) => setOrchestraMaxParallel(event.currentTarget.value)}
                  disabled={!orchestraEnabled}
                />
              </label>
              <label className="flex items-center gap-2 text-sm font-medium">
                <Switch
                  checked={orchestraIsolate}
                  onCheckedChange={setOrchestraIsolate}
                  disabled={!orchestraEnabled}
                />
                worktree 격리
              </label>
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">
              격리를 켜면 파일 수정 묶음마다 전용 체크아웃에서 병렬로 작업하고, 결과는 diff 검토 후
              병합합니다. 끄면 무인 실행은 기존처럼 오케스트라 없이 진행됩니다.
            </p>
          </div>
        </div>
        <div className="rounded-xl border border-border/70 bg-muted/25 p-4">
          <dl className="grid gap-3 text-xs">
            <div>
              <dt className="text-muted-foreground">프로젝트 ID</dt>
              <dd className="mt-1 break-all font-mono text-foreground">{project.id}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">운영 폴더</dt>
              <dd className="mt-1 break-all font-mono text-foreground">{project.workspaceRoot}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">격리 정책</dt>
              <dd className="mt-1 font-medium text-success-foreground">프로젝트·폴더 범위 적용</dd>
              <dd className="mt-1 text-muted-foreground">
                공용 기억과 공개 디자인 레퍼런스는 프로젝트 간 공유
              </dd>
            </div>
          </dl>
        </div>
      </div>
    </SectionCard>
  );
}

function KnowledgeSection({ project }: { project: EnvironmentProject }) {
  const knowledge = useEnvironmentQuery(
    orchestrationEnvironment.workspaceKnowledge({
      environmentId: project.environmentId,
      input: { projectId: project.id, includeShared: false, summariesOnly: true },
    }),
  );
  const exportKnowledge = useAtomCommand(orchestrationEnvironment.exportWorkspaceKnowledge, {
    label: "프로젝트 기억 전체 목록 내보내기",
    reportFailure: false,
  });
  const [exportingKnowledge, setExportingKnowledge] = useState(false);
  const [exportScope, setExportScope] = useState<KnowledgeExportScope>("all");
  const [printView, setPrintView] = useState<string | null>(null);
  const [printReady, setPrintReady] = useState(false);
  const printFrame = useRef<HTMLIFrameElement>(null);
  const exportKnowledgeList = async (format: "json" | "markdown" | "pdf") => {
    setExportingKnowledge(true);
    try {
      const result = await exportKnowledge({
        environmentId: project.environmentId,
        input: { projectId: project.id, includeShared: false, includeArchiveSnapshot: true },
      });
      if (
        notifyCommandFailure(result, "기억 목록을 가져오지 못했습니다.") ||
        result._tag !== "Success"
      )
        return;
      if (!result.value.archiveSnapshot)
        throw new Error("서버가 전체 기억 내보내기를 지원하지 않습니다. 최신 서버를 사용하세요.");
      const exportedAt = new Date().toISOString();
      const input = {
        projectId: project.id,
        projectTitle: project.title,
        exportedAt,
        items: result.value.items,
        archiveSnapshot: result.value.archiveSnapshot,
        scope: exportScope,
      };
      const safeProjectId = project.id.replace(/[^a-zA-Z0-9._-]/g, "_");
      const scopeSuffix =
        exportScope === "user_only"
          ? "-user-dialogue-style"
          : exportScope === "ai_only"
            ? "-ai-research-outputs"
            : "";
      if (format === "pdf") {
        setPrintReady(false);
        setPrintView(renderWorkspaceKnowledgePrintView(input));
      } else if (format === "markdown") {
        const md = serializeWorkspaceKnowledgeMarkdown(input);
        const url = URL.createObjectURL(new Blob([md], { type: "text/markdown;charset=utf-8" }));
        try {
          const link = document.createElement("a");
          link.href = url;
          link.download = `t3-knowledge-${safeProjectId}${scopeSuffix}-${exportedAt.slice(0, 10)}.md`;
          link.click();
        } finally {
          URL.revokeObjectURL(url);
        }
      } else {
        const json = serializeWorkspaceKnowledgeExport(input);
        const url = URL.createObjectURL(
          new Blob([json], { type: "application/json;charset=utf-8" }),
        );
        try {
          const link = document.createElement("a");
          link.href = url;
          link.download = `t3-knowledge-${safeProjectId}${scopeSuffix}-${exportedAt.slice(0, 10)}.json`;
          link.click();
        } finally {
          URL.revokeObjectURL(url);
        }
      }
      const scopeToastLabel =
        exportScope === "user_only"
          ? "내 대화·말투 분리 기억"
          : exportScope === "ai_only"
            ? "AI 작성·조사 결과 기억"
            : "전체 기억(분리 구역 포함)";
      notifySuccess(
        format === "pdf" ? "PDF 인쇄 보기를 열었습니다." : `${scopeToastLabel}을 내보냈습니다.`,
        `지식 ${input.items.length.toLocaleString("ko-KR")}개 · 대화 ${input.archiveSnapshot.threads.length.toLocaleString("ko-KR")}개`,
      );
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "전체 기억 내보내기 실패",
        description: error instanceof Error ? error.message : "파일을 만들지 못했습니다.",
      });
    } finally {
      setExportingKnowledge(false);
    }
  };
  const upsertKnowledge = useAtomCommand(projectEnvironment.upsertWorkspaceKnowledgeItem, {
    label: "프로젝트 지식 저장",
    reportFailure: false,
  });
  const archiveKnowledge = useAtomCommand(projectEnvironment.archiveWorkspaceKnowledgeItem, {
    label: "프로젝트 지식 보관",
    reportFailure: false,
  });
  const [kind, setKind] = useState<WorkspaceKnowledgeKind>("directive");
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [relativeFolder, setRelativeFolder] = useState("");
  const [scope, setScope] = useState<WorkspaceKnowledgeScope>("project");
  const [appliesToFolder, setAppliesToFolder] = useState("");
  const [design, setDesign] = useState<WorkspaceDesignReference | null>(null);
  const [tags, setTags] = useState("");
  const [saving, setSaving] = useState(false);
  const [ragText, setRagText] = useState("");
  const [ragRequest, setRagRequest] = useState("");
  const [contextPathText, setContextPathText] = useState("");
  const contextPaths = useMemo(
    () =>
      contextPathText
        .split(",")
        .map((path) => path.trim().replaceAll("\\", "/"))
        .filter(Boolean),
    [contextPathText],
  );
  const [composeTask, setComposeTask] = useState("");
  const [composeRequest, setComposeRequest] = useState("");
  const [contextMode, setContextMode] = useState<"standard" | "relevant">("standard");
  const rag = useEnvironmentQuery(
    ragRequest
      ? orchestrationEnvironment.workspaceRag({
          environmentId: project.environmentId,
          input: {
            projectId: project.id,
            query: ragRequest,
            includeShared: false,
            contextPaths,
            limit: 8,
            includeLongTermMemory: true,
          },
        })
      : null,
  );
  const composedPrompt = useEnvironmentQuery(
    composeRequest
      ? orchestrationEnvironment.workspacePrompt({
          environmentId: project.environmentId,
          input: {
            projectId: project.id,
            task: composeRequest,
            contextMode,
            includeShared: false,
            contextPaths,
            includeRag: true,
            includeWorkingMemory: true,
            includeLongTermMemory: true,
            ragLimit: 8,
            maxContextChars: 40_000,
          },
        })
      : null,
  );
  const automaticInputCount =
    knowledge.data?.items.filter(
      (item) => item.kind === "rag-source" && item.tags.includes("auto-conversation"),
    ).length ?? 0;
  const searchRag = () => {
    const query = ragText.trim();
    if (!query) return;
    if (query === ragRequest) rag.refresh();
    else setRagRequest(query);
  };
  const libraryStatus = useEnvironmentQuery(
    orchestrationEnvironment.sharedLibraryStatus({
      environmentId: project.environmentId,
      input: {},
    }),
  );
  const syncSharedLibrary = useAtomCommand(orchestrationEnvironment.syncSharedLibrary, {
    label: "공용 라이브러리 동기화",
    reportFailure: false,
  });
  const [librarySyncing, setLibrarySyncing] = useState(false);
  const librarySource = libraryStatus.data?.sources[0] ?? null;
  const libraryItemCount = libraryStatus.data?.libraries[0]?.itemCount ?? 0;
  const libraryRunning = librarySource?.running === true;
  const refreshLibraryStatus = libraryStatus.refresh;
  // Poll only while a sync runs, so the count climbs on screen without a
  // standing fixed-interval poller.
  useEffect(() => {
    if (!libraryRunning) return;
    const timer = window.setInterval(refreshLibraryStatus, 5_000);
    return () => window.clearInterval(timer);
  }, [libraryRunning, refreshLibraryStatus]);
  const formatLibraryTime = (iso: string) =>
    new Date(iso).toLocaleString("ko-KR", { dateStyle: "short", timeStyle: "short" });

  const syncLibrary = async () => {
    setLibrarySyncing(true);
    try {
      const result = await syncSharedLibrary({
        environmentId: project.environmentId,
        input: {},
      });
      if (!notifyCommandFailure(result, "공용 라이브러리 동기화 실패")) {
        refreshLibraryStatus();
        notifySuccess(
          result._tag === "Success" && !result.value.started
            ? "이미 동기화하는 중입니다."
            : "공용 라이브러리 동기화를 시작했습니다.",
          "새 레퍼런스를 가져오는 동안 항목 수가 늘어납니다.",
        );
      }
    } finally {
      setLibrarySyncing(false);
    }
  };

  const save = async () => {
    if (!title.trim() || !content.trim()) {
      toastManager.add({ type: "warning", title: "제목과 내용을 입력하세요." });
      return;
    }
    if (scope === "folder" && !appliesToFolder.trim()) {
      toastManager.add({
        type: "warning",
        title: "기억이 적용될 프로젝트 내부 폴더를 입력하세요.",
      });
      return;
    }
    setSaving(true);
    try {
      const validDesign = design
        ? decodeDesign({
            ...design,
            components: design.components.filter(Boolean),
          })
        : null;
      const research = {
        query: title.trim(),
        sources: [],
        capturedAt: new Date().toISOString(),
        verification: "unverified" as const,
      };
      const result = await upsertKnowledge({
        environmentId: project.environmentId,
        input: {
          projectId: project.id,
          itemId: WorkspaceKnowledgeItemId.make(`knowledge-${randomUUID()}`),
          kind: validDesign && kind !== "long-term-memory" ? "rag-source" : kind,
          title: title.trim(),
          content: content.trim(),
          status: "active",
          origin: "user",
          scope,
          appliesToFolder: scope === "folder" ? appliesToFolder.trim().replaceAll("\\", "/") : null,
          research: validDesign
            ? {
                ...research,
                design: validDesign,
                sources: validDesign.sourceUrl ? [validDesign.sourceUrl] : [],
              }
            : null,
          relativeFolder:
            kind === "long-term-memory" && relativeFolder.trim()
              ? relativeFolder.trim().replaceAll("\\", "/")
              : null,
          tags: tags
            .split(",")
            .map((tag) => tag.trim())
            .filter(Boolean),
        },
      });
      if (!notifyCommandFailure(result, "프로젝트 지식 저장 실패")) {
        setTitle("");
        setContent("");
        setRelativeFolder("");
        setAppliesToFolder("");
        setDesign(null);
        setTags("");
        knowledge.refresh();
        rag.refresh();
        composedPrompt.refresh();
        notifySuccess(`${KNOWLEDGE_KIND_LABELS[kind]}을 저장했습니다.`);
      }
    } catch {
      toastManager.add({
        type: "warning",
        title: "디자인 참고 자료의 URL과 입력 길이를 확인하세요.",
        description: "이미지는 HTTP(S) 주소 8개, 컴포넌트는 40개까지 저장할 수 있습니다.",
      });
    } finally {
      setSaving(false);
    }
  };

  const archive = async (item: WorkspaceKnowledgeItem) => {
    const result = await archiveKnowledge({
      environmentId: project.environmentId,
      input: { projectId: item.projectId, itemId: item.id },
    });
    if (!notifyCommandFailure(result, "지식 항목 보관 실패")) {
      knowledge.refresh();
      rag.refresh();
      composedPrompt.refresh();
      notifySuccess("항목을 보관 처리했습니다.");
    }
  };

  const restoreDocument = useAtomCommand(restoreWikiDocument, { reportFailure: false });
  const restore = async (item: WorkspaceKnowledgeItem) => {
    const result = await restoreDocument({
      environmentId: project.environmentId,
      input: { projectId: project.id, itemId: item.id, commandId: CommandId.make(randomUUID()) },
    });
    if (!notifyCommandFailure(result, "지식 항목 복원 실패")) {
      knowledge.refresh();
      rag.refresh();
      composedPrompt.refresh();
    }
  };

  return (
    <SectionCard
      id="project-knowledge"
      icon={DatabaseIcon}
      title="RAG · 메모리 · 장기기억 · 프롬프트"
      scopeLabel="공용 · 프로젝트 · 폴더 기억"
      description="공용 기억은 이 환경의 모든 프로젝트에서, 프로젝트 기억은 이 프로젝트에서, 폴더 기억은 지정한 폴더의 작업에서 사용됩니다. 조사 기록에는 출처와 검증 상태가 함께 남습니다."
      action={
        <div className="flex flex-wrap gap-1">
          <Badge variant="info">항목 {knowledge.data?.items.length ?? 0}개</Badge>
          <Badge variant="success">자동 입력 {automaticInputCount}개</Badge>
        </div>
      }
    >
      <div className="grid gap-6">
        <div className="grid gap-3 rounded-xl border border-border/70 p-4">
          <div className="flex items-center gap-2">
            <PlusIcon className="size-4 text-primary" />
            <h3 className="text-sm font-semibold">지식·기억·프롬프트 수집</h3>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <label className="grid gap-1.5 text-sm font-medium">
              종류
              <select
                className={SELECT_CLASS}
                value={kind}
                onChange={(event) => setKind(event.currentTarget.value as WorkspaceKnowledgeKind)}
              >
                {ALL_KNOWLEDGE_KINDS.map((value) => (
                  <option key={value} value={value}>
                    {KNOWLEDGE_KIND_LABELS[value]}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-1.5 text-sm font-medium">
              제목
              <Input
                id="knowledge-title"
                value={title}
                onChange={(event) => setTitle(event.currentTarget.value)}
              />
            </label>
          </div>
          <label className="grid gap-1.5 text-sm font-medium">
            내용
            <Textarea
              value={content}
              onChange={(event) => setContent(event.currentTarget.value)}
              placeholder="사용자 지침, 장기 목표, 검색 자료, 기억 또는 재사용할 프롬프트를 입력하세요."
            />
          </label>
          <DesignReferenceFields
            environmentId={project.environmentId}
            projectId={project.id}
            value={design}
            onChange={setDesign}
          />
          <div className="grid gap-3 md:grid-cols-2">
            <label className="grid gap-1.5 text-sm font-medium">
              기억 적용 범위
              <select
                className={SELECT_CLASS}
                value={scope}
                onChange={(event) => setScope(event.currentTarget.value as WorkspaceKnowledgeScope)}
              >
                <option value="environment">공용 · 이 환경의 모든 프로젝트</option>
                <option value="project">이 프로젝트</option>
                <option value="folder">이 프로젝트의 특정 폴더</option>
              </select>
            </label>
            {scope === "folder" ? (
              <label className="grid gap-1.5 text-sm font-medium">
                적용 폴더
                <Input
                  value={appliesToFolder}
                  onChange={(event) => setAppliesToFolder(event.currentTarget.value)}
                  placeholder="예: apps/web"
                />
              </label>
            ) : null}
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <label className="grid gap-1.5 text-sm font-medium">
              태그 (쉼표 구분)
              <Input value={tags} onChange={(event) => setTags(event.currentTarget.value)} />
            </label>
            {kind === "long-term-memory" ? (
              <label className="grid gap-1.5 text-sm font-medium">
                이 장기기억의 하위 폴더
                <Input
                  value={relativeFolder}
                  onChange={(event) => setRelativeFolder(event.currentTarget.value)}
                  placeholder="예: product/decisions"
                  className="font-mono"
                />
              </label>
            ) : (
              <div className="flex items-end text-xs leading-relaxed text-muted-foreground">
                장기기억을 선택하면 항목별 물리 하위 폴더를 지정할 수 있습니다.
              </div>
            )}
          </div>
          <div className="flex justify-end">
            <Button onClick={() => void save()} disabled={saving}>
              {saving ? <RefreshCcwIcon /> : <DatabaseIcon />}
              기억 저장
            </Button>
          </div>
        </div>

        <div className="grid gap-2 rounded-xl border border-border/70 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <DatabaseIcon className="size-4 text-primary" />
              <h3 className="text-sm font-semibold">공용 디자인 라이브러리</h3>
              <Badge variant="info">{libraryItemCount.toLocaleString("ko-KR")}건</Badge>
              {libraryRunning ? <Badge variant="warning">동기화 중</Badge> : null}
            </div>
            <Button
              size="xs"
              variant="outline"
              onClick={() => void syncLibrary()}
              disabled={librarySyncing || libraryRunning}
            >
              <RefreshCcwIcon />
              지금 동기화
            </Button>
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">
            <a
              href={librarySource?.origin ?? "https://ref.theseeker.io"}
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-2"
            >
              더씨커 레퍼런스
            </a>
            의 디자인 레퍼런스를 모든 프로젝트가 함께 검색합니다. 매일 새 레퍼런스를 가져오며,
            화면·디자인과 관련된 작업의 프롬프트에만 출처와 작가 표기와 함께 들어갑니다.
          </p>
          <p className="text-[11px] text-muted-foreground">
            {librarySource?.lastSyncAt
              ? `마지막 동기화 ${formatLibraryTime(librarySource.lastSyncAt)}`
              : "아직 동기화 전입니다."}
            {librarySource !== null &&
            librarySource.fullScanCompletedAt === null &&
            librarySource.scanCursor > 0
              ? ` · 최초 수집 ${librarySource.scanCursor.toLocaleString("ko-KR")}번까지 확인`
              : ""}
          </p>
          {librarySource?.lastError ? (
            <p className="text-xs text-destructive">{librarySource.lastError}</p>
          ) : null}
          {libraryStatus.error ? (
            <p className="text-xs text-destructive">{libraryStatus.error}</p>
          ) : null}
        </div>

        <label className="grid gap-1.5 text-sm font-medium">
          검색·프롬프트의 작업 경로
          <Input
            value={contextPathText}
            onChange={(event) => setContextPathText(event.currentTarget.value)}
            placeholder="예: apps/web, apps/server (비우면 공용·프로젝트 기억만 사용)"
          />
        </label>
        <WorkspaceResearchPanel
          project={project}
          onSaved={() => {
            knowledge.refresh();
            rag.refresh();
          }}
        />
        <div className="grid gap-4 xl:grid-cols-2">
          <div className="grid content-start gap-3 rounded-xl border border-border/70 p-4">
            <div className="flex items-center gap-2">
              <SearchIcon className="size-4 text-primary" />
              <h3 id="project-knowledge-search" className="scroll-mt-4 text-sm font-semibold">
                격리 RAG 검색
              </h3>
            </div>
            <div className="flex gap-2">
              <Input
                value={ragText}
                onChange={(event) => setRagText(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") searchRag();
                }}
                placeholder="프로젝트·공용·해당 폴더의 기억 검색"
              />
              <Button variant="outline" onClick={searchRag} disabled={!ragText.trim()}>
                <SearchIcon />
                검색
              </Button>
            </div>
            {rag.error ? <p className="text-xs text-destructive">{rag.error}</p> : null}
            {rag.data?.retrieval && (
              <p className="text-xs text-muted-foreground">
                {rag.data.retrieval.method === "hybrid"
                  ? `키워드 + 의미 검색 · 색인 ${rag.data.retrieval.indexedChunks}/${rag.data.retrieval.totalChunks}`
                  : "키워드 검색"}
                {rag.data.retrieval.message ? ` · ${rag.data.retrieval.message}` : ""}
              </p>
            )}
            {rag.data?.matches.map((match) => (
              <div
                key={`${match.projectId}:${match.itemId}:${match.chunkId ?? "item"}`}
                className="rounded-lg bg-muted/35 p-3"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-xs font-semibold">
                    <KnowledgeDocLink
                      environmentId={project.environmentId}
                      projectId={match.projectId}
                      itemId={match.itemId}
                    >
                      {match.title}
                    </KnowledgeDocLink>
                  </span>
                  <Badge variant="outline">{KNOWLEDGE_KIND_LABELS[match.kind]}</Badge>
                </div>
                {match.pdfRevision && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {formatPdfSearchEditionLabel(match.pdfRevision)}
                  </p>
                )}
                <p className="mt-1 line-clamp-3 whitespace-pre-wrap text-xs text-muted-foreground">
                  {match.snippet}
                </p>
              </div>
            ))}
          </div>

          <div className="grid content-start gap-3 rounded-xl border border-border/70 p-4">
            <div className="flex items-center gap-2">
              <SparklesIcon className="size-4 text-primary" />
              <h3 className="text-sm font-semibold">AI 프롬프트 수집·결합 미리보기</h3>
            </div>
            <Textarea
              size="sm"
              value={composeTask}
              onChange={(event) => setComposeTask(event.currentTarget.value)}
              placeholder="수행할 작업을 입력하면 적용할 사용자 지침과 기억을 미리 확인할 수 있습니다."
            />
            <label className="grid gap-1.5 text-xs font-medium">
              기억 선택 방식 (미리보기)
              <select
                className={SELECT_CLASS}
                value={contextMode}
                onChange={(event) =>
                  setContextMode(event.currentTarget.value === "relevant" ? "relevant" : "standard")
                }
              >
                <option value="standard">기존 방식</option>
                <option value="relevant">관련 기억 선택 · 평가 중</option>
              </select>
            </label>
            <Button
              variant="outline"
              className="justify-self-end"
              onClick={() => {
                const task = composeTask.trim();
                if (!task) return;
                if (task === composeRequest) composedPrompt.refresh();
                else setComposeRequest(task);
              }}
              disabled={!composeTask.trim()}
            >
              <SparklesIcon />
              결합 미리보기
            </Button>
            {composedPrompt.error ? (
              <p className="text-xs text-destructive">{composedPrompt.error}</p>
            ) : null}
            {composedPrompt.data ? (
              <div className="grid gap-2">
                <div className="flex flex-wrap gap-1">
                  <Badge variant="info">
                    자료{" "}
                    {composedPrompt.data.sourceReferences?.length ??
                      composedPrompt.data.sourceItemIds.length}
                  </Badge>
                  <Badge variant="info">검색 후보 {composedPrompt.data.ragMatches.length}</Badge>
                  {(composedPrompt.data.libraryMatches?.length ?? 0) > 0 ? (
                    <Badge variant="success">
                      디자인 레퍼런스 {composedPrompt.data.libraryMatches?.length}
                    </Badge>
                  ) : null}
                  {composedPrompt.data.truncated ? (
                    <Badge variant="warning">일부 생략</Badge>
                  ) : null}
                </div>
                {composedPrompt.data.tokenEstimate ? (
                  <WorkspacePromptTokens estimate={composedPrompt.data.tokenEstimate} />
                ) : null}
                {composedPrompt.data.diagnostics ? (
                  <WorkspacePromptDiagnostics
                    environmentId={project.environmentId}
                    diagnostics={composedPrompt.data.diagnostics}
                    items={knowledge.data?.items ?? []}
                  />
                ) : null}
                <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-lg bg-muted/40 p-3 font-mono text-[11px] leading-relaxed">
                  {composedPrompt.data.prompt}
                </pre>
              </div>
            ) : null}
          </div>
        </div>

        <div className="grid gap-2">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold">저장 항목</h3>
            <div className="flex flex-wrap items-center gap-1">
              <Link
                to={knowledgeDashboardRoute}
                params={{ environmentId: project.environmentId, projectId: project.id }}
                className="inline-flex h-6 items-center rounded-lg border px-2 text-xs font-medium text-primary"
              >
                위키 관리
              </Link>
              <select
                aria-label="기억 내보내기 구분"
                className="h-6 rounded-lg border bg-background px-2 text-xs"
                value={exportScope}
                onChange={(event) => setExportScope(event.target.value as KnowledgeExportScope)}
              >
                <option value="all">전체 (분리 구역 포함)</option>
                <option value="user_only">내 대화·말투만</option>
                <option value="ai_only">AI 작성·조사 결과만</option>
              </select>
              <Button
                size="xs"
                variant="outline"
                onClick={() => void exportKnowledgeList("json")}
                disabled={exportingKnowledge}
              >
                <DownloadIcon />
                {exportingKnowledge ? "내보내는 중…" : "JSON 내보내기"}
              </Button>
              <Button
                size="xs"
                variant="outline"
                onClick={() => void exportKnowledgeList("markdown")}
                disabled={exportingKnowledge}
              >
                <DownloadIcon />
                Markdown (.md)
              </Button>
              <Button
                size="xs"
                variant="outline"
                onClick={() => void exportKnowledgeList("pdf")}
                disabled={exportingKnowledge}
              >
                <FileStackIcon />
                PDF 보기 / 저장
              </Button>
              <Button size="xs" variant="ghost" onClick={knowledge.refresh}>
                <RefreshCcwIcon />
                새로고침
              </Button>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            내 대화·말투 프로필(<code>user-utterances/</code>)과 AI 작성·조사 결과(
            <code>ai-outputs/</code>)는 물리적으로 분리 보관되며 AI는 두 영역을 모두 참조할 수
            있습니다. 위 구분 선택으로 내 대화·말투만, AI 조사 결과만, 또는 분리 구역이 모두 담긴
            전체 파일을 JSON·Markdown·PDF로 각각 저장할 수 있습니다.
          </p>
          {knowledge.error ? <p className="text-xs text-destructive">{knowledge.error}</p> : null}
          <div className="grid gap-2 lg:grid-cols-2">
            {knowledge.data?.items.map((item) => (
              <article
                key={`${item.projectId}:${item.id}`}
                className="rounded-xl border border-border/60 p-3"
              >
                <div className="flex items-start gap-2">
                  <FileStackIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <h4 className="truncate text-sm font-medium">
                        <KnowledgeDocLink
                          environmentId={project.environmentId}
                          projectId={item.projectId}
                          itemId={item.id}
                        >
                          {item.title}
                        </KnowledgeDocLink>
                      </h4>
                      <Badge variant="outline">
                        {item.scope === "environment"
                          ? "공용"
                          : item.scope === "folder"
                            ? `폴더 · ${item.appliesToFolder}`
                            : "프로젝트"}
                      </Badge>
                      {item.research ? (
                        <Badge
                          variant={
                            item.research.verification === "verified" ? "success" : "warning"
                          }
                        >
                          {item.research.verification === "verified"
                            ? "검증됨"
                            : item.research.verification === "contradicted"
                              ? "반대 근거 확인"
                              : "검증 전 조사"}
                        </Badge>
                      ) : null}
                      <Badge variant={item.status === "active" ? "success" : "outline"}>
                        {KNOWLEDGE_KIND_LABELS[item.kind]}
                      </Badge>
                      {item.tags.includes("auto-conversation") ? (
                        <Badge variant="info">대화 자동 압축</Badge>
                      ) : null}
                      {item.tags.includes("auto-agent-output") ? (
                        <Badge variant="info">에이전트 결과</Badge>
                      ) : null}
                      {/* Automatic capture accumulates fast, so the item that
                          never reached a model is the one worth spotting. */}
                      {item.promptUses > 0 ? (
                        <Badge variant="outline">프롬프트 {item.promptUses}회</Badge>
                      ) : (
                        <Badge variant="warning">미사용</Badge>
                      )}
                    </div>
                    <KnowledgeExcerpt
                      environmentId={project.environmentId}
                      projectId={item.projectId}
                      itemId={item.id}
                    />
                    {item.research?.design ? (
                      <DesignReferencePreview
                        environmentId={project.environmentId}
                        reference={item.research.design}
                      />
                    ) : null}
                    {item.originalChars !== null && item.storedChars !== null ? (
                      <p className="mt-2 text-[10px] text-muted-foreground">
                        원문 {item.originalChars}자 → 저장 {item.storedChars}자
                        {item.originalChars > 0
                          ? ` · ${Math.round((1 - item.storedChars / item.originalChars) * 100)}% 절감`
                          : ""}
                        {item.tags.some((tag) => tag.startsWith("redacted-"))
                          ? " · 민감정보 마스킹"
                          : ""}
                      </p>
                    ) : null}
                    {item.relativeFolder ? (
                      <p className="mt-2 truncate font-mono text-[10px] text-muted-foreground">
                        folder/{item.relativeFolder}
                      </p>
                    ) : null}
                  </div>
                  {item.status !== "archived" && (
                    <KnowledgeDocLink
                      environmentId={project.environmentId}
                      projectId={item.projectId}
                      itemId={item.id}
                      view="edit"
                      className="rounded px-2 py-1 text-xs font-medium text-primary hover:underline"
                    >
                      수정
                    </KnowledgeDocLink>
                  )}
                  {item.status !== "archived" ? (
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label="항목 보관"
                      onClick={() => void archive(item)}
                    >
                      <ArchiveIcon />
                    </Button>
                  ) : (
                    <Button size="xs" variant="ghost" onClick={() => void restore(item)}>
                      복원
                    </Button>
                  )}
                </div>
              </article>
            ))}
          </div>
        </div>
      </div>
      <Dialog
        open={printView !== null}
        onOpenChange={(open) => {
          if (!open) setPrintView(null);
        }}
      >
        <DialogPopup className="w-[min(96vw,72rem)] max-w-none">
          <DialogHeader>
            <DialogTitle>전체 기억 PDF 미리보기</DialogTitle>
            <DialogDescription>인쇄 창에서 PDF로 저장할 수 있습니다.</DialogDescription>
          </DialogHeader>
          <iframe
            ref={printFrame}
            title="전체 기억 인쇄 미리보기"
            sandbox="allow-same-origin allow-modals"
            srcDoc={printView ?? ""}
            onLoad={() => setPrintReady(true)}
            className="h-[65vh] w-full border-y bg-white"
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setPrintView(null)}>
              닫기
            </Button>
            <Button
              disabled={!printReady}
              onClick={() => printFrame.current?.contentWindow?.print()}
            >
              PDF로 저장 / 인쇄
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </SectionCard>
  );
}

function RoleSection({ project }: { project: EnvironmentProject }) {
  const roles = useEnvironmentQuery(
    orchestrationEnvironment.workspaceAgentRoles({
      environmentId: project.environmentId,
      input: { projectId: project.id },
    }),
  );
  const serverConfigs = useServerConfigs();
  const providerSnapshots = serverConfigs.get(project.environmentId)?.providers ?? [];
  const providerEntries = useMemo(
    () => deriveProviderInstanceEntries(providerSnapshots).filter((entry) => entry.enabled),
    [providerSnapshots],
  );
  const providerGroups = useMemo(
    () => groupProviderInstanceEntriesByDriver(providerEntries),
    [providerEntries],
  );
  const upsertRole = useAtomCommand(projectEnvironment.upsertWorkspaceAgentRole, {
    label: "프로젝트 에이전트 역할 저장",
    reportFailure: false,
  });
  const removeRole = useAtomCommand(projectEnvironment.removeWorkspaceAgentRole, {
    label: "프로젝트 에이전트 역할 제거",
    reportFailure: false,
  });
  const [role, setRole] = useState<WorkspaceAgentRole>("coordinator");
  const [displayName, setDisplayName] = useState(ROLE_LABELS.coordinator);
  const [instanceId, setInstanceId] = useState("");
  const [model, setModel] = useState("");
  const [runtimeMode, setRuntimeMode] = useState<RuntimeMode>("full-access");
  const [interactionMode, setInteractionMode] = useState<ProviderInteractionMode>("default");
  const [instructions, setInstructions] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [saving, setSaving] = useState(false);
  const selectedProvider = providerEntries.find((entry) => entry.instanceId === instanceId) ?? null;

  const loadBinding = (binding: WorkspaceAgentRoleBinding) => {
    setRole(binding.role);
    setDisplayName(binding.displayName);
    setInstanceId(binding.modelSelection.instanceId);
    setModel(binding.modelSelection.model);
    setRuntimeMode(binding.runtimeMode);
    setInteractionMode(binding.interactionMode);
    setInstructions(binding.instructions);
    setEnabled(binding.enabled);
  };

  const selectRole = (nextRole: WorkspaceAgentRole) => {
    const binding = roles.data?.roles.find((candidate) => candidate.role === nextRole);
    if (binding) {
      loadBinding(binding);
      return;
    }
    const firstProvider = providerEntries[0];
    setRole(nextRole);
    setDisplayName(ROLE_LABELS[nextRole]);
    setInstanceId(firstProvider?.instanceId ?? "");
    setModel(firstProvider?.models[0]?.slug ?? "");
    setRuntimeMode("full-access");
    setInteractionMode("default");
    setInstructions("");
    setEnabled(true);
  };

  const save = async () => {
    const resolvedProvider = providerEntries.find((entry) => entry.instanceId === instanceId);
    const resolvedModel = model.trim() || resolvedProvider?.models[0]?.slug || "";
    if (!resolvedProvider || !resolvedModel || !displayName.trim()) {
      toastManager.add({
        type: "warning",
        title: "역할의 CLI 계정, 모델, 표시 이름을 모두 지정하세요.",
      });
      return;
    }
    setSaving(true);
    try {
      const result = await upsertRole({
        environmentId: project.environmentId,
        input: {
          projectId: project.id,
          role,
          displayName: displayName.trim(),
          modelSelection: {
            instanceId: ProviderInstanceId.make(resolvedProvider.instanceId),
            model: resolvedModel,
          },
          runtimeMode,
          interactionMode,
          instructions,
          enabled,
        },
      });
      if (!notifyCommandFailure(result, "AI 역할 저장 실패")) {
        roles.refresh();
        notifySuccess(`${ROLE_LABELS[role]} 역할을 저장했습니다.`);
      }
    } finally {
      setSaving(false);
    }
  };

  const remove = async (targetRole: WorkspaceAgentRole) => {
    const result = await removeRole({
      environmentId: project.environmentId,
      input: { projectId: project.id, role: targetRole },
    });
    if (!notifyCommandFailure(result, "AI 역할 제거 실패")) {
      roles.refresh();
      selectRole(targetRole);
      notifySuccess(`${ROLE_LABELS[targetRole]} 역할을 제거했습니다.`);
    }
  };

  return (
    <SectionCard
      id="project-accounts"
      icon={BotIcon}
      title="AI 역할과 CLI 계정"
      description="총괄·구현·조사 등 역할에 사용할 계정과 모델을 직접 선택합니다. 각 역할의 설정은 프로젝트별로 독립됩니다."
      action={
        <Badge variant="info">
          활성 {roles.data?.roles.filter((item) => item.enabled).length ?? 0}개
        </Badge>
      }
    >
      <div className="grid gap-5">
        <div className="grid gap-3">
          <div>
            <h3 className="text-sm font-semibold">등록된 CLI 계정 사용량</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              계정별 토큰·세션·활성 세션·크레딧·할당량과 초기화 시각입니다.
            </p>
          </div>
          <div className="grid gap-4">
            {providerGroups.map((group) => (
              <section key={group.driverKind} className="grid gap-2">
                <div className="flex min-w-0 items-center justify-between gap-3 px-1">
                  <div className="min-w-0">
                    <h4 className="truncate text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      {group.label}
                    </h4>
                    <p className="truncate text-[11px] text-muted-foreground">
                      계정 {group.entries.length}개 · 준비 {group.readyCount}개
                    </p>
                  </div>
                  {group.entries.length > 1 ? (
                    <Badge variant="outline" size="sm">
                      그룹
                    </Badge>
                  ) : null}
                </div>
                <div className="grid gap-3 xl:grid-cols-2">
                  {group.entries.map((provider) => (
                    <article
                      key={provider.instanceId}
                      className="grid gap-2 rounded-xl border border-border/65 bg-muted/10 p-3"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-semibold">{provider.displayName}</p>
                          <p className="truncate font-mono text-[10px] text-muted-foreground">
                            {provider.instanceId}
                          </p>
                        </div>
                        <Badge variant={provider.status === "ready" ? "success" : "warning"}>
                          {providerStatusLabel(provider.status)}
                        </Badge>
                      </div>
                      <ProviderAccountUsage usage={provider.snapshot.usage} />
                    </article>
                  ))}
                </div>
              </section>
            ))}
          </div>
        </div>

        <div className="grid gap-5 xl:grid-cols-[minmax(19rem,0.72fr)_minmax(0,1.28fr)]">
          <div className="grid content-start gap-2">
            {ALL_ROLES.map((roleName) => {
              const binding = roles.data?.roles.find((candidate) => candidate.role === roleName);
              return (
                <button
                  key={roleName}
                  type="button"
                  className={`flex items-center gap-3 rounded-xl border px-3 py-3 text-left transition-colors ${
                    role === roleName
                      ? "border-primary/50 bg-primary/5"
                      : "border-border/60 hover:bg-accent/40"
                  }`}
                  onClick={() => (binding ? loadBinding(binding) : selectRole(roleName))}
                >
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                    <BotIcon className="size-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium">{ROLE_LABELS[roleName]}</span>
                    <span className="block truncate text-[11px] text-muted-foreground">
                      {binding
                        ? `${binding.modelSelection.instanceId} · ${binding.modelSelection.model}`
                        : "미지정"}
                    </span>
                  </span>
                  <Badge variant={binding?.enabled ? "success" : "outline"}>
                    {binding?.enabled ? "사용" : "꺼짐"}
                  </Badge>
                </button>
              );
            })}
          </div>
        </div>

        <div className="grid gap-3 rounded-xl border border-border/70 p-4">
          <div className="grid gap-3 md:grid-cols-2">
            <label className="grid gap-1.5 text-sm font-medium">
              역할
              <select
                className={SELECT_CLASS}
                value={role}
                onChange={(event) => selectRole(event.currentTarget.value as WorkspaceAgentRole)}
              >
                {ALL_ROLES.map((value) => (
                  <option key={value} value={value}>
                    {ROLE_LABELS[value]}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-1.5 text-sm font-medium">
              표시 이름
              <Input
                value={displayName}
                onChange={(event) => setDisplayName(event.currentTarget.value)}
              />
            </label>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <label className="grid gap-1.5 text-sm font-medium">
              CLI 계정 인스턴스
              <select
                className={SELECT_CLASS}
                value={instanceId}
                onChange={(event) => {
                  const next = providerEntries.find(
                    (entry) => entry.instanceId === event.currentTarget.value,
                  );
                  setInstanceId(event.currentTarget.value);
                  setModel(next?.models[0]?.slug ?? "");
                }}
              >
                <option value="">계정을 선택하세요</option>
                {providerGroups.map((group) => (
                  <optgroup
                    key={group.driverKind}
                    label={`${group.label} · ${group.entries.length}개`}
                  >
                    {group.entries.map((provider) => (
                      <option key={provider.instanceId} value={provider.instanceId}>
                        {provider.displayName} ({provider.instanceId}) ·{" "}
                        {providerStatusLabel(provider.status)}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </label>
            <label className="grid gap-1.5 text-sm font-medium">
              모델
              <Input
                value={model}
                onChange={(event) => setModel(event.currentTarget.value)}
                list={`workspace-models-${role}`}
                placeholder="모델 식별자"
              />
              <datalist id={`workspace-models-${role}`}>
                {selectedProvider?.models.map((entry) => (
                  <option key={entry.slug} value={entry.slug} />
                ))}
              </datalist>
            </label>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <label className="grid gap-1.5 text-sm font-medium">
              실행 권한
              <select
                className={SELECT_CLASS}
                value={runtimeMode}
                onChange={(event) => setRuntimeMode(event.currentTarget.value as RuntimeMode)}
              >
                <option value="full-access">전체 접근</option>
                <option value="auto">자동</option>
                <option value="auto-accept-edits">편집 자동 승인</option>
                <option value="approval-required">승인 필요</option>
              </select>
            </label>
            <label className="grid gap-1.5 text-sm font-medium">
              상호작용 모드
              <select
                className={SELECT_CLASS}
                value={interactionMode}
                onChange={(event) =>
                  setInteractionMode(event.currentTarget.value as ProviderInteractionMode)
                }
              >
                <option value="default">기본</option>
                <option value="plan">계획</option>
              </select>
            </label>
          </div>
          <label className="grid gap-1.5 text-sm font-medium">
            역할 전용 지침
            <Textarea
              size="sm"
              value={instructions}
              onChange={(event) => setInstructions(event.currentTarget.value)}
              placeholder="이 역할이 항상 따라야 할 책임과 산출물 규칙"
            />
          </label>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <label className="flex items-center gap-2 text-sm font-medium">
              <Switch checked={enabled} onCheckedChange={setEnabled} />
              오케스트라 실행에 포함
            </label>
            <div className="flex gap-2">
              {roles.data?.roles.some((binding) => binding.role === role) ? (
                <Button variant="destructive-outline" onClick={() => void remove(role)}>
                  <Trash2Icon />
                  역할 제거
                </Button>
              ) : null}
              <Button onClick={() => void save()} disabled={saving}>
                {saving ? <RefreshCcwIcon /> : <CheckIcon />}
                역할 저장
              </Button>
            </div>
          </div>
          {providerEntries.length === 0 ? (
            <p className="rounded-lg bg-warning/8 p-3 text-xs text-warning-foreground">
              이 환경에 활성 CLI 계정이 없습니다. 설정 → 연결에서 계정을 먼저 등록하세요.
            </p>
          ) : null}
        </div>
      </div>
    </SectionCard>
  );
}

function localDateTimeInputValue(date: Date): string {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function timingSummary(timing: WorkspaceScheduleTiming): string {
  if (timing.kind === "after-run")
    return `${timing.runId} · ${timing.condition === "verified" ? "검증 통과" : "실행 완료"} 후 1회 · 실패 시 ${timing.onFailure === "cancel" ? "취소" : "보류"}`;
  if (timing.kind === "once") return `1회 · ${formatTimestamp(timing.runAt)}`;
  if (timing.kind === "interval") {
    return `${timing.everyMinutes}분 간격 · ${formatTimestamp(timing.startAt)}부터`;
  }
  return `매일 ${timing.localTime} · ${timing.timeZone}`;
}

function ScheduleSection({ project }: { project: EnvironmentProject }) {
  const runs = useEnvironmentQuery(
    orchestrationEnvironment.workspaceCollaborationRuns({
      environmentId: project.environmentId,
      input: { projectId: project.id },
    }),
  );
  const profiles = useEnvironmentSettings(
    project.environmentId,
    (settings) => settings.executionProfiles,
  );
  const [profileId, setProfileId] = useState("");
  const [taskRecipeId, setTaskRecipeId] = useState("");
  const [recipeInputs, setRecipeInputs] = useState<Record<string, string>>({});
  const taskInbox = useEnvironmentQuery(
    orchestrationEnvironment.taskInbox({
      environmentId: project.environmentId,
      input: { projectId: project.id },
    }),
  );
  const taskRecipe = taskInbox.data?.recipes.find((recipe) => recipe.id === taskRecipeId);
  const [predecessorId, setPredecessorId] = useState("");
  const [condition, setCondition] = useState<"completed" | "verified">("verified");
  const [onFailure, setOnFailure] = useState<"hold" | "cancel">("hold");
  const schedules = useEnvironmentQuery(
    orchestrationEnvironment.workspaceSchedules({
      environmentId: project.environmentId,
      input: { projectId: project.id },
    }),
  );
  const runtime = useEnvironmentQuery(
    orchestrationEnvironment.workspaceRuntime({
      environmentId: project.environmentId,
      input: { projectId: project.id },
    }),
  );
  useOperationsRevisionRefresh(runtime.data, schedules.refresh);
  useOperationsRevisionRefresh(runtime.data, runs.refresh);
  const upsertSchedule = useAtomCommand(projectEnvironment.upsertWorkspaceSchedule, {
    label: "프로젝트 일정 저장",
    reportFailure: false,
  });
  const removeSchedule = useAtomCommand(projectEnvironment.removeWorkspaceSchedule, {
    label: "프로젝트 일정 제거",
    reportFailure: false,
  });
  const [title, setTitle] = useState("");
  const [task, setTask] = useState("");
  const [kind, setKind] = useState<WorkspaceScheduleTiming["kind"]>("interval");
  const [onceAt, setOnceAt] = useState(() =>
    localDateTimeInputValue(new Date(Date.now() + 60 * 60_000)),
  );
  const [everyMinutes, setEveryMinutes] = useState("60");
  const [dailyTime, setDailyTime] = useState("09:00");
  const [timeZone, setTimeZone] = useState(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Seoul",
  );
  const [enabled, setEnabled] = useState(true);
  const [saving, setSaving] = useState(false);

  const makeTiming = (): WorkspaceScheduleTiming | null => {
    if (kind === "after-run")
      return predecessorId
        ? { kind, runId: WorkspaceCollaborationRunId.make(predecessorId), condition, onFailure }
        : null;
    if (kind === "once") {
      const date = new Date(onceAt);
      return Number.isNaN(date.getTime()) ? null : { kind, runAt: date.toISOString() };
    }
    if (kind === "interval") {
      const minutes = Number(everyMinutes);
      return Number.isInteger(minutes) && minutes >= 1 && minutes <= 10_080
        ? { kind, everyMinutes: minutes, startAt: new Date().toISOString() }
        : null;
    }
    return /^([01]\d|2[0-3]):[0-5]\d$/.test(dailyTime) && timeZone.trim()
      ? { kind, localTime: dailyTime, timeZone: timeZone.trim() }
      : null;
  };

  const save = async () => {
    const timing = makeTiming();
    if (profileId && !profiles[profileId]) {
      toastManager.add({
        type: "warning",
        title: "선택한 프로필이 삭제되었습니다. 다시 선택하세요.",
      });
      return;
    }
    if (
      !title.trim() ||
      (!taskRecipe && !task.trim()) ||
      timing === null ||
      (taskRecipeId && !taskRecipe?.enabled)
    ) {
      toastManager.add({
        type: "warning",
        title: "스케줄 이름, 작업, 올바른 실행 시간을 입력하세요.",
      });
      return;
    }
    setSaving(true);
    try {
      const result = await upsertSchedule({
        environmentId: project.environmentId,
        input: {
          scheduleId: WorkspaceScheduleId.make(`schedule-${randomUUID()}`),
          projectId: project.id,
          title: title.trim(),
          task: taskRecipe ? `업무 양식: ${taskRecipe.name} v${taskRecipe.revision}` : task.trim(),
          enabled,
          timing: {
            ...timing,
            ...(taskRecipe
              ? {
                  taskRecipe: {
                    recipeId: taskRecipe.id,
                    revision: taskRecipe.revision,
                    inputs: recipeInputs,
                  },
                }
              : profiles[profileId]
                ? { executionProfile: profiles[profileId] }
                : {}),
          },
        },
      });
      if (!notifyCommandFailure(result, "무인 스케줄 저장 실패")) {
        setTitle("");
        setTask("");
        schedules.refresh();
        notifySuccess("무인 스케줄을 저장했습니다.");
      }
    } finally {
      setSaving(false);
    }
  };

  const updateExisting = async (schedule: WorkspaceSchedule, nextEnabled: boolean) => {
    const result = await upsertSchedule({
      environmentId: project.environmentId,
      input: {
        scheduleId: schedule.id,
        projectId: project.id,
        title: schedule.title,
        task: schedule.task,
        enabled: nextEnabled,
        timing: schedule.timing,
      },
    });
    if (!notifyCommandFailure(result, "스케줄 상태 변경 실패")) {
      schedules.refresh();
      notifySuccess(nextEnabled ? "스케줄을 활성화했습니다." : "스케줄을 일시 중지했습니다.");
    }
  };

  const remove = async (scheduleId: WorkspaceScheduleId) => {
    const result = await removeSchedule({
      environmentId: project.environmentId,
      input: { projectId: project.id, scheduleId },
    });
    if (!notifyCommandFailure(result, "스케줄 삭제 실패")) {
      schedules.refresh();
      notifySuccess("스케줄을 삭제했습니다.");
    }
  };

  return (
    <SectionCard
      id="project-automation"
      icon={AlarmClockIcon}
      title="스케줄러와 무인 작업"
      description="시간 예약과 특정 협업 실행 완료 후 후속 작업을 지원합니다. 검증 통과 조건은 저장된 검증 근거를 확인하며, 서버 재시작 후에도 같은 예약이 중복 실행되지 않습니다."
      action={
        <Badge variant="info">
          활성 {schedules.data?.schedules.filter((item) => item.enabled).length ?? 0}개
        </Badge>
      }
    >
      <div className="grid gap-5 xl:grid-cols-[minmax(20rem,0.82fr)_minmax(0,1.18fr)]">
        <div className="grid content-start gap-3 rounded-xl border border-border/70 p-4">
          <div className="flex items-center gap-2">
            <CalendarClockIcon className="size-4 text-primary" />
            <h3 className="text-sm font-semibold">새 무인 작업</h3>
          </div>
          <label className="grid gap-1.5 text-sm font-medium">
            이름
            <Input value={title} onChange={(event) => setTitle(event.currentTarget.value)} />
          </label>
          <label className="grid gap-1.5 text-sm font-medium">
            수행 명령 · 업무 양식을 선택하면 해당 양식으로 실행
            <Textarea
              size="sm"
              value={task}
              onChange={(event) => setTask(event.currentTarget.value)}
              placeholder="역할별 AI가 무인으로 분담할 작업"
            />
          </label>
          <label className="grid gap-1.5 text-sm font-medium">
            실행 방식
            <select
              className={SELECT_CLASS}
              value={kind}
              onChange={(event) =>
                setKind(event.currentTarget.value as WorkspaceScheduleTiming["kind"])
              }
            >
              <option value="once">1회 실행</option>
              <option value="interval">주기 실행</option>
              <option value="daily">매일 실행</option>
              <option value="after-run">협업 실행 완료 후</option>
            </select>
          </label>
          <label className="grid gap-1.5 text-sm">
            저장한 업무 양식
            <select
              className={SELECT_CLASS}
              value={taskRecipeId}
              onChange={(event) => {
                setTaskRecipeId(event.currentTarget.value);
                setRecipeInputs({});
              }}
            >
              <option value="">직접 입력한 작업 실행</option>
              {taskInbox.data?.recipes
                .filter((recipe) => recipe.enabled)
                .map((recipe) => (
                  <option key={recipe.id} value={recipe.id}>
                    {recipe.name} v{recipe.revision}
                  </option>
                ))}
            </select>
          </label>
          {taskRecipe ? (
            <div className="grid gap-3">
              {taskRecipe.parameters.map((field) => (
                <label key={field.name} className="grid gap-1.5 text-sm">
                  {field.label}
                  {field.required ? " *" : ""}
                  <Textarea
                    value={recipeInputs[field.name] ?? field.defaultValue}
                    onChange={(event) =>
                      setRecipeInputs((current) => ({
                        ...current,
                        [field.name]: event.currentTarget.value,
                      }))
                    }
                  />
                </label>
              ))}
              <p className="text-xs text-muted-foreground">
                등록 당시 양식 버전과 입력을 보존합니다. 자동 업무 접수함에서 실행 결과를
                확인하세요.
              </p>
            </div>
          ) : null}
          <ExecutionProfileSelect
            environmentId={project.environmentId}
            value={profileId}
            onChange={setProfileId}
          />
          {kind === "after-run" ? (
            <div className="grid gap-3">
              <label className="grid gap-1.5 text-sm">
                선행 실행
                <select
                  className={SELECT_CLASS}
                  value={predecessorId}
                  onChange={(event) => setPredecessorId(event.currentTarget.value)}
                >
                  <option value="">선행 실행 선택</option>
                  {(runs.data?.runs ?? []).map((run) => (
                    <option key={run.id} value={run.id}>
                      {run.task.slice(0, 60)} · {run.status} · {run.id}
                    </option>
                  ))}
                </select>
              </label>
              <label className="grid gap-1.5 text-sm">
                시작 조건
                <select
                  className={SELECT_CLASS}
                  value={condition}
                  onChange={(event) =>
                    setCondition(
                      event.currentTarget.value === "verified" ? "verified" : "completed",
                    )
                  }
                >
                  <option value="verified">완료 + 검증 통과 근거</option>
                  <option value="completed">실행 완료</option>
                </select>
              </label>
              <label className="grid gap-1.5 text-sm">
                선행 실행 실패·취소 시
                <select
                  className={SELECT_CLASS}
                  value={onFailure}
                  onChange={(event) =>
                    setOnFailure(event.currentTarget.value === "cancel" ? "cancel" : "hold")
                  }
                >
                  <option value="hold">보류하고 오류 표시</option>
                  <option value="cancel">후속 예약 취소</option>
                </select>
              </label>
            </div>
          ) : null}
          {kind === "once" ? (
            <label className="grid gap-1.5 text-sm font-medium">
              실행 시각
              <Input
                type="datetime-local"
                value={onceAt}
                onChange={(event) => setOnceAt(event.currentTarget.value)}
              />
            </label>
          ) : null}
          {kind === "interval" ? (
            <label className="grid gap-1.5 text-sm font-medium">
              실행 간격 (분)
              <Input
                type="number"
                min={1}
                max={10_080}
                value={everyMinutes}
                onChange={(event) => setEveryMinutes(event.currentTarget.value)}
              />
            </label>
          ) : null}
          {kind === "daily" ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="grid gap-1.5 text-sm font-medium">
                현지 시각
                <Input
                  type="time"
                  value={dailyTime}
                  onChange={(event) => setDailyTime(event.currentTarget.value)}
                />
              </label>
              <label className="grid gap-1.5 text-sm font-medium">
                IANA 시간대
                <Input
                  value={timeZone}
                  onChange={(event) => setTimeZone(event.currentTarget.value)}
                  placeholder="Asia/Seoul"
                />
              </label>
            </div>
          ) : null}
          <div className="flex items-center justify-between gap-3">
            <label className="flex items-center gap-2 text-sm font-medium">
              <Switch checked={enabled} onCheckedChange={setEnabled} />
              저장 즉시 활성화
            </label>
            <Button onClick={() => void save()} disabled={saving}>
              {saving ? <RefreshCcwIcon /> : <AlarmClockIcon />}
              스케줄 저장
            </Button>
          </div>
          <p className="rounded-lg bg-muted/35 p-3 text-xs leading-relaxed text-muted-foreground">
            무인 실행에는 승인 대기 모드를 사용할 수 없습니다. 역할의 실행 권한을 auto,
            auto-accept-edits 또는 full-access로 지정하세요.
          </p>
        </div>

        <div className="grid content-start gap-2">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold">등록된 스케줄</h3>
            <Button size="xs" variant="ghost" onClick={schedules.refresh}>
              <RefreshCcwIcon />
              새로고침
            </Button>
          </div>
          {schedules.error ? <p className="text-xs text-destructive">{schedules.error}</p> : null}
          {schedules.data?.schedules.map((schedule) => (
            <article key={schedule.id} className="rounded-xl border border-border/65 p-4">
              <div className="flex items-start gap-3">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                  <AlarmClockIcon className="size-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h4 className="text-sm font-semibold">{schedule.title}</h4>
                    <Badge variant={schedule.enabled ? "success" : "outline"}>
                      {schedule.enabled ? "활성" : "일시 정지"}
                    </Badge>
                  </div>
                  <p className="mt-1 line-clamp-2 whitespace-pre-wrap text-xs text-muted-foreground">
                    {schedule.task}
                  </p>
                  <dl className="mt-3 grid gap-1 text-[11px] sm:grid-cols-2">
                    <div>
                      <dt className="inline text-muted-foreground">규칙 · </dt>
                      <dd className="inline">
                        {timingSummary(schedule.timing)}
                        {schedule.timing.executionProfile
                          ? ` · ${schedule.timing.executionProfile.name} v${schedule.timing.executionProfile.revision}`
                          : ""}
                      </dd>
                    </div>
                    <div>
                      <dt className="inline text-muted-foreground">다음 실행 · </dt>
                      <dd className="inline">{formatTimestamp(schedule.nextTriggerAt)}</dd>
                    </div>
                    <div>
                      <dt className="inline text-muted-foreground">최근 실행 · </dt>
                      <dd className="inline">{formatTimestamp(schedule.lastTriggeredAt)}</dd>
                    </div>
                    <div>
                      <dt className="inline text-muted-foreground">최근 실행 ID · </dt>
                      <dd className="inline break-all font-mono">{schedule.lastRunId ?? "-"}</dd>
                    </div>
                  </dl>
                  {schedule.lastError ? (
                    <p className="mt-2 rounded-md bg-destructive/8 p-2 text-xs text-destructive">
                      {schedule.lastError}
                    </p>
                  ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Switch
                    checked={schedule.enabled}
                    onCheckedChange={(checked) => void updateExisting(schedule, checked)}
                    aria-label={`${schedule.title} 활성화`}
                  />
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label={`${schedule.title} 삭제`}
                    onClick={() => void remove(schedule.id)}
                  >
                    <Trash2Icon />
                  </Button>
                </div>
              </div>
            </article>
          ))}
          {schedules.data && schedules.data.schedules.length === 0 ? (
            <p className="rounded-xl border border-dashed border-border py-10 text-center text-sm text-muted-foreground">
              등록된 무인 스케줄이 없습니다.
            </p>
          ) : null}
        </div>
      </div>
    </SectionCard>
  );
}

export function WorkspaceControlCenter({ project }: { project: EnvironmentProject }) {
  const navigate = useNavigate();
  const match = useMatch({ from: "/control-center/$environmentId/$projectId", shouldThrow: false });
  const hash = useLocation({ select: (location) => location.hash });
  const isOwnRoute =
    match?.params.environmentId === project.environmentId && match?.params.projectId === project.id;
  const routeDomain = isOwnRoute ? match?.search.domain : undefined;
  const routeSection = isOwnRoute ? match?.search.section : undefined;
  const routeKnowledgeRun = isOwnRoute ? match?.search.knowledgeRun : undefined;
  const routeHash = isOwnRoute ? hash : "";

  const [tabState, setTabState] = useState(() =>
    resolveControlCenterTabState({
      domain: routeDomain,
      section: routeSection,
      hash: routeHash,
      knowledgeRun: routeKnowledgeRun,
    }),
  );
  const [heroExpanded, setHeroExpanded] = useState(false);
  const showFullHero = tabState.section === "project-status" || heroExpanded;

  useEffect(() => {
    if (!isOwnRoute) return;
    if (!routeDomain && !routeSection && !routeHash && !routeKnowledgeRun) return;
    const resolved = resolveControlCenterTabState({
      domain: routeDomain,
      section: routeSection,
      hash: routeHash,
      knowledgeRun: routeKnowledgeRun,
    });
    setTabState((current) =>
      current.domain === resolved.domain && current.section === resolved.section
        ? current
        : resolved,
    );
  }, [isOwnRoute, routeDomain, routeHash, routeKnowledgeRun, routeSection]);

  const navigateToScopedTab = useCallback(
    (nextDomain: ControlCenterDomainId, nextSection: ControlCenterSectionId) => {
      setTabState({ domain: nextDomain, section: nextSection });
      void navigate({
        to: "/control-center/$environmentId/$projectId",
        params: {
          environmentId: project.environmentId,
          projectId: project.id,
        },
        search: (previous) => ({
          ...(previous?.knowledgeRun ? { knowledgeRun: previous.knowledgeRun } : {}),
          domain: nextDomain,
          section: nextSection,
        }),
        hash: "",
        replace: true,
        resetScroll: false,
      });
    },
    [navigate, project.environmentId, project.id],
  );

  const selectDomain = useCallback(
    (nextDomain: ControlCenterDomainId) => {
      const nextSection =
        tabState.domain === nextDomain ? tabState.section : defaultSectionForDomain(nextDomain);
      navigateToScopedTab(nextDomain, nextSection);
    },
    [navigateToScopedTab, tabState.domain, tabState.section],
  );

  const selectSection = useCallback(
    (nextSection: ControlCenterSectionId) => {
      const def = getControlCenterSection(nextSection);
      navigateToScopedTab(def.domain, def.id);
    },
    [navigateToScopedTab],
  );

  const renderActiveSection = () => {
    switch (tabState.section) {
      case "mission-control":
        return (
          <MissionControlView project={project} onExit={() => selectSection("project-status")} />
        );
      case "project-status":
        return <WorkspaceRuntimeSection project={project} onSelectSection={selectSection} />;
      case "attention-inbox":
        return <AttentionInbox project={project} />;
      case "project-runs":
        return <CollaborationSection project={project} />;
      case "project-automation-results":
        return (
          <WorkspaceAutomationSection
            key={`${project.environmentId}:${project.id}`}
            project={project}
          />
        );
      case "project-profiles":
        return (
          <section id="project-profiles">
            <ExecutionProfiles
              environmentId={project.environmentId}
              folderKey={`${project.environmentId}:${project.id}`}
            />
          </section>
        );
      case "conversation-transfer":
        return <ConversationTransferSection project={project} />;
      case "project-memory":
        return <WorkspaceBoundarySection project={project} />;
      case "project-knowledge":
        return <KnowledgeSection project={project} />;
      case "project-tools":
        return (
          <McpToolsSection
            id="project-tools"
            environmentId={project.environmentId}
            workspaceRoot={project.workspaceRoot}
          />
        );
      case "extensions":
        return (
          <ExtensionsSection
            environmentId={project.environmentId}
            workspaceRoot={project.workspaceRoot}
          />
        );
      case "project-automation":
        return <ScheduleSection project={project} />;
      case "completion-checks":
        return (
          <div className="grid gap-5">
            <CompletionAutomationSection project={project} />
            <CompletionAutomationReceipts project={project} />
          </div>
        );
      case "project-accounts":
        return <RoleSection project={project} />;
      case "project-programs":
        return (
          <section id="project-programs" className="scroll-mt-24">
            <WorkspaceProgramsSection project={project} />
          </section>
        );
      case "project-monitoring":
        return <WorkspaceMonitoringSection project={project} />;
      case "project-terminals":
        return <ProjectTerminalsSection project={project} />;
    }
  };

  return (
    <main className="workspace-control-center min-h-0 flex-1 overflow-y-auto bg-muted/15">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-4 px-4 pt-4 pb-12 sm:px-6 lg:px-8">
        {showFullHero ? (
          <section
            data-project-hero-mode="expanded"
            className="rounded-2xl border border-border bg-card p-5 sm:p-6"
          >
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-primary">
                  <FolderCogIcon className="size-4" />
                  <span className="text-xs font-semibold uppercase tracking-wide">
                    프로젝트 작업실
                  </span>
                </div>
                <h1 className="mt-2 truncate text-2xl font-semibold tracking-tight">
                  {project.title}
                </h1>
                <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
                  {project.workspaceRoot}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge variant="success">
                  <ShieldCheckIcon /> 엄격 격리
                </Badge>
                <Badge variant="info">
                  <DatabaseIcon /> 기억 격리
                </Badge>
                <Badge variant="warning">
                  <CrownIcon /> 사용자 우선
                </Badge>
                {tabState.section !== "project-status" ? (
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    onClick={() => setHeroExpanded(false)}
                  >
                    상단 요약 접기
                  </Button>
                ) : null}
              </div>
            </div>
            <p className="mt-3 max-w-4xl text-sm leading-relaxed text-muted-foreground">
              AI 실행부터 도구 연결, 프로젝트 기억과 후속 자동화까지 관리하세요.
            </p>
            <div className="mt-5 grid grid-cols-2 gap-2 border-t border-border pt-4 sm:grid-cols-4">
              {(
                [
                  {
                    id: "project-runs",
                    label: "AI 실행",
                    detail: "작업 시작·결과 확인",
                    icon: BotIcon,
                  },
                  {
                    id: "project-profiles",
                    label: "실행 프로필",
                    detail: "저장한 구성 적용",
                    icon: SparklesIcon,
                  },
                  {
                    id: "project-tools",
                    label: "MCP 도구",
                    detail: "연결·제공 도구 확인",
                    icon: TerminalIcon,
                  },
                  {
                    id: "project-memory",
                    label: "프로젝트 기억",
                    detail: "RAG·지침·장기기억",
                    icon: DatabaseIcon,
                  },
                ] as const
              ).map(({ id, label, detail, icon: Icon }) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => selectSection(id)}
                  className="flex items-center gap-3 rounded-xl p-3 text-left transition-colors hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/8 text-primary">
                    <Icon className="size-4" />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-sm font-semibold">{label}</span>
                    <span className="mt-0.5 block text-[11px] text-muted-foreground">{detail}</span>
                  </span>
                </button>
              ))}
            </div>
          </section>
        ) : (
          <section
            data-project-hero-mode="compact"
            className="sticky top-0 z-20 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border/80 bg-card/95 px-4 py-2.5 shadow-xs backdrop-blur-md"
          >
            <div className="flex min-w-0 items-center gap-2.5">
              <FolderCogIcon className="size-4 shrink-0 text-primary" />
              <h1 className="truncate text-sm font-semibold tracking-tight">{project.title}</h1>
              <span className="hidden truncate font-mono text-[11px] text-muted-foreground md:inline">
                {project.workspaceRoot}
              </span>
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-1.5">
              <Badge variant="success" size="sm">
                <ShieldCheckIcon /> 엄격 격리
              </Badge>
              <Badge variant="info" size="sm">
                <DatabaseIcon /> 기억 격리
              </Badge>
              <Button type="button" size="xs" variant="ghost" onClick={() => setHeroExpanded(true)}>
                요약 펼치기
              </Button>
            </div>
          </section>
        )}

        <WorkspaceSectionNav
          activeDomain={tabState.domain}
          activeSection={tabState.section}
          onSelectDomain={selectDomain}
          onSelectSection={selectSection}
        />

        <div
          role="tabpanel"
          id={`cc-tabpanel-${tabState.section}`}
          aria-labelledby={`cc-section-tab-${tabState.section}`}
          data-active-domain={tabState.domain}
          data-active-section={tabState.section}
          className="grid gap-5"
        >
          {renderActiveSection()}
        </div>
      </div>
    </main>
  );
}
