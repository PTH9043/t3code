// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import type {
  HostApprovalDeciderRole,
  HostApprovalRecord,
  HostApprovalRequesterRole,
  HostApprovalStatus,
  HostApprovalTarget,
  HostAuditChainVerification,
  HostAuditEventKind,
  HostAuditLedgerEntry,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const GENESIS_PREV_HASH = "0".repeat(64);

/** Deterministic canonical JSON serialization with sorted object keys. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export function sha256Hex(text: string): string {
  return NodeCrypto.createHash("sha256").update(text, "utf8").digest("hex");
}

export function computeApprovalTargetDigest(target: HostApprovalTarget): string {
  return sha256Hex(
    canonicalJson({
      action: target.action,
      resource: target.resource,
      revision: target.revision,
      args: target.args,
    }),
  );
}

function computeAuditEntryHash(input: {
  readonly entryId: string;
  readonly kind: HostAuditEventKind;
  readonly actorId: string;
  readonly actorKind: "human" | "agent" | "host";
  readonly resource: string;
  readonly payloadJson: string;
  readonly prevHash: string;
  readonly createdAt: string;
}): string {
  return sha256Hex(
    canonicalJson({
      entryId: input.entryId,
      kind: input.kind,
      actorId: input.actorId,
      actorKind: input.actorKind,
      resource: input.resource,
      payloadJson: input.payloadJson,
      prevHash: input.prevHash,
      createdAt: input.createdAt,
    }),
  );
}

export const appendHostAuditEntry = Effect.fn("HostApprovalGate.appendHostAuditEntry")(
  function* (input: {
    readonly kind: HostAuditEventKind;
    readonly actorId: string;
    readonly actorKind: "human" | "agent" | "host";
    readonly resource: string;
    readonly payload: unknown;
    readonly nowIso?: string;
  }) {
    const sql = yield* SqlClient.SqlClient;
    const createdAt = input.nowIso ?? DateTime.formatIso(yield* DateTime.now);
    const entryId = `aud_${NodeCrypto.randomUUID()}`;
    const payloadJson = canonicalJson(input.payload);
    const tail = yield* sql<{ entry_hash: string }>`
    SELECT entry_hash FROM host_audit_chain ORDER BY seq DESC LIMIT 1
  `;
    const prevHash = tail[0]?.entry_hash ?? GENESIS_PREV_HASH;
    const entryHash = computeAuditEntryHash({
      entryId,
      kind: input.kind,
      actorId: input.actorId,
      actorKind: input.actorKind,
      resource: input.resource,
      payloadJson,
      prevHash,
      createdAt,
    });

    yield* sql`INSERT INTO host_audit_chain (
    entry_id, kind, actor_id, actor_kind, resource, payload_json, prev_hash, entry_hash, created_at
  ) VALUES (
    ${entryId}, ${input.kind}, ${input.actorId}, ${input.actorKind}, ${input.resource},
    ${payloadJson}, ${prevHash}, ${entryHash}, ${createdAt}
  )`;

    const inserted = yield* sql<{ seq: number }>`
    SELECT seq FROM host_audit_chain WHERE entry_id = ${entryId} LIMIT 1
  `;

    return {
      seq: inserted[0]?.seq ?? 0,
      entryId,
      kind: input.kind,
      actorId: input.actorId,
      actorKind: input.actorKind,
      resource: input.resource,
      payloadJson,
      prevHash,
      entryHash,
      createdAt,
    };
  },
);

export const verifyHostAuditChain = Effect.fn("HostApprovalGate.verifyHostAuditChain")(
  function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{
      seq: number;
      entry_id: string;
      kind: HostAuditEventKind;
      actor_id: string;
      actor_kind: "human" | "agent" | "host";
      resource: string;
      payload_json: string;
      prev_hash: string;
      entry_hash: string;
      created_at: string;
    }>`SELECT seq, entry_id, kind, actor_id, actor_kind, resource, payload_json, prev_hash, entry_hash, created_at
     FROM host_audit_chain ORDER BY seq ASC`;

    let expectedPrev = GENESIS_PREV_HASH;
    for (const row of rows) {
      if (row.prev_hash !== expectedPrev) {
        return {
          valid: false,
          totalEntries: rows.length,
          corruptedSeq: row.seq,
          reason: `prev_hash mismatch at seq=${row.seq}`,
        };
      }
      const recomputed = computeAuditEntryHash({
        entryId: row.entry_id,
        kind: row.kind,
        actorId: row.actor_id,
        actorKind: row.actor_kind,
        resource: row.resource,
        payloadJson: row.payload_json,
        prevHash: row.prev_hash,
        createdAt: row.created_at,
      });
      if (recomputed !== row.entry_hash) {
        return {
          valid: false,
          totalEntries: rows.length,
          corruptedSeq: row.seq,
          reason: `entry_hash mismatch at seq=${row.seq}`,
        };
      }
      expectedPrev = row.entry_hash;
    }

    return {
      valid: true,
      totalEntries: rows.length,
      corruptedSeq: null,
      reason: null,
    };
  },
);

interface ApprovalDbRow {
  approval_id: string;
  thread_id: string | null;
  requester_actor_id: string;
  requester_role: HostApprovalRequesterRole;
  target_json: string;
  target_digest: string;
  status: HostApprovalStatus;
  decided_by: string | null;
  decided_role: HostApprovalDeciderRole | null;
  reason: string | null;
  created_at: string;
  updated_at: string;
}

function rowToRecord(row: ApprovalDbRow): HostApprovalRecord {
  return {
    approvalId: row.approval_id,
    threadId: row.thread_id,
    requesterActorId: row.requester_actor_id,
    requesterRole: row.requester_role,
    target: JSON.parse(row.target_json) as HostApprovalTarget,
    targetDigest: row.target_digest,
    status: row.status,
    decidedBy: row.decided_by,
    decidedRole: row.decided_role,
    reason: row.reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export const requestHostApproval = Effect.fn("HostApprovalGate.requestHostApproval")(
  function* (input: {
    readonly approvalId?: string;
    readonly threadId?: string | null;
    readonly requesterActorId: string;
    readonly requesterRole: HostApprovalRequesterRole;
    readonly target: HostApprovalTarget;
    readonly nowIso?: string;
  }) {
    const sql = yield* SqlClient.SqlClient;
    const nowIso = input.nowIso ?? DateTime.formatIso(yield* DateTime.now);
    const approvalId = input.approvalId ?? `apr_${NodeCrypto.randomUUID()}`;
    const targetDigest = computeApprovalTargetDigest(input.target);
    const targetJson = canonicalJson(input.target);

    yield* sql`INSERT INTO host_approvals (
    approval_id, thread_id, requester_actor_id, requester_role, target_json, target_digest,
    status, decided_by, decided_role, reason, created_at, updated_at
  ) VALUES (
    ${approvalId}, ${input.threadId ?? null}, ${input.requesterActorId}, ${input.requesterRole},
    ${targetJson}, ${targetDigest}, 'pending', NULL, NULL, NULL, ${nowIso}, ${nowIso}
  )`;

    yield* appendHostAuditEntry({
      kind: "approval.requested",
      actorId: input.requesterActorId,
      actorKind: "agent",
      resource: input.target.resource,
      payload: { approvalId, action: input.target.action, targetDigest },
      nowIso,
    });

    return {
      approvalId,
      threadId: input.threadId ?? null,
      requesterActorId: input.requesterActorId,
      requesterRole: input.requesterRole,
      target: input.target,
      targetDigest,
      status: "pending",
      decidedBy: null,
      decidedRole: null,
      reason: null,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
  },
);

export type DecideApprovalResult =
  | { readonly ok: true; readonly record: HostApprovalRecord }
  | {
      readonly ok: false;
      readonly code:
        | "not_found"
        | "not_pending"
        | "self_approval_rejected"
        | "non_human_decider_rejected";
      readonly message: string;
    };

/**
 * Host-enforced HITL decision gate:
 * 1) Rejects any non-human decider (prevents agents injecting `decided_by: user` via payload).
 * 2) Rejects self-approval when `decidedBy === requesterActorId`.
 */
export const decideHostApproval = Effect.fn("HostApprovalGate.decideHostApproval")(
  function* (input: {
    readonly approvalId: string;
    readonly decision: "approved" | "rejected";
    readonly decidedBy: string;
    readonly decidedRole: HostApprovalDeciderRole;
    readonly reason?: string;
    readonly nowIso?: string;
  }) {
    const sql = yield* SqlClient.SqlClient;
    const nowIso = input.nowIso ?? DateTime.formatIso(yield* DateTime.now);
    const rows = yield* sql<ApprovalDbRow>`
    SELECT * FROM host_approvals WHERE approval_id = ${input.approvalId} LIMIT 1
  `;
    const existing = rows[0];
    if (!existing) {
      return { ok: false, code: "not_found", message: `Approval ${input.approvalId} not found.` };
    }
    if (existing.status !== "pending") {
      return {
        ok: false,
        code: "not_pending",
        message: `Approval ${input.approvalId} is in '${existing.status}' state and cannot be decided.`,
      };
    }
    if (input.decision === "approved" && input.decidedRole !== "human") {
      yield* appendHostAuditEntry({
        kind: "approval.self_approval_blocked",
        actorId: input.decidedBy,
        actorKind: "host",
        resource: rowToRecord(existing).target.resource,
        payload: {
          approvalId: input.approvalId,
          decidedRole: input.decidedRole,
          reason: "non_human_decider_rejected",
        },
        nowIso,
      });
      return {
        ok: false,
        code: "non_human_decider_rejected",
        message: "Only a verified host human operator can approve irreversible actions.",
      };
    }
    if (input.decision === "approved" && input.decidedBy === existing.requester_actor_id) {
      yield* appendHostAuditEntry({
        kind: "approval.self_approval_blocked",
        actorId: input.decidedBy,
        actorKind: "host",
        resource: rowToRecord(existing).target.resource,
        payload: {
          approvalId: input.approvalId,
          requesterActorId: existing.requester_actor_id,
          reason: "self_approval_rejected",
        },
        nowIso,
      });
      return {
        ok: false,
        code: "self_approval_rejected",
        message: "Requester cannot self-approve its own approval request.",
      };
    }

    yield* sql`UPDATE host_approvals
    SET status = ${input.decision},
        decided_by = ${input.decidedBy},
        decided_role = ${input.decidedRole},
        reason = ${input.reason ?? null},
        updated_at = ${nowIso}
    WHERE approval_id = ${input.approvalId}`;

    const updated = rowToRecord({
      ...existing,
      status: input.decision,
      decided_by: input.decidedBy,
      decided_role: input.decidedRole,
      reason: input.reason ?? null,
      updated_at: nowIso,
    });

    yield* appendHostAuditEntry({
      kind: input.decision === "approved" ? "approval.approved" : "approval.rejected",
      actorId: input.decidedBy,
      actorKind: input.decidedRole === "human" ? "human" : "host",
      resource: updated.target.resource,
      payload: {
        approvalId: input.approvalId,
        targetDigest: updated.targetDigest,
        reason: input.reason ?? null,
      },
      nowIso,
    });

    return { ok: true, record: updated };
  },
);

export type ExecutionGateCheckResult =
  | { readonly allowed: true; readonly record: HostApprovalRecord }
  | {
      readonly allowed: false;
      readonly code:
        | "not_found"
        | "not_approved"
        | "digest_mismatch_invalidated"
        | "outcome_unknown_retry_blocked"
        | "already_executed";
      readonly message: string;
    };

/**
 * Verifies digest binding immediately prior to executing a sensitive action:
 * - Blocks automatic retries after `outcome_unknown` (prevents duplicate side effects).
 * - Invalidates approval if the execution target drifted by even 1 byte.
 */
export const verifyApprovalBeforeExecution = Effect.fn(
  "HostApprovalGate.verifyApprovalBeforeExecution",
)(function* (input: {
  readonly approvalId: string;
  readonly liveTarget: HostApprovalTarget;
  readonly nowIso?: string;
}) {
  const sql = yield* SqlClient.SqlClient;
  const nowIso = input.nowIso ?? DateTime.formatIso(yield* DateTime.now);
  const rows = yield* sql<ApprovalDbRow>`
    SELECT * FROM host_approvals WHERE approval_id = ${input.approvalId} LIMIT 1
  `;
  const existing = rows[0];
  if (!existing) {
    return {
      allowed: false,
      code: "not_found",
      message: `Approval ${input.approvalId} not found.`,
    };
  }
  if (existing.status === "outcome_unknown") {
    return {
      allowed: false,
      code: "outcome_unknown_retry_blocked",
      message:
        "Prior execution ended in outcome_unknown; automatic retry is permanently blocked until a human reconciles external state.",
    };
  }
  if (existing.status === "executed") {
    return {
      allowed: false,
      code: "already_executed",
      message: `Approval ${input.approvalId} was already executed.`,
    };
  }
  if (existing.status !== "approved") {
    return {
      allowed: false,
      code: "not_approved",
      message: `Approval ${input.approvalId} status is '${existing.status}', expected 'approved'.`,
    };
  }

  const liveDigest = computeApprovalTargetDigest(input.liveTarget);
  if (liveDigest !== existing.target_digest) {
    yield* sql`UPDATE host_approvals
      SET status = 'invalidated',
          reason = 'Target digest drifted between approval and execution',
          updated_at = ${nowIso}
      WHERE approval_id = ${input.approvalId}`;
    yield* appendHostAuditEntry({
      kind: "approval.invalidated",
      actorId: "host-control-plane",
      actorKind: "host",
      resource: input.liveTarget.resource,
      payload: {
        approvalId: input.approvalId,
        expectedDigest: existing.target_digest,
        liveDigest,
      },
      nowIso,
    });
    return {
      allowed: false,
      code: "digest_mismatch_invalidated",
      message: "Approval invalidated: target resource/revision/args changed after approval.",
    };
  }

  return { allowed: true, record: rowToRecord(existing) };
});

export const markApprovalOutcome = Effect.fn("HostApprovalGate.markApprovalOutcome")(
  function* (input: {
    readonly approvalId: string;
    readonly outcome: "executed" | "outcome_unknown";
    readonly detail?: string;
    readonly nowIso?: string;
  }) {
    const sql = yield* SqlClient.SqlClient;
    const nowIso = input.nowIso ?? DateTime.formatIso(yield* DateTime.now);
    const rows = yield* sql<ApprovalDbRow>`
    SELECT * FROM host_approvals WHERE approval_id = ${input.approvalId} LIMIT 1
  `;
    const existing = rows[0];
    if (!existing) return;

    yield* sql`UPDATE host_approvals
    SET status = ${input.outcome},
        reason = ${input.detail ?? existing.reason},
        updated_at = ${nowIso}
    WHERE approval_id = ${input.approvalId}`;

    yield* appendHostAuditEntry({
      kind: input.outcome === "executed" ? "approval.executed" : "approval.outcome_unknown",
      actorId: "host-control-plane",
      actorKind: "host",
      resource: rowToRecord(existing).target.resource,
      payload: { approvalId: input.approvalId, detail: input.detail ?? null },
      nowIso,
    });
  },
);
