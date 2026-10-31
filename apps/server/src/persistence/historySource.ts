import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

const sources = [
  {
    kind: "message",
    table: "projection_thread_messages",
    where: "thread_id=?",
    order: "created_at,message_id",
  },
  {
    kind: "activity",
    table: "projection_thread_activities",
    where: "thread_id=?",
    order: "sequence,created_at,activity_id",
  },
  { kind: "plan", table: "projection_thread_proposed_plans", where: "thread_id=?", order: "rowid" },
  { kind: "checkpoint", table: "projection_turns", where: "thread_id=?", order: "row_id" },
  {
    kind: "event",
    table: "orchestration_events",
    where: "aggregate_kind='thread' AND stream_id=?",
    order: "sequence",
  },
] as const;

/** Bun's SQL adapter lacks streams; use bounded keyset pages on the same read transaction. */
export const readHistorySource = Effect.fn("readHistorySource")(function* (
  sql: SqlClient.SqlClient,
  threadId: string,
  header: Readonly<Record<string, unknown>>,
  streamingSupported: boolean,
) {
  if (streamingSupported) {
    let records: Stream.Stream<
      Readonly<Record<string, unknown>>,
      import("effect/unstable/sql/SqlError").SqlError
    > = Stream.make(header);
    for (const source of sources)
      records = Stream.concat(
        records,
        sql.unsafe<Readonly<Record<string, unknown>>>(
          `SELECT '${source.kind}' AS record_type,* FROM ${source.table} WHERE ${source.where} ORDER BY ${source.order}`,
          [threadId],
        ).stream,
      );
    return yield* Stream.toAsyncIterableEffect(records);
  }
  const run = Effect.runPromiseWith(yield* Effect.context<never>());
  return {
    async *[Symbol.asyncIterator]() {
      yield { ...header, ordering: "source-rowid" };
      for (const source of sources) {
        let cursor = 0;
        while (true) {
          const rows = await run(
            sql.unsafe<Readonly<Record<string, unknown>> & { __archiveRowId: number }>(
              `SELECT rowid AS __archiveRowId,'${source.kind}' AS record_type,* FROM ${source.table} WHERE ${source.where} AND rowid>? ORDER BY rowid LIMIT 8`,
              [threadId, cursor],
            ),
          );
          if (!rows.length) break;
          for (const row of rows) {
            const { __archiveRowId, ...record } = row;
            if (!Number.isSafeInteger(__archiveRowId) || __archiveRowId <= cursor)
              throw new Error("History source cursor did not advance");
            cursor = __archiveRowId;
            yield record;
          }
        }
      }
    },
  } satisfies AsyncIterable<Readonly<Record<string, unknown>>>;
});
