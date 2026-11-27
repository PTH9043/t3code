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

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const chatUrl = OPENROUTER_BASE_URL + "/chat/completions";

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
const decodeEnvelope = Schema.decodeUnknownOption(
  Schema.Struct({
    error: Schema.optionalKey(Schema.Unknown),
  }),
);
const decodeNestedError = Schema.decodeUnknownOption(
  Schema.Struct({
    code: Schema.optionalKey(Schema.Union([Schema.String, Schema.Number])),
    message: Schema.optionalKey(Schema.String),
  }),
);
const decodeResponse = Schema.decodeUnknownOption(
  Schema.Struct({
    id: Schema.optionalKey(Schema.String),
    model: Schema.optionalKey(Schema.String),
    choices: Schema.Array(
      Schema.Struct({
        finish_reason: Schema.optionalKey(Schema.NullOr(Schema.String)),
        message: Schema.optionalKey(
          Schema.NullOr(
            Schema.Struct({
              content: Schema.optionalKey(Schema.NullOr(Schema.String)),
              refusal: Schema.optionalKey(Schema.NullOr(Schema.String)),
              annotations: Schema.optionalKey(Schema.Array(Schema.Unknown)),
            }),
          ),
        ),
      }),
    ),
    citations: Schema.optionalKey(Schema.Array(Schema.String)),
    search_results: Schema.optionalKey(Schema.Array(Schema.Struct({ url: Schema.String }))),
    usage: Schema.optionalKey(
      Schema.Struct({
        prompt_tokens: Schema.optionalKey(NonNegativeInt),
        completion_tokens: Schema.optionalKey(NonNegativeInt),
        cost: Schema.optionalKey(Schema.Number),
        prompt_tokens_details: Schema.optionalKey(
          Schema.Struct({ cached_tokens: Schema.optionalKey(NonNegativeInt) }),
        ),
      }),
    ),
  }),
);
const decodeNestedUrlCitation = Schema.decodeUnknownOption(
  Schema.Struct({
    type: Schema.Literal("url_citation"),
    url_citation: Schema.Struct({
      url: Schema.String,
      start_index: Schema.optionalKey(NonNegativeInt),
      end_index: Schema.optionalKey(NonNegativeInt),
    }),
  }),
);
const decodeFlatUrlCitation = Schema.decodeUnknownOption(
  Schema.Struct({
    type: Schema.Literal("url_citation"),
    url: Schema.String,
    start_index: Schema.optionalKey(NonNegativeInt),
    end_index: Schema.optionalKey(NonNegativeInt),
  }),
);

export interface OpenRouterModelSearchInput {
  readonly providerInstances: Readonly<Record<string, ProviderInstanceConfig>>;
  readonly apiInstanceId: string;
  readonly model: string;
  readonly query: string;
  readonly allowedDomains?: WorkspaceResearchInput["allowedDomains"];
  readonly instructions?: string;
}

export type OpenRouterModelSearchResult = Pick<
  WorkspaceResearchCall,
  "text" | "sources" | "responseId" | "inputTokens" | "outputTokens" | "cachedTokens" | "costTicks"
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

export class OpenRouterModelSearchError extends Data.TaggedError("OpenRouterModelSearchError")<{
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
) => new OpenRouterModelSearchError({ code, message, retryable, httpStatus });

export function isOfficialOpenRouterBase(value: string): boolean {
  const url = URL.parse(value);
  return url?.href === OPENROUTER_BASE_URL || url?.href === OPENROUTER_BASE_URL + "/";
}

export function isOpenRouterModelSearchAccount(
  apiInstanceId: string,
  instance: ProviderInstanceConfig | undefined,
): boolean {
  if (apiInstanceId.startsWith("openrouter_")) return true;
  const decoded = decodeIdentity(instance?.config);
  if (Option.isNone(decoded)) return false;
  const connection = decoded.value.apiConnection;
  return (
    connection.providerId === "t3_openrouter" ||
    connection.providerId === "openrouter" ||
    (typeof connection.baseUrl === "string" && isOfficialOpenRouterBase(connection.baseUrl))
  );
}

/** Models that already perform web search without needing OpenRouter's `:online` / `web` plugin. */
export function modelHasNativeWebSearch(model: string): boolean {
  const normalized = model.trim().toLowerCase();
  return (
    normalized.endsWith(":online") ||
    normalized.startsWith("perplexity/sonar") ||
    normalized.includes("-search-preview")
  );
}

function providerFailure(status: number, providerCode: string): OpenRouterModelSearchError {
  if (status === 401 || status === 403)
    return failure(
      "authentication",
      "OpenRouter API 키와 모델 접근 권한을 확인하세요.",
      false,
      status,
    );
  if (status === 402 || providerCode === "402")
    return failure("quota", "OpenRouter 계정 크레딧 잔액이 부족합니다.", false, status);
  if (status === 429)
    return failure("rate_limit", "OpenRouter 검색 요청 빈도 제한에 도달했습니다.", true, status);
  if (status === 408 || status >= 500)
    return failure(
      "upstream",
      "OpenRouter 검색 서비스가 요청을 완료하지 못했습니다.",
      true,
      status,
    );
  return failure("request", "OpenRouter 검색 요청이 거절됐습니다.", false, status);
}

export const runOpenRouterModelSearch = Effect.fn("runOpenRouterModelSearch")(function* (
  input: OpenRouterModelSearchInput,
): Effect.fn.Return<
  OpenRouterModelSearchResult,
  OpenRouterModelSearchError,
  HttpClient.HttpClient
> {
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
    return yield* failure("configuration", "선택한 OpenRouter API 계정을 사용할 수 없습니다.");
  const connection = decoded.value.apiConnection;
  if (!isOfficialOpenRouterBase(connection.baseUrl) || connection.protocol !== "chat-completions")
    return yield* failure(
      "configuration",
      "공식 OpenRouter API 주소(https://openrouter.ai/api/v1)와 채팅 연결 방식을 확인하세요.",
    );
  const model = input.model.trim();
  if (!model) return yield* failure("configuration", "OpenRouter 검색 모델 ID를 입력하세요.");
  const credential = instance.environment?.find((entry) => entry.name === OPENCODE_API_KEY_ENV);
  const key = credential?.value.trim();
  if (!key || credential?.valueRedacted || /[\r\n]/u.test(key))
    return yield* failure("configuration", "선택한 계정의 OpenRouter API 키를 확인하세요.");
  if (!input.query.trim()) return yield* failure("request", "검색어를 입력하세요.");

  const domainHint = input.allowedDomains?.length
    ? `\n허용된 도메인(${input.allowedDomains.join(", ")})의 출처만 우선 인용하세요.`
    : "";
  const systemText = (input.instructions ?? "").trim() + domainHint;
  const messages = [
    ...(systemText ? [{ role: "system", content: systemText }] : []),
    { role: "user", content: input.query },
  ];
  const needsWebPlugin = !modelHasNativeWebSearch(model);

  const request = yield* HttpClientRequest.post(chatUrl).pipe(
    HttpClientRequest.bearerToken(key),
    HttpClientRequest.setHeader("X-Title", "T3 Code"),
    HttpClientRequest.bodyJson({
      model,
      messages,
      stream: false,
      ...(needsWebPlugin ? { plugins: [{ id: "web", max_results: 5 }] } : {}),
    }),
    Effect.mapError(() => failure("request", "OpenRouter 검색 요청을 구성하지 못했습니다.")),
  );
  const http = yield* HttpClient.HttpClient;
  const response = yield* http.execute(request).pipe(
    Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
    Effect.mapError(() => failure("transport", "OpenRouter 서비스에 연결하지 못했습니다.", true)),
  );
  const status = response.status;
  if (status >= 300 && status < 400)
    return yield* failure(
      "redirect",
      "OpenRouter 검색 엔드포인트가 리디렉션을 반환했습니다.",
      false,
      status,
    );
  const raw = yield* response.json.pipe(
    Effect.mapError(() =>
      status >= 400
        ? providerFailure(status, "")
        : failure("invalid_response", "OpenRouter 검색 응답을 읽지 못했습니다.", true, status),
    ),
  );
  const envelope = decodeEnvelope(raw);
  if (Option.isNone(envelope))
    return yield* status >= 400
      ? providerFailure(status, "")
      : failure(
          "invalid_response",
          "OpenRouter 검색 응답 형식이 올바르지 않습니다.",
          false,
          status,
        );
  const nested = decodeNestedError(envelope.value.error);
  const code = Option.isSome(nested) ? nested.value.code : undefined;
  if (status < 200 || status >= 300 || envelope.value.error != null)
    return yield* providerFailure(status, String(code ?? ""));

  const parsed = decodeResponse(raw);
  if (Option.isNone(parsed))
    return yield* failure(
      "invalid_response",
      "OpenRouter 검색 응답 형식이 올바르지 않습니다.",
      false,
      status,
    );
  const payload = parsed.value;
  const choice = payload.choices[0];
  if (choice?.finish_reason === "content_filter" || Boolean(choice?.message?.refusal))
    return yield* failure(
      "policy",
      "OpenRouter 모델이 이 검색을 허용하지 않았습니다.",
      false,
      status,
    );
  if (
    choice?.finish_reason != null &&
    choice.finish_reason !== "stop" &&
    choice.finish_reason !== "length"
  )
    return yield* failure(
      "invalid_response",
      "OpenRouter 검색 응답이 정상 종료되지 않았습니다.",
      false,
      status,
    );
  const text = choice?.message?.content?.trim();
  if (!text || choice?.finish_reason === "length")
    return yield* failure(
      "insufficient",
      "OpenRouter가 완성된 검색 답변을 반환하지 않았습니다.",
      true,
      status,
    );

  const domains = input.allowedDomains?.map((domain) => domain.toLowerCase());
  const sources = new Set<string>();
  const citations: Array<{ start: number; end: number; url: string }> = [];

  const registerUrl = (rawUrl: string, start?: number, end?: number) => {
    const url = URL.parse(rawUrl);
    if (!url || !["https:", "http:"].includes(url.protocol) || url.username || url.password)
      return true;
    if (
      domains?.length &&
      !domains.some((domain) => url.hostname === domain || url.hostname.endsWith("." + domain))
    )
      return false;
    sources.add(url.href);
    if (start !== undefined && end !== undefined && start < end && end <= text.length)
      citations.push({ start, end, url: url.href });
    return true;
  };

  for (const rawUrl of [
    ...(payload.citations ?? []),
    ...(payload.search_results?.map((item) => item.url) ?? []),
  ]) {
    if (!registerUrl(rawUrl))
      return yield* failure(
        "missing_sources",
        "OpenRouter가 요청한 도메인 범위 밖의 출처를 반환했습니다.",
        false,
        status,
      );
  }
  for (const rawAnnotation of choice?.message?.annotations ?? []) {
    const flat = decodeFlatUrlCitation(rawAnnotation);
    const nestedAnn = decodeNestedUrlCitation(rawAnnotation);
    const entry = Option.isSome(flat)
      ? flat.value
      : Option.isSome(nestedAnn)
        ? nestedAnn.value.url_citation
        : undefined;
    if (!entry) continue;
    if (!registerUrl(entry.url, entry.start_index, entry.end_index))
      return yield* failure(
        "missing_sources",
        "OpenRouter가 요청한 도메인 범위 밖의 출처를 반환했습니다.",
        false,
        status,
      );
  }
  if (!sources.size)
    return yield* failure(
      "missing_sources",
      "OpenRouter 검색 응답에 확인 가능한 출처 URL이 없습니다.",
      true,
      status,
    );

  const responseId = payload.id?.trim() || null;
  if (
    [text, responseId ?? "", ...sources].some(
      (value) => value.includes(key) || value.includes(encodeURIComponent(key)),
    )
  )
    return yield* failure(
      "invalid_response",
      "OpenRouter 검색 응답에 인증 정보가 포함되어 반환할 수 없습니다.",
      false,
      status,
    );

  const rawCost = payload.usage?.cost;
  const costTicks =
    typeof rawCost === "number" && Number.isFinite(rawCost) && rawCost >= 0
      ? Math.round(rawCost * 1e10)
      : null;

  return {
    text,
    sources: [...sources],
    citations: citations.slice(0, 100),
    responseId,
    costTicks,
    inputTokens: payload.usage?.prompt_tokens ?? null,
    outputTokens: payload.usage?.completion_tokens ?? null,
    cachedTokens: payload.usage?.prompt_tokens_details?.cached_tokens ?? null,
  };
});
