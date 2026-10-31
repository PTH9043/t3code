import { useMemo } from "react";
import type { WorkspaceCollaborationRun, WorkspaceTaskNode } from "@t3tools/contracts";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { Button } from "../ui/button";
import { formatTimestamp } from "./controlCenterShared";
import type { WorktreeDiffTarget } from "./WorktreeDiffDialog";

export function WorktreeOperationsBoard(props: {
  project: EnvironmentProject;
  runs: ReadonlyArray<WorkspaceCollaborationRun>;
  onDiff: (target: WorktreeDiffTarget) => void;
}) {
  const rows = useMemo(() => {
    const selected: Array<{ run: WorkspaceCollaborationRun; node: WorkspaceTaskNode }> = [];
    for (const run of props.runs) {
      for (const node of run.graph?.nodes ?? []) {
        if (node.worktreePath === null) continue;
        selected.push({ run, node });
        if (selected.length === 30) return selected;
      }
    }
    return selected;
  }, [props.runs]);
  if (rows.length === 0) return null;
  return (
    <div className="overflow-x-auto rounded-xl border border-border p-3">
      <table className="w-full text-left text-xs">
        <caption className="mb-3 text-left text-sm font-semibold">
          Worktree 작업 현황 · 최근 실행의 노드 최대 30개
        </caption>
        <thead>
          <tr>
            <th>작업 / 브랜치</th>
            <th>실행</th>
            <th>검증</th>
            <th>최근 실제 활동</th>
            <th>변경 검토</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ run, node }) => {
            const validation =
              node.validation ??
              run.graph?.nodes.find((candidate) => candidate.validation?.targetNodeId === node.id)
                ?.validation;
            return (
              <tr key={`${run.id}:${node.id}`} className="border-t border-border">
                <td className="max-w-80 break-all p-2">
                  <span className="block font-medium">{node.title}</span>
                  <span className="font-mono text-muted-foreground">
                    {node.branch ?? node.worktreePath}
                  </span>
                </td>
                <td className="p-2">
                  {node.status}
                  <span className="block text-muted-foreground">{run.id}</span>
                </td>
                <td className="p-2">
                  {validation
                    ? `${validation.verdict} · ${validation.confidence}`
                    : "검증 근거 대기"}
                </td>
                <td className="p-2">
                  {formatTimestamp(
                    node.completedAt ??
                      node.attempts.at(-1)?.completedAt ??
                      node.attempts.at(-1)?.startedAt ??
                      node.startedAt,
                  )}
                </td>
                <td className="p-2">
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() =>
                      props.onDiff({
                        environmentId: props.project.environmentId,
                        worktreePath: node.worktreePath!,
                        branch: node.branch,
                        nodeTitle: node.title,
                      })
                    }
                  >
                    Diff 확인
                  </Button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="mt-2 text-xs text-muted-foreground">
        실행 완료와 변경 통합은 별개입니다. Diff를 확인한 뒤 기존 소스 제어 화면에서 통합하세요.
      </p>
    </div>
  );
}
