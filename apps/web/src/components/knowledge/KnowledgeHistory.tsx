import { useState } from "react";
import { MultiFileDiff } from "@pierre/diffs/react";
import type { EnvironmentId, ProjectId, WorkspaceKnowledgeItemId } from "@t3tools/contracts";
import { useEnvironmentQuery } from "~/state/query";
import { wikiRevision, wikiRevisions } from "./knowledgeApi";

type RevisionScope = {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  itemId: WorkspaceKnowledgeItemId;
};
type Revision = { sequence: number; occurredAt: string; eventType: string };
const label = (row: Revision) =>
  "#" +
  row.sequence +
  " · " +
  new Date(row.occurredAt).toLocaleString("ko-KR") +
  (row.eventType.endsWith("archived") ? " · 보관" : " · 저장");

function useSnapshot({ environmentId, projectId, itemId }: RevisionScope, sequence: number | null) {
  return useEnvironmentQuery(
    sequence ? wikiRevision({ environmentId, input: { projectId, itemId, sequence } }) : null,
  );
}

export function KnowledgeHistory(scope: RevisionScope) {
  const [before, setBefore] = useState<number | null>(null);
  const [previous, setPrevious] = useState<ReadonlyArray<Revision>>([]);
  const [base, setBase] = useState<number>();
  const [target, setTarget] = useState<number>();
  const page = useEnvironmentQuery(
    wikiRevisions({
      environmentId: scope.environmentId,
      input: {
        projectId: scope.projectId,
        itemId: scope.itemId,
        ...(before ? { beforeSequence: before } : {}),
      },
    }),
  );
  const revisions = [...previous, ...(page.data?.revisions ?? [])];
  const targetSequence = target ?? revisions[0]?.sequence ?? null;
  const baseSequence = base ?? revisions[1]?.sequence ?? null;
  const old = useSnapshot(scope, baseSequence);
  const current = useSnapshot(scope, targetSequence);
  const error = page.error ?? old.error ?? current.error;
  const first = old.data?.revision;
  const second = current.data?.revision;
  return (
    <section className="grid min-w-0 gap-4" aria-label="문서 기록">
      <h2 className="text-lg font-semibold">문서 기록</h2>
      {error && <p role="alert">{error}</p>}
      {!page.data && !error && <p role="status">기록을 불러오는 중…</p>}
      {page.data && !revisions.length && <p>저장된 버전 기록이 없습니다.</p>}
      {!!revisions.length && (
        <>
          <div className="flex flex-wrap gap-4">
            {(["비교 기준", "볼 버전"] as const).map((text, i) => (
              <label key={text} className="grid gap-1 text-sm">
                {text}
                <select
                  className="rounded border bg-background p-2"
                  value={(i ? targetSequence : baseSequence) ?? ""}
                  onChange={(event) => (i ? setTarget : setBase)(Number(event.target.value))}
                >
                  {!baseSequence && !i && <option value="">이전 버전 없음</option>}
                  {revisions.map((row) => (
                    <option key={row.sequence} value={row.sequence}>
                      {label(row)}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
          {page.data?.nextBeforeSequence && (
            <button
              className="w-fit text-primary underline"
              onClick={() => {
                setPrevious(revisions);
                setBefore(page.data!.nextBeforeSequence);
              }}
            >
              이전 기록 더 보기
            </button>
          )}
          {second ? (
            <>
              <h3 className="font-semibold">{second.title ?? "보관 기록"}</h3>
              {second.content !== null &&
              first?.content != null &&
              first.sequence !== second.sequence ? (
                <>
                  {first.title !== second.title && (
                    <p className="text-sm">
                      제목 변경 · <del>{first.title}</del> → <ins>{second.title}</ins>
                    </p>
                  )}
                  {first.content === second.content ? (
                    <p>본문 변경 없음</p>
                  ) : (
                    <div className="min-w-0 overflow-auto">
                      <MultiFileDiff
                        oldFile={{ name: "document.md", contents: first.content }}
                        newFile={{ name: "document.md", contents: second.content }}
                        options={{ diffStyle: "unified" }}
                      />
                    </div>
                  )}
                </>
              ) : second.content !== null ? (
                <pre className="whitespace-pre-wrap break-words">{second.content}</pre>
              ) : (
                <p>
                  이 기록은 문서가 보관된 시점을 표시합니다. 본문은 저장 버전에서 볼 수 있습니다.
                </p>
              )}
              {first && first.content === null && (
                <p className="text-sm">비교 기준으로 선택한 보관 기록에는 본문이 없습니다.</p>
              )}
            </>
          ) : (
            current.data && <p>선택한 버전의 본문을 찾을 수 없습니다.</p>
          )}
        </>
      )}
    </section>
  );
}
