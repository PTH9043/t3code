import { EventId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ProjectionThreadActivityRepository } from "../Services/ProjectionThreadActivities.ts";
import { ProjectionThreadActivityRepositoryLive } from "./ProjectionThreadActivities.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

it.layer(
  ProjectionThreadActivityRepositoryLive.pipe(
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provide(NodeServices.layer),
  ),
)("session recovery activity reads", (it) => {
  it.effect(
    "keeps question/task history and scheduled wakeups without hydrating other tool output",
    () =>
      Effect.gen(function* () {
        const repository = yield* ProjectionThreadActivityRepository;
        const threadId = ThreadId.make("recovery-thread");
        const at = "2026-10-19T00:00:00.000Z";
        const rows = [
          { id: "question", kind: "user-input.requested", payload: { requestId: "question-1" } },
          {
            id: "background",
            kind: "task.started",
            payload: { taskId: "task-1", agentKind: "background" },
          },
          {
            id: "wakeup",
            kind: "tool.completed",
            payload: { data: { toolName: "ScheduleWakeup", input: { delaySeconds: 60 } } },
          },
          {
            id: "large-tool",
            kind: "tool.completed",
            payload: { data: { toolName: "Read", output: "x".repeat(1_000_000) } },
          },
          {
            id: "ordinary",
            kind: "tool.started",
            payload: { data: { toolName: "ScheduleWakeup" } },
          },
        ];
        for (const [index, row] of rows.entries()) {
          yield* repository.upsert({
            activityId: EventId.make(row.id),
            threadId,
            turnId: null,
            tone: "info",
            kind: row.kind,
            summary: row.id,
            payload: row.payload,
            sequence: index + 1,
            createdAt: at,
          });
        }
        const recovery = yield* repository.listByThreadIdAndKinds({
          threadId,
          kinds: ["user-input.requested", "task.started"],
          completedToolNames: ["ScheduleWakeup"],
        });
        assert.deepStrictEqual(
          recovery.map((row) => row.activityId),
          ["question", "background", "wakeup"],
        );
        const toolsOnly = yield* repository.listByThreadIdAndKinds({
          threadId,
          kinds: [],
          completedToolNames: ["ScheduleWakeup"],
        });
        assert.deepStrictEqual(
          toolsOnly.map((row) => row.activityId),
          ["wakeup"],
        );
        const kindOnly = yield* repository.listByThreadIdAndKinds({
          threadId,
          kinds: ["task.started"],
        });
        assert.deepStrictEqual(
          kindOnly.map((row) => row.activityId),
          ["background"],
        );
        const overlapping = yield* repository.listByThreadIdAndKinds({
          threadId,
          kinds: ["tool.completed"],
          completedToolNames: ["ScheduleWakeup"],
        });
        assert.deepStrictEqual(
          overlapping.map((row) => row.activityId),
          ["wakeup", "large-tool"],
        );
        assert.deepStrictEqual(
          yield* repository.listByThreadIdAndKinds({ threadId, kinds: [] }),
          [],
        );
        const full = yield* repository.listByThreadId({ threadId });
        assert.equal(full.length, 5);
        assert.deepStrictEqual(full[3]?.payload, rows[3]?.payload);
        const other = yield* repository.listByThreadIdAndKinds({
          threadId: ThreadId.make("other-thread"),
          kinds: ["task.started"],
          completedToolNames: ["ScheduleWakeup"],
        });
        assert.deepStrictEqual(other, []);
      }),
  );
});
