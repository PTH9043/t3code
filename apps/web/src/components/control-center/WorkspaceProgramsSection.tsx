import { Link } from "@tanstack/react-router";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  WorkspaceProgramId,
  type WorkspaceIncident,
  type WorkspaceProgram,
  type WorkspaceProgramHealthCheck,
  type WorkspaceProgramRun,
} from "@t3tools/contracts";
import {
  ActivityIcon,
  AlertTriangleIcon,
  CheckCircle2Icon,
  ChevronRightIcon,
  CircleStopIcon,
  ExternalLinkIcon,
  FileWarningIcon,
  HistoryIcon,
  PlayIcon,
  PlusIcon,
  RefreshCcwIcon,
  RotateCwIcon,
  SearchIcon,
  ServerCogIcon,
  ShieldCheckIcon,
  Trash2Icon,
} from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";

import { cn, randomUUID } from "~/lib/utils";
import { useRecencyGroups } from "~/useRecencyGroups";
import { useEnvironmentSettings } from "~/hooks/useSettings";
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

const SELECT_CLASS =
  "h-9 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground outline-none transition-shadow focus:border-ring focus:ring-3 focus:ring-ring/20 dark:bg-input/32";
const DEFAULT_ERROR_PATTERN = "uncaught|unhandled|fatal|panic";

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

function runStatusLabel(status: WorkspaceProgramRun["status"] | "idle") {
  if (status === "starting") return "시작 중";
  if (status === "running") return "실행 중";
  if (status === "stopping") return "중지 중";
  if (status === "exited") return "중지됨";
  if (status === "failed") return "오류 종료";
  return "실행 기록 없음";
}

function runStatusVariant(status: WorkspaceProgramRun["status"] | "idle") {
  if (status === "running") return "success" as const;
  if (status === "failed") return "error" as const;
  if (status === "starting" || status === "stopping") return "warning" as const;
  return "outline" as const;
}

function incidentStatusLabel(status: WorkspaceIncident["status"]) {
  if (status === "open") return "새 오류";
  if (status === "diagnosing") return "AI 진단 중";
  if (status === "awaiting-user") return "수정 지시 대기";
  if (status === "repairing") return "수정 중";
  if (status === "verifying") return "재시작 검증 중";
  return "해결됨";
}

function incidentKindLabel(kind: WorkspaceIncident["kind"]) {
  if (kind === "spawn-failure") return "시작 실패";
  if (kind === "process-exit") return "비정상 종료";
  if (kind === "log-pattern") return "오류 로그 감지";
  return "상태검사 실패";
}

function candidateSourceLabel(source: string) {
  if (source === "project-script") return "프로젝트 실행 작업";
  if (source === "package-json") return "패키지 설정";
  if (source === "docker-compose") return "도커 구성";
  if (source === "python") return "파이썬 설정";
  if (source === "rust") return "러스트 설정";
  return "프로젝트 설정";
}

function integrityStatusLabel(status: WorkspaceProgram["integrity"]["status"]) {
  if (status === "queued") return "수렴 대기";
  if (status === "running") return "수렴 중";
  if (status === "stopping") return "중지 중";
  if (status === "stopped") return "수렴 중지됨";
  if (status === "converged") return "수렴 완료";
  if (status === "failed") return "수렴 실패";
  return "수렴 꺼짐";
}

function integrityStatusVariant(status: WorkspaceProgram["integrity"]["status"]) {
  if (status === "converged") return "success" as const;
  if (status === "failed") return "error" as const;
  if (status === "queued" || status === "running" || status === "stopping")
    return "warning" as const;
  return "outline" as const;
}

function integrityActive(integrity: WorkspaceProgram["integrity"]): boolean {
  return integrity.status === "queued" || integrity.status === "running";
}

function healthLabel(run: WorkspaceProgramRun | undefined) {
  if (!run) return "확인 전";
  if (run.healthStatus === "healthy") return "정상";
  if (run.healthStatus === "degraded") return "불안정";
  if (run.healthStatus === "unhealthy") return "응답 없음";
  return "확인 전";
}

export function WorkspaceProgramsSection({ project }: { project: EnvironmentProject }) {
  const programPermissions = useEnvironmentSettings(
    project.environmentId,
    (settings) => settings.workspaceProgramPermissions,
  );
  const programs = useEnvironmentQuery(
    orchestrationEnvironment.workspacePrograms({
      environmentId: project.environmentId,
      input: { projectId: project.id },
    }),
  );
  const candidates = useEnvironmentQuery(
    orchestrationEnvironment.workspaceProgramCandidates({
      environmentId: project.environmentId,
      input: { projectId: project.id },
    }),
  );
  const runs = useEnvironmentQuery(
    orchestrationEnvironment.workspaceProgramRuns({
      environmentId: project.environmentId,
      input: { projectId: project.id, limit: 25 },
    }),
  );
  const incidents = useEnvironmentQuery(
    orchestrationEnvironment.workspaceIncidents({
      environmentId: project.environmentId,
      input: { projectId: project.id, limit: 25 },
    }),
  );
  const runtime = useEnvironmentQuery(
    orchestrationEnvironment.workspaceRuntime({
      environmentId: project.environmentId,
      input: { projectId: project.id },
    }),
  );
  const lastOperationsRevisionRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    if (runtime.data === null) return;
    const revision = runtime.data.operationsUpdatedAt;
    if (lastOperationsRevisionRef.current === undefined) {
      lastOperationsRevisionRef.current = revision;
      return;
    }
    if (lastOperationsRevisionRef.current === revision) return;
    lastOperationsRevisionRef.current = revision;
    programs.refresh();
    runs.refresh();
    incidents.refresh();
  }, [incidents.refresh, programs.refresh, runs.refresh, runtime.data]);

  const upsertProgram = useAtomCommand(projectEnvironment.upsertWorkspaceProgram, {
    label: "프로젝트 프로그램 저장",
    reportFailure: false,
  });
  const removeProgram = useAtomCommand(projectEnvironment.removeWorkspaceProgram, {
    label: "프로젝트 프로그램 삭제",
    reportFailure: false,
  });
  const startProgram = useAtomCommand(projectEnvironment.startWorkspaceProgram, {
    label: "프로젝트 프로그램 시작",
    reportFailure: false,
  });
  const stopProgram = useAtomCommand(projectEnvironment.stopWorkspaceProgram, {
    label: "프로젝트 프로그램 중지",
    reportFailure: false,
  });
  const restartProgram = useAtomCommand(projectEnvironment.restartWorkspaceProgram, {
    label: "프로젝트 프로그램 재시작",
    reportFailure: false,
  });
  const startIntegrity = useAtomCommand(projectEnvironment.startWorkspaceProgramIntegrity, {
    label: "무결성 수렴 시작",
    reportFailure: false,
  });
  const stopIntegrity = useAtomCommand(projectEnvironment.stopWorkspaceProgramIntegrity, {
    label: "무결성 수렴 중지",
    reportFailure: false,
  });
  const repairIncident = useAtomCommand(projectEnvironment.requestWorkspaceIncidentRepair, {
    label: "오류 수정 요청",
    reportFailure: false,
  });
  const resolveIncident = useAtomCommand(projectEnvironment.resolveWorkspaceIncident, {
    label: "오류 해결 처리",
    reportFailure: false,
  });

  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [relativeDirectory, setRelativeDirectory] = useState("");
  const [autoStart, setAutoStart] = useState(false);
  const [healthKind, setHealthKind] = useState<"none" | "http" | "tcp">("none");
  const [healthTarget, setHealthTarget] = useState("");
  const [errorPattern, setErrorPattern] = useState(DEFAULT_ERROR_PATTERN);
  const [environmentVariableNames, setEnvironmentVariableNames] = useState("");
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [repairInstructions, setRepairInstructions] = useState<Record<string, string>>({});
  const [integrityDrafts, setIntegrityDrafts] = useState<Record<string, string>>({});
  const [integrityEnabled, setIntegrityEnabled] = useState(false);
  const [integrityValidationCommands, setIntegrityValidationCommands] = useState("");
  const [integrityRequiredCleanPasses, setIntegrityRequiredCleanPasses] = useState(2);

  const latestRunByProgram = useMemo(() => {
    const result = new Map<string, WorkspaceProgramRun>();
    for (const run of runs.data?.runs ?? []) {
      if (!result.has(run.programId)) result.set(run.programId, run);
    }
    return result;
  }, [runs.data?.runs]);
  const registeredCommands = useMemo(
    () => new Set((programs.data?.programs ?? []).map((program) => program.command.trim())),
    [programs.data?.programs],
  );
  const registeredIds = useMemo(
    () => new Set((programs.data?.programs ?? []).map((program) => program.id)),
    [programs.data?.programs],
  );
  const programNameById = useMemo(
    () => new Map((programs.data?.programs ?? []).map((program) => [program.id, program.name])),
    [programs.data?.programs],
  );
  // Runs accumulate for as long as the environment lives, so the table folds by
  // day and only keeps the recent ones open.
  const runList = useMemo(() => runs.data?.runs ?? [], [runs.data?.runs]);
  const runGroups = useRecencyGroups(runList, (run: WorkspaceProgramRun) => run.startedAt);

  const refreshAll = () => {
    programs.refresh();
    runs.refresh();
    incidents.refresh();
  };

  const healthCheck = (): WorkspaceProgramHealthCheck | null => {
    if (healthKind === "http") {
      if (!healthTarget.trim()) return null;
      try {
        const url = new URL(healthTarget.trim());
        if (url.protocol !== "http:" && url.protocol !== "https:") return null;
      } catch {
        return null;
      }
      return {
        kind: "http",
        url: healthTarget.trim(),
        expectedStatusMin: 200,
        expectedStatusMax: 399,
        intervalSeconds: 30,
        timeoutSeconds: 5,
        failureThreshold: 3,
      };
    }
    if (healthKind === "tcp") {
      const [host, rawPort] = healthTarget.trim().split(":");
      const port = Number(rawPort);
      if (!host || !Number.isInteger(port) || port < 1 || port > 65_535) return null;
      return {
        kind: "tcp",
        host,
        port,
        intervalSeconds: 30,
        timeoutSeconds: 5,
        failureThreshold: 3,
      };
    }
    return null;
  };

  const saveProgram = async (input: {
    id: WorkspaceProgramId;
    name: string;
    command: string;
    relativeDirectory: string;
    startPolicy?: WorkspaceProgram["startPolicy"];
    healthCheck?: WorkspaceProgramHealthCheck | null;
    errorPatterns?: string[];
    environmentVariableNames?: string[];
    integrityEnabled?: boolean;
    integrityValidationCommands?: string[];
    integrityRequiredCleanPasses?: number;
  }) => {
    setBusyKey(`save:${input.id}`);
    try {
      const result = await upsertProgram({
        environmentId: project.environmentId,
        input: {
          projectId: project.id,
          programId: input.id,
          name: input.name,
          command: input.command,
          relativeDirectory: input.relativeDirectory,
          environmentVariableNames: input.environmentVariableNames ?? [],
          startPolicy: input.startPolicy ?? "manual",
          healthCheck: input.healthCheck ?? null,
          errorPatterns: input.errorPatterns ?? [DEFAULT_ERROR_PATTERN],
          enabled: true,
          integrityEnabled: input.integrityEnabled ?? false,
          integrityValidationCommands: input.integrityValidationCommands ?? [],
          integrityRequiredCleanPasses: input.integrityRequiredCleanPasses ?? 2,
        },
      });
      if (!notifyFailure(result, "프로그램을 저장하지 못했습니다")) {
        toastManager.add({ type: "success", title: `${input.name} 프로그램을 등록했습니다.` });
        refreshAll();
        return true;
      }
      return false;
    } finally {
      setBusyKey(null);
    }
  };

  const submitManual = async () => {
    const trimmedName = name.trim();
    const trimmedCommand = command.trim();
    if (!trimmedName || !trimmedCommand) return;
    if (healthKind !== "none" && healthCheck() === null) {
      toastManager.add({ type: "warning", title: "상태검사 주소를 확인하세요." });
      return;
    }
    const selectedEnvironmentVariableNames = [
      ...new Set(
        environmentVariableNames
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean),
      ),
    ];
    if (selectedEnvironmentVariableNames.some((value) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value))) {
      toastManager.add({
        type: "warning",
        title: "환경 변수 이름을 확인하세요.",
        description: "영문자 또는 밑줄로 시작하고 영문자, 숫자, 밑줄만 사용할 수 있습니다.",
      });
      return;
    }
    const selectedValidationCommands = integrityValidationCommands
      .split("\n")
      .map((value) => value.trim())
      .filter(Boolean);
    const saved = await saveProgram({
      id: WorkspaceProgramId.make(
        `${
          trimmedName
            .toLowerCase()
            .replace(/[^a-z0-9._-]+/g, "-")
            .replace(/^-+|-+$/g, "") || "program"
        }-${randomUUID().slice(0, 8)}`,
      ),
      name: trimmedName,
      command: trimmedCommand,
      relativeDirectory: relativeDirectory.trim(),
      startPolicy: autoStart ? "server-start" : "manual",
      healthCheck: healthCheck(),
      errorPatterns: errorPattern.trim() ? [errorPattern.trim()] : [],
      environmentVariableNames: selectedEnvironmentVariableNames,
      integrityEnabled,
      integrityValidationCommands: selectedValidationCommands,
      integrityRequiredCleanPasses,
    });
    if (!saved) return;
    setName("");
    setCommand("");
    setRelativeDirectory("");
    setEnvironmentVariableNames("");
    setIntegrityValidationCommands("");
  };

  const runAction = async (
    program: WorkspaceProgram,
    action: "start" | "stop" | "restart" | "remove",
  ) => {
    setBusyKey(`${action}:${program.id}`);
    try {
      const request =
        action === "start"
          ? startProgram
          : action === "stop"
            ? stopProgram
            : action === "restart"
              ? restartProgram
              : removeProgram;
      const result = await request({
        environmentId: project.environmentId,
        input: { projectId: project.id, programId: program.id },
      });
      if (!notifyFailure(result, `${program.name} 작업을 처리하지 못했습니다`)) refreshAll();
    } finally {
      setBusyKey(null);
    }
  };

  /**
   * Re-upserts a program with new integrity settings, carrying every other field over
   * unchanged. The server rebuilds integrity state from the command on every upsert, so
   * enabling here queues a convergence cycle and disabling stops the running one.
   */
  const saveIntegrity = async (
    program: WorkspaceProgram,
    integrity: {
      enabled: boolean;
      validationCommands?: ReadonlyArray<string>;
      requiredCleanPasses?: number;
    },
  ) => {
    setBusyKey(`integrity-save:${program.id}`);
    try {
      const result = await upsertProgram({
        environmentId: project.environmentId,
        input: {
          projectId: project.id,
          programId: program.id,
          name: program.name,
          command: program.command,
          relativeDirectory: program.relativeDirectory,
          environmentVariableNames: [...program.environmentVariableNames],
          startPolicy: program.startPolicy,
          healthCheck: program.healthCheck,
          errorPatterns: [...program.errorPatterns],
          enabled: program.enabled,
          integrityEnabled: integrity.enabled,
          integrityValidationCommands: [
            ...(integrity.validationCommands ?? program.integrity.validationCommands),
          ],
          integrityRequiredCleanPasses:
            integrity.requiredCleanPasses ?? program.integrity.requiredCleanPasses,
        },
      });
      if (!notifyFailure(result, `${program.name} 무결성 설정을 저장하지 못했습니다`)) {
        toastManager.add({
          type: "success",
          title: integrity.enabled
            ? `${program.name} 무결성 수렴을 켰습니다.`
            : `${program.name} 무결성 수렴을 껐습니다.`,
        });
        refreshAll();
      }
    } finally {
      setBusyKey(null);
    }
  };

  const runIntegrityAction = async (program: WorkspaceProgram, action: "start" | "stop") => {
    setBusyKey(`integrity-${action}:${program.id}`);
    try {
      const request = action === "start" ? startIntegrity : stopIntegrity;
      const result = await request({
        environmentId: project.environmentId,
        input: { projectId: project.id, programId: program.id },
      });
      if (!notifyFailure(result, `${program.name} 무결성 수렴을 처리하지 못했습니다`)) {
        toastManager.add({
          type: "success",
          title:
            action === "start"
              ? `${program.name} 무결성 수렴을 시작했습니다.`
              : `${program.name} 무결성 수렴을 중지했습니다.`,
        });
        refreshAll();
      }
    } finally {
      setBusyKey(null);
    }
  };

  const requestRepair = async (incident: WorkspaceIncident) => {
    const instruction =
      repairInstructions[incident.id]?.trim() ||
      "자동 진단과 수집된 증거를 바탕으로 원인을 수정하고 관련 검증을 수행해 주세요.";
    setBusyKey(`repair:${incident.id}`);
    try {
      const result = await repairIncident({
        environmentId: project.environmentId,
        input: { projectId: project.id, incidentId: incident.id, instruction },
      });
      if (!notifyFailure(result, "오류 수정 작업을 시작하지 못했습니다")) {
        toastManager.add({ type: "success", title: "수정·검증 협업을 시작했습니다." });
        incidents.refresh();
      }
    } finally {
      setBusyKey(null);
    }
  };

  const markResolved = async (incident: WorkspaceIncident) => {
    const result = await resolveIncident({
      environmentId: project.environmentId,
      input: { projectId: project.id, incidentId: incident.id },
    });
    if (!notifyFailure(result, "오류 보고를 해결 처리하지 못했습니다")) incidents.refresh();
  };

  return (
    <div className="grid gap-5">
      <Card>
        <CardHeader>
          <div className="mb-1 flex items-center gap-2 text-primary">
            <ServerCogIcon className="size-4" />
            <span className="text-xs font-semibold uppercase tracking-wide">프로젝트 운영</span>
          </div>
          <CardTitle>주요 프로그램</CardTitle>
          <CardDescription>
            이 제어센터가 직접 시작한 프로그램만 추적합니다. 다른 터미널이나 외부 PID는 중지하지
            않습니다.
          </CardDescription>
          <CardAction>
            <Button size="xs" variant="ghost" onClick={refreshAll}>
              <RefreshCcwIcon /> 새로고침
            </Button>
          </CardAction>
        </CardHeader>
        <CardPanel className="grid gap-4">
          {!programPermissions.manualControl ? (
            <div className="rounded-xl border border-amber-500/25 bg-amber-500/8 px-4 py-3 text-sm text-amber-800 dark:text-amber-200">
              권한 탭에서 프로그램 수동 제어가 꺼져 있어 시작·중지·재시작 버튼을 사용할 수 없습니다.
            </div>
          ) : null}
          {(programs.data?.programs ?? []).map((program) => {
            const run = latestRunByProgram.get(program.id);
            // `stopping` keeps the stop control: a program that outlives the stop
            // escalation stays tracked, so offering start here would be a button that
            // silently does nothing.
            const running =
              run?.status === "running" || run?.status === "starting" || run?.status === "stopping";
            return (
              <article
                key={program.id}
                className="rounded-xl border border-border/70 bg-card/55 p-4"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h4 className="font-semibold">{program.name}</h4>
                      <Badge variant={runStatusVariant(run?.status ?? "idle")}>
                        {runStatusLabel(run?.status ?? "idle")}
                      </Badge>
                      <Badge variant="outline">상태 {healthLabel(run)}</Badge>
                      {program.startPolicy === "server-start" ? (
                        <Badge variant={programPermissions.autoStart ? "info" : "warning"}>
                          {programPermissions.autoStart
                            ? "서버 시작 시 자동 실행"
                            : "자동 실행 권한 꺼짐"}
                        </Badge>
                      ) : null}
                      {program.integrity.enabled ? (
                        <Badge variant={integrityStatusVariant(program.integrity.status)}>
                          무결성 {integrityStatusLabel(program.integrity.status)}
                        </Badge>
                      ) : null}
                    </div>
                    <p className="mt-2 break-all font-mono text-xs text-muted-foreground">
                      {program.command}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      PID {run?.pid ?? "-"} · 시작 {timestamp(run?.startedAt ?? null)} · 상태검사{" "}
                      {timestamp(run?.lastHealthCheckAt ?? null)}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {running ? (
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={busyKey !== null || !programPermissions.manualControl}
                        onClick={() => void runAction(program, "stop")}
                      >
                        <CircleStopIcon /> 중지
                      </Button>
                    ) : (
                      <Button
                        size="xs"
                        disabled={busyKey !== null || !programPermissions.manualControl}
                        onClick={() => void runAction(program, "start")}
                      >
                        <PlayIcon /> 시작
                      </Button>
                    )}
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={busyKey !== null || !programPermissions.manualControl}
                      onClick={() => void runAction(program, "restart")}
                    >
                      <RotateCwIcon /> 재시작
                    </Button>
                    {program.integrity.enabled ? (
                      integrityActive(program.integrity) ? (
                        <Button
                          size="xs"
                          variant="outline"
                          disabled={busyKey !== null || !programPermissions.manualControl}
                          onClick={() => void runIntegrityAction(program, "stop")}
                        >
                          <CircleStopIcon /> 수렴 중지
                        </Button>
                      ) : (
                        <Button
                          size="xs"
                          variant="outline"
                          disabled={busyKey !== null || !programPermissions.manualControl}
                          onClick={() => void runIntegrityAction(program, "start")}
                        >
                          <ShieldCheckIcon /> 무결성 수렴 시작
                        </Button>
                      )
                    ) : null}
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={busyKey !== null}
                      onClick={() => {
                        if (window.confirm(`${program.name} 프로그램과 실행 기록을 삭제할까요?`)) {
                          void runAction(program, "remove");
                        }
                      }}
                    >
                      <Trash2Icon /> 삭제
                    </Button>
                  </div>
                </div>
                <div className="mt-3 grid gap-2 rounded-lg border border-border/60 bg-background/55 px-3 py-2">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <p className="text-xs font-medium">AI 무결성 수렴</p>
                      <p className="text-xs text-muted-foreground">
                        {program.integrity.enabled
                          ? `주기 ${program.integrity.cycle} · 연속 통과 ${program.integrity.consecutiveCleanPasses}/${program.integrity.requiredCleanPasses} · 검증 명령 ${program.integrity.validationCommands.length}개 · 갱신 ${timestamp(program.integrity.updatedAt)}`
                          : "점검·수정·독립 검증을 서로 다른 CLI 계정에 나눠 반복합니다."}
                      </p>
                    </div>
                    <Switch
                      checked={program.integrity.enabled}
                      disabled={busyKey !== null || !programPermissions.manualControl}
                      onCheckedChange={(checked) =>
                        void saveIntegrity(program, { enabled: checked })
                      }
                      aria-label={`${program.name} AI 무결성 수렴`}
                    />
                  </div>
                  {program.integrity.summary ? (
                    <p className="text-xs text-muted-foreground">{program.integrity.summary}</p>
                  ) : null}
                  {program.integrity.enabled ? (
                    <details className="rounded-lg border border-border/60 p-2">
                      <summary className="cursor-pointer text-xs font-medium">
                        검증 명령 설정
                      </summary>
                      <div className="mt-2 grid gap-2">
                        <Textarea
                          value={
                            integrityDrafts[program.id] ??
                            program.integrity.validationCommands.join("\n")
                          }
                          onChange={(event) =>
                            setIntegrityDrafts((current) => ({
                              ...current,
                              [program.id]: event.currentTarget.value,
                            }))
                          }
                          placeholder={"한 줄에 하나씩 입력하세요.\nvp test run src/foo\nvp lint"}
                        />
                        <label className="grid gap-1 text-xs text-muted-foreground">
                          수렴 판정에 필요한 연속 통과 횟수
                          <select
                            className={SELECT_CLASS}
                            value={String(program.integrity.requiredCleanPasses)}
                            disabled={busyKey !== null || !programPermissions.manualControl}
                            onChange={(event) =>
                              void saveIntegrity(program, {
                                enabled: true,
                                requiredCleanPasses: Number(event.currentTarget.value),
                              })
                            }
                          >
                            {[1, 2, 3, 4, 5].map((value) => (
                              <option key={value} value={value}>
                                {value}회
                              </option>
                            ))}
                          </select>
                        </label>
                        <Button
                          size="xs"
                          variant="outline"
                          disabled={busyKey !== null || !programPermissions.manualControl}
                          onClick={() => {
                            const draft =
                              integrityDrafts[program.id] ??
                              program.integrity.validationCommands.join("\n");
                            setIntegrityDrafts((current) => {
                              const { [program.id]: _dropped, ...rest } = current;
                              return rest;
                            });
                            void saveIntegrity(program, {
                              enabled: true,
                              validationCommands: draft
                                .split("\n")
                                .map((value) => value.trim())
                                .filter(Boolean),
                            });
                          }}
                        >
                          검증 명령 저장
                        </Button>
                      </div>
                    </details>
                  ) : null}
                </div>
                {run?.recentLogTail ? (
                  <details className="mt-3 rounded-lg border border-border/60 bg-background/55 p-3">
                    <summary className="cursor-pointer text-xs font-medium">최근 로그</summary>
                    <pre className="mt-3 max-h-56 overflow-auto whitespace-pre-wrap break-words text-[11px] text-muted-foreground">
                      {run.recentLogTail}
                    </pre>
                  </details>
                ) : null}
              </article>
            );
          })}
          {programs.data?.programs.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
              등록된 프로그램이 없습니다. 아래 후보를 확인하거나 직접 등록하세요.
            </div>
          ) : null}
          {programs.error ? <p className="text-sm text-destructive">{programs.error}</p> : null}
        </CardPanel>
      </Card>

      <Card>
        <CardHeader>
          <div className="mb-1 flex items-center gap-2 text-primary">
            <SearchIcon className="size-4" />
            <span className="text-xs font-semibold uppercase tracking-wide">확인 후 등록</span>
          </div>
          <CardTitle>자동 발견 후보</CardTitle>
          <CardDescription>
            프로젝트 설정을 읽어 실행 후보만 제안합니다. 확인 버튼을 누르기 전에는 등록하거나
            실행하지 않습니다.
          </CardDescription>
          <CardAction>
            <Button size="xs" variant="ghost" onClick={candidates.refresh}>
              <RefreshCcwIcon /> 다시 찾기
            </Button>
          </CardAction>
        </CardHeader>
        <CardPanel className="grid gap-3 md:grid-cols-2">
          {(candidates.data?.candidates ?? []).map((candidate) => {
            const registered = registeredCommands.has(candidate.command.trim());
            return (
              <article
                key={`${candidate.source}:${candidate.id}`}
                className="rounded-xl border border-border/70 p-4"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h4 className="text-sm font-semibold">{candidate.name}</h4>
                    <p className="mt-1 text-xs text-muted-foreground">{candidate.reason}</p>
                  </div>
                  <Badge variant="outline">{candidateSourceLabel(candidate.source)}</Badge>
                </div>
                <p className="mt-3 break-all rounded-lg bg-muted/35 p-2 font-mono text-xs">
                  {candidate.command}
                </p>
                <Button
                  className="mt-3 w-full"
                  size="sm"
                  variant={registered ? "outline" : "default"}
                  disabled={registered || busyKey !== null}
                  onClick={() =>
                    void saveProgram({
                      id: registeredIds.has(candidate.id)
                        ? WorkspaceProgramId.make(`${candidate.id}-${randomUUID().slice(0, 8)}`)
                        : candidate.id,
                      name: candidate.name,
                      command: candidate.command,
                      relativeDirectory: candidate.relativeDirectory,
                    })
                  }
                >
                  {registered ? <CheckCircle2Icon /> : <PlusIcon />}
                  {registered ? "등록됨" : "확인하고 등록"}
                </Button>
              </article>
            );
          })}
          {candidates.data?.candidates.length === 0 ? (
            <p className="text-sm text-muted-foreground">자동으로 찾은 후보가 없습니다.</p>
          ) : null}
        </CardPanel>
      </Card>

      <Card>
        <CardHeader>
          <div className="mb-1 flex items-center gap-2 text-primary">
            <PlusIcon className="size-4" />
            <span className="text-xs font-semibold uppercase tracking-wide">직접 등록</span>
          </div>
          <CardTitle>프로그램 설정</CardTitle>
          <CardDescription>
            작업 폴더는 프로젝트 내부 상대 경로만 허용됩니다. 상태검사는 30초 간격·5초 제한·3회 연속
            실패로 시작합니다.
          </CardDescription>
        </CardHeader>
        <CardPanel className="grid gap-4">
          <div className="grid gap-3 md:grid-cols-2">
            <Input
              value={name}
              onChange={(event) => setName(event.currentTarget.value)}
              placeholder="프로그램 이름"
            />
            <Input
              value={relativeDirectory}
              onChange={(event) => setRelativeDirectory(event.currentTarget.value)}
              placeholder="상대 작업 폴더 (기본: 프로젝트 루트)"
            />
          </div>
          <Input
            value={command}
            onChange={(event) => setCommand(event.currentTarget.value)}
            placeholder="실행 명령"
          />
          <div className="grid gap-3 md:grid-cols-[180px_1fr]">
            <select
              className={SELECT_CLASS}
              value={healthKind}
              onChange={(event) => setHealthKind(event.currentTarget.value as typeof healthKind)}
            >
              <option value="none">상태검사 없음</option>
              <option value="http">HTTP 상태검사</option>
              <option value="tcp">TCP 상태검사</option>
            </select>
            <Input
              value={healthTarget}
              onChange={(event) => setHealthTarget(event.currentTarget.value)}
              disabled={healthKind === "none"}
              placeholder={healthKind === "tcp" ? "127.0.0.1:3000" : "http://127.0.0.1:3000/health"}
            />
          </div>
          <Input
            value={errorPattern}
            onChange={(event) => setErrorPattern(event.currentTarget.value)}
            placeholder="오류 로그 정규식"
          />
          <Input
            value={environmentVariableNames}
            onChange={(event) => setEnvironmentVariableNames(event.currentTarget.value)}
            placeholder="전달할 환경 변수 이름 (쉼표로 구분, 값은 저장하지 않음)"
          />
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border/65 px-4 py-3">
            <div>
              <p className="text-sm font-medium">T3 서버 시작 시 자동 실행</p>
              <p className="text-xs text-muted-foreground">
                {programPermissions.autoStart
                  ? "현재 자동 시작 권한이 허용되어 있습니다."
                  : "권한 탭의 자동 시작 허용도 함께 켜져 있어야 합니다."}
              </p>
            </div>
            <Switch
              checked={autoStart}
              onCheckedChange={setAutoStart}
              aria-label="서버 시작 시 자동 실행"
            />
          </div>
          <div className="grid gap-3 rounded-xl border border-border/65 px-4 py-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium">AI 무결성 수렴</p>
                <p className="text-xs text-muted-foreground">
                  점검·수정·독립 검증을 서로 다른 CLI 계정에 나눠 반복합니다. 프로젝트에 역할이 두
                  개 이상 연결되어 있어야 합니다.
                </p>
              </div>
              <Switch
                checked={integrityEnabled}
                onCheckedChange={setIntegrityEnabled}
                aria-label="AI 무결성 수렴"
              />
            </div>
            {integrityEnabled ? (
              <>
                <Textarea
                  value={integrityValidationCommands}
                  onChange={(event) => setIntegrityValidationCommands(event.currentTarget.value)}
                  placeholder={
                    "필수 검증 명령을 한 줄에 하나씩 입력하세요.\nvp test run src/foo\nvp lint"
                  }
                />
                <label className="grid gap-1 text-xs text-muted-foreground">
                  수렴 판정에 필요한 연속 통과 횟수
                  <select
                    className={SELECT_CLASS}
                    value={String(integrityRequiredCleanPasses)}
                    onChange={(event) =>
                      setIntegrityRequiredCleanPasses(Number(event.currentTarget.value))
                    }
                  >
                    {[1, 2, 3, 4, 5].map((value) => (
                      <option key={value} value={value}>
                        {value}회
                      </option>
                    ))}
                  </select>
                </label>
              </>
            ) : null}
          </div>
          <Button
            disabled={!name.trim() || !command.trim() || busyKey !== null}
            onClick={() => void submitManual()}
          >
            <PlusIcon /> 프로그램 등록
          </Button>
        </CardPanel>
      </Card>

      <Card>
        <CardHeader>
          <div className="mb-1 flex items-center gap-2 text-destructive">
            <FileWarningIcon className="size-4" />
            <span className="text-xs font-semibold uppercase tracking-wide">자동 오류 보고</span>
          </div>
          <CardTitle>장애와 AI 진단</CardTitle>
          <CardDescription>
            비정상 종료·승인된 로그 패턴·상태검사 실패를 묶어 보관합니다. AI는 진단까지만 자동으로
            수행하며 수정은 사용자의 명시적 지시 후 시작합니다.
          </CardDescription>
          <CardAction>
            <Badge variant="warning">
              미해결{" "}
              {
                (incidents.data?.incidents ?? []).filter((item) => item.status !== "resolved")
                  .length
              }
            </Badge>
          </CardAction>
        </CardHeader>
        <CardPanel className="grid gap-4">
          {(incidents.data?.incidents ?? []).map((incident) => (
            <article
              key={incident.id}
              className={`rounded-xl border p-4 ${
                incident.status === "resolved"
                  ? "border-border/60 bg-muted/15"
                  : "border-amber-500/25 bg-amber-500/5"
              }`}
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <AlertTriangleIcon className="size-4 text-amber-400" />
                    <h4 className="font-semibold">{incident.summary}</h4>
                    <Badge variant={incident.status === "resolved" ? "success" : "warning"}>
                      {incidentStatusLabel(incident.status)}
                    </Badge>
                    <Badge variant="outline">{incident.occurrenceCount}회</Badge>
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">
                    최초 {timestamp(incident.firstOccurredAt)} · 최근{" "}
                    {timestamp(incident.lastOccurredAt)} · {incidentKindLabel(incident.kind)}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  {incident.diagnosisThreadId ? (
                    <Button
                      size="xs"
                      variant="outline"
                      render={
                        <Link
                          to="/$environmentId/$threadId"
                          params={{
                            environmentId: project.environmentId,
                            threadId: incident.diagnosisThreadId,
                          }}
                        />
                      }
                    >
                      <ExternalLinkIcon /> 진단 대화 열기
                    </Button>
                  ) : null}
                  {incident.status !== "resolved" ? (
                    <Button size="xs" variant="ghost" onClick={() => void markResolved(incident)}>
                      <CheckCircle2Icon /> 해결 처리
                    </Button>
                  ) : null}
                </div>
              </div>
              {incident.diagnosis ? (
                <div className="mt-3 rounded-lg border border-border/60 bg-background/55 p-3">
                  <p className="text-xs font-semibold text-primary">AI 진단</p>
                  <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed">
                    {incident.diagnosis}
                  </p>
                </div>
              ) : null}
              <details className="mt-3 rounded-lg border border-border/60 p-3">
                <summary className="cursor-pointer text-xs font-medium">수집된 증거</summary>
                <pre className="mt-3 max-h-56 overflow-auto whitespace-pre-wrap break-words text-[11px] text-muted-foreground">
                  {incident.evidence}
                </pre>
              </details>
              {incident.status === "awaiting-user" ? (
                <div className="mt-3 grid gap-2">
                  <Textarea
                    value={repairInstructions[incident.id] ?? ""}
                    onChange={(event) =>
                      setRepairInstructions((current) => ({
                        ...current,
                        [incident.id]: event.currentTarget.value,
                      }))
                    }
                    placeholder="수정 지시를 입력하세요. 비워 두면 자동 진단을 바탕으로 수정·검증합니다."
                  />
                  <Button disabled={busyKey !== null} onClick={() => void requestRepair(incident)}>
                    <ActivityIcon /> 수정·검증 시작
                  </Button>
                </div>
              ) : null}
            </article>
          ))}
          {incidents.data?.incidents.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
              보고된 오류가 없습니다.
            </div>
          ) : null}
        </CardPanel>
      </Card>

      <Card>
        <CardHeader>
          <div className="mb-1 flex items-center gap-2 text-primary">
            <HistoryIcon className="size-4" />
            <span className="text-xs font-semibold uppercase tracking-wide">영구 실행 기록</span>
          </div>
          <CardTitle>최근 실행</CardTitle>
          <CardDescription>
            서버 재접속 후에도 프로그램별 시작·종료·상태검사 결과가 유지됩니다.
          </CardDescription>
        </CardHeader>
        <CardPanel className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-xs">
            <thead className="text-muted-foreground">
              <tr className="border-b border-border/70">
                <th className="px-2 py-2 font-medium">프로그램</th>
                <th className="px-2 py-2 font-medium">상태</th>
                <th className="px-2 py-2 font-medium">PID</th>
                <th className="px-2 py-2 font-medium">시작</th>
                <th className="px-2 py-2 font-medium">종료</th>
                <th className="px-2 py-2 font-medium">종료 코드</th>
              </tr>
            </thead>
            <tbody>
              {runGroups.groups.map((group) => {
                const expanded = runGroups.isExpanded(group.key);
                return (
                  <Fragment key={group.key}>
                    <tr className="border-b border-border/45">
                      <th colSpan={6} className="p-0 text-left font-normal">
                        <button
                          type="button"
                          onClick={() => runGroups.toggle(group.key)}
                          aria-expanded={expanded}
                          className="flex w-full items-center gap-1.5 px-2 py-1.5 text-muted-foreground hover:text-foreground"
                        >
                          <ChevronRightIcon
                            className={cn("size-3.5 shrink-0", expanded && "rotate-90")}
                          />
                          <span className="font-medium">{group.label}</span>
                          <span className="text-[11px]">({group.items.length}개)</span>
                        </button>
                      </th>
                    </tr>
                    {expanded
                      ? group.items.map((run) => (
                          <tr key={run.id} className="border-b border-border/45">
                            <td className="px-2 py-2">
                              {programNameById.get(run.programId) ?? run.programId}
                            </td>
                            <td className="px-2 py-2">{runStatusLabel(run.status)}</td>
                            <td className="px-2 py-2">{run.pid ?? "-"}</td>
                            <td className="px-2 py-2">{timestamp(run.startedAt)}</td>
                            <td className="px-2 py-2">{timestamp(run.stoppedAt)}</td>
                            <td className="px-2 py-2">{run.exitCode ?? "-"}</td>
                          </tr>
                        ))
                      : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </CardPanel>
      </Card>
    </div>
  );
}
