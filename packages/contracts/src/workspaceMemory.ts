import * as Schema from "effect/Schema";
import { ProjectId, ThreadId } from "./baseSchemas.ts";

const Scope = Schema.Literals(["project", "global"]);
const Base = { projectId: ProjectId };
const Id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200));
const Query = Schema.String.check(Schema.isMaxLength(4_000));
export const WorkspaceMemoryAction = Schema.Union([
  Schema.Struct({ ...Base, action: Schema.Literals(["status", "dream", "backfill"]) }),
  Schema.Struct({
    ...Base,
    action: Schema.Literal("search"),
    query: Query,
    limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20 }))),
  }),
  Schema.Struct({
    ...Base,
    action: Schema.Literal("read"),
    id: Id,
    offset: Schema.optionalKey(
      Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER - 12_000 })),
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
  Schema.Struct({
    ...Base,
    action: Schema.Literal("history"),
    threadId: ThreadId,
    after: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
    query: Schema.optionalKey(Query),
  }),
  Schema.Struct({ ...Base, action: Schema.Literal("export"), threadId: ThreadId }),
]);
export type WorkspaceMemoryAction = typeof WorkspaceMemoryAction.Type;
export class WorkspaceMemoryError extends Schema.TaggedErrorClass<WorkspaceMemoryError>()(
  "WorkspaceMemoryError",
  { message: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}
