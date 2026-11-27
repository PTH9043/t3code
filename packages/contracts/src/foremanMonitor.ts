import * as Schema from "effect/Schema";
import { NonNegativeInt } from "./baseSchemas.ts";

export const ForemanIndicatorId = Schema.Literals([
  "waiting",
  "approval_wait",
  "stall",
  "loop",
  "handoff_drop",
  "unverified",
  "vm_collision",
  "quota_burn",
  "silent_routine",
]);
export type ForemanIndicatorId = typeof ForemanIndicatorId.Type;

/**
 * 3-State No-Guessing Observation Model:
 * Missing/unobservable telemetry MUST surface as `unavailable` rather than silently `clear`.
 */
export const ForemanIndicatorState = Schema.Literals(["fired", "clear", "unavailable"]);
export type ForemanIndicatorState = typeof ForemanIndicatorState.Type;

export const ForemanIndicatorReport = Schema.Struct({
  id: ForemanIndicatorId,
  label: Schema.String,
  severityRank: NonNegativeInt,
  state: ForemanIndicatorState,
  summary: Schema.String,
  /** Explicit epistemic limit: what this signal alone cannot prove. */
  caveat: Schema.String,
  usageIsIncomplete: Schema.optionalKey(Schema.Boolean),
});
export type ForemanIndicatorReport = typeof ForemanIndicatorReport.Type;

export const ForemanMonitorSnapshot = Schema.Struct({
  evaluatedAtMs: NonNegativeInt,
  highestSeverityLabel: Schema.String,
  indicators: Schema.Array(ForemanIndicatorReport),
});
export type ForemanMonitorSnapshot = typeof ForemanMonitorSnapshot.Type;
