import {
  ModelSelection,
  MessageId,
  WorkspaceOrchestraBlock,
  TokenCounts,
  TokenUsageIssue,
  TokenUsageObservation,
  TokenUsagePhase,
  TokenUsageWork,
  type GetThreadTokenUsageInput,
  type OrchestrationEvent,
  type ThreadTokenUsageReport,
  type TokenUsageBreakdown,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { toPersistenceSqlError, toPersistenceDecodeError } from "../../persistence/Errors.ts";
import { addTokenCounts, advanceTokenUsage, emptyTokenCounts } from "../tokenUsage.ts";

const CountsJson = Schema.fromJsonString(TokenCounts);
const IssuesJson = Schema.fromJsonString(Schema.Array(TokenUsageIssue));
const decodeCounts = Schema.decodeUnknownEffect(CountsJson);
const decodeIssues = Schema.decodeUnknownEffect(IssuesJson);
const encodeCounts = Schema.encodeSync(CountsJson);
const encodeIssues = Schema.encodeSync(IssuesJson);
const isOrchestraBlock = Schema.is(WorkspaceOrchestraBlock);
const parseBlockMessage = Schema.decodeUnknownOption(Schema.Struct({ messageId: MessageId }));
const encodeKey = Schema.encodeSync(
  Schema.fromJsonString(Schema.Array(Schema.Union([Schema.String, Schema.Number]))),
);
const parseConsumption = Schema.decodeUnknownOption(
  Schema.Struct({
    consumption: Schema.Array(TokenUsageObservation),
  }),
);
const NativeTask = Schema.Struct({
  agentKind: Schema.optional(Schema.String),
  taskType: Schema.optional(Schema.String),
});
const RequestRow = Schema.Struct({
  requestId: Schema.String,
  model: Schema.String,
  instanceId: Schema.String,
  phase: TokenUsagePhase,
  attempt: Schema.Number,
  status: Schema.String,
  hasNativeChildren: Schema.Number,
});
const SampleRow = Schema.Struct({
  requestId: Schema.String,
  provider: Schema.String,
  model: Schema.String,
  counts: CountsJson,
  issues: IssuesJson,
});

/** Called inside the projection transaction; the existing event log is the raw ledger. */
const decodeModelSelection = Schema.decodeUnknownEffect(Schema.fromJsonString(ModelSelection));
const decodeNativeTask = Schema.decodeUnknownOption(NativeTask);
const decodeWorks = Schema.decodeUnknownEffect(Schema.Array(TokenUsageWork));
const decodeRequests = Schema.decodeUnknownEffect(Schema.Array(RequestRow));
const decodeSamples = Schema.decodeUnknownEffect(Schema.Array(SampleRow));

export const makeTokenUsageProjection = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const [collection] = yield* sql<{ afterSequence: number; startedAt: string }>`
    SELECT after_sequence AS "afterSequence", started_at AS "startedAt"
    FROM token_usage_collection WHERE id = 1`;
  if (!collection) return yield* Effect.die("Token usage collection migration is missing");

  const apply = Effect.fn("TokenUsageProjection.apply")(
    function* (event: OrchestrationEvent) {
      if (event.sequence <= collection.afterSequence) return;
      if (event.type === "thread.turn-start-requested") {
        const p = event.payload;
        const [thread] = yield* sql<{ selection: string }>`
        SELECT model_selection_json AS selection FROM projection_threads WHERE thread_id = ${p.threadId}`;
        const selection =
          p.modelSelection ??
          (thread
            ? yield* decodeModelSelection(thread.selection).pipe(
                Effect.mapError(toPersistenceDecodeError("TokenUsageProjection.model")),
              )
            : null);
        const workId = p.usageContext ? `run:${p.usageContext.workId}` : `request:${p.messageId}`;
        yield* sql`INSERT OR IGNORE INTO projection_token_usage_requests
        (request_id, thread_id, work_id, requested_sequence, requested_at,
         model, instance_id, phase, attempt, node_id, status)
        VALUES (${p.messageId}, ${p.threadId}, ${workId}, ${event.sequence}, ${p.createdAt},
          ${selection?.model ?? "unknown"}, ${selection?.instanceId ?? "unknown"},
          ${p.usageContext?.phase ?? "general"}, ${p.usageContext?.attempt ?? 1},
          ${p.usageContext?.nodeId ?? null}, 'pending')`;
        return;
      }
      if (event.type === "thread.session-set") {
        const { threadId, session } = event.payload;
        if (session.activeTurnId !== null && session.status === "running") {
          yield* sql`UPDATE projection_token_usage_requests
          SET turn_id = ${session.activeTurnId}, status = 'running'
          WHERE request_id = (
            SELECT request_id FROM projection_token_usage_requests
            WHERE thread_id = ${threadId} AND turn_id IS NULL AND status = 'pending'
            ORDER BY requested_sequence DESC LIMIT 1
          ) AND NOT EXISTS (
            SELECT 1 FROM projection_token_usage_requests
            WHERE thread_id = ${threadId} AND turn_id = ${session.activeTurnId}
          )`;
        } else if (["idle", "ready", "error", "interrupted", "stopped"].includes(session.status)) {
          yield* sql`UPDATE projection_token_usage_requests SET status = ${session.status}
          WHERE thread_id = ${threadId} AND status = 'running'`;
          if (["error", "interrupted", "stopped"].includes(session.status)) {
            yield* sql`UPDATE projection_token_usage_requests SET status = ${session.status}
            WHERE thread_id = ${threadId} AND status = 'pending'`;
          }
        }
        return;
      }
      // Restoring code/history never refunds tokens already spent.
      if (event.type !== "thread.activity-appended") return;
      const { threadId, activity } = event.payload;
      if (activity.kind === "orchestra.block" && isOrchestraBlock(activity.payload)) {
        const block = activity.payload;
        const phase =
          block.kind === "validation"
            ? "verification"
            : block.kind === "synthesis"
              ? "finalization"
              : block.kind === "orchestration" || block.kind === "research"
                ? "planning"
                : "implementation";
        yield* sql`INSERT INTO projection_token_usage_requests
          (request_id, thread_id, work_id, requested_sequence, requested_at, model, instance_id, phase, attempt, node_id, status)
          VALUES (${block.messageId}, ${threadId}, ${`run:${block.runId}`}, ${event.sequence}, ${activity.createdAt},
          ${block.modelSelection.model}, ${block.modelSelection.instanceId}, ${phase}, ${block.attempt}, ${block.nodeId}, ${block.status})
          ON CONFLICT(request_id) DO UPDATE SET status = excluded.status`;
        return;
      }
      if (activity.kind !== "context-window.updated" && activity.kind !== "task.started") return;
      const parsed =
        activity.kind === "context-window.updated"
          ? parseConsumption(activity.payload)
          : Option.none();
      if (activity.kind === "context-window.updated" && Option.isNone(parsed)) return;
      const blockMessage = parseBlockMessage(activity.payload);
      const blockRequestId = Option.isSome(blockMessage) ? blockMessage.value.messageId : null;
      const [request] =
        activity.turnId === null && blockRequestId === null
          ? []
          : yield* sql<{
              requestId: string;
              model: string;
              instanceId: string;
            }>`SELECT request_id AS "requestId", model, instance_id AS "instanceId"
      FROM projection_token_usage_requests WHERE thread_id = ${threadId} AND
        ((${blockRequestId} IS NOT NULL AND request_id = ${blockRequestId}) OR (${blockRequestId} IS NULL AND turn_id = ${activity.turnId}))`;

      if (activity.kind === "task.started" && request) {
        const task = decodeNativeTask(activity.payload);
        if (
          Option.isSome(task) &&
          (task.value.agentKind === "agent" ||
            (task.value.agentKind === undefined && task.value.taskType !== "plan"))
        ) {
          yield* sql`UPDATE projection_token_usage_requests SET has_native_children = 1
          WHERE request_id = ${request.requestId}`;
        }
      }
      if (activity.kind !== "context-window.updated") return;
      if (Option.isNone(parsed)) return;
      for (const observation of parsed.value.consumption) {
        const sourceId = encodeKey([
          threadId,
          ...(blockRequestId === null ? [] : [blockRequestId]),
          observation.provider,
          observation.sourceId,
        ]);
        const [cursor] = yield* sql<{ counts: string; sequence: number }>`
        SELECT counts_json AS counts, last_sequence AS sequence FROM projection_token_usage_cursors
        WHERE source_id = ${sourceId}`;
        if (cursor && cursor.sequence >= event.sequence) continue;
        const previous = cursor
          ? yield* decodeCounts(cursor.counts).pipe(
              Effect.mapError(toPersistenceDecodeError("TokenUsageProjection.cursor")),
            )
          : null;
        const advanced = advanceTokenUsage(previous, observation);
        yield* sql`INSERT INTO projection_token_usage_cursors (source_id, counts_json, last_sequence)
        VALUES (${sourceId}, ${encodeCounts(advanced.cursor)}, ${event.sequence})
        ON CONFLICT(source_id) DO UPDATE SET counts_json = excluded.counts_json,
          last_sequence = excluded.last_sequence`;
        if (!request) continue;
        const [existing] = yield* sql<{ counts: string; issues: string }>`
        SELECT counts_json AS counts, issues_json AS issues FROM projection_token_usage_samples
        WHERE request_id = ${request.requestId} AND source_id = ${sourceId}`;
        const counts = existing
          ? yield* decodeCounts(existing.counts).pipe(
              Effect.mapError(toPersistenceDecodeError("TokenUsageProjection.sample")),
            )
          : emptyTokenCounts();
        const issues = existing
          ? yield* decodeIssues(existing.issues).pipe(
              Effect.mapError(toPersistenceDecodeError("TokenUsageProjection.issues")),
            )
          : [];
        const nextIssues = new Set(issues);
        if (advanced.issue !== null) nextIssues.add(advanced.issue);
        if (observation.isFinal) nextIssues.delete("final-usage-unconfirmed");
        else if (!existing || (advanced.delta.total ?? 0) > 0)
          nextIssues.add("final-usage-unconfirmed");
        yield* sql`INSERT INTO projection_token_usage_samples
        (request_id, source_id, provider, model, counts_json, issues_json)
        VALUES (${request.requestId}, ${sourceId}, ${observation.provider},
          ${observation.model ?? request.model}, ${encodeCounts(addTokenCounts(counts, advanced.delta))},
          ${encodeIssues([...nextIssues])})
        ON CONFLICT(request_id, source_id) DO UPDATE SET
          counts_json = excluded.counts_json, issues_json = excluded.issues_json`;
      }
    },
    Effect.mapError(toPersistenceSqlError("TokenUsageProjection.apply")),
  );

  const getReport = Effect.fn("TokenUsageProjection.getReport")(
    function* (input: GetThreadTokenUsageInput) {
      const workRows = yield* sql`
      SELECT work_id AS "workId", MIN(requested_at) AS "requestedAt", MIN(requested_sequence) AS sequence
      FROM projection_token_usage_requests WHERE thread_id = ${input.threadId}
      GROUP BY work_id HAVING MIN(requested_sequence) < ${input.beforeSequence ?? Number.MAX_SAFE_INTEGER}
      ORDER BY sequence DESC LIMIT 21`;
      const allWorks = yield* decodeWorks(workRows).pipe(
        Effect.mapError(toPersistenceDecodeError("TokenUsageProjection.works")),
      );
      const recentWorks = allWorks.slice(0, 20);
      let work = recentWorks[0] ?? null;
      if (input.workId !== undefined) {
        const requestedWork = yield* sql`
        SELECT work_id AS "workId", MIN(requested_at) AS "requestedAt", MIN(requested_sequence) AS sequence
        FROM projection_token_usage_requests
        WHERE thread_id = ${input.threadId} AND work_id = ${input.workId}
        GROUP BY work_id`;
        const decoded = yield* decodeWorks(requestedWork).pipe(
          Effect.mapError(toPersistenceDecodeError("TokenUsageProjection.work")),
        );
        work = decoded[0] ?? null;
      }
      const base = {
        collectedSince: collection.startedAt,
        work,
        recentWorks,
        nextBeforeSequence: allWorks.length > 20 ? recentWorks.at(-1)!.sequence : null,
      };
      if (!work) {
        const historic = yield* sql`SELECT 1 FROM orchestration_events
        WHERE aggregate_kind = 'thread' AND stream_id = ${input.threadId}
          AND sequence <= ${collection.afterSequence} AND event_type = 'thread.turn-start-requested'
        LIMIT 1`;
        return {
          ...base,
          coverage: historic.length > 0 ? "before-collection" : "unavailable",
          counts: emptyTokenCounts(),
          breakdown: [],
          issues: [],
          inProgress: false,
          finality: "provisional",
          outcome: "unknown",
          verificationStatus: "not-evaluated",
        } satisfies ThreadTokenUsageReport;
      }
      const requests =
        yield* sql`SELECT request_id AS "requestId", model, instance_id AS "instanceId",
      phase, attempt, status, has_native_children AS "hasNativeChildren"
      FROM projection_token_usage_requests WHERE work_id = ${work.workId}`;
      const decodedRequests = yield* decodeRequests(requests).pipe(
        Effect.mapError(toPersistenceDecodeError("TokenUsageProjection.requests")),
      );
      const samples = yield* sql`SELECT s.request_id AS "requestId", s.provider, s.model,
      s.counts_json AS counts, s.issues_json AS issues FROM projection_token_usage_samples s
      JOIN projection_token_usage_requests r ON r.request_id = s.request_id WHERE r.work_id = ${work.workId}`;
      const decodedSamples = yield* decodeSamples(samples).pipe(
        Effect.mapError(toPersistenceDecodeError("TokenUsageProjection.samples")),
      );
      const byRequest = Map.groupBy(decodedSamples, (sample) => sample.requestId);
      const breakdown = new Map<string, TokenUsageBreakdown>();
      for (const request of decodedRequests) {
        const rows = byRequest.get(request.requestId) ?? [
          {
            provider: request.instanceId,
            model: request.model,
            counts: emptyTokenCounts(),
            issues: ["unreported" as const],
          },
        ];
        for (const row of rows) {
          const key = encodeKey([row.provider, row.model, request.phase, request.attempt]);
          const previous = breakdown.get(key);
          const issues = new Set<TokenUsageIssue>([...(previous?.issues ?? []), ...row.issues]);
          if (row.counts.total === null) issues.add("unreported");
          if (request.hasNativeChildren) issues.add("native-child-coverage-unknown");
          breakdown.set(key, {
            provider: row.provider,
            model: row.model,
            phase: request.phase,
            attempt: request.attempt,
            counts: addTokenCounts(previous?.counts ?? emptyTokenCounts(), row.counts),
            issues: [...issues],
          });
        }
      }
      const rows = [...breakdown.values()];
      const counts = rows.reduce((sum, row) => addTokenCounts(sum, row.counts), emptyTokenCounts());
      const issues = [...new Set(rows.flatMap((row) => row.issues))];
      const [run] = work.workId.startsWith("run:")
        ? yield* sql<{ status: string }>`
      SELECT status FROM projection_workspace_collaboration_runs WHERE run_id = ${work.workId.slice(4)}`
        : [];
      const inProgress = run
        ? ["queued", "running", "cancel-requested"].includes(run.status)
        : decodedRequests.some((request) => ["pending", "running"].includes(request.status));
      const failed = run
        ? run.status === "failed"
        : decodedRequests.some((request) => request.status === "error");
      const interrupted = run
        ? run.status === "cancelled"
        : decodedRequests.some((request) => ["stopped", "interrupted"].includes(request.status));
      return {
        ...base,
        counts,
        breakdown: rows,
        issues,
        coverage:
          counts.total === null ? "unavailable" : issues.length > 0 ? "partial" : "reported",
        inProgress,
        finality:
          inProgress || issues.includes("final-usage-unconfirmed") || issues.includes("unreported")
            ? "provisional"
            : "final",
        outcome: inProgress
          ? "running"
          : failed
            ? "failed"
            : interrupted
              ? "interrupted"
              : "completed",
        verificationStatus: "not-evaluated",
      } satisfies ThreadTokenUsageReport;
    },
    sql.withTransaction,
    Effect.mapError(toPersistenceSqlError("TokenUsageProjection.getReport")),
  );
  return { apply, getReport };
});
