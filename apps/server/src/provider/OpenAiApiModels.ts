import {
  OPENAI_API_CONNECTION,
  OPENAI_API_CREDENTIAL_ENV,
  OpenAiApiListModelsError,
  type OpenAiApiListModelsInput,
  type OpenAiApiListModelsResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { ServerSettingsService } from "../serverSettings.ts";

const EXCLUDED_MODEL_PREFIXES = [
  "text-embedding-",
  "whisper-",
  "tts-",
  "dall-e-",
  "omni-moderation-",
  "text-moderation-",
  "babbage-",
  "davinci-",
  "sora-",
  "gpt-image-",
  "chatgpt-image-",
  "gpt-audio-",
  "gpt-realtime-",
  "gpt-4o-realtime-",
  "gpt-4o-mini-realtime-",
  "gpt-4o-audio-",
  "gpt-4o-mini-audio-",
  "gpt-4o-transcribe",
  "gpt-4o-mini-transcribe",
  "gpt-4o-mini-tts",
] as const;

const PRIORITY_MODEL_PREFIXES = [
  "gpt-5.4",
  "gpt-5.3",
  "gpt-5.2",
  "gpt-5.1",
  "gpt-5",
  "o4",
  "o3",
  "o1",
  "codex",
  "gpt-4.1",
  "gpt-4o",
] as const;

export function filterAndSortOpenAiApiModels(rawIds: ReadonlyArray<string>): ReadonlyArray<string> {
  const unique = [...new Set(rawIds.map((id) => id.trim()).filter(Boolean))];
  const selectable = unique.filter((id) => {
    const lower = id.toLowerCase();
    return !EXCLUDED_MODEL_PREFIXES.some((prefix) => lower.startsWith(prefix));
  });
  const rank = (id: string): number => {
    const lower = id.toLowerCase();
    const index = PRIORITY_MODEL_PREFIXES.findIndex((prefix) => lower.startsWith(prefix));
    return index === -1 ? PRIORITY_MODEL_PREFIXES.length : index;
  };
  return selectable.toSorted((left, right) => {
    const diff = rank(left) - rank(right);
    if (diff !== 0) return diff;
    return left.localeCompare(right);
  });
}

export const listOpenAiApiModels = Effect.fn("listOpenAiApiModels")(function* (
  input: OpenAiApiListModelsInput,
  fetchImpl: typeof fetch = fetch,
): Effect.fn.Return<OpenAiApiListModelsResult, OpenAiApiListModelsError, ServerSettingsService> {
  let apiKey = input.apiKey?.trim() ?? "";
  if (!apiKey && input.instanceId) {
    const settings = yield* (yield* ServerSettingsService).getSettings.pipe(
      Effect.mapError(
        () =>
          new OpenAiApiListModelsError({
            detail: "저장된 OpenAI API 계정 설정을 읽지 못했습니다.",
          }),
      ),
    );
    const instance = settings.providerInstances[input.instanceId];
    const stored = instance?.environment?.find((entry) => entry.name === OPENAI_API_CREDENTIAL_ENV);
    apiKey = stored?.value.trim() ?? "";
  }
  if (!apiKey) {
    return yield* new OpenAiApiListModelsError({
      detail: "모델 목록을 불러오려면 OpenAI API 키를 먼저 입력하거나 저장된 계정을 선택하세요.",
    });
  }

  const maybeResponse = yield* Effect.tryPromise({
    try: (signal) =>
      fetchImpl(`${OPENAI_API_CONNECTION.baseUrl}/models`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
        signal,
      }),
    catch: (cause) =>
      new OpenAiApiListModelsError({
        detail: `OpenAI 모델 목록 요청에 실패했습니다: ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
  }).pipe(Effect.timeoutOption("15 seconds"));

  if (Option.isNone(maybeResponse)) {
    return yield* new OpenAiApiListModelsError({
      detail: "OpenAI 모델 목록 요청 시간이 초과되었습니다. 네트워크 상태를 확인하세요.",
    });
  }
  const response = maybeResponse.value;

  if (response.status === 401 || response.status === 403) {
    return yield* new OpenAiApiListModelsError({
      detail:
        "OpenAI API 키 인증에 실패했습니다(401/403). OpenAI 플랫폼에서 발급한 유효한 API 키인지 확인하세요.",
    });
  }
  if (!response.ok) {
    return yield* new OpenAiApiListModelsError({
      detail: `OpenAI 모델 목록 조회가 HTTP ${response.status} 오류를 반환했습니다.`,
    });
  }

  const payload = yield* Effect.tryPromise({
    try: () => response.json() as Promise<{ data?: ReadonlyArray<{ id?: unknown }> }>,
    catch: () =>
      new OpenAiApiListModelsError({
        detail: "OpenAI 모델 목록 응답을 해석하지 못했습니다.",
      }),
  });

  const ids = Array.isArray(payload?.data)
    ? payload.data
        .map((entry) => (typeof entry?.id === "string" ? entry.id : ""))
        .filter((id) => id.length > 0)
    : [];
  const models = filterAndSortOpenAiApiModels(ids);
  if (models.length === 0) {
    return yield* new OpenAiApiListModelsError({
      detail: "이 OpenAI API 키에서 사용할 수 있는 텍스트 모델이 반환되지 않았습니다.",
    });
  }
  return { models };
});
