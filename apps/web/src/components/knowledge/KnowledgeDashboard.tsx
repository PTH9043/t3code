import { useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { type ClientOrchestrationCommand } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { Button } from "~/components/ui/button";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { newCommandId, randomUUID } from "~/lib/utils";
import { dashboardQuery, dashboardCommand } from "./dashboardData";
import { number, type DashboardScope } from "./dashboardPresentation";
import { KnowledgeMetrics } from "./KnowledgeMetrics";
import { KnowledgeRows } from "./KnowledgeRows";
import { KnowledgeBulkActions } from "./KnowledgeBulkActions";
import { KnowledgeSearch } from "./KnowledgeSearch";
import {
  bulkTargets,
  toggleRows,
  pageLabels,
  type DashboardPage,
  type RowSelection,
  type SearchFilters,
} from "./dashboardSelection";

type Mutation = Extract<
  ClientOrchestrationCommand,
  {
    type:
      | "project.knowledge.bulk"
      | "project.knowledge.search.save"
      | "project.knowledge.search.remove";
  }
>;
type WithoutCommandFields<T> = T extends Mutation
  ? Omit<T, "commandId" | "createdAt" | "projectId">
  : never;
type Change = WithoutCommandFields<Mutation>;
const pageSize = 25;

export function KnowledgeDashboard({
  environmentId,
  projectId,
  projectTitle,
}: DashboardScope & { projectTitle: string }) {
  const scope = { environmentId, projectId };
  const [page, setPage] = useState<DashboardPage>("matching");
  const [offset, setOffset] = useState(0);
  const [filters, setFilters] = useState<SearchFilters>({});
  const [filterVersion, setFilterVersion] = useState(0);
  const [selected, setSelected] = useState<RowSelection>(new Map());
  const [groupBySource, setGroupBySource] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const pending = useRef(false);
  const previous = useRef<{ key: string; command: Mutation } | null>(null);
  const query = useEnvironmentQuery(
    dashboardQuery({
      environmentId,
      input: { projectId, offset, limit: pageSize, ...filters },
    }),
  );
  const data = query.data?.projectId === projectId ? query.data : null;
  const dispatch = useAtomCommand(dashboardCommand, { reportFailure: false });
  function clearSelection() {
    setSelected(new Map());
    setNotice("");
    setError(null);
  }
  function changePage(next: DashboardPage) {
    setPage(next);
    setOffset(0);
    setSelected(new Map());
    setError(null);
  }
  function search(next: SearchFilters) {
    setFilters(next);
    changePage("matching");
  }
  function openCluster(contentHash: string) {
    search({ contentHash });
    setFilterVersion((v) => v + 1);
  }
  async function submit(change: Change): Promise<boolean> {
    if (pending.current || !data || query.error) return false;
    const key = JSON.stringify(change);
    const command: Mutation =
      previous.current?.key === key
        ? previous.current.command
        : { ...change, projectId, commandId: newCommandId(), createdAt: new Date().toISOString() };
    previous.current = { key, command };
    pending.current = true;
    setBusy(true);
    setError(null);
    setNotice("");
    try {
      const result = await dispatch({ environmentId, input: command });
      if (result._tag === "Failure") {
        const failure = squashAtomCommandFailure(result);
        throw failure instanceof Error ? failure : new Error(String(failure));
      }
      previous.current = null;
      query.refresh();
      setNotice(
        change.type === "project.knowledge.bulk"
          ? `선택한 문서 ${change.items.length}개에 적용했습니다.`
          : "프로젝트의 저장 검색을 갱신했습니다.",
      );
      if (change.type === "project.knowledge.bulk") setSelected(new Map());
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "서버 응답을 확인하지 못했습니다.");
      return false;
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  // Preserve the creation id together with the command when a save needs a retry.
  function newSearchId(name: string, filters: SearchFilters) {
    const c = previous.current?.command;
    return c?.type === "project.knowledge.search.save" &&
      c.expectedUpdatedAt === null &&
      c.name === name &&
      JSON.stringify(c.filters) === JSON.stringify(filters)
      ? c.id
      : randomUUID();
  }
  const current = data?.[page];
  const rows = data && page !== "duplicates" ? data[page].items : [];
  const isInitialLoading = !data && !query.error;
  return (
    <main
      data-knowledge-hydrated={data ? "true" : "false"}
      data-loading={isInitialLoading ? "true" : "false"}
      className="min-h-0 flex-1 overflow-y-auto"
    >
      <div className="mx-auto grid w-full max-w-6xl gap-5 px-4 py-5 pb-10 sm:px-7">
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0">
            <nav
              aria-label="현재 위치"
              className="mb-1 flex flex-wrap gap-2 text-xs text-muted-foreground"
            >
              <Link to="/control-center" className="hover:underline">
                제어센터
              </Link>
              <span aria-hidden="true">/</span>
              <Link
                to="/control-center/$environmentId/$projectId"
                params={scope}
                hash="project-knowledge"
                className="break-words hover:underline"
              >
                {projectTitle}
              </Link>
            </nav>
            <h1 className="text-2xl font-semibold tracking-tight">지식 관리</h1>
          </div>
          <div className="flex items-center gap-2">
            {data && (
              <time className="text-xs text-muted-foreground" dateTime={data.measuredAt}>
                집계 {new Date(data.measuredAt).toLocaleString("ko-KR")}
              </time>
            )}
            <Button
              size="sm"
              variant="outline"
              disabled={busy || query.isPending}
              onClick={query.refresh}
            >
              새로고침
            </Button>
          </div>
        </header>
        {query.error && (
          <p role="alert" className="text-sm text-destructive">
            지식 통계를 불러오지 못했습니다. {query.error}
          </p>
        )}
        {isInitialLoading && (
          <div
            role="status"
            data-loading="true"
            className="grid gap-2.5 rounded-xl border border-border/70 bg-card/70 p-4"
          >
            <p className="text-xs font-medium text-muted-foreground">
              프로젝트 지식을 불러오는 중…
            </p>
            <div className="grid gap-2 sm:grid-cols-3">
              <div className="h-14 animate-pulse rounded-lg bg-muted/60" />
              <div className="h-14 animate-pulse rounded-lg bg-muted/60" />
              <div className="h-14 animate-pulse rounded-lg bg-muted/60" />
            </div>
            <div className="h-10 animate-pulse rounded-lg bg-muted/50" />
            <div className="h-10 animate-pulse rounded-lg bg-muted/40" />
          </div>
        )}
        {data && <KnowledgeMetrics data={data} />}
        <section aria-label="지식 문서 관리" className="grid gap-3">
          <div
            role="group"
            aria-label="문서 목록"
            className="flex flex-wrap items-center justify-between gap-2 border-b pb-2"
          >
            <div className="flex flex-wrap gap-1">
              {(Object.keys(pageLabels) as DashboardPage[]).map((key) => (
                <Button
                  key={key}
                  size="sm"
                  variant={page === key ? "secondary" : "ghost"}
                  aria-pressed={page === key}
                  disabled={busy}
                  onClick={() => {
                    if (page !== key) changePage(key);
                  }}
                >
                  {pageLabels[key]}{" "}
                  {data && <span className="tabular-nums">{number.format(data[key].total)}</span>}
                </Button>
              ))}
            </div>
            {page !== "duplicates" && (
              <Button
                size="xs"
                variant={groupBySource ? "secondary" : "outline"}
                aria-pressed={groupBySource}
                onClick={() => setGroupBySource((prev) => !prev)}
              >
                {groupBySource ? "동일 출처 묶기 켜짐" : "동일 출처 묶기 꺼짐"}
              </Button>
            )}
          </div>
          {page === "matching" && (
            <KnowledgeSearch
              key={filterVersion}
              filters={filters}
              apply={search}
              saved={data?.savedSearches ?? []}
              busy={busy || !data || !!query.error}
              onSave={(name, f, old) =>
                submit({
                  type: "project.knowledge.search.save",
                  id: old?.id ?? newSearchId(name, f),
                  name,
                  filters: f,
                  expectedUpdatedAt: old?.updatedAt ?? null,
                })
              }
              onRemove={(old) =>
                submit({
                  type: "project.knowledge.search.remove",
                  id: old.id,
                  expectedUpdatedAt: old.updatedAt,
                })
              }
            />
          )}
          {page !== "duplicates" && (
            <KnowledgeBulkActions
              selected={selected}
              busy={busy}
              canApply={!!data && !query.error}
              error={error}
              apply={(operation) =>
                submit({
                  type: "project.knowledge.bulk",
                  items: bulkTargets(selected),
                  operation,
                })
              }
              clear={clearSelection}
            />
          )}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          {notice && (
            <p role="status" className="text-sm">
              {notice}
            </p>
          )}
          {page === "duplicates" ? (
            <ul className="divide-y">
              {data?.duplicates.items.map((cluster) => (
                <li
                  key={cluster.contentHash}
                  className="flex flex-wrap items-center gap-3 py-2 text-sm"
                >
                  <code className="min-w-0 flex-1 break-all text-xs">{cluster.contentHash}</code>
                  <span>같은 본문 {number.format(cluster.count)}개</span>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => openCluster(cluster.contentHash)}
                  >
                    문서 보기
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <KnowledgeRows
              scope={scope}
              rows={rows}
              selected={selected}
              groupBySource={groupBySource}
              onToggle={(items, include) => {
                if (!pending.current) {
                  setSelected((old) => toggleRows(old, items, include));
                  setError(null);
                  setNotice("");
                }
              }}
            />
          )}
          {current && !current.items.length && (
            <p className="p-3 text-sm text-muted-foreground">
              {current.total === 0
                ? "해당하는 항목이 없습니다."
                : "이 페이지에 남은 항목이 없습니다."}
            </p>
          )}
          {current && (
            <nav aria-label="목록 페이지" className="flex items-center justify-end gap-2">
              <span className="text-xs tabular-nums text-muted-foreground">
                {current.items.length
                  ? `${number.format(offset + 1)}–${number.format(offset + current.items.length)} / `
                  : ""}
                {number.format(current.total)}
                {page === "duplicates" ? "묶음" : "개"}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={busy || offset === 0}
                onClick={() => setOffset((n) => Math.max(0, n - pageSize))}
              >
                이전
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={
                  busy || offset + current.items.length >= current.total || !current.items.length
                }
                onClick={() => setOffset((n) => n + pageSize)}
              >
                다음
              </Button>
            </nav>
          )}
        </section>
      </div>
    </main>
  );
}
