import type {
  ProjectId,
  WorkspaceIncident,
  WorkspaceIncidentId,
  WorkspaceIncidentListInput,
  WorkspaceProgram,
  WorkspaceProgramId,
  WorkspaceProgramIntegrity,
  WorkspaceProgramRun,
  WorkspaceProgramRunListInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";

import type { ProjectionRepositoryError } from "../Errors.ts";

export interface ProjectionWorkspaceProgramRepositoryShape {
  readonly upsertProgram: (
    program: WorkspaceProgram,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly removeProgram: (input: {
    readonly projectId: ProjectId;
    readonly programId: WorkspaceProgramId;
  }) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly removeByProjectId: (
    projectId: ProjectId,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly getProgram: (input: {
    readonly projectId: ProjectId;
    readonly programId: WorkspaceProgramId;
  }) => Effect.Effect<Option.Option<WorkspaceProgram>, ProjectionRepositoryError>;
  readonly listPrograms: (
    projectId: ProjectId,
  ) => Effect.Effect<ReadonlyArray<WorkspaceProgram>, ProjectionRepositoryError>;
  readonly listAutoStartPrograms: () => Effect.Effect<
    ReadonlyArray<WorkspaceProgram>,
    ProjectionRepositoryError
  >;
  readonly updateIntegrity: (input: {
    readonly projectId: ProjectId;
    readonly programId: WorkspaceProgramId;
    readonly integrity: WorkspaceProgramIntegrity;
  }) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly listIntegrityPrograms: () => Effect.Effect<
    ReadonlyArray<WorkspaceProgram>,
    ProjectionRepositoryError
  >;
  readonly upsertRun: (run: WorkspaceProgramRun) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly listRuns: (
    input: WorkspaceProgramRunListInput,
  ) => Effect.Effect<ReadonlyArray<WorkspaceProgramRun>, ProjectionRepositoryError>;
  readonly listActiveRuns: () => Effect.Effect<
    ReadonlyArray<WorkspaceProgramRun>,
    ProjectionRepositoryError
  >;
  readonly upsertIncident: (
    incident: WorkspaceIncident,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly getIncident: (input: {
    readonly projectId: ProjectId;
    readonly incidentId: WorkspaceIncidentId;
  }) => Effect.Effect<Option.Option<WorkspaceIncident>, ProjectionRepositoryError>;
  readonly findOpenIncidentByFingerprint: (input: {
    readonly projectId: ProjectId;
    readonly programId: WorkspaceProgramId;
    readonly fingerprint: string;
  }) => Effect.Effect<Option.Option<WorkspaceIncident>, ProjectionRepositoryError>;
  readonly listIncidents: (
    input: WorkspaceIncidentListInput,
  ) => Effect.Effect<ReadonlyArray<WorkspaceIncident>, ProjectionRepositoryError>;
  readonly listRecoverableIncidents: () => Effect.Effect<
    ReadonlyArray<WorkspaceIncident>,
    ProjectionRepositoryError
  >;
}

export class ProjectionWorkspaceProgramRepository extends Context.Service<
  ProjectionWorkspaceProgramRepository,
  ProjectionWorkspaceProgramRepositoryShape
>()("t3/persistence/Services/ProjectionWorkspacePrograms/ProjectionWorkspaceProgramRepository") {}
