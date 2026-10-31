import type { OrchestrationEvent, ProjectId, WorkspaceKnowledgeItemId } from "@t3tools/contracts";
import { makeKeyedCoalescingWorker } from "@t3tools/shared/KeyedCoalescingWorker";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { forkParked } from "../../serverActivation.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { WorkspaceKnowledgeFileStore } from "../Services/WorkspaceKnowledgeFileStore.ts";
import { WorkspaceMemory } from "../WorkspaceMemory.ts";
import {
  WorkspaceKnowledgeReactor,
  type WorkspaceKnowledgeReactorShape,
} from "../Services/WorkspaceKnowledgeReactor.ts";

type ReactorInput = {
  readonly projectId: ProjectId;
  readonly itemId?: WorkspaceKnowledgeItemId;
  readonly reason: "startup" | "item-upserted" | "item-archived" | "root-updated" | "turn-settled";
};

export const makeWorkspaceKnowledgeReactor = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const fileStore = yield* WorkspaceKnowledgeFileStore;
  const memory = yield* Effect.serviceOption(WorkspaceMemory);

  const reconcile = Effect.fn("WorkspaceKnowledgeReactor.reconcile")(function* (
    input: ReactorInput,
  ) {
    const project = yield* projectionSnapshotQuery.getProjectShellById(input.projectId);
    if (Option.isNone(project)) return;
    if (Option.isSome(memory)) yield* memory.value.reconcile(input.projectId);
    const root = project.value.workspaceControl?.longTermMemoryRoot ?? null;
    if (root === null) return;

    const listWorkspaceKnowledge = projectionSnapshotQuery.listWorkspaceKnowledge;
    if (listWorkspaceKnowledge === undefined) {
      return yield* Effect.logWarning(
        "Workspace knowledge projection is unavailable; physical memory reconciliation skipped",
        { projectId: input.projectId, reason: input.reason },
      );
    }

    const result = yield* listWorkspaceKnowledge({
      projectId: input.projectId,
      kinds: ["long-term-memory"],
    });
    const items = result.items;
    yield* Effect.forEach(items, (item) => fileStore.syncItem({ root, item }), {
      concurrency: 1,
      discard: true,
    });
  });

  const reconcileSafely = (input: ReactorInput) =>
    reconcile(input).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
        return Effect.logWarning("Workspace physical long-term-memory reconciliation failed", {
          projectId: input.projectId,
          itemId: input.itemId,
          reason: input.reason,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const coalescingWorker = yield* makeKeyedCoalescingWorker({
    merge: (_current: ReactorInput, next: ReactorInput) => next,
    process: (_projectId: ProjectId, input: ReactorInput) => reconcileSafely(input),
  });
  const worker = {
    enqueue: (input: ReactorInput) => coalescingWorker.enqueue(input.projectId, input),
    drain: coalescingWorker.drain,
  };
  const enqueueThread = (threadId: import("@t3tools/contracts").ThreadId) =>
    projectionSnapshotQuery.getThreadShellById(threadId).pipe(
      Effect.flatMap((thread) =>
        Option.isSome(thread)
          ? worker.enqueue({ projectId: thread.value.projectId, reason: "turn-settled" })
          : Effect.void,
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not queue completed-turn memory", { cause: Cause.pretty(cause) }),
      ),
    );

  const enqueueEvent = (event: OrchestrationEvent) => {
    switch (event.type) {
      case "project.knowledge-item-upserted":
        return worker.enqueue({
          projectId: event.payload.projectId,
          itemId: event.payload.itemId,
          reason: "item-upserted",
        });
      case "thread.turn-diff-completed":
        return Option.isSome(memory) ? enqueueThread(event.payload.threadId) : Effect.void;
      case "thread.session-set":
        return Option.isSome(memory) &&
          ["ready", "interrupted", "stopped", "error"].includes(event.payload.session.status)
          ? enqueueThread(event.payload.threadId)
          : Effect.void;
      case "project.knowledge-item-archived":
        return worker.enqueue({
          projectId: event.payload.projectId,
          itemId: event.payload.itemId,
          reason: "item-archived",
        });
      case "project.workspace-control-updated":
        return worker.enqueue({
          projectId: event.payload.projectId,
          reason: "root-updated",
        });
      default:
        return Effect.void;
    }
  };

  const enqueueStartupReconciliation = projectionSnapshotQuery.getShellSnapshot().pipe(
    Effect.flatMap((snapshot) =>
      Effect.forEach(
        snapshot.projects,
        (project) => worker.enqueue({ projectId: project.id, reason: "startup" }),
        { concurrency: 1, discard: true },
      ),
    ),
    Effect.catchCause((cause) =>
      Effect.logWarning("Workspace physical long-term-memory startup reconciliation failed", {
        cause: Cause.pretty(cause),
      }),
    ),
  );

  const start: WorkspaceKnowledgeReactorShape["start"] = Effect.fn("start")(function* () {
    yield* forkParked(Stream.runForEach(orchestrationEngine.streamDomainEvents, enqueueEvent), {
      startImmediately: true,
    });
    yield* enqueueStartupReconciliation;
  });

  return {
    start,
    drain: worker.drain,
  } satisfies WorkspaceKnowledgeReactorShape;
});

export const WorkspaceKnowledgeReactorLive = Layer.effect(
  WorkspaceKnowledgeReactor,
  makeWorkspaceKnowledgeReactor,
);
