/**
 * Buckets a dated list into day groups, with the recent days open and everything
 * older folded away behind a header that carries its count.
 *
 * Three surfaces pile records up — the sidebar's threads, a thread's own
 * timeline, and the control center's run table — and they render as a nested
 * list, a virtualized list, and a table respectively. No component fits all
 * three, so what they share is this: the bucketing, the labels, and the rule for
 * which buckets start open.
 */

/** Days kept expanded, counting today. Older days fold. */
export const RECENCY_EXPANDED_DAY_COUNT = 3;

export interface RecencyGroup<T> {
  /** Stable across renders and days: the local calendar date, `YYYY-MM-DD`. */
  readonly key: string;
  /** "오늘" / "어제" for the two most recent days, otherwise the date. */
  readonly label: string;
  readonly items: ReadonlyArray<T>;
  /** True once the day falls outside {@link RECENCY_EXPANDED_DAY_COUNT}. */
  readonly collapsedByDefault: boolean;
}

function startOfLocalDay(value: Date): number {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
}

function localDateKey(value: Date): string {
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${value.getFullYear()}-${month}-${day}`;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Whole local days between `date` and `now`. Local rather than UTC so a record
 * made at 23:50 reads as yesterday the next morning, not as today.
 */
export function localDaysAgo(date: Date, now: Date): number {
  return Math.round((startOfLocalDay(now) - startOfLocalDay(date)) / MS_PER_DAY);
}

export function recencyGroupLabel(date: Date, now: Date): string {
  const daysAgo = localDaysAgo(date, now);
  if (daysAgo <= 0) return "오늘";
  if (daysAgo === 1) return "어제";
  return localDateKey(date);
}

/**
 * Groups newest day first, preserving each caller's own ordering inside a day.
 * Items whose timestamp does not parse are treated as the oldest possible and
 * land in their own `unknown` group rather than being dropped — a record with a
 * broken date is still a record the person may be looking for.
 */
export function groupByRecency<T>(
  items: ReadonlyArray<T>,
  getTimestamp: (item: T) => string | number | Date | null | undefined,
  now: Date,
  expandedDayCount: number = RECENCY_EXPANDED_DAY_COUNT,
): ReadonlyArray<RecencyGroup<T>> {
  const byKey = new Map<string, { date: Date | null; items: T[] }>();

  for (const item of items) {
    const raw = getTimestamp(item);
    const parsed = raw === null || raw === undefined ? null : new Date(raw);
    const date = parsed !== null && Number.isFinite(parsed.getTime()) ? parsed : null;
    const key = date === null ? "unknown" : localDateKey(date);
    const bucket = byKey.get(key);
    if (bucket) {
      bucket.items.push(item);
    } else {
      byKey.set(key, { date, items: [item] });
    }
  }

  const groups: Array<RecencyGroup<T>> = [];
  for (const [key, bucket] of byKey) {
    groups.push({
      key,
      label: bucket.date === null ? "날짜 없음" : recencyGroupLabel(bucket.date, now),
      items: bucket.items,
      // `expandedDayCount` counts today, so the last open day is that many
      // minus one behind us; an undated group always folds.
      collapsedByDefault:
        bucket.date === null || localDaysAgo(bucket.date, now) > expandedDayCount - 1,
    });
  }

  // Newest first; the undated bucket sorts last because its key is not a date.
  return groups.sort((a, b) => {
    if (a.key === "unknown") return 1;
    if (b.key === "unknown") return -1;
    return b.key.localeCompare(a.key);
  });
}
