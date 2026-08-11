# 연결 런타임

> 메인테이너용 문서입니다. T3 Code를 사용 중이신가요? [docs/user](../user/)를 참고하세요.

연결 런타임은 웹과 모바일이 함께 사용합니다. 연결성, 인증, 재시도, 트랜스포트
수명, 캐시된 환경 데이터, 환경 스코프 작업을 이 런타임이 소유합니다.

웹과 모바일은 애플리케이션 루트에서 이 런타임을 한 번 마운트하고 동일하게
구성하며, `apps/web/src/connection/runtime.ts`와
`apps/mobile/src/connection/runtime.ts`는 제공하는 플랫폼 레이어만 다릅니다.
예전 방식의 연결 소유자나 지원되는 혼합 모드는 없습니다.

## 구성

[`connection/layer.ts`][layer]가 런타임을 조립합니다.

- `ConnectionResolver`([resolver.ts][resolver])는 카탈로그 항목을 primary,
  bearer, relay(중계 서버), SSH 대상에 맞는 준비된 인증 엔드포인트로 해석합니다.
- `ConnectionDriver`([driver.ts][driver])는 resolver를 거쳐 준비 과정을 마치고
  RPC 세션 하나를 연 뒤 `preparing`, `opening`, `synchronizing`을 보고합니다.
- `RpcSessionFactory`([rpc/session.ts][session])는 트랜스포트 시도를 한 번
  수행합니다. 재시도하지 않습니다. `RpcSession`은 이 팩토리가 반환하는
  인터페이스이며 `client`, `initialConfig`, `ready`, `probe`, `closed`를
  노출합니다.
- `EnvironmentRegistry`([registry.ts][registry])는 카탈로그와 환경별 스코프를
  소유합니다.
- `ConnectionOnboarding`과 `RelayEnvironmentDiscovery`는 레지스트리 옆에
  자리합니다. 시작 시 `EnvironmentRegistry.start`를 호출하고 플랫폼 등록 정보를
  `reconcilePlatform`으로 스트리밍합니다.

레지스트리는 환경마다 환경 스코프 supervisor(환경의 연결을 감독하는 구성 요소)를
하나씩 만듭니다. `acquireSupervisor`는 환경별로 접근을 직렬화하고, 카탈로그
항목이 바뀌지 않았으면 기존 supervisor를 재사용하며, 바뀌었으면 스코프를 닫고
다시 만듭니다. `createServiceScope`는 닫을 수 있는 스코프에 묶인
`EnvironmentSupervisor`를 만들어 연결하고, `run`과 `runStream`은 그 supervisor가
제공된 상태에서 호출자 effect를 실행합니다.

`EnvironmentSupervisor`는 목표 상태, 재시도 스케줄링, 활성 세션 스코프를
소유합니다. React 컴포넌트는 연결, 트랜스포트, 재시도 루프, RPC 클라이언트를
만들지 않습니다.

## 연결 상태

재시도를 소유하는 것은 supervisor뿐입니다.

1. 저장된 등록 정보나 플랫폼 등록 정보가 환경을 목표 상태로 표시합니다.
2. 기기가 오프라인이면 supervisor는 활성 세션을 해제하고, 재시도 횟수를
   소모하거나 타이머를 돌리지 않은 채 신호를 기다립니다.
3. 온라인이 되면 드라이버에 준비된 연결 하나와 RPC 세션 하나를 요청합니다.
4. 일시적인 실패는 16초로 제한된 지수 백오프(`RETRY_DELAYS_MS`)로 무한히
   재시도합니다. 연결이 30초 동안 안정적으로 유지되면 누적된 백오프가
   초기화됩니다.
5. 인증 또는 설정 실패는 외부 웨이크업이 관련 입력을 바꿀 때까지 차단 상태로
   남습니다.
6. 비자발적인 세션 종료는 등록 정보와 캐시를 유지한 채 재시도합니다.
7. 명시적 제거는 세션을 닫고 등록 정보, 자격 증명, shell 캐시, 대화 캐시를
   삭제합니다.

### 웨이크업

웨이크업 처리는 단계마다 다르며 [supervisor.ts][supervisor]에 있습니다.

- 연결 수립 중에는 `waitForEstablishmentInterrupt`가 단순한 애플리케이션
  활성화를 소비하고 **무시**합니다. 앱이 포그라운드로 돌아왔다는 이유로 진행
  중인 시도를 다시 시작하면 오히려 시도가 늦어질 뿐입니다. 예외는
  `application-active-reconnect`이며, 모바일이 의미 있는 백그라운드 중단 이후에
  내보냅니다. 이 신호는 연결 수립을 중단시키고 재시도 단계를 초기화하는데, OS가
  시도 중인 소켓을 조용히 끊었을 수 있기 때문입니다.
- 자격 증명 변경은 새 자격 증명이 수립 대상 자체를 바꾸는 relay 대상에서만 연결
  수립을 중단시킵니다.
- 명시적 연결 해제, 명시적 재시도, 오프라인 전환은 모든 경우에 연결 수립을
  중단시킵니다.
- 백오프를 기다리는 동안에는 애플리케이션 활성화가 재시도 단계를 초기화하므로,
  포그라운드로 올라온 앱은 남은 지연 시간을 채우지 않고 즉시 다시 연결합니다.
- 연결된 뒤에는 `monitorConnectedLease`가 단순한 활성화를 다시 연결하지 않고
  기존 세션을 프로브해서 처리하며(`lease.session.probe`, 모바일의
  `application-active-probe`에는 더 짧은 시간 제한 적용), 정상적인 세션은
  포그라운드 전환에도 유지됩니다. `application-active-reconnect`는 프로브를
  건너뛰고 lease를 곧바로 교체합니다.

UI는 supervisor 상태와 명시적인 데이터 동기화 상태에서 `available`, `offline`,
`connecting`, `reconnecting`, `connected`, `error`를 도출합니다. 캐시된
데이터나 트랜스포트 객체의 존재로 연결 상태를 추론하지 않습니다. 환경은 소켓이
열리고 초기 설정 RPC가 성공해 서버가 응답한다는 것이 확인된 뒤에 `connected`가
됩니다. shell 동기화와 대화 동기화는 서로 독립적인 데이터 상태입니다. RPC
트랜스포트는 정상인데 shell 구독이 실패한 경우, 실제로 예약되지도 않은 재연결이
아니라 동기화 오류가 있는 연결됨 상태로 표시합니다.

## 데이터 경계

유한한 요청, 지속 구독, 명령은 서로 다른 API입니다.

- 쿼리 Atom은 RPC 세대가 바뀌면 재검증합니다.
- 구독 Atom은 교체 세션으로 전환합니다.
- [rpc/client.ts][client]의 구독 실패 처리는 두 경우를 구분합니다. 트랜스포트
  실패(`isTransportFailure`: 모든 실패가 RPC 클라이언트 오류입니다)는 다시
  구독하지 않고 내부 구독을 끝내므로, 바깥 스트림은 supervisor가 교체 세션을
  공급할 때까지 기다립니다. 처리된 도메인 실패는 `onExpectedFailure`를 실행하고,
  `retryExpectedFailureAfter`가 설정되어 있으면 잠시 대기한 뒤 **같은** 세션에서
  다시 구독합니다. 정상적인 트랜스포트를 도메인 실패 때문에 해체하는 일은 결코
  없습니다.
- 뮤테이션은 실행 시점에 현재 환경 런타임을 해석합니다.
- shell과 대화 스냅샷은 오프라인에서도 사용할 수 있습니다.
- 동기화 상태는 도메인마다 명시적이고 독립적입니다. shell 상태는 `empty`,
  `cached`, `synchronizing`, `live` 중 하나이며 별도의 `error` 필드가 있고,
  `failed` 상태는 없습니다. 대화 상태에는 `deleted`가 추가됩니다.
- 캐시된 shell·대화 프로젝션이 빠른 재연결 중에 더 최신인 라이브 데이터를
  덮어쓰는 일은 절대 허용하지 않습니다.
- 도메인 Atom 팩토리는 effect를 환경 레지스트리로 라우팅하고 실행 시점에 현재
  스코프 서비스를 해석합니다. 프로젝트 명령과 대화 명령은 `src/state` 아래의
  Atom 팩토리(`createProjectEnvironmentAtoms`, `createThreadEnvironmentAtoms`)
  이며, shell·대화 상태 팩토리(`createEnvironmentShellAtoms`,
  `createEnvironmentThreadStateAtoms`)도 마찬가지입니다.
- 웹과 모바일은 각자의 Atom 런타임, React 훅, 기능 구성을 소유합니다.

Promise 브리지는 React/Atom 경계에만 존재합니다. 런타임과 비즈니스 로직은
Effect 네이티브로 유지됩니다.

## 플랫폼 레이어

웹과 모바일은 다음을 제공합니다.

- 네트워크 상태와 네트워크 변경 스트림
- 애플리케이션 수명 주기 웨이크업
- 클라우드 세션 자격 증명
- 기기 신원
- 플랫폼 등록 정보
- 영속 카탈로그, 자격 증명, shell, 대화 저장소
- HTTP, 암호화, 텔레메트리 레이어

플랫폼 레이어는 운영체제 기능을 어댑터로 연결합니다. 연결 정책은 구현하지
않습니다. `EnvironmentOwnedDataCleanup`도 이 계약의 일부입니다. 환경을 제거하면
레지스트리가 자체 캐시를 비우고 플랫폼 구현을 호출하므로, 웹은 메시지 입력창
초안을 지우고 모바일은 초안과 대화 아웃박스를 지웁니다.

## 소스 경계

애플리케이션은 명시적인 패키지 하위 경로를 import해야 하며, 이 패키지에는
의도적으로 루트 export가 없습니다. 하위 경로는
[packages/client-runtime/README.md](../../packages/client-runtime/README.md)에
정리되어 있고, 해당 패키지 `package.json`의 `exports` 맵이 기준이 되는
목록입니다. export되지 않은 파일은 구현 세부 사항입니다.

## 애플리케이션 경계

애플리케이션 루트는 공용 연결 레이어를 마운트하고, 자체 Atom 런타임을 만들며,
해당 플랫폼에 필요한 도메인 Atom 팩토리를 선택합니다. 웹과 모바일은 연결
소유권을 바꾸지 않고도 서로 다른 훅과 기능을 노출할 수 있습니다.

애플리케이션 코드는 RPC 클라이언트, 재시도 루프, 원시 오케스트레이션 명령을
직접 만들면 안 됩니다. 영속화 경로는 플랫폼 등록 정보와 캐시 저장소의 몫이며,
마이그레이션 또는 무효화 정책을 명시해야 합니다.

## 검증

핵심 상태 머신 테스트는 `@effect/vitest`와 결정적 서비스 레이어를 사용합니다.
반드시 다뤄야 하는 범위는 다음과 같습니다.

- 오프라인 시작과 온라인 웨이크업
- 16초 상한을 적용한 무한 재시도
- 백오프를 중단시키는 명시적 재시도
- 인증 웨이크업
- 비자발적 종료와 재연결
- 소유한 모든 상태를 지우는 명시적 제거
- relay 토큰 재사용과 갱신
- 점진적 relay 탐색
- shell·대화 캐시 하이드레이션
- 세션을 전환하는 지속 구독
- 명령 메타데이터와 멱등한 큐 명령 메타데이터

[layer]: ../../packages/client-runtime/src/connection/layer.ts
[resolver]: ../../packages/client-runtime/src/connection/resolver.ts
[driver]: ../../packages/client-runtime/src/connection/driver.ts
[registry]: ../../packages/client-runtime/src/connection/registry.ts
[supervisor]: ../../packages/client-runtime/src/connection/supervisor.ts
[session]: ../../packages/client-runtime/src/rpc/session.ts
[client]: ../../packages/client-runtime/src/rpc/client.ts
