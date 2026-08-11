import type {
  ProjectId,
  WorkspaceKnowledgeItem,
  WorkspaceKnowledgeItemId,
  WorkspaceRagSearchInput,
  WorkspaceRagSearchResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export interface ProjectionWorkspaceRagRepositoryShape {
  readonly replaceItem: (
    item: WorkspaceKnowledgeItem,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly removeItem: (input: {
    readonly projectId: ProjectId;
    readonly itemId: WorkspaceKnowledgeItemId;
  }) => Effect.Effect<void, ProjectionRepositoryError>;
  /** Remove only the derived chunks produced from automatic conversation capture. */
  readonly removeConversationInputs: (input: {
    readonly projectId: ProjectId;
    readonly itemPrefix?: string;
  }) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly search: (
    input: WorkspaceRagSearchInput,
  ) => Effect.Effect<WorkspaceRagSearchResult, ProjectionRepositoryError>;
}

export class ProjectionWorkspaceRagRepository extends Context.Service<
  ProjectionWorkspaceRagRepository,
  ProjectionWorkspaceRagRepositoryShape
>()("t3/persistence/Services/ProjectionWorkspaceRag/ProjectionWorkspaceRagRepository") {}
