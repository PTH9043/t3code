import { OrchestrationEvent, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer, Option, Schema } from "effect";
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

const decodeEvent = Schema.decodeUnknownEffect(OrchestrationEvent);

const testLayer = Layer.mergeAll(
  OrchestrationProjectionSnapshotQueryLive,
  OrchestrationProjectionPipelineLive,
).pipe(
  Layer.provideMerge(OrchestrationEventStoreLive),
  Layer.provide(ThreadBackgroundLiveness.layer),
  Layer.provide(ThreadPlanProgress.layer),
  Layer.provide(RepositoryIdentityResolver.layer),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-conversation-import-" })),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(NodeServices.layer),
);
const at = "2026-10-05T01:00:00.000Z";
const threadId = ThreadId.make("imported");
it.layer(testLayer)("imported conversation persistence", (it) => {
  it.effect(
    "projects messages and source metadata consistently, replays without duplicates and never queues an imported user turn",
    () =>
      Effect.gen(function* () {
        const store = yield* OrchestrationEventStore;
        const pipeline = yield* OrchestrationProjectionPipeline;
        const query = yield* ProjectionSnapshotQuery;
        const projectEvent = yield* decodeEvent({
          sequence: 1,
          eventId: "project-event",
          type: "project.created",
          payload: {
            projectId: "project",
            title: "Project",
            workspaceRoot: process.cwd(),
            defaultModelSelection: null,
            scripts: [],
            createdAt: at,
            updatedAt: at,
          },
          aggregateKind: "project",
          aggregateId: "project",
          commandId: "project-command",
          causationEventId: null,
          correlationId: null,
          metadata: {},
          occurredAt: at,
        });
        const importedEvent = yield* decodeEvent({
          sequence: 2,
          eventId: "import-event",
          type: "thread.created",
          payload: {
            projectId: "project",
            threadId,
            title: "Imported",
            modelSelection: { instanceId: "grok", model: "grok-build" },
            runtimeMode: "approval-required",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdAt: at,
            updatedAt: at,
            importedConversation: {
              format: "codex",
              sourceHash: "a".repeat(64),
              sourceSessionId: "original-session",
              messages: [
                { role: "user", text: "Keep my context", createdAt: at },
                { role: "assistant", text: "Original answer", createdAt: at },
              ],
            },
          },
          aggregateKind: "thread",
          aggregateId: threadId,
          commandId: "import-command",
          causationEventId: null,
          correlationId: null,
          metadata: {},
          occurredAt: at,
        });
        yield* store.append(projectEvent);
        yield* store.append(importedEvent);
        yield* pipeline.bootstrap;
        const read = Effect.gen(function* () {
          const thread = Option.getOrThrow(yield* query.getThreadDetailById(threadId));
          assert.deepEqual(
            thread.messages.map((message) => message.text),
            ["Keep my context", "Original answer"],
          );
          assert.equal(thread.session, null);
          assert.equal(thread.latestTurn, null);
          assert.equal(thread.activities.length, 1);
          assert.equal(thread.activities[0]?.kind, "conversation.imported");
          assert.deepEqual(thread.activities[0]?.payload, {
            format: "codex",
            sourceHash: "a".repeat(64),
            sourceSessionId: "original-session",
            messageCount: 2,
          });
          assert.equal(
            Option.getOrThrow(yield* query.getThreadShellById(threadId)).latestUserMessageAt,
            null,
          );
          assert.equal(
            (yield* query.getShellSnapshot()).threads.find((item) => item.id === threadId)?.session,
            null,
          );
        });
        yield* read;
        yield* pipeline.projectEvent(importedEvent);
        yield* read;
        yield* pipeline.bootstrap;
        yield* read;
      }),
  );
});
