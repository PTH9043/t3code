import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { WorkspaceCollaborationRunId } from "@t3tools/contracts";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  BrainCircuitIcon,
  CheckIcon,
  CrownIcon,
  PlayIcon,
  RefreshCcwIcon,
  SquareIcon,
} from "lucide-react";

import { randomUUID } from "~/lib/utils";
import { orchestrationEnvironment } from "~/state/orchestration";
import { projectEnvironment } from "~/state/projects";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import ChatMarkdown from "../ChatMarkdown";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { WorkspaceMeetingView } from "./WorkspaceMeetingView";
import { WorkspaceTaskGraphView } from "./WorkspaceTaskGraphView";
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
  const runs = useEnvironmentQuery(
    orchestrationEnvironment.workspaceCollaborationRuns({
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
  useOperationsRevisionRefresh(runtime.data, runs.refresh);
  const requestRun = useAtomCommand(projectEnvironment.requestWorkspaceCollaborationRun, {
    label: "프로젝트 협업 요청",
    reportFailure: false,
  });
  const cancelRun = useAtomCommand(projectEnvironment.cancelWorkspaceCollaborationRun, {
    label: "프로젝트 협업 취소",
    reportFailure: false,
  });
  const answerRun = useAtomCommand(projectEnvironment.answerWorkspaceCollaborationRun, {
    label: "회의 질문 답변",
    reportFailure: false,
  });
  const [task, setTask] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [answeringRunId, setAnsweringRunId] = useState<WorkspaceCollaborationRunId | null>(null);

  const answer = async (runId: WorkspaceCollaborationRunId, question: string, text: string) => {
    setAnsweringRunId(runId);
    try {
      const result = await answerRun({
        environmentId: project.environmentId,
        input: { projectId: project.id, runId, question, answer: text },
      });
      if (!notifyCommandFailure(result, "답변 전송 실패")) {
        runs.refresh();
        notifySuccess("답변을 전달했습니다.", "회의가 이어서 진행됩니다.");
      }
    } finally {
      setAnsweringRunId(null);
    }
  };

  const submit = async () => {
    if (!task.trim()) return;
    setSubmitting(true);
    try {
      const result = await requestRun({
        environmentId: project.environmentId,
        input: {
          runId: WorkspaceCollaborationRunId.make(randomUUID()),
          projectId: project.id,
          task: task.trim(),
        },
      });
      if (!notifyCommandFailure(result, "협업 실행 요청 실패")) {
        setTask("");
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
    if (!notifyCommandFailure(result, "협업 실행 취소 실패")) {
      runs.refresh();
      notifySuccess("취소 요청을 전달했습니다.");
    }
  };

  return (
    <SectionCard
      id="project-runs"
      icon={CrownIcon}
      title="사용자 목표 기반 작업 그래프"
      description="페이블이 목표를 의존성 그래프로 분해하고 코덱스·그록 작업을 필요한 순서와 병렬 경로로 실행합니다. 생성 결과는 별도 검증을 통과해야 종합되며, 실패하면 분류에 맞는 새 경로를 추가합니다. 사용자 요청은 같은 프로젝트의 무인 작업보다 항상 우선합니다."
      action={<Badge variant="warning">사용자 최우선</Badge>}
    >
      <div className="grid gap-5">
        <div className="rounded-xl border border-primary/25 bg-primary/4 p-4">
          <Textarea
            size="lg"
            value={task}
            onChange={(event) => setTask(event.currentTarget.value)}
            placeholder="달성할 최종 목표를 입력하세요. 페이블이 작업 그래프를 설계합니다."
          />
          <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-xs text-muted-foreground">
              지침·목표·메모리·RAG는 이 폴더에서만 결합되며 사용자 명령을 덮어쓸 수 없습니다.
            </p>
            <Button size="lg" onClick={() => void submit()} disabled={!task.trim() || submitting}>
              {submitting ? <RefreshCcwIcon /> : <PlayIcon />}
              작업 그래프 실행
            </Button>
          </div>
        </div>

        <div className="grid gap-2">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold">실행 이력</h3>
            <Button size="xs" variant="ghost" onClick={runs.refresh}>
              <RefreshCcwIcon />
              새로고침
            </Button>
          </div>
          {runs.error ? <p className="text-xs text-destructive">{runs.error}</p> : null}
          {runs.data?.runs.map((run) => (
            <details
              key={run.id}
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
                    {run.source === "user"
                      ? "사용자 명령"
                      : run.source === "incident"
                        ? `프로그램 장애 ${run.incidentId}`
                        : run.source === "integrity"
                          ? "무결성 수렴"
                          : `스케줄 ${run.scheduleId}`}{" "}
                    · {formatTimestamp(run.createdAt)}
                  </span>
                </span>
                {run.meeting?.pendingQuestion ? <Badge variant="warning">답변 필요</Badge> : null}
                <Badge variant={runBadgeVariant(run.status)}>{runStatusLabel(run.status)}</Badge>
              </summary>
              <div className="mt-4 grid gap-3 border-t border-border/50 pt-3">
                {run.meeting ? (
                  <WorkspaceMeetingView
                    meeting={run.meeting}
                    canAnswer={run.status === "queued" || run.status === "running"}
                    answering={answeringRunId === run.id}
                    onAnswer={(question, text) => void answer(run.id, question, text)}
                  />
                ) : null}
                {run.graph ? (
                  <WorkspaceTaskGraphView
                    graph={run.graph}
                    onOpenThread={({ threadId }) =>
                      void navigate({
                        to: "/$environmentId/$threadId",
                        params: { environmentId: project.environmentId, threadId },
                      })
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
              아직 협업 실행 이력이 없습니다.
            </p>
          ) : null}
        </div>
      </div>
    </SectionCard>
  );
}
