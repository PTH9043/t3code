# 아키텍처

> 메인테이너용 문서입니다. T3 Code를 사용 중이신가요? [docs/user](../user/)를 참고하세요.

T3 Code는 에이전트 세션, 프로젝트, 버전 관리를 소유하는 서버 런타임과, 인증된 Effect RPC WebSocket 하나로
서버와 통신하는 클라이언트(웹, 데스크톱, 모바일)로 이루어집니다. 서버는 실행 경계이며, 모든 제공자 프로세스,
터미널, git 작업, 파일시스템 읽기는 클라이언트가 아니라 서버에서 일어납니다.

```
┌────────────────────────────────────────────────┐
│ Clients: apps/web, apps/desktop, apps/mobile   │
│ shared runtime: packages/client-runtime        │
│  connection supervisor, RPC session, Atom state│
└──────────────────┬─────────────────────────────┘
                   │ Effect RPC over WebSocket (/ws)
                   │ contract: packages/contracts
┌──────────────────▼─────────────────────────────┐
│ apps/server                                    │
│  orchestration engine (event-sourced)          │
│  provider driver registry (5 built-in drivers) │
│  checkpointing, VCS, terminals, filesystem     │
└──────────────────┬─────────────────────────────┘
                   │ per-driver transport
┌──────────────────▼─────────────────────────────┐
│ Agent CLIs: Codex, Claude, Cursor, Grok,       │
│ OpenCode                                       │
└────────────────────────────────────────────────┘
```

## RPC 경계

클라이언트/서버 컨트랙트는 직접 만든 푸시 프로토콜이 아니라 Effect RPC 그룹입니다. [`rpc.ts`][rpc]는
`WS_METHODS`를 선언하고 `WsRpcGroup`을 조립하며, 각 멤버는 단항이거나 서버 스트림(`stream: true`)입니다.
`orchestration.subscribeShell`, `orchestration.subscribeThread`, `subscribeServerConfig`, `terminal.attach`
같은 스트리밍 멤버는 예전의 브로드캐스트 푸시 버스를 대체하며, 클라이언트는 필요한 것만 구독하고 서버는 그
구독으로만 푸시합니다.

[`ws.ts`][ws]가 이 그룹을 제공합니다. `websocketRpcRouteLayer`는 `GET /ws`를 마운트하고,
`EnvironmentAuth.authenticateWebSocketUpgrade`로 업그레이드를 인증한 뒤, 소켓을
`RpcServer.toHttpEffectWebsocket`에 넘깁니다. 인가는 메서드 단위로 이루어지며, `RPC_REQUIRED_SCOPE`가 각
메서드를 스코프에 대응시키고 `authorizeEffect`/`authorizeStream`이 이를 강제합니다. 유효한 소켓을 쥐고 있다고
해서 그 소켓의 모든 메서드를 호출할 인가가 생기는 것은 아닙니다.
[environment-auth.md](./environment-auth.md)를 참고하세요.

클라이언트에서는 [`session.ts`][session]가 소켓을 열고 타입이 지정된 클라이언트를 만듭니다.
`RpcSessionFactory`가 그 서비스이며, 세션은 `client`, `initialConfig`, `ready`, `probe`, `closed`를
노출합니다. 세션은 한 번만 시도하고 재시도하지 않습니다. 재시도, 백오프, 오프라인 정책은 connection supervisor(연결을 감독하는 구성 요소)의
몫입니다.

## 공용 클라이언트 런타임

`packages/client-runtime`은 연결 수명 주기, 인증, RPC, 캐시된 환경 데이터, Atom 팩토리 형태의 도메인 상태 등
화면과 무관한 클라이언트 관심사를 모두 담습니다. 웹과 모바일은 이를 같은 방식으로 조합하며
(`apps/web/src/connection/runtime.ts`와 `apps/mobile/src/connection/runtime.ts`는 서로 대칭이고 플랫폼별
백그라운드 활동 레이어에서만 다릅니다), 그 밖에는 각자 제공하는 플랫폼 레이어와 그 위에 올리는 UI에서만
다릅니다. React 컴포넌트는 트랜스포트, 재시도 루프, RPC 클라이언트를 직접 만들지 않습니다.
[connection-runtime.md](./connection-runtime.md)를 참고하세요.

## 오케스트레이션은 이벤트 소싱 방식입니다

서버는 앱 상태를 직접 변경하지 않습니다. 클라이언트가 타입이 지정된 명령을 전달하면 엔진이 이를 영속
이벤트로 바꾸고, 프로젝션이 읽기 모델을 만들어 냅니다.

[`OrchestrationEngine.ts`][engine]가 이 과정을 직렬화합니다. `dispatch`는 `CommandEnvelope`을
`commandQueue`에 넣고 그 결과를 기다리며, 단일 워커 파이버가 엔벨로프를 하나씩 꺼내므로 명령 처리 순서가
완전히 보장됩니다. 각 엔벨로프에 대해 `processEnvelope`는 다음을 수행합니다.

1. 영속 명령 receipt(작업 완료를 알리는 기록)를 확인해 재시도를 멱등하게 만듭니다.
2. `decideOrchestrationCommand` ([`decider.ts`][decider])를 실행해 명령과 현재 상태로부터 이벤트를 만들며,
   이 함수는 순수하고 부수 효과가 없습니다.
3. 하나의 SQL 트랜잭션 안에서 이벤트를 이벤트 스토어에 덧붙이고, [`projector.ts`][projector]를 통해 인메모리
   읽기 모델에 적용하고, 영속 테이블로 프로젝션하고, 수락된 receipt를 기록합니다.
4. 커밋 후에는 새 읽기 모델로 교체하고 커밋된 이벤트를 구독자에게 발행합니다.

영속화와 프로젝션이 하나의 트랜잭션을 공유하므로 읽기 모델이 이벤트 로그와 지속적으로 어긋날 수 없습니다.
전달이 실패하면 엔진은 시작 시퀀스 이후의 영속 이벤트를 다시 읽어 상태를 맞춥니다.

명령과 이벤트 이름은 [`orchestration.ts`][contracts]에 있습니다. 일부 명령은 클라이언트가 전달할 수 있고
(`thread.create`, `thread.turn.start`, `thread.approval.respond`), 나머지는 내부용이라 서버 쪽
reactor(후속 작업을 처리하는 워커)만 만들어 냅니다(`thread.message.assistant.delta`,
`thread.turn.diff.complete`).

턴은 해당 세션이 `running` 상태를 벗어날 때 완료되며, 이는 [`projector.ts`][projector]의
`settledTurnStateForSessionStatus`가 프로젝션합니다. 이후에 마무리되는 체크포인트 작업이 턴의 끝을 정하지는
않습니다.

## Drainable 워커

후속 작업은 [`DrainableWorker`][worker] 위에 만든 큐 기반 워커에서 비동기로 실행되며,
[`ProviderRuntimeIngestion`][ingest]은 제공자 런타임 스트림을 오케스트레이션 명령으로 정규화하고,
[`ProviderCommandReactor`][cmd]는 의도 이벤트에 반응해 제공자 호출을 전달하고,
[`CheckpointReactor`][checkpoint]는 프로젝트 체크포인트를 캡처하고 되돌립니다.

`DrainableWorker`는 트랜잭션 큐와 미처리 항목의 트랜잭션 카운트를 함께 묶습니다. `enqueue`는 원자적으로
항목을 넣고 카운트를 늘리며, 처리는 항상 카운트를 줄입니다. `drain`은 카운트가 0이 될 때까지 재시도하므로,
테스트는 일정 시간 대기하는 대신 "큐가 비었고 현재 항목이 끝났다"를 기다릴 수 있습니다. 세 서비스 모두 정확히
이 목적으로 `drain`을 노출합니다.

런타임 receipt는 테스트 전용 장치입니다. [`RuntimeReceiptBus.ts`][receipts]의 `RuntimeReceiptBusLive`는
아무것도 발행하지 않으며, 테스트 레이어만 PubSub 기반입니다. 프로덕션 동작을 receipt 위에 만들지 마세요.

## 제공자 드라이버

Codex, Claude, Cursor, Grok, OpenCode 드라이버 다섯 개가 기본 내장되어 [`builtInDrivers.ts`][drivers]에
`BUILT_IN_DRIVERS`로 등록되어 있습니다. 드라이버는 자신의 종류와 설정 스키마를 선언하고 스코프가 지정된
어댑터를 만들며, `ProviderInstanceRegistry`가 실행 중인 인스턴스를 소유하고 `ProviderAdapterRegistry`가
인스턴스를 해당 어댑터로 해석하므로, `ProviderService`는 뒤에 어떤 에이전트가 있는지 알지 못한 채 세션·턴
작업을 라우팅합니다. [providers.md](./providers.md)를 참고하세요.

## 체크포인트 관리

각 턴은 프로젝트 체크포인트로 앞뒤가 감싸이므로 diff와 되돌리기가 정확합니다. `CheckpointStore`는 VCS
드라이버의 체크포인트 작업을 통해 상태를 숨겨진 Git ref로 캡처하고, `CheckpointDiffQuery`는 턴 단위와 대화
전체의 diff 요청에 응답하며, `CheckpointReactor`는 기준선 캡처, 완료된 턴 캡처, diff 프로젝션, 그리고
프로젝트와 제공자 대화를 모두 되돌리는 일을 조율합니다. 저장 컨트랙트는
[`VcsDriver.ts`](../../apps/server/src/vcs/VcsDriver.ts)의 `VcsCheckpointOps`이며, Git 구현은 같은
디렉터리에 있습니다.

## 시작 과정

[`serverRuntimeStartup.ts`][startup]는 고정된 수명 주기를 실행합니다. 키 바인딩, 설정, reactor를 시작하고,
welcome을 발행하고, 명령 준비 상태를 알리고(`Accepting commands`로 기록됩니다), `markHttpListening`으로 HTTP
리스너를 기다리고, ready를 발행하고, 하트비트를 포크한 다음, 헤드리스 출력을 인쇄하거나 브라우저를 엽니다.
명령 준비는 리스너보다 먼저이므로, 열린 소켓은 곧바로 명령을 전달할 수 있습니다.

## 관련 문서

- [프로젝트 구조](./workspace-layout.md), [용어집](./glossary.md)
- [원격 환경](./remote.md), [서버 업데이트](./server-updates.md)
- [리소스 텔레메트리](./resource-telemetry.md)
- [스크립트](./scripts.md), [CI 게이트](./ci.md)

[rpc]: ../../packages/contracts/src/rpc.ts
[contracts]: ../../packages/contracts/src/orchestration.ts
[ws]: ../../apps/server/src/ws.ts
[session]: ../../packages/client-runtime/src/rpc/session.ts
[startup]: ../../apps/server/src/serverRuntimeStartup.ts
[engine]: ../../apps/server/src/orchestration/Layers/OrchestrationEngine.ts
[decider]: ../../apps/server/src/orchestration/decider.ts
[projector]: ../../apps/server/src/orchestration/projector.ts
[worker]: ../../packages/shared/src/DrainableWorker.ts
[ingest]: ../../apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts
[cmd]: ../../apps/server/src/orchestration/Layers/ProviderCommandReactor.ts
[checkpoint]: ../../apps/server/src/orchestration/Layers/CheckpointReactor.ts
[receipts]: ../../apps/server/src/orchestration/Layers/RuntimeReceiptBus.ts
[drivers]: ../../apps/server/src/provider/builtInDrivers.ts
