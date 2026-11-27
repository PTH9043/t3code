// @effect-diagnostics globalTimers:off - Bounded deadline on the optional SDK usage control request.
/**
 * Claude subscription limits read from the account, in the two-window shape
 * the usage snapshot already carries for Codex.
 *
 * Turn-driven `rate_limit_event` messages mostly omit `utilization`, so they
 * rarely fill a window. The Claude Agent SDK's `get_usage` control request
 * returns the same numbers as the CLI's `/usage` screen; the status probe asks
 * for it on the process it already started for that instance.
 *
 * @module provider/claudeUsageLimits
 */
import type { ServerProviderUsage, ServerProviderUsageWindow } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";

import type { ProviderRateLimitUsage } from "./providerAccountUsage.ts";

/** Account limits of one Claude instance, as read by its status probe. */
export interface ClaudeUsageSnapshot {
  /** When the SDK answered. Decides whether this or a turn's rate-limit event is newer. */
  readonly fetchedAt: string;
  readonly rateLimits: ProviderRateLimitUsage;
}

export type ClaudeUsageReadResult =
  | { readonly status: "ok"; readonly rateLimits: ProviderRateLimitUsage }
  | { readonly status: "unsupported" | "failed" | "timeout" };

// Same labels the rate-limit event path gives these two windows, so a later
// event is recognised as a reading of the same window.
const FIVE_HOUR_WINDOW = { label: "5시간", windowDurationMinutes: 300 } as const;
const SEVEN_DAY_WINDOW = { label: "7일", windowDurationMinutes: 10_080 } as const;
export const CLAUDE_USAGE_PROBE_TIMEOUT_MS = 4_000;

const CLAUDE_USAGE_METHOD = "usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET";

function readProperty(value: unknown, key: string): unknown {
  return Predicate.isObject(value) && Predicate.hasProperty(value, key) ? value[key] : undefined;
}

function epochSecondsFromIso(value: unknown): number | undefined {
  if (!Predicate.isString(value) || value.trim().length === 0) return undefined;
  const dateTime = DateTime.make(value);
  if (Option.isNone(dateTime)) return undefined;
  const seconds = Math.floor(DateTime.toEpochMillis(dateTime.value) / 1_000);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

/** `get_usage` reports utilization as 0-100, unlike rate-limit events (0-1). */
function usageWindow(
  value: unknown,
  window: Pick<ServerProviderUsageWindow, "label" | "windowDurationMinutes">,
): ServerProviderUsageWindow | undefined {
  const utilization = readProperty(value, "utilization");
  if (!Predicate.isNumber(utilization) || !Number.isFinite(utilization)) return undefined;
  const resetsAt = epochSecondsFromIso(readProperty(value, "resets_at"));
  return {
    ...window,
    usedPercent: Math.min(100, Math.max(0, utilization)),
    ...(resetsAt !== undefined ? { resetsAt } : {}),
  };
}

/**
 * Map a `get_usage` response to the 5-hour (`primary`) and all-models weekly
 * (`secondary`) windows. Windows the response does not report are left out;
 * model-specific weekly windows have no slot in this shape and are ignored.
 * Never throws: an unexpected shape yields no windows.
 */
export function claudeUsageResponseToRateLimits(response: unknown): ProviderRateLimitUsage {
  const rateLimits = readProperty(response, "rate_limits");
  const primary = usageWindow(readProperty(rateLimits, "five_hour"), FIVE_HOUR_WINDOW);
  const secondary = usageWindow(readProperty(rateLimits, "seven_day"), SEVEN_DAY_WINDOW);
  return {
    ...(primary ? { primary } : {}),
    ...(secondary ? { secondary } : {}),
  };
}

/** Provider-side usage for the instance snapshot, or `undefined` when no window was reported. */
export function claudeAccountUsage(snapshot: ClaudeUsageSnapshot): ServerProviderUsage | undefined {
  const { primary, secondary } = snapshot.rateLimits;
  if (!primary && !secondary) return undefined;
  return {
    source: "provider",
    updatedAt: snapshot.fetchedAt,
    sessionTokens: 0,
    sessionCount: 0,
    activeSessionCount: 0,
    ...(primary ? { primary } : {}),
    ...(secondary ? { secondary } : {}),
  };
}

/** Plan limits only exist for claude.ai logins; API-key and third-party backends have none. */
export function shouldReadClaudeUsage(input: {
  readonly authMode: string | undefined;
  readonly apiProvider: string | undefined;
}): boolean {
  if (input.authMode === "api-key") return false;
  return input.apiProvider === undefined || input.apiProvider === "firstParty";
}

function requestClaudeUsage(query: unknown): Promise<unknown> | undefined {
  // The SDK's typed method cannot ask the CLI to skip its scan of every recent
  // local transcript until it accepts `skipBehaviors`, and that scan outlasts
  // the deadline on a large history. Its control channel can, so use that
  // first and fall back to the typed method.
  const request = readProperty(query, "request");
  if (typeof request === "function") {
    return Promise.resolve(
      (request as (this: unknown, body: unknown) => unknown).call(query, {
        subtype: "get_usage",
        skip_behaviors: true,
      }),
    ).then((envelope) => readProperty(envelope, "response"));
  }
  const usage = readProperty(query, CLAUDE_USAGE_METHOD);
  if (typeof usage === "function") {
    return Promise.resolve(
      (usage as (this: unknown, options: unknown) => unknown).call(query, { skipBehaviors: true }),
    );
  }
  return undefined;
}

/**
 * Ask a live SDK query for the account limits, waiting at most `timeoutMs`.
 * Never rejects: a missing API, a failed request and a late answer each
 * resolve to a status the caller can ignore.
 */
export async function readClaudeRateLimits(
  query: unknown,
  timeoutMs: number,
): Promise<ClaudeUsageReadResult> {
  if (!(timeoutMs > 0)) return { status: "timeout" };
  let pending: Promise<unknown> | undefined;
  try {
    pending = requestClaudeUsage(query);
  } catch {
    return { status: "failed" };
  }
  if (!pending) return { status: "unsupported" };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<ClaudeUsageReadResult>((resolve) => {
    timer = setTimeout(() => resolve({ status: "timeout" }), timeoutMs);
  });
  // The handlers are attached before the race so a rejection that arrives
  // after the deadline (the probe aborts its process) is never unhandled.
  const answered = pending.then(
    (response): ClaudeUsageReadResult => ({
      status: "ok",
      rateLimits: claudeUsageResponseToRateLimits(response),
    }),
    (): ClaudeUsageReadResult => ({ status: "failed" }),
  );
  try {
    return await Promise.race([answered, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}
