import type { MessageId, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

export type BlackboardCategory =
  | "file-lock"
  | "verified-finding"
  | "active-hypothesis"
  | "handoff-checkpoint";

export interface BlackboardEntry {
  key: string;
  ownerAgentId: string;
  version: number;
  category: BlackboardCategory;
  payloadJson: string;
  leaseExpiresAt: number;
  updatedAt: number;
}

export interface SynchronousSqliteLike {
  exec(sql: string): void;
  pragma?(directive: string): unknown;
  prepare(sql: string): {
    run(...params: unknown[]): { changes: number | bigint };
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
}

export function initSharedBlackboardSchema(db: SynchronousSqliteLike): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspace_shared_blackboard (
      workspace_id TEXT NOT NULL,
      key TEXT NOT NULL,
      owner_agent_id TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      category TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      lease_expires_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (workspace_id, key)
    );

    CREATE INDEX IF NOT EXISTS idx_blackboard_lease
      ON workspace_shared_blackboard (workspace_id, lease_expires_at);
  `);
}

/**
 * Optimistic Concurrency Control (Compare-And-Swap, CAS) Blackboard update with Lease TTL expiration.
 */
export function upsertBlackboardEntryCas(
  db: SynchronousSqliteLike,
  workspaceId: string,
  entry: Omit<BlackboardEntry, "version" | "updatedAt">,
  expectedVersion?: number,
  nowMs: number = Date.now(),
): { success: boolean; newVersion: number; conflictEntry?: BlackboardEntry } {
  const existing = db
    .prepare(
      `SELECT key, owner_agent_id as ownerAgentId, version, category,
              payload_json as payloadJson, lease_expires_at as leaseExpiresAt,
              updated_at as updatedAt
       FROM workspace_shared_blackboard
       WHERE workspace_id = ? AND key = ?`,
    )
    .get(workspaceId, entry.key) as BlackboardEntry | undefined;

  if (!existing || Number(existing.leaseExpiresAt) <= nowMs) {
    const nextVersion = existing ? Number(existing.version) + 1 : 1;
    db.prepare(
      `INSERT INTO workspace_shared_blackboard
         (workspace_id, key, owner_agent_id, version, category, payload_json, lease_expires_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(workspace_id, key) DO UPDATE SET
         owner_agent_id = excluded.owner_agent_id,
         version = excluded.version,
         category = excluded.category,
         payload_json = excluded.payload_json,
         lease_expires_at = excluded.lease_expires_at,
         updated_at = excluded.updated_at`,
    ).run(
      workspaceId,
      entry.key,
      entry.ownerAgentId,
      nextVersion,
      entry.category,
      entry.payloadJson,
      entry.leaseExpiresAt,
      nowMs,
    );
    return { success: true, newVersion: nextVersion };
  }

  if (expectedVersion !== undefined && Number(existing.version) !== expectedVersion) {
    return {
      success: false,
      newVersion: Number(existing.version),
      conflictEntry: {
        ...existing,
        version: Number(existing.version),
        leaseExpiresAt: Number(existing.leaseExpiresAt),
        updatedAt: Number(existing.updatedAt),
      },
    };
  }

  const nextVersion = Number(existing.version) + 1;
  db.prepare(
    `UPDATE workspace_shared_blackboard
     SET owner_agent_id = ?, version = ?, category = ?, payload_json = ?,
         lease_expires_at = ?, updated_at = ?
     WHERE workspace_id = ? AND key = ? AND version = ?`,
  ).run(
    entry.ownerAgentId,
    nextVersion,
    entry.category,
    entry.payloadJson,
    entry.leaseExpiresAt,
    nowMs,
    workspaceId,
    entry.key,
    Number(existing.version),
  );

  return { success: true, newVersion: nextVersion };
}

/**
 * Effect SqlClient version of CAS Blackboard state update.
 */
export const upsertBlackboardEntryCasEffect = Effect.fn("WorkspaceMemory.upsertBlackboardEntryCas")(
  function* (
    sql: SqlClient.SqlClient,
    workspaceId: string,
    entry: Omit<BlackboardEntry, "version" | "updatedAt">,
    expectedVersion?: number,
    nowMs: number = Date.now(),
  ) {
    const [existing] = yield* sql<BlackboardEntry>`
    SELECT key, owner_agent_id as ownerAgentId, version, category,
           payload_json as payloadJson, lease_expires_at as leaseExpiresAt,
           updated_at as updatedAt
    FROM workspace_shared_blackboard
    WHERE workspace_id = ${workspaceId} AND key = ${entry.key}
  `;

    if (!existing || Number(existing.leaseExpiresAt) <= nowMs) {
      const nextVersion = existing ? Number(existing.version) + 1 : 1;
      yield* sql`
      INSERT INTO workspace_shared_blackboard
        (workspace_id, key, owner_agent_id, version, category, payload_json, lease_expires_at, updated_at)
      VALUES (
        ${workspaceId}, ${entry.key}, ${entry.ownerAgentId}, ${nextVersion},
        ${entry.category}, ${entry.payloadJson}, ${entry.leaseExpiresAt}, ${nowMs}
      )
      ON CONFLICT(workspace_id, key) DO UPDATE SET
        owner_agent_id = excluded.owner_agent_id,
        version = excluded.version,
        category = excluded.category,
        payload_json = excluded.payload_json,
        lease_expires_at = excluded.lease_expires_at,
        updated_at = excluded.updated_at
    `;
      return { success: true as const, newVersion: nextVersion };
    }

    if (expectedVersion !== undefined && Number(existing.version) !== expectedVersion) {
      return {
        success: false as const,
        newVersion: Number(existing.version),
        conflictEntry: existing,
      };
    }

    const nextVersion = Number(existing.version) + 1;
    yield* sql`
    UPDATE workspace_shared_blackboard
    SET owner_agent_id = ${entry.ownerAgentId},
        version = ${nextVersion},
        category = ${entry.category},
        payload_json = ${entry.payloadJson},
        lease_expires_at = ${entry.leaseExpiresAt},
        updated_at = ${nowMs}
    WHERE workspace_id = ${workspaceId} AND key = ${entry.key} AND version = ${existing.version}
  `;
    return { success: true as const, newVersion: nextVersion };
  },
);

/**
 * Reclaim expired Lease TTL entries from the Shared Blackboard and trigger SQLite
 * page-cache shrink + WAL truncate when process RSS usage ratio reaches 75%.
 */
export function sweepExpiredBlackboardAndCompactRam(
  db: SynchronousSqliteLike,
  workspaceId: string,
  rssUsageRatio: number,
  nowMs: number = Date.now(),
): { evictedEntries: number; walCheckpointed: boolean } {
  const result = db
    .prepare(
      `DELETE FROM workspace_shared_blackboard
       WHERE workspace_id = ? AND lease_expires_at <= ?`,
    )
    .run(workspaceId, nowMs);

  let walCheckpointed = false;
  if (rssUsageRatio >= 0.75) {
    if (typeof db.pragma === "function") {
      db.pragma("shrink_memory");
      db.pragma("wal_checkpoint(TRUNCATE)");
    } else {
      db.exec("PRAGMA shrink_memory; PRAGMA wal_checkpoint(TRUNCATE);");
    }
    walCheckpointed = true;
  }

  return {
    evictedEntries: Number(result.changes),
    walCheckpointed,
  };
}

export const sweepExpiredBlackboardAndCompactRamEffect = Effect.fn(
  "WorkspaceMemory.sweepExpiredBlackboardAndCompactRam",
)(function* (
  sql: SqlClient.SqlClient,
  workspaceId: string,
  rssUsageRatio: number,
  nowMs: number = Date.now(),
) {
  const expired = yield* sql<{ count: number }>`
    SELECT count(*) AS count FROM workspace_shared_blackboard
    WHERE workspace_id = ${workspaceId} AND lease_expires_at <= ${nowMs}
  `;
  const evictedEntries = Number(expired[0]?.count ?? 0);
  if (evictedEntries > 0) {
    yield* sql`
      DELETE FROM workspace_shared_blackboard
      WHERE workspace_id = ${workspaceId} AND lease_expires_at <= ${nowMs}
    `;
  }
  let walCheckpointed = false;
  if (rssUsageRatio >= 0.75) {
    yield* sql`PRAGMA shrink_memory`.pipe(Effect.ignore);
    yield* sql`PRAGMA wal_checkpoint(TRUNCATE)`.pipe(Effect.ignore);
    walCheckpointed = true;
  }
  return { evictedEntries, walCheckpointed };
});

/** Read prior-turn observations only when their originating user message has the current folder. */
export const readHandoffWorkingState = Effect.fn("WorkspaceMemory.handoffWorkingState")(function* (
  sql: SqlClient.SqlClient,
  projectId: ProjectId,
  threadId: ThreadId,
  messageId: MessageId,
) {
  const rows = yield* sql<{
    activity_id: string;
    kind: string;
    summary: string;
    detail: string | null;
    exit_code: number | null;
    request_id: string | null;
    file_path: string | null;
    output: string | null;
  }>`WITH eligible AS NOT MATERIALIZED (
    SELECT a.activity_id,a.kind,a.summary,a.created_at,a.rowid AS position,
      CASE WHEN json_valid(a.payload_json) THEN a.payload_json ELSE '{}' END AS payload
    FROM projection_thread_activities a
    JOIN projection_turns t ON t.thread_id=a.thread_id AND t.turn_id=a.turn_id
    JOIN projection_thread_messages u ON u.thread_id=t.thread_id AND u.message_id=t.pending_message_id AND u.role='user'
    JOIN projection_thread_messages c ON c.thread_id=a.thread_id AND c.message_id=${messageId}
    JOIN workspace_memory_v2_message_folders origin ON origin.message_id=u.message_id AND origin.thread_id=t.thread_id AND origin.project_id=${projectId}
    JOIN workspace_memory_v2_message_folders current ON current.message_id=c.message_id AND current.thread_id=t.thread_id AND current.project_id=origin.project_id AND current.folder=origin.folder
    WHERE a.thread_id=${threadId} AND u.rowid<c.rowid AND a.created_at<c.created_at
  ), tool AS (
    SELECT * FROM eligible WHERE kind IN ('tool.completed','tool.updated','tool.denied','runtime.error')
    ORDER BY created_at DESC,position DESC LIMIT 1
  ), task AS (
    SELECT * FROM eligible WHERE kind IN ('turn.plan.updated','task.started','task.progress','task.updated','task.completed')
      AND json_extract(payload,'$.usageSnapshot') IS NOT 1
    ORDER BY created_at DESC,position DESC LIMIT 1
  ), approval AS (
    SELECT e.* FROM eligible e JOIN projection_pending_approvals p
      ON p.thread_id=${threadId} AND p.request_id=json_extract(e.payload,'$.requestId') AND p.status='pending'
    WHERE e.kind='approval.requested' ORDER BY e.created_at DESC,e.position DESC LIMIT 1
  ), question AS (
    SELECT e.* FROM eligible e WHERE e.kind='user-input.requested' AND json_type(e.payload,'$.requestId')='text'
      AND NOT EXISTS (SELECT 1 FROM projection_thread_activities closed
        WHERE closed.thread_id=${threadId} AND closed.kind IN ('user-input.resolved','provider.user-input.respond.failed')
          AND json_valid(closed.payload_json)
          AND json_extract(closed.payload_json,'$.requestId')=json_extract(e.payload,'$.requestId')
          AND (closed.kind='user-input.resolved' OR EXISTS (
            SELECT 1 FROM json_each('["stale pending user-input request","unknown pending user-input request","unknown pending user input request","unknown pending codex user input request"]') phrase
            WHERE instr(lower(json_extract(closed.payload_json,'$.detail')),phrase.value)>0))
          AND (closed.created_at,closed.rowid)>=(e.created_at,e.position))
    ORDER BY e.created_at DESC,e.position DESC LIMIT 1
  ), observations AS (
    SELECT *, CASE WHEN json_type(payload,'$.data.item')='object' THEN json_extract(payload,'$.data.item')
      WHEN json_type(payload,'$.data')='object' THEN json_extract(payload,'$.data') ELSE '{}' END AS item
    FROM (SELECT * FROM tool UNION ALL SELECT * FROM task UNION ALL SELECT * FROM approval UNION ALL SELECT * FROM question)
  )
  SELECT activity_id,kind,substr(summary,1,120) AS summary,
    substr(coalesce((SELECT json_extract(step.value,'$.status') || ': ' || json_extract(step.value,'$.step')
        FROM json_each(payload,'$.plan') step WHERE step.type='object'
          AND json_extract(step.value,'$.status') IN ('inProgress','pending')
        ORDER BY json_extract(step.value,'$.status')='inProgress' DESC,step.key LIMIT 1),
      CASE WHEN json_type(payload,'$.detail')='text' THEN json_extract(payload,'$.detail') END,
      json_extract(payload,'$.questions[0].question'),json_extract(payload,'$.explanation'),
      json_extract(payload,'$.message'),json_extract(payload,'$.status')),1,320) AS detail,
    CASE WHEN json_type(item,'$.exitCode')='integer' THEN json_extract(item,'$.exitCode') END AS exit_code,
    substr(json_extract(payload,'$.requestId'),1,120) AS request_id,
    substr(coalesce(CASE WHEN json_type(item,'$.filePath')='text' THEN json_extract(item,'$.filePath') END,
      CASE WHEN json_type(item,'$.path')='text' THEN json_extract(item,'$.path') END,
      CASE WHEN json_type(item,'$.changes[0].path')='text' THEN json_extract(item,'$.changes[0].path') END),1,160) AS file_path,
    CASE WHEN json_type(item,'$.aggregatedOutput')='text' THEN substr(json_extract(item,'$.aggregatedOutput'),-240) END AS output
  FROM observations`;
  const attachments = yield* sql<{ message_id: string; id: string; name: string }>`
    SELECT m.message_id, substr(json_extract(j.value,'$.id'),1,120) AS id,
      substr(json_extract(j.value,'$.name'),1,255) AS name
    FROM projection_thread_messages m
    JOIN projection_thread_messages c ON c.thread_id=m.thread_id AND c.message_id=${messageId}
    JOIN workspace_memory_v2_message_folders origin ON origin.message_id=m.message_id AND origin.thread_id=m.thread_id AND origin.project_id=${projectId}
    JOIN workspace_memory_v2_message_folders current ON current.message_id=c.message_id AND current.thread_id=m.thread_id AND current.project_id=origin.project_id AND current.folder=origin.folder
    JOIN json_each(CASE WHEN json_valid(m.attachments_json) THEN m.attachments_json ELSE '[]' END) j
    WHERE m.thread_id=${threadId} AND m.rowid<c.rowid AND m.is_streaming=0 AND j.type='object'
      AND json_type(j.value,'$.id')='text' AND json_type(j.value,'$.name')='text'
    ORDER BY m.rowid DESC,j.key LIMIT 1`;
  const lines = rows.map(
    ({ activity_id, kind, summary, detail, exit_code, request_id, file_path, output }) => {
      const evidence = encodeJson({
        summary,
        requestId: request_id ?? undefined,
        exitCode: exit_code ?? undefined,
        path: file_path ?? undefined,
        output: output ?? undefined,
        detail: detail ?? undefined,
      });
      return `[activity:${activity_id}] ${kind} ${evidence}`.slice(0, 500);
    },
  );
  for (const attachment of attachments) {
    lines.push(
      `[message:${attachment.message_id}] attachment ${encodeJson({ id: attachment.id, name: attachment.name })}`,
    );
  }
  if (!lines.length) return "";
  return (
    "이전 턴의 작업 기록입니다. 당시 도구 결과·계획·대기 요청을 근거로 확인하고 실행이나 승인을 반복하지 마세요.\n" +
    lines.join("\n") +
    "\n"
  );
});
