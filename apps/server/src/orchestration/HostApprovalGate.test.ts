import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { expect, it } from "@effect/vitest";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import {
  decideHostApproval,
  markApprovalOutcome,
  requestHostApproval,
  verifyApprovalBeforeExecution,
  verifyHostAuditChain,
} from "./HostApprovalGate.ts";

it.effect(
  "enforces digest binding, blocks agent self-approval, blocks retries after outcome_unknown, and detects audit chain tampering",
  () =>
    Effect.gen(function* () {
      const target = {
        action: "git.merge_pr",
        resource: "repo/t3code#42",
        revision: "abc1234",
        args: { squash: true },
      };

      const req = yield* requestHostApproval({
        requesterActorId: "agent-codex-1",
        requesterRole: "agent",
        target,
      });
      expect(req.status).toBe("pending");

      // 1) Agent attempting to forge approval as non-human or self must be rejected.
      const agentTry = yield* decideHostApproval({
        approvalId: req.approvalId,
        decision: "approved",
        decidedBy: "agent-codex-1",
        decidedRole: "agent",
      });
      expect(agentTry.ok).toBe(false);
      if (!agentTry.ok) expect(agentTry.code).toBe("non_human_decider_rejected");

      const selfTry = yield* decideHostApproval({
        approvalId: req.approvalId,
        decision: "approved",
        decidedBy: "agent-codex-1",
        decidedRole: "human",
      });
      expect(selfTry.ok).toBe(false);
      if (!selfTry.ok) expect(selfTry.code).toBe("self_approval_rejected");

      // 2) Legitimate human approval passes when target is untouched.
      const humanOk = yield* decideHostApproval({
        approvalId: req.approvalId,
        decision: "approved",
        decidedBy: "human-operator",
        decidedRole: "human",
      });
      expect(humanOk.ok).toBe(true);

      const exactCheck = yield* verifyApprovalBeforeExecution({
        approvalId: req.approvalId,
        liveTarget: target,
      });
      expect(exactCheck.allowed).toBe(true);

      // 3) Changing a single byte in revision or args invalidates prior approval.
      const driftedCheck = yield* verifyApprovalBeforeExecution({
        approvalId: req.approvalId,
        liveTarget: { ...target, revision: "abc1235" },
      });
      expect(driftedCheck.allowed).toBe(false);
      if (!driftedCheck.allowed) expect(driftedCheck.code).toBe("digest_mismatch_invalidated");

      // 4) New request ending in outcome_unknown permanently blocks automatic retries.
      const req2 = yield* requestHostApproval({
        requesterActorId: "routine-nightly",
        requesterRole: "routine",
        target,
      });
      yield* decideHostApproval({
        approvalId: req2.approvalId,
        decision: "approved",
        decidedBy: "human-operator",
        decidedRole: "human",
      });
      yield* markApprovalOutcome({
        approvalId: req2.approvalId,
        outcome: "outcome_unknown",
        detail: "Transport timeout during remote write",
      });
      const retryBlocked = yield* verifyApprovalBeforeExecution({
        approvalId: req2.approvalId,
        liveTarget: target,
      });
      expect(retryBlocked.allowed).toBe(false);
      if (!retryBlocked.allowed) expect(retryBlocked.code).toBe("outcome_unknown_retry_blocked");

      // 5) Hash chain validates cleanly before tampering and pinpoints corrupted row after tampering.
      const cleanChain = yield* verifyHostAuditChain();
      expect(cleanChain.valid).toBe(true);
      expect(cleanChain.totalEntries).toBeGreaterThanOrEqual(6);

      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE host_audit_chain SET resource = 'tampered/resource' WHERE seq = 2`;
      const brokenChain = yield* verifyHostAuditChain();
      expect(brokenChain.valid).toBe(false);
      expect(brokenChain.corruptedSeq).toBe(2);
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
);
