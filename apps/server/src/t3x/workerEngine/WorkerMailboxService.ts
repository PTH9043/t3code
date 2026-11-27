// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off
import * as NodeCrypto from "node:crypto";
import {
  clampWorkerWaitSeconds,
  type WorkerAckInput,
  type WorkerAckResult,
  type WorkerCheckInput,
  type WorkerCheckResult,
  type WorkerDeliveryStatus,
  type WorkerMailboxMessageRecord,
  type WorkerMailboxMessageType,
  type WorkerOutcomeStatus,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { WorkerEngineError, type WorkerEngineStore } from "./WorkerEngineStore.ts";

interface MailboxMessageRow {
  readonly sequence: number;
  readonly message_id: string;
  readonly run_id: string;
  readonly thread_id: string;
  readonly task_id: string | null;
  readonly dispatch_id: string | null;
  readonly fencing_token: number | null;
  readonly from_actor: string;
  readonly to_actor: string;
  readonly type: WorkerMailboxMessageType;
  readonly outcome: WorkerOutcomeStatus | null;
  readonly subject: string;
  readonly body: string;
  readonly payload_json: string | null;
  readonly delivery_id: string | null;
  readonly created_at_ms: number;
  readonly delivered_at_ms: number | null;
  readonly acknowledged_at_ms: number | null;
}

interface MailboxDeliveryRow {
  readonly delivery_id: string;
  readonly run_id: string;
  readonly mailbox_handle: string;
  readonly consumer_generation: number;
  readonly message_ids_json: string;
  readonly status: WorkerDeliveryStatus;
  readonly created_at_ms: number;
  readonly acknowledged_at_ms: number | null;
}

function rowToMessage(row: MailboxMessageRow): WorkerMailboxMessageRecord {
  return {
    sequence: Number(row.sequence),
    messageId: row.message_id,
    runId: row.run_id,
    threadId: row.thread_id,
    taskId: row.task_id,
    dispatchId: row.dispatch_id,
    fencingToken: row.fencing_token === null ? null : Number(row.fencing_token),
    fromActor: row.from_actor,
    toActor: row.to_actor,
    type: row.type,
    outcome: row.outcome,
    subject: row.subject,
    body: row.body,
    payloadJson: row.payload_json,
    deliveryId: row.delivery_id,
    createdAtMs: Number(row.created_at_ms),
    deliveredAtMs: row.delivered_at_ms === null ? null : Number(row.delivered_at_ms),
    acknowledgedAtMs: row.acknowledged_at_ms === null ? null : Number(row.acknowledged_at_ms),
  };
}

export interface PostMailboxMessageInput {
  readonly runId: string;
  readonly threadId: string;
  readonly taskId?: string | null | undefined;
  readonly dispatchId?: string | null | undefined;
  readonly fencingToken?: number | null | undefined;
  readonly fromActor: string;
  readonly toActor: string;
  readonly type: WorkerMailboxMessageType;
  readonly outcome?: WorkerOutcomeStatus | null | undefined;
  readonly subject: string;
  readonly body: string;
  readonly payload?: unknown;
}

interface WakeupSignal {
  readonly runId: string;
  readonly threadId: string;
  readonly toActor: string;
  readonly type: WorkerMailboxMessageType;
}

function deriveMailboxHandle(input: WorkerCheckInput): string {
  if (input.toActor?.trim()) return input.toActor.trim();
  if (input.runId?.trim()) return `run:${input.runId.trim()}`;
  if (input.threadId?.trim()) return `thread:${input.threadId.trim()}`;
  return "supervisor";
}

function matchesFilter(msg: WorkerMailboxMessageRecord, filter: WorkerCheckInput): boolean {
  if (filter.runId && msg.runId !== filter.runId) return false;
  if (filter.threadId && msg.threadId !== filter.threadId) return false;
  if (filter.toActor && msg.toActor !== filter.toActor) return false;
  if (filter.types && filter.types.length > 0 && !filter.types.includes(msg.type)) return false;
  return true;
}

const mapSqlError = (operation: string) => (cause: unknown) =>
  new WorkerEngineError({
    code: "storage_error",
    message: `WorkerMailboxService.${operation} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
  });

export const makeWorkerMailboxService = Effect.fn("WorkerMailboxService.make")(function* (
  sql: SqlClient.SqlClient,
  store: WorkerEngineStore,
) {
  const wakeupPubSub = yield* Effect.acquireRelease(
    PubSub.unbounded<WakeupSignal>(),
    PubSub.shutdown,
  );

  const postMessages = (
    inputs: ReadonlyArray<PostMailboxMessageInput>,
  ): Effect.Effect<ReadonlyArray<WorkerMailboxMessageRecord>, WorkerEngineError> =>
    Effect.gen(function* () {
      if (inputs.length === 0) return [];
      const inserted = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const nowMs = yield* Clock.currentTimeMillis;
            const results: WorkerMailboxMessageRecord[] = [];
            for (const input of inputs) {
              const messageId = `msg_${NodeCrypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
              const payloadJson =
                input.payload === undefined ? null : JSON.stringify(input.payload);
              yield* sql`
                INSERT INTO worker_mailbox_messages (
                  message_id, run_id, thread_id, task_id, dispatch_id, fencing_token,
                  from_actor, to_actor, type, outcome, subject, body, payload_json, created_at_ms
                ) VALUES (
                  ${messageId}, ${input.runId}, ${input.threadId}, ${input.taskId ?? null},
                  ${input.dispatchId ?? null}, ${input.fencingToken ?? null},
                  ${input.fromActor}, ${input.toActor}, ${input.type}, ${input.outcome ?? null},
                  ${input.subject}, ${input.body}, ${payloadJson}, ${nowMs}
                )
              `;
              const rows = yield* sql<MailboxMessageRow>`
                SELECT * FROM worker_mailbox_messages WHERE message_id = ${messageId} LIMIT 1
              `;
              results.push(rowToMessage(rows[0]!));
            }
            return results;
          }),
        )
        .pipe(Effect.mapError(mapSqlError("postMessages")));

      for (const message of inserted) {
        yield* PubSub.publish(wakeupPubSub, {
          runId: message.runId,
          threadId: message.threadId,
          toActor: message.toActor,
          type: message.type,
        });
      }
      return inserted;
    });

  const postMessage = (
    input: PostMailboxMessageInput,
  ): Effect.Effect<WorkerMailboxMessageRecord, WorkerEngineError> =>
    postMessages([input]).pipe(Effect.map((list) => list[0]!));

  const queryUnreadCandidates = (filter: WorkerCheckInput, includeAssignedToDelivery: boolean) =>
    Effect.gen(function* () {
      let rows: ReadonlyArray<MailboxMessageRow>;
      if (filter.runId) {
        rows = includeAssignedToDelivery
          ? yield* sql<MailboxMessageRow>`
              SELECT * FROM worker_mailbox_messages
              WHERE run_id = ${filter.runId} AND acknowledged_at_ms IS NULL
              ORDER BY sequence ASC LIMIT 200
            `
          : yield* sql<MailboxMessageRow>`
              SELECT * FROM worker_mailbox_messages
              WHERE run_id = ${filter.runId} AND acknowledged_at_ms IS NULL AND delivery_id IS NULL
              ORDER BY sequence ASC LIMIT 200
            `;
      } else if (filter.threadId) {
        rows = includeAssignedToDelivery
          ? yield* sql<MailboxMessageRow>`
              SELECT * FROM worker_mailbox_messages
              WHERE thread_id = ${filter.threadId} AND acknowledged_at_ms IS NULL
              ORDER BY sequence ASC LIMIT 200
            `
          : yield* sql<MailboxMessageRow>`
              SELECT * FROM worker_mailbox_messages
              WHERE thread_id = ${filter.threadId} AND acknowledged_at_ms IS NULL AND delivery_id IS NULL
              ORDER BY sequence ASC LIMIT 200
            `;
      } else if (filter.toActor) {
        rows = includeAssignedToDelivery
          ? yield* sql<MailboxMessageRow>`
              SELECT * FROM worker_mailbox_messages
              WHERE to_actor = ${filter.toActor} AND acknowledged_at_ms IS NULL
              ORDER BY sequence ASC LIMIT 200
            `
          : yield* sql<MailboxMessageRow>`
              SELECT * FROM worker_mailbox_messages
              WHERE to_actor = ${filter.toActor} AND acknowledged_at_ms IS NULL AND delivery_id IS NULL
              ORDER BY sequence ASC LIMIT 200
            `;
      } else {
        rows = includeAssignedToDelivery
          ? yield* sql<MailboxMessageRow>`
              SELECT * FROM worker_mailbox_messages
              WHERE acknowledged_at_ms IS NULL
              ORDER BY sequence ASC LIMIT 200
            `
          : yield* sql<MailboxMessageRow>`
              SELECT * FROM worker_mailbox_messages
              WHERE acknowledged_at_ms IS NULL AND delivery_id IS NULL
              ORDER BY sequence ASC LIMIT 200
            `;
      }
      return rows.map(rowToMessage).filter((m) => matchesFilter(m, filter));
    }).pipe(Effect.mapError(mapSqlError("queryUnreadCandidates")));

  const claimDeliveryOnce = (
    input: WorkerCheckInput,
    clampedTimeoutSec: number,
  ): Effect.Effect<WorkerCheckResult, WorkerEngineError> =>
    Effect.gen(function* () {
      const limit = Math.max(1, Math.min(100, input.limit ?? 20));
      const activeDispatches = yield* store.listActiveDispatches({
        runId: input.runId,
        threadId: input.threadId,
      });

      // Peek mode never claims a delivery and never marks messages delivered.
      if (input.peek) {
        const unread = yield* queryUnreadCandidates(input, true);
        return {
          deliveryId: null,
          replayed: false,
          messages: unread.slice(0, limit),
          hasMore: unread.length > limit,
          activeDispatches,
          clampedTimeoutSec,
        };
      }

      const mailboxHandle = deriveMailboxHandle(input);
      const consumerGeneration = input.consumerGeneration ?? 0;

      const claimed = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            // 1. Replay any existing unacknowledged (`outstanding`) delivery for this mailbox & generation.
            const outstandingRows = yield* sql<MailboxDeliveryRow>`
              SELECT * FROM worker_mailbox_deliveries
              WHERE mailbox_handle = ${mailboxHandle}
                AND consumer_generation = ${consumerGeneration}
                AND status = 'outstanding'
              ORDER BY created_at_ms ASC LIMIT 1
            `;
            if (outstandingRows[0]) {
              const delivery = outstandingRows[0];
              const msgRows = yield* sql<MailboxMessageRow>`
                SELECT * FROM worker_mailbox_messages
                WHERE delivery_id = ${delivery.delivery_id} AND acknowledged_at_ms IS NULL
                ORDER BY sequence ASC
              `;
              const replayedMessages = msgRows
                .map(rowToMessage)
                .filter((m) => matchesFilter(m, input));
              if (replayedMessages.length > 0) {
                const remainingUnread = yield* queryUnreadCandidates(input, false);
                return {
                  deliveryId: delivery.delivery_id,
                  replayed: true,
                  messages: replayedMessages,
                  hasMore: remainingUnread.length > 0,
                };
              }
            }

            // 2. Claim the oldest unread messages in strict FIFO order into a new `outstanding` delivery.
            const unread = yield* queryUnreadCandidates(input, false);
            if (unread.length === 0) {
              return {
                deliveryId: null,
                replayed: false,
                messages: [] as WorkerMailboxMessageRecord[],
                hasMore: false,
              };
            }

            const batch = unread.slice(0, limit);
            const hasMore = unread.length > limit;
            const nowMs = yield* Clock.currentTimeMillis;
            const deliveryId = `del_${NodeCrypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
            const messageIds = batch.map((m) => m.messageId);
            const runId = input.runId ?? batch[0]!.runId;

            yield* sql`
              INSERT INTO worker_mailbox_deliveries (
                delivery_id, run_id, mailbox_handle, consumer_generation,
                message_ids_json, status, created_at_ms
              ) VALUES (
                ${deliveryId}, ${runId}, ${mailboxHandle}, ${consumerGeneration},
                ${JSON.stringify(messageIds)}, 'outstanding', ${nowMs}
              )
            `;

            for (const msg of batch) {
              yield* sql`
                UPDATE worker_mailbox_messages
                SET delivery_id = ${deliveryId}, delivered_at_ms = ${nowMs}
                WHERE message_id = ${msg.messageId}
              `;
            }

            return {
              deliveryId,
              replayed: false,
              messages: batch.map((m) => ({
                ...m,
                deliveryId,
                deliveredAtMs: nowMs,
              })),
              hasMore,
            };
          }),
        )
        .pipe(
          Effect.catch((error) =>
            error instanceof WorkerEngineError
              ? Effect.fail(error)
              : Effect.fail(mapSqlError("claimDeliveryOnce")(error)),
          ),
        );

      return {
        ...claimed,
        activeDispatches,
        clampedTimeoutSec,
      };
    });

  const checkMailbox = (
    input: WorkerCheckInput,
  ): Effect.Effect<WorkerCheckResult, WorkerEngineError> =>
    Effect.gen(function* () {
      const clampedTimeoutSec = clampWorkerWaitSeconds(input.timeoutSec, 60);
      if (!input.wait) {
        return yield* claimDeliveryOnce(input, clampedTimeoutSec);
      }

      // Subscribe BEFORE checking DB so a concurrent `postMessage` can never race between check & wait.
      return yield* Effect.scoped(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(wakeupPubSub);
          const initial = yield* claimDeliveryOnce(input, clampedTimeoutSec);
          if (initial.messages.length > 0) {
            return initial;
          }

          const deadlineMs = (yield* Clock.currentTimeMillis) + clampedTimeoutSec * 1_000;
          while (true) {
            const nowMs = yield* Clock.currentTimeMillis;
            const remainingMs = deadlineMs - nowMs;
            if (remainingMs <= 0) {
              return yield* claimDeliveryOnce(input, clampedTimeoutSec);
            }
            const nextSignal = yield* PubSub.take(subscription).pipe(
              Effect.timeoutOption(Duration.millis(remainingMs)),
            );
            if (Option.isNone(nextSignal)) {
              return yield* claimDeliveryOnce(input, clampedTimeoutSec);
            }
            const signal = nextSignal.value;
            const relevant =
              (!input.runId || signal.runId === input.runId) &&
              (!input.threadId || signal.threadId === input.threadId) &&
              (!input.toActor || signal.toActor === input.toActor) &&
              (!input.types || input.types.length === 0 || input.types.includes(signal.type));
            if (!relevant) {
              continue;
            }
            const nextCheck = yield* claimDeliveryOnce(input, clampedTimeoutSec);
            if (nextCheck.messages.length > 0) {
              return nextCheck;
            }
          }
        }),
      );
    });

  const ackDelivery = (input: WorkerAckInput): Effect.Effect<WorkerAckResult, WorkerEngineError> =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql<MailboxDeliveryRow>`
            SELECT * FROM worker_mailbox_deliveries WHERE delivery_id = ${input.deliveryId} LIMIT 1
          `;
          const delivery = rows[0];
          if (!delivery) {
            return yield* new WorkerEngineError({
              code: "not_found",
              message: `Delivery '${input.deliveryId}' not found.`,
            });
          }
          if (delivery.status === "fenced") {
            return yield* new WorkerEngineError({
              code: "fencing_rejected",
              message: `Delivery '${input.deliveryId}' belongs to a fenced consumer.`,
            });
          }
          if (
            input.consumerGeneration !== undefined &&
            Number(delivery.consumer_generation) !== input.consumerGeneration
          ) {
            return yield* new WorkerEngineError({
              code: "fencing_rejected",
              message: `Delivery '${input.deliveryId}' consumer generation mismatch (expected ${delivery.consumer_generation}, got ${input.consumerGeneration}).`,
            });
          }
          if (delivery.status === "acknowledged") {
            return {
              deliveryId: input.deliveryId,
              acknowledged: true,
              acknowledgedMessageCount: 0,
            };
          }

          const nowMs = yield* Clock.currentTimeMillis;
          const messageIds = JSON.parse(delivery.message_ids_json) as string[];
          for (const messageId of messageIds) {
            yield* sql`
              UPDATE worker_mailbox_messages
              SET acknowledged_at_ms = ${nowMs}
              WHERE message_id = ${messageId} AND acknowledged_at_ms IS NULL
            `;
          }
          yield* sql`
            UPDATE worker_mailbox_deliveries
            SET status = 'acknowledged', acknowledged_at_ms = ${nowMs}
            WHERE delivery_id = ${input.deliveryId}
          `;
          return {
            deliveryId: input.deliveryId,
            acknowledged: true,
            acknowledgedMessageCount: messageIds.length,
          };
        }),
      )
      .pipe(
        Effect.catch((error) =>
          error instanceof WorkerEngineError
            ? Effect.fail(error)
            : Effect.fail(mapSqlError("ackDelivery")(error)),
        ),
      );

  const fenceOutstandingDeliveries = (mailboxHandle: string, maxOldGeneration: number) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql<MailboxDeliveryRow>`
            SELECT * FROM worker_mailbox_deliveries
            WHERE mailbox_handle = ${mailboxHandle}
              AND status = 'outstanding'
              AND consumer_generation <= ${maxOldGeneration}
          `;
          for (const delivery of rows) {
            yield* sql`
              UPDATE worker_mailbox_deliveries
              SET status = 'fenced'
              WHERE delivery_id = ${delivery.delivery_id}
            `;
            yield* sql`
              UPDATE worker_mailbox_messages
              SET delivery_id = NULL
              WHERE delivery_id = ${delivery.delivery_id} AND acknowledged_at_ms IS NULL
            `;
          }
          return rows.length;
        }),
      )
      .pipe(Effect.mapError(mapSqlError("fenceOutstandingDeliveries")));

  const countUnread = (filter?: {
    readonly runId?: string | undefined;
    readonly threadId?: string | undefined;
    readonly toActor?: string | undefined;
  }) =>
    Effect.gen(function* () {
      const unread = yield* queryUnreadCandidates(
        {
          ...(filter?.runId ? { runId: filter.runId } : {}),
          ...(filter?.threadId ? { threadId: filter.threadId } : {}),
          ...(filter?.toActor ? { toActor: filter.toActor } : {}),
        },
        true,
      );
      return unread.length;
    });

  return {
    postMessage,
    postMessages,
    checkMailbox,
    ackDelivery,
    fenceOutstandingDeliveries,
    countUnread,
  };
});

export type WorkerMailboxService = Effect.Success<ReturnType<typeof makeWorkerMailboxService>>;
