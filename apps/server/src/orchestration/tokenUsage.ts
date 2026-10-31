import type { TokenCounts, TokenUsageIssue, TokenUsageObservation } from "@t3tools/contracts";

export const emptyTokenCounts = (): TokenCounts => ({
  total: null,
  input: null,
  output: null,
  cacheRead: null,
  cacheWrite: null,
  reasoning: null,
});
export const TOKEN_COUNT_KEYS = [
  "total",
  "input",
  "output",
  "cacheRead",
  "cacheWrite",
  "cacheWrite5m",
  "cacheWrite1h",
  "reasoning",
] as const;

/** Null means not reported. Known subtotals remain useful but are never called complete. */
export function addTokenCounts(a: TokenCounts, b: TokenCounts): TokenCounts {
  const sum = (key: keyof TokenCounts) =>
    a[key] == null ? (b[key] ?? null) : b[key] == null ? a[key] : a[key] + b[key];
  return {
    total: sum("total"),
    input: sum("input"),
    output: sum("output"),
    cacheRead: sum("cacheRead"),
    cacheWrite: sum("cacheWrite"),
    reasoning: sum("reasoning"),
    ...(sum("cacheWrite5m") === null ? {} : { cacheWrite5m: sum("cacheWrite5m")! }),
    ...(sum("cacheWrite1h") === null ? {} : { cacheWrite1h: sum("cacheWrite1h")! }),
  };
}

/**
 * A source is a native session counter or a single native execution result.
 * Repeated snapshots are replacements, not additional spend. Counter regressions
 * cannot distinguish reset from reordering: retain the high-water mark and flag the gap.
 */
export function advanceTokenUsage(
  previous: TokenCounts | null,
  observation: TokenUsageObservation,
): { cursor: TokenCounts; delta: TokenCounts; issue: TokenUsageIssue | null } {
  const next = observation.counts;
  if (previous === null) {
    return observation.mode === "execution-total" || observation.startsAtZero === true
      ? { cursor: next, delta: next, issue: null }
      : { cursor: next, delta: emptyTokenCounts(), issue: "baseline-required" };
  }
  if (
    TOKEN_COUNT_KEYS.some(
      (key) => previous[key] != null && next[key] != null && next[key] < previous[key],
    )
  ) {
    return { cursor: previous, delta: emptyTokenCounts(), issue: "counter-regressed" };
  }
  const diff = (key: keyof TokenCounts) =>
    previous[key] == null || next[key] == null ? null : next[key] - previous[key];
  return {
    cursor: {
      total: next.total ?? previous.total,
      input: next.input ?? previous.input,
      output: next.output ?? previous.output,
      cacheRead: next.cacheRead ?? previous.cacheRead,
      cacheWrite: next.cacheWrite ?? previous.cacheWrite,
      reasoning: next.reasoning ?? previous.reasoning,
      ...((next.cacheWrite5m ?? previous.cacheWrite5m) !== undefined
        ? { cacheWrite5m: next.cacheWrite5m ?? previous.cacheWrite5m }
        : {}),
      ...((next.cacheWrite1h ?? previous.cacheWrite1h) !== undefined
        ? { cacheWrite1h: next.cacheWrite1h ?? previous.cacheWrite1h }
        : {}),
    },
    delta: {
      total: diff("total"),
      input: diff("input"),
      output: diff("output"),
      cacheRead: diff("cacheRead"),
      cacheWrite: diff("cacheWrite"),
      reasoning: diff("reasoning"),
      ...(diff("cacheWrite5m") === null ? {} : { cacheWrite5m: diff("cacheWrite5m")! }),
      ...(diff("cacheWrite1h") === null ? {} : { cacheWrite1h: diff("cacheWrite1h")! }),
    },
    issue: null,
  };
}
