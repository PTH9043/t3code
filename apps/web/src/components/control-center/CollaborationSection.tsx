import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useMatch, useNavigate } from "@tanstack/react-router";
import { RunKnowledgeDocuments } from "../knowledge/RunKnowledgeDocuments";
import { WorkspaceCollaborationRunId, type WorkspaceMeetingQuestion } from "@t3tools/contracts";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  AlertTriangleIcon,
  BrainCircuitIcon,
  CheckIcon,
  CrownIcon,
  PlayIcon,
  RefreshCcwIcon,
  SquareIcon,
} from "lucide-react";

import { randomUUID } from "~/lib/utils";
import { useEnvironmentSettings } from "~/hooks/useSettings";
import { useComposerRequestModeStore } from "~/askFirstStore";
import { ExecutionProfileSelect } from "./ExecutionProfiles";
import { orchestrationEnvironment } from "~/state/orchestration";
import { projectEnvironment } from "~/state/projects";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import ChatMarkdown from "../ChatMarkdown";
import { OrchestraRunControls } from "../chat/OrchestraRunControls";
import { WorkflowRunControls } from "./WorkflowRunControls";
import { WorkspaceWorkflowSection } from "./WorkspaceWorkflowSection";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { WorktreeOperationsBoard } from "./WorktreeOperationsBoard";
import { WorkspaceMeetingView } from "./WorkspaceMeetingView";
import { WorkspaceTaskGraphView } from "./WorkspaceTaskGraphView";
import { WorktreeDiffDialog, type WorktreeDiffTarget } from "./WorktreeDiffDialog";
import { runKeptWorktreeCount, runsAwaitingPerson } from "./taskGraphPresentation";
import {
  ROLE_LABELS,
  SectionCard,
  formatTimestamp,
  notifyCommandFailure,
  notifySuccess,
  runBadgeVariant,
  runStatusLabel,
  useOperationsRevisionRefresh,
} from "./controlCenterShared";

export function CollaborationSection({ project }: { project: EnvironmentProject }) {
  const navigate = useNavigate();
  const match = useMatch({ from: "/control-center/$environmentId/$projectId", shouldThrow: false });
  const selectedRun =
    match?.params.environmentId === project.environmentId && match.params.projectId === project.id
      ? match.search.knowledgeRun
      : undefined;
  const selectedRunElement = useRef<HTMLDetailsElement>(null);
  const runs = useEnvironmentQuery(
    orchestrationEnvironment.workspaceCollaborationRuns({
      environmentId: project.environmentId,
      input: {
        projectId: project.id,
        ...(selectedRun ? { runId: WorkspaceCollaborationRunId.make(selectedRun) } : {}),
      },
    }),
  );
  const foundRun = selectedRun && runs.data?.runs.some((run) => run.id === selectedRun);
  useEffect(() => {
    if (foundRun && selectedRunElement.current) {
      selectedRunElement.current.open = true;
      selectedRunElement.current.scrollIntoView({ block: "start" });
    }
  }, [foundRun, selectedRun]);
  const runtime = useEnvironmentQuery(
    orchestrationEnvironment.workspaceRuntime({
      environmentId: project.environmentId,
      input: { projectId: project.id },
    }),
  );
  useOperationsRevisionRefresh(runtime.data, runs.refresh);
  const requestRun = useAtomCommand(orchestrationEnvironment.startWorkflow, {
    label: "AI 작업 실행 요청",
    reportFailure: false,
  });
  const cancelRun = useAtomCommand(projectEnvironment.cancelWorkspaceCollaborationRun, {
    label: "오케스트라 실행 취소",
    reportFailure: false,
  });
  const answerRun = useAtomCommand(projectEnvironment.answerWorkspaceCollaborationRun, {
    label: "오케스트라 질문 답변",
    reportFailure: false,
  });
  const cleanupWorktree = useAtomCommand(orchestrationEnvironment.cleanupWorkspaceWorktree, {
    label: "worktree 정리",
    reportFailure: false,
  });
  const [task, setTask] = useState("");
  const [profileId, setProfileId] = useState("");
  const requestMode = useComposerRequestModeStore(
    (state) => state.modeByFolder[`${project.environmentId}:${project.id}`] ?? "direct",
  );
  const profiles = useEnvironmentSettings(
    project.environmentId,
    (settings) => settings.executionProfiles,
  );
  const [submitting, setSubmitting] = useState(false);
  const [confirmedConfiguration, setConfirmedConfiguration] = useState<string | null>(null);
  const startRequest = useRef<{ requestId: string; configuration: string } | null>(null);
  const configuration = JSON.stringify({
    task: task.trim(),
    profileId,
    profile: profiles[profileId] ?? null,
    model: project.defaultModelSelection,
    requestMode,
  });
  const pendingChanged =
    startRequest.current !== null && startRequest.current.configuration !== configuration;
  const [answeringRunId, setAnsweringRunId] = useState<WorkspaceCollaborationRunId | null>(null);
  const [diffTarget, setDiffTarget] = useState<WorktreeDiffTarget | null>(null);
  // A node conversation stuck on a provider approval parks the person just
  // like a meeting question; the runtime's thread evidence carries it.
  const blockedThreadIds = useMemo(
    () =>
      new Set(
        (runtime.data?.evidence ?? [])
          .filter((entry) => entry.source === "thread" && entry.status === "blocked")
          .map((entry) => entry.sourceId),
      ),
    [runtime.data],
  );
  const attention = useMemo(
    () => runsAwaitingPerson(runs.data?.runs ?? [], blockedThreadIds),
    [runs.data, blockedThreadIds],
  );

  const cleanup = async (runId: WorkspaceCollaborationRunId, worktreePath: string) => {
    const result = await cleanupWorktree({
      environmentId: project.environmentId,
      input: { projectId: project.id, runId, worktreePath },
    });
    if (notifyCommandFailure(result, "worktree 정리 실패")) return;
    if (result._tag === "Success" && result.value.status === "kept-dirty") {
      notifySuccess(
        "worktree를 보존했습니다.",
        result.value.detail ?? "병합되지 않은 변경이 남아 있습니다. diff를 먼저 검토하세요.",
      );
      return;
    }
    runs.refresh();
    notifySuccess("worktree를 정리했습니다.", "브랜치는 저장소에 그대로 남습니다.");
  };

  const answer = async (
    runId: WorkspaceCollaborationRunId,
    question: WorkspaceMeetingQuestion,
    text: string,
  ) => {
    setAnsweringRunId(runId);
    try {
      const result = await answerRun({
        environmentId: project.environmentId,
        input: {
          projectId: project.id,
          runId,
          question: question.question,
          questionRef: { nodeId: question.nodeId, askedAt: question.askedAt },
          answer: text,
        },
      });
      if (!notifyCommandFailure(result, "답변 전송 실패")) {
        runs.refresh();
        notifySuccess("답변을 전달했습니다.", "오케스트라가 이어서 진행됩니다.");
      }
    } finally {
      setAnsweringRunId(null);
    }
  };

  const submit = async () => {
    if (!task.trim()) return;
    if (profileId && !profiles[profileId]) {
      toastManager.add({ type: "warning", title: "선택한 프로필을 다시 선택하세요." });
      return;
    }
    if (!profiles[profileId] && !project.defaultModelSelection) {
      toastManager.add({
        type: "warning",
        title: "프로젝트 기본 모델이나 실행 프로필을 선택하세요.",
      });
      return;
    }
    if (
      pendingChanged ||
      (requestMode === "conditions" && confirmedConfiguration !== configuration)
    )
      return;
    startRequest.current ??= { requestId: randomUUID(), configuration };
    setSubmitting(true);
    try {
      const result = await requestRun({
        environmentId: project.environmentId,
        input: {
          projectId: project.id,
          task: task.trim(),
          requestId: startRequest.current.requestId,
          requestMode,
          conditionsConfirmed: confirmedConfiguration === configuration,
          ...(profiles[profileId] ? { executionProfile: profiles[profileId] } : {}),
          ...(!profiles[profileId] && project.defaultModelSelection
            ? {
                roleModels: {
                  coordinator: project.defaultModelSelection,
                  implementer: project.defaultModelSelection,
                  researcher: project.defaultModelSelection,
                },
              }
            : {}),
        },
      });
      if (!notifyCommandFailure(result, "AI 작업 실행 요청 실패")) {
        setTask("");
        startRequest.current = null;
        setConfirmedConfiguration(null);
        runs.refresh();
        notifySuccess(
          "사용자 최우선 실행을 시작했습니다.",
          "같은 프로젝트의 대기·실행 중 무인 작업보다 먼저 처리됩니다.",
        );
      }
    } finally {
      setSubmitting(false);
    }
  };

  const cancel = async (runId: WorkspaceCollaborationRunId) => {
    const result = await cancelRun({
      environmentId: project.environmentId,
      input: { projectId: project.id, runId },
    });
    if (!notifyCommandFailure(result, "오케스트라 실행 취소 실패")) {
      runs.refresh();
      notifySuccess("취소 요청을 전달했습니다.");
    }
  };

  return (
    <SectionCard
      id="project-runs"
      icon={CrownIcon}
      title="AI 작업 실행"
      description="AI가 계획한 작업과 저장된 워크플로의 진행, 검증과 결과를 함께 확인합니다. 사용자 요청은 같은 프로젝트의 무인 작업보다 항상 우선합니다."
      action={<Badge variant="warning">사용자 최우선</Badge>}
    >
      <div className="grid gap-5">
        <WorktreeOperationsBoard
          project={project}
          runs={runs.data?.runs ?? []}
          onDiff={setDiffTarget}
        />
        <div className="rounded-xl border border-primary/25 bg-primary/4 p-4">
          <div className="mb-3">
            <ExecutionProfileSelect
              environmentId={project.environmentId}
              value={profileId}
              onChange={setProfileId}
            />
          </div>
          <Textarea
            size="lg"
            value={task}
            onChange={(event) => setTask(event.currentTarget.value)}
            placeholder="달성할 최종 목표를 입력하세요. 선택한 총괄 모델이 작업 그래프를 설계합니다."
          />
          <p className="mt-2 text-xs text-muted-foreground">
            {profiles[profileId]
              ? "선택한 실행 프로필의 참가자와 권한을 사용합니다."
              : project.defaultModelSelection
                ? `프로젝트에서 선택한 모델: ${project.defaultModelSelection.model}`
                : "프로젝트 기본 모델 또는 실행 프로필을 선택하세요."}
          </p>
          {requestMode === "conditions" ? (
            <label className="mt-2 flex gap-2 text-xs">
              <input
                type="checkbox"
                checked={confirmedConfiguration === configuration}
                onChange={(event) =>
                  setConfirmedConfiguration(event.target.checked ? configuration : null)
                }
              />
              목표와 실행 설정을 확인했습니다.
            </label>
          ) : null}
          {pendingChanged ? (
            <p role="alert" className="mt-2 text-xs text-destructive">
              이전 실행 요청의 결과를 확인하려면 원래 설정으로 되돌리세요.
            </p>
          ) : null}
          <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-xs text-muted-foreground">
              지침·목표·메모리·RAG는 이 폴더에서만 결합되며 사용자 명령을 덮어쓸 수 없습니다.
            </p>
            <Button
              size="lg"
              onClick={() => void submit()}
              disabled={
                !task.trim() ||
                submitting ||
                pendingChanged ||
                (!profiles[profileId] && !project.defaultModelSelection) ||
                (requestMode === "conditions" && confirmedConfiguration !== configuration)
              }
            >
              {submitting ? <RefreshCcwIcon /> : <PlayIcon />}
              작업 그래프 실행
            </Button>
          </div>
        </div>

        <WorkspaceWorkflowSection
          key={`workflow:${project.environmentId}:${project.id}`}
          project={project}
        />

        {attention.length > 0 ? (
          <div className="grid gap-2 rounded-xl border border-amber-500/45 bg-amber-500/8 p-3">
            <div className="flex items-center gap-2">
              <AlertTriangleIcon
                className="size-4 text-amber-600 dark:text-amber-400"
                aria-hidden
              />
              <h3 className="text-sm font-semibold">
                내 답변을 기다리는 실행 {attention.length}건
              </h3>
            </div>
            <ul className="grid gap-2">
              {attention.map((item) => (
                <li key={item.runId} className="rounded-lg bg-background/70 p-2.5">
                  <p className="line-clamp-1 text-xs font-medium">{item.task}</p>
                  {item.liveQuestion ? (
                    <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                      {item.liveQuestion}
                    </p>
                  ) : null}
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {item.awaitingUser > 0 ? (
                      <Badge size="sm" variant="warning">
                        답변 대기 노드 {item.awaitingUser}
                      </Badge>
                    ) : null}
                    {item.queuedQuestions > 0 ? (
                      <Badge size="sm" variant="outline">
                        뒤이어 물을 질문 {item.queuedQuestions}
                      </Badge>
                    ) : null}
                    {item.blockedNodeThreads > 0 ? (
                      <Badge size="sm" variant="error">
                        대화 승인 대기 {item.blockedNodeThreads}
                      </Badge>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
            <p className="text-[11px] text-muted-foreground">
              아래 실행 이력에서 해당 실행을 펼치면 답변할 수 있습니다.
            </p>
          </div>
        ) : null}

        <div className="grid gap-2">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold">실행 이력</h3>
            {selectedRun && (
              <Link
                to="/control-center/$environmentId/$projectId"
                params={{ environmentId: project.environmentId, projectId: project.id }}
                search={{}}
                className="text-xs text-primary underline"
              >
                전체 실행 이력
              </Link>
            )}
            <Button size="xs" variant="ghost" onClick={runs.refresh}>
              <RefreshCcwIcon />
              새로고침
            </Button>
          </div>
          {runs.error ? <p className="text-xs text-destructive">{runs.error}</p> : null}
          {selectedRun && runs.data && !foundRun && (
            <p role="status">이 프로젝트에서 원본 실행을 찾을 수 없습니다.</p>
          )}
          {runs.data?.runs.map((run) => (
            <details
              key={run.id}
              ref={run.id === selectedRun ? selectedRunElement : undefined}
              className="group rounded-xl border border-border/65 p-3 open:bg-muted/15"
            >
              <summary className="flex cursor-pointer list-none items-start gap-3">
                <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                  {run.status === "running" ? (
                    <RefreshCcwIcon className="size-4" />
                  ) : run.status === "completed" ? (
                    <CheckIcon className="size-4" />
                  ) : (
                    <BrainCircuitIcon className="size-4" />
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="line-clamp-2 text-sm font-medium">{run.task}</span>
                  <span className="mt-1 block text-[11px] text-muted-foreground">
                    {run.source === "automation"
                      ? "자동 업무"
                      : run.source === "user"
                        ? "사용자 명령"
                        : run.source === "incident"
                          ? `프로그램 장애 ${run.incidentId}`
                          : run.source === "integrity"
                            ? "무결성 수렴"
                            : `스케줄 ${run.scheduleId}`}{" "}
                    · {formatTimestamp(run.createdAt)}
                  </span>
                </span>
                {run.orchestra ? (
                  <Badge variant="info">
                    오케스트라 · 폭 {run.orchestra.maxParallel}
                    {run.orchestra.isolateWorktrees ? " · 격리" : ""}
                  </Badge>
                ) : null}
                {run.workflow ? (
                  <Badge variant="info">워크플로 · v{run.workflow.definitionRevision}</Badge>
                ) : null}
                {["completed", "failed", "cancelled"].includes(run.status) &&
                runKeptWorktreeCount(run.graph) > 0 ? (
                  <Badge variant="warning">정리 대기 {runKeptWorktreeCount(run.graph)}</Badge>
                ) : null}
                {run.meeting?.pendingQuestion ? <Badge variant="warning">답변 필요</Badge> : null}
                <Badge variant={runBadgeVariant(run.status)}>{runStatusLabel(run.status)}</Badge>
              </summary>
              <div className="mt-4 grid gap-3 border-t border-border/50 pt-3">
                <RunKnowledgeDocuments project={project} runId={run.id} />
                {run.meeting ? (
                  <WorkspaceMeetingView
                    meeting={run.meeting}
                    canAnswer={run.status === "queued" || run.status === "running"}
                    answering={answeringRunId === run.id}
                    onAnswer={(question, text) => void answer(run.id, question, text)}
                  />
                ) : null}
                <OrchestraRunControls environmentId={project.environmentId} run={run} />
                <WorkflowRunControls
                  environmentId={project.environmentId}
                  run={run}
                  onRefresh={runs.refresh}
                />
                {run.graph ? (
                  <WorkspaceTaskGraphView
                    graph={run.graph}
                    participants={run.meeting?.participants}
                    onOpenThread={({ threadId }) =>
                      void navigate({
                        to: "/$environmentId/$threadId",
                        params: { environmentId: project.environmentId, threadId },
                      })
                    }
                    onOpenDiff={({ node, worktreePath }) =>
                      setDiffTarget({
                        environmentId: project.environmentId,
                        worktreePath,
                        branch: node.branch,
                        nodeTitle: node.title,
                      })
                    }
                    onCleanupWorktree={
                      ["completed", "failed", "cancelled"].includes(run.status)
                        ? ({ worktreePath }) => void cleanup(run.id, worktreePath)
                        : undefined
                    }
                  />
                ) : (
                  <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                    {run.steps.map((step) => (
                      <div key={step.index} className="rounded-lg bg-muted/35 p-3">
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate text-xs font-semibold">
                            {step.index + 1}. {ROLE_LABELS[step.role]}
                          </span>
                          <Badge variant={runBadgeVariant(step.status)}>
                            {runStatusLabel(step.status)}
                          </Badge>
                        </div>
                        <p className="mt-1 truncate text-[10px] text-muted-foreground">
                          {step.modelSelection.instanceId} · {step.modelSelection.model}
                        </p>
                        {step.output ? (
                          <p className="mt-2 line-clamp-4 whitespace-pre-wrap text-xs leading-relaxed">
                            {step.output}
                          </p>
                        ) : null}
                        {step.error ? (
                          <p className="mt-2 text-xs text-destructive">{step.error}</p>
                        ) : null}
                      </div>
                    ))}
                  </div>
                )}
                {run.finalOutput ? (
                  <div>
                    <h4 className="mb-1 text-xs font-semibold">최종 통합 결과</h4>
                    <div className="max-h-96 overflow-auto rounded-lg bg-muted/40 p-3 text-xs leading-relaxed">
                      <ChatMarkdown text={run.finalOutput} cwd={undefined} />
                    </div>
                  </div>
                ) : null}
                {run.error ? <p className="text-xs text-destructive">{run.error}</p> : null}
                {run.status === "queued" || run.status === "running" ? (
                  <Button
                    variant="destructive-outline"
                    size="sm"
                    className="justify-self-end"
                    onClick={() => void cancel(run.id)}
                  >
                    <SquareIcon />
                    실행 취소
                  </Button>
                ) : null}
              </div>
            </details>
          ))}
          {runs.data && runs.data.runs.length === 0 ? (
            <p className="rounded-xl border border-dashed border-border py-8 text-center text-sm text-muted-foreground">
              아직 오케스트라 실행 이력이 없습니다.
            </p>
          ) : null}
        </div>
      </div>
      <WorktreeDiffDialog target={diffTarget} onClose={() => setDiffTarget(null)} />
    </SectionCard>
  );
}
