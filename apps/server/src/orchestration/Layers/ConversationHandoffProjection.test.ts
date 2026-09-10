import { OrchestrationEvent, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ServerConfig } from "../../config.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../ThreadPlanProgress.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";

const testLayer = Layer.mergeAll(
  OrchestrationProjectionSnapshotQueryLive,
  OrchestrationProjectionPipelineLive,
).pipe(
  Layer.provideMerge(OrchestrationEventStoreLive),
  Layer.provide(ThreadBackgroundLiveness.layer),
  Layer.provide(ThreadPlanProgress.layer),
  Layer.provide(RepositoryIdentityResolver.layer),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-handoff-projection-" })),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(NodeServices.layer),
);
const decodeEvent = Schema.decodeUnknownSync(OrchestrationEvent);
const now = "2026-09-05T03:00:00.000Z";

it.layer(testLayer)("handoff persistence", (it) => {
  it.effect(
    "defaults off, survives replay, exposes the same mode in all snapshots and restores standard mode",
    () =>
      Effect.gen(function* () {
        const store = yield* OrchestrationEventStore;
        const pipeline = yield* OrchestrationProjectionPipeline;
        const query = yield* ProjectionSnapshotQuery;
        const sql = yield* SqlClient.SqlClient;
        let sequence = 0;
        const append = (type: OrchestrationEvent["type"], payload: unknown, id = "thread-1") =>
          store.append(
            decodeEvent({
              sequence: ++sequence,
              eventId: `event-${sequence}`,
              type,
              payload,
              aggregateKind: type === "project.created" ? "project" : "thread",
              aggregateId: id,
              commandId: `command-${sequence}`,
              causationEventId: null,
              correlationId: null,
              metadata: {},
              occurredAt: now,
            }),
          );
        yield* append(
          "project.created",
          {
            projectId: "project-1",
            title: "Project",
            workspaceRoot: process.cwd(),
            defaultModelSelection: null,
            scripts: [],
            createdAt: now,
            updatedAt: now,
          },
          "project-1",
        );
        for (const id of ["thread-1", "thread-2"])
          yield* append(
            "thread.created",
            {
              threadId: id,
              projectId: "project-1",
              title: "Thread",
              modelSelection: { instanceId: "codex", model: "unchanged" },
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: null,
              createdAt: now,
              updatedAt: now,
            },
            id,
          );
        yield* pipeline.bootstrap;
        const threadId = ThreadId.make("thread-1");
        assert.equal(
          Option.getOrThrow(yield* query.getThreadShellById(threadId)).handoffMode,
          "standard",
        );
        const enabled = yield* append("thread.meta-updated", {
          threadId,
          handoffMode: "compact",
          updatedAt: now,
        });
        yield* pipeline.projectEvent(enabled);
        assert.equal(
          Option.getOrThrow(yield* query.getThreadDetailById(threadId)).handoffMode,
          "compact",
        );
        assert.equal(
          (yield* query.getShellSnapshot()).threads.find((t) => t.id === threadId)?.handoffMode,
          "compact",
        );
        assert.equal(
          (yield* query.getCommandReadModel()).threads.find((t) => t.id === threadId)?.handoffMode,
          "compact",
        );
        assert.equal(
          Option.getOrThrow(yield* query.getThreadShellById(ThreadId.make("thread-2"))).handoffMode,
          "standard",
        );
        yield* pipeline.bootstrap;
        yield* pipeline.projectEvent(enabled);
        assert.equal(
          Option.getOrThrow(yield* query.getThreadShellById(threadId)).handoffMode,
          "compact",
        );
        const disabled = yield* append("thread.meta-updated", {
          threadId,
          handoffMode: "standard",
          updatedAt: now,
        });
        yield* pipeline.projectEvent(disabled);
        assert.equal(
          Option.getOrThrow(yield* query.getThreadShellById(threadId)).handoffMode,
          "standard",
        );

        const answer = {
          threadId,
          requestId: "input-request",
          answers: { rollout: { answers: ["opt-in"] } },
          createdAt: now,
        };
        const first = yield* append("thread.user-input-response-requested", answer);
        yield* append(
          "thread.user-input-response-requested",
          { ...answer, threadId: "thread-2" },
          "thread-2",
        );
        const future = yield* append("thread.user-input-response-requested", {
          ...answer,
          requestId: "future-choice",
        });
        const decisions = yield* query.getThreadHandoffDecisions!({
          threadId,
          beforeSequence: future.sequence,
        });
        assert.equal(decisions.length, 1);
        assert.equal(decisions[0]?.id, first.eventId);
        assert.deepEqual(decisions[0]?.payload, answer);
        // No native acknowledgement/activity is needed to preserve a committed user choice.
        const [stored] = yield* sql<{
          handoff_mode: string;
        }>`SELECT handoff_mode FROM projection_threads WHERE thread_id = ${threadId}`;
        assert.equal(stored?.handoff_mode, "standard");
      }),
  );
});
