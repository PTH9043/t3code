import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import { EnvironmentId, ThreadId } from "./baseSchemas.ts";
import { ThreadCharacter } from "./threadCharacter.ts";
import { ModelSelection } from "./orchestration.ts";
import { AssistantAudioSettings } from "./assistantPresence.ts";

/** Settings for the single monitor assistant on this desktop. */
export const DesktopAssistantSettings = Schema.Struct({
  character: ThreadCharacter,
  modelSelection: Schema.NullOr(ModelSelection).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  alwaysOnTop: Schema.Boolean,
  openAtStartup: Schema.Boolean,
  keepOnMainClose: Schema.Boolean,
  voiceSendMode: Schema.optionalKey(Schema.Literals(["confirm", "auto"])),
  idlePowerSave30Fps: Schema.optionalKey(Schema.Boolean),
  customAvatarUrl: Schema.optionalKey(Schema.NullOr(Schema.String)),
  audio: Schema.optionalKey(AssistantAudioSettings),
  conversation: Schema.NullOr(Schema.Struct({ environmentId: EnvironmentId, threadId: ThreadId })),
});
export type DesktopAssistantSettings = typeof DesktopAssistantSettings.Type;

export const DesktopAssistantSettingsPatch = Schema.Struct({
  character: Schema.optionalKey(ThreadCharacter),
  modelSelection: Schema.optionalKey(Schema.NullOr(ModelSelection)),
  alwaysOnTop: Schema.optionalKey(Schema.Boolean),
  openAtStartup: Schema.optionalKey(Schema.Boolean),
  keepOnMainClose: Schema.optionalKey(Schema.Boolean),
  voiceSendMode: Schema.optionalKey(Schema.Literals(["confirm", "auto"])),
  idlePowerSave30Fps: Schema.optionalKey(Schema.Boolean),
  customAvatarUrl: Schema.optionalKey(Schema.NullOr(Schema.String)),
  audio: Schema.optionalKey(AssistantAudioSettings),
  conversation: Schema.optionalKey(
    Schema.NullOr(Schema.Struct({ environmentId: EnvironmentId, threadId: ThreadId })),
  ),
});
export type DesktopAssistantSettingsPatch = typeof DesktopAssistantSettingsPatch.Type;

export const DesktopAssistantModelUpdate = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
  modelSelection: ModelSelection,
  baseModelSelection: ModelSelection,
});
export type DesktopAssistantModelUpdate = typeof DesktopAssistantModelUpdate.Type;

export const DesktopAssistantConversationRef = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
});
export type DesktopAssistantConversationRef = typeof DesktopAssistantConversationRef.Type;

export const DEFAULT_DESKTOP_ASSISTANT_SETTINGS: DesktopAssistantSettings = {
  character: "off",
  modelSelection: null,
  alwaysOnTop: false,
  openAtStartup: false,
  keepOnMainClose: false,
  voiceSendMode: "confirm",
  conversation: null,
};
