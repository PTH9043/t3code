import { useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  TASK_GROUPS,
  classifyDashboardTask,
  taskGroupLabels,
  type TaskGroup,
} from "@t3tools/client-runtime/state/task-dashboard";
import { useListedThreadShells, useProjects } from "~/state/entities";
import { Card, CardHeader, CardTitle, CardDescription, CardPanel } from "../ui/card";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";

export function TaskDashboard() {
  const threads = useListedThreadShells();
  const projects = useProjects();
  const navigate = useNavigate();
  const [filter, setFilter] = useState<TaskGroup | "all">("all");
  const groups = useMemo(() => {
    const now = new Date().toISOString();
    return TASK_GROUPS.map((id) => ({
      id,
      threads: threads
        .filter((thread) => !thread.archivedAt && classifyDashboardTask(thread, now) === id)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    }));
  }, [threads]);
  return (
    <Card id="task-dashboard">
      <CardHeader>
        <CardTitle>작업 대시보드</CardTitle>
        <CardDescription>
          현재 연결된 환경의 실제 세션·승인·작업 상태입니다. 완료 표시는 AI 응답 완료를 뜻하며, 검증
          결과는 각 작업에서 확인하세요.
        </CardDescription>
      </CardHeader>
      <CardPanel>
        <div className="mb-4 flex flex-wrap gap-2">
          <Button
            size="sm"
            variant={filter === "all" ? "default" : "outline"}
            onClick={() => setFilter("all")}
          >
            전체
          </Button>
          {groups.map((group) => (
            <Button
              key={group.id}
              size="sm"
              variant={filter === group.id ? "default" : "outline"}
              onClick={() => setFilter(group.id)}
            >
              {taskGroupLabels[group.id]}{" "}
              <Badge size="sm" variant="outline">
                {group.threads.length}
              </Badge>
            </Button>
          ))}
        </div>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {groups
            .filter((group) => (filter === "all" ? group.threads.length > 0 : filter === group.id))
            .map((group) => (
              <section
                key={group.id}
                className="rounded-xl border border-border bg-background/40 p-3"
              >
                <h3 className="mb-2 text-xs font-semibold">
                  {taskGroupLabels[group.id]} · {group.threads.length}
                </h3>
                <div
                  className={
                    filter === "all" ? "grid gap-2" : "grid max-h-96 gap-2 overflow-y-auto"
                  }
                >
                  {group.threads.slice(0, filter === "all" ? 5 : 100).map((thread) => (
                    <button
                      type="button"
                      key={`${thread.environmentId}:${thread.id}`}
                      className="rounded-lg border border-border bg-card p-3 text-left hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
                      onClick={() =>
                        void navigate({
                          to: "/$environmentId/$threadId",
                          params: { environmentId: thread.environmentId, threadId: thread.id },
                        })
                      }
                    >
                      <p className="truncate text-sm font-medium">{thread.title}</p>
                      <p className="mt-1 truncate text-[11px] text-muted-foreground">
                        {projects.find(
                          (project) =>
                            project.environmentId === thread.environmentId &&
                            project.id === thread.projectId,
                        )?.title ?? "프로젝트"}{" "}
                        · {thread.modelSelection.instanceId}
                      </p>
                      {thread.planProgress ? (
                        <p className="mt-2 text-xs text-primary">
                          {thread.planProgress.completedSteps}/{thread.planProgress.totalSteps} ·{" "}
                          {thread.planProgress.step}
                        </p>
                      ) : null}
                      {thread.backgroundLiveness ? (
                        <p className="mt-1 text-[11px] text-muted-foreground">
                          {thread.backgroundLiveness === "working"
                            ? "백그라운드 작업 실행 중"
                            : "감시 작업 실행 중"}
                        </p>
                      ) : null}
                    </button>
                  ))}
                </div>
                {filter === "all" && group.threads.length > 5 ? (
                  <Button
                    className="mt-2"
                    size="sm"
                    variant="ghost"
                    onClick={() => setFilter(group.id)}
                  >
                    모두 보기
                  </Button>
                ) : null}
                {!group.threads.length ? (
                  <p className="text-xs text-muted-foreground">해당 상태의 작업이 없습니다.</p>
                ) : null}
              </section>
            ))}
        </div>
        {!threads.length ? (
          <p className="text-sm text-muted-foreground">
            연결된 프로젝트의 작업이 여기에 표시됩니다.
          </p>
        ) : null}
      </CardPanel>
    </Card>
  );
}
