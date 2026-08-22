import { Link } from "@tanstack/react-router";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  DEFAULT_WORKSPACE_MONITORING_SETTINGS,
  ProviderInstanceId,
  WorkspaceMonitoringPlan,
  type ModelSelection,
  type WorkspaceMonitoringAutonomy,
  type WorkspaceMonitoringPlanStatus,
  type WorkspaceMonitoringSettings,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import {
  EyeIcon,
  MessageSquareTextIcon,
  RefreshCcwIcon,
  ShieldAlertIcon,
  CheckIcon,
  PencilIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { useEnvironmentSettings } from "~/hooks/useSettings";
import { deriveProviderInstanceEntries } from "~/providerInstances";
import { useServerConfigs } from "~/state/entities";
import { orchestrationEnvironment } from "~/state/orchestration";
import { projectEnvironment } from "~/state/projects";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardAction, CardDescription, CardHeader, CardPanel, CardTitle } from "../ui/card";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  describeMonitoringMetric,
  describeMonitoringPlaybook,
  describeMonitoringTarget,
  monitoringPlanStatusLabel,
  monitoringPlanStatusVariant,
  parseMonitoringPlanDraft,
} from "./WorkspaceMonitoringSection.logic";

function notifyFailure<A, E>(result: AtomCommandResult<A, E>, title: string): boolean {
  if (result._tag === "Success") return false;
  const error = squashAtomCommandFailure(result);
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : "요청을 처리하지 못했습니다.",
    }),
  );
  return true;
}

function timestamp(value: string | null): string {
  if (value === null) return "-";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString("ko-KR");
}

const WATCHER_SELECT_CLASS =
  "h-9 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground outline-none transition-shadow focus:border-ring focus:ring-3 focus:ring-ring/20 dark:bg-input/32";

const AUTONOMY_OPTIONS: ReadonlyArray<{
  readonly value: WorkspaceMonitoringAutonomy;
  readonly label: string;
  readonly detail: string;
}> = [
  {
    value: "ask",
    label: "관찰·진단만, 행동은 물어봄",
    detail: "재시작·수정·설정 변경은 매번 모니터링 스레드에서 사람에게 묻습니다.",
  },
  {
    value: "playbooks",
    label: "승인한 플레이북 안에서 자율",
    detail:
      "계획을 승인할 때 '이 경우엔 이렇게'도 함께 승인합니다. 그 범위 밖은 여전히 묻습니다. 권한 설정의 '모니터링 자동 조치'도 켜져 있어야 합니다.",
  },
];

const encodePlan = Schema.encodeSync(Schema.fromJsonString(WorkspaceMonitoringPlan));

export function WorkspaceMonitoringSection({ project }: { project: EnvironmentProject }) {
  const settings: WorkspaceMonitoringSettings =
    project.workspaceControl?.monitoring ?? DEFAULT_WORKSPACE_MONITORING_SETTINGS;
  const runtime = useEnvironmentQuery(
    orchestrationEnvironment.workspaceRuntime({
      environmentId: project.environmentId,
      input: { projectId: project.id },
    }),
  );
  const permissions = useEnvironmentSettings(
    project.environmentId,
    (environmentSettings) => environmentSettings.workspaceProgramPermissions,
  );
  const updateWorkspaceControl = useAtomCommand(projectEnvironment.updateWorkspaceControl, {
    label: "프로그램 모니터링 설정",
    reportFailure: false,
  });
  const approvePlan = useAtomCommand(projectEnvironment.approveWorkspaceMonitoringPlan, {
    label: "감시 계획 승인",
    reportFailure: false,
  });
  const reanalyze = useAtomCommand(projectEnvironment.reanalyzeWorkspaceMonitoring, {
    label: "감시 계획 다시 분석",
    reportFailure: false,
  });

  const [checkInterval, setCheckInterval] = useState(String(settings.checkIntervalSec));
  const [perHour, setPerHour] = useState(String(settings.aiTurnBudget.perHour));
  const [perDay, setPerDay] = useState(String(settings.aiTurnBudget.perDay));
  // 감시 AI: which account/model runs the monitoring thread. Empty instance =
  // fall back to the project's operator/coordinator role binding.
  const serverConfigs = useServerConfigs();
  const providerSnapshots = serverConfigs.get(project.environmentId)?.providers ?? [];
  const providerEntries = useMemo(
    () => deriveProviderInstanceEntries(providerSnapshots).filter((entry) => entry.enabled),
    [providerSnapshots],
  );
  const [watcherInstanceId, setWatcherInstanceId] = useState(
    settings.modelSelection?.instanceId ?? "",
  );
  const [watcherModel, setWatcherModel] = useState(settings.modelSelection?.model ?? "");
  const watcherProvider =
    providerEntries.find((entry) => entry.instanceId === watcherInstanceId) ?? null;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [draftError, setDraftError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setCheckInterval(String(settings.checkIntervalSec));
    setPerHour(String(settings.aiTurnBudget.perHour));
    setPerDay(String(settings.aiTurnBudget.perDay));
    setWatcherInstanceId(settings.modelSelection?.instanceId ?? "");
    setWatcherModel(settings.modelSelection?.model ?? "");
  }, [
    project.id,
    settings.checkIntervalSec,
    settings.aiTurnBudget.perHour,
    settings.aiTurnBudget.perDay,
    settings.modelSelection,
  ]);

  const watcherSelection = useMemo<ModelSelection | null>(() => {
    if (watcherInstanceId.trim().length === 0) return null;
    const provider = providerEntries.find((entry) => entry.instanceId === watcherInstanceId);
    const model = watcherModel.trim() || provider?.models[0]?.slug || "";
    if (model.length === 0) return null;
    return { instanceId: ProviderInstanceId.make(watcherInstanceId), model };
  }, [providerEntries, watcherInstanceId, watcherModel]);
  const userSettings = useMemo(
    () => ({
      enabled: settings.enabled,
      autonomy: settings.autonomy,
      modelSelection: watcherSelection,
      checkIntervalSec: Math.min(
        3_600,
        Math.max(15, Number.parseInt(checkInterval, 10) || settings.checkIntervalSec),
      ),
      aiTurnBudget: {
        perHour: Math.min(
          12,
          Math.max(1, Number.parseInt(perHour, 10) || settings.aiTurnBudget.perHour),
        ),
        perDay: Math.min(
          60,
          Math.max(1, Number.parseInt(perDay, 10) || settings.aiTurnBudget.perDay),
        ),
      },
    }),
    [checkInterval, perDay, perHour, settings, watcherSelection],
  );
  const watcherChanged =
    (watcherSelection?.instanceId ?? null) !== (settings.modelSelection?.instanceId ?? null) ||
    (watcherSelection?.model ?? null) !== (settings.modelSelection?.model ?? null);
  const settingsChanged =
    watcherChanged ||
    userSettings.checkIntervalSec !== settings.checkIntervalSec ||
    userSettings.aiTurnBudget.perHour !== settings.aiTurnBudget.perHour ||
    userSettings.aiTurnBudget.perDay !== settings.aiTurnBudget.perDay;

  // Every monitoring write goes through workspaceControl.update with ONLY the
  // monitoring fields; the server keeps the rest of the blob as it is.
  const saveMonitoring = async (
    patch: Partial<typeof userSettings> & { readonly plan?: WorkspaceMonitoringPlan | null },
    successTitle: string,
  ) => {
    setBusy(true);
    try {
      const result = await updateWorkspaceControl({
        environmentId: project.environmentId,
        input: {
          projectId: project.id,
          longTermMemoryRoot: project.workspaceControl?.longTermMemoryRoot ?? null,
          monitoring: { ...userSettings, ...patch },
        },
      });
      if (!notifyFailure(result, "모니터링 설정 저장 실패")) {
        toastManager.add(stackedThreadToast({ type: "success", title: successTitle }));
      }
      return result._tag === "Success";
    } finally {
      setBusy(false);
    }
  };

  const startEditing = () => {
    setDraft(settings.plan === null ? "" : encodePlan(settings.plan));
    setDraftError(null);
    setEditing(true);
  };
  const savePlan = async () => {
    const parsed = parseMonitoringPlanDraft(draft, settings.plan);
    if (parsed._tag === "Invalid") {
      setDraftError(parsed.detail);
      return;
    }
    const saved = await saveMonitoring({ plan: parsed.plan }, "감시 계획을 저장했습니다.");
    if (saved) setEditing(false);
  };

  const monitoringRuntime = runtime.data?.monitoring;
  const planStatus: WorkspaceMonitoringPlanStatus = settings.planStatus;
  const plan = settings.plan;

  return (
    <Card id="project-monitoring" className="scroll-mt-24">
      <CardHeader>
        <div className="mb-1 flex items-center gap-2 text-primary">
          <EyeIcon className="size-4" />
          <span className="text-xs font-semibold uppercase tracking-wide">프로젝트 전용</span>
        </div>
        <CardTitle>프로그램 모니터링 모드</CardTitle>
        <CardDescription className="leading-relaxed">
          켜 두면 대화하는 동안에도 이 프로젝트의 프로그램을 계속 지켜봅니다. AI가 무엇을 감시할지
          먼저 제안하고, 승인한 계획대로 이상을 찾으면 전용 모니터링 스레드에 보고하고 거기서
          묻습니다.
        </CardDescription>
        <CardAction>
          <div className="flex items-center gap-2">
            <Badge variant={monitoringPlanStatusVariant(planStatus, settings.enabled)}>
              {settings.enabled ? monitoringPlanStatusLabel(planStatus) : "꺼짐"}
            </Badge>
            <Switch
              checked={settings.enabled}
              disabled={busy}
              aria-label="프로그램 모니터링 모드"
              onCheckedChange={(enabled) =>
                void saveMonitoring(
                  { enabled },
                  enabled
                    ? "모니터링을 켰습니다. 곧 감시 계획을 제안합니다."
                    : "모니터링을 껐습니다.",
                )
              }
            />
          </div>
        </CardAction>
      </CardHeader>
      <CardPanel className="grid gap-6">
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(17rem,0.45fr)]">
          <div className="grid gap-3">
            <span className="text-sm font-medium">AI 행동 범위</span>
            {AUTONOMY_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                disabled={busy}
                aria-pressed={settings.autonomy === option.value}
                onClick={() =>
                  settings.autonomy === option.value
                    ? undefined
                    : void saveMonitoring({ autonomy: option.value }, "AI 행동 범위를 바꿨습니다.")
                }
                className={
                  "rounded-xl border px-4 py-3 text-left transition-colors " +
                  (settings.autonomy === option.value
                    ? "border-primary bg-primary/5"
                    : "border-border hover:bg-muted")
                }
              >
                <div className="text-sm font-medium">{option.label}</div>
                <div className="mt-1 text-xs text-muted-foreground">{option.detail}</div>
              </button>
            ))}
            {settings.autonomy === "playbooks" && !permissions.monitoringAutoActions ? (
              <p className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs">
                <ShieldAlertIcon className="mt-0.5 size-3.5 shrink-0" />
                설정 → 권한 → 프로젝트 프로그램 운영에서 <strong>모니터링 자동 조치</strong>가 꺼져
                있어 플레이북은 기록만 되고 실행되지 않습니다.
              </p>
            ) : null}
          </div>
          <div className="grid gap-3">
            <span className="text-sm font-medium">감시 AI</span>
            <div className="grid gap-2 md:grid-cols-2">
              <label className="grid gap-1 text-xs text-muted-foreground">
                CLI 계정
                <select
                  className={WATCHER_SELECT_CLASS}
                  value={watcherInstanceId}
                  onChange={(event) => {
                    const next = providerEntries.find(
                      (entry) => entry.instanceId === event.currentTarget.value,
                    );
                    setWatcherInstanceId(event.currentTarget.value);
                    setWatcherModel(next?.models[0]?.slug ?? "");
                  }}
                >
                  <option value="">역할 바인딩(운영자/조정자)을 따름</option>
                  {providerEntries.map((provider) => (
                    <option key={provider.instanceId} value={provider.instanceId}>
                      {provider.displayName} ({provider.instanceId})
                    </option>
                  ))}
                </select>
              </label>
              <label className="grid gap-1 text-xs text-muted-foreground">
                모델
                <Input
                  value={watcherModel}
                  disabled={watcherInstanceId.length === 0}
                  onChange={(event) => setWatcherModel(event.currentTarget.value)}
                  list="monitoring-watcher-models"
                  placeholder="모델 식별자"
                />
                <datalist id="monitoring-watcher-models">
                  {watcherProvider?.models.map((entry) => (
                    <option key={entry.slug} value={entry.slug} />
                  ))}
                </datalist>
              </label>
            </div>
            <p className="text-xs text-muted-foreground">
              감시 스레드의 계획 제안·발견 보고·질문을 이 AI가 맡습니다. 감시 스레드에서 직접 대화할
              때도 같은 AI가 답합니다. Monitor 도구가 없는 모델이어도 됩니다 — 로그 tail과 상태
              수집은 서버가 합니다.
            </p>
            <label htmlFor="monitoring-interval" className="text-sm font-medium">
              점검 주기 (초, 15~3600)
            </label>
            <Input
              id="monitoring-interval"
              inputMode="numeric"
              value={checkInterval}
              onChange={(event) => setCheckInterval(event.target.value)}
            />
            <span className="text-sm font-medium">AI 턴 예산</span>
            <div className="grid grid-cols-2 gap-2">
              <label className="grid gap-1 text-xs text-muted-foreground">
                시간당 (≤12)
                <Input
                  inputMode="numeric"
                  value={perHour}
                  onChange={(event) => setPerHour(event.target.value)}
                />
              </label>
              <label className="grid gap-1 text-xs text-muted-foreground">
                하루 (≤60)
                <Input
                  inputMode="numeric"
                  value={perDay}
                  onChange={(event) => setPerDay(event.target.value)}
                />
              </label>
            </div>
            <p className="text-xs text-muted-foreground">
              신호 수집은 서버가 무료로 합니다. 예산은 이상이 감지됐을 때 AI가 보고·질문하는 턴에만
              쓰입니다.
              {monitoringRuntime
                ? ` 남은 턴: 이번 시간 ${monitoringRuntime.budgetRemainingHour}회 · 오늘 ${monitoringRuntime.budgetRemainingDay}회.`
                : null}
            </p>
            <Button
              size="sm"
              disabled={!settingsChanged || busy}
              onClick={() => void saveMonitoring({}, "감시 AI·주기·예산을 저장했습니다.")}
            >
              감시 AI·주기·예산 저장
            </Button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span>마지막 점검 {timestamp(settings.lastCheckedAt)}</span>
          <span aria-hidden>·</span>
          {settings.threadId ? (
            <Link
              to="/$environmentId/$threadId"
              params={{ environmentId: project.environmentId, threadId: settings.threadId }}
              className="inline-flex items-center gap-1 text-primary hover:underline"
            >
              <MessageSquareTextIcon className="size-3.5" /> 모니터링 스레드 열기
            </Link>
          ) : (
            <span>
              모니터링 스레드는 첫 점검 때 만들어집니다. 운영 진단 또는 총괄 조정 역할에 AI 계정이
              연결돼 있어야 합니다.
            </span>
          )}
        </div>

        <section className="grid gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold">감시 계획</h3>
            <div className="flex gap-2">
              {planStatus === "proposed" && plan ? (
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    void (async () => {
                      setBusy(true);
                      try {
                        const result = await approvePlan({
                          environmentId: project.environmentId,
                          input: { projectId: project.id, revision: plan.revision },
                        });
                        if (!notifyFailure(result, "감시 계획 승인 실패")) {
                          toastManager.add(
                            stackedThreadToast({
                              type: "success",
                              title: "감시 계획을 승인했습니다.",
                            }),
                          );
                        }
                      } finally {
                        setBusy(false);
                      }
                    })()
                  }
                >
                  <CheckIcon className="size-3.5" /> 승인
                </Button>
              ) : null}
              <Button
                size="sm"
                variant="outline"
                disabled={busy || !settings.enabled}
                onClick={() =>
                  void (async () => {
                    setBusy(true);
                    try {
                      const result = await reanalyze({
                        environmentId: project.environmentId,
                        input: { projectId: project.id },
                      });
                      if (!notifyFailure(result, "다시 분석 요청 실패")) {
                        toastManager.add(
                          stackedThreadToast({
                            type: "success",
                            title: "다시 분석을 요청했습니다.",
                            description: "다음 점검 때 모니터링 스레드에 새 계획이 올라옵니다.",
                          }),
                        );
                      }
                    } finally {
                      setBusy(false);
                    }
                  })()
                }
              >
                <RefreshCcwIcon className="size-3.5" /> 다시 분석
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={editing ? () => setEditing(false) : startEditing}
              >
                <PencilIcon className="size-3.5" /> {editing ? "편집 취소" : "직접 편집"}
              </Button>
            </div>
          </div>

          {planStatus === "stale" ? (
            <p className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs">
              프로그램 구성이 바뀌어 승인된 계획이 현재 상태와 맞지 않을 수 있습니다. 다시 분석을
              누르면 새 계획을 제안합니다. 그동안 기존 계획은 계속 적용됩니다.
            </p>
          ) : null}

          {editing ? (
            <div className="grid gap-2">
              <Textarea
                rows={14}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder='{"rationale": "...", "targets": [...], "metrics": [...], "playbooks": [...]}'
                className="font-mono text-xs"
              />
              {draftError ? <p className="text-xs text-destructive">{draftError}</p> : null}
              <div className="flex gap-2">
                <Button size="sm" disabled={busy} onClick={() => void savePlan()}>
                  계획 저장 (승인됨으로 저장)
                </Button>
                {plan ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      void saveMonitoring({ plan: null }, "감시 계획을 비웠습니다.").then(
                        (saved) => {
                          if (saved) setEditing(false);
                        },
                      )
                    }
                  >
                    계획 비우기
                  </Button>
                ) : null}
              </div>
            </div>
          ) : plan === null ? (
            <p className="text-sm text-muted-foreground">
              {settings.enabled
                ? "아직 계획이 없습니다. 첫 점검 때 AI가 프로젝트를 분석해 모니터링 스레드에 제안합니다."
                : "모니터링을 켜면 AI가 프로젝트를 분석해 감시 계획을 제안합니다."}
            </p>
          ) : (
            <div className="grid gap-4">
              {plan.rationale ? <p className="text-sm leading-relaxed">{plan.rationale}</p> : null}
              <div className="grid gap-3 md:grid-cols-3">
                <div className="grid gap-1">
                  <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    대상 {plan.targets.length}
                  </h4>
                  <ul className="grid gap-1 text-sm">
                    {plan.targets.map((target) => (
                      <li
                        key={`${target.kind}:${target.label}:${target.programId ?? target.pid ?? target.url ?? ""}`}
                      >
                        {describeMonitoringTarget(target)}
                      </li>
                    ))}
                  </ul>
                </div>
                <div className="grid gap-1">
                  <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    지표 {plan.metrics.length}
                  </h4>
                  <ul className="grid gap-1 text-sm">
                    {plan.metrics.map((metric) => (
                      <li
                        key={`${metric.targetIndex}:${metric.metric}:${metric.trend}:${metric.windowMin}:${metric.limit}`}
                      >
                        {describeMonitoringMetric(metric, plan.targets)}
                      </li>
                    ))}
                  </ul>
                </div>
                <div className="grid gap-1">
                  <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    플레이북 {plan.playbooks.length}
                  </h4>
                  <ul className="grid gap-1 text-sm">
                    {plan.playbooks.map((playbook) => (
                      <li key={`${playbook.when}:${playbook.action}:${playbook.programId ?? ""}`}>
                        {describeMonitoringPlaybook(playbook, plan)}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                {plan.revision}판 · 제안 {timestamp(plan.proposedAt)} · 승인{" "}
                {timestamp(plan.approvedAt)}
              </p>
            </div>
          )}
        </section>
      </CardPanel>
    </Card>
  );
}
