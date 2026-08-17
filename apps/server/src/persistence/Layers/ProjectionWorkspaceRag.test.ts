import {
  ProjectId,
  WorkspaceKnowledgeItemId,
  type WorkspaceKnowledgeItem,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { SqlitePersistenceMemory } from "./Sqlite.ts";
import {
  ProjectionWorkspaceRagRepositoryLive,
  chunkWorkspaceKnowledgeContent,
} from "./ProjectionWorkspaceRag.ts";
import { ProjectionWorkspaceRagRepository } from "../Services/ProjectionWorkspaceRag.ts";

const layer = it.layer(
  ProjectionWorkspaceRagRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

function item(input: {
  readonly projectId: string;
  readonly content: string;
  readonly kind?: WorkspaceKnowledgeItem["kind"];
  readonly status?: WorkspaceKnowledgeItem["status"];
}): WorkspaceKnowledgeItem {
  return {
    id: WorkspaceKnowledgeItemId.make("shared-item"),
    projectId: ProjectId.make(input.projectId),
    kind: input.kind ?? "rag-source",
    title: `${input.projectId} source`,
    content: input.content,
    status: input.status ?? "active",
    origin: "user",
    relativeFolder: null,
    tags: [],
    originalChars: null,
    storedChars: null,
    promptUses: 0,
    lastUsedAt: null,
    createdAt: "2026-08-08T00:00:00.000Z",
    updatedAt: "2026-08-08T01:00:00.000Z",
  };
}

layer("ProjectionWorkspaceRagRepository", (it) => {
  it.effect("never returns another Workspace's matching chunks", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionWorkspaceRagRepository;
      const itemA = item({
        projectId: "workspace-a",
        content: "The confidential launch code belongs only to Workspace A.",
      });
      const itemB = item({
        projectId: "workspace-b",
        content: "Workspace B contains a public release checklist.",
      });
      yield* repository.replaceItem(itemA);
      yield* repository.replaceItem(itemB);

      const searchA = yield* repository.search({
        projectId: itemA.projectId,
        query: "confidential launch",
      });
      const searchB = yield* repository.search({
        projectId: itemB.projectId,
        query: "confidential launch",
      });
      expect(searchA.matches).toHaveLength(1);
      expect(searchA.matches[0]?.title).toBe("workspace-a source");
      expect(searchB.matches).toEqual([]);

      yield* repository.removeItem({ projectId: itemA.projectId, itemId: itemA.id });
      expect(
        (yield* repository.search({
          projectId: itemA.projectId,
          query: "confidential",
        })).matches,
      ).toEqual([]);
    }),
  );

  it.effect("includes long-term memory only when requested and ignores inactive sources", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionWorkspaceRagRepository;
      const projectId = ProjectId.make("workspace-memory");
      yield* repository.replaceItem(
        item({
          projectId,
          content: "A durable preference for cobalt interfaces.",
          kind: "long-term-memory",
        }),
      );

      expect(
        (yield* repository.search({
          projectId,
          query: "cobalt",
          includeLongTermMemory: false,
        })).matches,
      ).toEqual([]);
      expect(
        (yield* repository.search({
          projectId,
          query: "cobalt",
          includeLongTermMemory: true,
        })).matches,
      ).toHaveLength(1);

      yield* repository.replaceItem(
        item({
          projectId,
          content: "A durable preference for cobalt interfaces.",
          kind: "long-term-memory",
          status: "archived",
        }),
      );
      expect(
        (yield* repository.search({
          projectId,
          query: "cobalt",
          includeLongTermMemory: true,
        })).matches,
      ).toEqual([]);
    }),
  );

  it("chunks large sources deterministically with bounded pieces", () => {
    const chunks = chunkWorkspaceKnowledgeContent("paragraph ".repeat(500));
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 1_200)).toBe(true);
  });
});
