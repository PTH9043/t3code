import {
  OrchestrationEvent,
  ThreadId,
  ProjectId,
  type TokenUsageObservation,
  type TokenUsageContext,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { makeTokenUsageProjection } from "./TokenUsageProjection.ts";
import { emptyTokenCounts } from "../tokenUsage.ts";

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
  it.effect("does not attribute an omitted field's earlier interval to the next request", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const projection = yield* makeTokenUsageProjection;
      const apply = (value: OrchestrationEvent) => sql.withTransaction(projection.apply(value));
      yield* apply(request(1, "field-boundary", "field-boundary-r1"));
      yield* apply(session(2, "field-boundary", "t1"));
      yield* apply(usage(3, "field-boundary", "t1", 1000));
      yield* apply(
        event(4, "thread.activity-appended", "field-boundary", {
          threadId: "field-boundary",
          activity: {
            id: "field-boundary-partial",
            createdAt: now,
            tone: "info",
            kind: "context-window.updated",
            summary: "Partial final usage",
            turnId: "t1",
            payload: {
              consumption: [
                {
                  sourceId: "native",
                  mode: "cumulative",
                  provider: "codex",
                  model: null,
                  isFinal: true,
                  counts: { ...emptyTokenCounts(), total: 1250 },
                },
              ],
            },
          },
        }),
      );
      yield* apply(session(5, "field-boundary", null, "ready"));
      const reconstructed = yield* makeTokenUsageProjection;
      yield* sql.withTransaction(
        reconstructed.apply(request(6, "field-boundary", "field-boundary-r2")),
      );
      yield* sql.withTransaction(reconstructed.apply(session(7, "field-boundary", "t2")));
      yield* sql.withTransaction(reconstructed.apply(usage(8, "field-boundary", "t2", 1500)));
      const first = yield* reconstructed.getReport({ threadId: ThreadId.make("field-boundary") });
      assert.strictEqual(first.counts.total, 250);
      assert.strictEqual(first.counts.input, null);
      yield* sql.withTransaction(reconstructed.apply(usage(9, "field-boundary", "t2", 1600)));
      const final = yield* reconstructed.getReport({ threadId: ThreadId.make("field-boundary") });
      assert.strictEqual(final.counts.total, 350);
      assert.strictEqual(final.counts.input, 100);
    }),
  );
  it.effect(
    "persists omitted field baselines across reconstruction without losing later usage",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const projection = yield* makeTokenUsageProjection;
        yield* sql.withTransaction(projection.apply(request(1, "omitted-fields", "omitted-r1")));
        yield* sql.withTransaction(projection.apply(session(2, "omitted-fields", "t1")));
        yield* sql.withTransaction(
          projection.apply(usage(3, "omitted-fields", "t1", 1000, "cumulative", "omitted-native")),
        );
        yield* sql.withTransaction(
          projection.apply(
            event(4, "thread.activity-appended", "omitted-fields", {
              threadId: "omitted-fields",
              activity: {
                id: "partial-usage",
                createdAt: now,
                tone: "info",
                kind: "context-window.updated",
                summary: "Partial usage snapshot",
                turnId: "t1",
                payload: {
                  consumption: [
                    {
                      sourceId: "omitted-native",
                      mode: "cumulative",
                      provider: "codex",
                      model: null,
                      isFinal: true,
                      counts: { ...emptyTokenCounts(), total: 1250 },
                    },
                  ],
                },
              },
            }),
          ),
        );
        const reconstructed = yield* makeTokenUsageProjection;
        yield* sql.withTransaction(
          reconstructed.apply(
            usage(5, "omitted-fields", "t1", 1450, "cumulative", "omitted-native"),
          ),
        );
        yield* sql.withTransaction(
          reconstructed.apply(
            usage(6, "omitted-fields", "t1", 1450, "cumulative", "omitted-native"),
          ),
        );
        const report = yield* reconstructed.getReport({
          threadId: ThreadId.make("omitted-fields"),
        });
        assert.strictEqual(report.counts.total, 450);
        assert.strictEqual(report.counts.input, 450);
        assert.strictEqual(report.counts.output, 0);
      }),
  );
  it.effect(
    "attributes restart recovery input after a stop receipt and excludes replayed old Codex spend",
    () =>
      Effect.gen(function* () {
        const projection = yield* makeTokenUsageProjection;
        const observation = (sequence: number, turn: string, total: number, epoch: string) => {
          const result = usage(
            sequence,
            "recovery-accounting",
            turn,
            total,
            "cumulative",
            `codex:native-recovery#${epoch}`,
          );
          if (result.type !== "thread.activity-appended") throw new Error("Expected activity");
          const payload = result.payload.activity.payload as {
            consumption: readonly TokenUsageObservation[];
          };
          return {
            ...result,
            payload: {
              ...result.payload,
              activity: {
                ...result.payload.activity,
                payload: {
                  ...payload,
                  consumption: payload.consumption.map((item) => ({ ...item, startsAtZero: true })),
                },
              },
            },
          };
        };
        yield* projection.apply(request(6000, "recovery-accounting", "before-restart"));
        yield* projection.apply(session(6001, "recovery-accounting", "old-turn"));
        yield* projection.apply(observation(6002, "old-turn", 100, "original"));
        yield* projection.apply(request(6003, "recovery-accounting", "after-restart"));
        yield* projection.apply(session(6004, "recovery-accounting", null, "stopped"));
        yield* projection.apply(observation(6005, "old-turn", 100, "resumed"));
        yield* projection.apply(session(6006, "recovery-accounting", "new-turn"));
        yield* projection.apply(observation(6007, "new-turn", 150, "resumed"));
        yield* projection.apply(session(6008, "recovery-accounting", null, "ready"));
        const before = yield* projection.getReport({
          threadId: ThreadId.make("recovery-accounting"),
          workId: "request:before-restart",
        });
        const after = yield* projection.getReport({
          threadId: ThreadId.make("recovery-accounting"),
          workId: "request:after-restart",
        });
        assert.strictEqual(before.counts.total, 100);
        assert.strictEqual(after.counts.total, 50);
        assert.strictEqual(after.outcome, "completed");
        yield* projection.apply(request(6009, "recovery-accounting", "reset-counter"));
        yield* projection.apply(session(6010, "recovery-accounting", "reset-turn"));
        yield* projection.apply(observation(6011, "reset-turn", 25, "reset"));
        assert.strictEqual(
          (yield* projection.getReport({ threadId: ThreadId.make("recovery-accounting") })).counts
            .total,
          25,
        );
      }),
  );
  it.effect(
    "combines Main, Owners and retries per goal, filters each task and scopes daily project usage",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const projection = yield* makeTokenUsageProjection;
        for (const [id, project] of [
          ["goal-main", "goal-project"],
          ["foreign", "foreign-project"],
        ]) {
          yield* sql`INSERT INTO projection_projects (project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES (${project},'Goal','D:/goal','[]',${now},${now})`;
          yield* sql`INSERT INTO projection_threads (thread_id,project_id,title,model_selection_json,created_at,updated_at) VALUES (${id},${project},'Main','{"instanceId":"codex","model":"test"}',${now},${now})`;
        }
        yield* projection.apply(request(5000, "goal-main", "goal-manual"));
        yield* projection.apply(session(5001, "goal-main", "goal-turn"));
        yield* projection.apply(usage(5002, "goal-main", "goal-turn", 100, "execution-total"));
        const link = event(5003, "thread.activity-appended", "goal-main", {
          threadId: "goal-main",
          activity: {
            id: "goal-link",
            kind: "token-usage.work-linked",
            tone: "info",
            summary: "Goal",
            createdAt: now,
            turnId: null,
            payload: {
              requestId: "goal-manual",
              usageContext: { workId: "goal-total", phase: "planning", nodeId: null, attempt: 1 },
            },
          },
        });
        yield* projection.apply(link);
        yield* projection.apply(link);
        for (const [id, total, attempt] of [
          ["owner-first", 200, 1],
          ["owner-retry", 50, 2],
        ] as const) {
          yield* projection.apply(
            event(5004 + attempt, "thread.activity-appended", "goal-main", {
              threadId: "goal-main",
              activity: {
                id,
                kind: "orchestra.block",
                tone: "info",
                summary: "Owner",
                createdAt: now,
                turnId: null,
                payload: {
                  executionId: id,
                  ownerThreadId: "goal-main",
                  runId: `separate-run-${attempt}`,
                  usageWorkId: "goal-total",
                  nodeId: "owner-task",
                  attempt,
                  messageId: id,
                  title: "Owner",
                  displayName: "AI",
                  role: "implementer",
                  kind: "implementation",
                  modelSelection: { instanceId: "codex", model: "test" },
                  status: "completed",
                },
              },
            }),
          );
          const observation = usage(
            5007 + attempt,
            "goal-main",
            "unused",
            total,
            "execution-total",
            id,
          );
          if (observation.type !== "thread.activity-appended") throw new Error("Expected activity");
          yield* projection.apply({
            ...observation,
            payload: {
              ...observation.payload,
              activity: {
                ...observation.payload.activity,
                turnId: null,
                payload: { ...(observation.payload.activity.payload as object), messageId: id },
              },
            },
          });
        }
        yield* projection.apply(session(5010, "goal-main", null, "ready"));
        yield* projection.apply(request(5011, "foreign", "foreign-request"));
        yield* projection.apply(session(5012, "foreign", "foreign-turn"));
        yield* projection.apply(usage(5013, "foreign", "foreign-turn", 999, "execution-total"));
        const report = yield* projection.getReport({
          threadId: ThreadId.make("goal-main"),
          workId: "run:goal-total",
        });
        assert.strictEqual(report.counts.total, 350);
        assert.strictEqual(report.requestCount, 3);
        assert.strictEqual(report.reportedRequestCount, 3);
        const owner = yield* projection.getReport({
          threadId: ThreadId.make("goal-main"),
          workId: "run:goal-total",
          nodeId: "owner-task",
        });
        assert.strictEqual(owner.counts.total, 250);
        assert.strictEqual(owner.requestCount, 2);
        const daily = yield* projection.getProjectReport({
          projectId: ProjectId.make("goal-project"),
          since: "2026-09-05T00:00:00Z",
        });
        assert.strictEqual(daily.counts.total, 350);
        assert.strictEqual(daily.requestCount, 3);
        assert.strictEqual(
          (yield* projection.getProjectReport({
            projectId: ProjectId.make("goal-project"),
            since: "2026-09-06T00:00:00Z",
          })).requestCount,
          0,
        );
      }),
  );
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
                  ...(attempt === 2 ? { usagePhase: "format-repair" } : {}),
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
        }>`SELECT request_id, counts_json FROM projection_token_usage_samples WHERE request_id IN (SELECT request_id FROM projection_token_usage_requests WHERE thread_id = 'orchestra-owner') ORDER BY request_id`;
        assert.deepStrictEqual(
          rows.map((row) => [row.request_id, JSON.parse(row.counts_json).total]),
          [
            ["block-a", 100],
            ["block-a-retry", 50],
            ["block-b", 150],
          ],
        );
        const phases = yield* sql<{
          request_id: string;
          phase: string;
        }>`SELECT request_id,phase FROM projection_token_usage_requests WHERE thread_id = 'orchestra-owner' ORDER BY request_id`;
        assert.deepStrictEqual(
          phases.map((row) => [row.request_id, row.phase]),
          [
            ["block-a", "implementation"],
            ["block-a-retry", "format-repair"],
            ["block-b", "implementation"],
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
        const nodeUsage = yield* projection.getReport({
          threadId: ThreadId.make("impl"),
          workId: "run:collab",
          nodeId: "n2",
        });
        assert.strictEqual(nodeUsage.counts.total, 200);
        assert.strictEqual(nodeUsage.breakdown.length, 1);
        assert.strictEqual(nodeUsage.breakdown[0]?.phase, "verification");
        assert.strictEqual(nodeUsage.breakdown[0]?.attempt, 2);
        const unknownNode = yield* projection.getReport({
          threadId: ThreadId.make("impl"),
          workId: "run:collab",
          nodeId: "unknown-node",
        });
        assert.strictEqual(unknownNode.counts.total, null);
        assert.strictEqual(unknownNode.requestCount, 0);
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

  it.effect("treats subagent spend reported inside Claude modelUsage as covered", () =>
    Effect.gen(function* () {
      const projection = yield* makeTokenUsageProjection;
      yield* projection.apply(request(170, "conductor", "conductor-request"));
      yield* projection.apply(session(171, "conductor", "conductor-turn"));
      yield* projection.apply(
        event(172, "thread.activity-appended", "conductor", {
          threadId: "conductor",
          activity: {
            id: "worker",
            createdAt: now,
            tone: "info",
            kind: "task.started",
            summary: "Worker",
            turnId: "conductor-turn",
            payload: { agentKind: "agent", taskId: "worker-1" },
          },
        }),
      );
      const observation = (model: string, total: number) => ({
        sourceId: `claude:session:result:${model}`,
        mode: "execution-total" as const,
        provider: "claude",
        model,
        isFinal: true,
        includesNativeChildren: true,
        counts: { ...emptyTokenCounts(), total, input: total, output: 0 },
      });
      yield* projection.apply(
        event(173, "thread.activity-appended", "conductor", {
          threadId: "conductor",
          activity: {
            id: "conductor-usage",
            createdAt: now,
            tone: "info",
            kind: "context-window.updated",
            summary: "Context window updated",
            turnId: "conductor-turn",
            payload: {
              consumption: [
                observation("claude-fable-5-2", 300),
                observation("claude-opus-5-5", 1200),
              ],
            },
          },
        }),
      );
      yield* projection.apply(session(174, "conductor", null, "ready"));
      const report = yield* projection.getReport({ threadId: ThreadId.make("conductor") });
      assert.strictEqual(report.counts.total, 1500);
      assert.notInclude(report.issues, "native-child-coverage-unknown");
      assert.strictEqual(report.coverage, "reported");
      assert.strictEqual(report.finality, "final");
      assert.deepStrictEqual(
        report.breakdown.map((row) => [row.model, row.counts.total]).toSorted(),
        [
          ["claude-fable-5-2", 300],
          ["claude-opus-5-5", 1200],
        ],
      );
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
