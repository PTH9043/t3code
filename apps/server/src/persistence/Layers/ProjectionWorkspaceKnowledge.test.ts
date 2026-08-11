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
        createdAt: "2026-08-08T01:00:00.000Z",
        updatedAt: "2026-08-08T01:00:00.000Z",
      };
      yield* repository.upsert(base);
      yield* repository.upsert({
        ...base,
        content: "Revised",
        status: "active",
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
});
