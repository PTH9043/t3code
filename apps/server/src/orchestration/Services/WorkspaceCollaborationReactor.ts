/** Executes and resumes role-based collaboration runs within one Workspace boundary. */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

export interface WorkspaceCollaborationReactorShape {
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  readonly drain: Effect.Effect<void>;
}

export class WorkspaceCollaborationReactor extends Context.Service<
  WorkspaceCollaborationReactor,
  WorkspaceCollaborationReactorShape
>()("t3/orchestration/Services/WorkspaceCollaborationReactor") {}
