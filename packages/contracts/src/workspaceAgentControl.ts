import * as Schema from "effect/Schema";
import {
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  TrimmedNonEmptyString,
  WorkspaceCollaborationRunId,
  WorkspaceTaskNodeId,
} from "./baseSchemas.ts";

export const AGENT_CONTROL_ACTIVITY_KIND = "orchestra.agent-control";
export const WORKSPACE_AGENT_CONTROL_WS_METHODS = {
  overview: "workspace.agentControl.overview",
  attention: "workspace.agentControl.attention",
  subscribe: "workspace.agentControl.subscribe",
  action: "workspace.agentControl.action",
  evidence: "workspace.agentControl.evidence",
} as const;

export const WorkspaceAttentionLookup = Schema.Struct({ projectId: Schema.optionalKey(ProjectId) });
export const WorkspaceRunAttention = Schema.Struct({
  id: Schema.String,
  projectId: ProjectId,
  runId: WorkspaceCollaborationRunId,
  threadId: Schema.NullOr(Schema.String),
  kind: Schema.Literals(["question", "plan", "verification", "usage-wait"]),
  title: Schema.String,
  detail: Schema.String,
  updatedAt: IsoDateTime,
});
export type WorkspaceRunAttention = typeof WorkspaceRunAttention.Type;
export const WorkspaceAttentionOverview = Schema.Struct({
  items: Schema.Array(WorkspaceRunAttention),
  total: NonNegativeInt,
});

export const WorkspaceAgentControlLookup = Schema.Struct({
  projectId: ProjectId,
  runId: WorkspaceCollaborationRunId,
});
export type WorkspaceAgentControlLookup = typeof WorkspaceAgentControlLookup.Type;

export const WorkspaceAgentControlRecord = Schema.Struct({
  id: TrimmedNonEmptyString,
  projectId: ProjectId,
  runId: WorkspaceCollaborationRunId,
  recordType: Schema.Literals(["message", "handoff", "report"]),
  fromNodeId: Schema.NullOr(WorkspaceTaskNodeId),
  toNodeId: Schema.NullOr(WorkspaceTaskNodeId),
  title: Schema.String,
  text: Schema.String,
  status: Schema.Literals([
    "queued",
    "dispatching",
    "accepted",
    "read",
    "cancelled",
    "unknown",
    "prepared",
    "recorded",
  ]),
  revision: NonNegativeInt,
  executionId: Schema.NullOr(Schema.String),
  contentHash: Schema.String,
  sourcePath: Schema.NullOr(Schema.String),
  sourceHash: Schema.NullOr(Schema.String),
  sourceChars: Schema.NullOr(NonNegativeInt),
  model: Schema.NullOr(Schema.String),
  providerInstanceId: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type WorkspaceAgentControlRecord = typeof WorkspaceAgentControlRecord.Type;

export const WorkspaceAgentControlOverview = Schema.Struct({
  records: Schema.Array(WorkspaceAgentControlRecord),
  total: NonNegativeInt,
});
export type WorkspaceAgentControlOverview = typeof WorkspaceAgentControlOverview.Type;

const identity = {
  ...WorkspaceAgentControlLookup.fields,
  requestId: TrimmedNonEmptyString.check(Schema.isMaxLength(100)),
};
export const WorkspaceAgentControlAction = Schema.Union([
  Schema.Struct({
    ...identity,
    action: Schema.Literal("send"),
    toNodeId: WorkspaceTaskNodeId,
    text: TrimmedNonEmptyString.check(Schema.isMaxLength(8_000)),
  }),
  Schema.Struct({
    ...WorkspaceAgentControlLookup.fields,
    action: Schema.Literal("read"),
    recordId: Schema.optionalKey(TrimmedNonEmptyString),
  }),
  Schema.Struct({
    ...WorkspaceAgentControlLookup.fields,
    action: Schema.Literals(["ack", "cancel", "requeue"]),
    recordId: TrimmedNonEmptyString,
    expectedRevision: NonNegativeInt,
  }),
]);
export type WorkspaceAgentControlAction = typeof WorkspaceAgentControlAction.Type;

export const WorkspaceAgentControlEvidenceInput = Schema.Struct({
  ...WorkspaceAgentControlLookup.fields,
  recordId: TrimmedNonEmptyString,
});
export type WorkspaceAgentControlEvidenceInput = typeof WorkspaceAgentControlEvidenceInput.Type;
export const WorkspaceAgentControlEvidence = Schema.Struct({
  record: WorkspaceAgentControlRecord,
  text: Schema.String,
});
export class WorkspaceAgentControlError extends Schema.TaggedErrorClass<WorkspaceAgentControlError>()(
  "WorkspaceAgentControlError",
  { message: Schema.String },
) {}
