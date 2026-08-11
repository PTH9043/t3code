import { ModelSelection, WorkspaceAgentRoleBinding, type ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceDecodeError, toPersistenceSqlError } from "../Errors.ts";
import {
  ProjectionWorkspaceAgentRoleRepository,
  type ProjectionWorkspaceAgentRoleRepositoryShape,
} from "../Services/ProjectionWorkspaceAgentRoles.ts";

const DbRow = WorkspaceAgentRoleBinding.mapFields(
  Struct.assign({
    modelSelection: Schema.fromJsonString(ModelSelection),
    enabled: Schema.Number,
  }),
);
const ProjectLookup = Schema.Struct({ projectId: Schema.String });
const encodeModelSelection = Schema.encodeUnknownSync(Schema.fromJsonString(ModelSelection));

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const listRows = SqlSchema.findAll({
    Request: ProjectLookup,
    Result: DbRow,
    execute: ({ projectId }) =>
      sql`
        SELECT
          project_id AS "projectId",
          role,
          display_name AS "displayName",
          model_selection_json AS "modelSelection",
          runtime_mode AS "runtimeMode",
          interaction_mode AS "interactionMode",
          instructions,
          enabled,
          updated_at AS "updatedAt"
        FROM projection_workspace_agent_roles
        WHERE project_id = ${projectId}
        ORDER BY CASE role
          WHEN 'coordinator' THEN 0
          WHEN 'operator' THEN 1
          WHEN 'planner' THEN 2
          WHEN 'researcher' THEN 3
          WHEN 'implementer' THEN 4
          WHEN 'reviewer' THEN 5
          WHEN 'verifier' THEN 6
          ELSE 99
        END ASC
      `,
  });

  const upsert: ProjectionWorkspaceAgentRoleRepositoryShape["upsert"] = (binding) =>
    sql`
      INSERT INTO projection_workspace_agent_roles (
        project_id, role, display_name, model_selection_json, runtime_mode,
        interaction_mode, instructions, enabled, updated_at
      ) VALUES (
        ${binding.projectId}, ${binding.role}, ${binding.displayName},
        ${encodeModelSelection(binding.modelSelection)}, ${binding.runtimeMode},
        ${binding.interactionMode}, ${binding.instructions},
        ${binding.enabled ? 1 : 0}, ${binding.updatedAt}
      )
      ON CONFLICT(project_id, role) DO UPDATE SET
        display_name = excluded.display_name,
        model_selection_json = excluded.model_selection_json,
        runtime_mode = excluded.runtime_mode,
        interaction_mode = excluded.interaction_mode,
        instructions = excluded.instructions,
        enabled = excluded.enabled,
        updated_at = excluded.updated_at
    `.pipe(
      Effect.asVoid,
      Effect.mapError(toPersistenceSqlError("ProjectionWorkspaceAgentRoles.upsert")),
    );

  const remove: ProjectionWorkspaceAgentRoleRepositoryShape["remove"] = (input) =>
    sql`
      DELETE FROM projection_workspace_agent_roles
      WHERE project_id = ${input.projectId} AND role = ${input.role}
    `.pipe(
      Effect.asVoid,
      Effect.mapError(toPersistenceSqlError("ProjectionWorkspaceAgentRoles.remove")),
    );

  const listByProjectId: ProjectionWorkspaceAgentRoleRepositoryShape["listByProjectId"] = (
    projectId: ProjectId,
  ) =>
    listRows({ projectId }).pipe(
      Effect.map((rows) =>
        rows.map((row) => ({
          ...row,
          enabled: row.enabled === 1,
        })),
      ),
      Effect.mapError((cause) =>
        cause._tag === "SqlError"
          ? toPersistenceSqlError("ProjectionWorkspaceAgentRoles.list:query")(cause)
          : toPersistenceDecodeError("ProjectionWorkspaceAgentRoles.list:decodeRows")(cause),
      ),
    );

  return ProjectionWorkspaceAgentRoleRepository.of({ upsert, remove, listByProjectId });
});

export const ProjectionWorkspaceAgentRoleRepositoryLive = Layer.effect(
  ProjectionWorkspaceAgentRoleRepository,
  make,
);
