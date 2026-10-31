import {
  DeepSeekConnectionError,
  OPENCODE_API_KEY_ENV,
  ProviderDriverKind,
  type DeepSeekConnectInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ServerSettingsService } from "../serverSettings.ts";

const ModelList = Schema.Struct({ data: Schema.Array(Schema.Struct({ id: Schema.String })) });
const decodeModelList = Schema.decodeUnknownEffect(ModelList);
export type DeepSeekRequest = (url: string, options: RequestInit) => Promise<Response>;

/** Verify credentials with the official model-list endpoint before persisting an account. */
export const verifyDeepSeekApiKey = Effect.fn("verifyDeepSeekApiKey")(function* (
  apiKey: string,
  request: DeepSeekRequest = fetch,
) {
  const response = yield* Effect.tryPromise({
    try: (signal) =>
      request("https://api.deepseek.com/models", {
        headers: { Authorization: `Bearer ${apiKey.trim()}` },
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
      }),
    catch: () =>
      new DeepSeekConnectionError({
        detail: "DeepSeek에 연결하지 못했습니다. 네트워크를 확인하고 다시 시도하세요.",
      }),
  });
  if (!response.ok) {
    return yield* new DeepSeekConnectionError({
      detail:
        response.status === 401 || response.status === 403
          ? "DeepSeek API 키가 유효하지 않거나 사용 권한이 없습니다. API 플랫폼에서 키를 확인하세요."
          : `DeepSeek 연결 확인에 실패했습니다 (HTTP ${response.status}). 잠시 후 다시 시도하세요.`,
    });
  }
  const payload = yield* Effect.tryPromise({
    try: () => response.json(),
    catch: () => new DeepSeekConnectionError({ detail: "DeepSeek 모델 목록을 읽지 못했습니다." }),
  });
  const decoded = yield* decodeModelList(payload).pipe(
    Effect.mapError(
      () => new DeepSeekConnectionError({ detail: "DeepSeek 모델 목록 형식이 올바르지 않습니다." }),
    ),
  );
  const models = [...new Set(decoded.data.map((model) => model.id.trim()).filter(Boolean))];
  if (!models.length)
    return yield* new DeepSeekConnectionError({
      detail: "이 DeepSeek 계정에 사용 가능한 모델이 없습니다.",
    });
  return models;
});

export const connectDeepSeekAccount = Effect.fn("connectDeepSeekAccount")(function* (
  input: DeepSeekConnectInput,
  request: DeepSeekRequest = fetch,
) {
  const models = yield* verifyDeepSeekApiKey(input.apiKey, request);
  const settings = yield* ServerSettingsService;
  // Entry upserts run under the settings service's write semaphore. A slow
  // remote check must not replace accounts added meanwhile by another client.
  yield* settings
    .updateSettings({
      providerInstancesToUpsert: {
        [input.instanceId]: {
          driver: ProviderDriverKind.make("opencode"),
          displayName: input.displayName,
          enabled: true,
          config: {
            apiConnection: {
              providerId: "t3_deepseek",
              baseUrl: "https://api.deepseek.com",
              protocol: "chat-completions",
              models,
              contextTokens: 1_048_576,
              outputTokens: 8192,
            },
          },
          environment: [
            { name: OPENCODE_API_KEY_ENV, value: input.apiKey.trim(), sensitive: true },
          ],
        },
      },
    })
    .pipe(
      Effect.mapError(
        () =>
          new DeepSeekConnectionError({
            detail: "DeepSeek 인증은 확인했지만 계정을 저장하지 못했습니다. 다시 시도하세요.",
          }),
      ),
    );
  return { instanceId: input.instanceId, models };
});
