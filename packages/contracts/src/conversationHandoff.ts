import * as Schema from "effect/Schema";
import { NonNegativeInt } from "./baseSchemas.ts";

/** Absent on older threads/servers; adaptive capsule is now preferred for new handoffs. */
export const ConversationHandoffMode = Schema.Literals(["standard", "compact", "adaptive"]);
export type ConversationHandoffMode = typeof ConversationHandoffMode.Type;

export const ConversationHandoffReport = Schema.Struct({
  version: Schema.Literal(1),
  status: Schema.Literals(["compact", "adaptive", "fallback"]),
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

/** Metadata for a handoff included in a request accepted by the provider. */
export const ConversationHandoffDelivery = Schema.Struct({
  backend: Schema.Literals(["workspace-memory", "projection"]),
  requestedMode: ConversationHandoffMode,
  chars: NonNegativeInt,
  archiveAttached: Schema.optionalKey(Schema.Boolean),
  compactReport: Schema.optionalKey(ConversationHandoffReport),
});
export type ConversationHandoffDelivery = typeof ConversationHandoffDelivery.Type;
