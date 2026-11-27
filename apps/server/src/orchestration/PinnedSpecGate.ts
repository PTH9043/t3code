// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import type {
  PinnedSpecBody,
  PinnedTaskSpec,
  SpecCheckerDecision,
  SpecCheckerVerdict,
  SpecGateOutcome,
  SpecProofSummary,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { appendHostAuditEntry, canonicalJson, sha256Hex } from "./HostApprovalGate.ts";

export function computePinnedSpecHash(body: PinnedSpecBody): string {
  return sha256Hex(
    canonicalJson({
      specId: body.specId,
      category: body.category,
      description: body.description,
      steps: body.steps,
      prerequisites: body.prerequisites,
      doneWhen: body.doneWhen,
    }),
  );
}

interface SpecDbRow {
  spec_id: string;
  thread_id: string | null;
  producer_actor_id: string;
  producer_session_id: string | null;
  body_json: string;
  spec_hash: string;
  prerequisites_met: number;
  executed_run_id: string | null;
  waived: number;
  created_at: string;
  updated_at: string;
}

interface VerdictDbRow {
  verdict_id: string;
  spec_id: string;
  spec_hash: string;
  checker_actor_id: string;
  checker_session_id: string | null;
  decision: SpecCheckerDecision;
  evidence: string;
  checked_at: string;
}

function rowToSpec(row: SpecDbRow): PinnedTaskSpec {
  return {
    specId: row.spec_id,
    threadId: row.thread_id,
    producerActorId: row.producer_actor_id,
    producerSessionId: row.producer_session_id,
    body: JSON.parse(row.body_json) as PinnedSpecBody,
    specHash: row.spec_hash,
    prerequisitesMet: row.prerequisites_met === 1,
    executedRunId: row.executed_run_id,
    waived: row.waived === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export const pinTaskSpec = Effect.fn("PinnedSpecGate.pinTaskSpec")(function* (input: {
  readonly body: PinnedSpecBody;
  readonly producerActorId: string;
  readonly producerSessionId?: string | null;
  readonly threadId?: string | null;
  readonly prerequisitesMet?: boolean;
  readonly nowIso?: string;
}) {
  const sql = yield* SqlClient.SqlClient;
  const nowIso = input.nowIso ?? DateTime.formatIso(yield* DateTime.now);
  const specHash = computePinnedSpecHash(input.body);
  const bodyJson = canonicalJson(input.body);
  const prereqs = input.prerequisitesMet ? 1 : 0;

  yield* sql`INSERT INTO pinned_task_specs (
    spec_id, thread_id, producer_actor_id, producer_session_id, body_json, spec_hash,
    prerequisites_met, executed_run_id, waived, created_at, updated_at
  ) VALUES (
    ${input.body.specId}, ${input.threadId ?? null}, ${input.producerActorId},
    ${input.producerSessionId ?? null}, ${bodyJson}, ${specHash}, ${prereqs},
    NULL, 0, ${nowIso}, ${nowIso}
  )`;

  yield* appendHostAuditEntry({
    kind: "spec.pinned",
    actorId: input.producerActorId,
    actorKind: "agent",
    resource: input.body.specId,
    payload: { specId: input.body.specId, specHash, category: input.body.category },
    nowIso,
  });

  return {
    specId: input.body.specId,
    threadId: input.threadId ?? null,
    producerActorId: input.producerActorId,
    producerSessionId: input.producerSessionId ?? null,
    body: input.body,
    specHash,
    prerequisitesMet: Boolean(input.prerequisitesMet),
    executedRunId: null,
    waived: false,
    createdAt: nowIso,
    updatedAt: nowIso,
  };
});

export const bindSpecExecutionRun = Effect.fn("PinnedSpecGate.bindSpecExecutionRun")(
  function* (input: {
    readonly specId: string;
    readonly runId: string;
    readonly prerequisitesMet?: boolean;
    readonly nowIso?: string;
  }) {
    const sql = yield* SqlClient.SqlClient;
    const nowIso = input.nowIso ?? DateTime.formatIso(yield* DateTime.now);
    if (input.prerequisitesMet !== undefined) {
      yield* sql`UPDATE pinned_task_specs
      SET executed_run_id = ${input.runId},
          prerequisites_met = ${input.prerequisitesMet ? 1 : 0},
          updated_at = ${nowIso}
      WHERE spec_id = ${input.specId}`;
    } else {
      yield* sql`UPDATE pinned_task_specs
      SET executed_run_id = ${input.runId},
          updated_at = ${nowIso}
      WHERE spec_id = ${input.specId}`;
    }
  },
);

export const recordSpecWaived = Effect.fn("PinnedSpecGate.recordSpecWaived")(function* (input: {
  readonly specId: string;
  readonly actorId: string;
  readonly reason: string;
  readonly nowIso?: string;
}) {
  const sql = yield* SqlClient.SqlClient;
  const nowIso = input.nowIso ?? DateTime.formatIso(yield* DateTime.now);
  yield* sql`UPDATE pinned_task_specs SET waived = 1, updated_at = ${nowIso} WHERE spec_id = ${input.specId}`;
  yield* appendHostAuditEntry({
    kind: "spec.waived",
    actorId: input.actorId,
    actorKind: "human",
    resource: input.specId,
    payload: { specId: input.specId, reason: input.reason },
    nowIso,
  });
});

export type SubmitVerdictResult =
  | { readonly ok: true; readonly verdict: SpecCheckerVerdict }
  | {
      readonly ok: false;
      readonly outcome: "refused_self_approval" | "refused_tampered";
      readonly message: string;
    };

/**
 * Zero Self-Approval Enforcement:
 * Rejects any checker verdict whose actorId OR sessionId matches the spec's producer,
 * or whose verified hash no longer matches the pinned spec hash.
 */
export const submitIndependentCheckerVerdict = Effect.fn(
  "PinnedSpecGate.submitIndependentCheckerVerdict",
)(function* (input: {
  readonly specId: string;
  readonly observedBody: PinnedSpecBody;
  readonly checkerActorId: string;
  readonly checkerSessionId?: string | null;
  readonly decision: SpecCheckerDecision;
  readonly evidence: string;
  readonly nowIso?: string;
}) {
  const sql = yield* SqlClient.SqlClient;
  const nowIso = input.nowIso ?? DateTime.formatIso(yield* DateTime.now);
  const rows = yield* sql<SpecDbRow>`
    SELECT * FROM pinned_task_specs WHERE spec_id = ${input.specId} LIMIT 1
  `;
  const row = rows[0];
  if (!row) {
    return {
      ok: false,
      outcome: "refused_tampered",
      message: `Pinned spec ${input.specId} does not exist.`,
    };
  }

  const observedHash = computePinnedSpecHash(input.observedBody);
  if (observedHash !== row.spec_hash) {
    yield* appendHostAuditEntry({
      kind: "spec.tampered",
      actorId: input.checkerActorId,
      actorKind: "host",
      resource: input.specId,
      payload: { expectedHash: row.spec_hash, observedHash },
      nowIso,
    });
    return {
      ok: false,
      outcome: "refused_tampered",
      message: "Pinned spec hash mismatch: goal/criteria tampered after pinning.",
    };
  }

  const sameActor = input.checkerActorId === row.producer_actor_id;
  const sameSession =
    Boolean(input.checkerSessionId) &&
    Boolean(row.producer_session_id) &&
    input.checkerSessionId === row.producer_session_id;

  if (sameActor || sameSession) {
    yield* appendHostAuditEntry({
      kind: "spec.self_approval_blocked",
      actorId: input.checkerActorId,
      actorKind: "host",
      resource: input.specId,
      payload: {
        producerActorId: row.producer_actor_id,
        checkerActorId: input.checkerActorId,
        sameActor,
        sameSession,
      },
      nowIso,
    });
    return {
      ok: false,
      outcome: "refused_self_approval",
      message: "Zero Self-Approval violation: producer cannot verify or approve its own spec.",
    };
  }

  const verdictId = `vrd_${NodeCrypto.randomUUID()}`;
  yield* sql`INSERT INTO pinned_spec_verdicts (
    verdict_id, spec_id, spec_hash, checker_actor_id, checker_session_id,
    decision, evidence, checked_at
  ) VALUES (
    ${verdictId}, ${input.specId}, ${row.spec_hash}, ${input.checkerActorId},
    ${input.checkerSessionId ?? null}, ${input.decision}, ${input.evidence}, ${nowIso}
  )`;

  yield* appendHostAuditEntry({
    kind: input.decision === "approve" ? "spec.checker_approved" : "spec.checker_blocked",
    actorId: input.checkerActorId,
    actorKind: "agent",
    resource: input.specId,
    payload: { verdictId, decision: input.decision, specHash: row.spec_hash },
    nowIso,
  });

  return {
    ok: true,
    verdict: {
      verdictId,
      specId: input.specId,
      specHash: row.spec_hash,
      checkerActorId: input.checkerActorId,
      checkerSessionId: input.checkerSessionId ?? null,
      decision: input.decision,
      evidence: input.evidence,
      checkedAt: nowIso,
    },
  };
});

/**
 * Triple Completion Gate:
 * PASS requires ALL of:
 * 1) Unmodified spec hash (`observedBody` matches pinned hash),
 * 2) `prerequisitesMet === true`,
 * 3) Bound `executedRunId !== null`,
 * 4) Explicit `approve` verdict from an independent checker (never the producer).
 */
export const evaluateSpecCompletionGate = Effect.fn("PinnedSpecGate.evaluateSpecCompletionGate")(
  function* (input: { readonly specId: string; readonly observedBody: PinnedSpecBody }) {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<SpecDbRow>`
      SELECT * FROM pinned_task_specs WHERE spec_id = ${input.specId} LIMIT 1
    `;
    const row = rows[0];
    if (!row) {
      return {
        specId: input.specId,
        outcome: "refused_tampered",
        summary: "고정된 스펙 원장을 찾을 수 없습니다.",
      };
    }
    const spec = rowToSpec(row);
    if (spec.waived) {
      return {
        specId: spec.specId,
        outcome: "waived",
        summary: "스펙 게이트가 감사 로그(spec-waived)에 기록된 상태로 우회되었습니다.",
      };
    }

    const observedHash = computePinnedSpecHash(input.observedBody);
    if (observedHash !== spec.specHash) {
      return {
        specId: spec.specId,
        outcome: "refused_tampered",
        summary: "착수 시 고정한 스펙 해시와 현재 본문이 불일치해 완료를 거부했습니다.",
      };
    }
    if (!spec.prerequisitesMet) {
      return {
        specId: spec.specId,
        outcome: "refused_unmet_prereqs",
        summary: "선행 조건(prerequisites)이 충족되지 않아 완료를 거부했습니다.",
      };
    }
    if (!spec.executedRunId) {
      return {
        specId: spec.specId,
        outcome: "refused_not_executed",
        summary: "스펙에 바인딩된 실제 실행 이력이 없어 완료를 거부했습니다.",
      };
    }

    const verdicts = yield* sql<VerdictDbRow>`
      SELECT * FROM pinned_spec_verdicts
      WHERE spec_id = ${spec.specId} AND spec_hash = ${spec.specHash}
      ORDER BY checked_at DESC
    `;

    const independent = verdicts.find(
      (v) =>
        v.checker_actor_id !== spec.producerActorId &&
        (!v.checker_session_id || v.checker_session_id !== spec.producerSessionId),
    );
    if (!independent) {
      const outcome: SpecGateOutcome =
        verdicts.length > 0 ? "refused_self_approval" : "refused_missing_checker";
      return {
        specId: spec.specId,
        outcome,
        summary:
          outcome === "refused_self_approval"
            ? "생산자의 자기승인은 허용되지 않습니다. 독립 검증자의 판정이 필요합니다."
            : "독립 검증자(Checker)의 승인 판정이 없어 완료를 보류했습니다.",
      };
    }

    if (independent.decision !== "approve") {
      return {
        specId: spec.specId,
        outcome: "refused_checker_blocked",
        checkerActorId: independent.checker_actor_id,
        summary: `독립 검증자(${independent.checker_actor_id})가 '${independent.decision}' 판정을 내렸습니다.`,
      };
    }

    return {
      specId: spec.specId,
      outcome: "pass",
      checkerActorId: independent.checker_actor_id,
      summary: `독립 검증자(${independent.checker_actor_id})가 스펙 해시(${spec.specHash.slice(0, 8)}) 기준으로 승인했습니다.`,
    };
  },
);
