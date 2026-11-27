import type { EnvironmentId } from "@t3tools/contracts";
import { useMemo, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  BotIcon,
  BrainCircuitIcon,
  DatabaseIcon,
  FolderKanbanIcon,
  PlusIcon,
  Settings2Icon,
  SearchIcon,
  ShieldCheckIcon,
} from "lucide-react";

import { openCommandPalette } from "~/commandPaletteBus";
import { deriveProviderInstanceEntries } from "~/providerInstances";
import { useEnvironments } from "~/state/environments";
import { useProjects, useServerConfigs } from "~/state/entities";
import { Badge } from "../ui/badge";
import { Input } from "../ui/input";
import { Button, buttonVariants } from "../ui/button";
import { Card, CardDescription, CardHeader, CardPanel, CardTitle } from "../ui/card";
import { knowledgeDashboardRoute } from "../knowledge/KnowledgeDocLink";
import { AddProviderInstanceDialog } from "../settings/AddProviderInstanceDialog";
import { ProviderAccountUsage } from "../settings/ProviderAccountUsage";
import { RedactedSensitiveText } from "../settings/RedactedSensitiveText";
import { McpToolsSection } from "../settings/McpToolsSection";
import { ExtensionsSection } from "../settings/ExtensionsSection";
import { AttentionInbox } from "./AttentionInbox";
import { TaskDashboard } from "./TaskDashboard";
import { JasnaSection } from "./JasnaSection";

function providerStatusLabel(status: string): string {
  if (status === "ready") return "준비됨";
  if (status === "warning") return "주의";
  if (status === "error") return "오류";
  if (status === "disabled") return "사용 안 함";
  return status;
}

function StatCard(props: {
  icon: typeof BrainCircuitIcon;
  label: string;
  value: string | number;
  detail: string;
}) {
  const Icon = props.icon;
  return (
    <Card className="min-w-0">
      <CardHeader className="p-3 sm:p-4 sm:pb-3">
        <div className="flex items-center gap-1.5 text-muted-foreground sm:gap-2">
          <Icon className="size-3.5 shrink-0 sm:size-4" />
          <span className="truncate text-xs font-medium">{props.label}</span>
        </div>
        <CardTitle className="text-xl tabular-nums sm:text-2xl">{props.value}</CardTitle>
        <CardDescription className="line-clamp-2 text-[11px] sm:text-xs">
          {props.detail}
        </CardDescription>
      </CardHeader>
    </Card>
  );
}

export function ControlCenterOverview() {
  const navigate = useNavigate();
  const projects = useProjects();
  const serverConfigs = useServerConfigs();
  const { environments } = useEnvironments();
  const [addProviderOpen, setAddProviderOpen] = useState(false);
  const [projectSearch, setProjectSearch] = useState("");
  const [targetEnvironmentId, setTargetEnvironmentId] = useState<EnvironmentId | null>(null);
  const targetEnvironment =
    environments.find((environment) => environment.environmentId === targetEnvironmentId) ??
    environments[0] ??
    null;
  const environmentLabels = useMemo(
    () =>
      new Map(environments.map((environment) => [environment.environmentId, environment.label])),
    [environments],
  );
  const providerRows = useMemo(
    () =>
      [...serverConfigs.entries()].flatMap(([environmentId, config]) =>
        deriveProviderInstanceEntries(config.providers).map((provider) => ({
          environmentId,
          environmentLabel: environmentLabels.get(environmentId) ?? "현재 환경",
          provider,
        })),
      ),
    [environmentLabels, serverConfigs],
  );
  const activeProviders = providerRows.filter(
    ({ provider }) => provider.enabled && provider.isAvailable,
  ).length;
  const providerRowGroups = useMemo(() => {
    const groups = new Map<string, typeof providerRows>();
    for (const row of providerRows) {
      const key = `${row.environmentId}:${row.provider.driverKind}`;
      const list = groups.get(key) ?? [];
      list.push(row);
      groups.set(key, list);
    }
    return [...groups.entries()].map(([key, rows]) => ({
      key,
      driverKind: rows[0]!.provider.driverKind,
      environmentLabel: rows[0]!.environmentLabel,
      rows,
    }));
  }, [providerRows]);
  const memoryRoots = projects.filter(
    (project) => project.workspaceControl?.longTermMemoryRoot != null,
  ).length;
  const automaticConversationRag = projects.filter(
    (project) => project.workspaceControl?.conversationRag.enabled !== false,
  ).length;
  const sortedProjects = [...projects].sort((left, right) => left.title.localeCompare(right.title));
  const query = projectSearch.trim().toLocaleLowerCase();
  const visibleProjects = sortedProjects.filter(
    (project) =>
      !query ||
      `${project.title} ${project.workspaceRoot} ${environmentLabels.get(project.environmentId) ?? ""}`
        .toLocaleLowerCase()
        .includes(query),
  );

  return (
    <main className="workspace-control-center min-h-0 flex-1 overflow-y-auto bg-muted/15">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
        <section className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="mb-1 text-xs font-semibold tracking-wide text-primary">WORKSPACE</p>
            <h1 className="text-2xl font-semibold tracking-tight">AI 작업실</h1>
            <p className="mt-1 max-w-3xl text-sm leading-relaxed text-muted-foreground">
              프로젝트별 작업과 기억을 이어가고, AI 계정과 MCP 도구를 한곳에서 관리하세요.
            </p>
          </div>
          <Button size="sm" onClick={() => openCommandPalette({ open: "add-project" })}>
            <PlusIcon />
            프로젝트 추가
          </Button>
        </section>

        <section
          data-control-center-kpi-grid=""
          className="grid grid-cols-2 gap-2.5 sm:gap-3 xl:grid-cols-4"
        >
          <StatCard
            icon={FolderKanbanIcon}
            label="독립 프로젝트"
            value={projects.length}
            detail="등록된 물리 폴더"
          />
          <StatCard
            icon={ShieldCheckIcon}
            label="격리 모드"
            value={projects.length}
            detail="모든 프로젝트 엄격 격리"
          />
          <StatCard
            icon={BotIcon}
            label="사용 가능 CLI 계정"
            value={activeProviders}
            detail={`전체 등록 인스턴스 ${providerRows.length}개`}
          />
          <StatCard
            icon={DatabaseIcon}
            label="자동 입력 RAG"
            value={automaticConversationRag}
            detail={`활성 프로젝트 · 외부 기억 루트 ${memoryRoots}개`}
          />
        </section>

        <AttentionInbox />
        <TaskDashboard />
        <JasnaSection />

        <section className="grid gap-4 xl:grid-cols-[minmax(0,1.4fr)_minmax(20rem,0.8fr)]">
          <Card>
            <CardHeader>
              <CardTitle>폴더별 운영 단위</CardTitle>
              <CardDescription>
                같은 CLI 계정을 사용해도 지식과 장기기억은 각 프로젝트 경계를 넘지 않습니다.
              </CardDescription>
              <label className="mt-3 flex items-center gap-2 rounded-lg border border-input bg-background px-3">
                <SearchIcon className="size-4 shrink-0 text-muted-foreground" />
                <Input
                  aria-label="프로젝트 검색"
                  className="border-0 bg-transparent shadow-none focus-visible:ring-0"
                  placeholder="프로젝트·폴더·환경 검색"
                  value={projectSearch}
                  onChange={(event) => setProjectSearch(event.currentTarget.value)}
                />
              </label>
            </CardHeader>
            <CardPanel className="grid gap-2">
              {visibleProjects.map((project) => (
                <div
                  key={`${project.environmentId}:${project.id}`}
                  className="grid min-w-0 rounded-xl border border-border/70 bg-background/50 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
                >
                  <button
                    type="button"
                    className="flex min-w-0 items-center gap-3 rounded-xl px-4 py-3 text-left transition-colors hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={() =>
                      void navigate({
                        to: "/control-center/$environmentId/$projectId",
                        params: { environmentId: project.environmentId, projectId: project.id },
                      })
                    }
                  >
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/8 text-primary">
                      <FolderKanbanIcon className="size-4" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{project.title}</span>
                      <span className="block truncate font-mono text-xs text-muted-foreground">
                        {project.workspaceRoot}
                      </span>
                    </span>
                    <span className="flex shrink-0 flex-col items-end gap-1">
                      <Badge variant="success">엄격 격리</Badge>
                      <Badge
                        variant={
                          project.workspaceControl?.conversationRag.enabled === false
                            ? "outline"
                            : "info"
                        }
                      >
                        입력 RAG{" "}
                        {project.workspaceControl?.conversationRag.enabled === false
                          ? "꺼짐"
                          : "켜짐"}
                      </Badge>
                      <span className="text-[10px] text-muted-foreground">
                        {environmentLabels.get(project.environmentId) ?? "현재 환경"}
                      </span>
                    </span>
                  </button>
                  <div className="mr-3 mb-2 flex items-center gap-1.5 justify-self-end sm:mb-0">
                    <Link
                      to="/control-center/$environmentId/$projectId"
                      params={{ environmentId: project.environmentId, projectId: project.id }}
                      search={{ domain: "home", section: "mission-control" }}
                      className={buttonVariants({
                        variant: "default",
                        size: "sm",
                      })}
                    >
                      자율 운영실
                    </Link>
                    <Link
                      to={knowledgeDashboardRoute}
                      params={{ environmentId: project.environmentId, projectId: project.id }}
                      aria-label={`${project.title} 위키 열기 (${environmentLabels.get(project.environmentId) ?? project.environmentId})`}
                      className={buttonVariants({
                        variant: "outline",
                        size: "sm",
                      })}
                    >
                      위키 열기
                    </Link>
                  </div>
                </div>
              ))}
              {visibleProjects.length === 0 ? (
                <div className="rounded-xl border border-dashed border-border px-6 py-12 text-center text-sm text-muted-foreground">
                  {query
                    ? "검색한 프로젝트가 없습니다."
                    : "먼저 운영할 폴더를 프로젝트로 추가하세요."}
                </div>
              ) : null}
            </CardPanel>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>CLI 계정 풀</CardTitle>
              <CardDescription>
                클로드, 코덱스, 그록 등 복수 인스턴스를 역할별로 선택할 수 있습니다.
              </CardDescription>
            </CardHeader>
            <CardPanel className="grid gap-3">
              {providerRowGroups.map((group) => (
                <section key={group.key} className="grid gap-2">
                  <div className="flex min-w-0 items-center justify-between gap-3 px-1">
                    <div className="min-w-0">
                      <h3 className="truncate text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        {group.driverKind}
                      </h3>
                      <p className="truncate text-[11px] text-muted-foreground">
                        {group.environmentLabel} · 계정 {group.rows.length}개
                      </p>
                    </div>
                    {group.rows.length > 1 ? (
                      <Badge variant="outline" size="sm">
                        그룹
                      </Badge>
                    ) : null}
                  </div>
                  {group.rows.map(({ environmentId, environmentLabel, provider }) => (
                    <div
                      key={`${environmentId}:${provider.instanceId}`}
                      className="grid gap-3 rounded-xl border border-border/60 bg-background/35 px-3 py-3"
                    >
                      <div className="flex min-w-0 items-center gap-3">
                        <span
                          className="size-2.5 shrink-0 rounded-full"
                          style={{
                            backgroundColor:
                              provider.accentColor ??
                              (provider.enabled && provider.status === "ready"
                                ? "var(--color-success)"
                                : "var(--color-muted-foreground)"),
                          }}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="flex min-w-0 items-center gap-2">
                            <span className="truncate text-sm font-medium">
                              {provider.displayName}
                            </span>
                            <Badge variant="outline" size="sm">
                              {provider.driverKind}
                            </Badge>
                          </span>
                          <span className="mt-0.5 flex min-w-0 flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
                            {provider.snapshot.auth.email ? (
                              <RedactedSensitiveText
                                value={provider.snapshot.auth.email}
                                ariaLabel={`${provider.displayName} 인증 이메일 보기 또는 가리기`}
                                revealTooltip="클릭하여 인증 이메일 표시"
                                hideTooltip="클릭하여 인증 이메일 가리기"
                              />
                            ) : (
                              <span className="truncate">
                                {provider.snapshot.auth.label ?? provider.instanceId}
                              </span>
                            )}
                            <span aria-hidden="true">·</span>
                            {/^DESKTOP-[A-Z0-9-]+$/i.test(environmentLabel) ? (
                              <RedactedSensitiveText
                                value={environmentLabel}
                                ariaLabel="호스트명 보기 또는 가리기"
                                revealTooltip="클릭하여 호스트명 표시"
                                hideTooltip="클릭하여 호스트명 가리기"
                              />
                            ) : (
                              <span className="truncate">{environmentLabel}</span>
                            )}
                          </span>
                        </span>
                        <Badge
                          variant={
                            provider.enabled && provider.status === "ready" ? "success" : "outline"
                          }
                        >
                          {providerStatusLabel(provider.status)}
                        </Badge>
                      </div>
                      <ProviderAccountUsage usage={provider.snapshot.usage} />
                    </div>
                  ))}
                </section>
              ))}
              {providerRows.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">
                  등록된 CLI 제공자 인스턴스가 없습니다.
                </p>
              ) : null}
              <div className="mt-2 grid gap-2 rounded-xl border border-dashed border-border px-3 py-3">
                <div className="flex flex-col gap-2 sm:flex-row">
                  {environments.length > 1 ? (
                    <select
                      aria-label="CLI 계정을 등록할 환경"
                      className="h-8 min-w-0 flex-1 rounded-lg border border-input bg-background px-2.5 text-xs text-foreground outline-none focus:ring-2 focus:ring-ring"
                      value={targetEnvironment?.environmentId ?? ""}
                      onChange={(event) => {
                        const selected = environments.find(
                          (environment) => environment.environmentId === event.target.value,
                        );
                        if (selected) setTargetEnvironmentId(selected.environmentId);
                      }}
                    >
                      {environments.map((environment) => (
                        <option key={environment.environmentId} value={environment.environmentId}>
                          {environment.label}
                        </option>
                      ))}
                    </select>
                  ) : null}
                  <Button
                    size="sm"
                    disabled={!targetEnvironment}
                    onClick={() => setAddProviderOpen(true)}
                  >
                    <PlusIcon />
                    CLI 계정 추가
                  </Button>
                </div>
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  같은 클로드·코덱스·그록도 개인용, 업무용처럼 여러 인스턴스로 분리해 등록할 수
                  있습니다.
                </p>
                <Button
                  variant="ghost"
                  size="sm"
                  className="justify-start text-muted-foreground"
                  onClick={() => void navigate({ to: "/settings/providers" })}
                >
                  <Settings2Icon />
                  모든 CLI 계정 설정 열기
                </Button>
              </div>
            </CardPanel>
          </Card>
        </section>
      </div>
      {targetEnvironment ? (
        <div className="mx-auto w-full max-w-7xl px-4 pb-6 sm:px-6 lg:px-8">
          <McpToolsSection
            key={targetEnvironment.environmentId}
            environmentId={targetEnvironment.environmentId}
          />
          <div className="mt-6">
            <ExtensionsSection
              key={targetEnvironment.environmentId}
              environmentId={targetEnvironment.environmentId}
            />
          </div>
        </div>
      ) : null}
      {targetEnvironment ? (
        <AddProviderInstanceDialog
          key={targetEnvironment.environmentId}
          open={addProviderOpen}
          environmentId={targetEnvironment.environmentId}
          environmentLabel={targetEnvironment.label}
          onOpenChange={setAddProviderOpen}
        />
      ) : null}
    </main>
  );
}
