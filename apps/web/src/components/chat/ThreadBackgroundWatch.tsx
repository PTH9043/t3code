import { useAtomValue } from "@effect/atom-react";
import {
  rollupBackgroundTasks,
  type EnvironmentId,
  type ThreadId,
  type UnifiedBgTask,
} from "@t3tools/contracts";
import { ActivityIcon } from "lucide-react";
import { useRef, useState } from "react";
import { useEnvironment } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  Popover,
  PopoverDescription,
  PopoverPopup,
  PopoverTitle,
  PopoverTrigger,
} from "../ui/popover";
import { Switch } from "../ui/switch";
import { BgTaskPeekPopover } from "./BgTaskPeekPopover";

export function ThreadBackgroundWatch({
  environmentId,
  threadId,
  backgroundTasks,
  onStopBackgroundWork,
  isStoppingBackgroundWork = false,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  backgroundTasks?: readonly UnifiedBgTask[];
  onStopBackgroundWork?: () => void;
  isStoppingBackgroundWork?: boolean;
}) {
  const connected = useEnvironment(environmentId)?.connection.phase === "connected";
  const settings = useAtomValue(serverEnvironment.settingsValueAtom(environmentId));
  const ids = settings?.backgroundWatchThreadIds;
  const [receipt, setReceipt] = useState<{
    previous: readonly ThreadId[];
    enabled: boolean;
  } | null>(null);
  // Use the acknowledged value until the settings stream delivers its next list.
  const enabled =
    receipt && receipt.previous === ids ? receipt.enabled : (ids?.includes(threadId) ?? false);
  const update = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const inFlight = useRef(false);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const ready = connected && Array.isArray(ids);
  const status = !ready ? "확인 필요" : saving ? "저장 중" : enabled ? "켜짐" : "꺼짐";
  const tasks = backgroundTasks ?? [];
  const rollup = rollupBackgroundTasks(tasks);
  const hasLiveTasks = rollup.totalActive > 0;
  const providerBreakdown = rollup.byProvider
    .map((entry) => `${entry.shortCode} ${entry.count}`)
    .join(" · ");
  const dotClass = !ready
    ? "bg-warning"
    : rollup.worstState === "FAILED"
      ? "bg-destructive"
      : rollup.worstState === "UNVERIFIED"
        ? "bg-orange-500"
        : rollup.worstState === "STALLED"
          ? "bg-warning"
          : hasLiveTasks || enabled
            ? "bg-success"
            : "bg-muted-foreground/50";

  async function change(next: boolean) {
    if (!ready || inFlight.current || next === enabled) return;
    inFlight.current = true;
    setSaving(true);
    setFailed(false);
    try {
      const result = await update({
        environmentId,
        input: { patch: { backgroundWatchThreadUpdate: { threadId, enabled: next } } },
      });
      if (
        result._tag === "Failure" ||
        !Array.isArray(result.value.backgroundWatchThreadIds) ||
        result.value.backgroundWatchThreadIds.includes(threadId) !== next
      ) {
        setFailed(true);
      } else {
        setReceipt({ previous: ids, enabled: next });
      }
    } catch {
      setFailed(true);
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  }

  return (
    <Popover>
      <PopoverTrigger
        data-chat-header-actions
        data-toolbar-control
        aria-label={
          hasLiveTasks
            ? `이 대화의 백그라운드 감시 · BG ${rollup.totalActive} 실행 중 · ${status}`
            : `이 대화의 백그라운드 감시 · ${status}`
        }
        title={
          hasLiveTasks
            ? `BG ${rollup.totalActive} 실행 중 (${providerBreakdown}) · 감시 ${status}`
            : `감시 ${status}`
        }
        className={
          hasLiveTasks
            ? "inline-flex h-7 shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-2 text-xs text-foreground transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring [-webkit-app-region:no-drag]"
            : "relative inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [-webkit-app-region:no-drag]"
        }
      >
        <ActivityIcon aria-hidden className="size-4 shrink-0" />
        <span
          aria-hidden
          className={
            hasLiveTasks
              ? `size-1.5 shrink-0 rounded-full ${dotClass}`
              : `absolute top-1 right-1 size-1.5 rounded-full ${dotClass}`
          }
        />
        {hasLiveTasks ? (
          <span className="font-medium tabular-nums">BG {rollup.totalActive}</span>
        ) : (
          <span className="sr-only">감시 {status}</span>
        )}
      </PopoverTrigger>
      <PopoverPopup align="end" className="w-88 max-w-[92vw] p-3">
        <div className="flex items-center justify-between gap-2">
          <PopoverTitle className="text-sm">이 대화의 백그라운드 감시</PopoverTitle>
          {ready && (
            <Switch
              aria-label="이 대화의 백그라운드 감시"
              checked={enabled}
              disabled={saving}
              onCheckedChange={change}
            />
          )}
        </div>
        <PopoverDescription className="mt-2 text-xs">
          켜면 이 대화에서 백그라운드 감시를 사용할 수 있습니다. 끄면 이 대화의 감시만 중지되고 진행
          중인 답변은 계속됩니다.
        </PopoverDescription>
        {!ready && (
          <p role="status" className="mt-2 text-xs">
            감시 설정을 확인할 수 없습니다. 서버 연결을 확인해 주세요.
          </p>
        )}
        {failed && (
          <p role="alert" className="mt-2 text-xs text-destructive">
            감시 설정 변경을 확인하지 못했습니다. 연결을 확인한 뒤 다시 시도해 주세요.
          </p>
        )}
        <BgTaskPeekPopover
          tasks={tasks}
          {...(onStopBackgroundWork ? { onStopAll: onStopBackgroundWork } : {})}
          stopping={isStoppingBackgroundWork}
        />
      </PopoverPopup>
    </Popover>
  );
}
