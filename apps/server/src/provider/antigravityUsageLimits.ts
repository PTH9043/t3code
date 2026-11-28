/**
 * Antigravity (`agy`) subscription quota parser for T3's usage snapshot.
 *
 * `agy -p /usage` prints tab-separated rows across model buckets, e.g.:
 *   Gemini Models\tWeekly Limit Remaining\t97%\t2026-11-27T09:36:45Z
 *   Gemini Models\tFive Hour Limit Remaining\t91%\t2026-11-20T14:36:45Z
 *   Claude and GPT models\tWeekly Limit Remaining\t47%\t2026-11-27T09:39:04Z
 *   Claude and GPT models\tFive Hour Limit Remaining\t0%\t2026-11-20T14:39:04Z
 *
 * The primary Gemini bucket fills `primary` (5h) and `secondary` (7d), while
 * additional buckets (such as Claude & GPT models) are preserved in `extraWindows`.
 *
 * @module provider/antigravityUsageLimits
 */
import type { ServerProviderUsage, ServerProviderUsageWindow } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

import type { ProviderRateLimitUsage } from "./providerAccountUsage.ts";

export const ANTIGRAVITY_USAGE_PROBE_TIMEOUT_MS = 18_000;

interface BucketMeta {
  readonly id: string;
  readonly displayPrefix: string;
  readonly isGemini: boolean;
}

function classifyBucket(rawBucket: string): BucketMeta {
  const trimmed = rawBucket.trim();
  if (/\bgemini\b/i.test(trimmed)) {
    return { id: "gemini", displayPrefix: "Gemini", isGemini: true };
  }
  if (/\bclaude\b/i.test(trimmed) && /\bgpt\b/i.test(trimmed)) {
    return { id: "claude-gpt", displayPrefix: "Claude·GPT", isGemini: false };
  }
  if (/\bclaude\b/i.test(trimmed)) {
    return { id: "claude", displayPrefix: "Claude", isGemini: false };
  }
  if (/\bgpt\b/i.test(trimmed)) {
    return { id: "gpt", displayPrefix: "GPT", isGemini: false };
  }
  const slug =
    trimmed
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "other";
  return { id: slug, displayPrefix: trimmed || "기타", isGemini: false };
}

function epochSecondsFromIso(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = DateTime.make(trimmed);
  if (Option.isNone(parsed)) return undefined;
  const seconds = Math.floor(DateTime.toEpochMillis(parsed.value) / 1_000);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
}

function parsePercent(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = /^(-?\d+(?:\.\d+)?)\s*%?$/.exec(value.trim());
  if (!match) return undefined;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function classifySlot(kindLabel: string): "primary" | "secondary" | undefined {
  if (/five\s*hour|5\s*h|5시간/i.test(kindLabel)) return "primary";
  if (/weekly|seven\s*day|7\s*d|주간|7일/i.test(kindLabel)) return "secondary";
  return undefined;
}

/**
 * Parse `agy -p /usage` stdout into `ProviderRateLimitUsage`.
 * Puts the Gemini bucket (or the first bucket if no Gemini bucket is present)
 * into `primary`/`secondary`, and preserves every additional bucket in `extraWindows`
 * ordered 5-hour before 7-day within each bucket. Never throws.
 */
export function parseAntigravityUsageOutput(output: string): ProviderRateLimitUsage {
  const buckets = new Map<
    string,
    {
      meta: BucketMeta;
      fiveHour?: ServerProviderUsageWindow;
      weekly?: ServerProviderUsageWindow;
    }
  >();

  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const columns = line.includes("\t")
      ? line.split("\t").map((col) => col.trim())
      : line.split(/\s{2,}/).map((col) => col.trim());
    if (columns.length < 3) continue;

    const [rawBucket = "", kindLabel = "", rawPercent = "", rawReset] = columns;
    const slot = classifySlot(kindLabel);
    if (!slot) continue;

    const percent = parsePercent(rawPercent);
    if (percent === undefined) continue;

    const meta = classifyBucket(rawBucket);
    const isRemaining = /remaining|남음|잔여/i.test(kindLabel);
    const usedPercent = Math.min(100, Math.max(0, isRemaining ? 100 - percent : percent));
    const resetsAt = epochSecondsFromIso(rawReset);
    const durationMinutes = slot === "primary" ? 300 : 10_080;
    const shortCadence = slot === "primary" ? "5시간" : "7일";

    const window: ServerProviderUsageWindow = {
      label: `${meta.displayPrefix} ${shortCadence}`,
      bucket: meta.id,
      usedPercent,
      windowDurationMinutes: durationMinutes,
      ...(resetsAt !== undefined ? { resetsAt } : {}),
    };

    const existing = buckets.get(meta.id) ?? { meta };
    if (slot === "primary") existing.fiveHour = window;
    else existing.weekly = window;
    buckets.set(meta.id, existing);
  }

  const allBuckets = [...buckets.values()];
  if (allBuckets.length === 0) return {};

  // Choose the Gemini bucket as the main pair if present; otherwise the first bucket.
  const mainBucket = allBuckets.find((entry) => entry.meta.isGemini) ?? allBuckets[0]!;
  const extraWindows: ServerProviderUsageWindow[] = [];
  for (const entry of allBuckets) {
    if (entry === mainBucket) continue;
    if (entry.fiveHour) extraWindows.push(entry.fiveHour);
    if (entry.weekly) extraWindows.push(entry.weekly);
  }

  return {
    ...(mainBucket.fiveHour ? { primary: mainBucket.fiveHour } : {}),
    ...(mainBucket.weekly ? { secondary: mainBucket.weekly } : {}),
    ...(extraWindows.length > 0 ? { extraWindows } : {}),
  };
}

/** Build a `ServerProviderUsage` snapshot from parsed Antigravity windows, or `undefined` if empty. */
export function antigravityAccountUsage(input: {
  readonly fetchedAt: string;
  readonly rateLimits: ProviderRateLimitUsage;
}): ServerProviderUsage | undefined {
  const { primary, secondary, extraWindows } = input.rateLimits;
  if (!primary && !secondary && (!extraWindows || extraWindows.length === 0)) return undefined;
  return {
    source: "provider",
    updatedAt: input.fetchedAt,
    sessionTokens: 0,
    sessionCount: 0,
    activeSessionCount: 0,
    ...(primary ? { primary } : {}),
    ...(secondary ? { secondary } : {}),
    ...(extraWindows && extraWindows.length > 0 ? { extraWindows } : {}),
  };
}
