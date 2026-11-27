// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off
import * as NodeCrypto from "node:crypto";
import type {
  WorkerDecisionGateRecord,
  WorkerDecisionGateRisk,
  WorkerDecisionGateStatus,
  WorkerGateCreateInput,
  WorkerGateResolveInput,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { appendHostAuditEntry } from "../../orchestration/HostApprovalGate.ts";
import { WorkerEngineError, type WorkerEngineStore } from "./WorkerEngineStore.ts";
import type { WorkerMailboxService } from "./WorkerMailboxService.ts";

interface DecisionGateRow {
  readonly gate_id: string;
  readonly task_id: string;
  readonly dispatch_id: string | null;
  readonly thread_id: string;
  readonly risk_level: WorkerDecisionGateRisk;
  readonly question: string;
  readonly options_json: string;
  readonly status: WorkerDecisionGateStatus;
  readonly resolution: string | null;
  readonly resolved_by: string | null;
  readonly created_at_ms: number;
  readonly resolved_at_ms: number | null;
}

function rowToGate(row: DecisionGateRow): WorkerDecisionGateRecord {
  let options: string[] = [];
  try {
    const parsed = JSON.parse(row.options_json);
    if (Array.isArray(parsed)) {
      options = parsed.filter((v): v is string => typeof v === "string");
    }
  } catch {
    options = [];
  }
  return {
    gateId: row.gate_id,
    taskId: row.task_id,
    dispatchId: row.dispatch_id,
    threadId: row.thread_id,
    riskLevel: row.risk_level,
    question: row.question,
    options,
    status: row.status,
    resolution: row.resolution,
    resolvedBy: row.resolved_by,
    createdAtMs: Number(row.created_at_ms),
    resolvedAtMs: row.resolved_at_ms === null ? null : Number(row.resolved_at_ms),
  };
}

const mapSqlError = (operation: string) => (cause: unknown) =>
  new WorkerEngineError({
    code: "storage_error",
    message: `WorkerDecisionGateService.${operation} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
  });

export function makeWorkerDecisionGateService(
  sql: SqlClient.SqlClient,
  store: WorkerEngineStore,
  mailbox: WorkerMailboxService,
) {
  const bestEffortAudit = (input: {
    readonly kind: "approval.requested" | "approval.approved" | "approval.rejected";
    readonly actorId: string;
    readonly actorKind: "human" | "agent" | "host";
    readonly resource: string;
    readonly payload: unknown;
  }) =>
    appendHostAuditEntry(input).pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
      Effect.ignore,
    );

  const createGate = (
    input: WorkerGateCreateInput,
  ): Effect.Effect<WorkerDecisionGateRecord, WorkerEngineError> =>
    Effect.gen(function* () {
      const task = yield* store.getTask(input.taskId);
      if (!task) {
        return yield* new WorkerEngineError({
          code: "not_found",
          message: `Task '${input.taskId}' not found while creating decision gate.`,
        });
      }

      if (input.dispatchId && input.fencingToken !== undefined) {
        yield* store.assertActiveFencing(input.taskId, input.dispatchId, input.fencingToken);
      }

      const nowMs = yield* Clock.currentTimeMillis;
      const gateId = `gate_${NodeCrypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
      const options =
        input.options && input.options.length > 0 ? [...input.options] : ["approve", "deny"];

      const record = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`
              INSERT INTO worker_decision_gates (
                gate_id, task_id, dispatch_id, thread_id, risk_level,
                question, options_json, status, created_at_ms
              ) VALUES (
                ${gateId}, ${task.taskId}, ${input.dispatchId ?? task.activeDispatchId},
                ${task.threadId}, ${input.riskLevel}, ${input.question},
                ${JSON.stringify(options)}, 'open', ${nowMs}
              )
            `;
            yield* sql`
              UPDATE worker_tasks
              SET status = 'blocked', updated_at_ms = ${nowMs}
              WHERE task_id = ${task.taskId}
            `;
            const rows = yield* sql<DecisionGateRow>`
              SELECT * FROM worker_decision_gates WHERE gate_id = ${gateId} LIMIT 1
            `;
            return rowToGate(rows[0]!);
          }),
        )
        .pipe(Effect.mapError(mapSqlError("createGate")));

      yield* mailbox.postMessage({
        runId: task.runId,
        threadId: task.threadId,
        taskId: task.taskId,
        dispatchId: record.dispatchId,
        fencingToken: task.fencingEpoch,
        fromActor: record.dispatchId ? `dispatch:${record.dispatchId}` : `task:${task.taskId}`,
        toActor: `run:${task.runId}`,
        type: "decision_gate",
        outcome: "blocked",
        subject: `[승인 필요 · ${record.riskLevel}] ${record.question.slice(0, 120)}`,
        body: record.question,
        payload: {
          gateId: record.gateId,
          riskLevel: record.riskLevel,
          options: record.options,
        },
      });

      yield* bestEffortAudit({
        kind: "approval.requested",
        actorId: record.dispatchId ?? task.taskId,
        actorKind: "agent",
        resource: `worker_gate:${record.gateId}`,
        payload: {
          gateId: record.gateId,
          taskId: task.taskId,
          riskLevel: record.riskLevel,
          question: record.question,
        },
      });

      return record;
    });

  const resolveGate = (
    input: WorkerGateResolveInput,
  ): Effect.Effect<WorkerDecisionGateRecord, WorkerEngineError> =>
    Effect.gen(function* () {
      const existingRows = yield* sql<DecisionGateRow>`
        SELECT * FROM worker_decision_gates WHERE gate_id = ${input.gateId} LIMIT 1
      `.pipe(Effect.mapError(mapSqlError("resolveGate")));
      const existing = existingRows[0] ? rowToGate(existingRows[0]) : null;
      if (!existing) {
        return yield* new WorkerEngineError({
          code: "not_found",
          message: `Decision gate '${input.gateId}' not found.`,
        });
      }
      if (existing.status !== "open") {
        return yield* new WorkerEngineError({
          code: "invalid_state",
          message: `Decision gate '${input.gateId}' is already '${existing.status}'.`,
        });
      }

      const task = yield* store.getTask(existing.taskId);
      const nowMs = yield* Clock.currentTimeMillis;
      const nextGateStatus: WorkerDecisionGateStatus =
        input.decision === "approve" ? "approved" : "denied";
      const nextTaskStatus = input.decision === "approve" ? "ready" : "failed";
      const resolvedBy = input.resolvedBy?.trim() || "user";
      const resolution = input.resolution?.trim() || input.decision;

      const updated = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`
              UPDATE worker_decision_gates
              SET status = ${nextGateStatus},
                  resolution = ${resolution},
                  resolved_by = ${resolvedBy},
                  resolved_at_ms = ${nowMs}
              WHERE gate_id = ${input.gateId}
            `;
            yield* sql`
              UPDATE worker_tasks
              SET status = ${nextTaskStatus},
                  updated_at_ms = ${nowMs}
              WHERE task_id = ${existing.taskId} AND status = 'blocked'
            `;
            const rows = yield* sql<DecisionGateRow>`
              SELECT * FROM worker_decision_gates WHERE gate_id = ${input.gateId} LIMIT 1
            `;
            return rowToGate(rows[0]!);
          }),
        )
        .pipe(Effect.mapError(mapSqlError("resolveGate")));

      if (task) {
        yield* mailbox.postMessage({
          runId: task.runId,
          threadId: task.threadId,
          taskId: task.taskId,
          dispatchId: updated.dispatchId,
          fencingToken: task.fencingEpoch,
          fromActor: resolvedBy,
          toActor: `run:${task.runId}`,
          type: "answer",
          subject: `[결정 관문 ${nextGateStatus}] ${updated.gateId}`,
          body: resolution,
          payload: {
            gateId: updated.gateId,
            decision: input.decision,
            resolution,
            resolvedBy,
          },
        });
      }

      yield* bestEffortAudit({
        kind: input.decision === "approve" ? "approval.approved" : "approval.rejected",
        actorId: resolvedBy,
        actorKind: "human",
        resource: `worker_gate:${updated.gateId}`,
        payload: {
          gateId: updated.gateId,
          taskId: updated.taskId,
          decision: input.decision,
          resolution,
        },
      });

      return updated;
    });

  const listGates = (filter?: {
    readonly taskId?: string | undefined;
    readonly threadId?: string | undefined;
    readonly status?: WorkerDecisionGateStatus | undefined;
  }) =>
    Effect.gen(function* () {
      let rows: ReadonlyArray<DecisionGateRow>;
      if (filter?.taskId) {
        rows = yield* sql<DecisionGateRow>`
          SELECT * FROM worker_decision_gates WHERE task_id = ${filter.taskId} ORDER BY created_at_ms DESC
        `;
      } else if (filter?.threadId) {
        rows = yield* sql<DecisionGateRow>`
          SELECT * FROM worker_decision_gates WHERE thread_id = ${filter.threadId} ORDER BY created_at_ms DESC
        `;
      } else {
        rows = yield* sql<DecisionGateRow>`
          SELECT * FROM worker_decision_gates ORDER BY created_at_ms DESC LIMIT 100
        `;
      }
      const all = rows.map(rowToGate);
      return filter?.status ? all.filter((g) => g.status === filter.status) : all;
    }).pipe(Effect.mapError(mapSqlError("listGates")));

  return {
    createGate,
    resolveGate,
    listGates,
  };
}

export type WorkerDecisionGateService = ReturnType<typeof makeWorkerDecisionGateService>;
