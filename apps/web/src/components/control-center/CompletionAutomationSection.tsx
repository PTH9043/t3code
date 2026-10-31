import { useEffect, useState } from "react";
import {
  DEFAULT_COMPLETION_AUTOMATION,
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
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { SectionCard, notifyCommandFailure, notifySuccess } from "./controlCenterShared";

const isCheck = Schema.is(CheckSchema);

export function CompletionAutomationSection({ project }: { project: EnvironmentProject }) {
  const stored = project.workspaceControl?.completionAutomation ?? DEFAULT_COMPLETION_AUTOMATION;
  const storedKey = JSON.stringify(stored);
  const [config, setConfig] = useState(stored);
  const [format, setFormat] = useState(stored.formatCommands.join("\n"));
  const [verification, setVerification] = useState(stored.verificationCommands.join("\n"));
  const [busy, setBusy] = useState(false);
  const update = useAtomCommand(projectEnvironment.updateWorkspaceControl, {
    reportFailure: false,
  });
  useEffect(() => {
    const value = JSON.parse(storedKey) as typeof stored;
    setConfig(value);
    setFormat(value.formatCommands.join("\n"));
    setVerification(value.verificationCommands.join("\n"));
  }, [storedKey]);
  const commands = (value: string) =>
    value
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  const save = async () => {
    setBusy(true);
    try {
      const result = await update({
        environmentId: project.environmentId,
        input: {
          projectId: project.id,
          longTermMemoryRoot: project.workspaceControl?.longTermMemoryRoot ?? null,
          completionAutomation: {
            ...config,
            formatCommands: commands(format),
            verificationCommands: commands(verification),
            followUpTask: config.followUpTask?.trim() || null,
          },
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
        <div className="grid gap-3 md:grid-cols-2">
          <label className="grid gap-1 text-xs">
            포맷 명령 (줄마다 하나)
            <Textarea
              value={format}
              onChange={(event) => setFormat(event.target.value)}
              placeholder="npm.cmd run format"
            />
          </label>
          <label className="grid gap-1 text-xs">
            검증 명령 (줄마다 하나)
            <Textarea
              value={verification}
              onChange={(event) => setVerification(event.target.value)}
              placeholder="npm.cmd test"
            />
          </label>
        </div>
        <label className="flex items-center justify-between gap-3 text-xs">
          모든 검증 통과 후 결과를 작업 기억에 저장
          <Switch
            checked={config.saveResult}
            onCheckedChange={(saveResult) => setConfig({ ...config, saveResult })}
          />
        </label>
        <label className="grid gap-1 text-xs">
          검증 통과 후 이어서 할 작업 (선택)
          <Textarea
            value={config.followUpTask ?? ""}
            onChange={(event) => setConfig({ ...config, followUpTask: event.target.value || null })}
            placeholder="검증 결과를 정리하고 사용자 문서를 업데이트해줘."
          />
        </label>
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
                  item.kind.endsWith("failed") || check?.passed === false
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
