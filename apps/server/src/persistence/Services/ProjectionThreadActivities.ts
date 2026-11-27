/**
 * ProjectionThreadActivityRepository - Projection repository interface for thread activity.
 *
 * Owns persistence operations for activity timeline entries projected from
 * orchestration events.
 *
 * @module ProjectionThreadActivityRepository
 */
import {
  EventId,
  IsoDateTime,
  NonNegativeInt,
  OrchestrationThreadActivityTone,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionThreadActivity = Schema.Struct({
  activityId: EventId,
  threadId: ThreadId,
  turnId: Schema.NullOr(TurnId),
  tone: OrchestrationThreadActivityTone,
  kind: Schema.String,
  summary: Schema.String,
  payload: Schema.Unknown,
  sequence: Schema.optional(NonNegativeInt),
  createdAt: IsoDateTime,
});
export type ProjectionThreadActivity = typeof ProjectionThreadActivity.Type;

export const ListProjectionThreadActivitiesInput = Schema.Struct({
  threadId: ThreadId,
});
export type ListProjectionThreadActivitiesInput = typeof ListProjectionThreadActivitiesInput.Type;

export const ListProjectionThreadActivitiesByKindInput = Schema.Struct({
  threadId: ThreadId,
  kinds: Schema.Array(Schema.String),
  completedToolNames: Schema.optional(Schema.Array(Schema.String)),
  recentMcp: Schema.optional(
    Schema.Struct({
      since: IsoDateTime,
      summaries: Schema.Array(Schema.String),
    }),
  ),
});
export type ListProjectionThreadActivitiesByKindInput =
  typeof ListProjectionThreadActivitiesByKindInput.Type;

export const DeleteProjectionThreadActivitiesInput = Schema.Struct({
  threadId: ThreadId,
});
export type DeleteProjectionThreadActivitiesInput =
  typeof DeleteProjectionThreadActivitiesInput.Type;

/**
 * ProjectionThreadActivityRepositoryShape - Service API for projected thread activity.
 */
export interface ProjectionThreadActivityRepositoryShape {
  /**
   * Insert or replace a projected thread activity row.
   *
   * Upserts by `activityId` and JSON-encodes payload.
   */
  readonly upsert: (
    row: ProjectionThreadActivity,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  /**
   * List projected thread activity rows for a thread.
   *
   * Returned in ascending runtime sequence order (or creation order when
   * sequence is unavailable).
   */
  readonly listByThreadId: (
    input: ListProjectionThreadActivitiesInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionThreadActivity>, ProjectionRepositoryError>;

  /**
   * Same order as listByThreadId, restricted to the given activity kinds and,
   * when requested, completed calls to specific tools. The
   * shell summary only needs the user-input lifecycle rows, and loading a long
   * thread's whole log (payloads included) on every event was the server's
   * dominant per-event cost.
   */
  readonly listByThreadIdAndKinds: (
    input: ListProjectionThreadActivitiesByKindInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionThreadActivity>, ProjectionRepositoryError>;

  /**
   * Delete projected thread activity rows by thread.
   */
  readonly deleteByThreadId: (
    input: DeleteProjectionThreadActivitiesInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

/**
 * ProjectionThreadActivityRepository - Service tag for thread activity persistence.
 */
export class ProjectionThreadActivityRepository extends Context.Service<
  ProjectionThreadActivityRepository,
  ProjectionThreadActivityRepositoryShape
>()("t3/persistence/Services/ProjectionThreadActivities/ProjectionThreadActivityRepository") {}
