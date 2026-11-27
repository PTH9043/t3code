import { useEffect, useState } from "react";
import { Link, Navigate, useNavigate } from "@tanstack/react-router";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  isProtectedWorkspaceKnowledgeItem,
  type WorkspaceKnowledgeItem,
  type WorkspaceKnowledgeItemId,
  type WorkspaceWikiLinksResult,
} from "@t3tools/contracts";
import { orchestrationEnvironment } from "~/state/orchestration";
import { useEnvironmentQuery } from "~/state/query";
import { KnowledgeDocLink, knowledgeDocRoute } from "./KnowledgeDocLink";
import { KnowledgeEditor } from "./KnowledgeEditor";
import { wikiIndexMatches } from "./knowledgeDocument.logic";
import { KnowledgeHistory } from "./KnowledgeHistory";
import { KnowledgeReader } from "./KnowledgeReader";
import { PdfRevisionPanel, pdfKnowledgeAttachment } from "./PdfRevisionPanel";
import { wikiLinks, wikiRevision, wikiRevisions } from "./knowledgeApi";

function DocumentEditSession({
  project,
  item,
  links,
  onSaved,
  refreshDocument,
}: {
  project: EnvironmentProject;
  item: WorkspaceKnowledgeItem;
  links: WorkspaceWikiLinksResult;
  onSaved: (id: WorkspaceKnowledgeItemId) => void;
  refreshDocument: () => void;
}) {
  const input = { projectId: project.id, itemId: item.id };
  const head = useEnvironmentQuery(
    wikiRevisions({ environmentId: project.environmentId, input: { ...input, limit: 1 } }),
  );
  const sequence = head.data?.revisions[0]?.sequence ?? 0;
  const snapshot = useEnvironmentQuery(
    sequence
      ? wikiRevision({ environmentId: project.environmentId, input: { ...input, sequence } })
      : null,
  );
  const [ready, setReady] = useState(false);
  const synchronized =
    head.data &&
    wikiIndexMatches(item.content, links.outgoing) &&
    (!sequence ||
      (snapshot.data?.revision?.content === item.content &&
        snapshot.data.revision.title === item.title));
  useEffect(() => {
    if (synchronized) setReady(true);
  }, [synchronized]);
  if (!ready)
    return (
      <div role="status">
        {head.error ??
          snapshot.error ??
          (snapshot.data && !synchronized
            ? "버전과 본문이 변경됐습니다. 최신 내용을 다시 불러오세요."
            : "편집할 버전을 불러오는 중…")}
        {(head.error || snapshot.error || (snapshot.data && !synchronized)) && (
          <button
            type="button"
            className="ml-2 text-primary underline"
            onClick={() => {
              refreshDocument();
              head.refresh();
              if (sequence) snapshot.refresh();
            }}
          >
            다시 불러오기
          </button>
        )}
      </div>
    );
  return (
    <KnowledgeEditor
      project={project}
      item={item}
      links={links}
      sequence={sequence}
      onSaved={onSaved}
    />
  );
}

export function KnowledgeDocumentPage({
  project,
  itemId,
  view,
}: {
  project: EnvironmentProject;
  itemId: WorkspaceKnowledgeItemId;
  view: "read" | "edit" | "history";
}) {
  const navigate = useNavigate();
  const ref = { environmentId: project.environmentId, projectId: project.id };
  const result = useEnvironmentQuery(
    orchestrationEnvironment.workspaceKnowledge({
      environmentId: project.environmentId,
      input: { projectId: project.id, itemId, includeShared: false },
    }),
  );
  const item = result.data?.items.find((row) => row.projectId === project.id && row.id === itemId);
  const graph = useEnvironmentQuery(
    item && view !== "history"
      ? wikiLinks({
          environmentId: project.environmentId,
          input: { projectId: project.id, itemId },
        })
      : null,
  );
  const pdfAttachment = item && pdfKnowledgeAttachment(item);
  const protectedItem = !!item && isProtectedWorkspaceKnowledgeItem(item);
  const forks = useEnvironmentQuery(
    protectedItem && view !== "history"
      ? orchestrationEnvironment.workspaceKnowledge({
          environmentId: project.environmentId,
          input: {
            projectId: project.id,
            sourceItemId: itemId,
            includeShared: false,
            summariesOnly: true,
          },
        })
      : null,
  );
  const fork = forks.data?.items.find(
    (row) => row.projectId === project.id && row.sourceItemId === itemId,
  );
  const saved = (id: WorkspaceKnowledgeItemId) => {
    result.refresh();
    graph.refresh();
    if (protectedItem) forks.refresh();
    void navigate({
      to: knowledgeDocRoute,
      params: { ...ref, itemId: id },
      search: {},
      replace: true,
    });
  };
  if (view === "edit" && fork)
    return (
      <Navigate
        to={knowledgeDocRoute}
        params={{ ...ref, itemId: fork.id }}
        search={fork.status !== "archived" ? { view: "edit" } : {}}
        replace
      />
    );
  return (
    <main className="min-h-0 min-w-0 flex-1 overflow-auto overscroll-contain">
      <div className="mx-auto grid w-full max-w-screen-2xl gap-6 px-4 py-5 sm:px-8">
        <nav aria-label="문서 경로" className="flex flex-wrap gap-2 text-sm text-muted-foreground">
          <Link to="/control-center">AI 제어센터</Link>
          <span aria-hidden>/</span>
          <Link
            to="/control-center/$environmentId/$projectId"
            params={ref}
            hash="project-knowledge"
          >
            {project.title} · 프로젝트 지식
          </Link>
          {item && (
            <>
              <span aria-hidden>/</span>
              <span className="break-all" aria-current="page">
                {item.title}
              </span>
            </>
          )}
        </nav>
        {result.error ? (
          <p role="alert">{result.error}</p>
        ) : !result.data ? (
          <p role="status">문서를 불러오는 중…</p>
        ) : !item ? (
          <p role="status">이 프로젝트에서 문서를 찾을 수 없습니다.</p>
        ) : (
          <>
            <header className="grid gap-3 border-b pb-4">
              <h1 className="break-words text-2xl font-semibold">{item.title}</h1>
              <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
                <span>
                  {item.status === "archived" ? "보관됨 · " : ""}수정{" "}
                  {new Date(item.updatedAt).toLocaleString("ko-KR")}
                </span>
                <span aria-hidden>·</span>
                <span className="tabular-nums">
                  RAG 사용 {item.promptUses.toLocaleString("ko-KR")}회
                </span>
                {item.lastUsedAt && (
                  <>
                    <span aria-hidden>·</span>
                    <span>최근 사용 {new Date(item.lastUsedAt).toLocaleString("ko-KR")}</span>
                  </>
                )}
              </p>
              <nav aria-label="문서 보기" className="flex flex-wrap gap-4 text-sm">
                <KnowledgeDocLink {...ref} itemId={itemId}>
                  읽기
                </KnowledgeDocLink>
                {item.status !== "archived" && (
                  <KnowledgeDocLink {...ref} itemId={fork?.id ?? itemId} view="edit">
                    편집
                  </KnowledgeDocLink>
                )}
                <KnowledgeDocLink {...ref} itemId={itemId} view="history">
                  기록 · 비교
                </KnowledgeDocLink>
              </nav>
            </header>
            {view === "read" && pdfAttachment && (
              <PdfRevisionPanel
                key={JSON.stringify([ref.environmentId, ref.projectId, itemId])}
                {...ref}
                itemId={itemId}
                name={pdfAttachment.name}
                excerptHash={pdfAttachment.contentHash}
                onPublished={() => {
                  result.refresh();
                  graph.refresh();
                }}
              />
            )}
            {(graph.error || forks.error) && <p role="alert">{graph.error ?? forks.error}</p>}
            {view === "history" ? (
              <KnowledgeHistory {...ref} itemId={itemId} />
            ) : view === "read" ? (
              <KnowledgeReader project={project} item={item} links={graph.data} fork={fork} />
            ) : item.status === "archived" ? (
              <p>보관된 문서입니다. 프로젝트 지식 목록에서 복원한 뒤 편집할 수 있습니다.</p>
            ) : graph.data && (!protectedItem || forks.data) ? (
              <DocumentEditSession
                project={project}
                item={item}
                links={graph.data}
                onSaved={saved}
                refreshDocument={() => {
                  result.refresh();
                  graph.refresh();
                }}
              />
            ) : (
              !graph.error && !forks.error && <p role="status">문서 연결 정보를 불러오는 중…</p>
            )}
          </>
        )}
      </div>
    </main>
  );
}
