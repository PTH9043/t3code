import {
  DEFAULT_WORKSPACE_AGENT_KNOWLEDGE_SETTINGS,
  DEFAULT_WORKSPACE_MONITORING_SETTINGS,
  DEFAULT_WORKSPACE_ORCHESTRA_DEFAULTS,
  DEFAULT_WORKSPACE_CONVERSATION_RAG_SETTINGS,
  EventId,
  ProjectId,
  WorkspaceKnowledgeItemId,
  type OrchestrationEvent,
  type OrchestrationProjectShell,
  type WorkspaceKnowledgeItem,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../Services/ProjectionSnapshotQuery.ts";
import { WorkspaceKnowledgeFileStore } from "../Services/WorkspaceKnowledgeFileStore.ts";
import { WorkspaceKnowledgeReactor } from "../Services/WorkspaceKnowledgeReactor.ts";
import { WorkspaceKnowledgeReactorLive } from "./WorkspaceKnowledgeReactor.ts";
import { activeWorkRegistry } from "../ActiveWorkTracker.ts";

const now = "2026-08-08T00:00:00.000Z";
const projectId = ProjectId.make("workspace-a");
const itemId = WorkspaceKnowledgeItemId.make("memory-1");
const item: WorkspaceKnowledgeItem = {
  id: itemId,
  projectId,
  kind: "long-term-memory",
  title: "Workspace A memory",
  content: "Remember only inside A.",
  status: "active",
  origin: "user",
  relativeFolder: null,
  tags: [],
  originalChars: null,
  storedChars: null,
  promptUses: 0,
  lastUsedAt: null,
  createdAt: now,
  updatedAt: now,
};
const project: OrchestrationProjectShell = {
  id: projectId,
  title: "Workspace A",
  workspaceRoot: "D:/workspace-a",
  defaultModelSelection: null,
  scripts: [],
  workspaceControl: {
    isolationMode: "strict",
    longTermMemoryRoot: "F:/NewAutoUsage/workspaces/workspace-a/memory/long-term",
    conversationRag: DEFAULT_WORKSPACE_CONVERSATION_RAG_SETTINGS,
    agentKnowledge: DEFAULT_WORKSPACE_AGENT_KNOWLEDGE_SETTINGS,
    monitoring: DEFAULT_WORKSPACE_MONITORING_SETTINGS,
    orchestra: DEFAULT_WORKSPACE_ORCHESTRA_DEFAULTS,
  },
  createdAt: now,
  updatedAt: now,
};
const upserted: OrchestrationEvent = {
  sequence: 1,
  eventId: EventId.make("event-memory-upserted"),
  aggregateKind: "project",
  aggregateId: projectId,
  occurredAt: now,
  commandId: null,
  causationEventId: null,
  correlationId: null,
  metadata: {},
  type: "project.knowledge-item-upserted",
  payload: {
    projectId,
    itemId,
    kind: "long-term-memory",
    title: item.title,
    content: item.content,
    status: item.status,
    origin: item.origin,
    relativeFolder: item.relativeFolder,
    tags: item.tags,
    originalChars: null,
    storedChars: null,
    updatedAt: now,
  },
};

it.effect("reconciles a long-term-memory event into its Workspace-selected root", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const archivedItem: WorkspaceKnowledgeItem = {
        ...item,
        id: WorkspaceKnowledgeItemId.make("memory-2"),
        status: "archived",
      };
      const mirroredItems = new Map<string, WorkspaceKnowledgeItem>();
      const synchronized = yield* Deferred.make<{
        readonly root: string;
        readonly item: WorkspaceKnowledgeItem;
      }>();
      const query = {
        getShellSnapshot: () =>
          Effect.succeed({ snapshotSequence: 0, projects: [], threads: [], updatedAt: now }),
        getProjectShellById: () => Effect.succeed(Option.some(project)),
        listWorkspaceKnowledge: () => Effect.succeed({ items: [item, archivedItem] }),
      } as unknown as ProjectionSnapshotQueryShape;
      const layer = WorkspaceKnowledgeReactorLive.pipe(
        Layer.provideMerge(
          Layer.succeed(OrchestrationEngineService, {
            readEvents: () => Stream.empty,
            dispatch: () => Effect.die("dispatch should not be called"),
            streamDomainEvents: Stream.make(upserted, {
              ...upserted,
              sequence: 2,
              eventId: EventId.make("archived-memory"),
              payload: { ...upserted.payload, itemId: archivedItem.id, status: "archived" },
            }),
            latestSequence: Effect.succeed(1),
          }),
        ),
        Layer.provideMerge(Layer.succeed(ProjectionSnapshotQuery, query)),
        Layer.provideMerge(
          Layer.succeed(WorkspaceKnowledgeFileStore, {
            syncItem: (input) =>
              Effect.sync(() => {
                mirroredItems.set(input.item.id, input.item);
              }).pipe(Effect.andThen(Deferred.succeed(synchronized, input)), Effect.asVoid),
          }),
        ),
      );

      yield* Effect.gen(function* () {
        const reactor = yield* WorkspaceKnowledgeReactor;
        yield* reactor.start();
        const mirrored = yield* Deferred.await(synchronized);
        expect(mirrored.root).toBe("F:/NewAutoUsage/workspaces/workspace-a/memory/long-term");
        expect(mirrored.item.projectId).toBe(projectId);
        expect(mirrored.item.id).toBe(itemId);
        yield* reactor.drain;
        expect([...mirroredItems.keys()].sort()).toEqual([item.id, archivedItem.id].sort());
        expect(mirroredItems.get(archivedItem.id)?.status).toBe("archived");
      }).pipe(Effect.provide(layer));
    }),
  ),
);

it.effect("Wave 5-A4: yields immediately (0ms) on turn-settled when live work is active", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let syncCalls = 0;
      const query = {
        getShellSnapshot: () =>
          Effect.succeed({ snapshotSequence: 0, projects: [project], threads: [], updatedAt: now }),
        getProjectShellById: () => Effect.succeed(Option.some(project)),
        listWorkspaceKnowledge: () => Effect.succeed({ items: [item] }),
      } as unknown as ProjectionSnapshotQueryShape;
      const layer = WorkspaceKnowledgeReactorLive.pipe(
        Layer.provideMerge(
          Layer.succeed(OrchestrationEngineService, {
            readEvents: () => Stream.empty,
            dispatch: () => Effect.die("dispatch should not be called"),
            streamDomainEvents: Stream.empty,
            latestSequence: Effect.succeed(0),
          }),
        ),
        Layer.provideMerge(Layer.succeed(ProjectionSnapshotQuery, query)),
        Layer.provideMerge(
          Layer.succeed(WorkspaceKnowledgeFileStore, {
            syncItem: () =>
              Effect.sync(() => {
                syncCalls += 1;
              }),
          }),
        ),
      );

      activeWorkRegistry.register({
        kind: "turn",
        id: "active-turn-a4-test",
        threadId: "active-turn-a4-test",
        summary: "test",
        startedAtMs: 1795767800000,
      });
      try {
        yield* Effect.gen(function* () {
          const reactor = yield* WorkspaceKnowledgeReactor;
          yield* reactor.start();
          yield* reactor.drain;
          expect(syncCalls).toBe(0);
        }).pipe(Effect.provide(layer));
      } finally {
        activeWorkRegistry.unregister("turn", "active-turn-a4-test");
      }
    }),
  ),
);
