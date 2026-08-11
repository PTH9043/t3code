import type { ProjectId, WorkspaceProgramDiscoveryResult } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";

export interface WorkspaceProgramSupervisorShape {
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  readonly drain: Effect.Effect<void>;
  readonly discover: (
    projectId: ProjectId,
  ) => Effect.Effect<WorkspaceProgramDiscoveryResult, ProjectionRepositoryError>;
}

export class WorkspaceProgramSupervisor extends Context.Service<
  WorkspaceProgramSupervisor,
  WorkspaceProgramSupervisorShape
>()("t3/orchestration/Services/WorkspaceProgramSupervisor") {}
