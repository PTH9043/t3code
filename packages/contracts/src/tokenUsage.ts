import * as Schema from "effect/Schema";
import { PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const TokenUsagePhase = Schema.Literals([
  "general",
  "discussion",
  "planning",
  "implementation",
  "verification",
  "finalization",
]);
export type TokenUsagePhase = typeof TokenUsagePhase.Type;

/** Assigned by the orchestration reactor, never inferred from prompt text. */
export const TokenUsageContext = Schema.Struct({
  workId: TrimmedNonEmptyString,
  phase: TokenUsagePhase,
  nodeId: Schema.NullOr(TrimmedNonEmptyString),
  attempt: PositiveInt,
});
export type TokenUsageContext = typeof TokenUsageContext.Type;
