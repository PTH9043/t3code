import type { OrchestrationEvent, ProjectId, WorkspaceKnowledgeItemId } from "@t3tools/contracts";
import { makeKeyedCoalescingWorker } from "@t3tools/shared/KeyedCoalescingWorker";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import { forkParked } from "../../serverActivation.ts";
import { ServerConfig } from "../../config.ts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { resumePdfRevisions } from "../../documents/pdfRevision.ts";
import { resumePdfIndexJobs } from "../../documents/resumePdfIndexJobs.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { WorkspaceKnowledgeFileStore } from "../Services/WorkspaceKnowledgeFileStore.ts";
import { activeWorkRegistry } from "../ActiveWorkTracker.ts";
import { WorkspaceMemory } from "../WorkspaceMemory.ts";
import { syncMissingKnowledgeToRoutingGraph } from "../workspaceRoutingGraph.ts";
import {
  WorkspaceKnowledgeReactor,
  type WorkspaceKnowledgeReactorShape,
} from "../Services/WorkspaceKnowledgeReactor.ts";

type ReactorInput = {
  readonly projectId: ProjectId;
  readonly itemId?: WorkspaceKnowledgeItemId;
  readonly itemIds?: ReadonlyArray<WorkspaceKnowledgeItemId>;
  readonly fullSync?: boolean;
  readonly reason: "startup" | "item-upserted" | "item-archived" | "root-updated" | "turn-settled";
};

/** Minimum interval between heavy turn-settled reconciles for the same project (10 min). */
const TURN_SETTLED_RECONCILE_COOLDOWN_MS = 10 * 60 * 1000;
/** Soft wall-clock deadline per physical file sync batch so background work never hogs the loop. */
const FILE_SYNC_TIME_BUDGET_MS = 8_000;

export const makeWorkspaceKnowledgeReactor = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const fileStore = yield* WorkspaceKnowledgeFileStore;
  const clock = yield* Clock.Clock;
  const memory = yield* Effect.serviceOption(WorkspaceMemory);
  const config = yield* Effect.serviceOption(ServerConfig);
  const fileSystem = yield* Effect.serviceOption(FileSystem.FileSystem);
  const path = yield* Effect.serviceOption(Path.Path);
  const revisionSql = yield* Effect.serviceOption(SqlClient.SqlClient);

  const lastTurnReconcileMsByProject = new Map<ProjectId, number>();
  const lastSyncedItemFingerprintByProject = new Map<ProjectId, Map<string, string>>();

  const reconcile = Effect.fn("WorkspaceKnowledgeReactor.reconcile")(function* (
    input: ReactorInput,
  ) {
    const nowMs = clock.currentTimeMillisUnsafe();
    const isHeavyTrigger = input.reason === "turn-settled" || input.reason === "startup";

    // Wave 5-A4: Never sleep 45s inside span and force-run while live work is active.
    // Yield immediately (0ms) so live chat turns / workers face zero background contention.
    if (isHeavyTrigger && activeWorkRegistry.snapshot(nowMs).totalActive > 0) {
      return;
    }

    // Wave 5-A4: Coalesce rapid `turn-settled` triggers per project (was firing every ~2.6 min).
    if (input.reason === "turn-settled") {
      const lastMs = lastTurnReconcileMsByProject.get(input.projectId) ?? 0;
      if (nowMs - lastMs < TURN_SETTLED_RECONCILE_COOLDOWN_MS) {
        return;
      }
      lastTurnReconcileMsByProject.set(input.projectId, nowMs);
    }

    const project = yield* projectionSnapshotQuery.getProjectShellById(input.projectId);
    if (Option.isNone(project)) return;

    // Only run full memory.reconcile (which includes dream crystallization) on heavy triggers,
    // not on every single knowledge-item upsert/archive.
    if (Option.isSome(memory) && (isHeavyTrigger || input.reason === "root-updated")) {
      yield* memory.value.reconcile(input.projectId);
    }

    if (Option.isSome(revisionSql)) {
      yield* syncMissingKnowledgeToRoutingGraph(revisionSql.value, {
        projectId: input.projectId,
        maxItems: 20,
      }).pipe(Effect.ignore);
    }
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
    const targetedIds =
      !input.fullSync && (input.reason === "item-upserted" || input.reason === "item-archived")
        ? new Set<string>([...(input.itemId ? [input.itemId] : []), ...(input.itemIds ?? [])])
        : null;
    const candidates =
      targetedIds && targetedIds.size > 0
        ? result.items.filter((item) => targetedIds.has(item.id))
        : result.items;

    let fingerprints = lastSyncedItemFingerprintByProject.get(input.projectId);
    if (!fingerprints || input.reason === "root-updated") {
      fingerprints = new Map<string, string>();
      lastSyncedItemFingerprintByProject.set(input.projectId, fingerprints);
    }

    const deadlineMs = clock.currentTimeMillisUnsafe() + FILE_SYNC_TIME_BUDGET_MS;
    for (const item of candidates) {
      const fp = `${item.status}|${item.updatedAt}|${item.title.length}|${item.content.length}`;
      if (fingerprints.get(item.id) === fp) {
        continue;
      }
      yield* fileStore.syncItem({ root, item });
      fingerprints.set(item.id, fp);
      if (clock.currentTimeMillisUnsafe() >= deadlineMs) {
        break;
      }
    }
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
    merge: (current: ReactorInput, next: ReactorInput): ReactorInput => {
      const mergedIds = new Set<WorkspaceKnowledgeItemId>();
      if (current.itemId) mergedIds.add(current.itemId);
      for (const id of current.itemIds ?? []) mergedIds.add(id);
      if (next.itemId) mergedIds.add(next.itemId);
      for (const id of next.itemIds ?? []) mergedIds.add(id);
      const fullSync =
        current.fullSync === true ||
        next.fullSync === true ||
        current.reason === "root-updated" ||
        next.reason === "root-updated" ||
        current.reason === "startup" ||
        next.reason === "startup";
      return {
        ...next,
        ...(mergedIds.size > 0 ? { itemIds: [...mergedIds] } : {}),
        ...(fullSync ? { fullSync: true } : {}),
      };
    },
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
    if (Option.isSome(config) && Option.isSome(fileSystem) && Option.isSome(path)) {
      if (Option.isSome(revisionSql)) {
        yield* forkParked(
          resumePdfRevisions({
            stateDir: config.value.stateDir,
            attachmentsDir: config.value.attachmentsDir,
            engine: orchestrationEngine,
          }).pipe(
            Effect.provideService(SqlClient.SqlClient, revisionSql.value),
            Effect.provideService(FileSystem.FileSystem, fileSystem.value),
            Effect.provideService(Path.Path, path.value),
            Effect.catchCause((cause) =>
              Effect.logWarning("Could not resume pending PDF revisions", { cause }),
            ),
          ),
        );
      }
      yield* forkParked(
        resumePdfIndexJobs({
          stateDir: config.value.stateDir,
          attachmentsDir: config.value.attachmentsDir,
          engine: orchestrationEngine,
          queries: projectionSnapshotQuery,
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem.value),
          Effect.provideService(Path.Path, path.value),
        ),
      );
    }
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
