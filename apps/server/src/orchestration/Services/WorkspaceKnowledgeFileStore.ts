/**
 * Physical, Workspace-owned mirror for long-term memory records.
 *
 * SQLite remains the authoritative event projection. This store makes every
 * long-term memory record inspectable and recoverable inside the physical root
 * selected for exactly one Workspace.
 */
import type { WorkspaceKnowledgeItem } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import type * as Effect from "effect/Effect";

export class WorkspaceKnowledgeFileStoreError extends Data.TaggedError(
  "WorkspaceKnowledgeFileStoreError",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface WorkspaceKnowledgeFileStoreShape {
  readonly syncItem: (input: {
    readonly root: string;
    readonly item: WorkspaceKnowledgeItem;
  }) => Effect.Effect<void, WorkspaceKnowledgeFileStoreError>;
}

export class WorkspaceKnowledgeFileStore extends Context.Service<
  WorkspaceKnowledgeFileStore,
  WorkspaceKnowledgeFileStoreShape
>()("t3/orchestration/Services/WorkspaceKnowledgeFileStore") {}
