import * as Schema from "effect/Schema";
import {
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  WorkspaceCollaborationRunId,
} from "./baseSchemas.ts";
import { WorkflowDefinition, WorkflowValues, WorkflowVersion } from "./workflowGraph.ts";
import {
  ProviderInteractionMode,
  RuntimeMode,
  WorkspaceCollaborationRun,
  WorkspaceExecutionProfile,
  WorkflowRoleModels,
} from "./orchestration.ts";
import { SkillMetadata } from "./agentSkills.ts";

export const WORKSPACE_WORKFLOW_WS_METHODS = {
  overview: "workspaceWorkflow.overview",
  save: "workspaceWorkflow.save",
  preview: "workspaceWorkflow.preview",
  start: "workspaceWorkflow.start",
  control: "workspaceWorkflow.control",
  skills: "workspaceWorkflow.skills",
  getRun: "workspaceWorkflow.getRun",
} as const;
export const WorkflowLookup = Schema.Struct({ projectId: ProjectId });
export const WorkflowRunLookup = Schema.Struct({
  projectId: ProjectId,
  runId: WorkspaceCollaborationRunId,
});
export type WorkflowRunLookup = typeof WorkflowRunLookup.Type;
export const WorkflowRunSummary = Schema.Struct({
  id: WorkspaceCollaborationRunId,
  projectId: ProjectId,
  status: WorkspaceCollaborationRun.fields.status,
  createdAt: WorkspaceCollaborationRun.fields.createdAt,
  updatedAt: WorkspaceCollaborationRun.fields.updatedAt,
  error: WorkspaceCollaborationRun.fields.error,
  workflow: Schema.Struct({
    title: Schema.String,
    definitionId: Schema.String,
    definitionRevision: NonNegativeInt,
    definitionDigest: Schema.String,
    control: Schema.Literals(["active", "pause-requested", "paused"]),
    controlRevision: NonNegativeInt,
  }),
  counts: Schema.Struct({
    total: NonNegativeInt,
    completed: NonNegativeInt,
    running: NonNegativeInt,
    failed: NonNegativeInt,
  }),
  failedNodes: Schema.Array(
    Schema.Struct({ id: Schema.String, title: Schema.String, attempts: NonNegativeInt }),
  ),
});
export type WorkflowRunSummary = typeof WorkflowRunSummary.Type;
export const AiTaskRunSummary = Schema.Struct({
  id: WorkspaceCollaborationRunId,
  projectId: ProjectId,
  status: WorkspaceCollaborationRun.fields.status,
  createdAt: WorkspaceCollaborationRun.fields.createdAt,
  updatedAt: WorkspaceCollaborationRun.fields.updatedAt,
  error: WorkspaceCollaborationRun.fields.error,
  title: Schema.String,
  workflowRevision: Schema.NullOr(NonNegativeInt),
  control: Schema.Literals(["active", "pause-requested", "paused"]),
  controlRevision: NonNegativeInt,
  counts: Schema.Struct({
    total: NonNegativeInt,
    completed: NonNegativeInt,
    running: NonNegativeInt,
    failed: NonNegativeInt,
  }),
});
export type AiTaskRunSummary = typeof AiTaskRunSummary.Type;
export const WorkflowSave = Schema.Struct({
  projectId: ProjectId,
  definition: WorkflowDefinition,
  expectedRevision: NonNegativeInt,
  archived: Schema.Boolean,
});
export type WorkflowSave = typeof WorkflowSave.Type;
export const WorkflowPreview = Schema.Struct({
  projectId: ProjectId,
  definition: WorkflowDefinition,
  values: WorkflowValues,
});
export type WorkflowPreview = typeof WorkflowPreview.Type;
export const WorkflowIssue = Schema.Struct({ path: Schema.String, message: Schema.String });
export type WorkflowIssue = typeof WorkflowIssue.Type;
export const WorkflowPreviewResult = Schema.Struct({
  valid: Schema.Boolean,
  issues: Schema.Array(WorkflowIssue),
  nodes: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      title: Schema.String,
      task: Schema.String,
      dependsOn: Schema.Array(Schema.String),
      successCriteria: Schema.Array(Schema.String),
      skillArguments: Schema.Array(Schema.String),
    }),
  ),
});
export type WorkflowPreviewResult = typeof WorkflowPreviewResult.Type;
export const WorkflowStart = Schema.Struct({
  projectId: ProjectId,
  definitionId: Schema.optionalKey(Schema.String),
  revision: Schema.optionalKey(NonNegativeInt),
  values: Schema.optionalKey(WorkflowValues),
  task: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(20_000))),
  requestId: TrimmedNonEmptyString,
  roleModels: Schema.optionalKey(WorkflowRoleModels),
  threadId: Schema.optionalKey(ThreadId),
  executionProfile: Schema.optionalKey(WorkspaceExecutionProfile),
  meeting: Schema.optionalKey(WorkspaceExecutionProfile.fields.meeting),
  orchestra: Schema.optionalKey(WorkspaceExecutionProfile.fields.orchestra),
  requestMode: Schema.optionalKey(Schema.Literals(["direct", "ask-first", "conditions"])),
  runtimeMode: Schema.optionalKey(RuntimeMode),
  interactionMode: Schema.optionalKey(ProviderInteractionMode),
  conditionsConfirmed: Schema.optionalKey(Schema.Boolean),
});
export type WorkflowStart = typeof WorkflowStart.Type;
export const WorkflowControl = Schema.Struct({
  projectId: ProjectId,
  runId: WorkspaceCollaborationRunId,
  expectedRevision: NonNegativeInt,
  action: Schema.Literals(["pause", "resume", "cancel", "retry"]),
  nodeId: Schema.optionalKey(Schema.String),
});
export type WorkflowControl = typeof WorkflowControl.Type;
export const WorkflowOverview = Schema.Struct({
  definitions: Schema.Array(WorkflowVersion),
  defaults: Schema.Array(WorkflowDefinition),
  runs: Schema.Array(WorkflowRunSummary),
  allRuns: Schema.optionalKey(Schema.Array(AiTaskRunSummary)),
});
export type WorkflowOverview = typeof WorkflowOverview.Type;
export const WorkflowSkillCatalog = Schema.Struct({
  skills: Schema.Array(SkillMetadata),
  truncated: Schema.Boolean,
});
export class WorkspaceWorkflowError extends Schema.TaggedErrorClass<WorkspaceWorkflowError>()(
  "WorkspaceWorkflowError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
