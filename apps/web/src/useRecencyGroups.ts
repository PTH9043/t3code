import { useCallback, useMemo, useState } from "react";

import { groupByRecency, RECENCY_EXPANDED_DAY_COUNT, type RecencyGroup } from "./recencyGroups";

export interface RecencyGroupsState<T> {
  readonly groups: ReadonlyArray<RecencyGroup<T>>;
  readonly isExpanded: (key: string) => boolean;
  readonly toggle: (key: string) => void;
  /** True when at least one group is folded, so callers can offer "펼치기". */
  readonly hasCollapsed: boolean;
  readonly expandAll: () => void;
}

/**
 * Day-bucketed view of a dated list, with the recent days open.
 *
 * The person's own toggles are held as an override set rather than a full
 * expanded map, so a group they never touched keeps following the default as
 * days roll over and new records arrive — otherwise yesterday's open group
 * would still be pinned open a week later.
 *
 * `now` is captured per grouping rather than per render: re-reading the clock
 * every render would rebuild the groups on every keystroke elsewhere in the
 * tree, and a day boundary crossed mid-session redraws on the next data change
 * anyway.
 */
export function useRecencyGroups<T>(
  items: ReadonlyArray<T>,
  getTimestamp: (item: T) => string | number | Date | null | undefined,
  expandedDayCount: number = RECENCY_EXPANDED_DAY_COUNT,
): RecencyGroupsState<T> {
  const [overrides, setOverrides] = useState<ReadonlyMap<string, boolean>>(() => new Map());

  const groups = useMemo(
    () => groupByRecency(items, getTimestamp, new Date(), expandedDayCount),
    // `getTimestamp` is an inline accessor at most call sites; keying on it
    // would regroup every render. The items and the window are what matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items, expandedDayCount],
  );

  const isExpanded = useCallback(
    (key: string) => {
      const override = overrides.get(key);
      if (override !== undefined) return override;
      return !(groups.find((group) => group.key === key)?.collapsedByDefault ?? false);
    },
    [groups, overrides],
  );

  const toggle = useCallback(
    (key: string) => {
      setOverrides((previous) => {
        const collapsedByDefault =
          groups.find((group) => group.key === key)?.collapsedByDefault ?? false;
        const current = previous.get(key) ?? !collapsedByDefault;
        const next = new Map(previous);
        next.set(key, !current);
        return next;
      });
    },
    [groups],
  );

  const expandAll = useCallback(() => {
    setOverrides(() => new Map(groups.map((group) => [group.key, true])));
  }, [groups]);

  const hasCollapsed = useMemo(
    () => groups.some((group) => !isExpanded(group.key)),
    [groups, isExpanded],
  );

  return { groups, isExpanded, toggle, hasCollapsed, expandAll };
}
