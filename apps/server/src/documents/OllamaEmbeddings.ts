import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { EmbeddingResponse, type SemanticEmbeddingInput } from "./semanticSearch.ts";

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
  isOllamaEmbeddingError(cause)
    ? cause.message
    : "로컬 의미 검색을 사용할 수 없어 키워드 검색을 유지합니다. Ollama와 임베딩 모델을 확인하세요.";

const OllamaErrorResponse = Schema.Struct({ error: Schema.String });

/** Keep interactive searches bounded while CPU document batches get time to finish. */
export const makeOllamaEmbeddings = Effect.fn("makeOllamaEmbeddings")(function* (
  http: HttpClient.HttpClient,
) {
  const permit = yield* Semaphore.make(1);
  return (input: Omit<SemanticEmbeddingInput, "signal">) =>
    permit
      .withPermits(1)(
        HttpClientRequest.post(`${input.endpoint}/api/embed`).pipe(
          HttpClientRequest.bodyJson({
            model: input.model,
            input: input.texts,
            truncate: false,
            keep_alive: "2m",
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
              return yield* HttpClientResponse.filterStatusOk(response);
            }),
          ),
          Effect.flatMap(HttpClientResponse.schemaBodyJson(EmbeddingResponse)),
          Effect.map((body) => body.embeddings),
        ),
      )
      .pipe(
        Effect.timeout(input.purpose === "index" ? "30 seconds" : "5 seconds"),
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
                      (cause.reason._tag === "DecodeError" ||
                        cause.reason._tag === "EmptyBodyError")
                    ? "response"
                    : "request";
          return new OllamaEmbeddingError({ model: input.model, reason });
        }),
      );
});
