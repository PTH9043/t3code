import type {
  OrchestrationThreadShell,
  ProjectId,
  WorkspaceCollaborationRun,
  WorkspaceIncident,
  WorkspaceMonitoringSettings,
  WorkspaceProgram,
  WorkspaceProgramRun,
  WorkspaceRuntimeEvidence,
  WorkspaceRuntimeAttention,
  WorkspaceRuntimeLifecycleStatus,
  WorkspaceRuntimeSnapshot,
  WorkspaceRuntimeStatus,
  WorkspaceSchedule,
} from "@t3tools/contracts";

import { runtimeMonitoringView } from "./workspaceMonitoring.ts";

const EVIDENCE_LIMIT = 50;
const STATUS_PRIORITY: Readonly<Record<WorkspaceRuntimeStatus, number>> = {
  failed: 0,
  blocked: 1,
  working: 2,
  done: 3,
  idle: 4,
  unknown: 5,
};

export interface WorkspaceRuntimeProjectionInput {
  readonly projectId: ProjectId;
  readonly projectUpdatedAt: string;
  readonly projectRuntimeViewedThrough: string | null;
  readonly threads: ReadonlyArray<OrchestrationThreadShell>;
  readonly programs: ReadonlyArray<WorkspaceProgram>;
  readonly programRuns: ReadonlyArray<WorkspaceProgramRun>;
  readonly incidents: ReadonlyArray<WorkspaceIncident>;
  readonly collaborationRuns: ReadonlyArray<WorkspaceCollaborationRun>;
  readonly schedules: ReadonlyArray<WorkspaceSchedule>;
  readonly monitoring: WorkspaceMonitoringSettings;
  /** Wall clock, for the monitoring budget window. */
  readonly now: string;
}

function bounded(value: string | null | undefined, maxLength: number): string | null {
  const normalized = value?.replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  return normalized.slice(0, maxLength);
}

function evidence(input: {
  readonly status: WorkspaceRuntimeStatus;
  readonly source: WorkspaceRuntimeEvidence["source"];
  readonly sourceId: string;
  readonly title: string;
  readonly detail?: string | null;
  readonly observedAt: string;
  readonly authority?: WorkspaceRuntimeEvidence["authority"];
}): WorkspaceRuntimeEvidence {
  const authority =
    input.authority ??
    (input.source === "thread"
      ? "provider"
      : input.source === "program"
        ? "program-supervisor"
        : input.source === "schedule"
          ? "scheduler"
          : "orchestration");
  return {
    status: input.status,
    authority,
    source: input.source,
    sourceId: input.sourceId.slice(0, 200),
    title: bounded(input.title, 200) ?? input.sourceId.slice(0, 200),
    detail: bounded(input.detail, 2_000),
    observedAt: input.observedAt,
  };
}

function lifecycleStatus(
  items: ReadonlyArray<WorkspaceRuntimeEvidence>,
): WorkspaceRuntimeLifecycleStatus {
  if (items.some((item) => item.status === "failed")) return "failed";
  if (items.some((item) => item.status === "working")) return "working";
  return "idle";
}

function latestCompletionAt(items: ReadonlyArray<WorkspaceRuntimeEvidence>): string | null {
  const completions = items.filter((item) => item.status === "done").map((item) => item.observedAt);
  return completions.length === 0 ? null : maxTimestamp(completions);
}

function projectAttention(input: {
  readonly items: ReadonlyArray<WorkspaceRuntimeEvidence>;
  readonly viewedThrough: string | null;
}): WorkspaceRuntimeAttention {
  if (input.items.some((item) => item.status === "failed")) return "error";
  if (input.items.some((item) => item.status === "blocked")) return "needs-input";
  if (
    input.items.some(
      (item) =>
        item.status === "done" &&
        (input.viewedThrough === null || item.observedAt > input.viewedThrough),
    )
  ) {
    return "completed-unseen";
  }
  return "none";
}

function maxTimestamp(values: ReadonlyArray<string>): string {
  return values.reduce((latest, value) => (value > latest ? value : latest));
}

function projectStatus(items: ReadonlyArray<WorkspaceRuntimeEvidence>): WorkspaceRuntimeStatus {
  if (items.some((item) => item.status === "failed")) return "failed";
  if (items.some((item) => item.status === "blocked")) return "blocked";
  if (items.some((item) => item.status === "working")) return "working";
  if (items.some((item) => item.status === "done")) return "done";
  return "idle";
}

export function deriveWorkspaceRuntimeSnapshot(
  input: WorkspaceRuntimeProjectionInput,
): WorkspaceRuntimeSnapshot {
  const items: WorkspaceRuntimeEvidence[] = [];
  let workingThreadCount = 0;
  let blockedThreadCount = 0;
  let failedThreadCount = 0;

  for (const thread of input.threads) {
    const turn = thread.latestTurn;
    const observedAt =
      turn?.completedAt ?? turn?.startedAt ?? turn?.requestedAt ?? thread.updatedAt;
    if (
      thread.hasPendingApprovals ||
      thread.hasPendingUserInput ||
      thread.hasActionableProposedPlan
    ) {
      blockedThreadCount += 1;
      items.push(
        evidence({
          status: "blocked",
          source: "thread",
          sourceId: thread.id,
          title: thread.title,
          detail: thread.hasPendingApprovals
            ? "도구 실행 승인이 필요합니다."
            : thread.hasPendingUserInput
              ? "사용자 입력이 필요합니다."
              : "제안된 계획의 확인이 필요합니다.",
          observedAt,
        }),
      );
      continue;
    }
    if (turn?.state === "error" || thread.session?.status === "error") {
      failedThreadCount += 1;
      items.push(
        evidence({
          status: "failed",
          source: "thread",
          sourceId: thread.id,
          title: thread.title,
          detail: thread.session?.lastError ?? "에이전트 턴이 오류로 종료되었습니다.",
          observedAt,
        }),
      );
      continue;
    }
    if (turn?.state === "interrupted") {
      failedThreadCount += 1;
      items.push(
        evidence({
          status: "failed",
          source: "thread",
          sourceId: thread.id,
          title: thread.title,
          detail: "에이전트 턴이 중단되었습니다.",
          observedAt,
        }),
      );
      continue;
    }
    if (
      turn?.state === "running" ||
      thread.session?.status === "starting" ||
      thread.session?.status === "running" ||
      thread.backgroundLiveness === "working"
    ) {
      workingThreadCount += 1;
      items.push(
        evidence({
          status: "working",
          source: "thread",
          sourceId: thread.id,
          title: thread.title,
          detail: thread.planProgress?.step ?? "에이전트가 작업을 진행하고 있습니다.",
          observedAt,
        }),
      );
      continue;
    }
    if (turn?.state === "completed") {
      items.push(
        evidence({
          status: "done",
          source: "thread",
          sourceId: thread.id,
          title: thread.title,
          detail: "최근 턴이 완료되었습니다.",
          observedAt,
        }),
      );
    }
  }

  const programNameById = new Map(input.programs.map((program) => [program.id, program.name]));
  const latestRunByProgram = new Map<string, WorkspaceProgramRun>();
  for (const run of input.programRuns) {
    const current = latestRunByProgram.get(run.programId);
    if (current === undefined || run.updatedAt > current.updatedAt) {
      latestRunByProgram.set(run.programId, run);
    }
  }

  let activeProgramCount = 0;
  let unhealthyProgramCount = 0;
  for (const run of latestRunByProgram.values()) {
    const title = programNameById.get(run.programId) ?? `프로그램 ${run.programId}`;
    if (run.status === "starting" || run.status === "running" || run.status === "stopping") {
      activeProgramCount += 1;
    }
    if (run.status === "failed" || run.healthStatus === "unhealthy") {
      unhealthyProgramCount += 1;
      items.push(
        evidence({
          status: "failed",
          source: "program",
          sourceId: run.programId,
          title,
          detail:
            run.status === "failed"
              ? `프로그램이 오류로 종료되었습니다${run.exitCode === null ? "." : ` (종료 코드 ${run.exitCode}).`}`
              : "상태검사에 응답하지 않습니다.",
          observedAt: run.updatedAt,
        }),
      );
      continue;
    }
    if (run.healthStatus === "degraded") {
      unhealthyProgramCount += 1;
      items.push(
        evidence({
          status: "blocked",
          source: "program",
          sourceId: run.programId,
          title,
          detail: "프로그램 상태가 불안정하여 확인이 필요합니다.",
          observedAt: run.updatedAt,
        }),
      );
      continue;
    }
    if (run.status === "starting" || run.status === "running" || run.status === "stopping") {
      items.push(
        evidence({
          status: "working",
          source: "program",
          sourceId: run.programId,
          title,
          detail:
            run.status === "starting"
              ? "프로그램을 시작하고 있습니다."
              : run.status === "stopping"
                ? "프로그램을 중지하고 있습니다."
                : run.healthStatus === "healthy"
                  ? "프로그램이 실행 중이며 상태검사를 통과했습니다."
                  : "프로그램이 실행 중입니다.",
          observedAt: run.updatedAt,
        }),
      );
    } else if (run.status === "exited") {
      items.push(
        evidence({
          status: "done",
          source: "program",
          sourceId: run.programId,
          title,
          detail: "프로그램 실행이 종료되었습니다.",
          observedAt: run.updatedAt,
        }),
      );
    }
  }

  const openIncidents = input.incidents.filter((incident) => incident.status !== "resolved");
  for (const incident of openIncidents) {
    const status =
      incident.status === "awaiting-user"
        ? "blocked"
        : incident.status === "diagnosing" ||
            incident.status === "repairing" ||
            incident.status === "verifying"
          ? "working"
          : "failed";
    items.push(
      evidence({
        status,
        source: "incident",
        sourceId: incident.id,
        title: incident.summary,
        detail:
          incident.status === "awaiting-user"
            ? (incident.diagnosis ?? "수정 지시가 필요합니다.")
            : `${incident.severity} · ${incident.kind} · ${incident.status}`,
        observedAt: incident.updatedAt,
      }),
    );
  }

  let activeCollaborationCount = 0;
  let failedCollaborationCount = 0;
  for (const run of input.collaborationRuns) {
    if (run.status === "queued" || run.status === "running" || run.status === "cancel-requested") {
      activeCollaborationCount += 1;
      items.push(
        evidence({
          status: "working",
          source: "collaboration",
          sourceId: run.id,
          title: run.task,
          detail:
            run.status === "queued"
              ? "작업 그래프 실행을 기다리고 있습니다."
              : run.status === "cancel-requested"
                ? "실행 취소를 처리하고 있습니다."
                : "여러 에이전트가 작업 그래프를 실행하고 있습니다.",
          observedAt: run.updatedAt,
        }),
      );
    } else if (run.status === "failed") {
      failedCollaborationCount += 1;
      items.push(
        evidence({
          status: "failed",
          source: "collaboration",
          sourceId: run.id,
          title: run.task,
          detail: run.error ?? "작업 그래프 실행이 실패했습니다.",
          observedAt: run.updatedAt,
        }),
      );
    } else if (run.status === "completed") {
      items.push(
        evidence({
          status: "done",
          source: "collaboration",
          sourceId: run.id,
          title: run.task,
          detail: "작업 그래프 실행이 완료되었습니다.",
          observedAt: run.updatedAt,
        }),
      );
    }
  }

  for (const schedule of input.schedules) {
    if (schedule.lastError === null) continue;
    items.push(
      evidence({
        status: "failed",
        source: "schedule",
        sourceId: schedule.id,
        title: schedule.title,
        detail: schedule.lastError,
        observedAt: schedule.updatedAt,
      }),
    );
  }

  const completedUnseenCount = items.filter(
    (item) =>
      item.status === "done" &&
      (input.projectRuntimeViewedThrough === null ||
        item.observedAt > input.projectRuntimeViewedThrough),
  ).length;
  const attentionCount =
    items.filter((item) => item.status === "blocked" || item.status === "failed").length +
    completedUnseenCount;
  const completionAt = latestCompletionAt(items);
  const operationTimestamps = [
    ...input.programs.map((program) => program.updatedAt),
    ...input.programRuns.map((run) => run.updatedAt),
    ...input.incidents.map((incident) => incident.updatedAt),
    ...input.collaborationRuns.map((run) => run.updatedAt),
    ...input.schedules.map((schedule) => schedule.updatedAt),
  ];
  items.sort(
    (left, right) =>
      STATUS_PRIORITY[left.status] - STATUS_PRIORITY[right.status] ||
      right.observedAt.localeCompare(left.observedAt) ||
      left.source.localeCompare(right.source) ||
      left.sourceId.localeCompare(right.sourceId),
  );

  return {
    projectId: input.projectId,
    status: projectStatus(items),
    lifecycleStatus: lifecycleStatus(items),
    attention: projectAttention({
      items,
      viewedThrough: input.projectRuntimeViewedThrough,
    }),
    counts: {
      threadCount: input.threads.length,
      workingThreadCount,
      blockedThreadCount,
      failedThreadCount,
      activeProgramCount,
      unhealthyProgramCount,
      openIncidentCount: openIncidents.length,
      activeCollaborationCount,
      failedCollaborationCount,
      enabledScheduleCount: input.schedules.filter((schedule) => schedule.enabled).length,
      attentionCount,
      completedUnseenCount,
    },
    evidence: items.slice(0, EVIDENCE_LIMIT),
    viewedThrough: input.projectRuntimeViewedThrough,
    latestCompletionAt: completionAt,
    operationsUpdatedAt:
      operationTimestamps.length === 0 ? null : maxTimestamp(operationTimestamps),
    monitoring: runtimeMonitoringView(input.monitoring, input.now),
    updatedAt: maxTimestamp([
      input.projectUpdatedAt,
      ...input.threads.map((thread) => thread.updatedAt),
      ...input.programs.map((program) => program.updatedAt),
      ...input.programRuns.map((run) => run.updatedAt),
      ...input.incidents.map((incident) => incident.updatedAt),
      ...input.collaborationRuns.map((run) => run.updatedAt),
      ...input.schedules.map((schedule) => schedule.updatedAt),
    ]),
  };
}
