import {
  AntseedConnectionError,
  OPENCODE_API_KEY_ENV,
  ProviderDriverKind,
  type AntseedConnectInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ServerSettingsService } from "../serverSettings.ts";

const ModelList = Schema.Struct({ data: Schema.Array(Schema.Struct({ id: Schema.String })) });
const decodeModelList = Schema.decodeUnknownEffect(ModelList);
export type AntseedRequest = (url: string, options: RequestInit) => Promise<Response>;

const toListUrl = (baseUrl: string): string => `${baseUrl.trim().replace(/\/+$/, "")}/v1/models`;

/**
 * Probe the gateway's model list before persisting an account so a bad key or
 * unreachable gateway never leaves a half-configured provider instance.
 */
export const verifyAntseedApiKey = Effect.fn("verifyAntseedApiKey")(function* (
  baseUrl: string,
  apiKey: string,
  request: AntseedRequest = fetch,
) {
  const response = yield* Effect.tryPromise({
    try: (signal) =>
      request(toListUrl(baseUrl), {
        headers: { Authorization: `Bearer ${apiKey.trim()}` },
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
      }),
    catch: () =>
      new AntseedConnectionError({
        detail: "Antseed 게이트웨이에 연결하지 못했습니다. 게이트웨이가 실행 중인지 확인하세요.",
      }),
  });
  if (!response.ok) {
    return yield* new AntseedConnectionError({
      detail:
        response.status === 401 || response.status === 403
          ? "Antseed API 키가 유효하지 않거나 사용 권한이 없습니다. 게이트웨이에서 키를 확인하세요."
          : `Antseed 연결 확인에 실패했습니다 (HTTP ${response.status}). 잠시 후 다시 시도하세요.`,
    });
  }
  const payload = yield* Effect.tryPromise({
    try: () => response.json(),
    catch: () => new AntseedConnectionError({ detail: "Antseed 모델 목록을 읽지 못했습니다." }),
  });
  const decoded = yield* decodeModelList(payload).pipe(
    Effect.mapError(
      () => new AntseedConnectionError({ detail: "Antseed 모델 목록 형식이 올바르지 않습니다." }),
    ),
  );
  const models = [...new Set(decoded.data.map((model) => model.id.trim()).filter(Boolean))];
  if (!models.length)
    return yield* new AntseedConnectionError({
      detail: "이 Antseed 게이트웨이에 사용 가능한 모델이 없습니다.",
    });
  return models;
});

export const connectAntseedAccount = Effect.fn("connectAntseedAccount")(function* (
  input: AntseedConnectInput,
  request: AntseedRequest = fetch,
) {
  const models = yield* verifyAntseedApiKey(input.baseUrl, input.apiKey, request);
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
              providerId: "t3_antseed",
              baseUrl: input.baseUrl.trim(),
              protocol: "chat-completions",
              models,
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
          new AntseedConnectionError({
            detail: "인증은 확인됐지만 계정을 저장하지 못했습니다. 다시 시도하세요.",
          }),
      ),
    );
  return { instanceId: input.instanceId, models };
});
