import * as Schema from "effect/Schema";
import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const HostApprovalStatus = Schema.Literals([
  "pending",
  "approved",
  "rejected",
  "invalidated",
  "executed",
  "outcome_unknown",
]);
export type HostApprovalStatus = typeof HostApprovalStatus.Type;

export const HostApprovalRequesterRole = Schema.Literals(["agent", "workflow", "routine"]);
export type HostApprovalRequesterRole = typeof HostApprovalRequesterRole.Type;

export const HostApprovalDeciderRole = Schema.Literals(["human", "agent", "system"]);
export type HostApprovalDeciderRole = typeof HostApprovalDeciderRole.Type;

/**
 * Digest-bound approval target: changing a single byte of action, resource,
 * revision, or args after requesting approval invalidates any prior approval.
 */
export const HostApprovalTarget = Schema.Struct({
  action: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  resource: TrimmedNonEmptyString.check(Schema.isMaxLength(1024)),
  revision: Schema.String.check(Schema.isMaxLength(256)),
  args: Schema.Unknown,
});
export type HostApprovalTarget = typeof HostApprovalTarget.Type;

export const HostApprovalRecord = Schema.Struct({
  approvalId: TrimmedNonEmptyString,
  threadId: Schema.NullOr(Schema.String),
  requesterActorId: TrimmedNonEmptyString,
  requesterRole: HostApprovalRequesterRole,
  target: HostApprovalTarget,
  targetDigest: TrimmedNonEmptyString,
  status: HostApprovalStatus,
  decidedBy: Schema.NullOr(Schema.String),
  decidedRole: Schema.NullOr(HostApprovalDeciderRole),
  reason: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type HostApprovalRecord = typeof HostApprovalRecord.Type;

export const HostAuditEventKind = Schema.Literals([
  "approval.requested",
  "approval.approved",
  "approval.rejected",
  "approval.invalidated",
  "approval.self_approval_blocked",
  "approval.executed",
  "approval.outcome_unknown",
  "approval.outcome_reconciled",
  "spec.pinned",
  "spec.tampered",
  "spec.waived",
  "spec.checker_approved",
  "spec.checker_blocked",
  "spec.self_approval_blocked",
  "security.ssrf_blocked",
  "security.secret_scrubbed",
]);
export type HostAuditEventKind = typeof HostAuditEventKind.Type;

export const HostAuditLedgerEntry = Schema.Struct({
  seq: NonNegativeInt,
  entryId: TrimmedNonEmptyString,
  kind: HostAuditEventKind,
  actorId: TrimmedNonEmptyString,
  actorKind: Schema.Literals(["human", "agent", "host"]),
  resource: Schema.String,
  payloadJson: Schema.String,
  prevHash: Schema.String,
  entryHash: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
});
export type HostAuditLedgerEntry = typeof HostAuditLedgerEntry.Type;

export const HostAuditChainVerification = Schema.Struct({
  valid: Schema.Boolean,
  totalEntries: NonNegativeInt,
  corruptedSeq: Schema.NullOr(NonNegativeInt),
  reason: Schema.NullOr(Schema.String),
});
export type HostAuditChainVerification = typeof HostAuditChainVerification.Type;
