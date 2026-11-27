import { useCallback, useEffect, useState } from "react";

// Keep the last dismissal per room through navigation and reload in this browser tab.
const dismissedByRoom = new Map<string, string>();
function lastDismissed(room: string): string | null {
  try {
    return dismissedByRoom.get(room) ?? window.sessionStorage.getItem(room);
  } catch {
    return dismissedByRoom.get(room) ?? null;
  }
}

export function remainingWatchNoticeMs(
  at: string | undefined,
  seconds: number,
  now: number,
): number {
  if (!at || !Number.isInteger(seconds) || seconds <= 0) return 0;
  const interrupted = Date.parse(at);
  if (!Number.isFinite(interrupted) || interrupted > now) return 0;
  return Math.max(0, seconds * 1000 - (now - interrupted));
}

export function useBackgroundWatchNotice(
  threadKey: string,
  notice: { readonly eventId: string; readonly at: string } | null,
  seconds: number,
) {
  const room = "t3.watch-interruption.dismissed:" + threadKey;
  const [expired, setExpired] = useState<{ at: string | undefined; seconds: number } | null>(null);
  const [dismissed, setDismissed] = useState<{ room: string; eventId: string } | null>(null);
  const eventId = notice?.eventId;
  const at = notice?.at;
  const visible =
    !!eventId &&
    (expired?.at !== at || expired?.seconds !== seconds) &&
    (dismissed?.room !== room || dismissed.eventId !== eventId) &&
    lastDismissed(room) !== eventId &&
    remainingWatchNoticeMs(at, seconds, Date.now()) > 0;
  useEffect(() => {
    if (!visible) return;
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      clearTimeout(timer);
      const left = remainingWatchNoticeMs(at, seconds, Date.now());
      if (left <= 0) setExpired({ at, seconds });
      else timer = setTimeout(schedule, Math.min(left, 2_147_483_647));
    };
    schedule();
    document.addEventListener("visibilitychange", schedule);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", schedule);
    };
  }, [at, eventId, room, seconds, visible]);

  const dismiss = useCallback(() => {
    if (!eventId) return;
    dismissedByRoom.set(room, eventId);
    try {
      window.sessionStorage.setItem(room, eventId);
    } catch {
      /* In-memory dismissal remains available. */
    }
    setDismissed({ room, eventId });
  }, [room, eventId]);
  return { visible, dismiss };
}
