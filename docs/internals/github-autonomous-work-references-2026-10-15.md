# AI가 자동으로 업무를 처리하게 만드는 GitHub 자료와 NewAutoUsage 적용안

2026년 10월 15일 조사. GitHub의 19개 저장소를 문서·구현·관련 테스트로 비교했다. 아래 출처는 확인한 커밋에 고정했다. 기본 브랜치의 구현과 정식 배포 버전은 다를 수 있으며, 외부 프로젝트를 직접 실행해 성능을 비교한 결과는 아니다.

**NewAutoUsage에는 외부 작업 접수 → 저장된 업무 양식 선택 → 필요할 때 AI 실행 → 결과 검증 → 후속 작업으로 이어지는 기능을 우선 추가하는 것이 적합하다.** 이미 있는 예약·실행 프로필·오케스트라·검증·복구 기능을 연결하면 된다. 일반 반복 업무에는 OpenClaw·Hermes·nanobot·Goose, 개발 업무에는 Symphony·GitHub Agentic Workflows·OpenHands Automation이 특히 참고할 만하다. 이 우선순위와 적용안은 현재 로컬 구현을 비교한 판단이다.

## 현재 기반과 추가할 기능

| 영역        | 현재 확인한 기능                                                               | 다음으로 확장할 부분                                                      |
| ----------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| 작업 시작   | 일회·주기·매일·협업 완료 후 예약, 결정적인 실행 ID, 같은 예약의 중복·겹침 처리 | GitHub 이슈·웹훅·파일 변화 등 외부 이벤트를 프로젝트별 작업으로 접수      |
| 재사용      | 버전이 있는 실행 프로필, 모델·역할·병렬 수·worktree·공통 지침·검증 명령        | 업무별 입력·출력 스키마, 사전 확인, 결과 전달 조건을 갖춘 업무 양식       |
| 실행과 복구 | 작업 그래프, 시도 기록, 사용자 질문 대기, 제한된 복구, 전달 여부 불명 상태     | 외부 이벤트·실행·외부 변경의 식별자를 연결하고 재시작 뒤 대조             |
| 완료 판정   | AI 응답 완료와 검증 근거, 실제 명령의 종료 코드·대상 커밋을 구분               | 업무별 최종 결과 확인: 생성 파일 내용, 외부 대상 상태, 처리된 이벤트 버전 |
| 비용        | 작업·시도별 사용량, 토큰 제한과 잠정·미확인 집계                               | AI를 생략한 실행 수, 검증된 완료 건당 사용량, 재시도·검증 포함 비용       |

로컬 근거는 [실행 프로필과 후속 예약](../user/execution-profiles-and-follow-ups.md), [예약 시점 계산](../../apps/server/src/orchestration/workspaceSchedule.ts), [예약 실행과 중복 처리](../../apps/server/src/orchestration/Layers/WorkspaceSchedulerReactor.ts), [개발 실행 상태](../../apps/server/src/orchestration/WorkspaceDevelopment.ts), [복구 정책](../../apps/server/src/orchestration/workspaceDevelopmentRecovery.ts), [자동화 결과 판정](../user/automation-results.md)이다. 따라서 외부 프레임워크의 예약기나 그래프 엔진을 통째로 추가하기보다, 기존 서버의 명령·이벤트·SQLite 원장에 업무 접수와 결과 판정을 연결하는 편이 작다.

[앞선 토큰·오케스트라 조사](github-token-and-orchestra-optimization-2026-10-15.md)는 당시 코드 기준의 제안이다. 이후 적용한 문맥 토큰 추정·선택 예산, 노드별 사용량·대기 사유, 회의 실패 횟수의 재시작 보존을 이번 신규 개발 목록에 다시 넣지 않는다.

## 일반 업무 자동화에서 우선 볼 자료

| 저장소                       | 확인한 기능                                                           | NewAutoUsage에 가져올 부분                                  | 도입 형태                 |
| ---------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------- |
| [OpenClaw][openclaw]         | 시간 예약·상시 점검·외부 이벤트의 구분, SQLite 실행 기록, 재시작 복구 | 자동화 종류와 실행 문맥·결과 전달 계약, 전달 불명 상태 처리 | TypeScript 구조 참고      |
| [Hermes Agent][hermes]       | 예약 작업의 사전 스크립트, AI 없이 실행, 이전 작업 결과 입력          | 변화 확인은 스크립트로 처리하고 판단이 필요할 때만 AI 호출  | 동작을 기존 예약에 적용   |
| [nanobot][nanobot]           | 외부 트리거의 영속 대기열, 세션이 바쁠 때 대기, 전달 상태             | 프로젝트별 외부 작업 접수함과 재시작 후 전달 추적           | 작은 구현을 참고          |
| [Goose][goose]               | 매개변수·출력 스키마·검증 명령·재시도 조건을 갖춘 recipe              | 기존 실행 프로필에 업무 입력·산출물·성공 조건 연결          | 업무 양식 설계 참고       |
| [Activepieces][activepieces] | 앱 연결·이벤트 흐름, 중복 필터와 대기 작업 재개                       | 외부 서비스의 이벤트를 접수함에 연결하는 어댑터             | 필요 시 별도 연결 서비스  |
| [Browser Use][browser-use]   | 브라우저 조작, 구조화된 결과, 단계·실패 제한                          | API가 없는 웹 업무의 선택 실행 도구                         | Python 실행기를 별도 연결 |

### OpenClaw: 언제 시작하고 어디에 결과를 남기는가

현재 자동화 문서는 정확한 시간의 예약, 주기적 상황 점검, 외부 웹훅, 내부 수명주기 hook을 구분한다. 예약 정의·실행 이력은 공유 SQLite에 저장한다. 시작할 때 밀린 작업을 조절하고, 누락된 모든 주기를 한꺼번에 AI 작업으로 재생하지 않는다. [자동화 개요][openclaw-automation], [예약 동작][openclaw-cron]

재시작 때 해당 실행의 종료 결과를 정확히 찾으면 결과를 복원하며 작업·전달을 다시 하지 않는다. 종료 증거가 없으면 중단·전달 불명으로 남기는 경로가 있다. 이 선택은 불확실한 외부 변경의 반복을 피하지만 일부 실행을 놓칠 수 있다. NewAutoUsage도 이미 있는 `delivery_unknown`에 외부 작업 식별자와 결과 대조를 연결하는 것이 적합하다. [재시작 규칙][openclaw-cron]

오래된 설명과 현재 구현을 구분해야 한다. 현재 문서는 Shared Tasks ledger·TaskFlow orchestration API·TaskFlow Webhooks plugin이 제거됐다고 명시한다. 이 항목을 현재 지원 기능으로 삼아 연결을 설계하지 않는다. [현재 자동화 개요][openclaw-automation]

### Hermes: AI 호출을 생략할 수 있는 자동화

예약 작업은 `script`의 표준 출력을 에이전트 문맥으로 넣을 수 있고, `no_agent`에서는 스크립트 자체가 전체 작업이다. `context_from`은 선행 작업의 최근 결과를 입력으로 연결한다. 실행기에는 AI를 생성하지 않는 경로와 비어 있는 출력 등의 전달 억제 조건도 있다. [작업 정의][hermes-jobs], [예약 실행기][hermes-scheduler]

적용 예시는 GitHub의 새 커밋·이슈 개수나 문서 폴더의 해시를 먼저 비교하는 것이다. 변화가 없으면 완료 기록만 남기고, 변화가 있으면 해당 차이만 AI에 준다. 단순 복사·형식 변환·개수 집계처럼 성공 기준이 명확한 업무도 스크립트로 끝낼 수 있다. 예상 절감률을 정하기보다 생략한 호출 수와 작업 전체 사용량을 측정한다.

Hermes의 실행 신원에는 작업 ID와 개별 실행 ID, 시작 원인과 예약 시점이 분리돼 있다. 이 구분을 외부 접수 이벤트와 NewAutoUsage 실행 ID 사이에 적용하면 반복 예약의 여러 실행을 같은 일로 오인하지 않는다. [실행 신원][hermes-identity]

### nanobot: 외부 작업을 받아 대기시키는 최소 구조

로컬 트리거는 영속 대기열에 쌓이며 gateway 시작과 대상 세션의 유휴 상태를 기다린다. 실행 중인 대화에 새 작업을 바로 끼워 넣지 않는 구조다. 전달 보장은 최소 한 번(at-least-once)이므로, 실행 중 장애가 나면 동일 작업이 다시 전달될 수 있다. 작업이 에이전트에 도달한 뒤 실패한 경우는 실패로 기록하는 등 재시도 경계도 구분한다. [자동화와 전달 의미][nanobot-automations], [세션 전달 구현][nanobot-delivery]

문서상 예약의 누락 시점은 재시작 뒤 모두 재생하지 않는다. interval과 wall-clock cron의 의미도 다르다. 로컬 트리거는 내장 공개 웹훅 수신기가 아니며, 외부 이벤트를 넣을 어댑터가 별도로 필요하다. 대기열은 gateway에 설정된 작업공간을 기준으로 하므로 현재 선택한 화면의 프로젝트와 혼동해서도 안 된다. [범위와 재시작 동작][nanobot-automations]

NewAutoUsage에는 `(환경, 이벤트 출처, 외부 이벤트 ID)`의 중복 접수 방지와 명시적인 프로젝트·스레드 대상이 적합하다. 접수의 중복 방지와 실제 파일·외부 서비스 변경의 중복 방지는 별도 문제로 다룬다.

### Goose: 매번 긴 지시를 쓰지 않는 업무 양식

recipe에 매개변수와 `response.json_schema`, 최대 turn 수, 성공 확인 명령, 최대 재시도, 실패 후 명령을 담는다. 입력·출력·검증을 함께 저장하는 구조가 유용하다. 다만 확인한 재시도는 초기 메시지 이력으로 되돌리는 방식이므로, NewAutoUsage의 완료 노드 재사용·부분 복구와 그대로 같지는 않다. [recipe 명세][goose-recipes], [재시도 구현][goose-retry]

적용할 양식은 ‘이슈 수정’, ‘문서 조사’, ‘파일 정리’, ‘변경 감시’ 정도로 작게 시작한다. 각 양식은 기존 프로필 버전에 연결하고 입력 필드, 출력 파일·스키마, 실제 확인 명령, 실행·재시도 예산을 저장한다. 예제의 명령은 대상 프로젝트에 맞게 검토하며 프로세스 이름을 묶어 종료하는 명령은 가져오지 않는다.

### Activepieces와 Browser Use: 실제 앱을 다루는 경계

Activepieces는 앱 연결과 흐름 구성의 참고 자료다. 확인한 중복 필터는 키가 있을 때 Redis에 30초 동안 저장하는 방식이며, 영구적인 중복 실행 방지는 아니다. 대기 작업 재개 구현과 테스트는 callback 도착 순서가 뒤바뀌는 경우를 다룬다. NewAutoUsage에는 이 경합 사례와 실행별 대조를 가져올 가치가 있다. [중복 필터][activepieces-dedupe], [재개 구현][activepieces-resume], [재개 테스트][activepieces-resume-tests]

라이선스는 루트 전체를 단순 MIT로 취급하면 안 된다. 일반 영역은 MIT이지만 `packages/ee/`와 서버의 EE 경로는 별도 조건이다. 전체 실행 엔진을 데스크톱에 넣기보다는 필요한 연결을 별도 서비스나 어댑터로 검토한다. [라이선스 범위][activepieces-license]

Browser Use는 API가 없는 웹에서 정보를 읽거나 파일을 받는 선택 도구다. 로컬 Python 라이브러리와 클라우드 서비스는 구분한다. 특히 `AgentHistoryList.is_successful()`은 마지막 결과에 에이전트가 기록한 성공 값을 읽는다. 이 값 하나로 실제 업무 완료를 증명할 수는 없다. 내려받은 파일의 형식·내용·행 수, 대상 화면의 변경 상태 등을 별도로 확인해야 한다. [실행 구조][browser-use], [성공 값 구현][browser-use-views]

## 개발 업무를 자동으로 처리하는 자료

| 저장소                                       | 확인한 기능                                                                    | NewAutoUsage 적용안                                       | 조건                                                          |
| -------------------------------------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------- | ------------------------------------------------------------- |
| [Symphony][symphony]                         | 이슈를 작업으로 배정, 작업공간 격리, 동시 실행 제한, 상태 대조와 재시도        | GitHub 이슈를 받아 격리된 수정 후보·테스트 결과까지 생성  | 참고 구현은 Linear·Elixir 중심인 engineering preview          |
| [GitHub Agentic Workflows][gh-aw]            | Markdown 업무 정의를 Actions로 컴파일, 제한된 결과 출력, 완료와 전달 결과 구분 | CI 실패 분석·이슈 분류·정기 점검, 검증된 결과당 비용 집계 | GitHub Actions 실행 및 선택 엔진 인증 필요                    |
| [OpenHands Automation][openhands-automation] | cron·웹훅·실행 이력·배정·sandbox 수명주기                                      | 자동화 관리와 에이전트 실행의 책임 분리                   | Beta, Python·PostgreSQL 기반 별도 서비스                      |
| [OpenHands SDK][openhands-sdk]               | 로컬·원격 실행, 대화 저장과 복원 예제                                          | 실행 상태 저장과 실행기 경계 비교                         | TypeScript 클라이언트가 로컬 Python 엔진을 대체하는 것은 아님 |

Symphony는 이슈별 작업공간과 작업 계약, 배정 전후 상태 대조가 핵심이다. 다만 재시작 복구는 tracker와 파일시스템을 다시 읽는 방식이며, 메모리의 실행 세션·재시도 타이머를 그대로 복구하는 시스템은 아니다. 현재 참고 구현의 셸·제공자 전제도 NewAutoUsage의 Windows CMD·여러 제공자 어댑터와 다르다. 이슈 접수·점유·격리 규칙을 가져오고 실행은 현재 서버가 맡는 편이 적합하다. [설계 명세][symphony-spec]

GitHub Agentic Workflows는 YAML frontmatter가 있는 Markdown에서 실행 정의를 만들고 `.lock.yml`로 컴파일한다. 기본 에이전트 작업은 읽기 중심이며, 허용한 결과 변경은 별도 출력 처리로 실행한다. 사용자 정의 작업 등 예외가 있어 모든 구성에 쓰기가 불가능하다는 뜻은 아니다. [실행 구조][gh-aw-how]

현재 work queue 명세는 Git에 기록한 작업·시도별 claim·용량 reservation을 구분한다. 특히 에이전트가 완료를 제출한 시점과 실제 결과가 전달돼 확인된 시점을 구분한다. outcome 문서도 산출물 존재만으로 성공을 인정하기보다 실제 수용·거절·대기·미확인 결과를 추적한다. NewAutoUsage의 검증 영수증에 외부 대상의 확인 결과를 연결하고, 비용을 검증된 완료 건으로 나누는 데 가장 유용한 참고다. [작업 대기열][gh-aw-queue], [결과 판정][gh-aw-outcomes]

OpenHands Automation은 언제 실행할지와 실행 이력·배정·sandbox 관리를 소유하고, SDK·Agent Server가 에이전트의 도구와 대화를 실행한다. 이 책임 구분은 기존 NewAutoUsage 예약기·오케스트라·제공자 어댑터와 비교할 만하다. 별도 Python·PostgreSQL 서비스를 그대로 추가할 필요가 있는지는 원격 실행 규모가 커졌을 때 판단한다. [저장소 경계와 Beta 상태][openhands-automation], [SDK][openhands-sdk], [대화 저장 예제][openhands-persistence]

## 함께 확인한 나머지 자료

| 저장소                                | 유용한 참고                                            | 적용 판단과 한계                                                                                                                                            |
| ------------------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [LangGraph][langgraph]                | 완료 단계 결과의 재사용, 중단·재개                     | 기존 그래프·SQLite에 동작 적용. 확인한 `InMemorySaver` 예제 자체는 프로세스 재시작 영속 저장소가 아님. [예제][langgraph-func]                               |
| [Temporal TypeScript SDK][temporal]   | 장시간 작업의 heartbeat, 진행 상태와 취소 처리         | 원격 worker 확장 시 참고. 실제 운영에는 Temporal 서비스가 추가됨. [Activity 동작][temporal-activity]                                                        |
| [Microsoft Agent Framework][ms-agent] | 질문 대기 상태를 포함한 checkpoint·재수화              | 기존 질문·답변 및 복구 흐름과 비교. Python·.NET 기반. [예제][ms-agent-checkpoint]                                                                           |
| [CrewAI][crewai]                      | 작업별 checkpoint, 완료 단계 건너뛰기, 이력 분기       | 자동 checkpoint 실패를 기록하고 계속하는 best-effort 정책은 중요한 배정 기록에 그대로 적용하지 않음. [정책][crewai-checkpoint]                              |
| [mini-swe-agent][mini-swe]            | 작은 실행 루프, trajectory, 단계·시간·관측 비용 제한   | 실행기 비교용 기준. 요청 전 누적 비용 검사만으로 요청 중 비용까지 엄격히 차단한다고 볼 수 없음. [루프][mini-swe-loop]                                       |
| [Superpowers][superpowers]            | 계획의 작업 분리, 완료 전 실제 검증 증거               | 업무 양식의 성공 조건과 단계별 작업 절차에 참고. [검증 원칙][superpowers-verification]                                                                      |
| [DeerFlow][deerflow]                  | 하위 작업의 결과·근거·미해결 사항 계약, 용량 제한      | 기존 오케스트라 보고 형식 보강용. [보고 계약][deerflow-report], [용량 관리][deerflow-capacity]                                                              |
| [OpenFang][openfang]                  | 도구·설정·절차를 묶은 Hands 업무 패키지                | ‘설치해서 고르는 업무’의 구성 참고. README가 pre-1.0과 변경 가능성을 명시하며, 확인한 마지막 push는 2026-07-02. [연구 업무 manifest][openfang-hand]         |
| [n8n][n8n]                            | 서비스 연결·시각 흐름, 실행 복구와 중단 후 재개 테스트 | 필요 시 외부 연결 서비스로 비교. MIT·Apache와 다른 Sustainable Use License 및 별도 EE 조건을 확인해야 함. [라이선스][n8n-license], [복구 테스트][n8n-crash] |

checkpoint를 저장했다는 사실만으로 외부 API 요청이나 파일 변경을 정확히 한 번 실행한다고 결론낼 수는 없다. 완료된 내부 단계의 재사용과 외부 변경의 확인을 함께 설계해야 한다. 위 비교는 현재 구현에서 보강할 경계를 찾는 참고 자료로 사용한다.

## 적용 우선순위와 완료 기준

### 1. 외부 작업 접수함

첫 연결 대상으로 GitHub 이슈·수동 API 중 하나를 선택하고, 접수 항목에 환경·프로젝트·이벤트 출처·외부 ID·원문 해시·접수 시점·선택한 양식 버전을 저장한다. 기존 예약도 같은 작업 접수 명령으로 연결하되 현재 예약 ID·중복 처리 의미를 유지한다. 실행 가능 여부와 취소·보류·실패 이유를 클라이언트에서 확인하고 다시 진행할 수 있게 한다.

완료 기준은 동일 이벤트 중복 수신 시 하나의 접수만 만들어지고, 재시작해도 대상 프로젝트·대기 상태가 유지되며, 실행 중인 세션에는 정책에 따라 대기하는 것이다. 이벤트 내용이 바뀐 재실행은 기존 기록을 덮지 않고 새 입력 버전으로 추적한다. 접수 중복 방지와 실행 시도·외부 변경의 확인에는 각각 다른 ID를 둔다.

### 2. 버전이 있는 업무 양식

기존 실행 프로필에 업무 입력 스키마, 산출물 경로·출력 스키마, 사전 확인 명령, 실제 성공 확인 명령, 실패 때 처리와 최대 실행 예산을 연결한다. 먼저 이슈 수정·변경 조사·파일 처리 세 양식으로 시작한다. 각 접수는 등록 당시 양식·프로필 버전을 보존한다. 재시도는 기존 실패 예산과 부분 복구를 사용한다.

완료 기준은 필수 입력이 빠진 접수가 실행되지 않고, 결과 스키마와 실제 산출물 검사가 함께 통과하며, 양식을 수정해도 대기 중인 작업의 조건이 바뀌지 않는 것이다. 작업의 성공 판정과 현재 활성 프로그램 교체는 분리된 단계로 둔다.

### 3. AI를 부르기 전의 변화 확인

출처의 revision·ETag·파일 해시·처리한 이벤트 ID를 먼저 비교한다. 새 정보가 없으면 `변화 없음`으로 종료하고, 새 정보가 있으면 변경분과 관련 근거만 AI에 전달한다. 집계·파일 변환처럼 규칙만으로 끝나는 업무에는 AI 생략 실행을 제공한다.

완료 기준은 변화 없는 실행에서 모델 호출이 없고, 확인 스크립트 실패를 ‘변화 없음’으로 오인하지 않으며, 입력이 바뀐 실행에는 바뀐 자료가 들어가는 것이다. 시간 비교만으로 새 자료를 놓치지 않게 출처별 버전 의미를 정한다.

### 4. 외부 변경의 결과 확인과 중단 후 복구

파일 생성·서비스 변경·결과 전달을 시도할 때 실행 ID와 변경 ID를 기록한다. 외부 대상이 idempotency key를 지원하면 사용하고, 지원하지 않으면 원격 ID나 파일 해시 등으로 결과를 대조한다. 응답을 받기 전에 프로세스가 끊겼다면 기존 `delivery_unknown` 정책과 연결해 확인한 뒤 재시도한다. 취소는 요청과 실제 중단 확인을 구분한다.

완료 기준은 성공 응답 직전·직후 중단 시에도 같은 외부 변경이 무조건 반복되지 않고, 확인 불가능한 결과가 성공·실패로 단정되지 않는 것이다. 파일 존재만으로 통과시키지 않고 해당 실행의 내용·버전과 일치하는지 확인한다.

### 5. 변화 감시와 완료 건당 비용

반복 조사·점검은 변화가 있을 때만 요약을 만들고, 결과는 실행 기록·파일·앱 화면 등 지정한 위치에 남긴다. 외부 메시지 전송을 선택하는 경우에도 업무별 전달 조건과 대상을 명시한다. 화면에는 접수·대기·실행·확인·완료를 보여 주며 취소·실패·결과 미확인으로 분기한다.

측정할 값은 AI 호출 생략 수, 검증된 완료율, 재실행·중복 접수 수, 결과 미확인 수, 완료까지 걸린 시간, 검증된 완료 건당 토큰·비용이다. 재시도와 검증 사용량도 같은 작업에 포함하고, 제공자가 보고하지 않은 수치를 0으로 취급하지 않는다.

## 실제로 구성할 만한 자동 업무

| 업무                         | 시작 조건과 처리                                                                                    | 완료 증거                                                                                              |
| ---------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| GitHub 이슈 수정 후보 만들기 | 지정한 저장소·라벨의 이슈 접수 → 재현 → 격리 작업공간 수정 → 관련 테스트·후보 빌드 → 검증 결과 저장 | 해당 이슈와 후보 커밋, 테스트 종료 코드, 빌드 결과, 산출물 해시. 프로그램 교체는 별도 안정성 확인 단계 |
| 문서 폴더의 새 자료 정리     | 새 파일·변경 해시 감지 → 텍스트 추출 → 필요한 부분만 AI 분류·정리 → 정해진 형식으로 저장            | 입력 해시, 필수 필드·행 수·출력 스키마 검사, 원본과 결과 대응                                          |
| 매일 GitHub 조사 갱신        | 감시 저장소의 새 release·commit·issue만 수집 → 기존 결과와 비교 → 관련 변경만 요약                  | 출처 revision·링크, 변경분 목록, 결과 문서. 변화가 없으면 AI 호출 생략                                 |
| 정기 상태 점검               | HTTP·포트·파일·로그를 규칙으로 검사 → 실패한 항목만 AI 분석 → 조치 후보와 확인 명령 저장            | 실제 상태 응답과 진단 로그, 재확인 결과. 정상 검사 자체는 스크립트로 종료                              |

향후 구현은 사용자 지시대로 별도 후보 프로그램에 먼저 적용하고 빌드·검증·안정성 확인을 거쳐 교체한다. 현재 문서는 그 구현을 선택하기 위한 조사 결과이며, 외부 프레임워크의 실행 성능이나 실제 업무 성공률을 검증한 기록과 구분한다.

## 확인한 저장소와 revision

GitHub 공개 메타데이터, 기본 브랜치 HEAD, 소스 트리를 확인하고 관련 문서·코드·테스트를 읽었다. 19개 저장소 모두 확인 시점에 archived 상태는 아니었다. 활동 날짜·별 개수만으로 안정성을 판정하지 않았으며, Python·.NET·Rust 실행기는 현재 TypeScript 제공자 어댑터와의 연결 비용도 고려했다. 별도 라이브러리·클라우드 실행기의 인증과 과금이 기존 제공자 CLI 로그인에 포함된다고 가정하지 않는다.

| 저장소                       | 확인한 커밋                                                                                                     |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------- |
| aaif-goose/goose             | [`dd17bf2021f3`](https://github.com/aaif-goose/goose/tree/dd17bf2021f3fb3b326c471593c352e1b0d62bbd)             |
| activepieces/activepieces    | [`f370253250a8`](https://github.com/activepieces/activepieces/tree/f370253250a85dd01803eb173ff5815ea80a30c3)    |
| browser-use/browser-use      | [`c75e8476e26d`](https://github.com/browser-use/browser-use/tree/c75e8476e26d18b7617643bc2ae082fae8eae431)      |
| bytedance/deer-flow          | [`c994826d0690`](https://github.com/bytedance/deer-flow/tree/c994826d0690d3d1c6b3af21f460b2ca5e73a2d3)          |
| crewAIInc/crewAI             | [`aa5f2acd9b48`](https://github.com/crewAIInc/crewAI/tree/aa5f2acd9b48782b6b6a756bcef24cc54ac0530b)             |
| github/gh-aw                 | [`b99bdc40f25e`](https://github.com/github/gh-aw/tree/b99bdc40f25ed5f7cf94821059279c79de8c45a9)                 |
| HKUDS/nanobot                | [`1d43b46e5470`](https://github.com/HKUDS/nanobot/tree/1d43b46e547010bda6fd88af747ea8dab853475c)                |
| langchain-ai/langgraph       | [`5eb60aef6f38`](https://github.com/langchain-ai/langgraph/tree/5eb60aef6f3837a1fb632a8abc6cf8e8da81785b)       |
| microsoft/agent-framework    | [`0cc867d966da`](https://github.com/microsoft/agent-framework/tree/0cc867d966daa2891c191204b1c9b7a4ff0e7619)    |
| n8n-io/n8n                   | [`e2529a849432`](https://github.com/n8n-io/n8n/tree/e2529a849432bdb3082615c04b1702df61cb91d5)                   |
| NousResearch/hermes-agent    | [`0ab8010b3c21`](https://github.com/NousResearch/hermes-agent/tree/0ab8010b3c211ff323fd8602ff0fbdfc4d96cb1b)    |
| obra/superpowers             | [`bb92a7774141`](https://github.com/obra/superpowers/tree/bb92a77741419a4ab5f06e711a283343f1ada0c3)             |
| openai/symphony              | [`be10a1b79df7`](https://github.com/openai/symphony/tree/be10a1b79df723d6d7612b5651c8522704dafb2e)              |
| openclaw/openclaw            | [`159e4a53b3c8`](https://github.com/openclaw/openclaw/tree/159e4a53b3c8697de65957c9038fdc0afc251a6d)            |
| OpenHands/automation         | [`3d0943593a29`](https://github.com/OpenHands/automation/tree/3d0943593a29d90bd0273404c86a768ae0b9cb0a)         |
| OpenHands/software-agent-sdk | [`8efff8d3cf1a`](https://github.com/OpenHands/software-agent-sdk/tree/8efff8d3cf1a5a3fcf7ce5e3b97c7f00684d9547) |
| RightNow-AI/openfang         | [`acf2587e46be`](https://github.com/RightNow-AI/openfang/tree/acf2587e46be174c10200489c9a2d23a39a98aeb)         |
| SWE-agent/mini-swe-agent     | [`04d809ceab9d`](https://github.com/SWE-agent/mini-swe-agent/tree/04d809ceab9df28f9adaed044884180159172930)     |
| temporalio/sdk-typescript    | [`046dcef5e3d5`](https://github.com/temporalio/sdk-typescript/tree/046dcef5e3d5d08710c4a07d805f17fea41e5ae5)    |

[openclaw]: https://github.com/openclaw/openclaw/blob/159e4a53b3c8697de65957c9038fdc0afc251a6d/README.md
[openclaw-automation]: https://github.com/openclaw/openclaw/blob/159e4a53b3c8697de65957c9038fdc0afc251a6d/docs/automation/index.md
[openclaw-cron]: https://github.com/openclaw/openclaw/blob/159e4a53b3c8697de65957c9038fdc0afc251a6d/docs/automation/cron-jobs/how-it-works.md
[hermes]: https://github.com/NousResearch/hermes-agent/blob/0ab8010b3c211ff323fd8602ff0fbdfc4d96cb1b/README.md
[hermes-jobs]: https://github.com/NousResearch/hermes-agent/blob/0ab8010b3c211ff323fd8602ff0fbdfc4d96cb1b/cron/jobs.py
[hermes-scheduler]: https://github.com/NousResearch/hermes-agent/blob/0ab8010b3c211ff323fd8602ff0fbdfc4d96cb1b/cron/scheduler.py
[hermes-identity]: https://github.com/NousResearch/hermes-agent/blob/0ab8010b3c211ff323fd8602ff0fbdfc4d96cb1b/cron/execution_identity.py
[nanobot]: https://github.com/HKUDS/nanobot/blob/1d43b46e547010bda6fd88af747ea8dab853475c/README.md
[nanobot-automations]: https://github.com/HKUDS/nanobot/blob/1d43b46e547010bda6fd88af747ea8dab853475c/docs/automations.md
[nanobot-delivery]: https://github.com/HKUDS/nanobot/blob/1d43b46e547010bda6fd88af747ea8dab853475c/nanobot/cron/session_delivery.py
[goose]: https://github.com/aaif-goose/goose/blob/dd17bf2021f3fb3b326c471593c352e1b0d62bbd/README.md
[goose-recipes]: https://github.com/aaif-goose/goose/blob/dd17bf2021f3fb3b326c471593c352e1b0d62bbd/documentation/docs/guides/recipes/recipe-reference.md
[goose-retry]: https://github.com/aaif-goose/goose/blob/dd17bf2021f3fb3b326c471593c352e1b0d62bbd/crates/goose/src/agents/state_machine/ops_retry.rs
[activepieces]: https://github.com/activepieces/activepieces/blob/f370253250a85dd01803eb173ff5815ea80a30c3/README.md
[activepieces-dedupe]: https://github.com/activepieces/activepieces/blob/f370253250a85dd01803eb173ff5815ea80a30c3/packages/server/api/src/app/trigger/dedupe-service.ts
[activepieces-resume]: https://github.com/activepieces/activepieces/blob/f370253250a85dd01803eb173ff5815ea80a30c3/packages/server/api/src/app/waitpoints/resume-service.ts
[activepieces-resume-tests]: https://github.com/activepieces/activepieces/blob/f370253250a85dd01803eb173ff5815ea80a30c3/packages/server/api/test/integration/ce/flows/flow-run/resume-service.test.ts
[activepieces-license]: https://github.com/activepieces/activepieces/blob/f370253250a85dd01803eb173ff5815ea80a30c3/LICENSE
[browser-use]: https://github.com/browser-use/browser-use/blob/c75e8476e26d18b7617643bc2ae082fae8eae431/README.md
[browser-use-views]: https://github.com/browser-use/browser-use/blob/c75e8476e26d18b7617643bc2ae082fae8eae431/browser_use/agent/views.py
[symphony]: https://github.com/openai/symphony/blob/be10a1b79df723d6d7612b5651c8522704dafb2e/README.md
[symphony-spec]: https://github.com/openai/symphony/blob/be10a1b79df723d6d7612b5651c8522704dafb2e/SPEC.md
[gh-aw]: https://github.com/github/gh-aw/blob/b99bdc40f25ed5f7cf94821059279c79de8c45a9/README.md
[gh-aw-how]: https://github.com/github/gh-aw/blob/b99bdc40f25ed5f7cf94821059279c79de8c45a9/docs/src/content/docs/introduction/how-they-work.mdx
[gh-aw-queue]: https://github.com/github/gh-aw/blob/b99bdc40f25ed5f7cf94821059279c79de8c45a9/docs/src/content/docs/reference/work-queue.md
[gh-aw-outcomes]: https://github.com/github/gh-aw/blob/b99bdc40f25ed5f7cf94821059279c79de8c45a9/docs/src/content/docs/reference/outcomes.md
[openhands-automation]: https://github.com/OpenHands/automation/blob/3d0943593a29d90bd0273404c86a768ae0b9cb0a/README.md
[openhands-sdk]: https://github.com/OpenHands/software-agent-sdk/blob/8efff8d3cf1a5a3fcf7ce5e3b97c7f00684d9547/README.md
[openhands-persistence]: https://github.com/OpenHands/software-agent-sdk/blob/8efff8d3cf1a5a3fcf7ce5e3b97c7f00684d9547/examples/01_standalone_sdk/10_persistence.py
[langgraph]: https://github.com/langchain-ai/langgraph/blob/5eb60aef6f3837a1fb632a8abc6cf8e8da81785b/README.md
[langgraph-func]: https://github.com/langchain-ai/langgraph/blob/5eb60aef6f3837a1fb632a8abc6cf8e8da81785b/libs/langgraph/langgraph/func/__init__.py
[temporal]: https://github.com/temporalio/sdk-typescript/blob/046dcef5e3d5d08710c4a07d805f17fea41e5ae5/README.md
[temporal-activity]: https://github.com/temporalio/sdk-typescript/blob/046dcef5e3d5d08710c4a07d805f17fea41e5ae5/packages/activity/src/index.ts
[ms-agent]: https://github.com/microsoft/agent-framework/blob/0cc867d966daa2891c191204b1c9b7a4ff0e7619/README.md
[ms-agent-checkpoint]: https://github.com/microsoft/agent-framework/blob/0cc867d966daa2891c191204b1c9b7a4ff0e7619/dotnet/samples/03-workflows/Checkpoint/CheckpointWithHumanInTheLoop/WorkflowFactory.cs
[crewai]: https://github.com/crewAIInc/crewAI/blob/aa5f2acd9b48782b6b6a756bcef24cc54ac0530b/README.md
[crewai-checkpoint]: https://github.com/crewAIInc/crewAI/blob/aa5f2acd9b48782b6b6a756bcef24cc54ac0530b/docs/edge/en/concepts/checkpointing.mdx
[mini-swe]: https://github.com/SWE-agent/mini-swe-agent/blob/04d809ceab9df28f9adaed044884180159172930/README.md
[mini-swe-loop]: https://github.com/SWE-agent/mini-swe-agent/blob/04d809ceab9df28f9adaed044884180159172930/src/minisweagent/agents/default.py
[superpowers]: https://github.com/obra/superpowers/blob/bb92a77741419a4ab5f06e711a283343f1ada0c3/README.md
[superpowers-verification]: https://github.com/obra/superpowers/blob/bb92a77741419a4ab5f06e711a283343f1ada0c3/skills/verification-before-completion/SKILL.md
[deerflow]: https://github.com/bytedance/deer-flow/blob/c994826d0690d3d1c6b3af21f460b2ca5e73a2d3/README.md
[deerflow-report]: https://github.com/bytedance/deer-flow/blob/c994826d0690d3d1c6b3af21f460b2ca5e73a2d3/backend/packages/harness/deerflow/subagents/report_contract.py
[deerflow-capacity]: https://github.com/bytedance/deer-flow/blob/c994826d0690d3d1c6b3af21f460b2ca5e73a2d3/backend/packages/harness/deerflow/subagents/capacity.py
[openfang]: https://github.com/RightNow-AI/openfang/blob/acf2587e46be174c10200489c9a2d23a39a98aeb/README.md
[openfang-hand]: https://github.com/RightNow-AI/openfang/blob/acf2587e46be174c10200489c9a2d23a39a98aeb/crates/openfang-hands/bundled/researcher/HAND.toml
[n8n]: https://github.com/n8n-io/n8n/blob/e2529a849432bdb3082615c04b1702df61cb91d5/README.md
[n8n-license]: https://github.com/n8n-io/n8n/blob/e2529a849432bdb3082615c04b1702df61cb91d5/LICENSE.md
[n8n-crash]: https://github.com/n8n-io/n8n/blob/e2529a849432bdb3082615c04b1702df61cb91d5/packages/@n8n/agents/src/runtime/__tests__/crash-resume.test.ts
