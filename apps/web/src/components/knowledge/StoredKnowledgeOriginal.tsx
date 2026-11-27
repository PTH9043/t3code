import type { EnvironmentId, ProjectId, WorkspaceKnowledgeItemId } from "@t3tools/contracts";
import { useState } from "react";
import { orchestrationEnvironment } from "~/state/orchestration";
import { useEnvironmentQuery } from "~/state/query";

type DocumentRef = {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  itemId: WorkspaceKnowledgeItemId;
};

export function KnowledgeExcerpt(props: DocumentRef) {
  const [open, setOpen] = useState(false);
  return (
    <details
      className="mt-1 text-xs text-muted-foreground"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="cursor-pointer">본문 미리보기</summary>
      {open && <StoredKnowledgeOriginal {...props} excerpt />}
    </details>
  );
}

export function StoredKnowledgeOriginal({
  environmentId,
  projectId,
  itemId,
  excerpt,
}: DocumentRef & { excerpt?: boolean }) {
  const result = useEnvironmentQuery(
    orchestrationEnvironment.workspaceKnowledge({
      environmentId,
      input: { projectId, itemId, includeShared: false },
    }),
  );
  const original = result.data?.items.find(
    (item) => item.id === itemId && item.projectId === projectId,
  );
  if (result.error) return <p role="alert">{result.error}</p>;
  if (!original)
    return (
      <p role="status">{result.data ? "저장 원문을 찾을 수 없습니다." : "원문을 불러오는 중…"}</p>
    );
  return excerpt ? (
    <p className="mt-1 line-clamp-3 whitespace-pre-wrap break-words">{original.content}</p>
  ) : (
    <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words font-sans">
      {original.content}
    </pre>
  );
}
