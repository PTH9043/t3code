import type {
  ProviderRuntimeEvent,
  ServerProvider,
  ServerProviderUsage,
  ServerProviderUsageCredits,
  ServerProviderUsageWindow,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import type { ProviderInstance } from "./ProviderDriver.ts";

export interface ProviderRateLimitUsage {
  readonly planType?: string;
  readonly primary?: ServerProviderUsageWindow;
  readonly secondary?: ServerProviderUsageWindow;
  readonly credits?: ServerProviderUsageCredits;
}

export interface ProviderAccountUsageState {
  readonly threadTokens: ReadonlyMap<string, number>;
  readonly sessions: ReadonlySet<string>;
  readonly activeSessions: ReadonlySet<string>;
  readonly rateLimits?: ProviderRateLimitUsage;
  readonly updatedAt?: string;
}

export const makeEmptyProviderAccountUsageState = (): ProviderAccountUsageState => ({
  threadTokens: new Map(),
  sessions: new Set(),
  activeSessions: new Set(),
});

function readProperty<const Key extends PropertyKey>(value: unknown, key: Key): unknown {
  return Predicate.isObject(value) && Predicate.hasProperty(value, key) ? value[key] : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return Predicate.isNumber(value) && Number.isFinite(value) ? value : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  const number = finiteNumber(value);
  return number !== undefined && number >= 0 ? Math.trunc(number) : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  const number = nonNegativeInteger(value);
  return number !== undefined && number > 0 ? number : undefined;
}

function trimmedString(value: unknown): string | undefined {
  if (!Predicate.isString(value)) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readFirst(value: unknown, keys: ReadonlyArray<string>): unknown {
  for (const key of keys) {
    const candidate = readProperty(value, key);
    if (candidate !== undefined && candidate !== null) return candidate;
  }
  return undefined;
}

function rateLimitLabel(value: unknown): string | undefined {
  const explicit = trimmedString(readFirst(value, ["label", "limitName", "limit_name"]));
  if (explicit) return explicit;

  switch (trimmedString(readFirst(value, ["rateLimitType", "rate_limit_type"]))) {
    case "five_hour":
      return "5시간";
    case "seven_day":
      return "7일";
    case "seven_day_opus":
      return "7일 · Opus";
    case "seven_day_sonnet":
      return "7일 · Sonnet";
    case "overage":
      return "초과 사용";
    default:
      return undefined;
  }
}

function normalizeUsedPercent(value: unknown): number | undefined {
  const direct = finiteNumber(readFirst(value, ["usedPercent", "used_percent"]));
  if (direct !== undefined) return Math.min(100, Math.max(0, direct));

  const utilization = finiteNumber(readProperty(value, "utilization"));
  if (utilization !== undefined) {
    const percent = utilization <= 1 ? utilization * 100 : utilization;
    return Math.min(100, Math.max(0, percent));
  }

  const remaining = finiteNumber(readFirst(value, ["remainingPercent", "remaining_percent"]));
  return remaining === undefined ? undefined : Math.min(100, Math.max(0, 100 - remaining));
}

function normalizeRateLimitWindow(
  value: unknown,
  fallbackLabel?: string,
): ServerProviderUsageWindow | undefined {
  if (!Predicate.isObject(value)) return undefined;
  const usedPercent = normalizeUsedPercent(value);
  if (usedPercent === undefined) return undefined;

  const label = rateLimitLabel(value) ?? fallbackLabel;
  const resetsAt = nonNegativeInteger(
    readFirst(value, ["resetsAt", "resets_at", "resetAt", "reset_at"]),
  );
  const windowDurationMinutes = positiveInteger(
    readFirst(value, ["windowDurationMins", "window_duration_mins", "windowDurationMinutes"]),
  );
  return {
    usedPercent,
    ...(label ? { label } : {}),
    ...(resetsAt !== undefined ? { resetsAt } : {}),
    ...(windowDurationMinutes !== undefined ? { windowDurationMinutes } : {}),
  };
}

function normalizeCredits(value: unknown): ServerProviderUsageCredits | undefined {
  if (!Predicate.isObject(value)) return undefined;
  const rawBalance = readProperty(value, "balance");
  const balance =
    trimmedString(rawBalance) ??
    (finiteNumber(rawBalance) !== undefined ? String(rawBalance) : undefined);
  const rawHasCredits = readFirst(value, ["hasCredits", "has_credits"]);
  const rawUnlimited = readProperty(value, "unlimited");
  const hasCredits = Predicate.isBoolean(rawHasCredits) ? rawHasCredits : undefined;
  const unlimited = Predicate.isBoolean(rawUnlimited) ? rawUnlimited : undefined;
  if (balance === undefined && hasCredits === undefined && unlimited === undefined)
    return undefined;
  return {
    ...(balance ? { balance } : {}),
    ...(hasCredits !== undefined ? { hasCredits } : {}),
    ...(unlimited !== undefined ? { unlimited } : {}),
  };
}

function unwrapRateLimitValue(value: unknown): unknown {
  let current = value;
  for (let depth = 0; depth < 3; depth++) {
    const nested = readFirst(current, [
      "rateLimits",
      "rate_limits",
      "rate_limit_info",
      "rateLimitInfo",
    ]);
    if (!Predicate.isObject(nested)) break;
    current = nested;
  }
  return current;
}

/** Normalize Codex and Claude's known quota payloads without coupling the wire contract to either SDK. */
export function normalizeProviderRateLimits(value: unknown): ProviderRateLimitUsage | undefined {
  const snapshot = unwrapRateLimitValue(value);
  if (!Predicate.isObject(snapshot)) return undefined;

  let primary = normalizeRateLimitWindow(readProperty(snapshot, "primary"));
  let secondary = normalizeRateLimitWindow(readProperty(snapshot, "secondary"));
  if (!primary && !secondary) {
    const singleWindow = normalizeRateLimitWindow(snapshot);
    const rateLimitType = trimmedString(readFirst(snapshot, ["rateLimitType", "rate_limit_type"]));
    if (rateLimitType?.startsWith("seven_day")) {
      secondary = singleWindow;
    } else {
      primary = singleWindow;
    }
  }

  if (!primary) {
    primary = normalizeRateLimitWindow(
      readFirst(snapshot, ["individualLimit", "individual_limit"]),
    );
  }
  const planType = trimmedString(readFirst(snapshot, ["planType", "plan_type"]));
  const credits = normalizeCredits(readProperty(snapshot, "credits"));
  if (!planType && !primary && !secondary && !credits) return undefined;
  return {
    ...(planType ? { planType } : {}),
    ...(primary ? { primary } : {}),
    ...(secondary ? { secondary } : {}),
    ...(credits ? { credits } : {}),
  };
}

function mergeRateLimits(
  previous: ProviderRateLimitUsage | undefined,
  next: ProviderRateLimitUsage,
): ProviderRateLimitUsage {
  return {
    ...(previous ?? {}),
    ...next,
  };
}

export function reduceProviderAccountUsage(
  state: ProviderAccountUsageState,
  event: ProviderRuntimeEvent,
): ProviderAccountUsageState {
  if (event.type === "session.started") {
    const sessions = new Set(state.sessions);
    const activeSessions = new Set(state.activeSessions);
    sessions.add(event.threadId);
    activeSessions.add(event.threadId);
    return { ...state, sessions, activeSessions, updatedAt: event.createdAt };
  }

  if (event.type === "session.exited") {
    const activeSessions = new Set(state.activeSessions);
    activeSessions.delete(event.threadId);
    return { ...state, activeSessions, updatedAt: event.createdAt };
  }

  if (event.type === "thread.token-usage.updated" && event.payload.usage !== undefined) {
    const threadTokens = new Map(state.threadTokens);
    const sessions = new Set(state.sessions);
    const observedTokens =
      event.payload.usage.totalProcessedTokens ?? event.payload.usage.usedTokens;
    threadTokens.set(
      event.threadId,
      Math.max(threadTokens.get(event.threadId) ?? 0, observedTokens),
    );
    sessions.add(event.threadId);
    return { ...state, threadTokens, sessions, updatedAt: event.createdAt };
  }

  if (event.type === "account.rate-limits.updated") {
    const rateLimits = normalizeProviderRateLimits(event.payload.rateLimits);
    return rateLimits
      ? {
          ...state,
          rateLimits: mergeRateLimits(state.rateLimits, rateLimits),
          updatedAt: event.createdAt,
        }
      : state;
  }

  return state;
}

export function providerAccountUsageFromState(
  state: ProviderAccountUsageState,
): ServerProviderUsage | undefined {
  if (!state.updatedAt) return undefined;
  let sessionTokens = 0;
  for (const tokens of state.threadTokens.values()) sessionTokens += tokens;
  return {
    source: "runtime",
    updatedAt: state.updatedAt,
    sessionTokens,
    sessionCount: state.sessions.size,
    activeSessionCount: state.activeSessions.size,
    ...(state.rateLimits?.planType ? { planType: state.rateLimits.planType } : {}),
    ...(state.rateLimits?.primary ? { primary: state.rateLimits.primary } : {}),
    ...(state.rateLimits?.secondary ? { secondary: state.rateLimits.secondary } : {}),
    ...(state.rateLimits?.credits ? { credits: state.rateLimits.credits } : {}),
  };
}

export function mergeProviderAccountUsage(
  providerUsage: ServerProviderUsage | undefined,
  state: ProviderAccountUsageState,
): ServerProviderUsage | undefined {
  const runtimeUsage = providerAccountUsageFromState(state);
  if (!runtimeUsage) return providerUsage;
  if (!providerUsage) return runtimeUsage;
  return {
    ...providerUsage,
    ...runtimeUsage,
    source: providerUsage.source === "runtime" ? "runtime" : "combined",
    updatedAt:
      providerUsage.updatedAt > runtimeUsage.updatedAt
        ? providerUsage.updatedAt
        : runtimeUsage.updatedAt,
  };
}

function attachUsage(snapshot: ServerProvider, state: ProviderAccountUsageState): ServerProvider {
  const usage = mergeProviderAccountUsage(snapshot.usage, state);
  return usage ? { ...snapshot, usage } : snapshot;
}

/**
 * Decorate one materialized instance with usage tracking. The adapter event
 * stream remains the canonical stream; tapping it here preserves ordering and
 * gives every configured instance its own isolated accumulator.
 */
export const trackProviderInstanceUsage = Effect.fn("trackProviderInstanceUsage")(function* (
  instance: ProviderInstance,
) {
  const usageState = yield* Ref.make(makeEmptyProviderAccountUsageState());
  const changes = yield* PubSub.unbounded<void>();
  yield* Effect.addFinalizer(() => PubSub.shutdown(changes));

  const recordEvent = (event: ProviderRuntimeEvent) => {
    if (
      event.providerInstanceId !== undefined &&
      event.providerInstanceId !== instance.instanceId
    ) {
      return Effect.void;
    }
    return Ref.modify(usageState, (previous) => {
      const next = reduceProviderAccountUsage(previous, event);
      return [next !== previous, next] as const;
    }).pipe(
      Effect.flatMap((changed) =>
        changed ? PubSub.publish(changes, undefined).pipe(Effect.asVoid) : Effect.void,
      ),
    );
  };

  const mergeSnapshot = (snapshot: ServerProvider) =>
    Ref.get(usageState).pipe(Effect.map((state) => attachUsage(snapshot, state)));
  const getSnapshot = instance.snapshot.getSnapshot.pipe(Effect.flatMap(mergeSnapshot));
  const refresh = instance.snapshot.refresh.pipe(Effect.flatMap(mergeSnapshot));

  return {
    ...instance,
    snapshot: {
      maintenanceCapabilities: instance.snapshot.maintenanceCapabilities,
      getSnapshot,
      refresh,
      get streamChanges() {
        return Stream.merge(
          instance.snapshot.streamChanges.pipe(Stream.mapEffect(mergeSnapshot)),
          Stream.fromPubSub(changes).pipe(Stream.mapEffect(() => getSnapshot)),
        );
      },
    },
    adapter: {
      ...instance.adapter,
      get streamEvents() {
        return instance.adapter.streamEvents.pipe(Stream.tap(recordEvent));
      },
    },
  } satisfies ProviderInstance;
});
