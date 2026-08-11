# 원격 아키텍처

> 메인테이너용 문서입니다. T3 Code를 사용 중이신가요? [docs/user](../user/)를 참고하세요.

원격 환경은 계획 단계가 아니라 이미 출시된 기능입니다. 직접 접속, bearer 페어링 접속, relay(중계 서버) 터널 접속, Tailscale 접속, 데스크톱이 관리하는 SSH 접속이 오늘날 모두 존재합니다. 이 문서는 이들이 공유하는 모델과 각 구성 요소가 어디에 있는지 설명합니다. 사용자용 설정 안내는 [원격 접속](../user/remote-access.md)을 참고하세요.

## 모델

T3에는 런타임 경계가 하나뿐입니다. 클라이언트가 HTTP와 WebSocket으로 T3 서버와 통신하고, 서버가 오케스트레이션, 제공자, 터미널, git, 파일시스템 작업을 소유합니다. 원격성은 연결 계층에서 표현되며, 런타임을 쪼개는 방식으로는 절대 표현되지 않습니다.

```text
┌──────────────────────────────────────────────┐
│ Client (desktop / mobile / web)              │
│  known environments, connection supervisor   │
└───────────────┬──────────────────────────────┘
                │ resolves one access endpoint
┌───────────────▼──────────────────────────────┐
│ Access method                                │
│  direct ws/wss, relay tunnel,                │
│  Tailscale serve, desktop-managed ssh        │
└───────────────┬──────────────────────────────┘
                │ connects to one T3 server
┌───────────────▼──────────────────────────────┐
│ Execution environment = one T3 server        │
│  identity, providers, projects/threads,      │
│  terminals, git, filesystem                  │
└──────────────────────────────────────────────┘
```

### ExecutionEnvironment

실행 중인 T3 서버 인스턴스 하나입니다. 제공자 가용성과 인증, 모델 가용성, 프로젝트와 대화, 터미널 프로세스, 파일시스템 접근, git 작업, 서버 설정을 소유합니다.

안정적인 `environmentId`로 식별하며, 이 값은 서버가 `<stateDir>/environment-id`에 저장하고 첫 시작 시 생성합니다(`apps/server/src/environment/ServerEnvironment.ts`). 데스크톱, 모바일, 웹이 모두 같은 개념을 기준으로 판단합니다.

### 알려진 환경과 연결 대상

클라이언트가 도달 방법을 알고 있는 환경에 대해 클라이언트 쪽에 저장한 항목입니다. 서버가 작성하지 않으며, 기기나 클라이언트 프로필에 로컬로 존재합니다. 호스팅 웹 앱에서는 이 항목이 브라우저 로컬에 저장됩니다. 호스팅 페어링 URL로 항목을 만들 수 있지만, 그렇다고 호스팅 앱이 서버 측 제어 평면이나 세션 상태 사본을 갖게 되는 것은 아닙니다.

[`connection/model.ts`][model]은 네 가지 대상 태그를 정의하며, 이것이 실제 접속 분류 체계입니다.

| 대상                      | 용도                                                                |
| ------------------------- | ------------------------------------------------------------------- |
| `PrimaryConnectionTarget` | 플랫폼이 관리하는 로컬 서버(데스크톱 백엔드, CLI가 제공하는 웹 앱). |
| `BearerConnectionTarget`  | 직접 HTTP/WebSocket으로 도달하며 수동으로 페어링한 모든 엔드포인트. |
| `RelayConnectionTarget`   | 관리형 T3 Connect relay 터널.                                       |
| `SshConnectionTarget`     | 데스크톱이 관리하는 SSH 환경.                                       |

bearer, relay, SSH는 저장되고, primary는 플랫폼이 관리합니다. Tailscale은 별도의 대상 종류가 아니라는 점에 유의하세요. Tailscale URL은 [`onboarding.ts`][onboarding]의 일반적인 bearer 경로(`preparePairingRegistration`)로 페어링하며, 이 경로는 페어링 URL과 호스트·페어링 코드 조합을 모두 받습니다. Tailscale은 엔드포인트 제공자이자 트랜스포트이며, 별개의 런타임 개념이 아닙니다.

### AdvertisedEndpoint

서버나 데스크톱이 작성한, 어떤 환경에 대한 후보 엔드포인트입니다. 구체적인 HTTP·WebSocket 기본 URL 쌍, 기본/사용 가능/사용 불가 표시, 도달 가능성 힌트(루프백, LAN, private, public, tunnel), 호스팅 HTTPS 앱이 사용할 수 있는지 같은 호환성 힌트로 이루어집니다.

클라이언트는 광고된 엔드포인트를 힌트로만 취급하며, 현재 기기에서 그 경로가 동작한다는 증거로 보지 않습니다. 판단은 연결 시도가 합니다.

UI는 네트워크 접속 요약에 기본 엔드포인트 하나만 표시하고 나머지는 고급 목록에 넣어 둡니다. [`ConnectionsSettings.tsx`](../../apps/web/src/components/settings/ConnectionsSettings.tsx)의 `selectPairingEndpoint`는 사용 불가 엔드포인트를 제외한 뒤 다음 순서로 고릅니다.

1. 저장된 `defaultEndpointKey` 재정의;
2. `isDefault`로 표시된 첫 번째 엔드포인트;
3. 도달 가능성이 `loopback`이 아닌 첫 번째 엔드포인트;
4. 호스팅 HTTPS 앱과 호환되는 첫 번째 엔드포인트;
5. 이 중 어느 것도 없으면 아무것도 고르지 않습니다.

무조건적인 루프백 대체 경로는 없습니다. 루프백 엔드포인트는 명시적으로 저장된 재정의나 `isDefault`를 통해서만 선택됩니다. LAN 주소는 네트워크에 따라 바뀌므로 가능하면 재정의를 원본 URL이 아니라 안정적인 엔드포인트 종류 단위로 저장하고, Tailscale 엔드포인트는 제공자별 안정 키(`tailscale-ip:`, `tailscale-magicdns:`)를 사용합니다.

### 엔드포인트 제공자

엔드포인트 제공자는 핵심 환경 모델의 일부가 되지 않으면서 광고된 엔드포인트를 보탭니다. 핵심은 환경, 페어링, 연결 수명 주기를 소유하고, 제공자는 정규화된 `AdvertisedEndpoint` 레코드를 반환합니다.

Tailscale이 첫 번째 제공자이며, T3는 탐색 이상을 관리합니다. `tailscaleServeEnabled`가 설정되면 서버는 시작 시 `ensureTailscaleServe`로 실제 수신 포트에 대한 Tailscale serve 매핑을 확보하고, 스코프가 닫힐 때 `disableTailscaleServe`로 해제합니다(`apps/server/src/server.ts`, [`@t3tools/tailscale`](../../packages/tailscale/src/tailscale.ts) 사용). 엔드포인트 식별자는 `apps/desktop/src/backend/tailscaleEndpointProvider.ts`에서 `private-network` 도달 가능성으로 생성합니다.

### 호스팅 페어링 요청

호스팅 페어링 요청은 정적 웹 앱을 위한 부트스트랩 URL이며, 트랜스포트가 아닙니다.

```text
https://app.t3.codes/pair?host=https://backend.example.com:3773#token=PAIRCODE
```

호스팅 앱은 `host`를 읽고 URL 해시에서 토큰을 가져와 해당 백엔드와 직접 교환한 뒤, 브라우저 기록에서 토큰을 제거하고 환경 레코드를 로컬에 저장합니다. 헬퍼는 [`shared/remote.ts`](../../packages/shared/src/remote.ts)(`setPairingTokenOnUrl`, `getPairingTokenFromUrl`, `stripPairingTokenFromUrl`)와 `apps/web/src/hostedPairing.ts`에 있습니다.

제약 사항:

- 호스팅 앱은 HTTP나 WebSocket 트래픽을 프록시하지 않습니다;
- 백엔드는 브라우저에서 직접 도달할 수 있어야 합니다;
- HTTPS 페이지는 HTTPS/WSS 백엔드에만 도달할 수 있습니다;
- HTTP LAN 엔드포인트는 계속 데스크톱이나 CLI의 직접 페어링 URL을 사용합니다;
- 토큰은 호스팅 앱 출처로 절대 전송되지 않도록 해시에 담습니다.

### RepositoryIdentity와 Project

`RepositoryIdentity`는 여러 환경에 걸친 최선 노력 기반의 논리적 저장소 묶음이며, UI 그룹화와 상관관계 표시에만 쓰이고 라우팅에는 절대 쓰이지 않습니다. `Project`는 환경 로컬 개념으로 남습니다. 로컬 클론과 원격 클론은 `RepositoryIdentity`를 공유할 수 있는 서로 다른 프로젝트이고, 대화는 한 환경의 한 프로젝트에 묶입니다.

## 접속 방식

접속은 한 가지 질문에 답합니다. 클라이언트는 T3 서버와 어떻게 WebSocket으로 통신하는가? 서버가 어떻게 시작되었는지, 프로세스를 누가 관리하는지에는 답하지 않습니다.

### 직접 WebSocket 접속

`wss://t3.example.com` 또는 `ws://10.0.0.15:3773`을 bearer 대상으로 페어링합니다. 이것이 기본 모델입니다. 클라이언트 쪽 프로세스 관리 없이 데스크톱, 모바일, 웹에서 동작합니다. 브라우저 보안 규칙도 이 모델의 일부입니다. 호스팅 HTTPS 클라이언트는 평문 `ws://`나 `http://` LAN 백엔드에 연결할 수 없습니다.

### relay 터널 접속

관리형 T3 Connect relay 터널은 `RelayConnectionTarget`을 사용하며, 호스트가 NAT 뒤에 있거나, 인바운드 포트를 쓸 수 없거나, 모바일이 데스크톱에서 호스팅하는 환경에 도달해야 할 때의 해답입니다. 클라이언트 관점에서는 여전히 평범한 WebSocket 연결이며, 경로만 중개됩니다. relay Worker는 자격 증명과 관리형 엔드포인트만 중개하고, 이후 애플리케이션 트래픽은 relay Worker 자체가 아니라 프로비저닝된 Cloudflare 터널 호스트명을 통해 연결이 유지되는 동안 흐릅니다. [t3-connect.md](./t3-connect.md)를 참고하세요.

### Tailscale 접속

T3가 관리하는 `tailscale serve` 매핑이 tailnet에서 서버를 HTTPS로 노출하고, 그 결과로 만들어진 사설망 엔드포인트를 페어링용으로 광고합니다. 이후 연결은 일반적인 bearer 경로를 따릅니다.

### 데스크톱이 관리하는 SSH 접속

SSH는 별도의 환경 유형이 아니라 접속과 실행을 돕는 보조 수단입니다. `DesktopSshEnvironment`([apps/desktop/src/ssh/DesktopSshEnvironment.ts][sshenv])는 `discoverHosts`, `ensureEnvironment`, `disconnectEnvironment`를 제공합니다. 이 클래스는 SSH 설정과 known hosts에서 대상을 찾고, 비밀번호·askpass 프롬프트를 담당하며, 수명 주기는 [packages/ssh/src/tunnel.ts][sshtunnel]의 `SshEnvironmentManager`에 위임하는데, 이 관리자는 대상을 해석하고, 원격 T3 서버를 실행하거나 재사용하고, 로컬 터널을 열고, HTTP 준비 상태를 확인하고, 필요하면 원격 페어링 토큰을 발급한 뒤, 로컬 HTTP/WS 엔드포인트를 반환합니다. 연결 해제는 터널을 닫고 실행기가 시작한 원격 서버라면 그 서버도 중지하며, 이미 실행 중이던 서버(`external`로 표시)는 계속 실행되도록 둡니다.

데스크톱 메인 프로세스가 이 일을 맡는 이유는 SSH를 실행하고, 프롬프트를 관리하고, 실행 스크립트를 쓰고, 포워딩을 정리할 수 있기 때문입니다. 렌더러는 다른 환경과 똑같이 포워딩된 URL로 연결하며 SSH 전용 RPC 경로가 필요 없습니다.

실패 처리는 명시적입니다. SSH 인증 실패는 환경이 저장되기 전에 드러나고, 원격 실행 실패에는 가능한 경우 실행기 출력이 포함되며, 포워딩 포트 실패는 관계없는 엔드포인트로 대체하지 않고 환경을 연결 끊김 상태로 두고, 재연결은 WebSocket 클라이언트를 다시 연결하기 전에 SSH 브리지를 복구합니다.

## 실행 방식

실행은 다른 질문에 답합니다. T3 서버는 대상 컴퓨터에 어떻게 존재하게 되는가? 이 질문은 접속과 분리해서 다루세요.

- **기존 서버.** 운영자가 이미 T3를 실행 중이며 클라이언트가 직접 또는 터널을 통해 연결합니다.
- **SSH를 통한 데스크톱 관리 원격 실행.** 데스크톱이 대상 컴퓨터를 살펴보고, 원격 서버를 실행하거나 재사용하고, 포트를 포워딩하면 렌더러가 평소처럼 연결합니다. 저장된 환경에는 SSH 실행으로 만들어졌다는 기록이 남지만 이는 재연결과 수명 주기 UX에만 쓰이며, 이 메타데이터가 프로토콜이나 식별 모델을 바꾸는 일은 없습니다.
- **클라이언트 관리 로컬 게시.** `t3 connect link`로 로컬 서버를 relay를 통해 게시해, 라우터나 방화벽 설정을 바꾸지 않고도 데스크톱에서 호스팅하는 환경을 모바일에 노출합니다.

같은 `ExecutionEnvironment`에 이 방식들 중 여러 가지로 도달할 수 있습니다. 실행 경로와 접속 경로만 다를 뿐입니다.

## 보안 모델

일부 환경은 신뢰할 수 없는 네트워크에서도 도달할 수 있으므로, 원격을 지원하는 환경은 명시적인 인증을 요구하고, 터널 노출은 절대 은폐에 의존하지 않으며, 저장된 엔드포인트는 안전하게 재연결할 수 있을 만큼의 인증 메타데이터를 담습니다.

WebSocket 인증은 쿼리 문자열에 담는 토큰이 아니라 전용 단기 티켓입니다. 클라이언트는 장기 bearer 또는 DPoP 자격 증명을 HTTP 헤더에 담아 `POST /api/auth/websocket-ticket`([authorization/remote.ts][authremote])에 제시하고, 반환된 티켓만 소켓 URL에 `wsTicket`으로 붙입니다. 서버는 `EnvironmentAuth.issueWebSocketTicket`으로 티켓을 발급하며, 티켓에는 `kind: "websocket"` 태그가 붙고 기본 TTL은 5분입니다(`apps/server/src/auth/SessionStore.ts`의 `DEFAULT_WEBSOCKET_TOKEN_TTL`). 핸드셰이크가 티켓을 검증하고, 각 RPC 메서드는 여전히 자체 스코프를 강제합니다. [environment-auth.md](./environment-auth.md)를 참고하세요.

호스팅 페어링은 클라이언트 쪽 편의 기능일 뿐입니다. 호스팅 앱은 쿼리 파라미터로 페어링 토큰을 받아서는 안 되고, 페어링 상태를 서버 측에 저장해서도 안 되며, HTTPS 브라우저 환경에서 HTTP 백엔드에 도달할 수 있다고 암시해서도 안 됩니다.

## 버전 조율

원격 환경은 클라이언트가 더 새로운 릴리스로 옮겨가는 동안에도 온라인 상태를 유지합니다. 환경 디스크립터는 실행 중인 서버 버전을 담고 안전한 교체 경로를 알릴 수 있어서, 트랜스포트에 프로세스 관리를 떠넘기지 않고도 UI가 알맞은 작업을 표시할 수 있습니다. 그 결과로 발생하는 연결 끊김과 재연결은 다른 비자발적 종료와 마찬가지로 connection supervisor(연결을 감독하는 구성 요소)가 담당합니다. [server-updates.md](./server-updates.md)를 참고하세요.

## 향후 작업

다음 항목은 아직 만들지 않았으며, 모델을 솔직하게 유지하기 위해 적어 둡니다.

- 추가 엔드포인트 제공자로서의 서드파티 터널 제품;
- relay가 호스팅하는 OAuth 콜백 브로커([t3-connect.md](./t3-connect.md) 참고);
- 현재의 연결 목록을 넘어서는 풍부한 다중 환경 UI.

[model]: ../../packages/client-runtime/src/connection/model.ts
[onboarding]: ../../packages/client-runtime/src/connection/onboarding.ts
[authremote]: ../../packages/client-runtime/src/authorization/remote.ts
[sshenv]: ../../apps/desktop/src/ssh/DesktopSshEnvironment.ts
[sshtunnel]: ../../packages/ssh/src/tunnel.ts
