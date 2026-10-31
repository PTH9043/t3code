# AutoUsage RAG·토큰 최적화 — Grok/X 수집 및 검증 기록

2026-09-12 KST. 이 문서는 조사 영수증이며 개선 기능의 구현 완료 기록이 아니다.
최종 판단은 [실행 계획](./rag-token-optimization-plan-2026-09-12.md), Grok의 원래 제안은 [원보고서](./rag-token-grok-report-2026-09-12.md)를 따른다. 둘이 다르면 검증 후 작성한 실행 계획을 우선한다.

## 실제 수집

- 설치 CLI: `grok 1.0.4 (d846eb93d9)`, 실행 결과 모델: `grok-4.6-build`.
- 17:52 KST에 별도 조사 폴더에서 headless 실행. 공개 자료만 조사하도록 요청하고 코드 변경·셸 실행·하위 에이전트·별도 기억 기능을 사용하지 않았다.
- 실행 옵션: `--prompt-file`, `--no-subagents`, `--no-memory`, `--permission-mode dontAsk`, `--output-format streaming-json`.
- 완료 이벤트 기준 **WebSearch 31건**(검색과 페이지 열람 합계), **XSearch 9건**(키워드 검색 5, 의미 검색 1, 스레드 조회 3)을 확인했다. 웹 검색의 x.com 제한만으로 X 검색을 대신한 것이 아니다.
- 마지막 별도 `web_fetch` 1건은 CLI에서 `User cancelled the execution for tool web_fetch`라는 결과를 남기고 수집 turn이 cancelled로 끝났다. 사용자가 직접 취소했다고 단정하지 않는다. 이 결과는 해당 조회에 한정된다.
- 수집 세션을 `--resume`하고 웹 검색을 비활성화하여 기존 자료만 정리했다. 추가 도구 호출 **0건**, 최종 `end_turn`, 원보고서 **6,488자**로 완료했다.
- session: `01a094d1-079b-7d82-bc74-db1986151f82`. 원시 이벤트는 `.t3/rag-token-research-2026-09-12/`에 보관한다. RAG에는 검색·출처·결과 메타데이터를 정리한 영수증을 저장하며 내부 thought 이벤트나 서명은 복제하지 않는다.

X 검색어와 조회 ID:

```text
prompt caching compaction tool search from:OpenAI OR from:AnthropicAI OR from:xai
prompt caching compaction tool search token efficiency for coding agents
from:AnthropicAI (prompt caching OR compaction OR tool search OR context engineering)
from:OpenAI (prompt caching OR compaction OR tool search)
from:xai (prompt caching OR cached tokens)
(context engineering OR prompt caching OR compaction) (from:alexalbert__ OR from:thariq OR from:karpathy OR from:swyx OR from:simonw)
x_thread_fetch: 1911918094106415212
x_thread_fetch: 1823752104273699216
x_thread_fetch: 2097049646636171505
```

웹 수집은 OpenAI/Anthropic/xAI의 캐시·압축·도구 검색·문맥 설계, SQLite FTS5, 하이브리드 검색·재순위 관련 자료를 대상으로 했다. 모든 실제 검색어·페이지 URL은 별도 `grok-evidence.json`의 trace와 AutoUsage RAG의 수집 영수증에 보존했다.

## X 게시물의 사용 범위

| Grok가 반환한 저자·URL                                               | Grok가 보고한 날짜·내용                 | 독립 검증 상태                                                                                                                         |
| -------------------------------------------------------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| [Alex Albert](https://x.com/alexalbert__/status/1823752104273699216) | 2024-08-14, 멀티턴 캐시 breakpoint 활용 | 동일 post ID의 native thread fetch 완료 이벤트 확인. 별도 웹 열람은 403, 본문·날짜는 독립 미확인. 현행 공식 캐시 문서로 기술 내용 대조 |
| [Simon Willison](https://x.com/simonw/status/1911918094106415212)    | 2025-04-14, 당시 GPT-4.1 캐시 가격 관찰 | native thread fetch 확인, 별도 웹은 403. 당시 가격 주장을 현행 가격으로 채택하지 않음                                                  |
| [anshuman](https://x.com/anshu_code/status/2097049646636171505)      | 2026-09-07, 개인 캐시 비용 측정         | native thread fetch 확인, 별도 웹은 403. 본문·날짜·수치 모두 독립 미확인, 성능 근거로 제외                                             |
| [AnthropicAI](https://x.com/AnthropicAI/status/1966236220868247701)  | 검색 스니펫에 도구 작성 글 소개         | 웹 검색에서 URL 발견, CLI fetch 취소/별도 웹 403. 원문 미검증                                                                          |

native XSearch 이벤트는 호출명·질의·post ID를 제공하지만 게시물 본문 전체를 NDJSON으로 노출하지 않았다. 따라서 **호출 증거**와 **Grok가 보고한 게시물 내용**을 구분한다. X의 개인 측정은 실험 아이디어로만 사용한다. 현행 기능 판단은 직접 열람한 공식 문서에 근거한다.

## 원보고서에서 수정하거나 채택하지 않은 내용

1. Grok는 “런타임이 사용량 API를 제공하지 않음”이라고 썼지만, 실제 종료 이벤트에는 usage/modelUsage가 있었다. 아래 숫자는 보고서 문장이 아닌 런타임 이벤트에서 추출했다. 모델이 자기 사용량을 모르는 것과 런타임 미보고는 다르다.
2. “성공당 캐시·reasoning을 합산”이라는 문장은 부분집합 중복 합산을 일으킬 수 있다. provider별 의미를 정규화하여 입력 전체+출력 전체만 더하고, 캐시/추론은 세부 내역으로 둔다.
3. “캐시가 이미 깨진 시점에는 모델/effort 변경”은 사용자 선택 변경의 근거로 채택하지 않았다. 사용자 선택 모델·추론 수준은 계속 유지한다.
4. “주입 집합의 고유 경로 수 감소”는 좋은 중복 제거 지표가 아니다. 다양한 필요한 근거가 사라질 수 있다. 중복 구간 감소와 필수 근거 보존·정답 품질로 평가한다.
5. “중간을 비우고 앞·뒤에 배치”를 일반 규칙으로 적용하지 않는다. 과거 위치 편향 연구를 현재 모델의 보장으로 확대하지 않고, 관련성·구조·안정적인 캐시 접두를 우선한다.
6. 하이브리드 검색을 첫 단계로 도입하지 않는다. 현재 SQLite/한국어 분석을 유지하고, 이미 확인된 불필요한 기억 주입과 재시도 문제부터 고친다.
7. Grok가 적은 SQLite 갱신일, 추가 모델 지원 하한, 부가 제품 발표일은 이 계획에서 독립 확인하지 않았으므로 구현 전제에서 제외했다. 가격·절감률은 현행 보장으로 사용하지 않는다.

## 런타임 사용량 영수증

| 요청           | 종료                     | input_tokens | cache_read_input_tokens | output_tokens | reasoning_tokens | total_tokens |
| -------------- | ------------------------ | -----------: | ----------------------: | ------------: | ---------------: | -----------: |
| 공개 자료 수집 | cancelled (마지막 fetch) |      172,826 |                 371,072 |         3,206 |            2,390 |      547,104 |
| 기존 자료 종합 | end_turn                 |      136,915 |                   1,408 |         5,306 |            1,949 |      143,629 |

두 이벤트 모두 cache_creation_input_tokens=0. 각 표본은 `input + cache_read + output = total`이며 reasoning을 다시 더하지 않는다. `usage` 이벤트와 동일한 `end.usage`를 중복 집계하지 않는다. CLI가 자체 보고한 금액은 각각 USD 0.57428832, 0.1041658이며 **실제 결제·구독 차감 검증값이 아니다**. 단계별 원본을 유지하고 native 계측의 범위·누계 의미를 확정하기 전 AutoUsage 전체 원장의 정상 집계로 승격하지 않는다.

수집과 종합 사이에는 도구 설정이 달라졌고 두 요청의 cache read가 크게 다르다. 여러 조건이 함께 바뀌었으므로 이를 어떤 단일 최적화의 인과 효과나 일반 절감률로 주장하지 않는다. 같은 session ID만으로 캐시 히트가 보장되지 않는다는 운영상 주의 사례다.

## 직접 대조한 공식 근거

확인일은 모두 2026-09-12다. [실행 계획 6절](./rag-token-optimization-plan-2026-09-12.md)에 각 출처와 적용 범위를 정리했다.

- [OpenAI 캐시](https://developers.openai.com/api/docs/guides/prompt-caching), [OpenAI 압축](https://developers.openai.com/api/docs/guides/compaction)
- [Anthropic 캐시](https://platform.claude.com/docs/en/build-with-claude/prompt-caching), [문맥 설계](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents), [Contextual Retrieval](https://www.anthropic.com/engineering/contextual-retrieval)
- [Anthropic 도구 활용](https://www.anthropic.com/engineering/advanced-tool-use), [MCP 실행 결과 처리](https://www.anthropic.com/engineering/code-execution-with-mcp)
- [xAI 캐시](https://docs.x.ai/developers/advanced-api-usage/prompt-caching/best-practices), [xAI X Search](https://docs.x.ai/developers/tools/x-search)
- [SQLite FTS5](https://sqlite.org/fts5.html)

## 저장·검증 영수증

AutoUsage 프로젝트에 짧은 장기기억과 상세 계획/검증 기록/Grok 원보고서/검색 trace를 각각 저장한다. Grok 원보고서는 위 수정사항을 앞에 붙이고 미검증 자료로 분류한다. 내용·출처·질의 이력을 보존하면서 원문 전체가 매번 장기기억으로 주입되지 않게 구분한다.

실제 저장 결과는 `.t3/rag-token-research-2026-09-12/rag-storage-result.json`에 남긴다. 저장 완료 기록은 본문 일치·FTS 검색·prompt sourceReferences 확인 후에만 작성한다.

2026-09-12 18:06 KST 최초 저장·검증 완료. AutoUsage 프로젝트(`a6faabb1-10fa-4985-9404-512250af2008`)에 프로젝트 범위로 아래 5건을 저장했다.

| 항목 ID                                   | 용도                                 | 검증 분류                                                |
| ----------------------------------------- | ------------------------------------ | -------------------------------------------------------- |
| `autousage-rag-token-memory-2026-09-12`   | 짧은 장기기억·다음 구현 순서         | unverified: 제안 효과 미검증                             |
| `autousage-rag-token-design-2026-09-12`   | 상세 실행 계획                       | unverified: 구현/성과 미검증                             |
| `autousage-rag-token-research-2026-09-12` | 조사·독립 대조·정정 기록             | verified: 명시된 확인 범위와 한계                        |
| `autousage-rag-token-grok-2026-09-12`     | 정정 링크가 붙은 Grok 원보고서       | unverified                                               |
| `autousage-rag-token-trace-2026-09-12`    | 실제 검색어·URL·X 도구·사용량 영수증 | verified: 호출 metadata, 검색 결과 전체의 진위 보장 아님 |

5건 모두 API 재조회 본문 일치, FTS 재검색, 각 항목 질의에 대한 prompt sourceReferences 포함을 확인했다. 검증 조합은 includeShared=false, ragLimit=20, maxContextChars=120000이며 모두 truncated=false였다. 별도 자연어 질의 “RAG 관련 기억 선택 토큰 최적화 형식 오류 재시도”에서도 상세 계획이 검색되었다. 이는 실제 모델 전송·모델 답변·절감률 검증이 아니다.
