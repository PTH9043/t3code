> 자료 상태: Grok 생성 원보고서. 일부 주장·날짜는 독립 미검증이며 런타임 사용량 미보고 주장 등은 정정되었다. [검증·정정 기록](./rag-token-research-2026-09-12.md)과 [최종 계획](./rag-token-optimization-plan-2026-09-12.md)을 먼저 확인한다.

# 코딩 에이전트 RAG·토큰 효율 공개 조사 (2026-09-12)

웹·X 공개 자료 조사입니다. 로컬 앱에서 검증한 성능이 아니며, 벤더가 보고한 절감·품질 수치는 그 실험 조건에만 해당합니다. 고정 절감률·요금 보장·모든 CLI에서 API 옵션이 동일하다는 주장은 하지 않습니다. 문자 수·토큰·컨텍스트 점유·청구는 서로 다릅니다.

## 1. 수집 방법

**웹 검색(WebSearch + 페이지 열람):**  
`OpenAI prompt caching`, `OpenAI compaction`, `OpenAI tool search`, `OpenAI reasoning tokens`, `Anthropic prompt caching`, `effective context engineering for AI agents`, `contextual retrieval`, `writing tools for agents`, `tool search defer_loading`, `xAI prompt caching`, `SQLite FTS5 bm25`, `hybrid BM25 vector reranking`, `Lost in the Middle Liu 2023`, `Azure hybrid retrieval reranking`.

**네이티브 X:** `x_keyword_search`, `x_semantic_search`, `x_thread_fetch`.  
`from:OpenAI`, `from:AnthropicAI`, `from:xai`는 **결과 없음**.  
`(from:alexalbert__ OR from:simonw …)` 및 의미검색은 게시물을 반환했고, 일부는 스레드로 재확인했습니다.

**웹 색인 x.com:** Anthropic 공식 게시물 스니펫은 웹 검색으로만 보였습니다. 해당 URL `web_fetch`는 **취소**되어 원문 전체는 미확인입니다.

**미접근:** Claude `tool-search-tool`, `compaction` 문서는 쿠키 벽으로 본문이 열리지 않았습니다. 검색 스니펫만 있고 표에는 넣지 않습니다.

## 2. 출처 표

수집일 모두 **2026-09-12**. 게시일이 문서에 없으면 “현행 문서”.

| #   | URL                                                                                                                                                                           | 게시·갱신               | 지지되는 주장                                                                                                                                         | 등급     | 신뢰             |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ---------------- |
| 1   | [OpenAI Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)                                                                                         | 현행                    | 캐시는 **접두 일치**. 정적 내용을 앞에. `cached_tokens`로 히트 측정. 캐시 토큰도 창을 차지. 모델·도구·`reasoning.effort` 변경은 접두를 깨뜨릴 수 있음 | 공식     | 높음             |
| 2   | [OpenAI Compaction](https://developers.openai.com/api/docs/guides/compaction)                                                                                                 | 문서 확인일 2026-09-12  | 임계 시 서버 압축 또는 `/responses/compact`. **별도 usage**. 암호 압축 항목은 사람이 읽기용 아님                                                      | 공식     | 높음             |
| 3   | [OpenAI Tool search](https://developers.openai.com/api/docs/guides/tools-tool-search)                                                                                         | 문서 확인일 2026-09-12  | `defer_loading`+`tool_search`로 스키마를 나중 주입. **모델 제한(문서: gpt-5.4+)**. 모든 CLI 보장이 아님                                               | 공식     | 높음             |
| 4   | [OpenAI Reasoning](https://developers.openai.com/api/docs/guides/reasoning)                                                                                                   | 현행                    | reasoning은 **출력 요금**이며 창을 차지. 사용자 `effort`를 비용 이유로 내리지 말 것                                                                   | 공식     | 높음             |
| 5   | [Anthropic Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)                                                                              | 현행                    | `cache_control`. 순서 tools→system→messages. 기본 TTL 5분(1h 옵션). 바이트 일치. 쓰기/읽기 요금이 다름                                                | 공식     | 높음             |
| 6   | [Effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)                                                            | 2025-09-29              | 최소 고신호 토큰. JIT 검색. 압축·메모·서브에이전트 요약. 도구 중복 금지                                                                               | 원저자   | 높음             |
| 7   | [Contextual Retrieval](https://www.anthropic.com/engineering/contextual-retrieval)                                                                                            | 2024-09-19              | 청크에 문서 맥락 부착 + BM25+임베딩 + 재순위. **저자 실험**에서 미회수율 감소 보고. 소규모 지식은 통째 프롬프트+캐시가 RAG보다 나을 수 있음           | 원저자   | 중(수치=그 실험) |
| 8   | [Writing tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents)                                                                                    | 2025-09-11              | 검색형 도구, 고신호·짧은 결과, 이름공간, 토큰·오류·호출 수 측정                                                                                       | 원저자   | 높음             |
| 9   | [xAI cache best practices](https://docs.x.ai/developers/advanced-api-usage/prompt-caching/best-practices)                                                                     | 2026-05-10              | 자동 접두 캐시. `x-grok-conv-id`/`prompt_cache_key`. 이전 메시지 편집 금지. 히트 **비보장**                                                           | 공식     | 높음             |
| 10  | [SQLite FTS5](https://www.sqlite.org/fts5.html)                                                                                                                               | 갱신 2026-08-01         | `MATCH` + `bm25()`(낮을수록 좋음). 코드·식별자에 맞는 어휘 검색                                                                                       | 공식     | 높음             |
| 11  | [Lost in the Middle](https://arxiv.org/abs/2307.03172)                                                                                                                        | 2023-07-06 (v3 2023-11) | 관련 정보가 **중간**이면 성능 하락. 상위 근거를 앞·뒤에                                                                                               | 원저자   | 높음(당시 모델)  |
| 12  | [Azure hybrid+rerank](https://techcommunity.microsoft.com/blog/azure-ai-foundry-blog/azure-ai-search-outperforming-vector-search-with-hybrid-retrieval-and-reranking/3929167) | 2023-09-18              | BM25+벡터+RRF 후 L2 재순위가 단독 벡터보다 NDCG가 나음(**그 벤치**)                                                                                   | 벤더실험 | 중               |

보조(표 밖): [OpenAI Agents API](https://openai.com/index/introducing-the-agents-api) (2026-09-10)는 세션 압축·도구검색·서브에이전트를 제품 기능으로 소개. [Anthropic context management](https://claude.com/blog/context-management) (2025-09-29)는 오래된 tool_result 제거+파일 메모리.

## 3. 실용 제안

**제약:** 작업 완료율과 사용자 선택 모델·reasoning effort를 유지. 캐시가 이미 깨진 시점(압축 등)이 아니면 모델/effort를 바꾸지 않음(Anthropic 비용 가이드 검색 스니펫과 OpenAI 캐시 무효화 표와 정합).

### A. RAG (주입 품질)

1. **하이브리드 BM25+벡터 → 중복 제거 → 재순위 → 상위 K만 주입.** 식별자·에러코드는 어휘, 개념은 벡터. 로컬은 SQLite FTS5 `bm25()` + 벡터 + RRF 가능.  
   _대가:_ 인덱스·재순위 지연.  
   _수락:_ 고정 과제에서 Recall@K·nDCG@K가 벡터단독보다 개선되고, 주입 토큰이 예산을 넘지 않음. 벤더 %를 목표로 쓰지 않음.

2. **버전·경로·해시를 청크 ID에 넣고 중복 제거.** 같은 파일 여러 판본을 넣지 않음.  
   _대가:_ 구버전 근거가 필요할 수 있음 → 명시 버전 필터.  
   _수락:_ 주입 집합의 고유 경로 수가 줄고, 잘못된 버전 인용 오류가 늘지 않음.

3. **관련도 순으로 앞·뒤에 두고 중간을 비움**(Liu). JIT 검색을 기본, 소량 상수는 앞에 고정.  
   _대가:_ 왕복 증가.  
   _수락:_ 동일 과제 성공률 유지, 프롬프트 내 무관 청크 비율 감소.

### B. 전체 작업 토큰 (계획→도구→검증→재시도→핸드오프→메모리)

4. **안정 접두:** 시스템+정렬된 도구 스키마를 세션 동안 바이트 고정, 가변 내용은 뒤. 타임스탬프·cwd를 접두에 넣지 않음. OpenAI `prompt_cache_key`, xAI `x-grok-conv-id`는 **해당 API**에서만.  
   _대가:_ 도구 집합 변경이 캐시를 깨뜨림.  
   _수락:_ `cached_tokens`/`cache_read`가 0이 아닌 턴 비율 상승. 성공률 유지.

5. **도구는 JIT·결과 상한.** 자주 쓰는 소수만 즉시 로드, 나머지는 검색. 결과는 검색·페이지·요약. 전체 덤프 금지(Writing tools).  
   _대가:_ 검색 턴. 스키마 지연으로 도구를 못 찾을 수 있음.  
   _수락:_ 턴당 도구정의 토큰 감소, 도구선택 오류 미증가.

6. **증거 연결 상태 + 계획적 압축.** 결정·파일·테스트는 ID와 함께 짧게 유지. 한도 근접 시에만 압축하고, 압축 호출 usage를 과제 원가에 포함.  
   _대가:_ 요약 손실.  
   _수락:_ 창 초과 실패 감소, 압축 후 재탐색·재시도가 급증하지 않음.

7. **재시도 분류.** 도구/검증 오류는 같은 모델로 좁혀 재시도. 정책·한도 오류는 재호출하지 않음. 핸드오프는 전체 로그가 아니라 요약+증거 ID. 장기 기억은 창 밖 파일.  
   _대가:_ 분류 누락 시 무한 루프.  
   _수락:_ 성공 과제당 평균 재시도·핸드오프 토큰이 줄고 완료율이 떨어지지 않음.

### C. 측정 (로컬 실험의 합격선)

성공 1건당 합산: 실패 턴, 압축/요약, 캐시 **쓰기와 읽기**, reasoning 출력, 서브에이전트.  
창 점유 ≠ 청구. 캐시 히트도 창을 채움.  
품질: 작업 완료, 회귀 테스트, 잘못된 근거.  
재시도: 원인별 횟수.  
비교는 **같은 모델·같은 effort**. 이 조사가 수치를 증명하지 않음.

## 4. 모순·미확인

- 접두 캐시는 문서 순서가 바뀌면 무효. RAG 재배열과 충돌 → 재순위 결과는 접두가 아닌 접미에.
- 소지식은 통째+캐시, 대지식은 RAG(Anthropic). 경계는 앱 창·요금에 따름.
- 캐시 TTL·라우팅·히트는 비보장(xAI·OpenAI).
- `tool_search`/`defer_loading`/서버 압축은 **제공자 API** 기능. CLI 기본값이 아님.
- 2023 위치 편향이 2026 모델에서 얼마나 줄었는지는 이 수집으로 미확인.
- 이번 런타임은 사용량 API를 제공하지 않음. 청구 실측 없음.

## 5. 수집한 X 게시물

네이티브 X로 본 것만 사실로 적습니다.

| 저자                          | URL                                                   | 시각       | 요약                                                        | 상태                                                            |
| ----------------------------- | ----------------------------------------------------- | ---------- | ----------------------------------------------------------- | --------------------------------------------------------------- |
| Alex Albert (@alexalbert\_\_) | https://x.com/alexalbert__/status/1823752104273699216 | 2024-08-14 | 멀티턴에서 캐시 브레이크포인트를 앞으로 옮겨 도구 턴을 캐시 | 네이티브 검색+스레드. 당시 베타·TTL 5분 등 **구버전**일 수 있음 |
| Simon Willison (@simonw)      | https://x.com/simonw/status/1911918094106415212       | 2025-04-14 | GPT-4.1 캐시 할인이 4o보다 크다는 **당시 가격** 관찰        | 네이티브+스레드. 현행 요금표 아님                               |
| anshuman (@anshu_code)        | https://x.com/anshu_code/status/2097049646636171505   | 2026-09-07 | 동일 11호출에서 캐시 히트 시 비용이 줄었다는 **개인 측정**  | 네이티브+스레드. **검증되지 않은 일화**                         |

웹 색인만: @AnthropicAI `https://x.com/AnthropicAI/status/1966236220868247701` (검색 스니펫 2025-09-11, 도구 작성 블로그 소개). **fetch 취소, 원문 미검증.**  
공식 계정 `from:` 검색은 실패. 의미검색의 다른 글(@dejavucoder 등)은 일화·2차 해석이라 채택하지 않음.
