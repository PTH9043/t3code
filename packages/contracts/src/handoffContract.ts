import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const HandoffWritePolicy = Schema.Literals(["read", "draft", "human-approved"]);
export type HandoffWritePolicy = typeof HandoffWritePolicy.Type;

export const HandoffEvidenceOrBlocker = Schema.Struct({
  observed_facts: Schema.Array(Schema.String),
  assumptions: Schema.Array(Schema.String),
  unverified_claims: Schema.Array(Schema.String),
});
export type HandoffEvidenceOrBlocker = typeof HandoffEvidenceOrBlocker.Type;

/**
 * Transcript-free 6-field handoff contract (adapted from grok-bot-architecture):
 * Forces structured references (disk paths / artifact IDs) instead of raw chat dumps
 * and explicitly declares write boundaries and verified vs. unverified evidence.
 */
export const HandoffEnvelopeV1 = Schema.Struct({
  owner: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  goal: TrimmedNonEmptyString.check(Schema.isMaxLength(2000)),
  refs: Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(512))).check(
    Schema.isMaxLength(32),
  ),
  write_policy: HandoffWritePolicy,
  done_when: TrimmedNonEmptyString.check(Schema.isMaxLength(2000)),
  evidence_or_blocker: HandoffEvidenceOrBlocker,
});
export type HandoffEnvelopeV1 = typeof HandoffEnvelopeV1.Type;

const SECRET_IN_HANDOFF_PATTERN =
  /\b(?:sk-(?:or-v1-|proj-|ant-)?[A-Za-z0-9_-]{16,}|(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|xai-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._~+/=-]{16,})\b/i;

export function validateHandoffEnvelope(envelope: HandoffEnvelopeV1): {
  readonly valid: boolean;
  readonly errors: ReadonlyArray<string>;
} {
  const errors: string[] = [];
  if (!envelope.owner.trim()) errors.push("owner is required.");
  if (!envelope.goal.trim()) errors.push("goal is required.");
  if (!envelope.done_when.trim()) errors.push("done_when is required.");
  const combined = [
    envelope.goal,
    envelope.done_when,
    ...envelope.refs,
    ...envelope.evidence_or_blocker.observed_facts,
    ...envelope.evidence_or_blocker.assumptions,
    ...envelope.evidence_or_blocker.unverified_claims,
  ].join("\n");
  if (SECRET_IN_HANDOFF_PATTERN.test(combined)) {
    errors.push("Handoff payload contains raw secret/token material; pass disk/vault refs only.");
  }
  return { valid: errors.length === 0, errors };
}

export function formatHandoffEnvelopeForPrompt(envelope: HandoffEnvelopeV1): string {
  const lines = [
    '<t3_handoff_contract version="1">',
    `- owner: ${envelope.owner}`,
    `- goal: ${envelope.goal}`,
    `- write_policy: ${envelope.write_policy}${envelope.write_policy === "read" ? " (DO NOT edit files or execute destructive writes)" : ""}`,
    `- done_when: ${envelope.done_when}`,
    ...(envelope.refs.length > 0 ? [`- refs: ${envelope.refs.join(", ")}`] : []),
    ...(envelope.evidence_or_blocker.observed_facts.length > 0
      ? [`- observed_facts: ${envelope.evidence_or_blocker.observed_facts.join(" | ")}`]
      : []),
    ...(envelope.evidence_or_blocker.assumptions.length > 0
      ? [`- assumptions: ${envelope.evidence_or_blocker.assumptions.join(" | ")}`]
      : []),
    ...(envelope.evidence_or_blocker.unverified_claims.length > 0
      ? [`- unverified_claims: ${envelope.evidence_or_blocker.unverified_claims.join(" | ")}`]
      : []),
    "</t3_handoff_contract>",
  ];
  return lines.join("\n");
}
