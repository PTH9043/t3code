import * as Schema from "effect/Schema";
import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { SkillBinding } from "./agentSkills.ts";

const Slug = TrimmedNonEmptyString.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
);
export const WorkflowInput = Schema.Struct({
  name: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  type: Schema.Literals(["string", "number", "boolean", "path"]),
  required: Schema.Boolean,
  defaultValue: Schema.String,
});
export type WorkflowInput = typeof WorkflowInput.Type;
export const WorkflowNode = Schema.Struct({
  id: Slug,
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  kind: Schema.Literals(["orchestration", "research", "implementation", "debug"]),
  agent: Schema.Literals(["fable", "codex", "grok"]),
  participantId: Schema.NullOr(Schema.String),
  task: TrimmedNonEmptyString.check(Schema.isMaxLength(4000)),
  dependsOn: Schema.Array(Slug),
  successCriteria: Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(4000))),
  skills: Schema.Array(SkillBinding),
});
export type WorkflowNode = typeof WorkflowNode.Type;
export const WorkflowDefinition = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  id: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  description: Schema.String,
  inputs: Schema.Array(WorkflowInput),
  nodes: Schema.Array(WorkflowNode).check(Schema.isMinLength(1), Schema.isMaxLength(24)),
});
export type WorkflowDefinition = typeof WorkflowDefinition.Type;
export const WorkflowValues = Schema.Record(Schema.String, Schema.String);
export type WorkflowValues = typeof WorkflowValues.Type;
export const WorkflowVersion = Schema.Struct({
  ...WorkflowDefinition.fields,
  revision: NonNegativeInt,
  archived: Schema.Boolean,
  digest: Schema.String,
  createdAt: IsoDateTime,
});
export type WorkflowVersion = typeof WorkflowVersion.Type;
export const WorkflowExecutionContext = Schema.Struct({
  definitionId: Schema.String,
  definitionRevision: NonNegativeInt,
  definitionDigest: Schema.String,
  title: Schema.String,
  values: WorkflowValues,
  nodeSkills: Schema.Array(
    Schema.Struct({ nodeId: Schema.String, skills: Schema.Array(SkillBinding) }),
  ),
  control: Schema.Literals(["active", "pause-requested", "paused"]),
  controlRevision: NonNegativeInt,
  executionRevision: Schema.optionalKey(NonNegativeInt),
  updatedAt: IsoDateTime,
  requestDigest: Schema.String,
  requestMode: Schema.optionalKey(Schema.Literals(["direct", "ask-first", "conditions"])),
});
export type WorkflowExecutionContext = typeof WorkflowExecutionContext.Type;
