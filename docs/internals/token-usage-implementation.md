# P0 토큰 사용량 구현

2026-09-05. [설계](./token-efficiency-design.md)의 P0 계측·조회·화면을 구현했다.
모델 선택·추론 설정·프롬프트·재시도 정책은 변경하지 않는다.

## 저장과 복구

- `TokenUsageObservation`은 기존 문맥 사용량 이벤트의 `consumption` 필드에 실린다.
  문맥 표시용 `usedTokens`는 소비량에 합산하지 않는다.
- 기존 orchestration event log가 원본 원장이다. 관측마다 별도 원문 로그를 중복 저장하지 않는다.
- migration 057은 `token_usage_collection`에 당시 최대 이벤트 sequence를 한 번 저장한다.
  과거 이벤트를 다시 재생해도 이 경계 이전은 집계하지 않는다.
- `projection_token_usage_requests`는 보고 여부와 관계없이 요청·모델·단계·시도를 기록한다.
  `projection_token_usage_cursors`는 native source별 누계와 처리 sequence를,
  `projection_token_usage_samples`는 요청에 귀속된 확인량과 누락 사유를 저장한다.
- projector의 cursor 갱신과 집계 변경은 같은 트랜잭션으로 처리한다.
  원장 재생·중복 통지·프로세스 재시작에서 같은 소비를 다시 더하지 않는다.
  코드/대화 되돌리기로 이미 쓴 토큰을 차감하지 않는다.
- 내부 `usageContext`를 통해 협업 run·node·시도를 연결한다. 일반 요청의 message ID는
  native turn ID가 생기기 전에도 사용할 수 있는 작업 식별자다. 클라이언트가 이 내부
  귀속 필드를 지정할 수는 없다.

## 제공자 계약

| 제공자                   | 원본과 산식                                                                 | 제한                                                                                                                                                        |
| ------------------------ | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex                    | `thread/tokenUsage/updated.tokenUsage.total`의 차분                         | `last`는 소비량이 아님. 새 native session만 0 기준이 입증됨. 재접속은 저장된 누계를 재사용하고, 처음 보는 기존 세션은 baseline 이후만 집계                  |
| Claude / 페이블          | SDK result의 `usage`를 result UUID별 1회 집계                               | streaming input의 result usage는 해당 턴의 주 에이전트 루프 합계. 캐시 읽기·쓰기를 입력에 포함. `modelUsage`는 호출 전체 누계이므로 턴 합계에 혼합하지 않음 |
| Antigravity (`gemini`)   | ACP `usage_update` 문맥 창(`usedTokens`/`maxTokens`) + `agy -p /usage` 쿼터 | 5시간·7일 버킷(`Gemini`·`Claude·GPT`) 잔여 한도와 실시간 문맥 창을 표시하며, 턴 종료 시 디바운스 갱신                                                       |
| Cursor / Grok / OpenCode | 요청과 선택 모델은 기록                                                     | 소비량이 확인되지 않아 unreported로 표시                                                                                                                    |

Claude의 streaming input 범위와 하위 에이전트 제외 의미는
[공식 cost tracking 문서](https://code.claude.com/docs/en/agent-sdk/cost-tracking#track-costs-in-streaming-input-mode)에
명시되어 있다. 입력/출력 fixture와 adapter 회귀 테스트를 함께 유지한다.
Claude result `usage`에는 native 하위 에이전트 소비가 포함되지 않는다.
Codex도 하위 포함 범위를 여기서 확정하지 않는다. 내장 agent 활동이 관측되면
부분 집계로 남기며, 별도 child 수치를 합계에 다시 더하지 않는다.

Codex는 순서가 보존된 native stream에서 최종 turn 통지를 받을 때 마지막 누계를
같은 source로 한 번 더 발행해 finality만 확정한다. 추가 소비는 0이다.
중간 재접속 후 usage 통지가 없거나 실패·중단으로 final 사용량이 확인되지 않으면
잠정 집계가 남는다. Claude는 유효한 SDK result가 final 관측이다.

누계가 감소하면 reset과 지연 도착을 구분할 근거가 없으므로 높은 기준점을 보존하고
해당 구간을 partial로 표시한다. native source가 바뀌어야 별도 카운터가 된다.
알 수 없는 turn에서 들어온 누계는 cursor만 전진시키며 다음 작업에 몰아넣지 않는다.
그 원본 관측은 이벤트 로그에 남지만 별도의 미배정 내역 화면은 제공하지 않는다.

## 조회와 화면

`orchestration.getThreadTokenUsage`는 기존 환경별 RPC와 orchestration read 권한을 사용한다.
thread의 작업 소속을 확인한 뒤 같은 협업 run의 다른 thread 내역도 조회한다.
recentWorks는 sequence 기준 20개씩 조회하므로 같은 시각의 작업도 페이지에서 빠지지 않는다.
여러 SQL 읽기는 한 트랜잭션으로 묶는다. 응답에 대화 본문·도구 출력·인증 정보를 싣지 않는다.

웹·데스크톱은 composer의 작은 버튼과 팝업, 모바일은 같은 숫자의 버튼과 닫을 수 있는
상세 화면을 제공한다. 포맷·상태 문구는 client-runtime에서 공유한다.
완료 여부와 `verificationStatus: not-evaluated`를 분리해 실행 종료를 품질 보증으로 쓰지 않는다.
화면 진입·실행 상태 변화·상세 열기·수동 새로고침에 조회하며 주기적인 LLM 호출이나
전체 대화 스캔을 추가하지 않는다.

## 검증과 남은 범위

집중 검증: 서버 182개, 계약 48개, 공용 숫자 표시 2개(총 232개 테스트).
서버·웹·client-runtime 타입 검사를 수행했으며 새 오류가 없다.
전체 저장소 검사 대신 변경된 경로의 검사만 실행했다.

- 정규화, 초기 baseline, 새 세션의 0 기준, 동일값의 독립 실행, 중복·역행,
  SQL 저장·복원·재구축, 협업 단계·재시도 합산, 미지원 제공자, 미배정 구간,
  중단과 child 포함 범위, 동일 시각 페이지 경계를 테스트한다.
- 기존 Codex·Claude adapter, runtime ingestion, projection pipeline 회귀 검사를 수행한다.
- 웹 타입 검사는 통과했다. 모바일은 변경 전과 같은 기존 navigation 타입 오류
  67개가 남아 있으며 새 오류는 없다.
- 실제 브라우저·Electron·모바일 실행 검증은 수행하지 않았다.
- native 하위 사용량의 완전한 귀속, 명시적인 native counter reset 추적,
  미배정 관측 내역 화면, 제공자별 실제 선택 모델 보정은 후속 범위다.
  현재 모델별 내역은 요청 당시 선택값을 보존한다.
- P1 문맥 인계·P2 회의 문맥·P3 검증 비용·P4 재시도 최적화 및 절감률 벤치마크는
  이 구현에 포함하지 않는다.

소스 수정에 따른 재시작으로 작업이 두 차례 중단되어, 나머지는 별도 작업 복사본에서
완성·검증한 뒤 원본과 충돌 여부를 확인해 반영했다. 운영 DB를 직접 수정하거나
서버/브라우저를 새로 실행하지 않았다.
