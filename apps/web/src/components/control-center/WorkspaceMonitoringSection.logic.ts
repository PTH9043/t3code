import {
  WorkspaceMonitoringPlan,
  type WorkspaceMonitoringMetric,
  type WorkspaceMonitoringPlanStatus,
  type WorkspaceMonitoringPlaybook,
  type WorkspaceMonitoringTarget,
} from "@t3tools/contracts";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

/** The fields a person types when editing a plan by hand; server-stamped fields are filled in here. */
const PlanDraft = Schema.Struct({
  rationale: Schema.optionalKey(WorkspaceMonitoringPlan.fields.rationale),
  targets: WorkspaceMonitoringPlan.fields.targets,
  metrics: WorkspaceMonitoringPlan.fields.metrics,
  playbooks: Schema.optionalKey(WorkspaceMonitoringPlan.fields.playbooks),
});
const decodeDraft = Schema.decodeUnknownResult(PlanDraft);

export type ParsedPlanDraft =
  | { readonly _tag: "Invalid"; readonly detail: string }
  | { readonly _tag: "Plan"; readonly plan: WorkspaceMonitoringPlan };

/**
 * Validate a hand-edited plan the same way the server validates an AI one:
 * strict schema plus index bounds. `previous` supplies proposedAt so the
 * timeline on the card keeps reading sensibly after an edit.
 */
export function parseMonitoringPlanDraft(
  text: string,
  previous: WorkspaceMonitoringPlan | null,
): ParsedPlanDraft {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (cause) {
    return { _tag: "Invalid", detail: `JSON 구문 오류: ${String(cause)}` };
  }
  const decoded = decodeDraft(json);
  if (Result.isFailure(decoded)) return { _tag: "Invalid", detail: String(decoded.failure) };
  const draft = decoded.success;
  const badMetric = draft.metrics.findIndex((metric) => metric.targetIndex >= draft.targets.length);
  if (badMetric !== -1) {
    return {
      _tag: "Invalid",
      detail: `metrics[${badMetric}].targetIndex가 targets 범위를 벗어납니다.`,
    };
  }
  const playbooks = draft.playbooks ?? [];
  const badPlaybook = playbooks.findIndex((playbook) => playbook.when >= draft.metrics.length);
  if (badPlaybook !== -1) {
    return {
      _tag: "Invalid",
      detail: `playbooks[${badPlaybook}].when이 metrics 범위를 벗어납니다.`,
    };
  }
  return {
    _tag: "Plan",
    plan: {
      revision: previous?.revision ?? 0,
      proposedAt: previous?.proposedAt ?? new Date().toISOString(),
      approvedAt: null,
      rationale: draft.rationale ?? null,
      targets: draft.targets,
      metrics: draft.metrics,
      playbooks,
    },
  };
}

export function monitoringPlanStatusLabel(status: WorkspaceMonitoringPlanStatus): string {
  switch (status) {
    case "none":
      return "계획 준비 중";
    case "proposed":
      return "승인 대기";
    case "approved":
      return "감시 중";
    case "stale":
      return "재분석 권장";
  }
}

export function monitoringPlanStatusVariant(
  status: WorkspaceMonitoringPlanStatus,
  enabled: boolean,
): "success" | "warning" | "info" | "outline" {
  if (!enabled) return "outline";
  switch (status) {
    case "approved":
      return "success";
    case "proposed":
    case "stale":
      return "warning";
    case "none":
      return "info";
  }
}

const TARGET_KIND_LABELS: Readonly<Record<WorkspaceMonitoringTarget["kind"], string>> = {
  program: "프로그램",
  "self-server": "T3 서버",
  "self-desktop": "T3 데스크톱",
  process: "프로세스",
  url: "URL",
  log: "로그 파일",
};

const METRIC_LABELS: Readonly<Record<WorkspaceMonitoringMetric["metric"], string>> = {
  cpu: "CPU",
  memory: "메모리",
  latency: "응답 지연",
  "slow-spans": "느린 span",
  health: "상태검사",
  regression: "회귀",
  "log-matches": "로그 패턴",
};

const TREND_LABELS: Readonly<Record<WorkspaceMonitoringMetric["trend"], string>> = {
  threshold: "임계치",
  slope: "증가 추세",
  "p95-vs-baseline": "직전 대비 p95",
};

const PLAYBOOK_LABELS: Readonly<Record<WorkspaceMonitoringPlaybook["action"], string>> = {
  "notify-only": "알리기만",
  "restart-program": "프로그램 재시작",
  "stop-program": "프로그램 중지",
  "start-program": "프로그램 시작",
  "repair-run": "수정·검증 run 시작",
};

export function describeMonitoringTarget(target: WorkspaceMonitoringTarget): string {
  const extra =
    target.kind === "program" && target.programId
      ? ` (${target.programId})`
      : target.kind === "process" && target.pid !== undefined
        ? ` (pid ${target.pid})`
        : target.kind === "url" && target.url
          ? ` (${target.url})`
          : target.kind === "log" && target.path
            ? ` (${target.path}${target.patterns?.length ? ` · 패턴 ${target.patterns.length}개` : ""})`
            : "";
  return `${TARGET_KIND_LABELS[target.kind]} · ${target.label}${extra}`;
}

function formatLimit(metric: WorkspaceMonitoringMetric): string {
  if (metric.trend === "p95-vs-baseline") return `${metric.limit}배`;
  switch (metric.metric) {
    case "cpu":
      return `${metric.limit}%`;
    case "memory":
      return metric.trend === "slope"
        ? `분당 ${Math.round(metric.limit / 1024 / 1024)}MB`
        : `${Math.round(metric.limit / 1024 / 1024)}MB`;
    case "latency":
      return `${metric.limit}ms`;
    case "slow-spans":
      return `분당 ${metric.limit}건`;
    case "health":
      return `연속 ${metric.limit}회 실패`;
    case "regression":
      return `${metric.limit}회 실패`;
    case "log-matches":
      return `${metric.limit}줄 이상`;
  }
}

export function describeMonitoringMetric(
  metric: WorkspaceMonitoringMetric,
  targets: ReadonlyArray<WorkspaceMonitoringTarget>,
): string {
  const target = targets[metric.targetIndex];
  return `${target?.label ?? `대상 #${metric.targetIndex}`} · ${METRIC_LABELS[metric.metric]} · ${TREND_LABELS[metric.trend]} ${formatLimit(metric)} · ${metric.windowMin}분 창`;
}

export function describeMonitoringPlaybook(
  playbook: WorkspaceMonitoringPlaybook,
  plan: Pick<WorkspaceMonitoringPlan, "metrics" | "targets">,
): string {
  const metric = plan.metrics[playbook.when];
  const target = metric === undefined ? undefined : plan.targets[metric.targetIndex];
  const trigger =
    metric === undefined
      ? `지표 #${playbook.when}`
      : `${target?.label ?? `대상 #${metric.targetIndex}`}의 ${METRIC_LABELS[metric.metric]} 이상`;
  return `${trigger} → ${PLAYBOOK_LABELS[playbook.action]}`;
}
