import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfig,
} from "./providerInstance.ts";
import { OpenCodeSettings } from "./settings.ts";

export const OPENAI_API_CONNECTION = {
  providerId: "t3_openai",
  baseUrl: "https://api.openai.com/v1",
  protocol: "responses",
} as const;
export const OPENAI_API_CREDENTIAL_ENV = "T3_OPENAI_API_KEY";

export const OPENAI_API_RECOMMENDED_MODELS = [
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5",
  "gpt-5-mini",
  "o3",
  "o4-mini",
  "gpt-4.1",
  "gpt-4o",
] as const;

const OPENAI_MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function isValidOpenAiApiModelId(model: string): boolean {
  const trimmed = model.trim();
  return trimmed.length > 0 && OPENAI_MODEL_ID_PATTERN.test(trimmed);
}

export const OpenAiApiListModelsInput = Schema.Struct({
  instanceId: Schema.optionalKey(ProviderInstanceId),
  apiKey: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(4096))),
});
export type OpenAiApiListModelsInput = typeof OpenAiApiListModelsInput.Type;

export const OpenAiApiListModelsResult = Schema.Struct({
  models: Schema.Array(Schema.String),
});
export type OpenAiApiListModelsResult = typeof OpenAiApiListModelsResult.Type;

export class OpenAiApiListModelsError extends Schema.TaggedErrorClass<OpenAiApiListModelsError>()(
  "OpenAiApiListModelsError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

const decodeSettings = Schema.decodeUnknownSync(OpenCodeSettings);

export function configureOpenAiApiAccount(input: {
  readonly displayName: string;
  readonly models: readonly string[];
  readonly apiKey: string;
  readonly existing?: ProviderInstanceConfig;
}): ProviderInstanceConfig {
  const displayName = input.displayName.trim();
  const models = [...new Set(input.models.map((model) => model.trim()).filter(Boolean))];
  const key = input.apiKey.trim();
  const existing = input.existing;
  const settings = decodeSettings(existing?.config ?? {});
  if (
    existing &&
    (existing.driver !== "opencode" ||
      settings.apiConnection?.providerId !== OPENAI_API_CONNECTION.providerId)
  )
    throw new Error("OpenAI API 계정을 선택하세요.");
  if (!displayName || models.length === 0) throw new Error("계정 이름과 API 모델 ID를 입력하세요.");
  const invalidModel = models.find((model) => !isValidOpenAiApiModelId(model));
  if (invalidModel) {
    throw new Error(
      `유효한 OpenAI API 모델 ID가 아닙니다("${invalidModel}"). 계정 이름이 아니라 공백과 슬래시(/)가 없는 실제 모델 ID(예: gpt-5.4, gpt-5-mini, o3)를 입력하세요.`,
    );
  }
  const environment = [...(existing?.environment ?? [])];
  const index = environment.findIndex((entry) => entry.name === OPENAI_API_CREDENTIAL_ENV);
  if (key) {
    const credential = { name: OPENAI_API_CREDENTIAL_ENV, value: key, sensitive: true };
    if (index === -1) environment.push(credential);
    else environment[index] = credential;
  } else if (index === -1 || !(environment[index]?.valueRedacted || environment[index]?.value)) {
    throw new Error("OpenAI API 키를 입력하세요.");
  }
  return {
    ...existing,
    driver: ProviderDriverKind.make("opencode"),
    enabled: existing?.enabled ?? true,
    displayName,
    config: {
      ...(existing?.config && typeof existing.config === "object" ? existing.config : {}),
      apiConnection: { ...settings.apiConnection, ...OPENAI_API_CONNECTION, models },
    },
    environment,
  };
}
