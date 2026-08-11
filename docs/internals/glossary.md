# 용어집

> 메인테이너용 문서입니다. T3 Code를 사용 중이신가요? [docs/user](../user/)를 참고하세요.

T3 Code를 위해 계속 갱신되는 용어집입니다. 이 코드베이스에서 자주 쓰는 용어가 어떤 뜻인지 설명합니다.

## 목차

- [프로젝트와 작업 공간](#프로젝트와-작업-공간)
- [대화 타임라인](#대화-타임라인)
- [오케스트레이션](#오케스트레이션)
- [제공자 런타임](#제공자-런타임)
- [체크포인트 관리](#체크포인트-관리)

## 개념

### 프로젝트와 작업 공간

#### 프로젝트

앱에서 최상위 프로젝트를 나타내는 레코드입니다. [오케스트레이션 컨트랙트][1]에서 프로젝트는 `workspaceRoot`와 제목을 가집니다. 프로젝트는 대화를 포함하지 않습니다: `OrchestrationProject`와 `OrchestrationThread`는 읽기 모델에서 서로 다른 배열이며, 프로젝트에 대화가 하나도 없을 수 있습니다. [workspace-layout.md][2]를 참고하세요.

#### 프로젝트 루트

프로젝트의 루트 파일시스템 경로입니다. [오케스트레이션 모델][1]에서는 브랜치와 선택적인 워크트리의 기준 디렉터리입니다. [workspace-layout.md][2]를 참고하세요.

#### 워크트리

대화 전용으로 격리된 작업 공간으로 사용하는 Git 워크트리입니다. [컨트랙트][1]에서 대화에 `worktreePath`가 있으면 메인 워킹 트리가 아니라 그곳에서 실행됩니다. Git 작업은 `apps/server/src/vcs/VcsDriver.ts`의 VCS 드라이버 컨트랙트 뒤에 있으며, [GitVcsDriverCore.ts][3]가 구현합니다.

### 대화 타임라인

#### 대화

대화 내용과 프로젝트 이력을 담는 주된 영속 단위입니다. [오케스트레이션 컨트랙트][1]에서 대화는 메시지, 활동, 체크포인트, 세션 관련 상태를 보관합니다. [projector.ts][4]를 참고하세요.

#### 턴

대화 안에서 사용자로부터 어시스턴트까지 이어지는 작업 주기 하나입니다. 사용자 입력으로 시작해 세션이 `running` 상태를 벗어날 때 끝나며, [projector.ts][4]는 이를 완료를 판정하는 기준 신호(`settledTurnStateForSessionStatus`)로 취급합니다. 체크포인트와 diff 작업은 그 뒤에 마무리될 수 있지만 턴이 끝난 시점을 바꾸지는 않습니다. [컨트랙트][1]와 [ProviderRuntimeIngestion.ts][5]를 참고하세요.

#### 활동

대화에 붙는, 사용자에게 보이는 로그 항목입니다. [컨트랙트][1]에서 활동은 승인, 도구 동작, 실패처럼 메시지가 아닌 중요한 이벤트를 담습니다. 활동은 [projector.ts][4]에서 대화 상태로 프로젝션됩니다.

### 오케스트레이션

오케스트레이션은 런타임 활동을 안정적인 앱 상태로 바꾸는 서버 쪽 도메인 계층입니다. 주요 진입점은 [OrchestrationEngine.ts][7]이고, 핵심 로직은 [decider.ts][8]과 [projector.ts][4]에 있습니다.

#### 애그리게이트

명령이나 이벤트가 속하는 도메인 객체입니다. [컨트랙트][1]에서는 보통 `project` 또는 `thread`입니다. [decider.ts][8]을 참고하세요.

#### 명령

도메인 상태를 바꾸려는, 타입이 정의된 요청입니다. [컨트랙트][1]에서 명령은 [commandInvariants.ts][9]에서 검증되고 [decider.ts][8]에 의해 이벤트로 바뀝니다.
예로는 `thread.create`, `thread.turn.start`, `thread.checkpoint.revert`가 있습니다.

#### 도메인 이벤트

이미 일어난 일을 영속적으로 남긴 사실입니다. [컨트랙트][1]에서 이벤트는 진실의 기준이며, 이벤트가 어떻게 적용되는지는 [projector.ts][4]에 나와 있습니다.
예로는 `thread.created`, `thread.message-sent`, `thread.turn-diff-completed`가 있습니다.

#### Decider(명령을 이벤트로 바꾸는 순수 함수)

명령과 현재 상태를 이벤트로 바꾸는 순수 오케스트레이션 로직입니다. 핵심 구현은 [decider.ts][8]에 있고, 사전 조건은 [commandInvariants.ts][9]에 있습니다.

#### 프로젝션

이벤트에서 파생된, 읽기에 최적화된 뷰입니다. [projector.ts][4], [ProjectionPipeline.ts][11], [ProjectionSnapshotQuery.ts][10]을 참고하세요.

#### Projector(이벤트에서 읽기 모델을 만드는 부분)

도메인 이벤트를 읽기 모델이나 프로젝션 테이블에 적용하는 로직입니다. [projector.ts][4]와 [ProjectionPipeline.ts][11]을 참고하세요.

#### 읽기 모델

오케스트레이션 상태를 현재 시점으로 구체화한 뷰입니다. [컨트랙트][1]에서 읽기 모델은 프로젝트, 대화, 메시지, 활동, 체크포인트, 세션 상태를 담습니다. [ProjectionSnapshotQuery.ts][10]과 [OrchestrationEngine.ts][7]을 참고하세요.

#### Reactor(후속 작업을 처리하는 워커)

이벤트나 런타임 신호 이후의 후속 작업을 처리하는, 부수 효과를 일으키는 서비스입니다. 예로는 [CheckpointReactor.ts][6], [ProviderCommandReactor.ts][12], [ProviderRuntimeIngestion.ts][5]가 있습니다.

#### 프로젝트 협업 실행

프로젝트 목표 하나를 위한 영속적인 멀티 에이전트 실행입니다. 새 실행은 의존성 그래프를 갖지만, 작업 그래프 지원 이전에 만들어진 실행은 이전 방식의 선형 단계를 유지합니다. 런타임은 [WorkspaceCollaborationReactor.ts][25]가 조정합니다. [workspace-collaboration.md][27]를 참고하세요.

#### 작업 그래프

프로젝트 협업 실행 안에 있는 영속적인 방향 비순환 그래프입니다. 작업에는 범위가 지정된 인계 하나, 의존성, 논리 에이전트 경로 배정, 상한이 있는 시도 횟수, 출력, 신뢰도, 검증 상태가 담깁니다. 순수한 파싱, 그래프 구체화, 준비된 작업 경계 계산, 순환 검사는 [workspaceTaskGraph.ts][26]에 있습니다.

#### 페이블, 코덱스, 그록 논리 에이전트

새로운 제공자 드라이버가 아니라 협업 그래프의 역할입니다. 페이블은 조정자이자 검증자, 코덱스는 구현 담당, 그록은 최신 정보 조사 담당입니다. 프로젝트 역할 연결은 이 논리 에이전트들을 기존 제공자 인스턴스로 연결합니다. [workspace-collaboration.md][27]를 참고하세요.

#### Receipt(작업 완료를 알리는 기록)

`checkpoint.baseline.captured`, `checkpoint.diff.finalized`, `turn.processing.quiesced`처럼 비동기 마일스톤이 완료될 때 발행되는, 타입이 정의된 신호입니다. receipt는 테스트 전용 장치입니다: 프로덕션의 `RuntimeReceiptBusLive` 발행은 아무 동작도 하지 않으며 테스트 계층만 PubSub으로 뒷받침됩니다. 프로덕션 동작을 receipt 위에 만들지 마세요. [RuntimeReceiptBus.ts][13]과 [CheckpointReactor.ts][6]을 참고하세요.

#### Quiesced

"Quiesced"는 턴이 조용하고 안정된 상태가 되었다는 뜻입니다. 즉 [CheckpointReactor.ts][6] 같은 후속 작업이 마무리된 상태입니다. 이 값은 [receipt 스키마][13]에 나타나므로 실제로는 프로덕션 신호라기보다 테스트가 기다리는 대상입니다.

### 제공자 런타임

실행 중인 백엔드 에이전트 구현과 그 이벤트 스트림입니다. 주요 서비스는 [ProviderService.ts][14], 어댑터 컨트랙트는 [ProviderAdapter.ts][15]이며, 개요는 [providers.md][16]에 있습니다.

#### 제공자

실제 작업을 수행하는 백엔드 에이전트 런타임입니다. 드라이버 다섯 개가 기본 내장됩니다: Codex, Claude, Cursor, Grok, OpenCode. [ProviderService.ts][14], [ProviderAdapter.ts][15]과 대표적인 어댑터인 [CodexAdapter.ts][17]을 참고하세요.

#### 세션

대화에 붙어 있는, 제공자가 뒷받침하는 실행 중 런타임입니다. 세션의 형태는 [오케스트레이션 컨트랙트][1]에 있고, 수명 주기는 [ProviderService.ts][14]에서 관리합니다.

#### 런타임 모드

대화나 세션의 안전·접근 모드입니다. [컨트랙트][1]는 값 네 개를 정의합니다: `approval-required`, `auto-accept-edits`, `auto`, `full-access`. [권한 모드][18]를 참고하세요.

#### 상호작용 모드

대화의 에이전트 상호작용 방식입니다. [컨트랙트][1]에서 값은 `default`와 `plan`입니다.

#### 어시스턴트 전달 모드

어시스턴트 텍스트가 대화 타임라인에 도달하는 방식을 제어합니다. [컨트랙트][1]에서 `streaming`은 점진적으로 갱신하고 `buffered`는 텍스트를 누적합니다. 버퍼링된 전달은 턴이 끝날 때까지 들고 있지 않습니다. 누적된 텍스트가 24,000자를 넘게 되는 시점에 쏟아내며, 승인과 사용자 입력 경계에서도 비웁니다. [ProviderRuntimeIngestion.ts][5]를 참고하세요.

#### 스냅샷

특정 시점의 상태 뷰입니다. 이 단어는 오케스트레이션, 제공자, 체크포인트 관리 등 여러 계층에서 쓰입니다. [ProjectionSnapshotQuery.ts][10], [ProviderAdapter.ts][15], [CheckpointStore.ts][19]를 참고하세요.

### 체크포인트 관리

체크포인트 관리는 시간에 따라 프로젝트 상태를 캡처해 앱이 턴을 diff하고 이전 지점으로 복원할 수 있게 합니다. 주요 구성 요소는 [CheckpointStore.ts][19], [CheckpointDiffQuery.ts][20], [CheckpointReactor.ts][6]입니다.

#### 체크포인트

특정 턴 시점의 대화 작업 공간을 저장한 스냅샷입니다. 실제로는 [CheckpointStore.ts][19]의 숨겨진 Git ref와 [ProjectionCheckpoints.ts][21]에서 프로젝션된 요약으로 이뤄집니다. 캡처와 수명 주기 작업은 [CheckpointReactor.ts][6]에서 이뤄집니다.

#### 체크포인트 ref

파일시스템 체크포인트의 영속 식별자이며 Git ref로 저장됩니다. [컨트랙트][1]에 타입이 정의되어 있고, [Utils.ts][22]에서 만들어지며, [CheckpointStore.ts][19]가 사용합니다.

#### 체크포인트 기준점

대화 타임라인을 diff할 때 시작점이 되는 체크포인트입니다. 이 흐름은 [RuntimeReceiptBus.ts][13]을 통해 드러나고, [CheckpointReactor.ts][6]에서 조정되며, [Utils.ts][22]가 뒷받침합니다.

#### 체크포인트 diff

체크포인트 두 개 사이의 패치 차이입니다. 조회 로직은 [CheckpointDiffQuery.ts][20]에, diff 파싱은 [Diffs.ts][23]에 있으며, 마무리는 [CheckpointReactor.ts][6]이 조정합니다.

#### 턴 diff

턴 하나의 파일 패치와 변경 파일 요약입니다. 보통 [CheckpointDiffQuery.ts][20]에서 계산하고, [컨트랙트][1]에 표현되며, [projector.ts][4]가 대화 상태에 기록합니다.

## 실무 요령

- `requested`가 보이면 "의도가 기록됨"으로 생각하세요.
- `completed`가 보이면 "결과가 적용됨"으로 생각하세요.
- `receipt`가 보이면 "비동기 마일스톤 신호, 테스트용"으로 생각하세요.
- `checkpoint`가 보이면 "diff·복원을 위한 프로젝트 스냅샷"으로 생각하세요.
- `quiesced`가 보이면 "관련 후속 작업이 모두 멈춤"으로 생각하세요.

## 관련 문서

- [아키텍처 개요][24]
- [제공자 아키텍처][16]
- [권한 모드][18]
- [프로젝트 구조][2]
- [프로젝트 협업 작업 그래프][27]

[1]: ../../packages/contracts/src/orchestration.ts
[2]: ./workspace-layout.md
[3]: ../../apps/server/src/vcs/GitVcsDriverCore.ts
[4]: ../../apps/server/src/orchestration/projector.ts
[5]: ../../apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts
[6]: ../../apps/server/src/orchestration/Layers/CheckpointReactor.ts
[7]: ../../apps/server/src/orchestration/Layers/OrchestrationEngine.ts
[8]: ../../apps/server/src/orchestration/decider.ts
[9]: ../../apps/server/src/orchestration/commandInvariants.ts
[10]: ../../apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts
[11]: ../../apps/server/src/orchestration/Layers/ProjectionPipeline.ts
[12]: ../../apps/server/src/orchestration/Layers/ProviderCommandReactor.ts
[13]: ../../apps/server/src/orchestration/Services/RuntimeReceiptBus.ts
[14]: ../../apps/server/src/provider/Layers/ProviderService.ts
[15]: ../../apps/server/src/provider/Services/ProviderAdapter.ts
[16]: ./providers.md
[17]: ../../apps/server/src/provider/Layers/CodexAdapter.ts
[18]: ../user/permission-modes.md
[19]: ../../apps/server/src/checkpointing/CheckpointStore.ts
[20]: ../../apps/server/src/checkpointing/CheckpointDiffQuery.ts
[21]: ../../apps/server/src/persistence/Services/ProjectionCheckpoints.ts
[22]: ../../apps/server/src/checkpointing/Utils.ts
[23]: ../../apps/server/src/checkpointing/Diffs.ts
[24]: ./overview.md
[25]: ../../apps/server/src/orchestration/Layers/WorkspaceCollaborationReactor.ts
[26]: ../../apps/server/src/orchestration/workspaceTaskGraph.ts
[27]: ./workspace-collaboration.md
