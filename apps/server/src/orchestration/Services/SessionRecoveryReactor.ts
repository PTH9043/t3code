/**
 * SessionRecoveryReactor - Startup recovery for turns the previous server
 * process took down with it.
 *
 * @module SessionRecoveryReactor
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

/**
 * SessionRecoveryReactorShape - Service API for the one-shot recovery sweep.
 */
export interface SessionRecoveryReactorShape {
  /**
   * Run the recovery sweep in the background once the server is active.
   *
   * The returned effect must be run in a scope so the sweep fiber can be
   * finalized on shutdown.
   */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;

  /** Resolves when the sweep has finished. Intended for tests. */
  readonly drain: Effect.Effect<void>;
}

/**
 * SessionRecoveryReactor - Service tag for the startup session recovery sweep.
 */
export class SessionRecoveryReactor extends Context.Service<
  SessionRecoveryReactor,
  SessionRecoveryReactorShape
>()("t3/orchestration/Services/SessionRecoveryReactor") {}
