import type { WorkspaceScheduleTiming } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

export interface WorkspaceScheduleResolution {
  readonly nextTriggerAt: string | null;
  readonly error: string | null;
}

function parseInstant(value: string, label: string): number | string {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : `${label} must be a valid ISO date-time.`;
}

function localParts(formatter: Intl.DateTimeFormat, timestamp: number) {
  const values = Object.fromEntries(
    formatter
      .formatToParts(DateTime.toDate(DateTime.makeUnsafe(timestamp)))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return {
    dateKey: `${values.year}-${values.month}-${values.day}`,
    time: `${values.hour}:${values.minute}`,
  };
}

function resolveDaily(input: {
  readonly timing: Extract<WorkspaceScheduleTiming, { readonly kind: "daily" }>;
  readonly nowMs: number;
  readonly lastTriggeredMs: number | null;
}): WorkspaceScheduleResolution {
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: input.timing.timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
  } catch {
    return {
      nextTriggerAt: null,
      error: `Unknown IANA time zone '${input.timing.timeZone}'.`,
    };
  }

  const lastLocalDate =
    input.lastTriggeredMs === null ? null : localParts(formatter, input.lastTriggeredMs).dateKey;
  const base =
    input.lastTriggeredMs === null
      ? Math.floor(input.nowMs / 60_000) * 60_000
      : Math.floor(Math.max(input.nowMs, input.lastTriggeredMs) / 60_000) * 60_000 + 60_000;
  for (let offsetMinutes = 0; offsetMinutes <= 4_320; offsetMinutes += 1) {
    const candidate = base + offsetMinutes * 60_000;
    const local = localParts(formatter, candidate);
    if (
      local.time === input.timing.localTime &&
      (lastLocalDate === null || local.dateKey !== lastLocalDate)
    ) {
      return {
        nextTriggerAt: DateTime.formatIso(DateTime.makeUnsafe(candidate)),
        error: null,
      };
    }
  }
  return {
    nextTriggerAt: null,
    error: `Could not resolve the next daily trigger for '${input.timing.localTime}' in '${input.timing.timeZone}'.`,
  };
}

/** Resolve exactly one next trigger; missed intervals never fan out into catch-up floods. */
export function resolveWorkspaceScheduleNextTrigger(input: {
  readonly timing: WorkspaceScheduleTiming;
  readonly now: string;
  readonly lastTriggeredAt: string | null;
}): WorkspaceScheduleResolution {
  const now = parseInstant(input.now, "now");
  if (typeof now === "string") return { nextTriggerAt: null, error: now };
  const last =
    input.lastTriggeredAt === null ? null : parseInstant(input.lastTriggeredAt, "lastTriggeredAt");
  if (typeof last === "string") return { nextTriggerAt: null, error: last };

  switch (input.timing.kind) {
    case "once": {
      if (last !== null) return { nextTriggerAt: null, error: null };
      const runAt = parseInstant(input.timing.runAt, "runAt");
      return typeof runAt === "string"
        ? { nextTriggerAt: null, error: runAt }
        : { nextTriggerAt: DateTime.formatIso(DateTime.makeUnsafe(runAt)), error: null };
    }
    case "interval": {
      const start = parseInstant(input.timing.startAt, "startAt");
      if (typeof start === "string") return { nextTriggerAt: null, error: start };
      const intervalMs = input.timing.everyMinutes * 60_000;
      let candidate: number;
      if (last === null) {
        candidate =
          start >= now ? start : start + Math.ceil((now - start) / intervalMs) * intervalMs;
      } else {
        const threshold = Math.max(now, last);
        candidate = start + (Math.floor((threshold - start) / intervalMs) + 1) * intervalMs;
      }
      return {
        nextTriggerAt: DateTime.formatIso(DateTime.makeUnsafe(candidate)),
        error: null,
      };
    }
    case "daily":
      return resolveDaily({ timing: input.timing, nowMs: now, lastTriggeredMs: last });
  }
}
