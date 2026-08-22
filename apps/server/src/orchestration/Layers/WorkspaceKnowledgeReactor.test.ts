import {
  DEFAULT_WORKSPACE_AGENT_KNOWLEDGE_SETTINGS,
  DEFAULT_WORKSPACE_MONITORING_SETTINGS,
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
      const synchronized = yield* Deferred.make<{
        readonly root: string;
        readonly item: WorkspaceKnowledgeItem;
      }>();
      const query = {
        getShellSnapshot: () =>
          Effect.succeed({ snapshotSequence: 0, projects: [], threads: [], updatedAt: now }),
        getProjectShellById: () => Effect.succeed(Option.some(project)),
        listWorkspaceKnowledge: () => Effect.succeed({ items: [item] }),
      } as unknown as ProjectionSnapshotQueryShape;
      const layer = WorkspaceKnowledgeReactorLive.pipe(
        Layer.provideMerge(
          Layer.succeed(OrchestrationEngineService, {
            readEvents: () => Stream.empty,
            dispatch: () => Effect.die("dispatch should not be called"),
            streamDomainEvents: Stream.make(upserted),
            latestSequence: Effect.succeed(1),
          }),
        ),
        Layer.provideMerge(Layer.succeed(ProjectionSnapshotQuery, query)),
        Layer.provideMerge(
          Layer.succeed(WorkspaceKnowledgeFileStore, {
            syncItem: (input) => Deferred.succeed(synchronized, input).pipe(Effect.asVoid),
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
      }).pipe(Effect.provide(layer));
    }),
  ),
);
