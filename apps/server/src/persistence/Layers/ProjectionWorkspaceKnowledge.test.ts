import { ProjectId, WorkspaceKnowledgeItemId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { ProjectionWorkspaceKnowledgeRepositoryLive } from "./ProjectionWorkspaceKnowledge.ts";
import { ProjectionWorkspaceKnowledgeRepository } from "../Services/ProjectionWorkspaceKnowledge.ts";

const layer = it.layer(
  ProjectionWorkspaceKnowledgeRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("ProjectionWorkspaceKnowledgeRepository", (it) => {
  it.effect("isolates same-id knowledge records by Workspace and archives only the target", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const repository = yield* ProjectionWorkspaceKnowledgeRepository;
      const workspaceA = ProjectId.make("workspace-a");
      const workspaceB = ProjectId.make("workspace-b");
      const sharedItemId = WorkspaceKnowledgeItemId.make("shared-item");

      for (const [projectId, title] of [
        [workspaceA, "Workspace A"],
        [workspaceB, "Workspace B"],
      ] as const) {
        yield* sql`
          INSERT INTO projection_projects (
            project_id,
            title,
            workspace_root,
            default_model_selection_json,
            scripts_json,
            workspace_control_json,
            created_at,
            updated_at,
            deleted_at
          ) VALUES (
            ${projectId},
            ${title},
            ${`D:/${projectId}`},
            NULL,
            '[]',
            '{"isolationMode":"strict","longTermMemoryRoot":null}',
            '2026-08-08T00:00:00.000Z',
            '2026-08-08T00:00:00.000Z',
            NULL
          )
        `;
      }

      yield* repository.upsert({
        id: sharedItemId,
        projectId: workspaceA,
        kind: "directive",
        title: "Workspace A directive",
        content: "Only A may read this.",
        status: "active",
        origin: "user",
        relativeFolder: null,
        tags: ["priority"],
        originalChars: null,
        storedChars: null,
        promptUses: 0,
        lastUsedAt: null,
        createdAt: "2026-08-08T01:00:00.000Z",
        updatedAt: "2026-08-08T01:00:00.000Z",
      });
      yield* repository.upsert({
        id: sharedItemId,
        projectId: workspaceB,
        kind: "goal",
        title: "Workspace B goal",
        content: "Only B may read this.",
        status: "active",
        origin: "user",
        relativeFolder: null,
        tags: [],
        originalChars: null,
        storedChars: null,
        promptUses: 0,
        lastUsedAt: null,
        createdAt: "2026-08-08T02:00:00.000Z",
        updatedAt: "2026-08-08T02:00:00.000Z",
      });

      yield* repository.archive({
        projectId: workspaceA,
        itemId: sharedItemId,
        archivedAt: "2026-08-08T03:00:00.000Z",
      });

      const itemsA = yield* repository.listByProjectId({ projectId: workspaceA });
      const itemsB = yield* repository.listByProjectId({ projectId: workspaceB });
      assert.deepStrictEqual(
        itemsA.map((item) => [item.title, item.status]),
        [["Workspace A directive", "archived"]],
      );
      assert.deepStrictEqual(
        itemsB.map((item) => [item.title, item.status]),
        [["Workspace B goal", "active"]],
      );
    }),
  );

  it.effect("preserves original creation time when an item is updated", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const repository = yield* ProjectionWorkspaceKnowledgeRepository;
      const projectId = ProjectId.make("workspace-update");
      const itemId = WorkspaceKnowledgeItemId.make("memory-1");
      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, default_model_selection_json,
          scripts_json, workspace_control_json, created_at, updated_at, deleted_at
        ) VALUES (
          ${projectId}, 'Workspace', 'D:/workspace-update', NULL, '[]',
          '{"isolationMode":"strict","longTermMemoryRoot":null}',
          '2026-08-08T00:00:00.000Z', '2026-08-08T00:00:00.000Z', NULL
        )
      `;
      const base = {
        id: itemId,
        projectId,
        kind: "long-term-memory" as const,
        title: "Memory",
        content: "Initial",
        status: "candidate" as const,
        origin: "agent" as const,
        relativeFolder: null,
        tags: [],
        originalChars: null,
        storedChars: null,
        promptUses: 0,
        lastUsedAt: null,
        createdAt: "2026-08-08T01:00:00.000Z",
        updatedAt: "2026-08-08T01:00:00.000Z",
      };
      yield* repository.upsert(base);
      yield* repository.upsert({
        ...base,
        content: "Revised",
        status: "active",
        originalChars: null,
        storedChars: null,
        promptUses: 0,
        lastUsedAt: null,
        createdAt: "2026-08-08T02:00:00.000Z",
        updatedAt: "2026-08-08T02:00:00.000Z",
      });

      const [item] = yield* repository.listByProjectId({ projectId });
      assert.strictEqual(item?.content, "Revised");
      assert.strictEqual(item?.status, "active");
      assert.strictEqual(item?.createdAt, "2026-08-08T01:00:00.000Z");
      assert.strictEqual(item?.updatedAt, "2026-08-08T02:00:00.000Z");
    }),
  );

  it.effect("counts one prompt use per composition and never lets an upsert reset it", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const repository = yield* ProjectionWorkspaceKnowledgeRepository;
      const projectId = ProjectId.make("workspace-usage");
      const usedId = WorkspaceKnowledgeItemId.make("used-item");
      const unusedId = WorkspaceKnowledgeItemId.make("unused-item");
      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, default_model_selection_json,
          scripts_json, workspace_control_json, created_at, updated_at, deleted_at
        ) VALUES (
          ${projectId}, 'Workspace', 'D:/workspace-usage', NULL, '[]',
          '{"isolationMode":"strict","longTermMemoryRoot":null}',
          '2026-08-08T00:00:00.000Z', '2026-08-08T00:00:00.000Z', NULL
        )
      `;
      const base = {
        projectId,
        kind: "long-term-memory" as const,
        content: "body",
        status: "active" as const,
        origin: "agent" as const,
        relativeFolder: null,
        tags: [],
        originalChars: null,
        storedChars: null,
        promptUses: 0,
        lastUsedAt: null,
        createdAt: "2026-08-08T01:00:00.000Z",
        updatedAt: "2026-08-08T01:00:00.000Z",
      };
      yield* repository.upsert({ ...base, id: usedId, title: "Used" });
      yield* repository.upsert({ ...base, id: unusedId, title: "Unused" });

      yield* repository.recordUsage({
        projectId,
        itemIds: [usedId],
        usedAt: "2026-08-09T00:00:00.000Z",
      });
      yield* repository.recordUsage({
        projectId,
        itemIds: [usedId],
        usedAt: "2026-08-10T00:00:00.000Z",
      });
      // An older replay must not drag the last-used timestamp backwards.
      yield* repository.recordUsage({
        projectId,
        itemIds: [usedId],
        usedAt: "2026-08-01T00:00:00.000Z",
      });

      // Re-registering the item, which automatic capture does on every run,
      // must leave the measure of its worth intact.
      yield* repository.upsert({
        ...base,
        id: usedId,
        title: "Used",
        content: "revised",
        updatedAt: "2026-08-11T00:00:00.000Z",
      });

      const items = yield* repository.listByProjectId({ projectId });
      const used = items.find((item) => item.id === usedId);
      const unused = items.find((item) => item.id === unusedId);
      assert.strictEqual(used?.promptUses, 3);
      assert.strictEqual(used?.lastUsedAt, "2026-08-10T00:00:00.000Z");
      assert.strictEqual(used?.content, "revised");
      assert.strictEqual(unused?.promptUses, 0);
      assert.strictEqual(unused?.lastUsedAt, null);
    }),
  );

  it.effect("ignores a composition that used no stored knowledge", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionWorkspaceKnowledgeRepository;
      yield* repository.recordUsage({
        projectId: ProjectId.make("workspace-empty"),
        itemIds: [],
        usedAt: "2026-08-09T00:00:00.000Z",
      });
    }),
  );

  it.effect("deduplicates repeated itemIds within a single recordUsage call", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const repository = yield* ProjectionWorkspaceKnowledgeRepository;
      const projectId = ProjectId.make("workspace-usage-dedupe");
      const itemId = WorkspaceKnowledgeItemId.make("dedupe-item");
      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, default_model_selection_json,
          scripts_json, workspace_control_json, created_at, updated_at, deleted_at
        ) VALUES (
          ${projectId}, 'Dedupe', 'D:/dedupe', NULL, '[]',
          '{"isolationMode":"strict","longTermMemoryRoot":null}',
          '2026-08-08T00:00:00.000Z', '2026-08-08T00:00:00.000Z', NULL
        )
      `;
      yield* repository.upsert({
        id: itemId,
        projectId,
        kind: "rag-source",
        title: "Dedupe Note",
        content: "Body",
        status: "active",
        origin: "user",
        relativeFolder: null,
        tags: [],
        originalChars: null,
        storedChars: null,
        promptUses: 0,
        lastUsedAt: null,
        createdAt: "2026-08-08T01:00:00.000Z",
        updatedAt: "2026-08-08T01:00:00.000Z",
      });

      yield* repository.recordUsage({
        projectId,
        itemIds: [itemId, itemId, itemId],
        usedAt: "2026-08-09T00:00:00.000Z",
      });

      const items = yield* repository.listByProjectId({ projectId });
      assert.strictEqual(items[0]?.promptUses, 1);
      assert.strictEqual(items[0]?.lastUsedAt, "2026-08-09T00:00:00.000Z");
    }),
  );
});
