import * as Schema from "effect/Schema";
import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * A low-cost helper API that an answering model may hand research and routine
 * chores to. The helper is an API account registered in the app (an OpenCode
 * API connection); which helper each answering model may use is set per
 * provider account.
 */
export const WorkspaceHelperInput = Schema.Struct({
  action: Schema.Literals(["status", "run"]),
  /** The self-contained chore. Required for `run`. */
  task: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(20_000))),
  /** Material the helper needs to do the chore. It sees nothing else. */
  context: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(60_000))),
});
export type WorkspaceHelperInput = typeof WorkspaceHelperInput.Type;

export const WorkspaceHelperResult = Schema.Struct({
  /** False when no helper is assigned to the calling model; `message` says why. */
  available: Schema.Boolean,
  account: Schema.NullOr(Schema.String),
  model: Schema.NullOr(Schema.String),
  /** Whether the user allowed project code and file contents to be sent. */
  projectContentAllowed: Schema.Boolean,
  text: Schema.NullOr(Schema.String),
  inputTokens: Schema.NullOr(NonNegativeInt),
  outputTokens: Schema.NullOr(NonNegativeInt),
  message: Schema.NullOr(Schema.String),
});
export type WorkspaceHelperResult = typeof WorkspaceHelperResult.Type;

export class WorkspaceHelperError extends Schema.TaggedErrorClass<WorkspaceHelperError>()(
  "WorkspaceHelperError",
  { message: Schema.String },
) {}
