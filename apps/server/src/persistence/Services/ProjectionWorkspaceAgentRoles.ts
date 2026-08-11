import type { ProjectId, WorkspaceAgentRole, WorkspaceAgentRoleBinding } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export interface ProjectionWorkspaceAgentRoleRepositoryShape {
  readonly upsert: (
    binding: WorkspaceAgentRoleBinding,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly remove: (input: {
    readonly projectId: ProjectId;
    readonly role: WorkspaceAgentRole;
  }) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly listByProjectId: (
    projectId: ProjectId,
  ) => Effect.Effect<ReadonlyArray<WorkspaceAgentRoleBinding>, ProjectionRepositoryError>;
}

export class ProjectionWorkspaceAgentRoleRepository extends Context.Service<
  ProjectionWorkspaceAgentRoleRepository,
  ProjectionWorkspaceAgentRoleRepositoryShape
>()(
  "t3/persistence/Services/ProjectionWorkspaceAgentRoles/ProjectionWorkspaceAgentRoleRepository",
) {}
