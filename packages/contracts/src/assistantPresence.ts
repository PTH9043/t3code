import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { PersonaAvatarExpressionKey, SituationMode } from "./livingPersona.ts";

export const AssistantInteractionMode = Schema.Literals([
  "idle",
  "listening",
  "thinking",
  "speaking",
  "working_bg",
  "alert_brake",
]);
export type AssistantInteractionMode = typeof AssistantInteractionMode.Type;

export const AssistantExpressionKey = PersonaAvatarExpressionKey;
export type AssistantExpressionKey = typeof AssistantExpressionKey.Type;

export const VisemeWeights = Schema.Struct({
  a: Schema.Number,
  i: Schema.Number,
  u: Schema.Number,
  e: Schema.Number,
  o: Schema.Number,
  silence: Schema.Number,
});
export type VisemeWeights = typeof VisemeWeights.Type;

export const ZERO_VISEME_WEIGHTS: VisemeWeights = {
  a: 0,
  i: 0,
  u: 0,
  e: 0,
  o: 0,
  silence: 1,
};

export const AssistantGazeSource = Schema.Literals([
  "cursor",
  "camera",
  "saccade_idle",
  "scripted",
]);
export type AssistantGazeSource = typeof AssistantGazeSource.Type;

export const AssistantGazeTarget = Schema.Struct({
  /** Normalized horizontal screen coordinate in [-1.0, +1.0]. */
  x: Schema.Number,
  /** Normalized vertical screen coordinate in [-1.0, +1.0]. */
  y: Schema.Number,
  source: AssistantGazeSource,
});
export type AssistantGazeTarget = typeof AssistantGazeTarget.Type;

export const AssistantPresenceState = Schema.Struct({
  personaId: Schema.String,
  /** Backward-compatible 1-bit working indicator for existing views. */
  isWorking: Schema.Boolean,
  mode: AssistantInteractionMode,
  situation: SituationMode,
  expression: AssistantExpressionKey,
  /** Target blend weight in [0.0, 1.0] for 300ms spring interpolation. */
  expressionWeight: Schema.Number,
  gazeTarget: AssistantGazeTarget,
  visemeWeights: VisemeWeights,
  activeSpeechText: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
export type AssistantPresenceState = typeof AssistantPresenceState.Type;

export const AssistantTtsEngine = Schema.Literals(["local_tts", "local_clone", "openai_compat"]);
export type AssistantTtsEngine = typeof AssistantTtsEngine.Type;

export const AssistantSttEngine = Schema.Literals([
  "local_whisper",
  "openai_compat",
  "browser_speech",
]);
export type AssistantSttEngine = typeof AssistantSttEngine.Type;

export const AssistantAudioSettings = Schema.Struct({
  handsFreeVad: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  bargeInEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  voiceConversationMode: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  ttsEngine: AssistantTtsEngine.pipe(Schema.withDecodingDefault(Effect.succeed("local_tts"))),
  sttEngine: AssistantSttEngine.pipe(Schema.withDecodingDefault(Effect.succeed("local_whisper"))),
  /** Loopback or user-approved OpenAI-compatible audio gateway (`unspeech`, Kokoro, GPT-SoVITS, F5-TTS, Fish Speech). */
  audioBaseUrl: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  ttsVoice: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed("af_heart"))),
  ttsModel: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed("kokoro"))),
  sttModel: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed("whisper-1"))),
  proactiveBriefingEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  proactiveCooldownMinutes: Schema.Number.pipe(Schema.withDecodingDefault(Effect.succeed(30))),
});
export type AssistantAudioSettings = typeof AssistantAudioSettings.Type;

export const DEFAULT_ASSISTANT_AUDIO_SETTINGS: AssistantAudioSettings = {
  handsFreeVad: false,
  bargeInEnabled: true,
  voiceConversationMode: false,
  ttsEngine: "local_tts",
  sttEngine: "local_whisper",
  audioBaseUrl: "",
  ttsVoice: "af_heart",
  ttsModel: "kokoro",
  sttModel: "whisper-1",
  proactiveBriefingEnabled: true,
  proactiveCooldownMinutes: 30,
};

export interface AssistantProactiveBriefingPayload {
  readonly personaId: string;
  readonly summaryText: string;
  readonly speakAloud: boolean;
  readonly sourceTaskId?: string | undefined;
}

export interface AssistantChannelTransport {
  readonly channelId: "desktop_ui" | "web_remote" | "discord" | "telegram";
  sendProactiveBriefing(payload: AssistantProactiveBriefingPayload): Promise<void>;
}

export function createInitialPresenceState(
  personaId: string,
  overrides?: Partial<AssistantPresenceState>,
): AssistantPresenceState {
  return {
    personaId,
    isWorking: false,
    mode: "idle",
    situation: "DEEP_WORK",
    expression: "neutral",
    expressionWeight: 0.7,
    gazeTarget: { x: 0, y: 0, source: "saccade_idle" },
    visemeWeights: ZERO_VISEME_WEIGHTS,
    activeSpeechText: null,
    ...overrides,
  };
}
