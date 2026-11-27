import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as LocalVoiceEngine from "../../assistant/LocalVoiceEngine.ts";
import { voiceRecordingGuard } from "../../assistant/VoiceRecordingGuard.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import * as Channels from "../channels.ts";

const VoiceResult = Schema.Struct({
  ok: Schema.Boolean,
  text: Schema.optionalKey(Schema.String),
  audio: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(Schema.String),
  warning: Schema.optionalKey(Schema.String),
  device: Schema.optionalKey(Schema.String),
});

export const voiceRecordingBegin = DesktopIpc.makeIpcMethod({
  channel: Channels.ASSISTANT_VOICE_RECORDING_BEGIN_CHANNEL,
  payload: Schema.Void,
  result: Schema.String,
  handler: Effect.fn("desktop.assistant.voiceRecordingBegin")(function* (_payload, event) {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    if (!event.sender) return yield* Effect.die(new Error("Missing recording sender"));
    return yield* Effect.sync(() => voiceRecordingGuard.begin(environment.stateDir, event.sender!));
  }),
});

export const voiceRecordingEnd = DesktopIpc.makeIpcMethod({
  channel: Channels.ASSISTANT_VOICE_RECORDING_END_CHANNEL,
  payload: Schema.String,
  result: Schema.Void,
  handler: Effect.fn("desktop.assistant.voiceRecordingEnd")(function* (token, event) {
    if (!event.sender) return yield* Effect.die(new Error("Missing recording sender"));
    yield* Effect.sync(() => voiceRecordingGuard.end(token, event.sender!));
  }),
});

export const voiceStatus = DesktopIpc.makeIpcMethod({
  channel: Channels.ASSISTANT_VOICE_STATUS_CHANNEL,
  payload: Schema.Void,
  result: Schema.Struct({
    paths: Schema.Struct({
      python: Schema.String,
      whisper: Schema.String,
      qwen: Schema.String,
      script: Schema.String,
      sample: Schema.String,
    }),
    python: Schema.Boolean,
    whisper: Schema.Boolean,
    qwen: Schema.Boolean,
    script: Schema.Boolean,
    sample: Schema.Boolean,
  }),
  handler: Effect.fn("desktop.assistant.voiceStatus")(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    return yield* Effect.promise(() =>
      LocalVoiceEngine.voiceStatus(
        environment.appRoot,
        environment.isPackaged ? environment.resourcesPath : undefined,
        environment.isPackaged ? environment.baseDir : environment.rootDir,
        environment.stateDir,
      ),
    );
  }),
});

export const voiceRun = DesktopIpc.makeIpcMethod({
  channel: Channels.ASSISTANT_VOICE_RUN_CHANNEL,
  payload: Schema.Struct({
    task: Schema.Literals(["transcribe", "clone"]),
    audio: Schema.optionalKey(Schema.String),
    text: Schema.optionalKey(Schema.String),
    referenceText: Schema.optionalKey(Schema.String),
  }),
  result: VoiceResult,
  handler: Effect.fn("desktop.assistant.voiceRun")(function* (request) {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    return yield* Effect.promise(() =>
      LocalVoiceEngine.runVoice(
        environment.appRoot,
        request,
        environment.isPackaged ? environment.resourcesPath : undefined,
        environment.isPackaged ? environment.baseDir : environment.rootDir,
        environment.stateDir,
      ).catch((cause) => ({ ok: false, error: String(cause) })),
    );
  }),
});

export const voiceSampleSave = DesktopIpc.makeIpcMethod({
  channel: Channels.ASSISTANT_VOICE_SAMPLE_SAVE_CHANNEL,
  payload: Schema.Struct({ audio: Schema.String, token: Schema.String }),
  result: VoiceResult,
  handler: Effect.fn("desktop.assistant.voiceSampleSave")(function* ({ audio, token }) {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    return yield* Effect.promise(() =>
      LocalVoiceEngine.saveVoiceSample(environment.stateDir, audio, token).catch((cause) => ({
        ok: false,
        error: String(cause),
      })),
    );
  }),
});

export const voiceSampleBegin = DesktopIpc.makeIpcMethod({
  channel: Channels.ASSISTANT_VOICE_SAMPLE_BEGIN_CHANNEL,
  payload: Schema.Void,
  result: Schema.String,
  handler: Effect.fn("desktop.assistant.voiceSampleBegin")(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    return yield* Effect.promise(() =>
      LocalVoiceEngine.beginVoiceSampleUpdate(environment.stateDir),
    );
  }),
});

export const voiceSampleDelete = DesktopIpc.makeIpcMethod({
  channel: Channels.ASSISTANT_VOICE_SAMPLE_DELETE_CHANNEL,
  payload: Schema.Void,
  result: VoiceResult,
  handler: Effect.fn("desktop.assistant.voiceSampleDelete")(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    return yield* Effect.promise(() => LocalVoiceEngine.deleteVoiceSample(environment.stateDir));
  }),
});

export const voiceCancel = DesktopIpc.makeIpcMethod({
  channel: Channels.ASSISTANT_VOICE_CANCEL_CHANNEL,
  payload: Schema.Void,
  result: Schema.Boolean,
  handler: () => Effect.sync(() => LocalVoiceEngine.cancelVoice()),
});
