# NewAutoUsage 토큰과 오케스트라 최적화에 참고할 GitHub 자료

2026년 10월 15일 기준이다. 현재 로컬 코드와 미커밋 변경을 포함해 비교했다. [앞선 GitHub 조사](github-development-references-2026-10-15.md)를 보완하며, 이번에 교체한 검색 캐시·부분 토큰 집계 개선 다음에 적용할 작업을 다룬다.

우선 개발할 기능은 **문맥별 토큰 표시, 오케스트라 노드별 비용과 대기 원인 추적, 코드 구조 지도, 명령 출력의 선택적 축소**다. 기존 Effect·이벤트 원장·SQLite를 기반으로 구현하고, 외부 프레임워크에서는 적용할 동작과 회귀 사례를 가져오는 방향이 적합하다. 아래 우선순위는 적용 제안이며, 효과는 완료 작업당 사용량과 품질로 판정한다.

## 현재 구현과 추가할 부분

| 영역            | 이미 있는 기능                                                         | 추가할 부분                                                       |
| --------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------- |
| 프로젝트 문맥   | 관련 기억 선택, 본문 해시 중복 제거, 사용자 지침 우선, 삽입·제외 진단  | 모델에 맞는 토큰 계측과 역할별 입력 예산                          |
| 협업 인계       | 직접 의존 노드 결과 전달, 원문 파일과 SHA-256, 검증 가능한 상세 생략   | 원문의 필요한 부분을 조회하는 도구와 노드별 문맥 사용량           |
| 회의 문맥       | 의장 정리의 정확한 인용 중복 제거, 반대·미해결 내용 보존               | 작업 상태 요약의 갱신 조건과 요약 생성 비용 계측                  |
| 오케스트라 실행 | 병렬 수 제한, 같은 작업실의 쓰기 직렬화, 체인별 작업실 분리, 독립 검증 | 토큰 잔여량과 실행 중 작업을 고려한 배정, 대기 사유 표시          |
| 실패 복구       | 형식 복구 원문 해시 확인, 시도별 기록, 중단 후 재개, 사용자 질문 대기  | 회의의 재시작 전후 실패 예산 유지, 재실행 범위와 무효화 이유 표시 |
| 사용량          | 요청·단계·시도별 집계, 목표·일일 토큰 한도, 입력·출력·캐시 표시        | 실행 그래프와 사용량 원장을 연결한 노드별 비용·시간 화면          |
| 원격 전달       | 이벤트 병합, snapshot 이후 실시간 전달, sequence 기반 재생             | 느린 클라이언트의 대기열 크기 계측과 과부하 후 재동기화           |

로컬 근거는 [문맥 선택](../../apps/server/src/orchestration/workspacePromptRelevant.ts), [원문 보관](../../apps/server/src/orchestration/workspaceContextArtifacts.ts), [회의 문맥](../../apps/server/src/orchestration/workspaceMeetingContext.ts), [협업 인계](../../apps/server/src/orchestration/workspaceCollaboration.ts), [실행 wave 선택](../../apps/server/src/orchestration/workspaceTaskGraph.ts), [형식 복구](../../apps/server/src/orchestration/workspaceFormatRepair.ts), [사용량 제한](../../apps/server/src/orchestration/workspaceDevelopmentUsage.ts), [현재 사용량 화면](../../apps/web/src/components/chat/DevelopmentTokenUsage.tsx), [WebSocket 구독](../../apps/server/src/ws.ts)이다.

현재 문맥 조합의 기본 예산은 60,000자이며 `tokenCount`는 `null`, 상태는 `unavailable`이다. 필수 사용자 지침은 선택 자료의 예산보다 우선한다. 인계는 원문을 확인할 수 없거나 지정된 보고 형식을 만족하지 못하면 전체 결과를 보존하는 경로도 있다. 이 정책을 유지하면서 실제 입력 크기와 원문 추가 조회 비용을 함께 줄일 여지가 있다.

## 토큰 최적화에 우선 참고할 저장소

| 자료                                                | 참고할 구현                                                                         | NewAutoUsage 적용안                                                               | 우선순위  |
| --------------------------------------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | --------- |
| [Aider](https://github.com/Aider-AI/aider)          | 파일 의존 관계와 주요 심볼을 토큰 예산에 맞게 고르는 repository map                 | Main에는 코드 구조 지도를, 담당 노드에는 관련 파일·심볼과 필요한 구현 범위를 전달 | 높음      |
| [Repomix](https://github.com/yamadashy/repomix)     | Tree-sitter 기반 구조 추출, 토큰 계수기 지연 로딩과 캐시 테스트                     | 전체 저장소의 자동 삽입보다 관련 파일 묶음의 구조 요약·계수에 적용                | 높음      |
| [RTK](https://github.com/rtk-ai/rtk)                | git·테스트 등 명령별 출력 필터, 원문 보관, 제공자별 실행 연결                       | 지원되는 실행 경로에서 반복 성공 로그를 줄이고 실패·원문·종료 코드는 보존         | 시범 적용 |
| [OpenCode](https://github.com/anomalyco/opencode)   | 모델 입력 한도, 요약 출력 여유, 최근 대화 보존, 완료된 compaction의 투영            | T3가 구성하는 입력의 예산과 요약 실패 처리를 개선하는 비교 자료                   | 높음      |
| [Mastra](https://github.com/mastra-ai/mastra)       | Observer·Reflector, 관측 기록, 토큰 임계값과 비동기 반영                            | 긴 Main 작업의 결정·미완료 사항을 유지하는 작업 상태 메모                         | 조건부    |
| [Goose](https://github.com/aaif-goose/goose)        | 문맥 관리 모듈, 제공자가 문맥을 소유하는 경우의 경계, 도구 호출·결과 쌍 보존 테스트 | 제공자별 compaction capability와 종료·실패 회귀 테스트 보강                       | 높음      |
| [LLMLingua](https://github.com/microsoft/LLMLingua) | 학습 모델을 이용한 프롬프트 압축, 다국어 모델과 보존 옵션                           | 긴 자연어 조사 자료의 별도 압축 실험                                              | 후순위    |

### 코드 구조 지도와 관련 파일 묶음

Aider는 주요 정의와 호출 관계를 고른 뒤 토큰 예산에 맞는 지도만 전달한다. Repomix의 구조 압축은 구현 세부를 생략하고 시그니처·타입·구조를 남기며, 해당 기능은 실험적이라고 명시한다. [Aider 설명](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/website/docs/repomap.md), [선택 알고리즘](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/repomap.py), [Repomix 구조 압축](https://github.com/yamadashy/repomix/blob/55c6de6aebde4c38877fbcaf005c4cc396bf6e2d/website/client/src/en/guide/code-compress.md)

적용할 기능은 프로젝트 코드 지도다. 노드를 시작할 때 목표와 연관된 파일·export·타입·테스트 위치를 먼저 보여 주고, 구현 본문은 파일·줄 범위로 추가 조회한다. 수정·검증 시에는 실제 본문을 읽는다. 파싱 실패와 동적 코드도 표시한다. 캐시는 파일 내용·파서 버전·프로젝트 범위에 연결하고, 삭제·이름 변경·미커밋 수정 때 갱신한다. 외부 저장소를 포함한 전체 코드를 매번 포장하면 입력량이 늘 수 있으므로 작업별 선택이 필요하다.

### 문맥별 토큰 계수와 입력 예산

Repomix의 계수기는 encoding을 지연 로딩하고 재사용한다. 계수기와 캐시 분리 방식은 Node 서버에 적용하기 쉽다. 계수 실패를 0으로 처리하는 동작은 예산 판단에 맞게 변경해 미확인 상태로 전달해야 한다. [계수기](https://github.com/yamadashy/repomix/blob/55c6de6aebde4c38877fbcaf005c4cc396bf6e2d/src/core/metrics/TokenCounter.ts), [캐시 테스트](https://github.com/yamadashy/repomix/blob/55c6de6aebde4c38877fbcaf005c4cc396bf6e2d/tests/core/metrics/tokenCountCache.test.ts)

문맥 진단 화면에는 사용자 지침·작업·기억·RAG·의존 결과별 토큰과 생략 이유를 추가한다. 선택 모델에 맞는 계수를 지원하는 경우와 추정만 가능한 경우를 구분한다. T3가 조합한 입력의 계수와 제공자가 보고한 전체 소비량도 각각 표시한다. 제공자 내부 대화·도구 정의·이미지까지 포함한 전체 요청을 T3의 문자열 계수 하나로 표현할 수는 없다.

입력 예산에는 답변과 필요한 도구 결과의 여유를 둔다. 필수 지침이 예산을 넘으면 초과 상태를 보여 주고 선택 자료를 줄이거나 작업을 나눈다. OpenCode의 입력 한도·최근 문맥·요약 출력 제한 테스트가 비교 자료다. [현재 compaction 구현](https://github.com/anomalyco/opencode/blob/328f74c2131ad700eebfa2f4b5ee64fe2cde78e2/packages/core/src/session/compaction.ts), [회귀 테스트](https://github.com/anomalyco/opencode/blob/328f74c2131ad700eebfa2f4b5ee64fe2cde78e2/packages/core/test/session-compaction.test.ts)

### 명령 출력 축소와 원문 조회

RTK의 명령별 필터와 원문 보관을 참고해, 반복되는 성공 행·진행 표시를 줄이고 실패 목록·종료 코드·원문 위치를 전달하는 실행 경로를 시범 적용할 수 있다. 모델이 읽기 전에 출력이 바뀌는 경로에서 토큰 효과를 측정한다. 앱이 이미 수신한 활동 로그의 화면 표시만 줄이는 기능은 네트워크·렌더링 최적화로 계측한다. [Vitest 필터](https://github.com/rtk-ai/rtk/blob/0508e11297c1bb55677b1e74261910346e9d1654/src/cmds/js/vitest_cmd.rs), [원문 보관](https://github.com/rtk-ai/rtk/blob/0508e11297c1bb55677b1e74261910346e9d1654/src/core/tee.rs)

NewAutoUsage의 실행 경로에서는 제공자·설치 버전별 연결 방식을 확인해야 한다. 우선 직접 관리하는 읽기·검증 명령부터 CMD의 한글·공백·빈 인자·종료 코드로 비교한다. 필터가 지원하지 않는 출력은 원문 경로로 처리한다. 테스트와 빌드 실패의 마지막 진단, 부분 출력, 취소도 보존한다. 전역 hook이나 사용자 지침 파일을 일괄 수정하는 설치보다 프로젝트별 선택 적용이 적합하다.

현재 RTK는 Apache-2.0 CLI와 OSS 배포판, BUSL-1.1인 engine·proxy를 구분한다. 제품에 포함할 구성 요소를 정할 때 이 구분을 유지한다. 저장소가 설명하는 명령 출력 절감 수치에는 NewAutoUsage 전체 작업의 절감률을 대입하지 않는다. [구성 안내](https://github.com/rtk-ai/rtk/blob/0508e11297c1bb55677b1e74261910346e9d1654/README.md), [engine 라이선스](https://github.com/rtk-ai/rtk/blob/0508e11297c1bb55677b1e74261910346e9d1654/engine/LICENSE), [proxy 라이선스](https://github.com/rtk-ai/rtk/blob/0508e11297c1bb55677b1e74261910346e9d1654/proxy/LICENSE)

### 긴 작업의 상태 메모와 캐시

Mastra의 관측 메모는 긴 대화를 관측 기록으로 유지하고 임계값에 따라 갱신한다. 안정적인 문맥과 추가 기록을 이용하는 캐시 설계, 이전 관측 입력의 비용 관리가 참고할 부분이다. NewAutoUsage에서는 현재 목표·사용자 결정·완료 상태·실패한 접근·남은 검사·원문 참조로 범위를 좁힌 메모가 적합하다. [관측 메모](https://github.com/mastra-ai/mastra/blob/6bfa29c6b77645fb680bde7db1c7323529dedd7d/docs/src/content/en/docs/memory/observational-memory.mdx), [임계값 구현](https://github.com/mastra-ai/mastra/blob/6bfa29c6b77645fb680bde7db1c7323529dedd7d/packages/memory/src/processors/observational-memory/thresholds.ts)

요약은 문맥이 충분히 커졌거나 작업 단계가 바뀔 때 갱신하고, 생성·실패·재조회 비용도 해당 작업에 귀속한다. 동일 세션의 전달 이력과 문맥 revision을 확인해 불변 자료의 반복 삽입을 줄이며, 새 세션·모델·계정으로 전환할 때는 필요한 문맥을 다시 제공한다. 실제 캐시 재사용은 제공자의 보고로 평가한다. 보이지 않는 제공자 내부 문맥을 임의로 편집하지 않는다.

Goose는 문맥을 직접 소유하는 제공자, 토큰 미보고, 연속 문맥 오류, 도구 호출·결과 쌍의 보존을 구분한 테스트가 있다. 이 경계를 어댑터별 지원 표에 반영할 가치가 있다. [Goose 문맥 모듈](https://github.com/aaif-goose/goose/blob/01fa5dfe9ee1964988b237aaf9bcdd738b720299/crates/goose-context-management/README.md), [수명 주기 테스트](https://github.com/aaif-goose/goose/blob/01fa5dfe9ee1964988b237aaf9bcdd738b720299/crates/goose/src/agents/state_machine/tests/compaction_lifecycle.rs)

LLMLingua의 모델 기반 압축은 긴 자연어 근거를 대상으로 한국어 누락·부정문·숫자 보존과 로컬 추론 비용을 비교한 뒤 검토한다. 사용자 제약·소스 코드·정확한 명령·판정 결과는 원문과 구조화된 필드로 보존한다. 저장소의 최대 압축 수치는 특정 실험의 결과다. [LLMLingua](https://github.com/microsoft/LLMLingua/blob/5a4c78ae18ab17a98cf997e8259354e546081d64/README.md)

## 오케스트라 기능에 참고할 저장소

| 자료                                                                                     | 참고할 구현                                                             | 추가할 기능                                                           |
| ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------- |
| [DeerFlow](https://github.com/bytedance/deer-flow)                                       | 실행·대기 용량, 에이전트 턴 예산, 인수 기준과 근거를 요구하는 결과 계약 | 배정 대기 사유, 노드별 한도, 인수 기준별 결과·근거 연결               |
| [OpenHands SDK](https://github.com/OpenHands/software-agent-sdk)                         | 병렬 도구 실행의 자원별 잠금, 위임, condenser                           | 쓰기 충돌 사유 표시, 독립 작업의 동시 실행, 요약과 원문 조회 연결     |
| [Google ADK JS](https://github.com/google/adk-js)                                        | Workflow의 제한된 병렬 실행, 중단 후 재개 테스트                        | 병렬 wave의 중단·부분 결과·재개 정책을 명확하게 표시                  |
| [Microsoft Agent Framework](https://github.com/microsoft/agent-framework)                | 사용자 응답 대기와 checkpoint 상태 복원                                 | 질문·응답·시도 예산을 재시작 후에도 일관되게 복원                     |
| [OpenTelemetry GenAI 규약](https://github.com/open-telemetry/semantic-conventions-genai) | workflow·agent·tool·model 호출의 연결과 토큰 속성                       | 기존 원장으로 실행 타임라인과 노드별 비용 표시, 선택적 trace 내보내기 |
| [Langfuse](https://github.com/langfuse/langfuse)                                         | 실행 trace, 평가, 프롬프트 실험·관측 UX                                 | 실행 비교 화면과 문맥 버전별 품질·사용량 비교                         |

### 노드별 비용과 대기 원인 화면

기존 작업 목록에 다음 정보를 연결하면 사용자가 실행을 조정하기 쉬워진다.

| 표시                            | 연결할 근거                                         | 사용자가 할 수 있는 판단                       |
| ------------------------------- | --------------------------------------------------- | ---------------------------------------------- |
| 노드별 입력·출력·캐시·계측 상태 | 요청·노드·시도 ID와 사용량 원장                     | 어느 단계에서 입력 또는 재시도가 늘었는지 확인 |
| 실행 시간과 대기 시간           | 배정·시작·완료 receipt                              | 모델 응답 지연과 병렬 슬롯 대기를 구분         |
| 대기 사유                       | 의존 노드, 동일 작업실 쓰기, 계정 한도, 사용자 질문 | 작업 순서·모델·실행 설정 조정                  |
| 문맥 구성과 원문                | 문맥 진단, artifact hash, 조회 기록                 | 반복 전달되는 기억과 긴 의존 결과 확인         |
| 실패와 다음 행동                | 실패 분류, 이전 시도, 인수 기준                     | 형식 수정·검증 재실행·사용자 개입 중 선택      |

추적 구조는 실행 → 노드 → 시도 → 제공자 요청·도구 실행으로 연결한다. 상위 합계와 하위 요청을 중복 합산하지 않고, 실제 요청을 한 번씩 집계한다. 기존 원장을 기준으로 화면을 만들고 외부 추적 서비스 연결은 선택 기능으로 둘 수 있다. [GenAI agent·workflow 규약](https://github.com/open-telemetry/semantic-conventions-genai/blob/f3c6d0c9bb66ebd474668a3a0be25c61226f02c2/docs/gen-ai/gen-ai-agent-spans.md), [Langfuse 관측·평가 기능](https://github.com/langfuse/langfuse/blob/bc1ade0aacca75104bad934e92d70a454ec16e67/README.md)

GenAI 규약은 기존 semantic-conventions 저장소에서 별도 저장소로 이동했으며 현재 Development 상태다. export 매핑의 버전을 보관한다. 제공자가 보고한 billed·processed·cache 항목의 의미를 현재 집계와 맞춰 변환한다. 원문 수집은 메타데이터·토큰 수 집계와 별도로 선택한다. [토큰 규약](https://github.com/open-telemetry/semantic-conventions-genai/blob/f3c6d0c9bb66ebd474668a3a0be25c61226f02c2/docs/gen-ai/gen-ai-token-metrics.md)

### 배정과 중단 정책

현재 wave 선택은 공유 작업실의 쓰기를 단독 실행하거나 체인별로 한 노드씩 배정한다. OpenHands의 자원별 잠금은 이 정책을 세밀하게 비교할 자료다. 다만 외부 CLI 내부의 모든 파일 작업을 T3가 통제하는 구조는 아니므로, 오케스트라 배정 단계의 쓰기 범위 선언·작업실 분리·통합 검증에 연결해야 한다. [자원 잠금](https://github.com/OpenHands/software-agent-sdk/blob/75105bd40936f1962d8fa91506776a0c02ba957f/openhands-sdk/openhands/sdk/conversation/resource_lock_manager.py), [병렬 실행](https://github.com/OpenHands/software-agent-sdk/blob/75105bd40936f1962d8fa91506776a0c02ba957f/openhands-sdk/openhands/sdk/agent/parallel_executor.py)

새 배정에서는 사용자가 정한 최대 병렬 수를 유지하면서, 실행 중인 작업·보고된 잔여 토큰·예산 예약·계측 공백을 함께 고려한다. 보고가 늦을 때 동시에 시작한 작업이 남은 예산을 각각 소비하는 경우를 시험한다. 예약은 다음 배정을 위한 제어값이며 최종 소비량은 제공자 관측으로 정산한다. [DeerFlow 용량 관리](https://github.com/bytedance/deer-flow/blob/a63856f690e1d9bdc01b0065207de4f0077dc2db/backend/packages/harness/deerflow/subagents/capacity.py)

Google ADK JS에서는 구형 `ParallelAgent`가 deprecated이며 Workflow 경로를 안내한다. 현재 `ParallelWorker`는 병렬 수 제한, 중단 시 신규 배정 중지, 사용자 응답 후 재개를 다룬다. 한 항목 실패 시 다른 결과를 버리는 정책과 실행 중 항목의 취소 정책은 제품 요구에 맞게 선택해야 한다. NewAutoUsage의 완료된 노드 보존과 독립 검증은 유지한다. [Workflow 구현](https://github.com/google/adk-js/blob/0f3e5f22b37492eb32b67710761ebf1cdb28dd56/core/src/workflow/nodes/parallel_worker.ts), [병렬·중단·재개 테스트](https://github.com/google/adk-js/blob/0f3e5f22b37492eb32b67710761ebf1cdb28dd56/core/test/workflow/parallel_worker_test.ts)

### 재시작 후에도 유지할 실패 예산과 인수 기준

현재 협업 reactor의 회의 발언 실패 횟수는 메모리 Map에 있고 재시작 시 새 예산을 부여한다고 설명돼 있다. 회의별·참가자별·발언 단계별 실패 횟수와 사용자 재개 허용을 이벤트에 남기는 개선을 검토할 수 있다. 동일 실패가 재시작 뒤 무제한으로 반복되는지 회귀 사례로 확인한다. 이미 영속화된 graph attempt와 기존 복구 정책에 맞춰 확장한다. [현재 reactor](../../apps/server/src/orchestration/Layers/WorkspaceCollaborationReactor.ts), [현재 복구 정책](../../apps/server/src/orchestration/workspaceDevelopmentRecovery.ts)

Microsoft 예제는 사용자 응답을 기다리는 단계와 실행기 상태를 checkpoint로 복원한다. DeerFlow는 인수 기준별 근거를 결과에 연결하고, 사용자 설정의 턴 수와 실행 엔진 내부 step 수를 구분한다. T3에서도 사용자에게 보이는 시도·노드·턴·토큰 한도를 각각 정의하고, 형식 복구 비용을 본 작업 재시도와 구분해 보여 주는 데 참고할 수 있다. [사용자 응답과 checkpoint](https://github.com/microsoft/agent-framework/blob/0cc867d966daa2891c191204b1c9b7a4ff0e7619/dotnet/samples/03-workflows/Checkpoint/CheckpointWithHumanInTheLoop/WorkflowFactory.cs), [결과 계약](https://github.com/bytedance/deer-flow/blob/a63856f690e1d9bdc01b0065207de4f0077dc2db/backend/packages/harness/deerflow/subagents/report_contract.py), [턴 예산 변환](https://github.com/bytedance/deer-flow/blob/a63856f690e1d9bdc01b0065207de4f0077dc2db/backend/packages/harness/deerflow/subagents/turn_budget.py)

## 프로그램 성능 개선에 적용할 부분

| 대상                | 적용안                                                              | 측정할 값                                               |
| ------------------- | ------------------------------------------------------------------- | ------------------------------------------------------- |
| WebSocket 구독      | 기존 이벤트 병합을 유지하고 클라이언트별 대기열과 전송 지연 계측    | 대기 이벤트·바이트 수, 최대 메모리, 최신 sequence 지연  |
| 느린 원격 연결      | 한도 초과 시 해당 연결에 재동기화를 요구하고 영속 sequence부터 복구 | 완료·실패·질문 이벤트 누락, 중복, 정상 클라이언트 지연  |
| 대량 터미널 출력    | 전송·소비량 확인과 상·하한을 둔 흐름 제어 검토                      | 입력 응답 시간, 버퍼 크기, 한글·제어문자·종료 코드 보존 |
| 코드 지도·토큰 계수 | 내용 해시별 계산 재사용, encoding 지연 로딩, 필요한 파일만 처리     | 첫 실행·반복 실행 지연, 캐시 적중, CPU·메모리           |
| 오케스트라 화면     | 기존 목록 상태에 요약 지표를 추가하고 상세 결과는 필요할 때 조회    | 전송 payload, 렌더 시간, 접힌 상세의 파싱 비용          |

현재 shell·thread 구독에는 scope에 묶인 무제한 Queue가 있다. 느린 연결에서 실제로 얼마나 쌓이는지 먼저 측정한다. 단순히 bounded Queue로 교체해 전체 생산자를 막거나 중요한 이벤트를 버리는 방식은 피하고, 해당 클라이언트의 복구 가능한 전송 정책을 설계한다.

xterm.js의 공식 가이드는 클라이언트 소비 확인, 상·하한, WebSocket을 가로지르는 흐름 제어를 설명한다. 현재 터미널 렌더러와 어댑터의 지원 범위에 맞춰 이 전송 원리를 참고한다. demo 서버는 자체적으로 흐름 제한이 없는 예라고 표시하므로 제품 구현의 기준으로 복사하지 않는다. [흐름 제어 가이드](https://xtermjs.org/docs/guides/flowcontrol/), [demo의 설명](https://github.com/xtermjs/xterm.js/blob/991857a1b1cacf06f9531ba74a6e927a7a6398bb/demo/server/server.ts)

## 실행하기 쉽게 만드는 기능 후보

1. **시작 전 실행 미리보기**: 역할·모델·병렬 수·인수 기준·검증 명령·토큰 한도와 계측 공백을 한 화면에서 확인한다. 기존 실행 설정과 역할 배정을 재사용한다.
2. **노드별 문맥 보기**: 무엇을 읽고 어떤 원문을 생략했는지, 추가 조회가 얼마나 발생했는지 확인한다. 사용자 지침은 별도로 고정 표시한다.
3. **대기 이유와 다음 행동**: 의존 작업, 쓰기 충돌, 예산, 계정 제한, 질문 대기를 구체적으로 표시하고 기존 재개·답변·중단 동작으로 연결한다.
4. **변경된 가지의 재검증**: 요구사항 revision·대상 diff·의존 파일·설정·lockfile·검증 명령과 도구 버전이 같은 결과만 재사용한다. 의존 범위가 불명확하면 보수적으로 무효화한다.
5. **실행 비교**: 같은 작업에서 문맥 정책·코드 지도·출력 필터의 유무에 따른 토큰·완료 시간·재시도·품질을 비교한다.
6. **절약·균형·검증 중심 설정**: 사용자가 선택한 모델과 책임 범위 안에서 문맥·검증·병렬 정책을 묶는다. 독립 검증과 중요한 제약을 보존한다.

[RouteLLM](https://github.com/lm-sys/RouteLLM/blob/0b64fdafe049e596a3f5657c219329f24af24198/README.md)은 모델 라우팅의 평가 구조를 참고할 수 있다. 확인한 저장소의 최근 push는 2024년 8월이며 예시 모델·벤치마크도 당시 구성이다. 현재 CLI 구독·모델에 바로 적용할 기본 라우터로 두기보다, 사용자 역할 설정과 실제 코딩 평가를 바탕으로 후속 실험에 사용한다.

## 개발 우선순위와 완료 조건

| 순서 | 작업                                | 변경 위치                                     | 완료 조건                                                                         |
| ---- | ----------------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------- |
| 1    | 문맥별 토큰 표시와 역할별 입력 예산 | 문맥 조합·contracts·기존 진단 화면            | 한국어·코드·특수 토큰의 계수 상태 구분, 필수 지침 보존, 출력 여유와 초과 표시     |
| 2    | 오케스트라 비용·시간·대기 원인 연결 | 사용량 조회·공유 client runtime·작업 목록     | 원장 합계와 노드별 합계 일치, 재시도·재연결 중복 없음, partial 유지               |
| 3    | 회의 실패 예산 영속화               | 협업 reactor·이벤트·projection                | 재시작 후 횟수 유지, 사용자 응답이 허용한 추가 시도만 실행                        |
| 4    | 작업별 코드 지도                    | 프로젝트 파일 조회·문맥 조합                  | 수정·삭제 시 갱신, 관련 파일 선택, 구현 확인에 원문 사용, 성공 작업당 사용량 비교 |
| 5    | 명령 출력 축소 시범 적용            | 직접 관리하는 실행 경로·provider별 capability | CMD 인자·한글·종료 코드 보존, 실패 진단 복원, 원문 재조회 포함 총사용량 개선      |
| 6    | 느린 클라이언트의 전송 예산         | WebSocket·contracts·모든 클라이언트           | 과부하·재연결 후 이벤트 정합성, 다른 연결의 진행 보존, 메모리·입력 지연 측정      |
| 7    | 실행 중 예산 예약과 배정 이유       | 기존 스케줄링·사용량 제한                     | 동시 배정·취소·미보고·재시작에서 예약 누수와 중복 없음                            |
| 8    | 상태 메모와 선택적 요약             | Main·회의·artifact 경로                       | 결정·반대·미해결·근거 보존, 요약·추가 조회 비용을 포함한 개선                     |

화면·계약 변경은 웹·데스크톱·모바일과 원격 연결에 함께 반영한다. 새로운 문맥·출력 제어는 제공자별 지원 여부를 정하고, 지원되는 경로에서 선택적으로 검증한다. 구현·빌드·안정성 확인은 격리 작업공간에서 진행한 뒤 기존 프로그램을 교체하는 순서를 유지한다.

## 효과를 판정할 실험

토큰 처리량, 제공자의 캐시 내역과 실제 비용, CPU·메모리·전송량을 각각 측정한다. 정확한 집계 개선과 실제 입력 축소의 효과도 각각 기록한다. 모델·추론 설정·제공자 버전·코드 기준점·완료 조건을 맞추고, 같은 변경 묶음에서 한 기능씩 비교한다.

대표 작업은 한국어 요구사항을 포함한 작은 수정, 여러 파일 변경, 긴 테스트 실패 로그, 다수 의존 결과를 가진 graph, 질문 대기 후 재개, 중단·재시작, 느린 원격 연결이다. 각 실험에는 다음을 기록한다.

- 완료 작업당 입력·출력·캐시, 요약·검증·실패·추가 조회까지 포함한 사용량.
- 완료 시간, 도구 호출·재시도 수, 큐 대기, 모델별 계측 범위.
- 요구사항 충족, 놓친 제약, 테스트 결과, 독립 검증, 수동 재작업.
- 새 세션과 캐시가 남은 세션의 결과, 미보고·부분 보고 상태.

실패한 작업의 비용도 남긴다. 압축률이나 출력 글자 수만으로 성공을 판정하지 않는다. 결과가 안정적인 기능부터 기본값 후보로 올린다.

## 소스 기준과 구성 요소 조건

상세 링크는 다음 commit에 고정했다. branch의 최신 기능과 설치된 릴리즈의 지원 범위는 구현 시 대조한다.

| 저장소                                    | 확인한 commit  |
| ----------------------------------------- | -------------- |
| rtk-ai/rtk                                | `0508e11297c1` |
| Aider-AI/aider                            | `5dc9490bb35f` |
| yamadashy/repomix                         | `55c6de6aebde` |
| anomalyco/opencode                        | `328f74c2131a` |
| mastra-ai/mastra                          | `6bfa29c6b776` |
| aaif-goose/goose                          | `01fa5dfe9ee1` |
| microsoft/LLMLingua                       | `5a4c78ae18ab` |
| bytedance/deer-flow                       | `a63856f690e1` |
| OpenHands/software-agent-sdk              | `75105bd40936` |
| google/adk-js                             | `0f3e5f22b374` |
| microsoft/agent-framework                 | `0cc867d966da` |
| open-telemetry/semantic-conventions-genai | `f3c6d0c9bb66` |
| langfuse/langfuse                         | `bc1ade0aacca` |
| xtermjs/xterm.js                          | `991857a1b1ca` |
| lm-sys/RouteLLM                           | `0b64fdafe049` |

Mastra의 일반 코드는 Apache-2.0이며 `ee/` 등 별도 조건의 경로가 있다. Langfuse도 MIT 영역과 별도 `ee/` 경로를 구분한다. RTK의 구성별 조건은 앞에서 구분했다. 실제 재사용 파일의 조건을 기준으로 구성 요소를 선택한다. [Mastra 조건](https://github.com/mastra-ai/mastra/blob/6bfa29c6b77645fb680bde7db1c7323529dedd7d/LICENSE.md), [Langfuse 조건](https://github.com/langfuse/langfuse/blob/bc1ade0aacca75104bad934e92d70a454ec16e67/LICENSE)
