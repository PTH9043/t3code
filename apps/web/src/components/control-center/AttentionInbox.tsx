import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import {
  attentionKindLabels,
  threadAttentionItems,
  type AttentionKind,
} from "@t3tools/client-runtime/state/presentation";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { useThreadShells, useProjects } from "~/state/entities";
import { useEnvironments } from "~/state/environments";
import { orchestrationEnvironment } from "~/state/orchestration";
import { useEnvironmentQuery } from "~/state/query";
import { Card, CardHeader, CardTitle, CardDescription, CardPanel } from "../ui/card";
import { Button } from "../ui/button";

export function AttentionInbox({ project }: { project?: EnvironmentProject }) {
  const threads = useThreadShells();
  const projects = useProjects();
  const { environments } = useEnvironments();
  const navigate = useNavigate();
  const [filter, setFilter] = useState<AttentionKind | "all">("all");
  const [expanded, setExpanded] = useState(false);
  const allItems = threadAttentionItems(
    threads.filter(
      (thread) =>
        !project ||
        (thread.environmentId === project.environmentId && thread.projectId === project.id),
    ),
  );
  const countByKind = allItems.reduce<Partial<Record<AttentionKind, number>>>((acc, item) => {
    acc[item.kind] = (acc[item.kind] ?? 0) + 1;
    return acc;
  }, {});
  const items = allItems.filter((item) => filter === "all" || item.kind === filter);
  const visible = expanded ? items : items.slice(0, 12);
  return (
    <Card id="attention-inbox" data-attention-inbox>
      <CardHeader>
        <CardTitle>확인함</CardTitle>
        <CardDescription>
          질문·권한 승인·실행 계획·오류와 제한 대기를 모았습니다. 항목을 열면 해당 작업의 최신
          요청에서 답변할 수 있습니다.
        </CardDescription>
      </CardHeader>
      <CardPanel className="space-y-3">
        <div className="flex flex-wrap gap-2">
          <Button
            size="xs"
            variant={filter === "all" ? "default" : "outline"}
            onClick={() => setFilter("all")}
          >
            전체
            <span className="ml-1 font-mono text-[10px] opacity-80">{allItems.length}</span>
          </Button>
          {(Object.keys(attentionKindLabels) as AttentionKind[]).map((kind) => {
            const count = countByKind[kind] ?? 0;
            return (
              <Button
                key={kind}
                size="xs"
                variant={filter === kind ? "default" : "outline"}
                onClick={() => setFilter(kind)}
              >
                {attentionKindLabels[kind]}
                <span className="ml-1 font-mono text-[10px] opacity-80">{count}</span>
              </Button>
            );
          })}
        </div>
        {visible.map(({ id, kind, thread }) => (
          <button
            key={id}
            type="button"
            className="block w-full rounded-lg border border-border p-3 text-left hover:bg-muted"
            onClick={() =>
              void navigate({
                to: "/$environmentId/$threadId",
                params: { environmentId: thread.environmentId, threadId: thread.id },
              })
            }
          >
            <span className="text-xs font-semibold text-primary">{attentionKindLabels[kind]}</span>
            <p className="truncate text-sm">{thread.title}</p>
            <p className="truncate text-xs text-muted-foreground">
              {projects.find(
                (p) => p.environmentId === thread.environmentId && p.id === thread.projectId,
              )?.title ?? "프로젝트"}{" "}
              ·{" "}
              {environments.find((e) => e.environmentId === thread.environmentId)?.label ?? "환경"}
            </p>
          </button>
        ))}
        {items.length > 12 && (
          <Button size="xs" variant="outline" onClick={() => setExpanded(!expanded)}>
            {expanded ? "접기" : "대화 요청 모두 보기 (" + items.length + ")"}
          </Button>
        )}
        {!items.length && (
          <p className="text-xs text-muted-foreground">
            현재 필터에 해당하는 대화 요청이 없습니다.
          </p>
        )}
        {(project
          ? [{ environmentId: project.environmentId, label: "현재 프로젝트" }]
          : environments
        ).map((environment) => (
          <RunAttention
            key={environment.environmentId}
            environmentId={environment.environmentId}
            label={environment.label}
            {...(project ? { projectId: project.id } : {})}
            filter={filter}
          />
        ))}
      </CardPanel>
    </Card>
  );
}
function RunAttention({
  environmentId,
  label,
  projectId,
  filter,
}: {
  environmentId: EnvironmentId;
  label: string;
  projectId?: ProjectId;
  filter: AttentionKind | "all";
}) {
  const result = useEnvironmentQuery(
    orchestrationEnvironment.workspaceAttention({
      environmentId,
      input: projectId ? { projectId } : {},
    }),
  );
  const [expanded, setExpanded] = useState(false);
  const navigate = useNavigate();
  const items = result.data?.items.filter((item) => filter === "all" || item.kind === filter) ?? [];
  return (
    <div className="space-y-2">
      {result.error && (
        <p role="alert" className="text-xs text-destructive">
          {label}: {result.error}
          <Button size="xs" variant="ghost" onClick={result.refresh}>
            다시 조회
          </Button>
        </p>
      )}
      {(expanded ? items : items.slice(0, 12)).map((item) => (
        <button
          type="button"
          key={item.id}
          className="block w-full rounded-lg border border-border p-3 text-left hover:bg-muted"
          onClick={() =>
            void navigate({
              to: "/control-center/$environmentId/$projectId",
              params: { environmentId, projectId: item.projectId },
              search: { domain: "execution", section: "project-runs" },
            })
          }
        >
          <p className="text-xs font-semibold text-primary">
            {item.title} · {label}
          </p>
          <p className="mt-1 line-clamp-2 whitespace-pre-wrap break-words text-xs">{item.detail}</p>
        </button>
      ))}
      {items.length > 12 && (
        <Button size="xs" variant="outline" onClick={() => setExpanded(!expanded)}>
          {expanded ? "접기" : "실행 요청 모두 보기 (" + items.length + ")"}
        </Button>
      )}
      {result.data && result.data.total > result.data.items.length && (
        <p className="text-xs text-muted-foreground">
          최근 {result.data.items.length}개 표시 · 전체 {result.data.total}개. 프로젝트별 확인함에서
          나머지를 확인하세요.
        </p>
      )}
    </div>
  );
}
