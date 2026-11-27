import type { OrchestrationThreadActivity } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { HistoryIcon, XIcon } from "lucide-react";
import { memo, useMemo } from "react";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import {
  latestUpgradeRoomOfflineWork,
  OFFLINE_WORK_STATUS_LABELS,
  shouldShowUpgradeRoomOfflineWork,
  UPGRADE_ROOM_OFFLINE_WORK_SEEN_KEY,
  UPGRADE_ROOM_THREAD_ID,
} from "./upgradeRoomOfflineWork";

const SeenActivityId = Schema.NullOr(Schema.String);

function formatTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleString("ko-KR", {
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
}

/** "T3가 꺼진 동안 한 작업" — shown once per offline-work activity in the upgrade room thread. */
export const UpgradeRoomOfflineWorkCard = memo(function UpgradeRoomOfflineWorkCard({
  threadId,
  activities,
  enabled,
}: {
  threadId: string;
  activities: ReadonlyArray<OrchestrationThreadActivity>;
  enabled: boolean;
}) {
  const latest = useMemo(
    () => (threadId === UPGRADE_ROOM_THREAD_ID ? latestUpgradeRoomOfflineWork(activities) : null),
    [activities, threadId],
  );
  const [seenActivityId, setSeenActivityId] = useLocalStorage(
    UPGRADE_ROOM_OFFLINE_WORK_SEEN_KEY,
    null,
    SeenActivityId,
  );
  if (
    !latest ||
    !shouldShowUpgradeRoomOfflineWork({
      threadId,
      enabled,
      activityId: latest.activityId,
      seenActivityId,
    })
  ) {
    return null;
  }
  const { work } = latest;
  return (
    <div className="pointer-events-auto mx-auto w-fit max-w-[calc(100%-2rem)] pt-3">
      <section
        aria-label="T3가 꺼진 동안 한 작업"
        className="alert-glass relative flex max-w-xl gap-3 rounded-xl border py-3 ps-3.5 pe-10 text-card-foreground text-sm"
      >
        <HistoryIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
        <div className="flex min-w-0 flex-col gap-1.5">
          <div className="font-medium">T3가 꺼진 동안 한 작업</div>
          <div className="text-muted-foreground text-xs">
            {formatTime(work.from)} ~ {formatTime(work.to)}
          </div>
          {work.items.length === 0 ? (
            <div className="text-muted-foreground">진행된 작업이 없습니다.</div>
          ) : (
            <ul className="flex max-h-64 flex-col gap-2 overflow-y-auto">
              {work.items.map((item) => (
                <li key={item.jobId} className="flex min-w-0 flex-col gap-0.5">
                  <div className="truncate" title={item.request}>
                    {item.request || "(내용 없음)"}
                  </div>
                  <div className="text-muted-foreground text-xs">
                    {OFFLINE_WORK_STATUS_LABELS[item.status]} · {formatTime(item.startedAt)}
                    {item.finishedAt ? ` ~ ${formatTime(item.finishedAt)}` : ""}
                  </div>
                  {item.questions?.map((question) => (
                    <div
                      key={`${question.handledAs}:${question.question}`}
                      className="text-muted-foreground text-xs"
                    >
                      질문: {question.question} —{" "}
                      {question.handledAs === "decided" ? "스스로 판단함" : "답변 대기 중"}
                    </div>
                  ))}
                </li>
              ))}
            </ul>
          )}
        </div>
        <button
          type="button"
          aria-label="T3가 꺼진 동안 한 작업 닫기"
          className="absolute top-2 right-2 inline-flex size-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-foreground/8 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => setSeenActivityId(latest.activityId)}
        >
          <XIcon aria-hidden className="size-3.5" />
        </button>
      </section>
    </div>
  );
});
