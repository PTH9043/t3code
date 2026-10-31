import * as Schema from "effect/Schema";
import {
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  TrimmedNonEmptyString,
  WorkspaceCollaborationRunId,
} from "./baseSchemas.ts";
import { WorkspaceExecutionProfile } from "./orchestration.ts";

export const WORKSPACE_TASK_INBOX_WS_METHODS = {
  overview: "workspaceTaskInbox.overview",
  subscribe: "workspaceTaskInbox.subscribe",
  get: "workspaceTaskInbox.get",
  saveRecipe: "workspaceTaskInbox.saveRecipe",
  submit: "workspaceTaskInbox.submit",
  action: "workspaceTaskInbox.action",
} as const;

const ShortText = TrimmedNonEmptyString.check(Schema.isMaxLength(200));
const Command = TrimmedNonEmptyString.check(Schema.isMaxLength(1000));
export const WorkspaceTaskInputs = Schema.Record(
  TrimmedNonEmptyString.check(Schema.isPattern(/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/)),
  Schema.String.check(Schema.isMaxLength(4000)),
);
export type WorkspaceTaskInputs = typeof WorkspaceTaskInputs.Type;
export const WorkspaceTaskPrecheck = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("none") }),
  Schema.Struct({
    kind: Schema.Literal("files"),
    paths: Schema.Array(ShortText).check(Schema.isMinLength(1), Schema.isMaxLength(20)),
  }),
  Schema.Struct({ kind: Schema.Literal("command"), command: Command }),
]);
export const WorkspaceTaskArtifact = Schema.Struct({
  path: ShortText,
  format: Schema.Literals(["text", "json"]),
  requiredKeys: Schema.Array(ShortText).check(Schema.isMaxLength(20)),
});
export type WorkspaceTaskArtifact = typeof WorkspaceTaskArtifact.Type;
export const WorkspaceTaskRecipeDefinition = Schema.Struct({
  id: ShortText,
  name: ShortText,
  enabled: Schema.Boolean,
  parameters: Schema.Array(
    Schema.Struct({
      name: TrimmedNonEmptyString.check(Schema.isPattern(/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/)),
      label: ShortText,
      required: Schema.Boolean,
      defaultValue: Schema.String.check(Schema.isMaxLength(4000)),
    }),
  ).check(Schema.isMaxLength(12)),
  taskTemplate: TrimmedNonEmptyString.check(Schema.isMaxLength(10_000)),
  execution: Schema.Literals(["agent", "script"]),
  script: Schema.String.check(Schema.isMaxLength(1000)),
  precheck: WorkspaceTaskPrecheck,
  artifacts: Schema.Array(WorkspaceTaskArtifact).check(Schema.isMaxLength(10)),
  verificationCommands: Schema.Array(Command).check(Schema.isMaxLength(8)),
  executionProfile: Schema.NullOr(WorkspaceExecutionProfile),
});
export type WorkspaceTaskRecipeDefinition = typeof WorkspaceTaskRecipeDefinition.Type;
export const WorkspaceTaskRecipe = Schema.Struct({
  ...WorkspaceTaskRecipeDefinition.fields,
  revision: NonNegativeInt,
  updatedAt: IsoDateTime,
});
export type WorkspaceTaskRecipe = typeof WorkspaceTaskRecipe.Type;
export const WorkspaceTaskReceipt = Schema.Struct({
  kind: Schema.Literals(["precheck", "script", "verification", "artifact"]),
  label: Schema.String,
  passed: Schema.Boolean,
  exitCode: Schema.NullOr(Schema.Number),
  sha256: Schema.NullOr(Schema.String),
  output: Schema.String,
  observedAt: IsoDateTime,
});
export type WorkspaceTaskReceipt = typeof WorkspaceTaskReceipt.Type;
export const WorkspaceInboxTaskStatus = Schema.Literals([
  "queued",
  "held",
  "checking",
  "dispatching",
  "running",
  "verifying",
  "cancel-requested",
  "completed",
  "unchanged",
  "needs-verification",
  "failed",
  "cancelled",
  "delivery-unknown",
]);
export type WorkspaceInboxTaskStatus = typeof WorkspaceInboxTaskStatus.Type;
export const WorkspaceInboxTask = Schema.Struct({
  id: ShortText,
  projectId: ProjectId,
  source: ShortText,
  externalId: ShortText,
  inputHash: Schema.String,
  inputs: WorkspaceTaskInputs,
  recipe: WorkspaceTaskRecipe,
  status: WorkspaceInboxTaskStatus,
  attempt: NonNegativeInt,
  runId: Schema.NullOr(WorkspaceCollaborationRunId),
  monitorKey: Schema.String,
  workspaceRoot: Schema.NullOr(Schema.String),
  precheckFingerprint: Schema.NullOr(Schema.String),
  baseline: Schema.Record(Schema.String, Schema.NullOr(Schema.String)),
  receipts: Schema.Array(WorkspaceTaskReceipt),
  output: Schema.String,
  error: Schema.NullOr(Schema.String),
  aiSkipped: Schema.Boolean,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type WorkspaceInboxTask = typeof WorkspaceInboxTask.Type;
export const WorkspaceTaskInboxLookup = Schema.Struct({ projectId: ProjectId });
export const WorkspaceTaskLookup = Schema.Struct({ projectId: ProjectId, taskId: ShortText });
export const WorkspaceTaskRecipeSave = Schema.Struct({
  projectId: ProjectId,
  recipe: WorkspaceTaskRecipeDefinition,
});
export type WorkspaceTaskRecipeSave = typeof WorkspaceTaskRecipeSave.Type;
export const WorkspaceTaskSubmit = Schema.Struct({
  projectId: ProjectId,
  recipeId: ShortText,
  recipeRevision: Schema.optionalKey(NonNegativeInt),
  source: ShortText,
  externalId: ShortText,
  inputs: WorkspaceTaskInputs,
});
export type WorkspaceTaskSubmit = typeof WorkspaceTaskSubmit.Type;
export const WorkspaceTaskAction = Schema.Struct({
  projectId: ProjectId,
  taskId: ShortText,
  action: Schema.Literals(["hold", "release", "cancel", "retry", "reconcile"]),
});
export type WorkspaceTaskAction = typeof WorkspaceTaskAction.Type;
export const WorkspaceTaskInboxEntry = Schema.Struct({
  id: ShortText,
  source: ShortText,
  externalId: ShortText,
  status: WorkspaceInboxTaskStatus,
  attempt: NonNegativeInt,
  runId: Schema.NullOr(WorkspaceCollaborationRunId),
  error: Schema.NullOr(Schema.String),
  aiSkipped: Schema.Boolean,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  recipeId: ShortText,
  recipeName: ShortText,
  recipeRevision: NonNegativeInt,
});
export type WorkspaceTaskInboxEntry = typeof WorkspaceTaskInboxEntry.Type;
export const WorkspaceTaskInboxOverview = Schema.Struct({
  recipes: Schema.Array(WorkspaceTaskRecipe),
  tasks: Schema.Array(WorkspaceTaskInboxEntry),
  totalTasks: NonNegativeInt,
  completed: NonNegativeInt,
  aiSkipped: NonNegativeInt,
  waiting: NonNegativeInt,
});
export type WorkspaceTaskInboxOverview = typeof WorkspaceTaskInboxOverview.Type;
export class WorkspaceTaskInboxError extends Schema.TaggedErrorClass<WorkspaceTaskInboxError>()(
  "WorkspaceTaskInboxError",
  { message: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}
