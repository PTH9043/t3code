import * as Schema from "effect/Schema";
import {
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  TrimmedNonEmptyString,
  WorkspaceKnowledgeItemId,
} from "./baseSchemas.ts";

export const WORKSPACE_RESEARCH_WS_METHODS = {
  status: "workspaceResearch.status",
  run: "workspaceResearch.run",
  configureKey: "workspaceResearch.configureKey",
} as const;
export const WorkspaceResearchLookup = Schema.Struct({ projectId: ProjectId });
const DateFilter = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/));
export const WorkspaceResearchInput = Schema.Struct({
  projectId: ProjectId,
  requestId: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  query: TrimmedNonEmptyString.check(Schema.isMaxLength(4000)),
  source: Schema.Literals(["web", "x", "both"]),
  allowedDomains: Schema.optional(
    Schema.Array(Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9.-]+$/))).check(
      Schema.isMaxLength(5),
    ),
  ),
  allowedHandles: Schema.optional(
    Schema.Array(Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_]{1,15}$/))).check(
      Schema.isMaxLength(20),
    ),
  ),
  fromDate: Schema.optional(DateFilter),
  toDate: Schema.optional(DateFilter),
  followUpId: Schema.optional(Schema.String),
});
export type WorkspaceResearchInput = typeof WorkspaceResearchInput.Type;
export const WorkspaceResearchCall = Schema.Struct({
  requestId: Schema.String,
  projectId: ProjectId,
  query: Schema.String,
  kind: Schema.Literals(["research", "compaction"]),
  status: Schema.Literals(["pending", "complete", "uncertain"]),
  createdAt: IsoDateTime,
  day: Schema.String,
  responseId: Schema.NullOr(Schema.String),
  costTicks: Schema.NullOr(NonNegativeInt),
  inputTokens: Schema.NullOr(NonNegativeInt),
  outputTokens: Schema.NullOr(NonNegativeInt),
  cachedTokens: Schema.NullOr(NonNegativeInt),
  text: Schema.String,
  sources: Schema.Array(Schema.String),
  itemId: Schema.NullOr(WorkspaceKnowledgeItemId),
  message: Schema.NullOr(Schema.String),
});
export type WorkspaceResearchCall = typeof WorkspaceResearchCall.Type;
export const WorkspaceResearchStatus = Schema.Struct({
  apiKeyReady: Schema.Boolean,
  model: Schema.String,
  day: Schema.String,
  dailyLimitUsd: Schema.NullOr(Schema.Number),
  reportedTodayUsd: Schema.Number,
  projectTodayUsd: Schema.Number,
  unreportedCalls: NonNegativeInt,
  busy: Schema.Boolean,
  calls: Schema.Array(WorkspaceResearchCall),
});
export type WorkspaceResearchStatus = typeof WorkspaceResearchStatus.Type;
export const WorkspaceResearchKeyInput = Schema.Struct({
  apiKey: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(512))),
});
export class WorkspaceResearchError extends Schema.TaggedErrorClass<WorkspaceResearchError>()(
  "WorkspaceResearchError",
  { message: Schema.String },
) {}
