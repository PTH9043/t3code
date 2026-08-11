/** Reacts to Workspace knowledge events and reconciles physical long-term memory. */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

export interface WorkspaceKnowledgeReactorShape {
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  readonly drain: Effect.Effect<void>;
}

export class WorkspaceKnowledgeReactor extends Context.Service<
  WorkspaceKnowledgeReactor,
  WorkspaceKnowledgeReactorShape
>()("t3/orchestration/Services/WorkspaceKnowledgeReactor") {}
