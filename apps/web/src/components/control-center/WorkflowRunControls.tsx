import { useRef, useState } from "react";
import type { EnvironmentId, WorkspaceCollaborationRun } from "@t3tools/contracts";
import { workspaceRunControl } from "@t3tools/shared/workflow";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { orchestrationEnvironment } from "~/state/orchestration";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";

export function WorkflowRunControls({
  environmentId,
  run,
  onRefresh,
}: {
  environmentId: EnvironmentId;
  run: WorkspaceCollaborationRun;
  onRefresh: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const control = useAtomCommand(orchestrationEnvironment.controlWorkflow, {
    reportFailure: false,
  });
  const runControl = workspaceRunControl(run);

  const change = async (action: "pause" | "resume" | "retry", nodeId?: string) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await control({
        environmentId,
        input: {
          projectId: run.projectId,
          runId: run.id,
          expectedRevision: runControl.controlRevision,
          action,
          ...(nodeId ? { nodeId } : {}),
        },
      });
      if (result._tag !== "Success") setError(String(squashAtomCommandFailure(result)));
      onRefresh();
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-2 rounded-lg border border-border bg-background p-3 text-xs">
      <p>
        {run.workflow ? `${run.workflow.title} · v${run.workflow.definitionRevision}` : "AI 작업"} ·{" "}
        {runControl.control === "paused"
          ? "일시정지"
          : runControl.control === "pause-requested"
            ? "진행 단계 정리 중"
            : "실행 제어 활성"}
      </p>
      <div className="flex flex-wrap gap-2">
        {["queued", "running"].includes(run.status) ? (
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={busy}
            onClick={() => void change(runControl.control === "active" ? "pause" : "resume")}
          >
            {runControl.control === "active" ? "일시정지" : "재개"}
          </Button>
        ) : null}
        {run.status === "failed"
          ? run.graph?.nodes
              .filter((node) => node.status === "failed" && node.attempts.length > 0)
              .map((node) => (
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  key={node.id}
                  disabled={busy}
                  onClick={() => void change("retry", node.id)}
                >
                  {node.title} 재시도
                </Button>
              ))
          : null}
      </div>
      {error ? (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
