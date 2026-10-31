import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const SkillInvocationPolicy = Schema.Literals(["both", "manual", "model", "disabled"]);
export const SkillMetadata = Schema.Struct({
  name: TrimmedNonEmptyString,
  description: Schema.String,
  path: TrimmedNonEmptyString,
  scope: Schema.String,
  provider: Schema.String,
  enabled: Schema.Boolean,
  invocation: SkillInvocationPolicy,
  argumentHint: Schema.String,
  compatibility: Schema.String,
  allowedTools: Schema.Array(Schema.String),
  nativeOnly: Schema.Boolean,
  extensions: Schema.Record(Schema.String, Schema.Unknown),
  diagnostics: Schema.Array(Schema.String),
  digest: Schema.String,
});
export type SkillMetadata = typeof SkillMetadata.Type;

export const SkillBinding = Schema.Struct({
  name: TrimmedNonEmptyString,
  path: TrimmedNonEmptyString,
  provider: TrimmedNonEmptyString,
  arguments: Schema.String,
  digest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  mode: Schema.Literals(["native", "instructions"]),
  snapshotPath: Schema.optionalKey(Schema.String),
  resources: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({ path: Schema.String, sha256: Schema.String, bytes: Schema.Number }),
    ),
  ),
});
export type SkillBinding = typeof SkillBinding.Type;

export const SkillResourceDigest = Schema.Struct({
  path: TrimmedNonEmptyString,
  sha256: Schema.String,
  bytes: Schema.Number,
});
export type SkillResourceDigest = typeof SkillResourceDigest.Type;
