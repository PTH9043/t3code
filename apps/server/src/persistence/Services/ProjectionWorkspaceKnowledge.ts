/** Workspace-owned knowledge projection repository. Every operation requires a ProjectId. */
import {
  IsoDateTime,
  ProjectId,
  WorkspaceKnowledgeItem,
  WorkspaceKnowledgeItemId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionWorkspaceKnowledgeItem = WorkspaceKnowledgeItem;
export type ProjectionWorkspaceKnowledgeItem = typeof ProjectionWorkspaceKnowledgeItem.Type;

export const ListProjectionWorkspaceKnowledgeInput = Schema.Struct({ projectId: ProjectId });
export type ListProjectionWorkspaceKnowledgeInput =
  typeof ListProjectionWorkspaceKnowledgeInput.Type;

export const ArchiveProjectionWorkspaceKnowledgeInput = Schema.Struct({
  projectId: ProjectId,
  itemId: WorkspaceKnowledgeItemId,
  archivedAt: IsoDateTime,
});
export type ArchiveProjectionWorkspaceKnowledgeInput =
  typeof ArchiveProjectionWorkspaceKnowledgeInput.Type;

export const RecordProjectionWorkspaceKnowledgeUsageInput = Schema.Struct({
  projectId: ProjectId,
  itemIds: Schema.Array(WorkspaceKnowledgeItemId),
  usedAt: IsoDateTime,
});
export type RecordProjectionWorkspaceKnowledgeUsageInput =
  typeof RecordProjectionWorkspaceKnowledgeUsageInput.Type;

export interface ProjectionWorkspaceKnowledgeRepositoryShape {
  readonly upsert: (
    item: ProjectionWorkspaceKnowledgeItem,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly archive: (
    input: ArchiveProjectionWorkspaceKnowledgeInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  /** Count one prompt composition against each item that went into it. */
  readonly recordUsage: (
    input: RecordProjectionWorkspaceKnowledgeUsageInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  /** Remove derived conversation RAG copies while leaving canonical thread messages untouched. */
  readonly removeConversationInputs: (input: {
    readonly projectId: ProjectId;
    readonly itemPrefix?: string;
  }) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly listByProjectId: (
    input: ListProjectionWorkspaceKnowledgeInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionWorkspaceKnowledgeItem>, ProjectionRepositoryError>;
}

export class ProjectionWorkspaceKnowledgeRepository extends Context.Service<
  ProjectionWorkspaceKnowledgeRepository,
  ProjectionWorkspaceKnowledgeRepositoryShape
>()(
  "t3/persistence/Services/ProjectionWorkspaceKnowledge/ProjectionWorkspaceKnowledgeRepository",
) {}
