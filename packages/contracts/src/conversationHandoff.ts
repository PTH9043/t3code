import * as Schema from "effect/Schema";
import { NonNegativeInt } from "./baseSchemas.ts";

/** Absent on older threads/servers; absence always means standard handoff. */
export const ConversationHandoffMode = Schema.Literals(["standard", "compact"]);
export type ConversationHandoffMode = typeof ConversationHandoffMode.Type;

export const ConversationHandoffReport = Schema.Struct({
  version: Schema.Literal(1),
  status: Schema.Literals(["compact", "fallback"]),
  reason: Schema.Literals([
    "reduced",
    "insufficient-savings",
    "incomplete-history",
    "source-unavailable",
    "source-too-large",
    "attachments-present",
    "history-reverted",
  ]),
  originalChars: NonNegativeInt,
  sentChars: NonNegativeInt,
  savedChars: NonNegativeInt,
  sourceHash: Schema.NullOr(Schema.String),
  sourceMessageCount: NonNegativeInt,
});
export type ConversationHandoffReport = typeof ConversationHandoffReport.Type;
