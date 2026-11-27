import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import {
  MCP_MONITOR_MAX_MS,
  MCP_RECOVERY_SUMMARIES,
  RECOVERY_BACKGROUND_TEXT,
  RECOVERY_MCP_CHECK_TEXT,
  orphanedBackgroundWork,
  recoveryMessageParts,
} from "./backgroundWatchRecovery.ts";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { toPersistenceSqlError } from "../persistence/Errors.ts";
import { OrchestrationCommandInvariantError } from "./Errors.ts";

export interface RecoveryDeliveryIdentity {
  readonly eventId: string;
  readonly threadId: string;
  readonly messageId: string;
  readonly eventSequence: number;
}
export type RecoveryDeliveryState = "queued" | "sending" | "accepted" | "unknown" | "cancelled";

/** The journal records transmission evidence, not permission to repeat an uncertain call. */
export function makeRecoveryDeliveryJournal(sql: SqlClient.SqlClient) {
  const enqueue = Effect.fn("RecoveryDeliveryJournal.enqueue")(function* (
    entry: RecoveryDeliveryIdentity,
    now: string,
  ) {
    const rows = yield* sql<{ eventId: string }>`INSERT INTO recovery_delivery_journal
      (event_id, thread_id, message_id, event_sequence, state, updated_at)
      SELECT event_id, stream_id, ${entry.messageId}, sequence, 'queued', ${now}
      FROM orchestration_events WHERE event_id = ${entry.eventId} AND sequence = ${entry.eventSequence}
        AND aggregate_kind = 'thread' AND stream_id = ${entry.threadId}
        AND event_type = 'thread.turn-start-requested'
        AND json_extract(payload_json, '$.messageId') = ${entry.messageId}
        AND json_extract(payload_json, '$.inputOrigin') = 'automation'
      RETURNING event_id AS "eventId"`.pipe(
      Effect.mapError(toPersistenceSqlError("RecoveryDeliveryJournal.enqueue")),
    );
    if (rows.length !== 1)
      return yield* new OrchestrationCommandInvariantError({
        commandType: "thread.background-recovery.start",
        detail: "복구 요청과 저장된 전달 대상이 일치하지 않습니다.",
      });
  });

  const listQueued = Effect.fn("RecoveryDeliveryJournal.listQueued")(function* () {
    return yield* sql<RecoveryDeliveryIdentity>`SELECT event_id AS "eventId", thread_id AS "threadId",
      message_id AS "messageId", event_sequence AS "eventSequence"
      FROM recovery_delivery_journal WHERE state = 'queued' ORDER BY event_sequence`.pipe(
      Effect.mapError(toPersistenceSqlError("RecoveryDeliveryJournal.listQueued")),
    );
  });

  const watchEvidence = Effect.fn("RecoveryDeliveryJournal.watchEvidence")(function* (
    entry: RecoveryDeliveryIdentity,
    nowMs: number,
    revokedAtMs?: number,
  ) {
    // The recovery command itself appends interruption receipts. Read the surviving
    // starts preceding it and subsequent stops. Exclude its own receipts and reverted history.
    const rows = yield* sql<{
      activityId: string;
      createdAt: string;
      kind: string;
      payloadJson: string;
    }>`
      SELECT a.activity_id AS "activityId", a.created_at AS "createdAt", a.kind, a.payload_json AS "payloadJson"
      FROM orchestration_events request
      JOIN orchestration_events prior ON prior.aggregate_kind = 'thread'
        AND prior.stream_id = request.stream_id
        AND prior.event_type = 'thread.activity-appended' AND prior.command_id IS NOT request.command_id
      JOIN projection_thread_activities a ON a.thread_id = prior.stream_id
        AND a.activity_id = json_extract(prior.payload_json, '$.activity.id')
      WHERE request.event_id = ${entry.eventId} AND request.stream_id = ${entry.threadId}
        AND (prior.sequence < request.sequence OR a.kind IN ('session.recovered', 'task.completed', 'task.updated')
          OR json_extract(a.payload_json, '$.data.item.tool') = 'TaskStop'
          OR json_extract(a.payload_json, '$.data.item.arguments.stop') = 1
          OR json_extract(a.payload_json, '$.data.input.stop') = 1)
        AND (a.kind IN ('session.recovered','task.started','task.updated','task.completed')
          OR (a.kind = 'tool.completed' AND (json_extract(a.payload_json, '$.data.toolName') = 'ScheduleWakeup'
            OR (a.created_at >= ${DateTime.formatIso(DateTime.makeUnsafe(nowMs - MCP_MONITOR_MAX_MS))}
              AND a.summary IN ${sql.in(MCP_RECOVERY_SUMMARIES)}))))`.pipe(
      Effect.mapError(toPersistenceSqlError("RecoveryDeliveryJournal.watchEvidence")),
    );
    return orphanedBackgroundWork(
      rows.map((row) => ({ ...row, payload: JSON.parse(row.payloadJson) })),
      nowMs,
      revokedAtMs,
    );
  });

  const activeTurnIsWatchOnly = Effect.fn("RecoveryDeliveryJournal.activeTurnIsWatchOnly")(
    function* (threadId: string, turnId: string) {
      const rows = yield* sql<{ text: string }>`SELECT m.text FROM projection_turns t
      JOIN recovery_delivery_journal r ON r.thread_id = t.thread_id AND r.message_id = t.pending_message_id
      JOIN projection_thread_messages m ON m.thread_id = r.thread_id AND m.message_id = r.message_id
      WHERE t.thread_id = ${threadId} AND t.turn_id = ${turnId}`.pipe(
        Effect.mapError(toPersistenceSqlError("RecoveryDeliveryJournal.activeTurnIsWatchOnly")),
      );
      return rows.some((row) => recoveryMessageParts(row.text).foreground === null);
    },
  );

  const state = Effect.fn("RecoveryDeliveryJournal.state")(function* (eventId: string) {
    const rows = yield* sql<{ state: RecoveryDeliveryState }>`SELECT state
      FROM recovery_delivery_journal WHERE event_id = ${eventId}`.pipe(
      Effect.mapError(toPersistenceSqlError("RecoveryDeliveryJournal.state")),
    );
    return rows[0]?.state ?? null;
  });

  const isRecoveryStop = Effect.fn("RecoveryDeliveryJournal.isRecoveryStop")(function* (
    commandId: string,
    threadId: string,
  ) {
    const rows = yield* sql<{ eventId: string }>`SELECT recovery.event_id AS "eventId"
      FROM recovery_delivery_journal recovery
      JOIN orchestration_events request ON request.event_id = recovery.event_id
      WHERE request.command_id = ${commandId} AND recovery.thread_id = ${threadId}`.pipe(
      Effect.mapError(toPersistenceSqlError("RecoveryDeliveryJournal.isRecoveryStop")),
    );
    return rows.length > 0;
  });

  const cancelQueued = Effect.fn("RecoveryDeliveryJournal.cancelQueued")(function* (
    eventId: string,
    now: string,
  ) {
    yield* sql`UPDATE recovery_delivery_journal SET state = 'cancelled', updated_at = ${now}
      WHERE event_id = ${eventId} AND state = 'queued'`.pipe(
      Effect.mapError(toPersistenceSqlError("RecoveryDeliveryJournal.cancelQueued")),
    );
  });

  const cancelRoomWatchRequests = (threadId: string, disabledAt: string) =>
    sql`UPDATE recovery_delivery_journal AS r SET state = 'cancelled', updated_at = ${disabledAt}
      WHERE r.thread_id = ${threadId} AND r.state = 'queued' AND EXISTS (
        SELECT 1 FROM projection_thread_messages m
        WHERE m.thread_id = r.thread_id AND m.message_id = r.message_id AND m.created_at <= ${disabledAt}
          AND (instr(m.text, ${RECOVERY_BACKGROUND_TEXT}) = 1 OR instr(m.text, ${RECOVERY_MCP_CHECK_TEXT}) = 1)
      )`.pipe(
      Effect.mapError(toPersistenceSqlError("RecoveryDeliveryJournal.cancelRoomWatchRequests")),
      Effect.asVoid,
    );

  const eligible = Effect.fn("RecoveryDeliveryJournal.eligible")(function* (eventId: string) {
    const rows = yield* sql<{ eventId: string }>`SELECT recovery.event_id AS "eventId"
      FROM recovery_delivery_journal recovery
      WHERE recovery.event_id = ${eventId} AND recovery.state = 'queued'
      AND NOT EXISTS (
        SELECT 1 FROM orchestration_events later
        WHERE later.aggregate_kind = 'thread' AND later.stream_id = recovery.thread_id
          AND later.sequence > recovery.event_sequence
          AND (later.event_type IN ('thread.session-stop-requested', 'thread.turn-interrupt-requested',
                                   'thread.turn-start-requested', 'thread.archived', 'thread.deleted')
            OR (later.event_type = 'thread.message-sent' AND json_extract(later.payload_json, '$.role') = 'user'))
      )`.pipe(Effect.mapError(toPersistenceSqlError("RecoveryDeliveryJournal.eligible")));
    return rows.length > 0;
  });

  const listUnknown = Effect.fn("RecoveryDeliveryJournal.listUnknown")(function* () {
    return yield* sql<RecoveryDeliveryIdentity>`SELECT recovery.event_id AS "eventId", recovery.thread_id AS "threadId",
      recovery.message_id AS "messageId", recovery.event_sequence AS "eventSequence"
      FROM recovery_delivery_journal recovery WHERE recovery.state = 'unknown'
      AND NOT EXISTS (SELECT 1 FROM orchestration_events later WHERE later.aggregate_kind = 'thread'
        AND later.stream_id = recovery.thread_id AND later.sequence > recovery.event_sequence
        AND later.event_type IN ('thread.turn-start-requested', 'thread.session-stop-requested',
                                 'thread.turn-interrupt-requested', 'thread.archived', 'thread.deleted'))
      ORDER BY recovery.event_sequence`.pipe(
      Effect.mapError(toPersistenceSqlError("RecoveryDeliveryJournal.listUnknown")),
    );
  });

  const listUnconfirmedAccepted = Effect.fn("RecoveryDeliveryJournal.listUnconfirmedAccepted")(
    function* () {
      return yield* sql<RecoveryDeliveryIdentity>`SELECT recovery.event_id AS "eventId",
        recovery.thread_id AS "threadId", recovery.message_id AS "messageId",
        recovery.event_sequence AS "eventSequence"
        FROM recovery_delivery_journal recovery WHERE recovery.state = 'accepted'
        AND NOT EXISTS (
          SELECT 1 FROM projection_turns turn WHERE turn.thread_id = recovery.thread_id
            AND turn.pending_message_id = recovery.message_id AND turn.turn_id IS NOT NULL
        ) AND NOT EXISTS (
          SELECT 1 FROM orchestration_events later WHERE later.aggregate_kind = 'thread'
            AND later.stream_id = recovery.thread_id AND later.sequence > recovery.event_sequence
            AND later.event_type IN ('thread.turn-start-requested', 'thread.session-stop-requested',
                                     'thread.turn-interrupt-requested', 'thread.archived', 'thread.deleted')
        ) ORDER BY recovery.event_sequence`.pipe(
        Effect.mapError(toPersistenceSqlError("RecoveryDeliveryJournal.listUnconfirmedAccepted")),
      );
    },
  );

  const activeThreads = Effect.fn("RecoveryDeliveryJournal.activeThreads")(function* () {
    const rows = yield* sql<{ threadId: string }>`SELECT DISTINCT recovery.thread_id AS "threadId"
      FROM recovery_delivery_journal recovery
      WHERE (recovery.state IN ('queued', 'sending', 'unknown', 'cancelled')
        OR (recovery.state = 'accepted' AND NOT EXISTS (
          SELECT 1 FROM projection_turns received WHERE received.thread_id = recovery.thread_id
            AND received.pending_message_id = recovery.message_id AND received.turn_id IS NOT NULL
        )))
      AND NOT EXISTS (
        SELECT 1 FROM orchestration_events later
        WHERE later.aggregate_kind = 'thread' AND later.stream_id = recovery.thread_id
          AND later.sequence > recovery.event_sequence
          AND later.event_type = 'thread.turn-start-requested'
          AND EXISTS (
            SELECT 1 FROM projection_turns started
            WHERE started.thread_id = recovery.thread_id AND started.state = 'running'
              AND started.turn_id IS NOT NULL
              AND started.pending_message_id = json_extract(later.payload_json, '$.messageId')
          )
      )`.pipe(Effect.mapError(toPersistenceSqlError("RecoveryDeliveryJournal.activeThreads")));
    return new Set(rows.map((row) => row.threadId));
  });

  const claim = Effect.fn("RecoveryDeliveryJournal.claim")(function* (
    eventId: string,
    now: string,
  ) {
    const claimed = yield* sql<{ eventId: string }>`UPDATE recovery_delivery_journal AS recovery
      SET state = 'sending', updated_at = ${now}
      WHERE event_id = ${eventId} AND state = 'queued'
      AND NOT EXISTS (
        SELECT 1 FROM orchestration_events later
        WHERE later.aggregate_kind = 'thread' AND later.stream_id = recovery.thread_id
          AND later.sequence > recovery.event_sequence
          AND (later.event_type IN ('thread.session-stop-requested', 'thread.turn-interrupt-requested',
                                   'thread.turn-start-requested', 'thread.archived', 'thread.deleted')
            OR (later.event_type = 'thread.message-sent' AND json_extract(later.payload_json, '$.role') = 'user'))
      ) RETURNING event_id AS "eventId"`.pipe(
      Effect.mapError(toPersistenceSqlError("RecoveryDeliveryJournal.claim")),
    );
    if (claimed.length > 0) return true;
    yield* sql`UPDATE recovery_delivery_journal AS recovery SET state = 'cancelled', updated_at = ${now}
      WHERE event_id = ${eventId} AND state = 'queued'
      AND EXISTS (
        SELECT 1 FROM orchestration_events later
        WHERE later.aggregate_kind = 'thread' AND later.stream_id = recovery.thread_id
          AND later.sequence > recovery.event_sequence
          AND (later.event_type IN ('thread.session-stop-requested', 'thread.turn-interrupt-requested',
                                   'thread.turn-start-requested', 'thread.archived', 'thread.deleted')
            OR (later.event_type = 'thread.message-sent' AND json_extract(later.payload_json, '$.role') = 'user'))
      )`.pipe(Effect.mapError(toPersistenceSqlError("RecoveryDeliveryJournal.cancelSuperseded")));
    return false;
  });

  const accept = Effect.fn("RecoveryDeliveryJournal.accept")(function* (
    eventId: string,
    now: string,
  ) {
    yield* sql`UPDATE recovery_delivery_journal SET state = 'accepted', updated_at = ${now}
      WHERE event_id = ${eventId} AND state = 'sending'`.pipe(
      Effect.mapError(toPersistenceSqlError("RecoveryDeliveryJournal.accept")),
    );
  });

  const acceptForStartedTurn = Effect.fn("RecoveryDeliveryJournal.acceptForStartedTurn")(
    function* (input: {
      readonly threadId: string;
      readonly turnId: string;
      readonly messageId: string | null;
      readonly now: string;
    }) {
      yield* sql`UPDATE recovery_delivery_journal
      SET state = 'accepted', updated_at = ${input.now}
      WHERE thread_id = ${input.threadId}
        AND state = 'sending'
        AND (
          (${input.messageId} IS NOT NULL AND message_id = ${input.messageId})
          OR EXISTS (
            SELECT 1 FROM projection_turns t
            WHERE t.thread_id = recovery_delivery_journal.thread_id
              AND t.turn_id = ${input.turnId}
              AND t.pending_message_id = recovery_delivery_journal.message_id
          )
        )`.pipe(
        Effect.mapError(toPersistenceSqlError("RecoveryDeliveryJournal.acceptForStartedTurn")),
      );
    },
  );

  const markUnknown = Effect.fn("RecoveryDeliveryJournal.markUnknown")(function* (now: string) {
    return yield* sql<RecoveryDeliveryIdentity>`UPDATE recovery_delivery_journal
      SET state = 'unknown', updated_at = ${now} WHERE state = 'sending'
      RETURNING event_id AS "eventId", thread_id AS "threadId", message_id AS "messageId",
        event_sequence AS "eventSequence"`.pipe(
      Effect.mapError(toPersistenceSqlError("RecoveryDeliveryJournal.markUnknown")),
    );
  });

  const markSendingUnknown = Effect.fn("RecoveryDeliveryJournal.markSendingUnknown")(function* (
    eventId: string,
    now: string,
  ) {
    yield* sql`UPDATE recovery_delivery_journal SET state = 'unknown', updated_at = ${now}
      WHERE event_id = ${eventId} AND state = 'sending'`.pipe(
      Effect.mapError(toPersistenceSqlError("RecoveryDeliveryJournal.markSendingUnknown")),
    );
  });

  const markQueuedUnknown = Effect.fn("RecoveryDeliveryJournal.markQueuedUnknown")(function* (
    eventId: string,
    now: string,
  ) {
    yield* sql`UPDATE recovery_delivery_journal SET state = 'unknown', updated_at = ${now}
      WHERE event_id = ${eventId} AND state = 'queued'`.pipe(
      Effect.mapError(toPersistenceSqlError("RecoveryDeliveryJournal.markQueuedUnknown")),
    );
  });

  return {
    enqueue,
    listQueued,
    listUnknown,
    listUnconfirmedAccepted,
    state,
    isRecoveryStop,
    watchEvidence,
    activeTurnIsWatchOnly,
    cancelQueued,
    cancelRoomWatchRequests,
    cancelUnsentClaim: (eventId: string, now: string) =>
      sql`UPDATE recovery_delivery_journal SET state = 'cancelled', updated_at = ${now}
        WHERE event_id = ${eventId} AND state = 'sending'`.pipe(
        Effect.mapError(toPersistenceSqlError("RecoveryDeliveryJournal.cancelUnsentClaim")),
        Effect.asVoid,
      ),
    eligible,
    activeThreads,
    claim,
    accept,
    acceptForStartedTurn,
    markUnknown,
    markSendingUnknown,
    markQueuedUnknown,
  };
}
