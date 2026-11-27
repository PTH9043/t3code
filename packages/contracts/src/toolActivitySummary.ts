import * as Schema from "effect/Schema";
import { EventId, NonNegativeInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const ToolActivitySummaryFact = Schema.Struct({
  action: Schema.Literals(["read", "search", "list", "edit", "command", "other"]),
  phase: Schema.Literals(["started", "running", "completed", "failed", "stopped", "declined"]),
  evidence: Schema.Literals(["planned", "observed", "tool-reported", "confirmed-diff"]),
  subject: Schema.optionalKey(
    Schema.Literals([
      "diff",
      "history-fetch",
      "history-read",
      "history-fetch-read",
      "test",
      "read-search",
      "database-read",
      "repository-status",
    ]),
  ),
  compound: Schema.optionalKey(Schema.Literal(true)),
  targetCount: NonNegativeInt,
  confirmedDiffCount: NonNegativeInt,
});
export type ToolActivitySummaryFact = typeof ToolActivitySummaryFact.Type;

export const ToolActivitySummaryInput = Schema.Struct({
  threadId: ThreadId,
  activityId: EventId,
  fact: ToolActivitySummaryFact,
});
export type ToolActivitySummaryInput = typeof ToolActivitySummaryInput.Type;

export const TOOL_ACTIVITY_SUMMARY_MODELS = {
  granite: "granite4.1:8b",
  "qwen-coder": "qwen2.5-coder:14b",
} as const;

export const ToolActivitySummaryResult = Schema.Union([
  Schema.Struct({
    summary: TrimmedNonEmptyString,
    model: Schema.Literals([
      TOOL_ACTIVITY_SUMMARY_MODELS.granite,
      TOOL_ACTIVITY_SUMMARY_MODELS["qwen-coder"],
    ]),
  }),
  Schema.Struct({ summary: Schema.Null, model: Schema.Null }),
]);
export type ToolActivitySummaryResult = typeof ToolActivitySummaryResult.Type;
