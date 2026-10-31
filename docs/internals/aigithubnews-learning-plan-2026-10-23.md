# AI GitHub News 학습 자료와 T3 발전 계획

이번 계획의 검토 대상은 **수집한 GitHub 주소 8,682개 전체, 14개 분야**다. 전수 평가에서 배울 내용과 활용 가치를 기록하고 적용·실험·참고·보류를 결정한 뒤 발전 과제를 정한다. 기존에 먼저 읽은 35개와 우선순위 P1인 14개로 검토 범위를 제한하지 않는다.

T3의 개발 후보에는 검색·기억의 정확도와 긴 작업의 복구·검증 근거가 있다. 새 프레임워크 도입은 기존 Effect·SQLite·provider 어댑터로 해결되지 않는 문제가 확인된 뒤에 판단한다.

2차 구현에서는 한국어 120문항 평가 도구와 개발용 92·예약 검증용 28문항을 구성하고 실제 SQLite·로컬 임베딩 검색과 최종 근거 구성을 비교했다. 검색·근거 회귀 조건은 55/120→120/120으로 개선됐고 경계 위반은 0건이었다. 의미 검색의 문맥 탈락과 출처·기록 시각 누락을 수정했다. 사진 끌어놓기와 물리 프로젝트별 미전송 첨부 보존도 분리 앱에서 검증했다. [2차 업데이트 기록](../operations/aigithubnews-phase2-2026-10-23.md)에 측정 환경·입력 토큰 증가·지연 편차·검증 한계와 운영 반영 증거를 연결한다. 모델 답변의 정답률과 전수 GitHub 검토가 완료됐다는 의미는 아니다.

2026-10-23 진행: 기존 35개 README 검토를 구조화했고 [표본 100개 발췌 선별](aigithubnews-pilot-screening-2026-10-23.md)을 추가했다. 전체 검토와 병행해 현재 재현된 모델 미설치·검색 방식 표시·MCP 연결 초기 오류를 수정했다. 별도 앱의 집중 테스트 43개와 화면 검사 후 운영에 반영한 범위는 [첫 업데이트 기록](../operations/aigithubnews-upgrade-2026-10-23.md)에 연결한다. 전체 과제 도입과 성능 목표 달성은 이후 검증 대상으로 유지한다.

자료 범위는 [AI GitHub News 공개 채널](https://t.me/s/aigithubnews)의 2026년 10월 23일 수집 시점, 15,132번 게시물까지다. 공개 게시물 15,086건에서 GitHub를 직접 연결한 게시물 11,353건과 중복을 제거한 저장소 주소 8,682개를 확인했다. 보이지 않는 게시물 ID 46개는 삭제·비공개 등 이유를 확인할 수 없는 공백으로 남긴다. 이 범위 밖의 새 게시물과 README 안의 모든 외부 링크까지 재귀적으로 수집한 수치는 아니다.

전체 주소와 출처는 [저장소 목록](aigithubnews-repositories-2026-10-23.md), 기계 처리용 정보는 [JSON 목록](aigithubnews-catalog-2026-10-23.json), 우선 검토한 35개 자료는 [학습 노트](aigithubnews-learning-notes-2026-10-23.md)에 연결한다. 실제 원본·해시·검색 파일은 `D:/__NewAutoUsage/.t3/aigithubnews-research-20261023/`에 보관한다. 최종 저장·원본 검증 수는 같은 폴더의 `verification.json`을 기준으로 한다.

## 전체 대상의 검토 절차

[전체 실행 계획표](aigithubnews-execution-schedule-2026-10-23.md)와 [분야별 전체 검토 범위](aigithubnews-full-review-scope-2026-10-23.md)를 따른다. 이전 주소 104개를 같은 저장소에 연결해 공개 저장소 8,429개와 공개 확인이 안 되는 주소 149개, 총 8,578개 검토 단위로 등록했다. 전체 주소가 48개 검토 묶음에 연결되었으며 누락은 0개다. 대상 등록은 내용 검토를 완료한 상태와 구분한다.

먼저 14개 분야에 걸친 표본 100개로 분야별 처리량과 자료 부족 비율을 측정한다. 이후 모든 검토 단위에 목적·학습 내용·활용 분야·자원·유지 상태·재사용 조건·결정과 근거를 남긴다. 확인 불가 주소도 보류 사유를 기록한다. 전수 평가에서 나온 도입·실험 후보는 관련 소스와 분리 실험으로 검증하며, 후보 수를 기존 35개로 고정하지 않는다.

검토 분야는 에이전트 실행·MCP와 스킬·개발 도구·기억과 검색·평가와 관측·데이터와 인프라·업무 자동화·로컬 추론·모델 학습·이미지와 영상·음성과 음악·교육 자료·금융과 전문 분야·그 밖의 자료를 모두 포함한다. 각 분야의 학습 노트와 발전 과제를 남기고 실제 개발·도입은 검증 결과에 따라 선택한다.

전수 검토 기간은 표본의 실측 처리량으로 산정한다. 아래 약 4주 개발 예상은 전수 검토 후 선택할 첫 T3 개발 주기의 예시이며, 전체 수집 목록의 검토·구현을 모두 4주에 마친다는 뜻이 아니다.

## 현재 구현에서 이어갈 부분

[Memory v2](memory-v2.md)에는 원문 아카이브, 출처를 보존한 기억, 필요한 항목만 읽는 조회, 프로젝트 범위의 검색, 지속 가능한 색인 작업과 원본 삭제를 분리한 파생 캐시 정리가 이미 설명되어 있다. [로컬 검색과 연구](local-search-and-research.md)는 키워드·의미 검색 결합과 검색 요청에서 문서 임베딩을 분리한 구조를 기록한다. 따라서 장기 기억이나 혼합 검색을 새 기능으로 다시 제안하지 않는다.

작업 실행에는 [복구 분류와 장벽](../../apps/server/src/orchestration/workspaceDevelopmentRecovery.ts), [작업 검사](../../apps/server/src/orchestration/workspaceTaskChecks.ts), [명령 reactor](../../apps/server/src/orchestration/Layers/ProviderCommandReactor.ts)가 있다. 다음 과제는 새 실행기를 만드는 것이 아니라 기존 기록이 재시작·취소·중복 전달에서도 일관되는지 확인하는 것이다.

[10월 15일 개발 자료](github-development-references-2026-10-15.md)와 [자율 작업 자료](github-autonomous-work-references-2026-10-15.md)는 선행 조사다. 이번 계획은 현재 문서와 코드를 기준으로 다시 평가하며, 이전 문서의 재현 후보를 해결되지 않은 장애로 단정하지 않는다.

## 먼저 확인한 참고 사례

| 우선 분야          | 주요 자료                                                                                                                                                                             | T3에서 얻을 결과                                                      |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| 기억의 정정과 시점 | [Graphiti](https://github.com/getzep/graphiti), [Mem0](https://github.com/mem0ai/mem0), [Claude Mem](https://github.com/thedotmack/claude-mem)                                        | 사용자 정정·에이전트 보고·예정과 완료를 구분하는 검색 평가            |
| 문서와 원문 근거   | [RAGFlow](https://github.com/infiniflow/ragflow), [LightRAG](https://github.com/HKUDS/LightRAG), [Onyx](https://github.com/onyx-dot-app/onyx)                                         | 한국어 PDF·표·OCR·코드 자료에서 근거 위치와 검색 실패를 확인하는 평가 |
| 작업 복구          | [LangGraph](https://github.com/langchain-ai/langgraph), [DeerFlow](https://github.com/bytedance/deer-flow), [Microsoft Agent Framework](https://github.com/microsoft/agent-framework) | 중복 실행·재개·취소·사용자 입력 대기를 구분하는 집중 회귀 사례        |
| 평가와 관측        | [Promptfoo](https://github.com/promptfoo/promptfoo), [Opik](https://github.com/comet-ml/opik), [Langfuse](https://github.com/langfuse/langfuse)                                       | 구현 버전·평가셋·실행 이력·사용량을 함께 비교하는 결과 기록           |
| 개발 작업실과 세션 | [Emdash](https://github.com/generalaction/emdash), [Pi App](https://github.com/justhil/pi-app), [Happier](https://github.com/happier-dev/happier)                                     | 준비 상태·변경 범위·기기 전환을 명확히 보여 주는 개발 흐름            |
| 지식과 스킬 재사용 | [AKM](https://github.com/itlackey/akm), [Context7](https://github.com/upstash/context7), [Agent Skills](https://github.com/mblode/agent-skills)                                       | 출처·버전·사용 결과를 보존하는 스킬 개선과 문서 조회                  |

나머지 자료도 삭제하지 않고 전체 목록에 보존한다. 자동 분류는 이름·소개·주제 태그를 이용한 탐색용 표지이며, 전체 코드 검토나 도입 권고를 뜻하지 않는다. 별 수는 같은 분야의 탐색 순서를 정하는 보조 정보로만 사용한다.

## 전수 평가 후 첫 T3 개발 주기 예시

아래 기간은 한 명이 순차적으로 진행할 첫 개발 주기의 초기 작업일 추정이다. 전수 검토에서 정한 과제에 맞춰 구체적인 항목과 기간을 조정한다. 전수 검토 시간은 이 추정에 포함하지 않는다. 이 문서는 일정 자동 실행이나 운영 기능 변경을 등록하지 않는다.

| 단계                    | 예상 기간 | 구현하거나 확인할 내용                                                                                         | 완료 조건                                                                                                                       |
| ----------------------- | --------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 1 평가 기준 고정        | 2~3일     | 기존 한국어 정답셋을 보존하고 새 실패 사례를 추가한다. 검색·작업 성공·토큰·지연의 기준값을 기록한다.           | 데이터셋 버전·입력·정답 근거·환경·모델·설정이 기록되고 같은 입력의 비교가 가능하다.                                             |
| 2 기억과 자료 검색      | 3~5일     | 정정 전후, 사실 시점, 원문 인용, 자료 삭제·제외, 프로젝트 경계의 실패를 재현한다. 실제 실패한 부분만 수정한다. | 프로젝트 경계 침범 0건, 정정·시점 정답률과 Recall@5가 기준보다 떨어지지 않는다. 원문을 다시 열 수 있다.                         |
| 3 긴 작업 복구          | 3~5일     | 명령 수락 전 실패, 수락 뒤 응답 누락, 재시작, 중복 영수증, 취소 후 늦은 결과, 사용자 입력 대기를 대조한다.     | 수락했거나 실행 여부가 불확실한 명령을 자동 재실행하지 않는다. 취소 뒤 새 작업이 시작되지 않으며 다른 스레드를 건드리지 않는다. |
| 4 문서와 스킬 개선      | 2~4일     | 라이브러리 버전과 공식 문서 출처를 기록한다. 반복 실패에서 수정 제안과 검증 결과를 남긴다.                     | 스킬 변경 전후 결과와 되돌릴 버전이 남고 사용자 권한·질문하기·계획 선택이 유지된다.                                             |
| 5 개발 화면과 기기 전환 | 3~5일     | 작업실 준비 실패, turn·session·working tree 변경 범위, 원문 열기, provider·기기 전환의 표시를 개선한다.        | 웹·데스크톱·모바일에서 진행·대기·실패·완료가 같은 의미로 보이고 재연결 뒤 질문과 취소 상태가 보존된다.                          |

### 1 평가 기준 고정

[Promptfoo의 비교 설정](https://github.com/promptfoo/promptfoo/blob/b678d240d8f1426bee776ff24c34252baa564e17/examples/eval-rag-full/promptfooconfig.with-asserts.yaml)은 같은 질문에 검색 개수를 바꾸고 고정 문자열 검사와 모델 채점을 나눈다. [Opik의 데이터셋 버전 비교 모델](https://github.com/comet-ml/opik/blob/ec65c464a0ee7cbfed45d52da6c16491dc42aee1/apps/opik-backend/src/main/java/com/comet/opik/api/DatasetVersionDiff.java)은 평가 자료 변경과 구현 변경을 분리하는 참고다.

첫 평가셋은 120문항으로 구성한다. 의미 검색 30개, 명시적인 정정 20개, 시점 20개, 프로젝트·폴더 범위 20개, 삭제·제외 10개, 긴 기록 10개, 코드·버전 질문 10개다. 같은 fixture에서 Recall@5, MRR, 근거 인용 적합률, 응답 지연 P50·P95, 입력 토큰과 모델 사용량을 기록한다. 측정용 데이터와 최종 확인용 holdout을 분리하고 운영 원문은 읽기 전용 스냅샷에서 익명화해 가져온다.

초기 채택 목표는 어려운 검색 부분집합의 정답률 5%p 개선 또는 동일 정답률에서 입력 토큰 중앙값 15% 절감이다. 전체 검색 정답률의 하락과 P95 지연의 10% 초과 악화는 허용하지 않는다. 모두 **앞으로 검증할 목표값**이며 현재 달성한 성능 수치가 아니다. 기능상 반드시 지켜야 하는 범위 분리와 중복 실행 방지는 평균 점수로 상쇄하지 않는다.

### 2 기억과 자료 검색

[Graphiti의 시간 경계 테스트](https://github.com/getzep/graphiti/blob/345e73161a61b0a4400f80c64e5bba6a584acb7b/tests/utils/maintenance/test_temporal_edge_utils.py)는 미래 계획을 말한 시점과 계획의 목표 날짜, 기간 종료를 서로 구분한다. 이를 그대로 한국어 판별기로 가져오기보다, “다음 달 완료할 예정”이 “완료했다”로 검색되지 않는 사례와 정정 전후 질문을 평가에 추가한다.

수정 후보는 [기억 선택](../../apps/server/src/orchestration/workspaceKnowledgeSelection.ts), [프롬프트 구성](../../apps/server/src/orchestration/workspacePrompt.ts), [RAG projection](../../apps/server/src/persistence/Layers/ProjectionWorkspaceRag.ts), [의미 검색](../../apps/server/src/documents/semanticSearch.ts)이다. 기존 lineage·revision·source ID를 먼저 사용한다. 필요성이 증명되지 않은 그래프 DB나 별도 기억 서버는 첫 단계의 의존성으로 넣지 않는다.

Mem0의 현재 README는 관리형 플랫폼의 전용 최적화와 공개 SDK를 구분한다. [공개 SDK의 시간 기능 관련 테스트](https://github.com/mem0ai/mem0/blob/2c81af3bbe27d9bccb09c772d583df9e9be72ee5/tests/memory/test_temporal_feature_notice.py)도 있다. 외부 벤치마크 점수나 서비스 기능을 T3의 예상 성능으로 옮겨 적지 않는다.

### 3 긴 작업 복구

[LangGraph의 저장 규약 테스트](https://github.com/langchain-ai/langgraph/blob/9d68e5b3eb1a63027b05e9f0152149ea0284dcdb/libs/checkpoint-conformance/langgraph/checkpoint/conformance/spec/test_put_writes.py)와 [스레드 삭제 규약](https://github.com/langchain-ai/langgraph/blob/9d68e5b3eb1a63027b05e9f0152149ea0284dcdb/libs/checkpoint-conformance/langgraph/checkpoint/conformance/spec/test_delete_thread.py)을 현재 이벤트 원장과 대조한다. 체크포인트 저장이라는 이름이 같아도 외부 부수 효과의 정확히 한 번 실행까지 보장한다고 해석하지 않는다.

`WorkspaceDevelopment`, `ProviderCommandReactor`, 사용량 원장과 작업 검사에서 명령 identity·receipt·산출물 해시의 연결을 확인한다. 같은 명령의 재전달이 새 실행과 새 사용량으로 기록되지 않는지, 늦게 도착한 결과가 취소를 뒤집지 않는지 검증한다. 서버 테스트는 receipt와 worker drain을 기다리며 고정 시간 sleep을 성공 조건으로 쓰지 않는다.

### 4 문서와 스킬 개선

AKM의 자산 색인과 피드백 기반 수정 제안, Context7의 버전별 문서 조회를 참고한다. 제안 단위에는 문제 사례, 관련 스킬·라이브러리 버전, 수정 전후 결과, 출처, 되돌릴 버전을 남긴다. 같은 실패에서 검증된 개선만 공용 지식으로 승격하고 에이전트의 추측은 사용자 사실과 구분한다.

스킬 도입이나 외부 저장소의 설치 설명이 현재 사용자 설정을 덮어쓰지 않게 한다. 전체·제한 권한, 질문하기·조건확인·계획 모드와 PowerShell·화면 입력 금지 지침은 현재 선택을 유지한다. 자료 수집이 새 도구의 자동 설치·실행이나 다른 사람에게 메시지를 보내는 작업으로 이어지지 않게 한다.

### 5 개발 화면과 기기 전환

[Emdash의 준비 gate 테스트](https://github.com/generalaction/emdash/blob/5bebb2e842f31e61b338c04054b106ed4d046887/packages/core/src/runtimes/workspace-registry/node/activation-gate.test.ts)는 준비 파일 처리를 기다리는 순서와 실패 뒤 진행을 허용하는 정책을 드러낸다. T3에서는 필수 자산 실패와 선택 자산 실패를 구분하고 실제 실행 가능한 상태를 표시한다.

[Pi App의 diff 테스트](https://github.com/justhil/pi-app/blob/6cf93eb218ea06b90f74f24eb86690e83625ec3a/packages/shared/diff-model.test.ts)는 binary·rename·공백 경로를 포함한다. 현재 checkpoint와 diff를 이용해 사용자가 보고 있는 변경 범위를 명시하고 원문·산출물로 돌아가는 흐름을 연결한다. Happier와 Happy는 provider·기기 전환의 비교 대상으로 삼는다.

상태 계약은 `packages/contracts`, 공유 동작은 `packages/client-runtime`을 기준으로 맞춘다. 채팅·설정·명령 팔레트·단축키의 적용 여부와 로컬·원격·relay·다중 환경의 차이를 변경마다 기록한다. 브라우저나 화면 검증은 사용자가 요청한 범위에서만 수행한다. 운영 프로그램을 나중에 교체할 때는 기존 관리자 실행기로 전체 범위를 유지하고 `showInactive()`로 실제 창을 표시·검증한다.

## 도입 전에 분리할 상태와 조건

AutoGen은 [현재 README](https://github.com/microsoft/autogen/blob/004749e6b7102c8fd317b9b1499ce5807223c278/README.md)에서 유지보수 종료를 선언하고 Microsoft Agent Framework를 안내한다. 같은 조회의 GitHub API `isArchived` 값은 false였으므로 두 근거를 따로 보존했다. Letta의 [기존 저장소 README](https://github.com/letta-ai/letta/blob/8816d3a8516893bfdc0fa14bfb1235226012e295/README.md)는 V1 서버를 retired로 설명하고 `letta-ai/letta-code`를 현재 소스로 안내한다.

[Onyx](https://github.com/onyx-dot-app/onyx/blob/345b1e5986780e52ebb7ed79fcd507744c405f73/LICENSE), [Mastra](https://github.com/mastra-ai/mastra/blob/cf0ca8b55d67a3ccf6ee7835e4dd2addea0c82a8/LICENSE.md), [LiteLLM](https://github.com/BerriAI/litellm/blob/f2118fc7670ba3fa736d9b8f4deef9077a45a720/LICENSE)은 일반 영역과 Enterprise 영역의 조건을 구분한다. [Asqav](https://github.com/jagmarques/asqav-sdk/blob/23a159f9a7fd4f6c08226be1eac4f7a1a8beb805/LICENSE)는 SDK와 verifier·conformance의 조건이 다르다. 저장소 전체의 별 수나 API SPDX 한 칸으로 코드 재사용 조건을 결론 내리지 않는다.

## 저장과 이후 조회

원본 수집은 `collect.py`, GitHub 원본 보관은 `archive_github.py`, 목록·검색 파일 재생성은 `build_catalog.py`가 담당한다. 각 파일은 조사 폴더 안에 있다. README는 gzip 원문과 SHA-256·Git blob ID·기준 commit을 연결하고, 세부 코드 자료는 `code-samples.json`에서 확인한다.

문자열 API 응답과 Git 원본의 해시가 달랐던 README 19건은 고정 commit의 raw 파일로 교체했다. 이 중에는 API에서 약 512,000바이트로 잘린 긴 파일도 있었다. `.org`·`.adoc` 형식과 GitHub가 기본 README로 지정한 하위 폴더 문서도 추가 조회했다. 원본 복구 내역은 `readme-repair-receipt.json`, 최종 해시와 검색 검증은 `verification.json`에 남긴다.

프로젝트 기억에는 전체 목록의 위치와 분야별 핵심 학습 노트를 연결한다. 전체 저장소의 README를 새 요청마다 일괄 주입하지 않고, 로컬 검색으로 후보를 고른 뒤 해당 원문을 읽는다. 이는 자료와 판단을 재사용하는 지식 저장이며 모델 가중치를 재학습한 결과를 의미하지 않는다.

추가 수집이 필요하면 새 시점의 자료를 별도 snapshot으로 남기고 새 저장소·주소 이전·README·라이선스·유지 상태의 변경을 비교한다. 원본 삭제, 자동 일정 등록, 새 의존성 설치는 이번 자료 저장과 발전 계획 수립에 포함하지 않는다.
