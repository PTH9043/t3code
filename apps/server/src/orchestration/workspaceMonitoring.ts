import {
  WorkspaceMonitoringPlan,
  WorkspaceProgramId,
  type WorkspaceIncident,
  type WorkspaceMonitoringMetric,
  type WorkspaceMonitoringSettings,
  type WorkspaceProgram,
  type WorkspaceProgramCandidate,
  type WorkspaceProgramRun,
  type WorkspaceRuntimeMonitoring,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

/**
 * Pure helpers for 프로그램 모니터링 모드: the plan marker protocol, the AI-turn
 * budget, and the prompts. Nothing here touches Effect services so every rule
 * is unit-testable in isolation; the reactor only sequences them.
 */

export const WORKSPACE_MONITORING_PLAN_OPEN_MARKER = "[T3_MONITORING_PLAN]";
export const WORKSPACE_MONITORING_PLAN_CLOSE_MARKER = "[/T3_MONITORING_PLAN]";
export const WORKSPACE_MONITORING_ACTION_OPEN_MARKER = "[T3_MONITORING_ACTION]";
export const WORKSPACE_MONITORING_ACTION_CLOSE_MARKER = "[/T3_MONITORING_ACTION]";

/** Hard ceilings; the person's budget is clamped underneath them. */
export const MAX_MONITORING_TURNS_PER_HOUR = 12;
export const MAX_MONITORING_TURNS_PER_DAY = 60;

const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;

/** The subset of the plan the AI is asked to write (everything else is stamped by the server). */
const ProposedPlanBody = Schema.Struct({
  rationale: WorkspaceMonitoringPlan.fields.rationale,
  targets: WorkspaceMonitoringPlan.fields.targets,
  metrics: WorkspaceMonitoringPlan.fields.metrics,
  playbooks: WorkspaceMonitoringPlan.fields.playbooks,
});
export type ProposedPlanBody = typeof ProposedPlanBody.Type;
const decodeProposedPlanBody = Schema.decodeUnknownResult(ProposedPlanBody);

export type ParsedMonitoringPlan =
  | { readonly _tag: "Missing" }
  | { readonly _tag: "Invalid"; readonly detail: string }
  | { readonly _tag: "Plan"; readonly plan: ProposedPlanBody };

/**
 * Pull the fenced plan out of an assistant message. Strict on purpose: a plan
 * that does not decode is reported back, never guessed at, and never retried
 * automatically — each retry would cost a turn from the person's budget.
 */
export function parseMonitoringPlan(output: string): ParsedMonitoringPlan {
  const open = output.lastIndexOf(WORKSPACE_MONITORING_PLAN_OPEN_MARKER);
  if (open === -1) return { _tag: "Missing" };
  const bodyStart = open + WORKSPACE_MONITORING_PLAN_OPEN_MARKER.length;
  const close = output.indexOf(WORKSPACE_MONITORING_PLAN_CLOSE_MARKER, bodyStart);
  if (close === -1) return { _tag: "Invalid", detail: "닫는 마커가 없습니다." };
  const raw = output
    .slice(bodyStart, close)
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (cause) {
    return { _tag: "Invalid", detail: `JSON 구문 오류: ${String(cause)}` };
  }
  const decoded = decodeProposedPlanBody(json);
  if (Result.isFailure(decoded)) {
    return { _tag: "Invalid", detail: String(decoded.failure) };
  }
  const plan = decoded.success;
  const badMetric = plan.metrics.findIndex((metric) => metric.targetIndex >= plan.targets.length);
  if (badMetric !== -1) {
    return {
      _tag: "Invalid",
      detail: `metrics[${badMetric}].targetIndex가 targets 범위를 벗어납니다.`,
    };
  }
  const badPlaybook = plan.playbooks.findIndex((playbook) => playbook.when >= plan.metrics.length);
  if (badPlaybook !== -1) {
    return {
      _tag: "Invalid",
      detail: `playbooks[${badPlaybook}].when이 metrics 범위를 벗어납니다.`,
    };
  }
  return { _tag: "Plan", plan };
}

export interface MonitoringTurnBudget {
  readonly remainingHour: number;
  readonly remainingDay: number;
  /** `turnLog` with entries older than a day dropped — write this back. */
  readonly trimmedLog: ReadonlyArray<string>;
}

/**
 * How many automatic turns are still allowed right now. Mirrors the
 * collaboration graph-revision budget: the person's number, clamped under the
 * global ceiling, minus what the log already shows for the window.
 */
export function monitoringTurnBudget(
  settings: Pick<WorkspaceMonitoringSettings, "aiTurnBudget" | "turnLog">,
  nowIso: string,
): MonitoringTurnBudget {
  const now = Date.parse(nowIso);
  const trimmedLog = settings.turnLog.filter((at) => now - Date.parse(at) < DAY_MS);
  const lastHour = trimmedLog.filter((at) => now - Date.parse(at) < HOUR_MS).length;
  const perHour = Math.min(settings.aiTurnBudget.perHour, MAX_MONITORING_TURNS_PER_HOUR);
  const perDay = Math.min(settings.aiTurnBudget.perDay, MAX_MONITORING_TURNS_PER_DAY);
  return {
    remainingHour: Math.max(0, perHour - lastHour),
    remainingDay: Math.max(0, perDay - trimmedLog.length),
    trimmedLog,
  };
}

export function runtimeMonitoringView(
  settings: WorkspaceMonitoringSettings,
  nowIso: string,
): WorkspaceRuntimeMonitoring {
  const budget = monitoringTurnBudget(settings, nowIso);
  return {
    enabled: settings.enabled,
    planStatus: settings.planStatus,
    threadId: settings.threadId,
    budgetRemainingHour: budget.remainingHour,
    budgetRemainingDay: budget.remainingDay,
    lastCheckedAt: settings.lastCheckedAt,
  };
}

export interface MonitoringProposalContext {
  readonly projectTitle: string;
  readonly workspaceRoot: string;
  readonly programs: ReadonlyArray<WorkspaceProgram>;
  readonly runs: ReadonlyArray<WorkspaceProgramRun>;
  readonly candidates: ReadonlyArray<WorkspaceProgramCandidate>;
  readonly openIncidents: ReadonlyArray<WorkspaceIncident>;
  readonly selfMonitoring: boolean;
  readonly autonomy: WorkspaceMonitoringSettings["autonomy"];
}

const METRIC_GUIDE = [
  "- cpu / threshold: limit = 퍼센트(0-100). 창 안의 평균이 넘으면 이상.",
  "- memory / slope: limit = 분당 증가 바이트. 창 안의 선형 기울기가 넘으면 이상(누수 의심).",
  "- latency / p95-vs-baseline: limit = 배율(1.5 = 직전 창보다 50% 느림). 프로그램은 상태검사 응답시간, self-server는 이벤트 루프 지연(p99 ms) 기준. self-server에는 threshold(limit = ms, 예: 200)도 적절.",
  "- slow-spans / threshold: limit = 분당 1초 이상 걸린 span 수. self-server 대상 전용.",
  "- failed-spans / threshold: limit = 분당 실패한 내부 처리(span) 수. self-server 대상 전용. 같은 오류가 여러 span에 잡힐 수 있으므로 실패한 사용자 요청 수와 동일하지 않습니다.",
  "- health / threshold: limit = 연속 실패 횟수.",
  "- regression / threshold: limit = 1. 코드 변경 후 검증 명령이 실패하면 이상.",
  "- log-matches / threshold: limit = 창 안에서 patterns에 맞은 줄 수(보통 1). log 대상 전용. 서버가 파일을 직접 tail 하므로 AI 세션이 끝나거나 서버가 재시작돼도 감시가 유지됩니다.",
].join("\n");

/** The once-per-enable (or 다시 분석) prompt that ends in a parsable plan. */
export function buildMonitoringProposalPrompt(context: MonitoringProposalContext): string {
  const programLines =
    context.programs.length === 0
      ? ["(등록된 프로그램 없음)"]
      : context.programs.map((program) => {
          const run = context.runs.find((candidate) => candidate.programId === program.id);
          const health =
            program.healthCheck === null
              ? "상태검사 없음"
              : program.healthCheck.kind === "http"
                ? `HTTP ${program.healthCheck.url}`
                : `TCP ${program.healthCheck.host}:${program.healthCheck.port}`;
          return `- programId=${program.id} · ${program.name} · \`${program.command}\` · ${health} · 현재 ${run?.status ?? "미실행"}`;
        });
  const candidateLines =
    context.candidates.length === 0
      ? ["(후보 없음)"]
      : context.candidates.map(
          (candidate) => `- ${candidate.name} · \`${candidate.command}\` · ${candidate.reason}`,
        );
  const incidentLines =
    context.openIncidents.length === 0
      ? ["(미해결 장애 없음)"]
      : context.openIncidents.map(
          (incident) => `- [${incident.severity}] ${incident.kind}: ${incident.summary}`,
        );
  return [
    "# 프로그램 모니터링 계획 제안",
    "이 대화는 이 프로젝트의 전용 모니터링 스레드입니다. 앞으로 감시 결과와 질문이 여기에 쌓입니다.",
    "읽기 전용으로 프로젝트를 파악하세요. 파일을 수정하거나 프로그램을 실행·중지하지 마세요.",
    `프로젝트: ${context.projectTitle} (${context.workspaceRoot})`,
    "## 등록된 프로그램",
    ...programLines,
    "## 폴더에서 발견된 실행 후보 (등록되지 않음)",
    ...candidateLines,
    "## 미해결 장애",
    ...incidentLines,
    context.selfMonitoring
      ? "## T3 Code 자체 감시\n서버 전역 설정에서 이 프로젝트가 T3 Code 자체(self-server, 데스크톱이 호스트이면 self-desktop)의 상태를 받도록 지정되어 있습니다. 해당 대상을 포함하세요."
      : "## T3 Code 자체 감시\n꺼져 있습니다. self-server / self-desktop 대상은 넣지 마세요.",
    "## 지표 규칙",
    METRIC_GUIDE,
    context.autonomy === "playbooks"
      ? "## 플레이북\n자율 모드입니다. 이상 발생 시 서버가 자동 실행할 규칙을 playbooks에 제안하세요(restart-program / stop-program / start-program / repair-run / notify-only). 되돌리기 어려운 행동은 notify-only로 두세요."
      : "## 플레이북\n질문 모드입니다. playbooks는 전부 notify-only로만 제안하세요. 실제 행동은 매번 사람에게 묻습니다.",
    "## 출력 형식",
    "먼저 무엇을 왜 감시할지 한국어로 짧게 설명한 뒤, 반드시 마지막에 아래 블록을 정확히 한 번 출력하세요. 블록 밖에 JSON을 두지 마세요.",
    WORKSPACE_MONITORING_PLAN_OPEN_MARKER,
    JSON.stringify(
      {
        rationale: "한 문단",
        targets: [{ kind: "program", label: "표시 이름", programId: "등록된 programId" }],
        metrics: [{ targetIndex: 0, metric: "health", trend: "threshold", windowMin: 5, limit: 3 }],
        playbooks: [{ when: 0, action: "notify-only" }],
      },
      null,
      2,
    ),
    WORKSPACE_MONITORING_PLAN_CLOSE_MARKER,
    "targets 최대 16개, metrics 최대 32개, playbooks 최대 8개. process/url/log 대상은 실제로 폴더나 데이터 디렉터리에서 확인한 것만.",
    '## 로그 파일 감시\n프로그램이 쓰는 로그 파일(예: watcher.log)에서 오류·잠금·재시작·특정 판정 같은 줄을 잡고 싶으면 log 대상을 쓰세요: { "kind": "log", "label": "표시 이름", "path": "E:/data/app.log", "patterns": ["database is locked", "Traceback", "^!! "] } + metric { "metric": "log-matches", "trend": "threshold", "windowMin": 5, "limit": 1 }. 패턴은 JavaScript 정규식이며 대소문자를 구분합니다. 과거 내용은 보지 않고 계획 승인 이후에 새로 쓰인 줄만 봅니다.',
  ].join("\n\n");
}

export interface MonitoringFinding {
  /** `${targetIndex}|${metric}|${direction}` — the dedupe key. */
  readonly fingerprint: string;
  readonly targetLabel: string;
  readonly programId: string | null;
  readonly metric: WorkspaceMonitoringMetric;
  readonly observed: string;
  readonly observedAt: string;
}

export interface MonitoringFindingPromptInput {
  readonly projectTitle: string;
  readonly findings: ReadonlyArray<MonitoringFinding>;
  readonly executedPlaybooks: ReadonlyArray<string>;
  readonly autonomy: WorkspaceMonitoringSettings["autonomy"];
  readonly budget: MonitoringTurnBudget;
}

/** One turn per batch of anomalies; the AI diagnoses and, in ask mode, asks. */
export function buildMonitoringFindingPrompt(input: MonitoringFindingPromptInput): string {
  const findingLines = input.findings.map(
    (finding) =>
      `- ${finding.targetLabel}${finding.programId === null ? "" : ` (programId=${finding.programId})`} · ${finding.metric.metric}/${finding.metric.trend} (창 ${finding.metric.windowMin}분, 한도 ${finding.metric.limit}) · 관측: ${finding.observed} · ${finding.observedAt}`,
  );
  const playbookLines =
    input.executedPlaybooks.length === 0
      ? ["(없음)"]
      : input.executedPlaybooks.map((line) => `- ${line}`);
  return [
    "# 모니터링 이상 감지",
    `프로젝트: ${input.projectTitle}`,
    "## 감지된 이상",
    ...findingLines,
    "## 서버가 이미 실행한 플레이북",
    ...playbookLines,
    input.autonomy === "ask"
      ? "## 할 일\n읽기 전용으로 원인 후보·영향·권장 조치를 정리하세요. 재시작·중지·시작은 직접 실행하지 말고 필요한 조치를 제안하세요. 제안 행동 블록만으로 서버가 프로그램을 제어하지 않습니다. 로그·파일·상태 소스를 읽지 못했거나 접근에 실패했다면 '이상 없음'이나 '변경 없음'으로 추측하지 말고 반드시 `[UNREADABLE]`과 대상 경로·오류 사유를 명시하세요."
      : "## 할 일\n실행된 플레이북이 적절했는지 평가하고, 남은 위험과 필요한 조치를 제안하세요. 플레이북 밖의 제안 행동 블록만으로 서버가 프로그램을 제어하지 않습니다. 로그·파일·상태 소스를 읽지 못했거나 접근에 실패했다면 '이상 없음'이나 '변경 없음'으로 추측하지 말고 반드시 `[UNREADABLE]`과 대상 경로·오류 사유를 명시하세요.",
    [
      "## 제안 행동 블록",
      "프로그램 재시작·중지·시작을 제안할 때만 응답 맨 마지막에 정확히 한 번 출력하세요. 이 블록은 제안이며 서버가 블록만으로 프로그램을 제어하지 않습니다.",
      WORKSPACE_MONITORING_ACTION_OPEN_MARKER,
      JSON.stringify([{ action: "restart-program", programId: "감지된 이상의 programId" }]),
      WORKSPACE_MONITORING_ACTION_CLOSE_MARKER,
      "action은 restart-program / stop-program / start-program 중 하나. programId는 감시 계획에 있는 프로그램만.",
    ].join("\n"),
    `## 예산\n이번 시간 남은 자동 턴 ${input.budget.remainingHour}회, 오늘 ${input.budget.remainingDay}회. 불필요한 후속 턴을 만들지 마세요.`,
  ].join("\n\n");
}

/** A program action suggested by the monitoring AI. */
const RequestedAction = Schema.Struct({
  action: Schema.Literals(["restart-program", "stop-program", "start-program"]),
  programId: WorkspaceProgramId,
});
export type MonitoringRequestedAction = typeof RequestedAction.Type;
const decodeRequestedActions = Schema.decodeUnknownResult(
  Schema.Array(RequestedAction).check(Schema.isMaxLength(4)),
);

export interface ParsedMonitoringActions {
  readonly actions: ReadonlyArray<MonitoringRequestedAction>;
  /** Why a suggestion was not accepted — shown in the thread, never guessed around. */
  readonly rejected: string | null;
}

/**
 * Parse suggestions from the AI at the end of a finding turn. A suggestion is
 * not proof of a person's decision and does not itself execute a command.
 * Only programs named in the approved plan are accepted.
 */
export function parseMonitoringActions(
  output: string,
  plan: Pick<WorkspaceMonitoringPlan, "targets">,
): ParsedMonitoringActions {
  const open = output.lastIndexOf(WORKSPACE_MONITORING_ACTION_OPEN_MARKER);
  if (open === -1) return { actions: [], rejected: null };
  const bodyStart = open + WORKSPACE_MONITORING_ACTION_OPEN_MARKER.length;
  const close = output.indexOf(WORKSPACE_MONITORING_ACTION_CLOSE_MARKER, bodyStart);
  if (close === -1) return { actions: [], rejected: "행동 블록의 닫는 마커가 없습니다." };
  const raw = output
    .slice(bodyStart, close)
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (cause) {
    return { actions: [], rejected: `행동 블록 JSON 구문 오류: ${String(cause)}` };
  }
  const decoded = decodeRequestedActions(Array.isArray(json) ? json : [json]);
  if (Result.isFailure(decoded)) return { actions: [], rejected: String(decoded.failure) };
  const allowed = new Set(
    plan.targets.flatMap((target) => (target.programId === undefined ? [] : [target.programId])),
  );
  const actions = decoded.success.filter((entry) => allowed.has(entry.programId));
  const dropped = decoded.success.length - actions.length;
  return {
    actions,
    rejected:
      dropped === 0
        ? null
        : `감시 계획에 없는 프로그램을 향한 행동 ${dropped}건은 실행하지 않았습니다.`,
  };
}

/** Staleness hint posted once per stale transition, without spending the AI budget. */
export const MONITORING_STALE_NOTICE =
  "프로그램 구성이 바뀌어 승인된 감시 계획이 더 이상 현재 상태와 맞지 않을 수 있습니다. 기존 계획의 관찰은 계속하지만 자동 조치는 실행하지 않습니다. 제어센터에서 **다시 분석**을 누르면 새 계획을 제안합니다.";

export function findFirstMonitoredProjectId<T extends { readonly id: string }>(
  projects: ReadonlyArray<T & { readonly monitoringEnabled: boolean }>,
  preferred: string | null,
): Option.Option<T["id"]> {
  if (preferred !== null) {
    const match = projects.find((project) => project.id === preferred && project.monitoringEnabled);
    if (match !== undefined) return Option.some(match.id);
  }
  const first = projects.find((project) => project.monitoringEnabled);
  return first === undefined ? Option.none() : Option.some(first.id);
}
