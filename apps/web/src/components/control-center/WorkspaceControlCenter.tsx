import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  DEFAULT_WORKSPACE_AGENT_KNOWLEDGE_SETTINGS,
  DEFAULT_WORKSPACE_CONVERSATION_RAG_SETTINGS,
  DEFAULT_WORKSPACE_ORCHESTRA_DEFAULTS,
  ProviderInstanceId,
  ThreadId,
  WorkspaceKnowledgeItemId,
  WorkspaceScheduleId,
  type ProviderInteractionMode,
  type RuntimeMode,
  type TerminalSummary,
  type WorkspaceAgentRole,
  type WorkspaceAgentRoleBinding,
  type WorkspaceKnowledgeKind,
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

import { deriveProviderInstanceEntries } from "~/providerInstances";
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
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { ProviderAccountUsage } from "../settings/ProviderAccountUsage";
import { WorkspaceMonitoringSection } from "./WorkspaceMonitoringSection";
import { WorkspaceProgramsSection } from "./WorkspaceProgramsSection";
import { CollaborationSection } from "./CollaborationSection";
import {
  ROLE_LABELS,
  SectionCard,
  formatTimestamp,
  notifyCommandFailure,
  notifySuccess,
  useOperationsRevisionRefresh,
} from "./controlCenterShared";

const SELECT_CLASS =
  "h-9 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground outline-none transition-shadow focus:border-ring focus:ring-3 focus:ring-ring/20 dark:bg-input/32";

const KNOWLEDGE_KIND_LABELS: Readonly<Record<WorkspaceKnowledgeKind, string>> = {
  directive: "사용자 지침",
  goal: "영속 목표",
  "rag-source": "RAG 자료",
  "run-memory": "실행 기억",
  "working-memory": "작업 기억",
  "long-term-memory": "장기기억",
  prompt: "프롬프트 조각",
};

const ALL_ROLES = Object.keys(ROLE_LABELS) as WorkspaceAgentRole[];
const ALL_KNOWLEDGE_KINDS = Object.keys(KNOWLEDGE_KIND_LABELS) as WorkspaceKnowledgeKind[];

function providerStatusLabel(status: string): string {
  if (status === "ready") return "준비됨";
  if (status === "warning") return "주의";
  if (status === "error") return "오류";
  if (status === "disabled") return "사용 안 함";
  return status;
}

function numericKnowledgeTag(tags: ReadonlyArray<string>, prefix: string): number | null {
  const value = tags.find((tag) => tag.startsWith(prefix))?.slice(prefix.length);
  if (value === undefined) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
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

function WorkspaceRuntimeSection({ project }: { project: EnvironmentProject }) {
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
    const sectionId =
      item.source === "program" || item.source === "incident"
        ? "project-programs"
        : item.source === "collaboration"
          ? "project-runs"
          : item.source === "monitoring"
            ? "project-monitoring"
            : "project-automation";
    document.getElementById(sectionId)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <SectionCard
      id="project-status"
      icon={ActivityIcon}
      title="프로젝트 운영 상태"
      description="대화·에이전트·프로그램·장애 보고·작업 그래프를 프로젝트 경계 안에서 함께 판정합니다. 상태마다 실제 프로젝션 근거를 남기므로 단순 화면 추측으로 자동 작업을 승인하지 않습니다."
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
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-8">
            {[
              ["작업 중 대화", counts?.workingThreadCount ?? 0],
              ["확인할 대화", counts?.blockedThreadCount ?? 0],
              ["오류 대화", counts?.failedThreadCount ?? 0],
              ["새 완료", counts?.completedUnseenCount ?? 0],
              ["실행 프로그램", counts?.activeProgramCount ?? 0],
              ["비정상 프로그램", counts?.unhealthyProgramCount ?? 0],
              ["열린 장애", counts?.openIncidentCount ?? 0],
              ["실행 작업 그래프", counts?.activeCollaborationCount ?? 0],
              ["활성 스케줄", counts?.enabledScheduleCount ?? 0],
            ].map(([label, value]) => (
              <div key={label} className="rounded-xl border border-border/65 bg-muted/20 p-3">
                <p className="text-[11px] text-muted-foreground">{label}</p>
                <p className="mt-1 text-xl font-semibold tabular-nums">{value}</p>
              </div>
            ))}
          </div>

          <div className="rounded-xl border border-border/65">
            <div className="flex items-center justify-between gap-3 border-b border-border/60 px-4 py-3">
              <div>
                <h3 className="text-sm font-semibold">판정 근거</h3>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  확인 또는 오류 근거 {counts?.attentionCount ?? 0}개 · 갱신{" "}
                  {formatTimestamp(snapshot.updatedAt)}
                </p>
              </div>
              {(counts?.attentionCount ?? 0) > 0 ? (
                <AlertTriangleIcon className="size-4 text-warning" />
              ) : (
                <CheckIcon className="size-4 text-success" />
              )}
            </div>
            <div className="divide-y divide-border/55">
              {snapshot.evidence.slice(0, 12).map((item) => (
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
              {snapshot.evidence.length === 0 ? (
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
  }, [
    configuredAgentKnowledge,
    configuredConversationRag,
    configuredOrchestra,
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
  const settingsChanged =
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
      description="이 폴더의 프로젝트 ID가 지식·RAG·실행·스케줄의 보안 경계입니다. 같은 계정이나 같은 모델을 사용해도 다른 프로젝트의 기억은 조회하거나 결합하지 않습니다."
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
                  협업 실행이 끝나면 각 작업의 결과를 빠짐없이 압축해 검색 자료로 등록합니다.
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
              페이블이 고른 기억 후보와 별개로, 조사·구현·검증 결과 자체가
              <span className="font-mono"> collaboration-outputs </span>
              폴더에 등록됩니다. 끄면 이후 실행부터 등록하지 않으며 이미 등록된 자료는 남습니다.
            </p>
          </div>
          <div className="grid gap-3 border-t border-border/50 pt-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium">무인 실행 오케스트라 기본값</p>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  스케줄·장애 복구처럼 사람이 보내지 않는 실행에 적용됩니다. 회의에서 직접 보낸
                  실행은 전송 시 설정이 우선합니다.
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
              <dd className="mt-1 font-medium text-success-foreground">폴더 외부 지식 조회 금지</dd>
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
      input: { projectId: project.id },
    }),
  );
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
  const [tags, setTags] = useState("");
  const [saving, setSaving] = useState(false);
  const [ragText, setRagText] = useState("");
  const [ragRequest, setRagRequest] = useState("");
  const [composeTask, setComposeTask] = useState("");
  const [composeRequest, setComposeRequest] = useState("");
  const rag = useEnvironmentQuery(
    ragRequest
      ? orchestrationEnvironment.workspaceRag({
          environmentId: project.environmentId,
          input: {
            projectId: project.id,
            query: ragRequest,
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

  const save = async () => {
    if (!title.trim() || !content.trim()) {
      toastManager.add({ type: "warning", title: "제목과 내용을 입력하세요." });
      return;
    }
    setSaving(true);
    try {
      const result = await upsertKnowledge({
        environmentId: project.environmentId,
        input: {
          projectId: project.id,
          itemId: WorkspaceKnowledgeItemId.make(`knowledge-${randomUUID()}`),
          kind,
          title: title.trim(),
          content: content.trim(),
          status: "active",
          origin: "user",
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
        setTags("");
        knowledge.refresh();
        notifySuccess(`${KNOWLEDGE_KIND_LABELS[kind]}을 저장했습니다.`);
      }
    } finally {
      setSaving(false);
    }
  };

  const archive = async (itemId: WorkspaceKnowledgeItemId) => {
    const result = await archiveKnowledge({
      environmentId: project.environmentId,
      input: { projectId: project.id, itemId },
    });
    if (!notifyCommandFailure(result, "지식 항목 보관 실패")) {
      knowledge.refresh();
      notifySuccess("항목을 보관 처리했습니다.");
    }
  };

  return (
    <SectionCard
      id="project-knowledge"
      icon={DatabaseIcon}
      title="RAG · 메모리 · 장기기억 · 프롬프트"
      description="모든 자료는 이 프로젝트에만 귀속됩니다. 사용자 지침은 결합 프롬프트의 최상위 권한으로 유지되고, 검색 자료와 에이전트 기억은 비권위 참고 문맥으로만 들어갑니다."
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
              <Input value={title} onChange={(event) => setTitle(event.currentTarget.value)} />
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
              프로젝트에 저장
            </Button>
          </div>
        </div>

        <div className="grid gap-4 xl:grid-cols-2">
          <div className="grid content-start gap-3 rounded-xl border border-border/70 p-4">
            <div className="flex items-center gap-2">
              <SearchIcon className="size-4 text-primary" />
              <h3 className="text-sm font-semibold">격리 RAG 검색</h3>
            </div>
            <div className="flex gap-2">
              <Input
                value={ragText}
                onChange={(event) => setRagText(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && ragText.trim()) setRagRequest(ragText.trim());
                }}
                placeholder="이 프로젝트 안에서만 검색"
              />
              <Button
                variant="outline"
                onClick={() => ragText.trim() && setRagRequest(ragText.trim())}
                disabled={!ragText.trim()}
              >
                <SearchIcon />
                검색
              </Button>
            </div>
            {rag.error ? <p className="text-xs text-destructive">{rag.error}</p> : null}
            {rag.data?.matches.map((match) => (
              <div key={match.itemId} className="rounded-lg bg-muted/35 p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-xs font-semibold">{match.title}</span>
                  <Badge variant="outline">{KNOWLEDGE_KIND_LABELS[match.kind]}</Badge>
                </div>
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
              placeholder="수행할 작업을 입력하면 지침 → 목표 → 프롬프트 → 메모리 → RAG 순서로 결합합니다."
            />
            <Button
              variant="outline"
              className="justify-self-end"
              onClick={() => composeTask.trim() && setComposeRequest(composeTask.trim())}
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
                  <Badge variant="info">자료 {composedPrompt.data.sourceItemIds.length}</Badge>
                  <Badge variant="info">RAG {composedPrompt.data.ragMatches.length}</Badge>
                  {composedPrompt.data.truncated ? (
                    <Badge variant="warning">일부 생략</Badge>
                  ) : null}
                </div>
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
            <Button size="xs" variant="ghost" onClick={knowledge.refresh}>
              <RefreshCcwIcon />
              새로고침
            </Button>
          </div>
          {knowledge.error ? <p className="text-xs text-destructive">{knowledge.error}</p> : null}
          <div className="grid gap-2 lg:grid-cols-2">
            {knowledge.data?.items.map((item) => (
              <article key={item.id} className="rounded-xl border border-border/60 p-3">
                <div className="flex items-start gap-2">
                  <FileStackIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <h4 className="truncate text-sm font-medium">{item.title}</h4>
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
                    <p className="mt-1 line-clamp-3 whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground">
                      {item.content}
                    </p>
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
                  {item.status !== "archived" ? (
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label="항목 보관"
                      onClick={() => void archive(item.id)}
                    >
                      <ArchiveIcon />
                    </Button>
                  ) : null}
                </div>
              </article>
            ))}
          </div>
        </div>
      </div>
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
      title="페이블 · 코덱스 · 그록 역할과 CLI 계정"
      description="페이블은 그래프 설계·검증·종합을, 코덱스는 구현·디버깅을, 그록은 최신 정보와 소셜 조사를 담당합니다. 각 논리 역할은 정확한 공급자 인스턴스와 모델에 고정되며 개인·업무 계정 배정은 프로젝트별로 독립됩니다."
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
          <div className="grid gap-3 xl:grid-cols-2">
            {providerEntries.map((provider) => (
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
                {providerEntries.map((provider) => (
                  <option key={provider.instanceId} value={provider.instanceId}>
                    {provider.displayName} ({provider.instanceId}) ·{" "}
                    {providerStatusLabel(provider.status)}
                  </option>
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
              협업 실행에 포함
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
  if (timing.kind === "once") return `1회 · ${formatTimestamp(timing.runAt)}`;
  if (timing.kind === "interval") {
    return `${timing.everyMinutes}분 간격 · ${formatTimestamp(timing.startAt)}부터`;
  }
  return `매일 ${timing.localTime} · ${timing.timeZone}`;
}

function ScheduleSection({ project }: { project: EnvironmentProject }) {
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
    if (!title.trim() || !task.trim() || timing === null) {
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
          task: task.trim(),
          enabled,
          timing,
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
      description="1회·주기·IANA 시간대 기반 매일 실행을 지원합니다. 서버 재시작 뒤에도 복구되며, 같은 프로젝트의 실행 중첩은 건너뛰고 사용자 명령이 들어오면 무인 실행이 선점됩니다."
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
            수행 명령
            <Textarea
              size="sm"
              value={task}
              onChange={(event) => setTask(event.currentTarget.value)}
              placeholder="역할별 AI가 무인으로 협업할 작업"
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
            </select>
          </label>
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
                      <dd className="inline">{timingSummary(schedule.timing)}</dd>
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
  return (
    <main className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-5 px-4 py-6 sm:px-6 lg:px-8">
        <section className="rounded-2xl border border-border/70 bg-gradient-to-br from-primary/7 via-card to-card p-5 sm:p-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-primary">
                <FolderCogIcon className="size-4" />
                <span className="text-xs font-semibold uppercase tracking-wide">
                  장기 운영 프로젝트
                </span>
              </div>
              <h1 className="mt-2 truncate text-2xl font-semibold tracking-tight">
                {project.title}
              </h1>
              <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
                {project.workspaceRoot}
              </p>
            </div>
            <div className="flex flex-wrap gap-1.5">
              <Badge variant="success">
                <ShieldCheckIcon /> 엄격 격리
              </Badge>
              <Badge variant="info">
                <DatabaseIcon /> 기억 격리
              </Badge>
              <Badge variant="warning">
                <CrownIcon /> 사용자 우선
              </Badge>
            </div>
          </div>
          <p className="mt-4 max-w-4xl text-sm leading-relaxed text-muted-foreground">
            이 폴더는 독립된 장기 운영 단위입니다. 지침과 목표는 세션이 끝나도 남고, 역할별 AI는
            같은 폴더의 문맥만 공유하며, 실행 결과는 다시 이 프로젝트의 실행 기억으로 축적됩니다.
          </p>
        </section>

        <nav
          aria-label="프로젝트 내부 영역"
          className="sticky top-0 z-10 -mx-1 flex gap-1 overflow-x-auto rounded-xl border border-border/70 bg-background/92 p-1 shadow-sm backdrop-blur"
        >
          {[
            ["project-status", "상태"],
            ["project-programs", "프로그램·장애"],
            ["project-monitoring", "모니터링"],
            ["project-terminals", "터미널"],
            ["project-runs", "실행"],
            ["project-accounts", "AI 계정"],
            ["project-memory", "RAG·메모리"],
            ["project-knowledge", "지식"],
            ["project-automation", "자동화"],
          ].map(([id, label]) => (
            <a
              key={id}
              href={`#${id}`}
              className="shrink-0 rounded-lg px-3 py-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {label}
            </a>
          ))}
        </nav>

        <WorkspaceRuntimeSection project={project} />
        <ProjectTerminalsSection project={project} />
        <WorkspaceBoundarySection project={project} />
        <section id="project-programs" className="scroll-mt-24">
          <WorkspaceProgramsSection project={project} />
        </section>
        <WorkspaceMonitoringSection project={project} />
        <CollaborationSection project={project} />
        <RoleSection project={project} />
        <KnowledgeSection project={project} />
        <ScheduleSection project={project} />
      </div>
    </main>
  );
}
