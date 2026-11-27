import * as Schema from "effect/Schema";
import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const PinnedSpecBody = Schema.Struct({
  specId: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  category: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  description: TrimmedNonEmptyString.check(Schema.isMaxLength(4000)),
  steps: Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(1000))),
  prerequisites: Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(500))),
  doneWhen: TrimmedNonEmptyString.check(Schema.isMaxLength(2000)),
});
export type PinnedSpecBody = typeof PinnedSpecBody.Type;

export const PinnedTaskSpec = Schema.Struct({
  specId: TrimmedNonEmptyString,
  threadId: Schema.NullOr(Schema.String),
  producerActorId: TrimmedNonEmptyString,
  producerSessionId: Schema.NullOr(Schema.String),
  body: PinnedSpecBody,
  specHash: TrimmedNonEmptyString,
  prerequisitesMet: Schema.Boolean,
  executedRunId: Schema.NullOr(Schema.String),
  waived: Schema.Boolean,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type PinnedTaskSpec = typeof PinnedTaskSpec.Type;

export const SpecCheckerDecision = Schema.Literals(["approve", "block", "hold"]);
export type SpecCheckerDecision = typeof SpecCheckerDecision.Type;

export const SpecCheckerVerdict = Schema.Struct({
  verdictId: TrimmedNonEmptyString,
  specId: TrimmedNonEmptyString,
  specHash: TrimmedNonEmptyString,
  checkerActorId: TrimmedNonEmptyString,
  checkerSessionId: Schema.NullOr(Schema.String),
  decision: SpecCheckerDecision,
  evidence: TrimmedNonEmptyString.check(Schema.isMaxLength(4000)),
  checkedAt: IsoDateTime,
});
export type SpecCheckerVerdict = typeof SpecCheckerVerdict.Type;

export const SpecGateOutcome = Schema.Literals([
  "pass",
  "refused_self_approval",
  "refused_tampered",
  "refused_unmet_prereqs",
  "refused_not_executed",
  "refused_missing_checker",
  "refused_checker_blocked",
  "waived",
]);
export type SpecGateOutcome = typeof SpecGateOutcome.Type;

export const SpecProofSummary = Schema.Struct({
  specId: TrimmedNonEmptyString,
  outcome: SpecGateOutcome,
  checkerActorId: Schema.optionalKey(Schema.String),
  summary: Schema.String,
});
export type SpecProofSummary = typeof SpecProofSummary.Type;
