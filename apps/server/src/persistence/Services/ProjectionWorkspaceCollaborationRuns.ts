import type {
  ProjectId,
  WorkspaceCollaborationRun,
  WorkspaceCollaborationRunId,
  WorkspaceCollaborationRunListInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";

import type { ProjectionRepositoryError } from "../Errors.ts";

export interface ProjectionWorkspaceCollaborationRunRepositoryShape {
  readonly upsert: (
    run: WorkspaceCollaborationRun,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly requestCancel: (input: {
    readonly projectId: ProjectId;
    readonly runId: WorkspaceCollaborationRunId;
    readonly cancelledAt: string;
  }) => Effect.Effect<void, ProjectionRepositoryError>;
  /**
   * Settles the meeting's pending question. A no-op when the run has no meeting,
   * is not parked, or is parked on a different question than the one answered.
   */
  readonly recordAnswer: (input: {
    readonly projectId: ProjectId;
    readonly runId: WorkspaceCollaborationRunId;
    readonly question: string;
    readonly answer: string;
    readonly answeredAt: string;
  }) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly getById: (input: {
    readonly projectId: ProjectId;
    readonly runId: WorkspaceCollaborationRunId;
  }) => Effect.Effect<Option.Option<WorkspaceCollaborationRun>, ProjectionRepositoryError>;
  readonly list: (
    input: WorkspaceCollaborationRunListInput,
  ) => Effect.Effect<ReadonlyArray<WorkspaceCollaborationRun>, ProjectionRepositoryError>;
  readonly listResumable: () => Effect.Effect<
    ReadonlyArray<WorkspaceCollaborationRun>,
    ProjectionRepositoryError
  >;
}

export class ProjectionWorkspaceCollaborationRunRepository extends Context.Service<
  ProjectionWorkspaceCollaborationRunRepository,
  ProjectionWorkspaceCollaborationRunRepositoryShape
>()(
  "t3/persistence/Services/ProjectionWorkspaceCollaborationRuns/ProjectionWorkspaceCollaborationRunRepository",
) {}
