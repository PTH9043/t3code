// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import type {
  DelegateMandate,
  SubordinateRole,
  WorkspaceDelegateItemStatus,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export type PersistedDelegationStatus = Exclude<WorkspaceDelegateItemStatus, "not_found">;

export interface PersistedDelegationRow {
  readonly delegationId: string;
  readonly threadId: string;
  readonly ownerTurnId: string;
  readonly answeringInstanceId: string;
  readonly role: SubordinateRole;
  readonly targetInstanceId: string;
  readonly targetModel: string;
  readonly taskText: string;
  readonly taskHash: string;
  readonly status: PersistedDelegationStatus;
  readonly resultText: string | null;
  readonly errorMessage: string | null;
  readonly mandateJson: string | null;
  readonly lastActivityAt: string;
  readonly lastToolSummary: string | null;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly deliveredAt: string | null;
}

interface RawDelegationRow {
  delegation_id: string;
  thread_id: string;
  owner_turn_id: string;
  answering_instance_id: string;
  role: SubordinateRole;
  target_instance_id: string;
  target_model: string;
  task_text: string;
  task_hash: string;
  status: PersistedDelegationStatus;
  result_text: string | null;
  error_message: string | null;
  mandate_json: string | null;
  last_activity_at: string;
  last_tool_summary: string | null;
  started_at: string;
  finished_at: string | null;
  delivered_at: string | null;
}

function mapRow(row: RawDelegationRow): PersistedDelegationRow {
  return {
    delegationId: row.delegation_id,
    threadId: row.thread_id,
    ownerTurnId: row.owner_turn_id,
    answeringInstanceId: row.answering_instance_id,
    role: row.role,
    targetInstanceId: row.target_instance_id,
    targetModel: row.target_model,
    taskText: row.task_text,
    taskHash: row.task_hash,
    status: row.status,
    resultText: row.result_text,
    errorMessage: row.error_message,
    mandateJson: row.mandate_json,
    lastActivityAt: row.last_activity_at,
    lastToolSummary: row.last_tool_summary,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    deliveredAt: row.delivered_at,
  };
}

export function computeDelegationTaskHash(task: string): string {
  const normalized = task.trim().replace(/\s+/gu, " ").toLowerCase();
  return NodeCrypto.createHash("sha256").update(normalized, "utf8").digest("hex");
}

export function makeWorkspaceDelegationStore(sql: SqlClient.SqlClient) {
  const insert = (input: {
    readonly delegationId: string;
    readonly threadId: string;
    readonly ownerTurnId: string;
    readonly answeringInstanceId: string;
    readonly role: SubordinateRole;
    readonly targetInstanceId: string;
    readonly targetModel: string;
    readonly taskText: string;
    readonly taskHash: string;
    readonly mandate?: DelegateMandate | undefined;
    readonly startedAt: string;
  }) =>
    sql`INSERT OR REPLACE INTO workspace_delegations (
      delegation_id, thread_id, owner_turn_id, answering_instance_id, role,
      target_instance_id, target_model, task_text, task_hash, status,
      result_text, error_message, mandate_json, last_activity_at, last_tool_summary,
      started_at, finished_at, delivered_at
    ) VALUES (
      ${input.delegationId}, ${input.threadId}, ${input.ownerTurnId}, ${input.answeringInstanceId},
      ${input.role}, ${input.targetInstanceId}, ${input.targetModel}, ${input.taskText.slice(0, 20_000)},
      ${input.taskHash}, 'running', NULL, NULL,
      ${input.mandate ? JSON.stringify(input.mandate) : null},
      ${input.startedAt}, NULL, ${input.startedAt}, NULL, NULL
    )`.pipe(
      Effect.asVoid,
      Effect.orElseSucceed(() => undefined),
    );

  const updateActivity = (input: {
    readonly delegationId: string;
    readonly lastActivityAt: string;
    readonly lastToolSummary?: string | null | undefined;
    readonly status?: "running" | "stalled" | undefined;
  }) =>
    sql`UPDATE workspace_delegations
      SET last_activity_at = ${input.lastActivityAt},
          last_tool_summary = COALESCE(${input.lastToolSummary ?? null}, last_tool_summary),
          status = COALESCE(${input.status ?? null}, status)
      WHERE delegation_id = ${input.delegationId}
        AND status IN ('running', 'stalled')`.pipe(
      Effect.asVoid,
      Effect.orElseSucceed(() => undefined),
    );

  const settle = (input: {
    readonly delegationId: string;
    readonly status: Exclude<PersistedDelegationStatus, "running" | "stalled">;
    readonly resultText?: string | null | undefined;
    readonly errorMessage?: string | null | undefined;
    readonly finishedAt: string;
  }) =>
    sql`UPDATE workspace_delegations
      SET status = ${input.status},
          result_text = COALESCE(${input.resultText ?? null}, result_text),
          error_message = COALESCE(${input.errorMessage ?? null}, error_message),
          finished_at = ${input.finishedAt},
          last_activity_at = ${input.finishedAt}
      WHERE delegation_id = ${input.delegationId}`.pipe(
      Effect.asVoid,
      Effect.tapError((cause) =>
        Effect.logError("workspace_delegations.settle failed", {
          delegationId: input.delegationId,
          status: input.status,
          cause: String(cause),
        }),
      ),
      Effect.orElseSucceed(() => undefined),
    );

  const markDelivered = (delegationId: string, deliveredAt: string) =>
    sql`UPDATE workspace_delegations
      SET delivered_at = COALESCE(delivered_at, ${deliveredAt})
      WHERE delegation_id = ${delegationId}`.pipe(
      Effect.asVoid,
      Effect.orElseSucceed(() => undefined),
    );

  const markInterruptedBeforeBoot = (bootedAt: string, finishedAt: string) =>
    sql`UPDATE workspace_delegations
      SET status = 'interrupted_by_restart',
          error_message = COALESCE(error_message, '서버 재시작으로 중단되었습니다.'),
          finished_at = ${finishedAt}
      WHERE status IN ('running', 'stalled')
        AND started_at < ${bootedAt}`.pipe(
      Effect.asVoid,
      Effect.orElseSucceed(() => undefined),
    );

  const getById = (delegationId: string) =>
    sql<RawDelegationRow>`SELECT * FROM workspace_delegations WHERE delegation_id = ${delegationId} LIMIT 1`.pipe(
      Effect.map((rows) => (rows[0] ? mapRow(rows[0]) : undefined)),
      Effect.orElseSucceed(() => undefined),
    );

  const listByThread = (threadId: string, limit = 20) =>
    sql<RawDelegationRow>`SELECT * FROM workspace_delegations
      WHERE thread_id = ${threadId}
      ORDER BY started_at DESC
      LIMIT ${limit}`.pipe(
      Effect.map((rows) => rows.map(mapRow)),
      Effect.orElseSucceed((): ReadonlyArray<PersistedDelegationRow> => []),
    );

  const findActiveDuplicate = (input: {
    readonly threadId: string;
    readonly targetInstanceId: string;
    readonly targetModel: string;
    readonly taskHash: string;
  }) =>
    sql<RawDelegationRow>`SELECT * FROM workspace_delegations
      WHERE thread_id = ${input.threadId}
        AND target_instance_id = ${input.targetInstanceId}
        AND target_model = ${input.targetModel}
        AND task_hash = ${input.taskHash}
        AND status IN ('running', 'stalled')
      ORDER BY started_at DESC
      LIMIT 1`.pipe(
      Effect.map((rows) => (rows[0] ? mapRow(rows[0]) : undefined)),
      Effect.orElseSucceed(() => undefined),
    );

  return {
    insert,
    updateActivity,
    settle,
    markDelivered,
    markInterruptedBeforeBoot,
    getById,
    listByThread,
    findActiveDuplicate,
  };
}

export type WorkspaceDelegationStore = ReturnType<typeof makeWorkspaceDelegationStore>;
