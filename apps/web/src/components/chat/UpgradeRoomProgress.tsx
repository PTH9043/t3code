import {
  describeUpgradeRoomProgress,
  type UpgradeRoomProgress,
} from "@t3tools/client-runtime/state/thread-tool-activity";
import { useEffect, useState } from "react";

export function UpgradeRoomProgressCard({
  progress,
  waiting,
}: {
  readonly progress: UpgradeRoomProgress;
  readonly waiting: string | null;
}) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, []);
  return (
    <section
      aria-label="업그레이드 방 작업 상황"
      className="flex shrink-0 flex-wrap items-baseline gap-x-2 border-b border-border/60 px-4 py-2 text-xs"
    >
      <span className="font-medium">{describeUpgradeRoomProgress(progress, now, waiting)}</span>
      {progress.recordedAt && (
        <time className="text-muted-foreground tabular-nums" dateTime={progress.recordedAt}>
          {new Date(progress.recordedAt).toLocaleTimeString("ko-KR", { hour12: false })}
        </time>
      )}
      {progress.label && (
        <span className="min-w-0 break-words text-muted-foreground">{progress.label}</span>
      )}
      {progress.completedTools > 0 && (
        <span className="text-muted-foreground tabular-nums">
          도구 {progress.completedTools}회 종료
        </span>
      )}
      {progress.plan && <span className="min-w-0 basis-full break-words">{progress.plan}</span>}
    </section>
  );
}
