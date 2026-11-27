// @effect-diagnostics nodeBuiltinImport:off globalDate:off
import * as NodeCrypto from "node:crypto";
import {
  CLAUDE_API_KEY_ENV,
  LOCAL_OLLAMA_INSTANCE,
  OPENAI_API_CONNECTION,
  OPENAI_API_CREDENTIAL_ENV,
  OPENCODE_API_KEY_ENV,
  OpenCodeApiConnection,
  ProviderDriverKind,
  ProviderInstanceId,
  type AiSearchProviderOption,
  type AiSearchSelectableModel,
  type ProviderInstanceConfig,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { antseedApiBaseUrl } from "../provider/antseedApiUrl.ts";
import { LOCAL_OLLAMA_PROVIDER } from "../provider/localOllama.ts";
import {
  boundedEmbeddingText,
  getEmbeddingModelMultilingualAdvisory,
  type SemanticEmbeddingInput,
} from "./semanticSearch.ts";

const ANTHROPIC_API_BASE_URL = "https://api.anthropic.com/v1";
const ANTHROPIC_API_VERSION = "2023-06-01";
const EMBEDDING_MODEL_NAME_PATTERN =
  /(?:embed|bge(?:-|$)|e5-|gte-|minilm|arctic-embed|jina-embed|voyage-|paraphrase-multilingual)/iu;
const MULTILINGUAL_RECOMMENDED_PATTERN =
  /(?:bge-m3|nomic-embed-text-v2|text-embedding-3|embedding-3|embedding-v1|multilingual|ko[-_]|korean|qwen\d*(?:\.\d+)?-embedding|jina-embeddings-v3|embeddinggemma)/iu;

const decodeOpenCodeApiWrapper = Schema.decodeUnknownOption(
  Schema.Struct({ apiConnection: OpenCodeApiConnection }),
);
const decodeClaudeApiWrapper = Schema.decodeUnknownOption(
  Schema.Struct({
    authMode: Schema.optionalKey(Schema.String),
    customModels: Schema.optionalKey(Schema.Array(Schema.String)),
  }),
);
const OpenAiModelsListResponse = Schema.Struct({
  data: Schema.optional(Schema.Array(Schema.Struct({ id: Schema.String }))),
});
const OpenAiEmbeddingsResponse = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      index: Schema.optional(Schema.Number),
      embedding: Schema.Array(Schema.Number.check(Schema.isFinite())).check(
        Schema.isMinLength(1),
        Schema.isMaxLength(4096),
      ),
    }),
  ),
});
const OpenAiChatCompletionResponse = Schema.Struct({
  choices: Schema.optional(
    Schema.Array(
      Schema.Struct({
        message: Schema.optional(
          Schema.Struct({
            content: Schema.optional(Schema.NullOr(Schema.String)),
          }),
        ),
      }),
    ),
  ),
});
const OpenAiResponsesApiResponse = Schema.Struct({
  output_text: Schema.optional(Schema.String),
  output: Schema.optional(
    Schema.Array(
      Schema.Struct({
        content: Schema.optional(
          Schema.Array(
            Schema.Struct({
              text: Schema.optional(Schema.String),
            }),
          ),
        ),
      }),
    ),
  ),
});
const AnthropicMessagesResponse = Schema.Struct({
  content: Schema.optional(
    Schema.Array(
      Schema.Struct({
        type: Schema.optional(Schema.String),
        text: Schema.optional(Schema.String),
      }),
    ),
  ),
});
const OllamaChatResponse = Schema.Struct({
  message: Schema.optional(
    Schema.Struct({
      content: Schema.optional(Schema.String),
    }),
  ),
});
const RerankScoreItem = Schema.Struct({
  id: Schema.Union([Schema.Number, Schema.String]),
  score: Schema.Number.check(Schema.isFinite()),
});
const RerankScoresPayload = Schema.Struct({
  scores: Schema.Array(RerankScoreItem),
});
const decodeRerankScoresJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(RerankScoresPayload),
);

export type RegisteredSemanticProtocol = "openai-responses" | "openai-chat" | "anthropic-messages";

export interface ResolvedRegisteredSemanticProvider {
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly displayName: string;
  readonly baseUrl: string;
  readonly apiBaseUrl: string;
  readonly protocol: RegisteredSemanticProtocol;
  readonly providerTag: string;
  readonly isLocal: boolean;
  readonly apiKey: string | null;
  readonly apiKeyReady: boolean;
  readonly supportsEmbeddingsApi: boolean;
  readonly supportsRerankApi: boolean;
  readonly registeredModels: readonly string[];
}

export function isLoopbackHttpUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl.trim());
    if (!["http:", "https:"].includes(parsed.protocol)) return false;
    const host = parsed.hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1");
    return host === "127.0.0.1" || host === "localhost" || host === "::1";
  } catch {
    return false;
  }
}

function sanitizeHttpBaseUrl(rawUrl: string): string | null {
  try {
    const parsed = new URL(rawUrl.trim());
    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    ) {
      return null;
    }
    return parsed.toString().replace(/\/+$/u, "");
  } catch {
    return null;
  }
}

function resolveApiBaseUrl(providerId: string, baseUrl: string): string | null {
  if (providerId === "t3_antseed") {
    try {
      return antseedApiBaseUrl(baseUrl);
    } catch {
      return null;
    }
  }
  return sanitizeHttpBaseUrl(baseUrl);
}

function classifyProviderEmbeddingsSupport(
  providerId: string,
  apiBaseUrl: string,
  isLocal: boolean,
): boolean {
  const lowerBase = apiBaseUrl.toLowerCase();
  if (
    providerId === "t3_deepseek" ||
    providerId === "deepseek" ||
    lowerBase.includes("api.deepseek.com")
  ) {
    return false;
  }
  if (
    providerId === "t3_exaone" ||
    providerId === "exaone" ||
    lowerBase.includes("api.exaone.ai")
  ) {
    return false;
  }
  if (
    providerId === OPENAI_API_CONNECTION.providerId ||
    providerId === "t3_openrouter" ||
    providerId === "openrouter" ||
    providerId === "t3_qianfan" ||
    providerId === "qianfan" ||
    providerId === "t3_glm" ||
    providerId === "glm" ||
    isLocal
  ) {
    return true;
  }
  // Generic OpenAI-compatible endpoints may expose `/embeddings`.
  return true;
}

function presetEmbeddingModelsForProvider(
  providerId: string,
  apiBaseUrl: string,
): ReadonlyArray<{ readonly name: string; readonly recommended: boolean }> {
  const lowerBase = apiBaseUrl.toLowerCase();
  if (providerId === OPENAI_API_CONNECTION.providerId || lowerBase.includes("api.openai.com")) {
    return [
      { name: "text-embedding-3-small", recommended: true },
      { name: "text-embedding-3-large", recommended: true },
    ];
  }
  if (providerId === "t3_openrouter" || lowerBase.includes("openrouter.ai")) {
    return [
      { name: "openai/text-embedding-3-small", recommended: true },
      { name: "qwen/qwen3-embedding-8b", recommended: true },
      { name: "baai/bge-m3", recommended: true },
    ];
  }
  if (providerId === "t3_qianfan" || lowerBase.includes("qianfan.baidubce.com")) {
    return [
      { name: "bge-large-zh", recommended: true },
      { name: "embedding-v1", recommended: false },
    ];
  }
  if (providerId === "t3_glm" || lowerBase.includes("open.bigmodel.cn")) {
    return [{ name: "embedding-3", recommended: true }];
  }
  return [];
}

const CLAUDE_API_DEFAULT_RERANK_MODELS = [
  { name: "claude-haiku-4-5", recommended: true },
  { name: "claude-sonnet-4-5", recommended: false },
] as const;

export function resolveRegisteredSemanticProvider(
  instanceIdRaw: string,
  instance: ProviderInstanceConfig | undefined,
): ResolvedRegisteredSemanticProvider | null {
  if (!instance || instance.enabled === false) return null;
  const instanceId = ProviderInstanceId.make(instanceIdRaw);
  if (instanceId === LOCAL_OLLAMA_INSTANCE) return null;

  if (instance.driver === "opencode") {
    const decoded = decodeOpenCodeApiWrapper(instance.config);
    if (Option.isNone(decoded)) return null;
    const connection = decoded.value.apiConnection;
    if (connection.providerId === LOCAL_OLLAMA_PROVIDER) return null;
    const apiBaseUrl = resolveApiBaseUrl(connection.providerId, connection.baseUrl);
    if (!apiBaseUrl) return null;
    const isLocal = isLoopbackHttpUrl(apiBaseUrl);
    const isOfficialOpenAi = connection.providerId === OPENAI_API_CONNECTION.providerId;
    const keyEnvName = isOfficialOpenAi ? OPENAI_API_CREDENTIAL_ENV : OPENCODE_API_KEY_ENV;
    const keyEntry = instance.environment?.find((entry) => entry.name === keyEnvName);
    const apiKey = keyEntry?.value.trim() || null;
    const apiKeyReady = Boolean(apiKey || keyEntry?.valueRedacted || isLocal);
    return {
      instanceId,
      driver: instance.driver,
      displayName: instance.displayName?.trim() || instanceId,
      baseUrl: connection.baseUrl,
      apiBaseUrl,
      protocol: connection.protocol === "responses" ? "openai-responses" : "openai-chat",
      providerTag: connection.providerId,
      isLocal,
      apiKey,
      apiKeyReady,
      supportsEmbeddingsApi: classifyProviderEmbeddingsSupport(
        connection.providerId,
        apiBaseUrl,
        isLocal,
      ),
      supportsRerankApi: true,
      registeredModels: [...new Set(connection.models.map((m) => m.trim()).filter(Boolean))],
    };
  }

  if (instance.driver === "claudeAgent") {
    const decoded = decodeClaudeApiWrapper(instance.config);
    if (Option.isNone(decoded) || decoded.value.authMode !== "api-key") return null;
    const keyEntry = instance.environment?.find((entry) => entry.name === CLAUDE_API_KEY_ENV);
    const apiKey = keyEntry?.value.trim() || null;
    const apiKeyReady = Boolean(apiKey || keyEntry?.valueRedacted);
    const customModels = (decoded.value.customModels ?? []).map((m) => m.trim()).filter(Boolean);
    return {
      instanceId,
      driver: instance.driver,
      displayName: instance.displayName?.trim() || "Claude API",
      baseUrl: ANTHROPIC_API_BASE_URL,
      apiBaseUrl: ANTHROPIC_API_BASE_URL,
      protocol: "anthropic-messages",
      providerTag: "claude-api",
      isLocal: false,
      apiKey,
      apiKeyReady,
      supportsEmbeddingsApi: false,
      supportsRerankApi: true,
      registeredModels: [...new Set(customModels)],
    };
  }

  return null;
}

export function listResolvedRegisteredSemanticProviders(
  settings: ServerSettings | null | undefined,
): ReadonlyArray<ResolvedRegisteredSemanticProvider> {
  if (!settings?.providerInstances) return [];
  const resolved: ResolvedRegisteredSemanticProvider[] = [];
  for (const [instanceId, instance] of Object.entries(settings.providerInstances)) {
    const provider = resolveRegisteredSemanticProvider(instanceId, instance);
    if (provider) resolved.push(provider);
  }
  return resolved.toSorted(
    (left, right) =>
      Number(right.supportsEmbeddingsApi) - Number(left.supportsEmbeddingsApi) ||
      Number(right.isLocal) - Number(left.isLocal) ||
      left.displayName.localeCompare(right.displayName),
  );
}

function makeSelectableModel(input: {
  readonly name: string;
  readonly mode: "embedding" | "rerank";
  readonly recommended: boolean;
  readonly sourceHint: AiSearchSelectableModel["sourceHint"];
}): AiSearchSelectableModel {
  const englishOnlyWarning =
    input.mode === "embedding"
      ? (getEmbeddingModelMultilingualAdvisory(input.name) ?? undefined)
      : undefined;
  const multilingualRecommended =
    input.mode === "embedding" &&
    englishOnlyWarning === undefined &&
    MULTILINGUAL_RECOMMENDED_PATTERN.test(input.name);
  return {
    name: input.name,
    mode: input.mode,
    recommended: input.recommended || multilingualRecommended,
    multilingualRecommended,
    sourceHint: input.sourceHint,
    ...(englishOnlyWarning ? { englishOnlyWarning } : {}),
  };
}

const discoverProviderEmbeddingModels = Effect.fn("discoverProviderEmbeddingModels")(function* (
  http: HttpClient.HttpClient,
  provider: ResolvedRegisteredSemanticProvider,
): Effect.fn.Return<ReadonlyArray<string>> {
  if (
    !provider.supportsEmbeddingsApi ||
    provider.providerTag !== OPENAI_API_CONNECTION.providerId ||
    !provider.apiKey
  ) {
    return [];
  }
  const response = yield* HttpClientRequest.get(`${provider.apiBaseUrl}/models`).pipe(
    HttpClientRequest.setHeader("Authorization", `Bearer ${provider.apiKey}`),
    http.execute,
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap(HttpClientResponse.schemaBodyJson(OpenAiModelsListResponse)),
    Effect.timeout("2500 millis"),
    Effect.result,
  );
  if (response._tag === "Failure") return [];
  return [...new Set((response.success.data ?? []).map((entry) => entry.id.trim()))]
    .filter((id) => id.length > 0 && /^text-embedding-/iu.test(id))
    .toSorted();
});

export const buildRegisteredProviderOption = Effect.fn("buildRegisteredProviderOption")(function* (
  http: HttpClient.HttpClient,
  provider: ResolvedRegisteredSemanticProvider,
): Effect.fn.Return<AiSearchProviderOption> {
  const seen = new Map<string, AiSearchSelectableModel>();
  const addModel = (model: AiSearchSelectableModel) => {
    const key = `${model.mode}:${model.name}`;
    if (!seen.has(key)) seen.set(key, model);
  };

  if (provider.supportsEmbeddingsApi) {
    for (const preset of presetEmbeddingModelsForProvider(
      provider.providerTag,
      provider.apiBaseUrl,
    )) {
      addModel(
        makeSelectableModel({
          name: preset.name,
          mode: "embedding",
          recommended: preset.recommended,
          sourceHint: "preset",
        }),
      );
    }
    const discovered = yield* discoverProviderEmbeddingModels(http, provider);
    for (const name of discovered) {
      addModel(
        makeSelectableModel({
          name,
          mode: "embedding",
          recommended: /text-embedding-3/iu.test(name),
          sourceHint: "discovered",
        }),
      );
    }
  }

  for (const modelName of provider.registeredModels) {
    const looksLikeEmbedding =
      provider.supportsEmbeddingsApi && EMBEDDING_MODEL_NAME_PATTERN.test(modelName);
    addModel(
      makeSelectableModel({
        name: modelName,
        mode: looksLikeEmbedding ? "embedding" : "rerank",
        recommended: looksLikeEmbedding
          ? MULTILINGUAL_RECOMMENDED_PATTERN.test(modelName)
          : /mini|flash|haiku|4b|small/iu.test(modelName),
        sourceHint: "registered",
      }),
    );
  }

  if (provider.protocol === "anthropic-messages") {
    for (const preset of CLAUDE_API_DEFAULT_RERANK_MODELS) {
      addModel(
        makeSelectableModel({
          name: preset.name,
          mode: "rerank",
          recommended: preset.recommended,
          sourceHint: "preset",
        }),
      );
    }
  }

  const models = [...seen.values()].toSorted(
    (left, right) =>
      Number(left.mode === "rerank") - Number(right.mode === "rerank") ||
      Number(right.recommended) - Number(left.recommended) ||
      left.name.localeCompare(right.name),
  );

  const statusMessage = !provider.apiKeyReady
    ? `${provider.displayName} 계정에 저장된 API 키가 없습니다. 제공자 설정에서 API 키를 먼저 저장하세요.`
    : undefined;

  return {
    source: "provider-instance",
    instanceId: provider.instanceId,
    driver: provider.driver,
    displayName: provider.displayName,
    baseUrl: provider.apiBaseUrl,
    isLocal: provider.isLocal,
    apiKeyReady: provider.apiKeyReady,
    supportsEmbeddingsApi: provider.supportsEmbeddingsApi,
    supportsRerankApi: provider.supportsRerankApi,
    models,
    ...(statusMessage ? { statusMessage } : {}),
  };
});

export const RegisteredSemanticFailureReason = Schema.Literals([
  "provider-missing",
  "auth",
  "model-missing",
  "rate-limit",
  "connection",
  "timeout",
  "response",
  "request",
]);

export class RegisteredSemanticError extends Schema.TaggedErrorClass<RegisteredSemanticError>()(
  "RegisteredSemanticError",
  {
    providerLabel: Schema.String,
    model: Schema.String,
    reason: RegisteredSemanticFailureReason,
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "provider-missing":
        return `선택한 의미 검색 계정('${this.providerLabel}')이 비활성화되었거나 찾을 수 없습니다. 키워드 검색을 유지합니다.`;
      case "auth":
        return `${this.providerLabel} API 키 인증에 실패했습니다. 제공자 설정의 API 키를 확인하세요. 키워드 검색을 유지합니다.`;
      case "model-missing":
        return `${this.providerLabel}에서 모델 '${this.model}'을(를) 찾을 수 없거나 임베딩 엔드포인트를 지원하지 않습니다. 키워드 검색을 유지합니다.`;
      case "rate-limit":
        return `${this.providerLabel} 요청 한도에 도달했습니다. 잠시 후 다시 시도되며 키워드 검색을 유지합니다.`;
      case "connection":
        return `${this.providerLabel}에 연결할 수 없습니다. 주소와 네트워크 상태를 확인하세요. 키워드 검색을 유지합니다.`;
      case "timeout":
        return `${this.providerLabel} 의미 검색 대기 시간이 초과되었습니다. 키워드 검색을 유지합니다.`;
      case "response":
        return `${this.providerLabel}가 올바른 의미 검색 응답을 반환하지 않았습니다. 모델 설정을 확인하세요. 키워드 검색을 유지합니다.`;
      case "request":
        return `${this.providerLabel} 의미 검색 요청이 실패했습니다. 모델과 계정 상태를 확인하세요. 키워드 검색을 유지합니다.`;
    }
  }
}

export const isRegisteredSemanticError = Schema.is(RegisteredSemanticError);

function mapHttpFailureReason(cause: unknown): typeof RegisteredSemanticFailureReason.Type {
  if (typeof cause === "object" && cause !== null && "_tag" in cause) {
    if (cause._tag === "TimeoutError") return "timeout";
    if (cause._tag === "SchemaError") return "response";
  }
  if (HttpClientError.isHttpClientError(cause)) {
    const status = cause.response?.status;
    if (status === 401 || status === 403) return "auth";
    if (status === 404) return "model-missing";
    if (status === 429) return "rate-limit";
    if (cause.reason._tag === "TransportError") return "connection";
    if (cause.reason._tag === "DecodeError" || cause.reason._tag === "EmptyBodyError") {
      return "response";
    }
  }
  return "request";
}

export const embedWithRegisteredProvider = Effect.fn("embedWithRegisteredProvider")(
  function* (input: {
    readonly http: HttpClient.HttpClient;
    readonly provider: ResolvedRegisteredSemanticProvider;
    readonly model: string;
    readonly texts: readonly string[];
    readonly purpose: SemanticEmbeddingInput["purpose"];
  }): Effect.fn.Return<readonly (readonly number[])[], RegisteredSemanticError> {
    const { http, provider, model, texts, purpose } = input;
    if (!provider.supportsEmbeddingsApi) {
      return yield* new RegisteredSemanticError({
        providerLabel: provider.displayName,
        model,
        reason: "model-missing",
      });
    }
    if (!provider.apiKey && !provider.isLocal) {
      return yield* new RegisteredSemanticError({
        providerLabel: provider.displayName,
        model,
        reason: "auth",
      });
    }

    let request = HttpClientRequest.post(`${provider.apiBaseUrl}/embeddings`).pipe(
      HttpClientRequest.setHeader("Content-Type", "application/json"),
    );
    if (provider.apiKey) {
      request = HttpClientRequest.setHeader(request, "Authorization", `Bearer ${provider.apiKey}`);
    }

    return yield* request.pipe(
      HttpClientRequest.bodyJson({
        model,
        input: texts,
      }),
      Effect.flatMap(http.execute),
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(OpenAiEmbeddingsResponse)),
      Effect.map((payload) =>
        [...payload.data]
          .toSorted((left, right) => (left.index ?? 0) - (right.index ?? 0))
          .map((entry) => entry.embedding),
      ),
      Effect.timeout(purpose === "index" ? "30 seconds" : "3500 millis"),
      Effect.mapError((cause) => {
        if (isRegisteredSemanticError(cause)) return cause;
        return new RegisteredSemanticError({
          providerLabel: provider.displayName,
          model,
          reason: mapHttpFailureReason(cause),
        });
      }),
    );
  },
);

const RERANK_SYSTEM_PROMPT =
  'You are a semantic relevance scorer for document search. Given a user query and numbered document chunks, return ONLY valid JSON in the exact format {"scores":[{"id":1,"score":0.85}]}. Score must be a number from 0.0 to 1.0 (1.0 = directly answers or strongly matches the query semantically even with different wording; 0.0 = unrelated). Include only chunks with score >= 0.40. No markdown fences or extra text.';

const RERANK_CACHE_TTL_MS = 5 * 60 * 1000;
const RERANK_CACHE_MAX_ENTRIES = 64;
export const SEMANTIC_RERANK_MAX_CANDIDATES = 16;

export interface SemanticRerankCandidate {
  readonly id: string;
  readonly title: string;
  readonly content: string;
}

export function parseLlmRerankScores(
  rawText: string,
  candidates: ReadonlyArray<SemanticRerankCandidate>,
): ReadonlyArray<{ readonly id: string; readonly similarity: number }> | null {
  const cleaned = rawText
    .replace(/^```(?:json)?\s*/iu, "")
    .replace(/\s*```$/u, "")
    .trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  const decoded = decodeRerankScoresJson(cleaned.slice(start, end + 1));
  if (Option.isNone(decoded)) return null;

  const byId = new Map<string, number>();
  for (const item of decoded.value.scores) {
    const idx =
      typeof item.id === "number" ? Math.trunc(item.id) - 1 : Number.parseInt(item.id, 10) - 1;
    if (!Number.isInteger(idx) || idx < 0 || idx >= candidates.length) continue;
    const candidate = candidates[idx]!;
    const score = Math.max(0, Math.min(1, item.score));
    const prev = byId.get(candidate.id);
    if (prev === undefined || score > prev) {
      byId.set(candidate.id, score);
    }
  }
  return [...byId.entries()]
    .map(([id, similarity]) => ({ id, similarity }))
    .toSorted(
      (left, right) => right.similarity - left.similarity || left.id.localeCompare(right.id),
    );
}

function buildRerankUserPrompt(
  query: string,
  candidates: ReadonlyArray<SemanticRerankCandidate>,
): string {
  const safeQuery = boundedEmbeddingText(query, 512);
  const lines = candidates.map((candidate, index) => {
    const title = boundedEmbeddingText(candidate.title, 180).replace(/\s+/gu, " ");
    const excerpt = boundedEmbeddingText(candidate.content, 420).replace(/\s+/gu, " ");
    return `[${index + 1}] ${title}\n${excerpt}`;
  });
  return `Query: ${safeQuery}\n\nDocuments:\n${lines.join("\n\n")}`;
}

function parseLoopbackOrigin(rawUrl: string): string | null {
  if (!isLoopbackHttpUrl(rawUrl)) return null;
  try {
    return new URL(rawUrl.trim()).origin;
  } catch {
    return null;
  }
}

export const makeSemanticLlmReranker = Effect.fn("makeSemanticLlmReranker")(function* (
  http: HttpClient.HttpClient,
  getSettings: () => Effect.Effect<ServerSettings | null>,
) {
  const permit = yield* Semaphore.make(2);
  const cache = new Map<
    string,
    {
      readonly expiresAt: number;
      readonly ranked: ReadonlyArray<{ readonly id: string; readonly similarity: number }>;
    }
  >();

  return Effect.fn("semanticLlmRerank")(function* (input: {
    readonly instanceId: ProviderInstanceId | null;
    readonly endpoint: string;
    readonly model: string;
    readonly query: string;
    readonly candidates: ReadonlyArray<SemanticRerankCandidate>;
  }): Effect.fn.Return<
    ReadonlyArray<{ readonly id: string; readonly similarity: number }>,
    RegisteredSemanticError
  > {
    const bounded = input.candidates.slice(0, SEMANTIC_RERANK_MAX_CANDIDATES);
    if (bounded.length === 0) return [];

    const cacheKey = NodeCrypto.createHash("sha256")
      .update(
        [
          input.instanceId ?? input.endpoint,
          input.model,
          input.query.trim(),
          ...bounded.map((c) => `${c.id}:${c.title.slice(0, 64)}:${c.content.slice(0, 128)}`),
        ].join("\0"),
      )
      .digest("hex");
    const now = yield* Clock.currentTimeMillis;
    const cached = cache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      cache.delete(cacheKey);
      cache.set(cacheKey, cached);
      return cached.ranked;
    }

    const userPrompt = buildRerankUserPrompt(input.query, bounded);
    let providerLabel = "Ollama";

    const rawText = yield* permit.withPermits(1)(
      Effect.gen(function* () {
        if (input.instanceId === null) {
          const origin = parseLoopbackOrigin(input.endpoint);
          if (!origin) {
            return yield* new RegisteredSemanticError({
              providerLabel: "Ollama",
              model: input.model,
              reason: "connection",
            });
          }
          return yield* HttpClientRequest.post(`${origin}/api/chat`).pipe(
            HttpClientRequest.bodyJson({
              model: input.model,
              stream: false,
              format: "json",
              keep_alive: "5m",
              options: { temperature: 0, num_predict: 400 },
              messages: [
                { role: "system", content: RERANK_SYSTEM_PROMPT },
                { role: "user", content: userPrompt },
              ],
            }),
            Effect.flatMap(http.execute),
            Effect.flatMap(HttpClientResponse.filterStatusOk),
            Effect.flatMap(HttpClientResponse.schemaBodyJson(OllamaChatResponse)),
            Effect.map((body) => body.message?.content ?? ""),
          );
        }

        const settings = yield* getSettings();
        const provider = resolveRegisteredSemanticProvider(
          input.instanceId,
          settings?.providerInstances[input.instanceId],
        );
        if (!provider) {
          return yield* new RegisteredSemanticError({
            providerLabel: input.instanceId,
            model: input.model,
            reason: "provider-missing",
          });
        }
        providerLabel = provider.displayName;
        if (!provider.apiKey && !provider.isLocal) {
          return yield* new RegisteredSemanticError({
            providerLabel,
            model: input.model,
            reason: "auth",
          });
        }

        if (provider.protocol === "anthropic-messages") {
          return yield* HttpClientRequest.post(`${provider.apiBaseUrl}/messages`).pipe(
            HttpClientRequest.setHeader("Content-Type", "application/json"),
            HttpClientRequest.setHeader("x-api-key", provider.apiKey ?? ""),
            HttpClientRequest.setHeader("anthropic-version", ANTHROPIC_API_VERSION),
            HttpClientRequest.bodyJson({
              model: input.model,
              system: RERANK_SYSTEM_PROMPT,
              max_tokens: 400,
              temperature: 0,
              messages: [{ role: "user", content: userPrompt }],
            }),
            Effect.flatMap(http.execute),
            Effect.flatMap(HttpClientResponse.filterStatusOk),
            Effect.flatMap(HttpClientResponse.schemaBodyJson(AnthropicMessagesResponse)),
            Effect.map((body) =>
              (body.content ?? [])
                .filter((part) => part.type === "text" && typeof part.text === "string")
                .map((part) => part.text ?? "")
                .join("\n"),
            ),
          );
        }

        if (provider.protocol === "openai-responses") {
          let req = HttpClientRequest.post(`${provider.apiBaseUrl}/responses`).pipe(
            HttpClientRequest.setHeader("Content-Type", "application/json"),
          );
          if (provider.apiKey) {
            req = HttpClientRequest.setHeader(req, "Authorization", `Bearer ${provider.apiKey}`);
          }
          return yield* req.pipe(
            HttpClientRequest.bodyJson({
              model: input.model,
              instructions: RERANK_SYSTEM_PROMPT,
              input: userPrompt,
              max_output_tokens: 400,
              text: { format: { type: "json_object" } },
            }),
            Effect.flatMap(http.execute),
            Effect.flatMap(HttpClientResponse.filterStatusOk),
            Effect.flatMap(HttpClientResponse.schemaBodyJson(OpenAiResponsesApiResponse)),
            Effect.map((body) => {
              if (typeof body.output_text === "string" && body.output_text.trim()) {
                return body.output_text;
              }
              return (body.output ?? [])
                .flatMap((entry) => entry.content ?? [])
                .map((part) => part.text ?? "")
                .join("\n");
            }),
          );
        }

        let req = HttpClientRequest.post(`${provider.apiBaseUrl}/chat/completions`).pipe(
          HttpClientRequest.setHeader("Content-Type", "application/json"),
        );
        if (provider.apiKey) {
          req = HttpClientRequest.setHeader(req, "Authorization", `Bearer ${provider.apiKey}`);
        }
        return yield* req.pipe(
          HttpClientRequest.bodyJson({
            model: input.model,
            temperature: 0,
            max_tokens: 400,
            messages: [
              { role: "system", content: RERANK_SYSTEM_PROMPT },
              { role: "user", content: userPrompt },
            ],
          }),
          Effect.flatMap(http.execute),
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.flatMap(HttpClientResponse.schemaBodyJson(OpenAiChatCompletionResponse)),
          Effect.map((body) => body.choices?.[0]?.message?.content ?? ""),
        );
      }).pipe(
        Effect.timeout("6 seconds"),
        Effect.mapError((cause) => {
          if (isRegisteredSemanticError(cause)) return cause;
          return new RegisteredSemanticError({
            providerLabel,
            model: input.model,
            reason: mapHttpFailureReason(cause),
          });
        }),
      ),
    );

    const parsed = parseLlmRerankScores(rawText, bounded);
    if (parsed === null) {
      return yield* new RegisteredSemanticError({
        providerLabel,
        model: input.model,
        reason: "response",
      });
    }

    cache.set(cacheKey, { expiresAt: now + RERANK_CACHE_TTL_MS, ranked: parsed });
    while (cache.size > RERANK_CACHE_MAX_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
    return parsed;
  });
});
