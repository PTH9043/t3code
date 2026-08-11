import type { StatusTone } from "../../components/StatusPill";
import type { RemoteClientConnectionState } from "../../lib/connection";

export function connectionTone(state: RemoteClientConnectionState): StatusTone {
  switch (state) {
    case "connected":
      return {
        label: "연결됨",
        pillClassName: "bg-emerald-500/12 dark:bg-emerald-500/16",
        textClassName: "text-emerald-700 dark:text-emerald-300",
      };
    case "reconnecting":
      return {
        label: "다시 연결 중",
        pillClassName: "bg-amber-500/12 dark:bg-amber-500/16",
        textClassName: "text-amber-700 dark:text-amber-300",
      };
    case "connecting":
      return {
        label: "연결 중",
        pillClassName: "bg-sky-500/12 dark:bg-sky-500/16",
        textClassName: "text-sky-700 dark:text-sky-300",
      };
    case "error":
      return {
        label: "연결 실패",
        pillClassName: "bg-rose-500/12 dark:bg-rose-500/16",
        textClassName: "text-rose-700 dark:text-rose-300",
      };
    case "offline":
      return {
        label: "오프라인",
        pillClassName: "bg-rose-500/12 dark:bg-rose-500/16",
        textClassName: "text-rose-700 dark:text-rose-300",
      };
    case "available":
      return {
        label: "사용 가능",
        pillClassName: "bg-neutral-500/10 dark:bg-neutral-500/16",
        textClassName: "text-neutral-600 dark:text-neutral-300",
      };
  }
}
