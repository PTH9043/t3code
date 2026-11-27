import { useState } from "react";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { WorkspaceCollaborationRunId, WorkspaceKnowledgeItemId } from "@t3tools/contracts";
import { orchestrationEnvironment } from "~/state/orchestration";
import { useEnvironmentQuery } from "~/state/query";
import { KnowledgeDocLink } from "./KnowledgeDocLink";

export function RunKnowledgeDocuments({
  project,
  runId,
  omitItemId,
}: {
  project: EnvironmentProject;
  runId: WorkspaceCollaborationRunId;
  omitItemId?: WorkspaceKnowledgeItemId;
}) {
  const [open, setOpen] = useState(false);
  const result = useEnvironmentQuery(
    open
      ? orchestrationEnvironment.workspaceKnowledge({
          environmentId: project.environmentId,
          input: {
            projectId: project.id,
            sourceRunId: runId,
            includeShared: false,
            summariesOnly: true,
          },
        })
      : null,
  );
  const items =
    result.data?.items.filter(
      (item) =>
        item.projectId === project.id && item.provenance?.runId === runId && item.id !== omitItemId,
    ) ?? [];
  return (
    <details onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="cursor-pointer text-sm font-medium">이 실행에 연결된 지식 문서</summary>
      {open && (
        <div className="mt-2 grid gap-1 text-sm">
          {result.error ? (
            <p role="alert">{result.error}</p>
          ) : !result.data ? (
            <p role="status">불러오는 중…</p>
          ) : items.length ? (
            items.map((item) => (
              <KnowledgeDocLink
                key={item.id}
                environmentId={project.environmentId}
                projectId={project.id}
                itemId={item.id}
              >
                {item.title}
              </KnowledgeDocLink>
            ))
          ) : (
            <p>연결된 문서가 없습니다.</p>
          )}
        </div>
      )}
    </details>
  );
}
