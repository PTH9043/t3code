import { type TimestampFormat } from "@t3tools/contracts/settings";

export function getTimestampFormatOptions(
  timestampFormat: TimestampFormat,
  includeSeconds: boolean,
): Intl.DateTimeFormatOptions {
  const baseOptions: Intl.DateTimeFormatOptions = {
    hour: "numeric",
    minute: "2-digit",
    ...(includeSeconds ? { second: "2-digit" } : {}),
  };

  if (timestampFormat === "locale") {
    return baseOptions;
  }

  return {
    ...baseOptions,
    hour12: timestampFormat === "12-hour",
  };
}

const timestampFormatterCache = new Map<string, Intl.DateTimeFormat>();

function getTimestampFormatter(
  timestampFormat: TimestampFormat,
  includeSeconds: boolean,
): Intl.DateTimeFormat {
  const cacheKey = `${timestampFormat}:${includeSeconds ? "seconds" : "minutes"}`;
  const cachedFormatter = timestampFormatterCache.get(cacheKey);
  if (cachedFormatter) {
    return cachedFormatter;
  }

  const formatter = new Intl.DateTimeFormat(
    undefined,
    getTimestampFormatOptions(timestampFormat, includeSeconds),
  );
  timestampFormatterCache.set(cacheKey, formatter);
  return formatter;
}

export function parseTimestampDate(isoDate: string): Date | null {
  const date = new Date(isoDate);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatTimestamp(isoDate: string, timestampFormat: TimestampFormat): string {
  const date = parseTimestampDate(isoDate);
  if (!date) return "";
  return getTimestampFormatter(timestampFormat, true).format(date);
}

const chatDateFormatter = new Intl.DateTimeFormat("ko-KR", {
  year: "numeric",
  month: "long",
  day: "numeric",
});

/**
 * Long-form tooltip label, e.g. `12:04, 4th June`.
 * Renders the wall-clock time without seconds followed by the ordinal day and month name.
 */
export function formatChatTimestampTooltip(
  isoDate: string,
  timestampFormat: TimestampFormat,
): string {
  const date = parseTimestampDate(isoDate);
  if (!date) return "";
  const time = formatShortTimestamp(isoDate, timestampFormat);
  return `${chatDateFormatter.format(date)} ${time}`;
}

export function formatShortTimestamp(isoDate: string, timestampFormat: TimestampFormat): string {
  const date = parseTimestampDate(isoDate);
  if (!date) return "";
  return getTimestampFormatter(timestampFormat, false).format(date);
}

/**
 * Format a relative time string from an ISO date.
 * Returns `{ value: "20s", suffix: "ago" }` or `{ value: "just now", suffix: null }`
 * so callers can style the numeric portion independently.
 */
type RelativeTimeParts = { value: string; suffix: string | null };
export type RelativeTimeState =
  | { status: "missing" }
  | { status: "invalid" }
  | { status: "relative"; value: string; suffix: string | null };

export function formatRelativeTime(isoDate: string): RelativeTimeParts | null {
  const date = parseTimestampDate(isoDate);
  if (!date) return null;
  const diffMs = Date.now() - date.getTime();
  if (diffMs < 0) return { value: "방금", suffix: null };
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return { value: "방금", suffix: null };
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return { value: `${minutes}분`, suffix: "전" };
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { value: `${hours}시간`, suffix: "전" };
  const days = Math.floor(hours / 24);
  return { value: `${days}일`, suffix: "전" };
}

export function formatRelativeTimeLabel(isoDate: string) {
  const relative = formatRelativeTime(isoDate);
  if (!relative) return "";
  return relative.suffix ? `${relative.value} ${relative.suffix}` : relative.value;
}

export function getRelativeTimeState(isoDate: string | null): RelativeTimeState {
  if (!isoDate) return { status: "missing" };
  const relative = formatRelativeTime(isoDate);
  if (!relative) return { status: "invalid" };
  return { status: "relative", ...relative };
}

/**
 * Relative elapsed duration since an ISO instant, without an "ago" suffix.
 * Useful for labels like "Connected for 3m".
 */
export function formatElapsedDurationLabel(isoDate: string, nowMs: number = Date.now()): string {
  const date = parseTimestampDate(isoDate);
  if (!date) return "";
  const diffMs = nowMs - date.getTime();
  if (diffMs <= 0) return "방금";

  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 5) return "방금";
  if (seconds < 60) return `${seconds}초`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}분`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}시간`;

  const days = Math.floor(hours / 24);
  return `${days}일`;
}

/**
 * Relative time until an ISO instant (e.g. expiry). Mirrors {@link formatRelativeTime} but for future times.
 */
export function formatRelativeTimeUntil(isoDate: string): RelativeTimeParts | null {
  const date = parseTimestampDate(isoDate);
  if (!date) return null;
  const diffMs = date.getTime() - Date.now();
  if (diffMs <= 0) return { value: "만료됨", suffix: null };
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 5) return { value: "곧 만료", suffix: null };
  if (seconds < 60) return { value: `${seconds}초`, suffix: "남음" };
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return { value: `${minutes}분`, suffix: "남음" };
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { value: `${hours}시간`, suffix: "남음" };
  const days = Math.floor(hours / 24);
  return { value: `${days}일`, suffix: "남음" };
}

export function formatRelativeTimeUntilLabel(isoDate: string): string {
  const relative = formatRelativeTimeUntil(isoDate);
  if (!relative) return "";
  return relative.suffix ? `${relative.value} ${relative.suffix}` : relative.value;
}

/**
 * Countdown for a future instant (e.g. link expiry): "Expires in 4m 12s", with second precision under one hour.
 * Pass `nowMs` when a parent tick drives re-renders so the diff matches that snapshot.
 */
export function formatExpiresInLabel(isoDate: string, nowMs: number = Date.now()): string {
  const date = parseTimestampDate(isoDate);
  if (!date) return "";
  const diffMs = date.getTime() - nowMs;
  if (diffMs <= 0) return "만료됨";

  const totalSeconds = Math.floor(diffMs / 1000);
  if (totalSeconds < 5) return "잠시 후 만료";
  if (totalSeconds < 60) return `${totalSeconds}초 후 만료`;

  if (totalSeconds < 3600) {
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return seconds === 0 ? `${minutes}분 후 만료` : `${minutes}분 ${seconds}초 후 만료`;
  }

  if (totalSeconds < 86_400) {
    const hours = Math.floor(totalSeconds / 3600);
    const rem = totalSeconds % 3600;
    const minutes = Math.floor(rem / 60);
    const seconds = rem % 60;
    const parts = [`${hours}시간`];
    if (minutes > 0) parts.push(`${minutes}분`);
    if (seconds > 0) parts.push(`${seconds}초`);
    return `${parts.join(" ")} 후 만료`;
  }

  const days = Math.floor(totalSeconds / 86_400);
  const remAfterDays = totalSeconds % 86_400;
  if (remAfterDays === 0) return `${days}일 후 만료`;
  const hours = Math.floor(remAfterDays / 3600);
  const rem = remAfterDays % 3600;
  const minutes = Math.floor(rem / 60);
  const seconds = rem % 60;
  const tail: string[] = [];
  if (hours > 0) tail.push(`${hours}시간`);
  if (minutes > 0) tail.push(`${minutes}분`);
  if (seconds > 0) tail.push(`${seconds}초`);
  return tail.length > 0 ? `${days}일 ${tail.join(" ")} 후 만료` : `${days}일 후 만료`;
}
