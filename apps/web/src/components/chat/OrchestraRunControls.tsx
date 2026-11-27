import { WorkspaceAgentControlPanel } from "./WorkspaceAgentControlPanel";
import {
  findOrchestraPlanCycle,
  orchestraPlanDependencyWouldCycle,
} from "./orchestraPlanDependencies";
import { useState } from "react";
import type {
  EnvironmentId,
  WorkspaceCollaborationRun,
  WorkspaceOrchestraPlanEdit,
} from "@t3tools/contracts";
import { projectEnvironment } from "~/state/projects";
import { orchestrationEnvironment } from "~/state/orchestration";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { notifyCommandFailure, notifySuccess } from "../control-center/controlCenterShared";
import { WorktreeDiffDialog, type WorktreeDiffTarget } from "../control-center/WorktreeDiffDialog";
import { Button } from "../ui/button";

type Run = Pick<WorkspaceCollaborationRun, "id" | "status" | "graph" | "meeting"> &
  Partial<Pick<WorkspaceCollaborationRun, "projectId" | "orchestra">>;
const INPUT = "w-full min-w-0 rounded-md border border-input bg-background px-2 py-1.5 text-xs";
const DELIVERY_LABEL = {
  verifying: "실제 검증 중",
  passed: "검증 통과",
  failed: "검증 실패 · 확인 필요",
  "needs-verification": "검증 명령 필요",
  "awaiting-integration": "변경 통합 대기",
} as const;

/** The same controls are rendered in chat and the project control center. */
export function OrchestraRunControls({
  environmentId,
  run,
}: {
  environmentId: EnvironmentId;
  run: Run;
}) {
  const graph = run.graph;
  const [diff, setDiff] = useState<WorktreeDiffTarget | null>(null);
  if (!graph) return null;
  const pending = run.status === "running" && graph.planReview?.status === "pending";
  return (
    <div className="space-y-2" data-orchestra-controls={run.id}>
      {pending && run.projectId && (
        <PlanEditor
          key={run.id + ":" + graph.planReview!.revision}
          environmentId={environmentId}
          run={{ ...run, projectId: run.projectId }}
        />
      )}
      {run.projectId && (run.meeting?.threadId || graph.nodes.some((node) => node.threadId)) && (
        <WorkspaceAgentControlPanel
          environmentId={environmentId}
          run={{ ...run, projectId: run.projectId }}
        />
      )}
      {graph.delivery && (
        <div
          className="space-y-2 rounded-md border border-border bg-background p-3 text-xs"
          role="status"
        >
          <p className="font-semibold">{DELIVERY_LABEL[graph.delivery.status]}</p>
          <p className="whitespace-pre-wrap break-words">{graph.delivery.detail}</p>
          {graph.delivery.commands.length > 0 && (
            <ul className="space-y-2">
              {graph.delivery.commands.map((receipt) => (
                <li key={receipt.logPath} className="break-all">
                  <code>{receipt.command}</code>
                  <p>
                    종료 코드 {receipt.exitCode ?? "없음"}
                    {receipt.timedOut ? " · 시간 초과" : ""}
                  </p>
                  <p className="text-muted-foreground">로그: {receipt.logPath}</p>
                </li>
              ))}
            </ul>
          )}
          {graph.delivery.worktrees.map((worktreePath) => (
            <div key={worktreePath} className="flex flex-wrap items-center gap-2">
              <code className="break-all">{worktreePath}</code>
              <Button
                size="xs"
                variant="outline"
                onClick={() =>
                  setDiff({
                    environmentId,
                    worktreePath,
                    branch:
                      graph.nodes.find((node) => node.worktreePath === worktreePath)?.branch ??
                      null,
                    nodeTitle: "오케스트라 변경",
                  })
                }
              >
                변경 검토
              </Button>
            </div>
          ))}
          {run.status === "running" && graph.delivery.status !== "verifying" && run.projectId && (
            <DeliveryRetry
              environmentId={environmentId}
              run={{ ...run, projectId: run.projectId }}
            />
          )}
        </div>
      )}
      {diff && <WorktreeDiffDialog target={diff} onClose={() => setDiff(null)} />}
    </div>
  );
}

function PlanEditor({
  environmentId,
  run,
}: {
  environmentId: EnvironmentId;
  run: Run & Pick<WorkspaceCollaborationRun, "projectId">;
}) {
  const graph = run.graph!;
  const nodes = graph.nodes.filter(
    (node) =>
      node.id !== "plan" &&
      ["orchestration", "research", "implementation", "debug"].includes(node.kind),
  );
  const gates = new Map(
    graph.nodes.flatMap((node) =>
      node.validationTargetId === null ? [] : [[node.id, node.validationTargetId] as const],
    ),
  );
  const [edits, setEdits] = useState<ReadonlyArray<WorkspaceOrchestraPlanEdit>>(() =>
    nodes.map((node) => ({
      nodeId: node.id,
      title: node.title,
      task: node.handoff.task,
      participantId: graph.workflowAssignment?.pendingNodeIds.includes(node.id)
        ? null
        : node.participantId,
      dependsOn: node.dependsOn.flatMap((id) => {
        const producer = gates.get(id) ?? id;
        return nodes.some((candidate) => candidate.id === producer) ? [producer] : [];
      }),
    })),
  );
  const [busy, setBusy] = useState(false);
  const cycle = findOrchestraPlanCycle(edits);
  const cycleLabel = cycle
    ?.map((id) => edits.find((edit) => edit.nodeId === id)?.title ?? id)
    .join(" → ");
  const review = useAtomCommand(projectEnvironment.reviewWorkspaceCollaborationRun, {
    label: "오케스트라 실행 계획 확인",
    reportFailure: false,
  });
  const runs = useEnvironmentQuery(
    orchestrationEnvironment.workspaceCollaborationRuns({
      environmentId,
      input: { projectId: run.projectId },
    }),
  );
  const update = (id: string, patch: Partial<WorkspaceOrchestraPlanEdit>) =>
    setEdits((current) =>
      current.map((edit) => (edit.nodeId === id ? { ...edit, ...patch } : edit)),
    );
  const submit = async (approve: boolean) => {
    setBusy(true);
    try {
      const result = await review({
        environmentId,
        input: {
          projectId: run.projectId,
          runId: run.id,
          expectedRevision: graph.planReview!.revision,
          edits: edits.map((edit) => ({
            ...edit,
            title: edit.title.trim(),
            task: edit.task.trim(),
          })),
          approve,
        },
      });
      if (notifyCommandFailure(result, "계획 저장 실패")) return;
      runs.refresh();
      notifySuccess(approve ? "확인한 계획으로 작업을 시작합니다." : "계획을 저장했습니다.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <fieldset
      disabled={busy}
      className="space-y-3 rounded-lg border border-border bg-background p-3"
      data-orchestra-plan-review
    >
      <legend className="px-1 text-sm font-semibold">실행 계획 확인</legend>
      <p className="text-xs text-muted-foreground">
        아래 계획은 아직 실행하지 않았습니다. 저장만 하거나 확인 후 시작할 수 있습니다.
      </p>
      {edits.map((edit) => (
        <details
          key={edit.nodeId}
          data-orchestra-plan-node={edit.nodeId}
          open
          className="rounded-md border border-border p-2"
        >
          <summary className="text-xs font-medium">{edit.title}</summary>
          <div className="mt-2 grid gap-2">
            <label className="grid gap-1 text-xs">
              작업 이름
              <input
                className={INPUT}
                maxLength={200}
                value={edit.title}
                onChange={(event) => update(edit.nodeId, { title: event.currentTarget.value })}
              />
            </label>
            <label className="grid gap-1 text-xs">
              작업 지시
              <textarea
                className={INPUT}
                rows={3}
                aria-label="작업 지시"
                maxLength={8000}
                value={edit.task}
                onChange={(event) => update(edit.nodeId, { task: event.currentTarget.value })}
              />
            </label>
            {run.meeting && (
              <label className="grid gap-1 text-xs">
                담당 AI
                <select
                  className={INPUT}
                  value={edit.participantId ?? ""}
                  onChange={(event) => {
                    if (
                      event.currentTarget.value === "" &&
                      graph.workflowAssignment?.pendingNodeIds.includes(edit.nodeId)
                    ) {
                      update(edit.nodeId, { participantId: null });
                      return;
                    }
                    const seat = run.meeting!.participants.find(
                      (candidate) => candidate.id === event.currentTarget.value,
                    );
                    if (seat) update(edit.nodeId, { participantId: seat.id });
                  }}
                >
                  {graph.workflowAssignment?.pendingNodeIds.includes(edit.nodeId) && (
                    <option value="">감독자 배정 대기</option>
                  )}
                  {run.meeting.participants.map((seat) => (
                    <option key={seat.id} value={seat.id}>
                      {seat.displayName} · {seat.modelSelection.model}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <fieldset className="space-y-1">
              <legend className="text-xs">먼저 끝나야 하는 작업</legend>
              {nodes
                .filter((node) => node.id !== edit.nodeId)
                .map((node) => {
                  const checked = edit.dependsOn.includes(node.id);
                  const createsCycle =
                    !checked && orchestraPlanDependencyWouldCycle(edits, edit.nodeId, node.id);
                  return (
                    <label key={node.id} className="flex items-center gap-2 text-xs">
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={createsCycle}
                        title={
                          createsCycle
                            ? "선택하면 작업이 서로 기다리는 순환 관계가 됩니다."
                            : undefined
                        }
                        onChange={(event) =>
                          update(edit.nodeId, {
                            dependsOn: event.currentTarget.checked
                              ? [...edit.dependsOn, node.id]
                              : edit.dependsOn.filter((id) => id !== node.id),
                          })
                        }
                      />
                      {node.title}
                      {createsCycle && <span className="text-muted-foreground">(순환 관계)</span>}
                    </label>
                  );
                })}
            </fieldset>
          </div>
        </details>
      ))}
      {cycleLabel && (
        <p role="alert" className="text-xs text-destructive">
          선행 작업이 순환합니다: {cycleLabel}. 선택된 선행 작업을 해제하세요.
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={busy || cycle !== null}
          onClick={() => void submit(false)}
        >
          계획만 저장
        </Button>
        <Button
          size="sm"
          disabled={
            busy || cycle !== null || edits.some((edit) => !edit.title.trim() || !edit.task.trim())
          }
          onClick={() => void submit(true)}
        >
          이 계획으로 시작
        </Button>
      </div>
    </fieldset>
  );
}

function DeliveryRetry({
  environmentId,
  run,
}: {
  environmentId: EnvironmentId;
  run: Run & Pick<WorkspaceCollaborationRun, "projectId">;
}) {
  const [commands, setCommands] = useState((run.orchestra?.verificationCommands ?? []).join("\n"));
  const [busy, setBusy] = useState(false);
  const verify = useAtomCommand(projectEnvironment.verifyWorkspaceCollaborationRun, {
    label: "오케스트라 결과 검증",
    reportFailure: false,
  });
  const runs = useEnvironmentQuery(
    orchestrationEnvironment.workspaceCollaborationRuns({
      environmentId,
      input: { projectId: run.projectId },
    }),
  );
  const submit = async () => {
    setBusy(true);
    try {
      const result = await verify({
        environmentId,
        input: {
          projectId: run.projectId,
          runId: run.id,
          verificationCommands: commands
            .split(/\r?\n/u)
            .map((command) => command.trim())
            .filter(Boolean),
        },
      });
      if (notifyCommandFailure(result, "검증 요청 실패")) return;
      runs.refresh();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-2">
      <label className="grid gap-1">
        검증 명령 · 한 줄에 하나
        <textarea
          className={INPUT}
          rows={2}
          aria-label="검증 명령 · 한 줄에 하나"
          maxLength={4000}
          value={commands}
          onChange={(event) => setCommands(event.currentTarget.value)}
        />
      </label>
      <Button size="sm" variant="outline" disabled={busy} onClick={() => void submit()}>
        통합 상태 확인 · 다시 검증
      </Button>
    </div>
  );
}
