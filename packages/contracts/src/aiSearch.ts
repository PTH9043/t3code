import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

export const AiSearchSemanticMode = Schema.Literals(["embedding", "rerank"]);
export type AiSearchSemanticMode = typeof AiSearchSemanticMode.Type;

export const AiSearchModelSourceHint = Schema.Literals([
  "installed",
  "registered",
  "discovered",
  "preset",
]);
export type AiSearchModelSourceHint = typeof AiSearchModelSourceHint.Type;

export const OllamaEmbeddingModelInfo = Schema.Struct({
  name: TrimmedNonEmptyString,
  sizeBytes: Schema.optional(Schema.Number),
  parameterSize: Schema.optional(TrimmedNonEmptyString),
  quantizationLevel: Schema.optional(TrimmedNonEmptyString),
  family: Schema.optional(TrimmedNonEmptyString),
  multilingualRecommended: Schema.Boolean,
  englishOnlyWarning: Schema.optional(TrimmedNonEmptyString),
});
export type OllamaEmbeddingModelInfo = typeof OllamaEmbeddingModelInfo.Type;

export const AiSearchSelectableModel = Schema.Struct({
  name: TrimmedNonEmptyString,
  mode: AiSearchSemanticMode,
  recommended: Schema.Boolean,
  multilingualRecommended: Schema.Boolean,
  sourceHint: AiSearchModelSourceHint,
  sizeBytes: Schema.optional(Schema.Number),
  parameterSize: Schema.optional(TrimmedNonEmptyString),
  quantizationLevel: Schema.optional(TrimmedNonEmptyString),
  family: Schema.optional(TrimmedNonEmptyString),
  englishOnlyWarning: Schema.optional(TrimmedNonEmptyString),
});
export type AiSearchSelectableModel = typeof AiSearchSelectableModel.Type;

export const AiSearchProviderOption = Schema.Struct({
  source: Schema.Literals(["ollama", "provider-instance"]),
  instanceId: Schema.optional(ProviderInstanceId),
  driver: Schema.optional(ProviderDriverKind),
  displayName: TrimmedNonEmptyString,
  baseUrl: Schema.optional(TrimmedNonEmptyString),
  isLocal: Schema.Boolean,
  apiKeyReady: Schema.Boolean,
  supportsEmbeddingsApi: Schema.Boolean,
  supportsRerankApi: Schema.Boolean,
  models: Schema.Array(AiSearchSelectableModel),
  statusMessage: Schema.optional(TrimmedNonEmptyString),
});
export type AiSearchProviderOption = typeof AiSearchProviderOption.Type;

export const AiSearchListEmbeddingModelsInput = Schema.Struct({
  /** Optional local Ollama endpoint override; defaults to persisted `aiSearch.embeddingEndpoint`. */
  endpoint: Schema.optional(TrimmedNonEmptyString),
});
export type AiSearchListEmbeddingModelsInput = typeof AiSearchListEmbeddingModelsInput.Type;

export const AiSearchListEmbeddingModelsResult = Schema.Struct({
  endpoint: TrimmedNonEmptyString,
  reachable: Schema.Boolean,
  models: Schema.Array(OllamaEmbeddingModelInfo),
  providers: Schema.optional(Schema.Array(AiSearchProviderOption)),
  errorMessage: Schema.optional(TrimmedNonEmptyString),
});
export type AiSearchListEmbeddingModelsResult = typeof AiSearchListEmbeddingModelsResult.Type;

export class AiSearchListEmbeddingModelsError extends Schema.TaggedErrorClass<AiSearchListEmbeddingModelsError>()(
  "AiSearchListEmbeddingModelsError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}
