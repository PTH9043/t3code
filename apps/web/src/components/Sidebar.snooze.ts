import type { TimestampFormat } from "@t3tools/contracts/settings";
import {
  resolveSnoozePresets as resolveSharedSnoozePresets,
  snoozeWakeLabel as sharedSnoozeWakeLabel,
  type SnoozePreset,
} from "@t3tools/client-runtime/state/thread-settled";

import { formatShortTimestamp, parseTimestampDate } from "../timestampFormat";

export type { SnoozePreset };

const DAY_MS = 24 * 60 * 60 * 1_000;

function timeOfDayLabel(date: Date, timestampFormat: TimestampFormat): string {
  return formatShortTimestamp(date.toISOString(), timestampFormat);
}

export function resolveSnoozePresets(
  now: Date,
  timestampFormat: TimestampFormat,
): ReadonlyArray<SnoozePreset> {
  return resolveSharedSnoozePresets(now).map((preset) => {
    const wake = parseTimestampDate(preset.snoozedUntil);
    if (wake === null) return preset;
    const time = timeOfDayLabel(wake, timestampFormat);
    return {
      ...preset,
      label:
        preset.id === "hour"
          ? "1시간 후"
          : preset.id === "evening"
            ? "오늘 저녁"
            : preset.id === "tomorrow"
              ? "내일"
              : "다음 주",
      whenLabel:
        preset.id === "next-week"
          ? `${wake.toLocaleDateString("ko-KR", { weekday: "short" })} ${time}`
          : time,
    };
  });
}

/**
 * Human wake time for menus and toasts: "tomorrow 9:00", "Mon 9:00",
 * "17:30" (today).
 */
export function snoozeWakeDescription(
  snoozedUntil: string,
  now: Date,
  timestampFormat: TimestampFormat,
): string {
  const wake = parseTimestampDate(snoozedUntil);
  if (wake === null) return "";
  const time = timeOfDayLabel(wake, timestampFormat);
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const dayDelta = Math.floor((wake.getTime() - startOfToday.getTime()) / DAY_MS);
  if (dayDelta === 0) return time;
  if (dayDelta === 1) return `내일 ${time}`;
  const weekday = wake.toLocaleDateString("ko-KR", { weekday: "short" });
  if (dayDelta < 7) return `${weekday} ${time}`;
  const date = wake.toLocaleDateString("ko-KR", { month: "short", day: "numeric" });
  return `${date} ${time}`;
}

export function snoozeWakeLabel(snoozedUntil: string, options: { readonly now: string }): string {
  const label = sharedSnoozeWakeLabel(snoozedUntil, options);
  if (label === "now") return "지금";
  if (label.endsWith("m")) return `${label.slice(0, -1)}분`;
  if (label.endsWith("h")) return `${label.slice(0, -1)}시간`;
  if (label.endsWith("d")) return `${label.slice(0, -1)}일`;
  return label;
}
