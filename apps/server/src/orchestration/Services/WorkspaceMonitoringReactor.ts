/**
 * 프로그램 모니터링 모드 — the always-on loop that watches a project's programs
 * (and, when configured, T3 Code itself), reports into the project's one
 * monitoring thread, and asks there before acting.
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

export interface WorkspaceMonitoringReactorShape {
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  /** One evaluation pass over every enabled project whose interval is due. */
  readonly tick: Effect.Effect<void>;
  readonly drain: Effect.Effect<void>;
}

export class WorkspaceMonitoringReactor extends Context.Service<
  WorkspaceMonitoringReactor,
  WorkspaceMonitoringReactorShape
>()("t3/orchestration/Services/WorkspaceMonitoringReactor") {}
