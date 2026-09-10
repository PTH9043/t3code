import {
  OrchestrationEvent,
  ThreadId,
  type TokenUsageObservation,
  type TokenUsageContext,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { makeTokenUsageProjection } from "./TokenUsageProjection.ts";

const decodeEvent = Schema.decodeUnknownSync(OrchestrationEvent);

const now = "2026-09-05T12:00:00.000Z";
const event = (
  sequence: number,
  type: OrchestrationEvent["type"],
  thread: string,
  payload: unknown,
) =>
  decodeEvent({
    sequence,
    type,
    eventId: `event-${sequence}-${thread}`,
    aggregateKind: "thread",
    aggregateId: thread,
    occurredAt: now,
    commandId: `command-${sequence}-${thread}`,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload,
  });
const request = (sequence: number, thread: string, id: string, context?: TokenUsageContext) =>
  event(sequence, "thread.turn-start-requested", thread, {
    threadId: thread,
    messageId: id,
    modelSelection: { instanceId: "codex", model: "model-at-request" },
    runtimeMode: "full-access",
    interactionMode: "default",
    createdAt: now,
    ...(context ? { usageContext: context } : {}),
  });
const session = (sequence: number, thread: string, turn: string | null, status = "running") =>
  event(sequence, "thread.session-set", thread, {
    threadId: thread,
    session: {
      threadId: thread,
      status,
      providerName: "codex",
      providerInstanceId: "codex",
      runtimeMode: "full-access",
      activeTurnId: turn,
      lastError: null,
      updatedAt: now,
    },
  });
const usage = (
  sequence: number,
  thread: string,
  turn: string,
  total: number,
  mode: TokenUsageObservation["mode"] = "cumulative",
  source = "native",
) =>
  event(sequence, "thread.activity-appended", thread, {
    threadId: thread,
    activity: {
      id: `usage-${sequence}`,
      createdAt: now,
      tone: "info",
      kind: "context-window.updated",
      summary: "Context window updated",
      turnId: turn,
      payload: {
        usedTokens: 99999,
        consumption: [
          {
            sourceId: source,
            mode,
            provider: "codex",
            model: null,
            isFinal: true,
            counts: {
              total,
              input: total,
              output: 0,
              cacheRead: 0,
              cacheWrite: null,
              reasoning: null,
            },
          },
        ],
      },
    },
  });

it.layer(SqlitePersistenceMemory)("TokenUsageProjection", (it) => {
  it.effect(
    "keeps simultaneous blocks and retries independent when a provider reuses its usage source id",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const projection = yield* makeTokenUsageProjection;
        let sequence = 1000;
        for (const [messageId, total, attempt] of [
          ["block-a", 100, 1],
          ["block-b", 150, 1],
          ["block-a-retry", 50, 2],
        ] as const) {
          yield* projection.apply(
            event(sequence++, "thread.activity-appended", "orchestra-owner", {
              threadId: "orchestra-owner",
              activity: {
                id: messageId,
                kind: "orchestra.block",
                tone: "info",
                summary: "Work",
                turnId: null,
                createdAt: now,
                payload: {
                  executionId: messageId,
                  ownerThreadId: "orchestra-owner",
                  runId: "parallel-run",
                  nodeId: messageId,
                  attempt,
                  messageId,
                  title: "Work",
                  displayName: "AI",
                  role: "implementer",
                  kind: "implementation",
                  modelSelection: { instanceId: "codex", model: "test" },
                  status: "running",
                },
              },
            }),
          );
          const observation = usage(
            sequence++,
            "orchestra-owner",
            "unused",
            total,
            "execution-total",
          );
          if (observation.type !== "thread.activity-appended")
            throw new Error("Expected usage activity");
          yield* projection.apply({
            ...observation,
            payload: {
              ...observation.payload,
              activity: {
                ...observation.payload.activity,
                turnId: null,
                payload: { ...(observation.payload.activity.payload as object), messageId },
              },
            },
          });
        }
        const rows = yield* sql<{
          request_id: string;
          counts_json: string;
        }>`SELECT request_id, counts_json FROM projection_token_usage_samples ORDER BY request_id`;
        assert.deepStrictEqual(
          rows.map((row) => [row.request_id, JSON.parse(row.counts_json).total]),
          [
            ["block-a", 100],
            ["block-a-retry", 50],
            ["block-b", 150],
          ],
        );
      }),
  );

  it.effect(
    "reports a successful retry as completed while retaining the failed attempt's spend",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO projection_projects
      (project_id, title, workspace_root, scripts_json, created_at, updated_at)
      VALUES ('retry-project', 'Retry', 'D:/retry-project', '[]', ${now}, ${now})`;
        yield* sql`INSERT INTO projection_workspace_collaboration_runs
      (run_id, project_id, source, task, status, created_at, updated_at)
      VALUES ('retry-run', 'retry-project', 'user', 'Retry task', 'completed', ${now}, ${now})`;
        const projection = yield* makeTokenUsageProjection;
        yield* projection.apply(
          request(300, "retry", "attempt-1", {
            workId: "retry-run",
            phase: "implementation",
            nodeId: "node",
            attempt: 1,
          }),
        );
        yield* projection.apply(session(301, "retry", "try-1"));
        yield* projection.apply(
          usage(302, "retry", "try-1", 400, "execution-total", "try-result-1"),
        );
        yield* projection.apply(session(303, "retry", null, "error"));
        yield* projection.apply(
          request(304, "retry", "attempt-2", {
            workId: "retry-run",
            phase: "implementation",
            nodeId: "node",
            attempt: 2,
          }),
        );
        yield* projection.apply(session(305, "retry", "try-2"));
        yield* projection.apply(
          usage(306, "retry", "try-2", 600, "execution-total", "try-result-2"),
        );
        yield* projection.apply(session(307, "retry", null, "ready"));
        const report = yield* projection.getReport({ threadId: ThreadId.make("retry") });
        assert.strictEqual(report.counts.total, 1000);
        assert.strictEqual(report.outcome, "completed");
        assert.strictEqual(report.breakdown.find((row) => row.attempt === 2)?.counts.total, 600);
      }),
  );
  it.effect("persists baselines across reconstruction and deduplicates repeated events", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const first = yield* makeTokenUsageProjection;
      const apply = (e: OrchestrationEvent) => sql.withTransaction(first.apply(e));
      yield* apply(request(1, "restart", "r1"));
      yield* apply(session(2, "restart", "t1"));
      yield* apply(usage(3, "restart", "t1", 1000));
      yield* apply(usage(4, "restart", "t1", 1250));
      yield* apply(usage(4, "restart", "t1", 1250));
      yield* apply(session(5, "restart", null, "ready"));
      const restarted = yield* makeTokenUsageProjection;
      yield* sql.withTransaction(restarted.apply(request(6, "restart", "r2")));
      yield* sql.withTransaction(restarted.apply(session(7, "restart", "t2")));
      yield* sql.withTransaction(restarted.apply(usage(8, "restart", "t2", 1400)));
      const report = yield* restarted.getReport({ threadId: ThreadId.make("restart") });
      assert.strictEqual(report.counts.total, 150);
      assert.strictEqual(report.coverage, "reported");
      const earlier = yield* restarted.getReport({
        threadId: ThreadId.make("restart"),
        workId: "request:r1",
      });
      assert.strictEqual(earlier.counts.total, 250);
      assert.deepEqual(earlier.issues, ["baseline-required"]);
      assert.strictEqual(earlier.inProgress, false);
    }),
  );

  it.effect(
    "groups implementation, verification and retries across threads without inventing unsupported usage",
    () =>
      Effect.gen(function* () {
        const projection = yield* makeTokenUsageProjection;
        const sql = yield* SqlClient.SqlClient;
        const apply = (e: OrchestrationEvent) => sql.withTransaction(projection.apply(e));
        yield* apply(
          request(20, "impl", "r-impl", {
            workId: "collab",
            phase: "implementation",
            nodeId: "n1",
            attempt: 1,
          }),
        );
        yield* apply(session(21, "impl", "t-impl"));
        yield* apply(usage(22, "impl", "t-impl", 200, "execution-total", "result-1"));
        yield* apply(usage(23, "impl", "t-impl", 200, "execution-total", "result-1"));
        yield* apply(
          request(24, "verify", "r-verify", {
            workId: "collab",
            phase: "verification",
            nodeId: "n2",
            attempt: 2,
          }),
        );
        yield* apply(session(25, "verify", "t-verify"));
        yield* apply(usage(26, "verify", "t-verify", 200, "execution-total", "result-2"));
        yield* apply(
          request(27, "unsupported", "r-other", {
            workId: "collab",
            phase: "finalization",
            nodeId: null,
            attempt: 1,
          }),
        );
        const report = yield* projection.getReport({ threadId: ThreadId.make("impl") });
        assert.strictEqual(report.counts.total, 400);
        assert.strictEqual(report.coverage, "partial");
        assert.strictEqual(report.breakdown.length, 3);
        assert.strictEqual(report.breakdown.find((r) => r.phase === "verification")?.attempt, 2);
        assert.strictEqual(
          report.breakdown.find((r) => r.phase === "finalization")?.counts.total,
          null,
        );
        const unrelated = yield* projection.getReport({
          threadId: ThreadId.make("other-thread"),
          workId: "run:collab",
        });
        assert.strictEqual(unrelated.work, null);
        assert.strictEqual(unrelated.counts.total, null);
      }),
  );

  it.effect(
    "ignores pre-collection events and distinguishes historical data from unreported new work",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE token_usage_collection SET after_sequence = 50 WHERE id = 1`;
        const projection = yield* makeTokenUsageProjection;
        yield* projection.apply(request(49, "old", "old-request"));
        yield* sql`INSERT INTO orchestration_events
      (sequence, event_id, aggregate_kind, stream_id, stream_version, event_type,
       occurred_at, actor_kind, payload_json, metadata_json)
      VALUES (49, 'old-event', 'thread', 'old', 1, 'thread.turn-start-requested',
        ${now}, 'user', '{}', '{}')`;
        const historic = yield* projection.getReport({ threadId: ThreadId.make("old") });
        assert.strictEqual(historic.coverage, "before-collection");
        assert.strictEqual(historic.counts.total, null);
        yield* projection.apply(request(51, "new", "new-request"));
        const current = yield* projection.getReport({ threadId: ThreadId.make("new") });
        assert.strictEqual(current.coverage, "unavailable");
        assert.strictEqual(current.counts.total, null);
        yield* sql`UPDATE token_usage_collection SET after_sequence = 0 WHERE id = 1`;
      }),
  );

  it.effect(
    "rebuilds identically, keeps partial failures and never charges unassigned counter intervals to the next turn",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const projection = yield* makeTokenUsageProjection;
        const events = [
          request(100, "rebuild", "rb1"),
          session(101, "rebuild", "rb-t1"),
          usage(102, "rebuild", "rb-t1", 1000),
          usage(103, "rebuild", "rb-t1", 1200),
          session(104, "rebuild", null, "error"),
          // This native turn has no known T3 request; advance the cursor only.
          usage(105, "rebuild", "unassigned-native-turn", 1600),
          request(106, "rebuild", "rb2"),
          session(107, "rebuild", "rb-t2"),
          usage(108, "rebuild", "rb-t2", 1800),
          session(109, "rebuild", null, "ready"),
        ];
        for (const e of events) yield* sql.withTransaction(projection.apply(e));
        const before = yield* projection.getReport({ threadId: ThreadId.make("rebuild") });
        assert.strictEqual(before.counts.total, 200);
        const failed = yield* projection.getReport({
          threadId: ThreadId.make("rebuild"),
          workId: "request:rb1",
        });
        assert.strictEqual(failed.counts.total, 200);
        assert.strictEqual(failed.outcome, "failed");
        yield* sql`DELETE FROM projection_token_usage_samples WHERE request_id IN ('rb1','rb2')`;
        yield* sql`DELETE FROM projection_token_usage_requests WHERE thread_id = 'rebuild'`;
        yield* sql`DELETE FROM projection_token_usage_cursors WHERE source_id LIKE '%"rebuild"%'`;
        const rebuilt = yield* makeTokenUsageProjection;
        for (const e of events) yield* sql.withTransaction(rebuilt.apply(e));
        const after = yield* rebuilt.getReport({ threadId: ThreadId.make("rebuild") });
        assert.deepEqual(after, before);
      }),
  );

  it.effect(
    "marks unfinished reports and native child gaps without adding child totals twice",
    () =>
      Effect.gen(function* () {
        const projection = yield* makeTokenUsageProjection;
        yield* projection.apply(request(150, "partial", "partial-1"));
        yield* projection.apply(session(151, "partial", "partial-turn"));
        const observation = usage(
          152,
          "partial",
          "partial-turn",
          100,
          "execution-total",
          "partial-result",
        );
        if (observation.type !== "thread.activity-appended") return;
        const payload = {
          usedTokens: 100,
          consumption: [
            {
              sourceId: "partial-result",
              mode: "execution-total",
              provider: "claude",
              model: null,
              counts: {
                total: 100,
                input: 80,
                output: 20,
                cacheRead: 0,
                cacheWrite: 0,
                reasoning: null,
              },
            },
          ],
        };
        yield* projection.apply({
          ...observation,
          payload: {
            ...observation.payload,
            activity: { ...observation.payload.activity, payload },
          },
        });
        yield* projection.apply(
          event(153, "thread.activity-appended", "partial", {
            threadId: "partial",
            activity: {
              id: "child",
              createdAt: now,
              tone: "info",
              kind: "task.started",
              summary: "Child",
              turnId: "partial-turn",
              payload: { agentKind: "agent", taskId: "child-1", totalTokens: 5000 },
            },
          }),
        );
        yield* projection.apply(session(154, "partial", null, "interrupted"));
        const report = yield* projection.getReport({ threadId: ThreadId.make("partial") });
        assert.strictEqual(report.counts.total, 100);
        assert.strictEqual(report.finality, "provisional");
        assert.strictEqual(report.outcome, "interrupted");
        assert.include(report.issues, "final-usage-unconfirmed");
        assert.include(report.issues, "native-child-coverage-unknown");
      }),
  );

  it.effect("paginates equal timestamps by unique request sequence", () =>
    Effect.gen(function* () {
      const projection = yield* makeTokenUsageProjection;
      for (let n = 0; n < 23; n++) yield* projection.apply(request(200 + n, "pages", `page-${n}`));
      const first = yield* projection.getReport({ threadId: ThreadId.make("pages") });
      assert.strictEqual(first.recentWorks.length, 20);
      assert.strictEqual(first.nextBeforeSequence, 203);
      const second = yield* projection.getReport({
        threadId: ThreadId.make("pages"),
        beforeSequence: first.nextBeforeSequence!,
      });
      assert.strictEqual(second.recentWorks.length, 3);
      assert.strictEqual(second.nextBeforeSequence, null);
      assert.strictEqual(
        new Set([...first.recentWorks, ...second.recentWorks].map((work) => work.workId)).size,
        23,
      );
    }),
  );
});
