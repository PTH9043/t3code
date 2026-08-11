import type {
  IsoDateTime,
  ProjectId,
  ProjectScheduleRuntimeUpdatedPayload,
  ProjectScheduleUpsertedPayload,
  WorkspaceSchedule,
  WorkspaceScheduleId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";

import type { ProjectionRepositoryError } from "../Errors.ts";

export interface ProjectionWorkspaceScheduleRepositoryShape {
  readonly upsertDefinition: (
    definition: ProjectScheduleUpsertedPayload,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly remove: (input: {
    readonly projectId: ProjectId;
    readonly scheduleId: WorkspaceScheduleId;
  }) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly removeByProjectId: (
    projectId: ProjectId,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly updateRuntime: (
    runtime: ProjectScheduleRuntimeUpdatedPayload,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly getById: (input: {
    readonly projectId: ProjectId;
    readonly scheduleId: WorkspaceScheduleId;
  }) => Effect.Effect<Option.Option<WorkspaceSchedule>, ProjectionRepositoryError>;
  readonly listByProjectId: (
    projectId: ProjectId,
  ) => Effect.Effect<ReadonlyArray<WorkspaceSchedule>, ProjectionRepositoryError>;
  readonly listPendingReconciliation: () => Effect.Effect<
    ReadonlyArray<WorkspaceSchedule>,
    ProjectionRepositoryError
  >;
  readonly listDue: (
    now: IsoDateTime,
  ) => Effect.Effect<ReadonlyArray<WorkspaceSchedule>, ProjectionRepositoryError>;
}

export class ProjectionWorkspaceScheduleRepository extends Context.Service<
  ProjectionWorkspaceScheduleRepository,
  ProjectionWorkspaceScheduleRepositoryShape
>()("t3/persistence/Services/ProjectionWorkspaceSchedules/ProjectionWorkspaceScheduleRepository") {}
