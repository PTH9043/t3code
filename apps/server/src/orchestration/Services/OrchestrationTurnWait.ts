import {
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type OrchestrationLatestTurn,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";

export class OrchestrationTurnWaitThreadNotFoundError extends Schema.TaggedErrorClass<OrchestrationTurnWaitThreadNotFoundError>()(
  "OrchestrationTurnWaitThreadNotFoundError",
  { threadId: ThreadId },
) {
  override get message(): string {
    return `Thread '${this.threadId}' disappeared while waiting for its turn.`;
  }
}

export class OrchestrationTurnWaitProjectMismatchError extends Schema.TaggedErrorClass<OrchestrationTurnWaitProjectMismatchError>()(
  "OrchestrationTurnWaitProjectMismatchError",
  {
    threadId: ThreadId,
    expectedProjectId: ProjectId,
    actualProjectId: ProjectId,
  },
) {
  override get message(): string {
    return `Thread '${this.threadId}' crossed from project '${this.expectedProjectId}' to '${this.actualProjectId}'.`;
  }
}

export class OrchestrationTurnWaitTargetReplacedError extends Schema.TaggedErrorClass<OrchestrationTurnWaitTargetReplacedError>()(
  "OrchestrationTurnWaitTargetReplacedError",
  {
    threadId: ThreadId,
    expectedTurnId: TurnId,
    actualTurnId: Schema.NullOr(TurnId),
  },
) {
  override get message(): string {
    const actual = this.actualTurnId === null ? "no active turn" : `turn '${this.actualTurnId}'`;
    return `Turn '${this.expectedTurnId}' in thread '${this.threadId}' was replaced by ${actual}.`;
  }
}

export class OrchestrationTurnWaitInterruptedError extends Schema.TaggedErrorClass<OrchestrationTurnWaitInterruptedError>()(
  "OrchestrationTurnWaitInterruptedError",
  {
    threadId: ThreadId,
    turnId: Schema.NullOr(TurnId),
    eventType: Schema.String,
  },
) {
  override get message(): string {
    return `Waiting for thread '${this.threadId}' was interrupted by '${this.eventType}'.`;
  }
}

export interface OrchestrationTurnWaitInput {
  readonly threadId: ThreadId;
  readonly expectedProjectId?: ProjectId;
  /** Ignore an older completed turn while a newly requested turn is starting. */
  readonly requestedAtOrAfter?: string;
  /** Internal cancellation boundary; evaluated once for each committed domain event. */
  readonly interruptWhen?: (event: OrchestrationEvent) => boolean;
}

export interface OrchestrationTurnWaitResult {
  readonly thread: OrchestrationThread;
  readonly turn: OrchestrationLatestTurn;
}

export type OrchestrationTurnWaitError =
  | ProjectionRepositoryError
  | OrchestrationTurnWaitThreadNotFoundError
  | OrchestrationTurnWaitProjectMismatchError
  | OrchestrationTurnWaitTargetReplacedError
  | OrchestrationTurnWaitInterruptedError;

export interface OrchestrationTurnWaitShape {
  readonly waitForSettledTurn: (
    input: OrchestrationTurnWaitInput,
  ) => Effect.Effect<OrchestrationTurnWaitResult, OrchestrationTurnWaitError>;
}

export class OrchestrationTurnWait extends Context.Service<
  OrchestrationTurnWait,
  OrchestrationTurnWaitShape
>()("t3/orchestration/Services/OrchestrationTurnWait") {}
