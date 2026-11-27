import * as Schema from "effect/Schema";
import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ModelSelection } from "./orchestration.ts";
import { ThreadTeamMember } from "./threadModelTeam.ts";
import { ThreadResponseStyle } from "./threadResponseStyle.ts";

export const SavedThreadSettingsTeam = Schema.Struct({
  answeringModel: ModelSelection,
  source: Schema.Literals(["room", "global", "account"]),
  members: Schema.Array(ThreadTeamMember),
});
export type SavedThreadSettingsTeam = typeof SavedThreadSettingsTeam.Type;

export const ThreadSettingsSnapshot = Schema.Struct({
  modelSelection: ModelSelection,
  responseStyle: ThreadResponseStyle,
  team: SavedThreadSettingsTeam,
}).check(
  Schema.makeFilter(
    (s) =>
      (s.modelSelection.instanceId === s.team.answeringModel.instanceId &&
        s.modelSelection.model === s.team.answeringModel.model) ||
      "Team belongs to a different answering model",
  ),
);
export type ThreadSettingsSnapshot = typeof ThreadSettingsSnapshot.Type;

export const ThreadSettingsPreset = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  snapshot: ThreadSettingsSnapshot,
});
export type ThreadSettingsPreset = typeof ThreadSettingsPreset.Type;

export const ThreadSettingsLibraryEntry = Schema.Struct({
  id: TrimmedNonEmptyString,
  kind: Schema.Literals(["style", "model", "team", "preset"]),
  name: TrimmedNonEmptyString,
  sourceThreadId: Schema.optionalKey(ThreadId),
  projectTitle: Schema.optionalKey(Schema.String),
  threadTitle: Schema.optionalKey(Schema.String),
  modelSelection: Schema.optionalKey(ModelSelection),
  responseStyle: Schema.optionalKey(ThreadResponseStyle),
  team: Schema.optionalKey(SavedThreadSettingsTeam),
});
export type ThreadSettingsLibraryEntry = typeof ThreadSettingsLibraryEntry.Type;
