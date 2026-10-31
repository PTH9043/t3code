import * as Schema from "effect/Schema";
import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

/** Cache reads/writes are subsets of input; reasoning is a subset of output. */
const Count = NonNegativeInt.check(Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER));
export const TokenCounts = Schema.Struct({
  total: Schema.NullOr(Count),
  input: Schema.NullOr(Count),
  output: Schema.NullOr(Count),
  cacheRead: Schema.NullOr(Count),
  cacheWrite: Schema.NullOr(Count),
  cacheWrite5m: Schema.optional(Count),
  cacheWrite1h: Schema.optional(Count),
  reasoning: Schema.NullOr(Count),
});
export type TokenCounts = typeof TokenCounts.Type;

/** Native accounting evidence, independent of the context-window display. */
export const TokenUsageObservation = Schema.Struct({
  startsAtZero: Schema.optional(Schema.Boolean),
  isFinal: Schema.optional(Schema.Boolean),
  sourceId: TrimmedNonEmptyString,
  mode: Schema.Literals(["cumulative", "execution-total"]),
  provider: TrimmedNonEmptyString,
  model: Schema.NullOr(TrimmedNonEmptyString),
  counts: TokenCounts,
});
export type TokenUsageObservation = typeof TokenUsageObservation.Type;

export const TokenUsagePhase = Schema.Literals([
  "general",
  "discussion",
  "planning",
  "implementation",
  "verification",
  "finalization",
  "format-repair",
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

export const TokenUsageIssue = Schema.Literals([
  "baseline-required",
  "counter-regressed",
  "unreported",
  "native-child-coverage-unknown",
  "final-usage-unconfirmed",
]);
export type TokenUsageIssue = typeof TokenUsageIssue.Type;
export const TokenUsageCoverage = Schema.Literals([
  "before-collection",
  "unavailable",
  "partial",
  "reported",
]);
export type TokenUsageCoverage = typeof TokenUsageCoverage.Type;

export const TokenUsageBreakdown = Schema.Struct({
  provider: Schema.String,
  model: Schema.String,
  phase: TokenUsagePhase,
  attempt: PositiveInt,
  counts: TokenCounts,
  issues: Schema.Array(TokenUsageIssue),
});
export type TokenUsageBreakdown = typeof TokenUsageBreakdown.Type;
export const TokenUsageSummary = Schema.Struct({
  counts: TokenCounts,
  breakdown: Schema.Array(TokenUsageBreakdown),
  issues: Schema.Array(TokenUsageIssue),
  coverage: TokenUsageCoverage,
  inProgress: Schema.Boolean,
  requestCount: NonNegativeInt,
  reportedRequestCount: NonNegativeInt,
});
export type TokenUsageSummary = typeof TokenUsageSummary.Type;
export const TokenUsageWork = Schema.Struct({
  workId: Schema.String,
  requestedAt: IsoDateTime,
  sequence: NonNegativeInt,
});
export type TokenUsageWork = typeof TokenUsageWork.Type;
export const GetThreadTokenUsageInput = Schema.Struct({
  nodeId: Schema.optional(TrimmedNonEmptyString),
  threadId: ThreadId,
  workId: Schema.optional(TrimmedNonEmptyString),
  beforeSequence: Schema.optional(NonNegativeInt),
});
export type GetThreadTokenUsageInput = typeof GetThreadTokenUsageInput.Type;
export const ThreadTokenUsageReport = Schema.Struct({
  requestCount: Schema.optional(NonNegativeInt),
  reportedRequestCount: Schema.optional(NonNegativeInt),
  finality: Schema.Literals(["provisional", "final"]),
  outcome: Schema.Literals(["running", "completed", "failed", "interrupted", "unknown"]),
  verificationStatus: Schema.Literal("not-evaluated"),
  collectedSince: Schema.String,
  coverage: TokenUsageCoverage,
  work: Schema.NullOr(TokenUsageWork),
  counts: TokenCounts,
  breakdown: Schema.Array(TokenUsageBreakdown),
  issues: Schema.Array(TokenUsageIssue),
  inProgress: Schema.Boolean,
  recentWorks: Schema.Array(TokenUsageWork),
  nextBeforeSequence: Schema.NullOr(NonNegativeInt),
});
export type ThreadTokenUsageReport = typeof ThreadTokenUsageReport.Type;
