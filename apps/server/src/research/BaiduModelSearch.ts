import {
  NonNegativeInt,
  OpenCodeApiConnection,
  OPENCODE_API_KEY_ENV,
  type ProviderInstanceConfig,
  type WorkspaceResearchCall,
  type WorkspaceResearchInput,
} from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";

const baseUrl = "https://qianfan.baidubce.com/v2";
const searchUrl = baseUrl + "/ai_search/chat/completions";
const decodeAccount = Schema.decodeUnknownOption(
  Schema.Struct({
    apiConnection: OpenCodeApiConnection,
    enabled: Schema.optionalKey(Schema.Boolean),
  }),
);
const decodeIdentity = Schema.decodeUnknownOption(
  Schema.Struct({
    apiConnection: Schema.Struct({
      providerId: Schema.optionalKey(Schema.Unknown),
      baseUrl: Schema.optionalKey(Schema.Unknown),
    }),
  }),
);
const errorCode = Schema.Union([Schema.String, Schema.Number]);
const decodeEnvelope = Schema.decodeUnknownOption(
  Schema.Struct({
    code: Schema.optionalKey(errorCode),
    error: Schema.optionalKey(Schema.Unknown),
    is_safe: Schema.optionalKey(Schema.Union([Schema.Boolean, Schema.Literals(["true", "false"])])),
  }),
);
const decodeNestedError = Schema.decodeUnknownOption(Schema.Struct({ code: errorCode }));
const decodeResponse = Schema.decodeUnknownOption(
  Schema.Struct({
    request_id: Schema.optionalKey(Schema.String),
    model: Schema.optionalKey(Schema.String),
    choices: Schema.Array(
      Schema.Struct({
        finish_reason: Schema.optionalKey(Schema.NullOr(Schema.String)),
        message: Schema.optionalKey(
          Schema.NullOr(
            Schema.Struct({
              content: Schema.optionalKey(Schema.NullOr(Schema.String)),
              role: Schema.optionalKey(Schema.Literal("assistant")),
            }),
          ),
        ),
      }),
    ),
    references: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.Unknown))),
    usage: Schema.optionalKey(
      Schema.Struct({
        prompt_tokens: Schema.optionalKey(NonNegativeInt),
        completion_tokens: Schema.optionalKey(NonNegativeInt),
      }),
    ),
  }),
);
const decodeReference = Schema.decodeUnknownOption(Schema.Struct({ url: Schema.String }));

export interface BaiduModelSearchInput {
  readonly providerInstances: Readonly<Record<string, ProviderInstanceConfig>>;
  readonly apiInstanceId: string;
  readonly model: string;
  readonly query: string;
  readonly allowedDomains?: WorkspaceResearchInput["allowedDomains"];
  readonly instructions?: string;
}

export type BaiduModelSearchResult = Pick<
  WorkspaceResearchCall,
  "text" | "sources" | "responseId" | "inputTokens" | "outputTokens"
> & {
  readonly citations: NonNullable<WorkspaceResearchCall["citations"]>;
};

type FailureKind =
  | "configuration"
  | "authentication"
  | "request"
  | "quota"
  | "rate_limit"
  | "transport"
  | "upstream"
  | "redirect"
  | "invalid_response"
  | "missing_sources"
  | "insufficient"
  | "policy";

export class BaiduModelSearchError extends Data.TaggedError("BaiduModelSearchError")<{
  readonly code: FailureKind;
  readonly message: string;
  readonly retryable: boolean;
  readonly httpStatus: number | null;
}> {}

const failure = (
  code: FailureKind,
  message: string,
  retryable = false,
  httpStatus: number | null = null,
) => new BaiduModelSearchError({ code, message, retryable, httpStatus });

export function isOfficialQianfanBase(value: string): boolean {
  const url = URL.parse(value);
  return url?.href === baseUrl || url?.href === baseUrl + "/";
}

/** Route registered Qianfan accounts here even when their endpoint has been misconfigured. */
export function isBaiduModelSearchAccount(
  apiInstanceId: string,
  instance: ProviderInstanceConfig | undefined,
): boolean {
  if (apiInstanceId.startsWith("qianfan_")) return true;
  const decoded = decodeIdentity(instance?.config);
  if (Option.isNone(decoded)) return false;
  const connection = decoded.value.apiConnection;
  return (
    connection.providerId === "t3_qianfan" ||
    connection.providerId === "qianfan" ||
    (typeof connection.baseUrl === "string" && isOfficialQianfanBase(connection.baseUrl))
  );
}

function providerFailure(status: number, providerCode: string): BaiduModelSearchError {
  if (status === 401 || status === 403 || providerCode === "216003")
    return failure(
      "authentication",
      "Qianfan API 키와 모델 접근 권한을 확인하세요.",
      false,
      status,
    );
  if (providerCode === "QUOTA_USER_DAILY_FREE" || providerCode === "BILLING_INSUFFICIENT_BALANCE")
    return failure("quota", "Qianfan 검색 할당량 또는 계정 잔액을 확인하세요.", false, status);
  if (status === 429 || providerCode === "RATE_LIMIT_SEARCH_QPS")
    return failure("rate_limit", "Qianfan 검색 요청 빈도 제한에 도달했습니다.", true, status);
  if (status === 408 || status >= 500 || providerCode === "InternalError")
    return failure("upstream", "Qianfan 검색 서비스가 요청을 완료하지 못했습니다.", true, status);
  return failure("request", "Qianfan 검색 요청이 거절됐습니다.", false, status);
}

// Baidu documents the selected-model search, forced search mode, non-streamed result and
// references at https://cloud.baidu.com/doc/qianfan-api/s/jmwbqlawq .
export const runBaiduModelSearch = Effect.fn("runBaiduModelSearch")(function* (
  input: BaiduModelSearchInput,
): Effect.fn.Return<BaiduModelSearchResult, BaiduModelSearchError, HttpClient.HttpClient> {
  const instance = Object.hasOwn(input.providerInstances, input.apiInstanceId)
    ? input.providerInstances[input.apiInstanceId]
    : undefined;
  const decoded = decodeAccount(instance?.config);
  if (
    !instance ||
    instance.driver !== "opencode" ||
    instance.enabled === false ||
    Option.isNone(decoded) ||
    decoded.value.enabled === false
  )
    return yield* failure("configuration", "선택한 Qianfan API 계정을 사용할 수 없습니다.");
  const connection = decoded.value.apiConnection;
  if (!isOfficialQianfanBase(connection.baseUrl) || connection.protocol !== "chat-completions")
    return yield* failure(
      "configuration",
      "공식 Qianfan v2 API 주소와 채팅 연결 방식을 확인하세요.",
    );
  if (!connection.models.includes(input.model))
    return yield* failure("configuration", "이 계정에 등록된 Qianfan 검색 모델을 선택하세요.");
  const credential = instance.environment?.find((entry) => entry.name === OPENCODE_API_KEY_ENV);
  const key = credential?.value.trim();
  if (!key || credential?.valueRedacted || /[\r\n]/u.test(key))
    return yield* failure("configuration", "선택한 계정의 Qianfan API 키를 확인하세요.");
  if (!input.query.trim()) return yield* failure("request", "검색어를 입력하세요.");

  const request = yield* HttpClientRequest.post(searchUrl).pipe(
    HttpClientRequest.bearerToken(key),
    HttpClientRequest.bodyJson({
      model: input.model,
      messages: [{ role: "user", content: input.query }],
      stream: false,
      search_mode: "required",
      search_source: "baidu_search_v2",
      ...(input.instructions ? { instruction: input.instructions } : {}),
      ...(input.allowedDomains?.length
        ? { search_filter: { match: { site: input.allowedDomains } } }
        : {}),
    }),
    Effect.mapError(() => failure("request", "Qianfan 검색 요청을 구성하지 못했습니다.")),
  );
  const http = yield* HttpClient.HttpClient;
  const response = yield* http.execute(request).pipe(
    Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
    Effect.mapError(() => failure("transport", "Qianfan 검색 서비스에 연결하지 못했습니다.", true)),
  );
  const status = response.status;
  if (status >= 300 && status < 400)
    return yield* failure(
      "redirect",
      "Qianfan 검색 엔드포인트가 리디렉션을 반환했습니다.",
      false,
      status,
    );
  const raw = yield* response.json.pipe(
    Effect.mapError(() =>
      status >= 400
        ? providerFailure(status, "")
        : failure("invalid_response", "Qianfan 검색 응답을 읽지 못했습니다.", true, status),
    ),
  );
  const envelope = decodeEnvelope(raw);
  if (Option.isNone(envelope))
    return yield* status >= 400
      ? providerFailure(status, "")
      : failure("invalid_response", "Qianfan 검색 응답 형식이 올바르지 않습니다.", false, status);
  const nested = decodeNestedError(envelope.value.error);
  const code = Option.isSome(nested) ? nested.value.code : envelope.value.code;
  if (
    status < 200 ||
    status >= 300 ||
    envelope.value.error != null ||
    (code != null && String(code) !== "0")
  )
    return yield* providerFailure(status, String(code ?? ""));
  if (envelope.value.is_safe === false || envelope.value.is_safe === "false")
    return yield* failure("policy", "Qianfan이 이 검색을 허용하지 않았습니다.", false, status);
  const parsed = decodeResponse(raw);
  if (Option.isNone(parsed))
    return yield* failure(
      "invalid_response",
      "Qianfan 검색 응답 형식이 올바르지 않습니다.",
      false,
      status,
    );
  const payload = parsed.value;
  const choice = payload.choices[0];
  if (choice?.finish_reason === "content_filter")
    return yield* failure("policy", "Qianfan이 이 검색을 허용하지 않았습니다.", false, status);
  if (
    (payload.model != null && payload.model !== input.model) ||
    (choice?.finish_reason != null &&
      choice.finish_reason !== "stop" &&
      choice.finish_reason !== "length")
  )
    return yield* failure(
      "invalid_response",
      "선택한 모델의 검색 응답을 확인할 수 없습니다.",
      false,
      status,
    );
  const text = choice?.message?.content?.trim();
  if (!text || choice?.finish_reason === "length")
    return yield* failure(
      "insufficient",
      "Qianfan이 완성된 검색 답변을 반환하지 않았습니다.",
      true,
      status,
    );

  const domains = input.allowedDomains?.map((domain) => domain.toLowerCase());
  const sources = new Set<string>();
  for (const rawReference of payload.references ?? []) {
    const reference = decodeReference(rawReference);
    if (Option.isNone(reference)) continue;
    const url = URL.parse(reference.value.url);
    if (!url || !["https:", "http:"].includes(url.protocol) || url.username || url.password)
      continue;
    if (
      domains?.length &&
      !domains.some((domain) => url.hostname === domain || url.hostname.endsWith("." + domain))
    )
      return yield* failure(
        "missing_sources",
        "Qianfan이 요청한 도메인 범위 밖의 출처를 반환했습니다.",
        false,
        status,
      );
    sources.add(url.href);
  }
  if (!sources.size)
    return yield* failure(
      "missing_sources",
      "Qianfan 검색 응답에 확인 가능한 출처 URL이 없습니다.",
      true,
      status,
    );
  const responseId = payload.request_id?.trim() || null;
  if (
    [text, responseId ?? "", ...sources].some(
      (value) => value.includes(key) || value.includes(encodeURIComponent(key)),
    )
  )
    return yield* failure(
      "invalid_response",
      "Qianfan 검색 응답에 인증 정보가 포함되어 반환할 수 없습니다.",
      false,
      status,
    );
  return {
    text,
    sources: [...sources],
    citations: [],
    responseId,
    inputTokens: payload.usage?.prompt_tokens ?? null,
    outputTokens: payload.usage?.completion_tokens ?? null,
  };
});
