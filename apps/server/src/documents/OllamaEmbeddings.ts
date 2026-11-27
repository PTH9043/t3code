import {
  ProviderInstanceId,
  type AiSearchListEmbeddingModelsInput,
  type AiSearchListEmbeddingModelsResult,
  type AiSearchProviderOption,
  type AiSearchSelectableModel,
  type OllamaEmbeddingModelInfo,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { vramArbiter } from "../background/VramArbiter.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  RegisteredSemanticError,
  buildRegisteredProviderOption,
  embedWithRegisteredProvider,
  isRegisteredSemanticError,
  listResolvedRegisteredSemanticProviders,
  resolveRegisteredSemanticProvider,
} from "./RegisteredSemanticModels.ts";
import {
  EmbeddingResponse,
  getEmbeddingModelMultilingualAdvisory,
  parseProviderEmbeddingInstanceId,
  type SemanticEmbeddingInput,
} from "./semanticSearch.ts";

export const OllamaEmbeddingFailureReason = Schema.Literals([
  "model-missing",
  "connection",
  "timeout",
  "response",
  "request",
]);

export class OllamaEmbeddingError extends Schema.TaggedErrorClass<OllamaEmbeddingError>()(
  "OllamaEmbeddingError",
  {
    model: Schema.String,
    reason: OllamaEmbeddingFailureReason,
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "model-missing":
        return `서버의 Ollama에 임베딩 모델 '${this.model}'이 설치되어 있지 않습니다. 모델을 준비할 때까지 키워드 검색을 유지합니다.`;
      case "connection":
        return "서버의 Ollama에 연결할 수 없습니다. 실행 상태와 임베딩 주소를 확인하세요. 키워드 검색을 유지합니다.";
      case "timeout":
        return "로컬 의미 검색의 대기 시간이 초과되었습니다. Ollama의 모델 로딩과 처리 상태를 확인하세요. 키워드 검색을 유지합니다.";
      case "response":
        return "Ollama가 올바른 임베딩 응답을 반환하지 않았습니다. 임베딩 모델과 서버 버전을 확인하세요. 키워드 검색을 유지합니다.";
      case "request":
        return "Ollama가 임베딩 요청을 처리하지 못했습니다. 임베딩 모델과 서버 상태를 확인하세요. 키워드 검색을 유지합니다.";
    }
  }
}

export const isOllamaEmbeddingError = Schema.is(OllamaEmbeddingError);
export const isOllamaEmbeddingFailureReason = Schema.is(OllamaEmbeddingFailureReason);

export const semanticSearchFailureMessage = (cause: unknown): string =>
  isRegisteredSemanticError(cause)
    ? cause.message
    : isOllamaEmbeddingError(cause)
      ? cause.message
      : "의미 검색을 사용할 수 없어 키워드 검색을 유지합니다. 선택한 제공자와 모델을 확인하세요.";

const OllamaErrorResponse = Schema.Struct({ error: Schema.String });

/** Keep interactive searches bounded (2s fast fallback for local Ollama) and prioritized ahead of background indexing. */
export const makeOllamaEmbeddings = Effect.fn("makeOllamaEmbeddings")(function* (
  http: HttpClient.HttpClient,
  getSettings?: () => Effect.Effect<ServerSettings | null>,
) {
  const permit = yield* Semaphore.make(1);
  let activeSearches = 0;

  const waitForInteractivePriority = (purpose: SemanticEmbeddingInput["purpose"]) =>
    purpose !== "index"
      ? Effect.void
      : Effect.gen(function* () {
          let waited = 0;
          while (activeSearches > 0 && waited < 30) {
            yield* Effect.sleep("100 millis");
            waited += 1;
          }
        });

  return (
    input: Omit<SemanticEmbeddingInput, "signal">,
  ): Effect.Effect<
    readonly (readonly number[])[],
    OllamaEmbeddingError | RegisteredSemanticError
  > => {
    const providerInstanceId = parseProviderEmbeddingInstanceId(input.endpoint);
    if (providerInstanceId !== null) {
      return Effect.gen(function* () {
        const settings = getSettings ? yield* getSettings() : null;
        const provider = resolveRegisteredSemanticProvider(
          providerInstanceId,
          settings?.providerInstances[ProviderInstanceId.make(providerInstanceId)],
        );
        if (!provider) {
          return yield* new RegisteredSemanticError({
            providerLabel: providerInstanceId,
            model: input.model,
            reason: "provider-missing",
          });
        }
        return yield* embedWithRegisteredProvider({
          http,
          provider,
          model: input.model,
          texts: input.texts,
          purpose: input.purpose,
        });
      });
    }

    const isInteractive = input.purpose !== "index";
    if (isInteractive) {
      vramArbiter.recordUserActivity();
    } else if (vramArbiter.isBackgroundPaused()) {
      return Effect.fail(new OllamaEmbeddingError({ model: input.model, reason: "timeout" }));
    }
    const runRequest = Effect.gen(function* () {
      yield* waitForInteractivePriority(input.purpose);
      return yield* permit.withPermits(1)(
        HttpClientRequest.post(`${input.endpoint}/api/embed`).pipe(
          HttpClientRequest.bodyJson({
            model: input.model,
            input: input.texts,
            truncate: true,
            keep_alive: isInteractive ? "5m" : "2m",
            options: { num_gpu: 0, num_thread: 4 },
          }),
          Effect.flatMap(http.execute),
          Effect.flatMap(
            Effect.fn(function* (response) {
              if (response.status === 404) {
                const body = yield* HttpClientResponse.schemaBodyJson(OllamaErrorResponse)(
                  response,
                ).pipe(Effect.orElseSucceed(() => null));
                if (body && /model.*not found/i.test(body.error)) {
                  return yield* new OllamaEmbeddingError({
                    model: input.model,
                    reason: "model-missing",
                  });
                }
              }
              if (response.status < 200 || response.status >= 300) {
                yield* Effect.logWarning("Ollama embedding request returned non-OK status", {
                  model: input.model,
                  purpose: input.purpose,
                  status: response.status,
                  batchSize: input.texts.length,
                });
              }
              return yield* HttpClientResponse.filterStatusOk(response);
            }),
          ),
          Effect.flatMap(HttpClientResponse.schemaBodyJson(EmbeddingResponse)),
          Effect.map((body) => body.embeddings),
        ),
      );
    });

    return Effect.acquireUseRelease(
      Effect.sync(() => {
        if (isInteractive) activeSearches += 1;
      }),
      () => runRequest,
      () =>
        Effect.sync(() => {
          if (isInteractive) activeSearches = Math.max(0, activeSearches - 1);
        }),
    ).pipe(
      Effect.timeout(input.purpose === "index" ? "30 seconds" : "2 seconds"),
      Effect.mapError((cause) => {
        if (isOllamaEmbeddingError(cause)) return cause;
        const reason =
          cause._tag === "TimeoutError"
            ? "timeout"
            : cause._tag === "SchemaError"
              ? "response"
              : HttpClientError.isHttpClientError(cause) && cause.reason._tag === "TransportError"
                ? "connection"
                : HttpClientError.isHttpClientError(cause) &&
                    (cause.reason._tag === "DecodeError" || cause.reason._tag === "EmptyBodyError")
                  ? "response"
                  : "request";
        return new OllamaEmbeddingError({ model: input.model, reason });
      }),
    );
  };
});

const OllamaTagModelDetailsSchema = Schema.Struct({
  family: Schema.optional(Schema.String),
  families: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
  parameter_size: Schema.optional(Schema.String),
  quantization_level: Schema.optional(Schema.String),
});

const OllamaTagEntrySchema = Schema.Struct({
  name: Schema.String,
  size: Schema.optional(Schema.Number),
  remote_model: Schema.optional(Schema.String),
  remote_host: Schema.optional(Schema.String),
  details: Schema.optional(OllamaTagModelDetailsSchema),
});

const OllamaTagsResponseSchema = Schema.Struct({
  models: Schema.optional(Schema.Array(OllamaTagEntrySchema)),
});

const OllamaShowResponseSchema = Schema.Struct({
  capabilities: Schema.optional(Schema.Array(Schema.String)),
  remote_model: Schema.optional(Schema.String),
  remote_host: Schema.optional(Schema.String),
  details: Schema.optional(OllamaTagModelDetailsSchema),
});

const FALLBACK_EMBEDDING_NAME_PATTERN =
  /(?:embed|bge(?:-|$)|e5-|gte-|minilm|arctic-embed|jina-embed|paraphrase-multilingual)/iu;
const MULTILINGUAL_RECOMMENDED_PATTERN =
  /(?:bge-m3|nomic-embed-text-v2|multilingual|ko[-_]|korean|qwen\d*(?:\.\d+)?-embedding|jina-embeddings-v3|embeddinggemma)/iu;

function parseLoopbackOllamaOrigin(endpoint: string): string | null {
  try {
    const parsed = new URL(endpoint.trim());
    if (!["http:", "https:"].includes(parsed.protocol)) return null;
    const host = parsed.hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1");
    if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

interface DiscoveredOllamaModels {
  readonly endpoint: string;
  readonly reachable: boolean;
  readonly embeddingModels: ReadonlyArray<OllamaEmbeddingModelInfo>;
  readonly selectableModels: ReadonlyArray<AiSearchSelectableModel>;
  readonly errorMessage?: string;
}

const discoverOllamaModelsInternal = Effect.fn("discoverOllamaModelsInternal")(function* (
  http: HttpClient.HttpClient,
  endpoint: string,
): Effect.fn.Return<DiscoveredOllamaModels> {
  const normalizedInput = endpoint.trim() || "http://127.0.0.1:11434";
  const origin = parseLoopbackOllamaOrigin(normalizedInput);
  if (!origin) {
    return {
      endpoint: normalizedInput,
      reachable: false,
      embeddingModels: [],
      selectableModels: [],
      errorMessage: "임베딩 주소는 서버 환경의 localhost HTTP 주소여야 합니다.",
    };
  }

  const tagsResult = yield* HttpClientRequest.get(`${origin}/api/tags`).pipe(
    http.execute,
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap(HttpClientResponse.schemaBodyJson(OllamaTagsResponseSchema)),
    Effect.timeout("3 seconds"),
    Effect.result,
  );
  if (tagsResult._tag === "Failure") {
    return {
      endpoint: origin,
      reachable: false,
      embeddingModels: [],
      selectableModels: [],
      errorMessage:
        "서버의 Ollama에 연결할 수 없습니다. Ollama 실행 상태를 확인하세요. 연결되지 않아도 키워드 검색이나 등록된 API 모델은 사용할 수 있습니다.",
    };
  }

  const localTags = (tagsResult.success.models ?? []).filter(
    (entry) => entry.name.trim().length > 0 && !entry.remote_model && !entry.remote_host,
  );

  const inspected = yield* Effect.forEach(
    localTags,
    (entry) =>
      Effect.gen(function* () {
        const showResult = yield* HttpClientRequest.post(`${origin}/api/show`).pipe(
          HttpClientRequest.bodyJson({ model: entry.name }),
          Effect.flatMap(http.execute),
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.flatMap(HttpClientResponse.schemaBodyJson(OllamaShowResponseSchema)),
          Effect.timeout("2500 millis"),
          Effect.result,
        );

        let isEmbeddingModel: boolean;
        let isCompletionModel = false;
        let showDetails: typeof OllamaTagModelDetailsSchema.Type | undefined;
        if (showResult._tag === "Success") {
          const info = showResult.success;
          if (info.remote_model || info.remote_host) return null;
          showDetails = info.details;
          if (Array.isArray(info.capabilities) && info.capabilities.length > 0) {
            isEmbeddingModel = info.capabilities.includes("embedding");
            isCompletionModel = info.capabilities.includes("completion");
          } else {
            const fam = info.details?.family ?? entry.details?.family ?? "";
            isEmbeddingModel =
              FALLBACK_EMBEDDING_NAME_PATTERN.test(entry.name) || /bert/iu.test(fam);
            isCompletionModel = !isEmbeddingModel;
          }
        } else {
          const fam = entry.details?.family ?? "";
          isEmbeddingModel = FALLBACK_EMBEDDING_NAME_PATTERN.test(entry.name) || /bert/iu.test(fam);
          isCompletionModel = !isEmbeddingModel;
        }

        if (!isEmbeddingModel && !isCompletionModel) return null;

        const name = entry.name.trim();
        const details = showDetails ?? entry.details;
        const parameterSize = details?.parameter_size?.trim() || undefined;
        const quantizationLevel = details?.quantization_level?.trim() || undefined;
        const family = details?.family?.trim() || undefined;
        const sizeField =
          typeof entry.size === "number" && Number.isFinite(entry.size) && entry.size > 0
            ? { sizeBytes: entry.size }
            : {};
        const sharedMeta = {
          ...sizeField,
          ...(parameterSize ? { parameterSize } : {}),
          ...(quantizationLevel ? { quantizationLevel } : {}),
          ...(family ? { family } : {}),
        };

        if (isEmbeddingModel) {
          const englishOnlyWarning = getEmbeddingModelMultilingualAdvisory(name) ?? undefined;
          const multilingualRecommended =
            englishOnlyWarning === undefined && MULTILINGUAL_RECOMMENDED_PATTERN.test(name);
          const embeddingInfo: OllamaEmbeddingModelInfo = {
            name,
            ...sharedMeta,
            multilingualRecommended,
            ...(englishOnlyWarning ? { englishOnlyWarning } : {}),
          };
          const selectable: AiSearchSelectableModel = {
            name,
            mode: "embedding",
            recommended: multilingualRecommended,
            multilingualRecommended,
            sourceHint: "installed",
            ...sharedMeta,
            ...(englishOnlyWarning ? { englishOnlyWarning } : {}),
          };
          return { embeddingInfo, selectable };
        }

        const selectable: AiSearchSelectableModel = {
          name,
          mode: "rerank",
          recommended: false,
          multilingualRecommended: false,
          sourceHint: "installed",
          ...sharedMeta,
        };
        return { embeddingInfo: null, selectable };
      }),
    { concurrency: 4 },
  );

  const embeddingModels = inspected
    .map((item) => item?.embeddingInfo ?? null)
    .filter((item): item is OllamaEmbeddingModelInfo => item !== null)
    .toSorted(
      (left, right) =>
        Number(right.multilingualRecommended) - Number(left.multilingualRecommended) ||
        left.name.localeCompare(right.name),
    );

  const selectableModels = inspected
    .map((item) => item?.selectable ?? null)
    .filter((item): item is AiSearchSelectableModel => item !== null)
    .toSorted(
      (left, right) =>
        Number(left.mode === "rerank") - Number(right.mode === "rerank") ||
        Number(right.recommended) - Number(left.recommended) ||
        left.name.localeCompare(right.name),
    );

  return {
    endpoint: origin,
    reachable: true,
    embeddingModels,
    selectableModels,
  };
});

function buildOllamaProviderOption(discovered: DiscoveredOllamaModels): AiSearchProviderOption {
  const statusMessage = discovered.errorMessage
    ? discovered.errorMessage
    : discovered.embeddingModels.length === 0 && discovered.selectableModels.length === 0
      ? "Ollama에 설치된 모델이 없습니다. 터미널에서 `ollama pull bge-m3` 등으로 설치한 뒤 새로고침하세요."
      : undefined;
  return {
    source: "ollama",
    displayName: "로컬 Ollama",
    baseUrl: discovered.endpoint,
    isLocal: true,
    apiKeyReady: discovered.reachable,
    supportsEmbeddingsApi: true,
    supportsRerankApi: true,
    models: discovered.selectableModels,
    ...(statusMessage ? { statusMessage } : {}),
  };
}

/**
 * Query a local Ollama endpoint (`/api/tags` + `/api/show`) and return locally installed
 * embedding models (in `models`) plus provider-scoped options (in `providers`).
 */
export const discoverOllamaEmbeddingModelsAtEndpoint = Effect.fn(
  "discoverOllamaEmbeddingModelsAtEndpoint",
)(function* (
  http: HttpClient.HttpClient,
  endpoint: string,
): Effect.fn.Return<AiSearchListEmbeddingModelsResult> {
  const discovered = yield* discoverOllamaModelsInternal(http, endpoint);
  return {
    endpoint: discovered.endpoint,
    reachable: discovered.reachable,
    models: discovered.embeddingModels,
    providers: [buildOllamaProviderOption(discovered)],
    ...(discovered.errorMessage ? { errorMessage: discovered.errorMessage } : {}),
  };
});

export const listLocalOllamaEmbeddingModels = Effect.fn("listLocalOllamaEmbeddingModels")(
  function* (
    input: AiSearchListEmbeddingModelsInput,
  ): Effect.fn.Return<
    AiSearchListEmbeddingModelsResult,
    never,
    HttpClient.HttpClient | ServerSettingsService
  > {
    const http = yield* HttpClient.HttpClient;
    const settingsService = yield* ServerSettingsService;
    const persisted = yield* settingsService.getSettings.pipe(Effect.orElseSucceed(() => null));
    const endpoint =
      input.endpoint?.trim() || persisted?.aiSearch.embeddingEndpoint || "http://127.0.0.1:11434";

    const discoveredOllama = yield* discoverOllamaModelsInternal(http, endpoint);
    const resolvedRegistered = listResolvedRegisteredSemanticProviders(persisted);
    const registeredProviderOptions = yield* Effect.forEach(
      resolvedRegistered,
      (provider) => buildRegisteredProviderOption(http, provider),
      { concurrency: 4 },
    );

    return {
      endpoint: discoveredOllama.endpoint,
      reachable: discoveredOllama.reachable,
      models: discoveredOllama.embeddingModels,
      providers: [buildOllamaProviderOption(discoveredOllama), ...registeredProviderOptions],
      ...(discoveredOllama.errorMessage ? { errorMessage: discoveredOllama.errorMessage } : {}),
    };
  },
);
