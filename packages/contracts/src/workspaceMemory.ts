import * as Schema from "effect/Schema";
import { ProjectId, ThreadId } from "./baseSchemas.ts";

const Scope = Schema.Literals(["project", "global"]);
const Base = { projectId: ProjectId };
const Id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200));
export const WORKSPACE_MEMORY_WS_METHODS = {
  forgetMessage: "workspaceMemory.forgetMessage",
  remember: "workspaceMemory.remember",
} as const;
export const WorkspaceMemoryForgetInput = Schema.Struct({
  projectId: ProjectId,
  threadId: ThreadId,
  id: Id,
});
export const WorkspaceMemoryRememberInput = Schema.Struct({
  projectId: ProjectId,
  threadId: ThreadId,
  requestId: Id,
  topic: Id,
  text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(8_000)),
  /** Explicitly save to the project root when an older thread has no recorded folder. */
  projectRoot: Schema.optionalKey(Schema.Boolean),
});
const Query = Schema.String.check(Schema.isMaxLength(4_000));
const IsoDateFilter = Schema.String.check(Schema.isMinLength(4), Schema.isMaxLength(40));
export const WorkspaceMemorySpeakerFilter = Schema.Literals(["all", "user", "ai"]);
export type WorkspaceMemorySpeakerFilter = typeof WorkspaceMemorySpeakerFilter.Type;
export const WorkspaceMemoryLayerFilter = Schema.Literals(["all", "observation", "fact"]);
export type WorkspaceMemoryLayerFilter = typeof WorkspaceMemoryLayerFilter.Type;
const makeActions = <B extends Schema.Struct.Fields, L extends Schema.Top>(Base: B, Limit: L) =>
  Schema.Union([
    Schema.Struct({
      ...Base,
      action: Schema.Literals(["status", "dream", "backfill", "user_style"]),
    }),
    Schema.Struct({
      ...Base,
      action: Schema.Literal("search"),
      query: Query,
      limit: Schema.optionalKey(Limit),
      speaker: Schema.optionalKey(WorkspaceMemorySpeakerFilter),
      layer: Schema.optionalKey(WorkspaceMemoryLayerFilter),
      fromDate: Schema.optionalKey(IsoDateFilter),
      toDate: Schema.optionalKey(IsoDateFilter),
      includeSuperseded: Schema.optionalKey(Schema.Boolean),
    }),
    Schema.Struct({
      ...Base,
      action: Schema.Literal("reflect"),
      query: Query,
      limit: Schema.optionalKey(Limit),
    }),
    Schema.Struct({
      ...Base,
      action: Schema.Literal("read"),
      id: Id,
      offset: Schema.optionalKey(
        Schema.Int.check(
          Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER - 12_000 }),
        ),
      ),
    }),
    Schema.Struct({
      ...Base,
      action: Schema.Literal("remember"),
      requestId: Id,
      topic: Id,
      text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(8_000)),
      scope: Schema.optionalKey(Scope),
    }),
    Schema.Struct({ ...Base, action: Schema.Literal("forget"), id: Id }),
    Schema.Struct({ ...Base, action: Schema.Literal("forget-message"), id: Id }),
    Schema.Struct({
      ...Base,
      action: Schema.Literal("history"),
      threadId: ThreadId,
      after: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
      query: Schema.optionalKey(Query),
      speaker: Schema.optionalKey(WorkspaceMemorySpeakerFilter),
    }),
    Schema.Struct({ ...Base, action: Schema.Literal("export"), threadId: ThreadId }),
  ]);
export const WORKSPACE_MEMORY_SEARCH_LIMIT_MAX = 20;
export const WorkspaceMemoryAction = makeActions(
  Base,
  Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: WORKSPACE_MEMORY_SEARCH_LIMIT_MAX })),
);
/**
 * What the agent-facing tool accepts. The project is always the calling
 * conversation's, so it may be omitted, and an oversized search limit is
 * clamped by the handler rather than rejected as an unreadable union error.
 */
export const WorkspaceMemoryToolInput = makeActions(
  { projectId: Schema.optionalKey(ProjectId) },
  Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
);
export type WorkspaceMemoryToolInput = typeof WorkspaceMemoryToolInput.Type;
export type WorkspaceMemoryAction = typeof WorkspaceMemoryAction.Type;
export class WorkspaceMemoryError extends Schema.TaggedErrorClass<WorkspaceMemoryError>()(
  "WorkspaceMemoryError",
  { message: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}
