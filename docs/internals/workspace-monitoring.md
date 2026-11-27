# 프로그램 모니터링 모드

> 메인테이너용 문서입니다. 사용자에게 보이는 동작은 [프로그램 모니터링 모드](../user/program-monitoring.md)에 설명되어 있습니다.

모니터링은 프로젝트 프로그램 운영 위에 얹힌 상시 루프입니다. 새 집계나 테이블을 만들지 않고, 프로젝트 행의 `workspaceControl.monitoring` 블롭 하나와 리액터 하나로 동작합니다.

## 영속 모델

`WorkspaceMonitoringSettings`(`packages/contracts/src/orchestration.ts`)가 `WorkspaceControlSettings.monitoring`에 `withDecodingDefault`로 붙어 있습니다. 기존 설정은 호환되며, 대기 발견과 조치 이력은 SQLite 마이그레이션 090·091의 별도 저널에 저장합니다. 사람이 편집하는 필드(`enabled`, `autonomy`, `checkIntervalSec`, `aiTurnBudget`)와 루프가 기록하는 필드(`threadId`, `plan`, `planStatus`, `turnLog`, `lastCheckedAt`)가 함께 들어 있어 서버를 재시작해도 같은 스레드·계획·예산으로 이어집니다.

턴의 `inputOrigin`은 프로젝션에 저장되지 않으므로 예산은 `turnLog`(최근 24시간의 자동 턴 시각, 최대 60개)로 계산합니다.

## 명령과 이벤트

모니터링 명령은 모두 기존 이벤트 `project.workspace-control-updated` 하나로 나갑니다. 새 이벤트 타입이나 프로젝터는 없습니다.

- `project.workspace-control.update`에 `monitoring` 필드가 추가됐습니다. 생략하면 기존 값을 유지합니다. `plan`을 함께 넘기면 사람이 쓴 계획이므로 `approved`로 저장합니다.
- `project.monitoring.plan.approve`(클라이언트): `proposed` 상태에서만, 카드가 들고 있던 `revision`이 현재와 같을 때만 통과합니다.
- `project.monitoring.reanalyze`(클라이언트): `planStatus`를 `none`으로 돌립니다. 이전 승인 계획을 `activePlan`으로 보존해 새 계획 승인 전까지 관찰에 사용합니다.
- `project.monitoring.plan.propose`(내부): 현재 재분석 세대와 일치하는 AI 제안만 `proposed`로 저장하고 `revision`을 올립니다. 이전 요청의 늦은 응답은 거부합니다.
- `project.monitoring.runtime.update`(내부): `threadId`, `turnLog`, `lastCheckedAt`을 patch합니다. 프로그램 구성 변경은 기존 계획을 stale로 표시하고 이전 제안 세대를 무효화합니다.
- `thread.delete`가 모니터링 스레드를 지우면 decider가 두 번째 이벤트로 `threadId`를 비웁니다.

## 리액터

`Layers/WorkspaceMonitoringReactor.ts`는 `WorkspaceSchedulerReactor`의 골격(start/tick/drain, 뮤텍스, `forkParked`)을 따릅니다. `OrchestrationReactor`에서 프로그램 감시기 다음에 시작합니다.

비용 규칙은 `subscribeWorkspaceRuntime` 폭주를 고친 날(2026-08-21)의 교훈입니다.

- 도메인 이벤트는 인메모리 플래그만 바꿉니다(켜진 프로젝트 집합, 프로그램 집합 변경 → `stale`). 평가는 5초 기본 tick에서 프로젝트별 `checkIntervalSec`이 지난 것만 합니다.
- 신호는 pull입니다. `ResourceTelemetry.latest`(켜진 프로젝트가 있을 때만 구독을 잡고 마지막 off에서 놓음), 프로그램 run의 `pid`와 `consecutiveHealthFailures`, 미해결 장애.
- 링버퍼(`workspaceMonitoringTrends.ts`의 `SampleRing`)는 대상×지표마다 240개. 기울기·p95 비교·임계치는 순수 함수라 Effect 없이 테스트합니다.
- 이상은 `targetIndex|metric|direction` 핑거프린트로 dedupe하고, 같은 이상의 재보고는 30분(또는 지표 창이 더 길면 그 길이)마다로 제한합니다. 예산이 없거나 `autoDiagnosis` 권한이 꺼져 있으면 turn 대신 `monitoring.finding.held` 활동을 시간당 1회만 남깁니다.
- AI 진단과 새 계획 제안·승인 대기 중에도 마지막 승인 계획으로 표본을 수집합니다. 발견은 전달 전에 발생 ID와 함께 SQLite 저널에 기록하며 서버 재시작이나 계획 변경 후에도 전달 전 발견을 복구합니다. 같은 지표의 별도 발생은 다른 ID로 보존하고, 해당 진단에서 확인된 ID만 저널에서 지웁니다. 제안·승인 대기 또는 기존 계획이 stale인 동안은 관찰만 하고 자동 플레이북을 실행하지 않습니다. 자동 조치는 현재도 발생 중인 이상과 현재 설정을 확인한 뒤 실행합니다. 서버 중단 시간은 관찰되지 않으며, AI 응답 저장과 발견 확인 사이에 종료되면 복구 후 중복 진단될 수 있습니다.

## 스레드 프로토콜

스레드 생성과 턴 시작은 `WorkspaceProgramSupervisor.diagnoseIncident`와 같습니다: 운영 진단→총괄 조정 역할 바인딩의 모델, `runtimeMode "approval-required"`, `interactionMode "plan"`, `inputOrigin "automation"`, `OrchestrationTurnWait.waitForSettledTurn`.

감시 턴의 응답은 요청 시각과 저장된 턴의 원본 입력 메시지 ID가 모두 일치할 때만 사용합니다. 식별을 확인하지 못하면 이전 또는 다른 요청의 응답을 감시 결과로 사용하지 않습니다.

제안 턴은 `workspaceMonitoring.ts`의 `[T3_MONITORING_PLAN]…[/T3_MONITORING_PLAN]` 블록으로 끝나야 합니다. `parseMonitoringPlan`은 마지막 블록을 엄격하게 디코드하고 인덱스 범위를 검사합니다. 실패하면 `monitoring.proposal.unparsed` 활동을 남길 뿐 자동 재시도하지 않습니다(재시도는 예산을 씁니다).

AI 행동 블록은 제안으로 기록하며, 사용자 선택의 증거로 간주해 프로그램을 실행하지 않습니다. 명시적 프로그램 제어는 기존 제어센터 경로로 수행합니다. 허용된 플레이북은 AI가 아니라 서버가 턴 시작 전에 기존 명령(`project.program.start/stop/restart`, `project.program.incident.repair.request`)으로 실행합니다. 그래서 자율 행동은 전부 이벤트 로그에 남습니다.

## 권한

`WorkspaceProgramPermissions.monitoringAutoActions`(기본 false)가 플레이북 실행을 막습니다. 자동 턴 자체는 기존 `autoDiagnosis`가 게이트입니다. 서버 전역 `ServerSettings.selfMonitoring { enabled, projectId }`는 T3 Code 자체 감시 대상을 어느 프로젝트의 스레드로 보낼지 정합니다(2단계).

## T3 Code 자체 감시

`apps/server/src/diagnostics/ServerSelfSignals.ts`가 프로세스 전역 싱글턴으로 두 신호를 모읍니다: `perf_hooks.monitorEventLoopDelay`(읽을 때 p99 ms를 돌려주고 리셋)와 초 단위 링(3,601칸)에 쌓는 느린(≥1초)·실패 span 수. 각 창의 오래된 경계는 1초 미만 더 포함될 수 있습니다. `Observability.ts`가 서버 트레이서의 싱크를 감싸 `recordSpan`을 호출합니다 — span당 정수 증가 두 번이라 항상 켜 둡니다. 브라우저 span은 탭하지 않습니다.

리액터는 `self-server` 대상의 `latency`를 이벤트 루프 p99 ms로, `slow-spans`와 `failed-spans`를 각 지표의 설정된 창에서 분당 느린 span·실패 span 수로 읽고, `cpu`/`memory`는 텔레메트리의 `server`/`server-child` 카테고리 합으로 읽습니다. `self-desktop`은 `electron-*` 카테고리 합이며 데스크톱이 호스트가 아니면 자연히 비어 있습니다. 실패 span은 내부 추적 단위이므로 하나의 오류가 여러 번 집계될 수 있고, 사용자가 요청한 작업의 실패 건수와 같지 않습니다.

이벤트 루프 히스토그램은 해당 지연 지표를 실제로 평가할 때만 읽고 같은 tick에서 공유합니다. 서로 다른 주기로 평가되는 여러 프로젝트의 지연 창을 독립적으로 보존하지는 않습니다.

기존 OTLP 지표를 명시적으로 설정한 경우 기억 검색의 횟수·성공/실패·시간(`t3_memory_searches_total`, `t3_memory_search_duration`)과 검색 결과 유무(`t3_memory_search_results_total`)도 내보냅니다. 검색어·기억 본문·프로젝트 식별자는 지표 속성에 넣지 않습니다. 검색 결과 유무는 검색 품질이나 기억의 정확성 판정이 아닙니다. `t3_provider_turn_duration`은 모델 전체 응답 시간이 아니라 제공자에 요청을 전달하는 호출 시간입니다. OTLP를 자동으로 켜거나 외부 수집기를 시작하지 않습니다.

수신 프로젝트는 `ServerSettings.selfMonitoring { enabled, projectId }`(설정 → 권한 → T3 Code 자체 감시)로 정합니다. `projectId`가 null이면 모니터링이 켜진 프로젝트 중 id 정렬 첫 번째가 받습니다. 제안 프롬프트는 이 프로젝트에서만 self 대상을 넣으라고 지시합니다.

## 코드 변경 후 회귀

계획에 `regression` 지표가 있을 때만, 평가마다 최대 1분에 한 번 `VcsStatusBroadcaster.refreshLocalStatus(workspaceRoot)`로 브랜치·작업 트리 지문을 만듭니다(파일 감시 없음 — Windows 재귀 감시와 이벤트 폭주를 피하기 위해 폴링). 지문이 직전 폴링과 다르면 프로젝트 프로그램들의 `integrity.validationCommands` 합집합을 `ProcessRunner`로 실행합니다. 리액터 전역 `Semaphore(1)`로 한 번에 하나만, 항상 백그라운드 fork, 명령당 10분 타임아웃. 결과(실패 수, stderr 꼬리)는 인메모리에 남아 다음 평가의 `regression` 샘플이 되고, 통과/실패는 `monitoring.regression.*` 활동으로 스레드에 남습니다. 검증 명령이 하나도 없으면 아무것도 추측하지 않습니다.

## URL·프로그램 응답 지연

`url` 대상의 `health`/`latency`와 `program` 대상의 `latency`는 평가마다 HTTP GET 1회(5초 제한, 동시 4개)로 잽니다. 프로그램은 등록된 HTTP 상태검사 URL을 씁니다. 연속 실패 횟수가 health 샘플, 성공 시 왕복 ms가 latency 샘플입니다. 지표가 그 URL을 읽지 않으면 프로브하지 않습니다.

샘플 링은 `targetIndex|metric|프로세스 식별자`로 키를 잡습니다. 프로그램이 재시작되면(pid 변경) 새 링으로 시작해, 이전 프로세스의 부재와 새 프로세스의 초기 메모리가 섞여 "분당 1MB 증가"로 읽히던 오탐이 사라집니다. 라이브 검증에서 실제로 한 번 발생했던 사례입니다.

## 모바일

`apps/mobile/src/features/threads/MonitoringPlanCard.tsx`가 모니터링 스레드에서 `planStatus === "proposed"`일 때 컴포저 위에 승인 카드를 띄우고 `projectEnvironment.approveWorkspaceMonitoringPlan`을 보냅니다. 질문(`user-input.requested`)은 기존 카드와 푸시 경로를 그대로 씁니다.

## 트리 밖 `process` 대상

텔레메트리 사이드카는 루트(서버 + 외부 루트)의 하위 트리만 샘플링하므로, 승인된 계획의 `process` 대상(pid, 선택적 startTimeMs)은 루트로 등록돼야 보입니다. 리액터가 매 tick 끝에 모든 프로젝트의 `process` 대상을 합쳐 `ResourceTelemetry.setMonitoredProcesses`로 넘기고(변경 시에만), 마지막 모니터가 꺼지면 빈 목록을 넘깁니다. `ResourceTelemetry`는 데스크톱의 Electron 루트와 모니터링 루트를 따로 들고 있다가 합집합을 사이드카의 교체식 `setExternalProcesses`에 보내므로, 한쪽이 바뀌어도 다른 쪽이 떨어지지 않습니다. 사이드카가 startTimeMs로 PID 재사용을 걸러 줍니다.

등록된 루트와 그 하위는 카테고리 `external`로 분류돼 backend/allT3 집계와 자체 감시(`self-server`, `self-desktop`) 사용량에 섞이지 않습니다.

## 상태검사 실패 사유

`WorkspaceProgramRun.lastHealthFailure`(`reason` + `detail` + `elapsedMs`)가 마지막 실패를 기록합니다. `timeout`인데 실제 경과가 한도보다 1.5초 이상 더 길면 감시 서버의 이벤트 루프가 멈춰 있던 것이므로 `inconclusive`로 남기고 연속 실패 횟수에 넣지 않습니다(dev 빌드 버스트 때 나던 오탐). 장애 증거와 런타임 요약 digest에 사유가 그대로 들어가 AI가 가설 대신 사실로 판정합니다.

## 감시 AI 선택과 로그 대상 (2026-08-22)

`WorkspaceMonitoringUserSettings.modelSelection`(null = 역할 바인딩 폴백)이 감시 스레드 생성과 모든 automation 턴의 모델을 정합니다(`pickMonitoringModel`). `log` 대상(`path`, `patterns`)은 리액터의 `tailLogs`가 매 평가마다 Effect `FileSystem`으로 오프셋 이후만 읽어(최대 1MB/틱, 첫 관측은 오프셋만 기록, 축소 시 0으로) 패턴에 맞는 줄을 `ProjectMonitor.logs`에 한 시간/200줄까지 보관합니다. `log-matches` 지표는 창 안의 줄 수이며 threshold 평가에서 health처럼 "최신 값"으로 판정합니다. 발견 프롬프트에는 마지막 8줄이 인용됩니다. 웹은 프로젝트의 `monitoring.threadId`로 감시 스레드를 식별해 사이드바 고정(눈 아이콘)과 다른 대화의 "감시 AI 새 보고" 배너(`hasUnseenCompletion` 또는 pending user input)를 그립니다.
