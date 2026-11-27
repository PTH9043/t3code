import { useState } from "react";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { WorkspaceKnowledgeItemId } from "@t3tools/contracts";
import { useEnvironmentQuery } from "~/state/query";
import { dashboardQuery } from "./dashboardData";

export function WikiLinkPicker({
  project,
  query,
  onPick,
}: {
  project: EnvironmentProject;
  query: string;
  onPick: (item: { id: WorkspaceKnowledgeItemId; title: string }) => void;
}) {
  const [offset, setOffset] = useState(0);
  const result = useEnvironmentQuery(
    dashboardQuery({
      environmentId: project.environmentId,
      input: {
        projectId: project.id,
        query,
        offset,
      },
    }),
  );
  const page = result.data?.matching;
  return (
    <section aria-label="연결할 문서 선택" className="grid gap-2 rounded-lg border p-3 text-sm">
      <h3 className="font-semibold">연결할 문서 선택</h3>
      <p className="text-xs text-muted-foreground">제목이 같으면 문서 ID를 확인해 선택하세요.</p>
      {result.error ? (
        <p role="alert">{result.error}</p>
      ) : !page ? (
        <p role="status">찾는 중…</p>
      ) : page.items.length === 0 ? (
        <p>일치하는 문서가 없습니다.</p>
      ) : (
        <>
          <ul className="grid max-h-56 gap-1 overflow-auto">
            {page.items
              .filter((item) => item.status !== "archived")
              .map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    className="w-full rounded px-2 py-1 text-left hover:bg-muted focus-visible:bg-muted"
                    onClick={() => onPick(item)}
                  >
                    {item.title}{" "}
                    <code className="break-all text-xs text-muted-foreground">{item.id}</code>
                  </button>
                </li>
              ))}
          </ul>
          <div className="flex gap-3">
            {offset > 0 && (
              <button type="button" onClick={() => setOffset(0)}>
                처음
              </button>
            )}
            {offset + page.items.length < page.total && (
              <button type="button" onClick={() => setOffset(offset + page.items.length)}>
                다음 결과
              </button>
            )}
          </div>
        </>
      )}
    </section>
  );
}
