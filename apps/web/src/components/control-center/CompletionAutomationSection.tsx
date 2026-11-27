import { useEffect, useState } from "react";
import {
  DEFAULT_COMPLETION_AUTOMATION,
  DEFAULT_COMPLETION_COMMAND_TIMEOUT_SECONDS,
  DEFAULT_COMPLETION_MAX_AUTO_FIX_ATTEMPTS,
  MAX_COMPLETION_COMMAND_TIMEOUT_SECONDS,
  MAX_COMPLETION_MAX_AUTO_FIX_ATTEMPTS,
  MIN_COMPLETION_COMMAND_TIMEOUT_SECONDS,
  MIN_COMPLETION_MAX_AUTO_FIX_ATTEMPTS,
  resolveCompletionAutomationLimits,
  type WorkspaceAutomationCheck,
  WorkspaceAutomationCheck as CheckSchema,
} from "@t3tools/contracts";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import * as Schema from "effect/Schema";
import { ShieldCheckIcon } from "lucide-react";
import { projectEnvironment } from "~/state/projects";
import { useListedThreadShells, useThreadActivities } from "~/state/entities";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { SectionCard, notifyCommandFailure, notifySuccess } from "./controlCenterShared";

const isCheck = Schema.is(CheckSchema);

export const DEFAULT_COMPLETION_MAX_AUTO_REPAIRS = DEFAULT_COMPLETION_MAX_AUTO_FIX_ATTEMPTS;
export const DEFAULT_COMPLETION_TIMEOUT_SECONDS = DEFAULT_COMPLETION_COMMAND_TIMEOUT_SECONDS;

function clampInputInteger(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

export function CompletionAutomationSection({ project }: { project: EnvironmentProject }) {
  const stored = project.workspaceControl?.completionAutomation ?? DEFAULT_COMPLETION_AUTOMATION;
  const storedLimits = resolveCompletionAutomationLimits(stored);
  const storedNormalized = {
    ...stored,
    maxAutoFixAttempts: storedLimits.maxAutoFixAttempts,
    commandTimeoutSeconds: storedLimits.commandTimeoutSeconds,
  };
  const storedKey = JSON.stringify(storedNormalized);
  const [config, setConfig] = useState(storedNormalized);
  const [format, setFormat] = useState(storedNormalized.formatCommands.join("\n"));
  const [verification, setVerification] = useState(
    storedNormalized.verificationCommands.join("\n"),
  );
  const [busy, setBusy] = useState(false);
  const update = useAtomCommand(projectEnvironment.updateWorkspaceControl, {
    reportFailure: false,
  });
  useEffect(() => {
    const value = JSON.parse(storedKey) as typeof storedNormalized;
    setConfig(value);
    setFormat(value.formatCommands.join("\n"));
    setVerification(value.verificationCommands.join("\n"));
  }, [storedKey]);
  const commands = (value: string) =>
    value
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  const resolvedLimits = resolveCompletionAutomationLimits(config);
  const save = async () => {
    setBusy(true);
    try {
      const normalizedLimits = resolveCompletionAutomationLimits(config);
      const nextConfig = {
        ...config,
        formatCommands: commands(format),
        verificationCommands: commands(verification),
        followUpTask: config.followUpTask?.trim() || null,
        maxAutoFixAttempts: normalizedLimits.maxAutoFixAttempts,
        commandTimeoutSeconds: normalizedLimits.commandTimeoutSeconds,
      };
      setConfig(nextConfig);
      const result = await update({
        environmentId: project.environmentId,
        input: {
          projectId: project.id,
          longTermMemoryRoot: project.workspaceControl?.longTermMemoryRoot ?? null,
          completionAutomation: nextConfig,
        },
      });
      if (!notifyCommandFailure(result, "완료 후 자동 검증을 저장하지 못했습니다."))
        notifySuccess("완료 후 자동 검증을 저장했습니다.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <SectionCard
      id="completion-checks"
      icon={ShieldCheckIcon}
      title="완료 후 자동 검증"
      description="Git 작업 공간의 일반 대화가 완료되면 포맷 명령을 실행하고 체크포인트를 저장한 뒤 테스트합니다. 명령은 서버의 셸에서 실행됩니다."
    >
      <div className="grid gap-3">
        <label className="flex items-center justify-between gap-3 text-sm">
          포맷·검증 자동 실행
          <Switch
            checked={config.enabled}
            onCheckedChange={(enabled) => setConfig({ ...config, enabled })}
          />
        </label>
        <div
          className={`grid gap-3 transition-opacity ${config.enabled ? "" : "opacity-55"}`}
          aria-disabled={!config.enabled}
        >
          <div className="grid gap-3 md:grid-cols-2">
            <label className="grid gap-1 text-xs">
              포맷 명령 (줄마다 하나)
              <Textarea
                disabled={!config.enabled}
                value={format}
                onChange={(event) => setFormat(event.target.value)}
                placeholder="npm.cmd run format"
              />
            </label>
            <label className="grid gap-1 text-xs">
              검증 명령 (줄마다 하나)
              <Textarea
                disabled={!config.enabled}
                value={verification}
                onChange={(event) => setVerification(event.target.value)}
                placeholder="npm.cmd test"
              />
            </label>
          </div>
          <div className="grid gap-3 rounded-xl border border-border/70 bg-muted/20 p-3 md:grid-cols-2">
            <label className="grid gap-1 text-xs font-medium">
              최대 자동 보정 횟수 (기본 {DEFAULT_COMPLETION_MAX_AUTO_FIX_ATTEMPTS}회)
              <Input
                type="number"
                disabled={!config.enabled}
                min={MIN_COMPLETION_MAX_AUTO_FIX_ATTEMPTS}
                max={MAX_COMPLETION_MAX_AUTO_FIX_ATTEMPTS}
                step={1}
                value={String(resolvedLimits.maxAutoFixAttempts)}
                onChange={(event) =>
                  setConfig((current) => ({
                    ...current,
                    maxAutoFixAttempts: clampInputInteger(
                      Number.parseInt(event.currentTarget.value, 10),
                      MIN_COMPLETION_MAX_AUTO_FIX_ATTEMPTS,
                      MAX_COMPLETION_MAX_AUTO_FIX_ATTEMPTS,
                      DEFAULT_COMPLETION_MAX_AUTO_FIX_ATTEMPTS,
                    ),
                  }))
                }
              />
            </label>
            <label className="grid gap-1 text-xs font-medium">
              명령별 실행 타임아웃 · 초 (기본 {DEFAULT_COMPLETION_COMMAND_TIMEOUT_SECONDS}초)
              <Input
                type="number"
                disabled={!config.enabled}
                min={MIN_COMPLETION_COMMAND_TIMEOUT_SECONDS}
                max={MAX_COMPLETION_COMMAND_TIMEOUT_SECONDS}
                step={10}
                value={String(resolvedLimits.commandTimeoutSeconds)}
                onChange={(event) =>
                  setConfig((current) => ({
                    ...current,
                    commandTimeoutSeconds: clampInputInteger(
                      Number.parseInt(event.currentTarget.value, 10),
                      MIN_COMPLETION_COMMAND_TIMEOUT_SECONDS,
                      MAX_COMPLETION_COMMAND_TIMEOUT_SECONDS,
                      DEFAULT_COMPLETION_COMMAND_TIMEOUT_SECONDS,
                    ),
                  }))
                }
              />
            </label>
            <p className="text-xs leading-relaxed text-muted-foreground md:col-span-2">
              안전 한도: 무한 루프와 장시간 정지를 막기 위해 자동 보정은 최대{" "}
              {resolvedLimits.maxAutoFixAttempts}회(기본 {DEFAULT_COMPLETION_MAX_AUTO_FIX_ATTEMPTS}
              회), 개별 검증 명령은 {resolvedLimits.commandTimeoutSeconds}초(기본{" "}
              {DEFAULT_COMPLETION_COMMAND_TIMEOUT_SECONDS}초) 기준으로 보호합니다. 한도 초과 시 즉시
              중단하고 결과를 대화에 기록합니다.
            </p>
          </div>
          <label className="flex items-center justify-between gap-3 text-xs">
            모든 검증 통과 후 결과를 작업 기억에 저장
            <Switch
              disabled={!config.enabled}
              checked={config.enabled && config.saveResult}
              onCheckedChange={(saveResult) => setConfig({ ...config, saveResult })}
            />
          </label>
          <label className="grid gap-1 text-xs">
            검증 통과 후 이어서 할 작업 (선택)
            <Textarea
              disabled={!config.enabled}
              value={config.followUpTask ?? ""}
              onChange={(event) =>
                setConfig({ ...config, followUpTask: event.target.value || null })
              }
              placeholder="검증 결과를 정리하고 사용자 문서를 업데이트해줘."
            />
          </label>
        </div>
        <p className="text-xs text-muted-foreground">
          각 명령의 종료 코드와 실행 시각을 대화에 기록합니다. 실패하거나 새 작업이 시작되면 결과
          저장·후속 실행을 보류합니다. 후속 작업은 한 번 실행하며 자동화가 반복되지 않습니다.
        </p>
        <Button
          className="w-fit"
          size="sm"
          disabled={
            busy ||
            (config.enabled && !commands(verification).length) ||
            commands(format).length > 6 ||
            commands(verification).length > 6
          }
          onClick={() => void save()}
        >
          설정 저장
        </Button>
      </div>
    </SectionCard>
  );
}

export function CompletionAutomationReceipts({ project }: { project: EnvironmentProject }) {
  const threads = useListedThreadShells()
    .filter(
      (thread) => thread.environmentId === project.environmentId && thread.projectId === project.id,
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const [selected, setSelected] = useState<string>("");
  const thread = threads.find((item) => item.id === selected) ?? threads[0];
  const activities = useThreadActivities(
    thread ? { environmentId: project.environmentId, threadId: thread.id } : null,
  );
  const receipts = activities.filter((item) => item.kind.startsWith("automation.")).slice(-20);
  return (
    <details className="rounded-xl border border-border bg-card p-4">
      <summary className="cursor-pointer text-sm font-semibold">자동 검증 실행 기록</summary>
      <select
        aria-label="검증 기록을 확인할 대화"
        className="mt-3 w-full rounded border bg-background p-2 text-sm"
        value={thread?.id ?? ""}
        onChange={(event) => setSelected(event.target.value)}
      >
        {threads.map((item) => (
          <option key={item.id} value={item.id}>
            {item.title}
          </option>
        ))}
      </select>
      <div className="mt-3 grid gap-2">
        {receipts.map((item) => {
          const check: WorkspaceAutomationCheck | null = isCheck(item.payload)
            ? item.payload
            : null;
          return (
            <div key={item.id} className="rounded-lg bg-muted/40 p-3 text-xs">
              <p
                className={
                  item.kind.endsWith("failed") ||
                  item.kind.endsWith("limit_reached") ||
                  check?.passed === false
                    ? "text-destructive"
                    : "text-foreground"
                }
              >
                {item.summary}
              </p>
              {check ? (
                <>
                  <code className="mt-1 block break-all">{check.command}</code>
                  <p className="mt-1 text-muted-foreground">
                    {check.startedAt} → {check.completedAt}
                  </p>
                  {check.output ? (
                    <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap text-[11px]">
                      {check.output}
                    </pre>
                  ) : null}
                </>
              ) : null}
            </div>
          );
        })}
        {!receipts.length ? (
          <p className="text-xs text-muted-foreground">이 대화의 자동 검증 기록이 없습니다.</p>
        ) : null}
      </div>
    </details>
  );
}
