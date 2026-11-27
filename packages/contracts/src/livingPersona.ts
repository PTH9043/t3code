import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const HonorificLevel = Schema.Literals([
  "formal_hapsipsio",
  "polite_haeyo",
  "hybrid_pro",
  "casual_banmal",
]);
export type HonorificLevel = typeof HonorificLevel.Type;

export const SituationMode = Schema.Literals([
  "DEEP_WORK",
  "SUNK_COST_BRAKE",
  "LATE_NIGHT_CARE",
  "CELEBRATION",
  "INCIDENT_RESPONSE",
]);
export type SituationMode = typeof SituationMode.Type;

export const PersonaTraitGenome = Schema.Struct({
  ocean: Schema.Struct({
    openness: Schema.Number,
    conscientiousness: Schema.Number,
    extraversion: Schema.Number,
    agreeableness: Schema.Number,
    neuroticism: Schema.Number,
  }),
  koreanPragmatics: Schema.Struct({
    firmness: Schema.Number,
    warmth: Schema.Number,
    wit: Schema.Number,
    intimacy: Schema.Number,
  }),
});
export type PersonaTraitGenome = typeof PersonaTraitGenome.Type;

export const KoreanRegisterSpec = Schema.Struct({
  primaryLevel: HonorificLevel,
  userTitle: Schema.String,
  selfReference: Schema.String,
  preferredEndings: Schema.Array(Schema.String),
  forbiddenEndings: Schema.Array(Schema.String),
});
export type KoreanRegisterSpec = typeof KoreanRegisterSpec.Type;

export const PersonaOutputContract = Schema.Struct({
  reportHeader: Schema.Struct({
    enabled: Schema.Boolean,
    markdownHeading: Schema.String,
  }),
  closingAdvice: Schema.Struct({
    enabled: Schema.Boolean,
    markdownHeading: Schema.String,
    maxLines: Schema.Literals([1, 2]),
  }),
});
export type PersonaOutputContract = typeof PersonaOutputContract.Type;

export const PersonaAvatarExpressionKey = Schema.Literals([
  "neutral",
  "warm_smile",
  "firm_serious",
  "worried_care",
  "proud_joy",
  "urgent_focus",
]);
export type PersonaAvatarExpressionKey = typeof PersonaAvatarExpressionKey.Type;

export const PersonaAvatarExpressionBinding = Schema.Struct({
  expressionName: Schema.String,
  motionGroup: Schema.optionalKey(Schema.String),
  blendWeight: Schema.optionalKey(Schema.Number),
});

export const PersonaAvatarVoiceConfig = Schema.Struct({
  rendererType: Schema.Literals(["live2d", "vrm", "none"]),
  modelId: Schema.String,
  expressionMap: Schema.Record(Schema.String, PersonaAvatarExpressionBinding).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  voice: Schema.Struct({
    enabled: Schema.Boolean,
    engine: Schema.Literals(["local_tts", "openai_compat", "gpt_sovits"]),
    voiceId: Schema.String,
    baseSpeed: Schema.Number,
    basePitch: Schema.Number,
    prosodyByAffect: Schema.Boolean,
  }),
});
export type PersonaAvatarVoiceConfig = typeof PersonaAvatarVoiceConfig.Type;

export const PersonaFewShotExample = Schema.Struct({
  userPromptSkeleton: Schema.String,
  assistantResponse: Schema.String,
});

export const T3PersonaManifest = Schema.Struct({
  schemaVersion: Schema.Literal("1.0.0"),
  personaId: TrimmedNonEmptyString,
  displayName: TrimmedNonEmptyString,
  tagline: Schema.String,
  isBuiltin: Schema.Boolean,
  memoryPolicy: Schema.Struct({
    shareHumanProfile: Schema.Boolean,
    isolatePersonaSelf: Schema.Boolean,
    sharedGroupKey: Schema.optionalKey(Schema.NullOr(Schema.String)),
  }),
  traits: PersonaTraitGenome,
  register: KoreanRegisterSpec,
  outputContract: PersonaOutputContract,
  avatarVoice: PersonaAvatarVoiceConfig,
  fewShotExamples: Schema.Record(Schema.String, PersonaFewShotExample).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  updatedAt: Schema.String,
});
export type T3PersonaManifest = typeof T3PersonaManifest.Type;

export const PersonaBundle = Schema.Struct({
  manifest: T3PersonaManifest,
  soulMarkdown: Schema.String,
});
export type PersonaBundle = typeof PersonaBundle.Type;

export const PersonaLibraryIndexEntry = Schema.Struct({
  personaId: Schema.String,
  displayName: Schema.String,
  tagline: Schema.String,
  isBuiltin: Schema.Boolean,
  rendererType: Schema.Literals(["live2d", "vrm", "none"]),
  modelId: Schema.String,
  updatedAt: Schema.String,
});
export type PersonaLibraryIndexEntry = typeof PersonaLibraryIndexEntry.Type;

export const PersonaRevisionSummary = Schema.Struct({
  revisionId: Schema.String,
  personaId: Schema.String,
  contentSha256: Schema.String,
  changeNote: Schema.String,
  createdAt: Schema.String,
});
export type PersonaRevisionSummary = typeof PersonaRevisionSummary.Type;

export const BUILTIN_CHIEF_OF_STAFF_ID = "builtin-chief-of-staff" as const;
