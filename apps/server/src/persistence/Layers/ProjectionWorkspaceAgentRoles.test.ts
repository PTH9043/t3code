import { ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { ProjectionWorkspaceAgentRoleRepositoryLive } from "./ProjectionWorkspaceAgentRoles.ts";
import { ProjectionWorkspaceAgentRoleRepository } from "../Services/ProjectionWorkspaceAgentRoles.ts";

const layer = it.layer(
  ProjectionWorkspaceAgentRoleRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("ProjectionWorkspaceAgentRoleRepository", (it) => {
  it.effect("isolates the same role across Workspaces and supports multiple CLI instances", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const repository = yield* ProjectionWorkspaceAgentRoleRepository;
      const workspaceA = ProjectId.make("workspace-a");
      const workspaceB = ProjectId.make("workspace-b");
      for (const projectId of [workspaceA, workspaceB]) {
        yield* sql`
          INSERT INTO projection_projects (
            project_id, title, workspace_root, default_model_selection_json,
            scripts_json, workspace_control_json, created_at, updated_at, deleted_at
          ) VALUES (
            ${projectId}, ${projectId}, ${`D:/${projectId}`}, NULL, '[]',
            '{"isolationMode":"strict","longTermMemoryRoot":null}',
            '2026-08-08T00:00:00.000Z', '2026-08-08T00:00:00.000Z', NULL
          )
        `;
      }

      yield* repository.upsert({
        projectId: workspaceA,
        role: "coordinator",
        displayName: "Codex work lead",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex_work"),
          model: "gpt-5",
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        instructions: "Coordinate Workspace A only.",
        enabled: true,
        updatedAt: "2026-08-08T01:00:00.000Z",
      });
      yield* repository.upsert({
        projectId: workspaceB,
        role: "coordinator",
        displayName: "Codex personal lead",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex_personal"),
          model: "gpt-5",
        },
        runtimeMode: "approval-required",
        interactionMode: "plan",
        instructions: "Coordinate Workspace B only.",
        enabled: true,
        updatedAt: "2026-08-08T02:00:00.000Z",
      });

      expect((yield* repository.listByProjectId(workspaceA))[0]).toMatchObject({
        projectId: workspaceA,
        modelSelection: { instanceId: "codex_work" },
      });
      expect((yield* repository.listByProjectId(workspaceB))[0]).toMatchObject({
        projectId: workspaceB,
        modelSelection: { instanceId: "codex_personal" },
      });

      yield* repository.upsert({
        projectId: workspaceA,
        role: "operator",
        displayName: "Codex incident operator",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex_work"),
          model: "gpt-5",
        },
        runtimeMode: "approval-required",
        interactionMode: "plan",
        instructions: "Diagnose Workspace A incidents only.",
        enabled: true,
        updatedAt: "2026-08-08T03:00:00.000Z",
      });
      expect(yield* repository.listByProjectId(workspaceA)).toEqual([
        expect.objectContaining({ projectId: workspaceA, role: "coordinator" }),
        expect.objectContaining({
          projectId: workspaceA,
          role: "operator",
          displayName: "Codex incident operator",
          modelSelection: expect.objectContaining({ instanceId: "codex_work" }),
        }),
      ]);

      yield* repository.remove({ projectId: workspaceA, role: "coordinator" });
      yield* repository.remove({ projectId: workspaceA, role: "operator" });
      expect(yield* repository.listByProjectId(workspaceA)).toEqual([]);
      expect(yield* repository.listByProjectId(workspaceB)).toHaveLength(1);
    }),
  );
});
