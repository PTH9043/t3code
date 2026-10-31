import * as Schema from "effect/Schema";
import {
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { TokenUsageCoverage } from "./tokenUsage.ts";
import { DevelopmentArtifactMediaType } from "./workspaceDevelopment.ts";

export const WORKSPACE_AUTOMATION_WS_METHODS = {
  overview: "workspaceAutomation.overview",
  evidence: "workspaceAutomation.evidence",
} as const;
export const WorkspaceAutomationLookup = Schema.Struct({ projectId: ProjectId });
export const WorkspaceAutomationEvidenceRef = Schema.Struct({
  kind: Schema.Literals([
    "verification-log",
    "integration-log",
    "verification-artifact",
    "integration-artifact",
  ]),
  recordId: TrimmedNonEmptyString,
  index: NonNegativeInt,
  label: Schema.String,
});
export type WorkspaceAutomationEvidenceRef = typeof WorkspaceAutomationEvidenceRef.Type;
export const WorkspaceAutomationEvidenceInput = Schema.Struct({
  projectId: ProjectId,
  ...WorkspaceAutomationEvidenceRef.fields,
});
export type WorkspaceAutomationEvidenceInput = typeof WorkspaceAutomationEvidenceInput.Type;
export const WorkspaceAutomationEvidence = Schema.Struct({
  label: Schema.String,
  contents: Schema.String,
  byteLength: NonNegativeInt,
  truncated: Schema.Boolean,
  mediaType: Schema.optional(DevelopmentArtifactMediaType),
  encoding: Schema.optional(Schema.Literals(["utf8", "base64"])),
  sha256: Schema.optional(Schema.String),
});
export type WorkspaceAutomationEvidence = typeof WorkspaceAutomationEvidence.Type;
export const WorkspaceAutomationRow = Schema.Struct({
  id: Schema.String,
  source: Schema.Literals(["collaboration", "development"]),
  title: Schema.String,
  status: Schema.String,
  requestedAt: IsoDateTime,
  finishedAt: Schema.NullOr(IsoDateTime),
  durationMs: Schema.NullOr(NonNegativeInt),
  attempts: Schema.NullOr(NonNegativeInt),
  retries: Schema.NullOr(NonNegativeInt),
  verification: Schema.Literals([
    "unverified",
    "reported-pass",
    "reported-fail",
    "passed",
    "failed",
    "stale",
  ]),
  measuredTokens: Schema.NullOr(NonNegativeInt),
  tokenCoverage: TokenUsageCoverage,
  threadId: Schema.NullOr(ThreadId),
  evidence: Schema.Array(WorkspaceAutomationEvidenceRef),
});
export type WorkspaceAutomationRow = typeof WorkspaceAutomationRow.Type;
export const WorkspaceAutomationOverview = Schema.Struct({
  projectId: ProjectId,
  generatedAt: IsoDateTime,
  totalRows: NonNegativeInt,
  rows: Schema.Array(WorkspaceAutomationRow).check(Schema.isMaxLength(50)),
  schedules: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      title: Schema.String,
      enabled: Schema.Boolean,
      nextTriggerAt: Schema.NullOr(IsoDateTime),
      lastError: Schema.NullOr(Schema.String),
    }),
  ).check(Schema.isMaxLength(50)),
  totalSchedules: NonNegativeInt,
  metrics: Schema.Struct({
    completed: NonNegativeInt,
    failed: NonNegativeInt,
    active: NonNegativeInt,
    verified: NonNegativeInt,
    retried: NonNegativeInt,
    firstAttemptCompleted: NonNegativeInt,
    knownAttemptRows: NonNegativeInt,
    measuredTokens: Schema.NullOr(NonNegativeInt),
    measuredRows: NonNegativeInt,
  }),
});
export type WorkspaceAutomationOverview = typeof WorkspaceAutomationOverview.Type;
export class WorkspaceAutomationError extends Schema.TaggedErrorClass<WorkspaceAutomationError>()(
  "WorkspaceAutomationError",
  { message: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}
