/** Durable per-Workspace scheduler that emits unattended collaboration runs. */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

export interface WorkspaceSchedulerReactorShape {
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  readonly tick: Effect.Effect<void>;
  readonly drain: Effect.Effect<void>;
}

export class WorkspaceSchedulerReactor extends Context.Service<
  WorkspaceSchedulerReactor,
  WorkspaceSchedulerReactorShape
>()("t3/orchestration/Services/WorkspaceSchedulerReactor") {}
