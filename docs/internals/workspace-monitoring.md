# 프로그램 모니터링 모드

> 메인테이너용 문서입니다. 사용자에게 보이는 동작은 [프로그램 모니터링 모드](../user/program-monitoring.md)에 설명되어 있습니다.

모니터링은 프로젝트 프로그램 운영 위에 얹힌 상시 루프입니다. 새 집계나 테이블을 만들지 않고, 프로젝트 행의 `workspaceControl.monitoring` 블롭 하나와 리액터 하나로 동작합니다.

## 영속 모델

`WorkspaceMonitoringSettings`(`packages/contracts/src/orchestration.ts`)가 `WorkspaceControlSettings.monitoring`에 `withDecodingDefault`로 붙어 있습니다. 마이그레이션은 없습니다. 사람이 편집하는 필드(`enabled`, `autonomy`, `checkIntervalSec`, `aiTurnBudget`)와 루프가 기록하는 필드(`threadId`, `plan`, `planStatus`, `turnLog`, `lastCheckedAt`)가 함께 들어 있어 서버를 재시작해도 같은 스레드·계획·예산으로 이어집니다.

턴의 `inputOrigin`은 프로젝션에 저장되지 않으므로 예산은 `turnLog`(최근 24시간의 자동 턴 시각, 최대 60개)로 계산합니다.

## 명령과 이벤트

모니터링 명령은 모두 기존 이벤트 `project.workspace-control-updated` 하나로 나갑니다. 새 이벤트 타입이나 프로젝터는 없습니다.

- `project.workspace-control.update`에 `monitoring` 필드가 추가됐습니다. 생략하면 기존 값을 유지합니다. `plan`을 함께 넘기면 사람이 쓴 계획이므로 `approved`로 저장합니다.
- `project.monitoring.plan.approve`(클라이언트): `proposed` 상태에서만, 카드가 들고 있던 `revision`이 현재와 같을 때만 통과합니다.
- `project.monitoring.reanalyze`(클라이언트): `planStatus`를 `none`으로 돌립니다. 이전 계획은 새 제안이 올 때까지 남습니다.
- `project.monitoring.plan.propose`(내부): AI가 낸 계획을 `proposed`로 저장하고 `revision`을 올립니다.
- `project.monitoring.runtime.update`(내부): `threadId`, `turnLog`, `lastCheckedAt`을 patch합니다. `planStatus: "stale"`은 `approved`일 때만 적용됩니다.
- `thread.delete`가 모니터링 스레드를 지우면 decider가 두 번째 이벤트로 `threadId`를 비웁니다.

## 리액터

`Layers/WorkspaceMonitoringReactor.ts`는 `WorkspaceSchedulerReactor`의 골격(start/tick/drain, 뮤텍스, `forkParked`)을 따릅니다. `OrchestrationReactor`에서 프로그램 감시기 다음에 시작합니다.

비용 규칙은 `subscribeWorkspaceRuntime` 폭주를 고친 날(2026-08-21)의 교훈입니다.

- 도메인 이벤트는 인메모리 플래그만 바꿉니다(켜진 프로젝트 집합, 프로그램 집합 변경 → `stale`). 평가는 5초 기본 tick에서 프로젝트별 `checkIntervalSec`이 지난 것만 합니다.
- 신호는 pull입니다. `ResourceTelemetry.latest`(켜진 프로젝트가 있을 때만 구독을 잡고 마지막 off에서 놓음), 프로그램 run의 `pid`와 `consecutiveHealthFailures`, 미해결 장애.
- 링버퍼(`workspaceMonitoringTrends.ts`의 `SampleRing`)는 대상×지표마다 240개. 기울기·p95 비교·임계치는 순수 함수라 Effect 없이 테스트합니다.
- 이상은 `targetIndex|metric|direction` 핑거프린트로 dedupe하고, 같은 이상의 재보고는 30분(또는 지표 창이 더 길면 그 길이)마다로 제한합니다. 예산이 없거나 `autoDiagnosis` 권한이 꺼져 있으면 turn 대신 `monitoring.finding.held` 활동을 시간당 1회만 남깁니다.

## 스레드 프로토콜

스레드 생성과 턴 시작은 `WorkspaceProgramSupervisor.diagnoseIncident`와 같습니다: 운영 진단→총괄 조정 역할 바인딩의 모델, `runtimeMode "approval-required"`, `interactionMode "plan"`, `inputOrigin "automation"`, `OrchestrationTurnWait.waitForSettledTurn`.

제안 턴은 `workspaceMonitoring.ts`의 `[T3_MONITORING_PLAN]…[/T3_MONITORING_PLAN]` 블록으로 끝나야 합니다. `parseMonitoringPlan`은 마지막 블록을 엄격하게 디코드하고 인덱스 범위를 검사합니다. 실패하면 `monitoring.proposal.unparsed` 활동을 남길 뿐 자동 재시도하지 않습니다(재시도는 예산을 씁니다).

"행동 전 질문"은 별도 장치가 없습니다. 제공자 어댑터가 이미 질문 도구를 `user-input.requested` 활동으로 올리고 모바일 푸시까지 이어지므로, 프롬프트가 질문 도구를 쓰라고 지시할 뿐입니다. 플레이북은 AI가 아니라 서버가 턴 시작 전에 기존 명령(`project.program.start/stop/restart`, `project.program.incident.repair.request`)으로 실행합니다. 그래서 자율 행동은 전부 이벤트 로그에 남습니다.

## 권한

`WorkspaceProgramPermissions.monitoringAutoActions`(기본 false)가 플레이북 실행을 막습니다. 자동 턴 자체는 기존 `autoDiagnosis`가 게이트입니다. 서버 전역 `ServerSettings.selfMonitoring { enabled, projectId }`는 T3 Code 자체 감시 대상을 어느 프로젝트의 스레드로 보낼지 정합니다(2단계).

## T3 Code 자체 감시

`apps/server/src/diagnostics/ServerSelfSignals.ts`가 프로세스 전역 싱글턴으로 두 신호를 모읍니다: `perf_hooks.monitorEventLoopDelay`(읽을 때 p99 ms를 돌려주고 리셋)와 분 단위 링(60칸)에 쌓는 느린(≥1초)·실패 span 수. `Observability.ts`가 서버 트레이서의 싱크를 감싸 `recordSpan`을 호출합니다 — span당 정수 증가 두 번이라 항상 켜 둡니다. 브라우저 span은 탭하지 않습니다.

리액터는 `self-server` 대상의 `latency`를 이벤트 루프 p99 ms로, `slow-spans`를 분당 느린 span 수로 읽고, `cpu`/`memory`는 텔레메트리의 `server`/`server-child` 카테고리 합으로 읽습니다. `self-desktop`은 `electron-*` 카테고리 합이며 데스크톱이 호스트가 아니면 자연히 비어 있습니다.

수신 프로젝트는 `ServerSettings.selfMonitoring { enabled, projectId }`(설정 → 권한 → T3 Code 자체 감시)로 정합니다. `projectId`가 null이면 모니터링이 켜진 프로젝트 중 id 정렬 첫 번째가 받습니다. 제안 프롬프트는 이 프로젝트에서만 self 대상을 넣으라고 지시합니다.

## 코드 변경 후 회귀

계획에 `regression` 지표가 있을 때만, 평가마다 최대 1분에 한 번 `VcsStatusBroadcaster.refreshLocalStatus(workspaceRoot)`로 브랜치·작업 트리 지문을 만듭니다(파일 감시 없음 — Windows 재귀 감시와 이벤트 폭주를 피하기 위해 폴링). 지문이 직전 폴링과 다르면 프로젝트 프로그램들의 `integrity.validationCommands` 합집합을 `ProcessRunner`로 실행합니다. 리액터 전역 `Semaphore(1)`로 한 번에 하나만, 항상 백그라운드 fork, 명령당 10분 타임아웃. 결과(실패 수, stderr 꼬리)는 인메모리에 남아 다음 평가의 `regression` 샘플이 되고, 통과/실패는 `monitoring.regression.*` 활동으로 스레드에 남습니다. 검증 명령이 하나도 없으면 아무것도 추측하지 않습니다.

## URL·프로그램 응답 지연

`url` 대상의 `health`/`latency`와 `program` 대상의 `latency`는 평가마다 HTTP GET 1회(5초 제한, 동시 4개)로 잽니다. 프로그램은 등록된 HTTP 상태검사 URL을 씁니다. 연속 실패 횟수가 health 샘플, 성공 시 왕복 ms가 latency 샘플입니다. 지표가 그 URL을 읽지 않으면 프로브하지 않습니다.

샘플 링은 `targetIndex|metric|프로세스 식별자`로 키를 잡습니다. 프로그램이 재시작되면(pid 변경) 새 링으로 시작해, 이전 프로세스의 부재와 새 프로세스의 초기 메모리가 섞여 "분당 1MB 증가"로 읽히던 오탐이 사라집니다. 라이브 검증에서 실제로 한 번 발생했던 사례입니다.

## 모바일

`apps/mobile/src/features/threads/MonitoringPlanCard.tsx`가 모니터링 스레드에서 `planStatus === "proposed"`일 때 컴포저 위에 승인 카드를 띄우고 `projectEnvironment.approveWorkspaceMonitoringPlan`을 보냅니다. 질문(`user-input.requested`)은 기존 카드와 푸시 경로를 그대로 씁니다.

## 아직 없는 것

- `process` 대상은 텔레메트리 사이드카가 추적하는 프로세스 트리(서버가 띄운 것 + Electron) 안의 PID만 읽습니다. 트리 밖의 임의 PID를 `ResourceTelemetry.setExternalProcesses`에 가산 등록하는 경로는 아직 없습니다(현재 유일 호출자가 Electron PID를 교체 방식으로 넘김).
