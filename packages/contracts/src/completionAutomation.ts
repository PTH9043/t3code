import * as Schema from "effect/Schema";
const Commands = Schema.Array(
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1000)),
).check(Schema.isMaxLength(6));
export const WorkspaceCompletionAutomation = Schema.Struct({
  enabled: Schema.Boolean,
  formatCommands: Commands,
  verificationCommands: Commands,
  saveResult: Schema.Boolean,
  followUpTask: Schema.NullOr(Schema.String.check(Schema.isMaxLength(8000))),
});
export type WorkspaceCompletionAutomation = typeof WorkspaceCompletionAutomation.Type;
export const DEFAULT_COMPLETION_AUTOMATION: WorkspaceCompletionAutomation = {
  enabled: false,
  formatCommands: [],
  verificationCommands: [],
  saveResult: true,
  followUpTask: null,
};
export const WorkspaceAutomationCheck = Schema.Struct({
  phase: Schema.Literals(["format", "verification"]),
  command: Schema.String,
  exitCode: Schema.NullOr(Schema.Number),
  passed: Schema.Boolean,
  output: Schema.String,
  startedAt: Schema.String,
  completedAt: Schema.String,
});
export type WorkspaceAutomationCheck = typeof WorkspaceAutomationCheck.Type;
