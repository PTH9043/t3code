# 워크스페이스 구조

> 메인테이너용 문서입니다. T3 Code를 사용 중이신가요? [docs/user](../user/)를 참고하세요.

[vite-plus](https://vite.plus)(`vp`)로 구동하는 pnpm 워크스페이스입니다. 작업 명령은 [scripts.md](./scripts.md)를 참고하세요.

## apps

- `apps/server` (`t3`): 실행 런타임이자 배포되는 CLI입니다. 오케스트레이션, 제공자 드라이버, 체크포인트 관리, VCS, 터미널, 파일시스템 접근, 인증, HTTP + WebSocket 인터페이스를 담당합니다. 빌드된 웹 앱도 제공합니다.
- `apps/web` (`@t3tools/web`): React + Vite UI입니다. 공용 클라이언트 런타임을 사용하며 라우팅, 컴포넌트, 웹 전용 플랫폼 계층을 더합니다.
- `apps/desktop` (`@t3tools/desktop`): Electron 셸입니다. 데스크톱 스코프의 `t3` 백엔드를 감독하고, `t3code://` 프로토콜로 웹 번들을 불러오며, SSH로 관리하는 원격 환경을 담당합니다.
- `apps/mobile` (`@t3tools/mobile`): Expo/React Native 클라이언트입니다. 클라이언트 런타임 구성은 웹과 같고 플랫폼 계층과 UI가 다릅니다.
- `apps/marketing` (`@t3tools/marketing`): Astro 마케팅 사이트입니다.

## packages

- `packages/contracts` (`@t3tools/contracts`): 공용 Effect Schema 정의입니다. RPC 그룹, 오케스트레이션 명령/이벤트/읽기 모델, 인증 스코프, 환경 디스크립터, 설정.
- `packages/shared` (`@t3tools/shared`): 서버와 클라이언트가 함께 쓰는 프레임워크 독립적인 유틸리티입니다(`DrainableWorker`, git 및 소스 관리 헬퍼, relay(중계 서버) 인증과 서명, DPoP, semver, 로깅, 관측성 등).
- `packages/client-runtime` (`@t3tools/client-runtime`): 연결 수명 주기, 인가, RPC 세션, 환경 레지스트리, 그리고 웹과 모바일이 공유하는 Atom 기반 도메인 상태입니다. 이 패키지의 [README](../../packages/client-runtime/README.md)를 참고하세요.
- `packages/ssh` (`@t3tools/ssh`): SSH 설정 파싱, 인증 프롬프트, 명령 실행, 그리고 데스크톱이 관리하는 SSH 환경 뒤에서 동작하는 터널·환경 관리자입니다.
- `packages/tailscale` (`@t3tools/tailscale`): 서버가 구동하는 `ensureTailscaleServe` / `disableTailscaleServe` serve 수명 주기를 포함한 Tailscale CLI 래퍼입니다.
- `packages/effect-acp` (`effect-acp`): Agent Client Protocol의 Effect 클라이언트 및 에이전트 구현으로, ACP로 통신하는 제공자 드라이버가 사용합니다.
- `packages/effect-codex-app-server` (`effect-codex-app-server`): `codex app-server` JSON-RPC 프로토콜용 Effect 클라이언트입니다.

## infra

- `infra/relay` (`t3code-relay`): Alchemy로 배포하는 호스팅형 T3 Connect relay입니다. 환경 탐색, 클라우드 측 기록, 모바일 알림을 처리합니다. 핫 패스에는 속하지 않으며, 연결이 끝난 뒤 클라이언트 트래픽은 환경으로 직접 전달됩니다. [t3-connect.md](./t3-connect.md)를 참고하세요.

## 기타 최상위 디렉터리

- `scripts/`: `vp run`으로 실행하는 워크스페이스 도구입니다. 개발 실행기, 데스크톱 아티팩트 빌드, 릴리스 헬퍼, 모바일 정적 검사와 쇼케이스 캡처, 업데이트 매니페스트 병합.
- `assets/`: 채널별(`dev`, `nightly`, `prod`) 브랜드 및 앱 아이콘 원본입니다.
- `patches/`: 고정된 업스트림 의존성에 적용하는 pnpm 패치입니다.
- `oxlint-plugin-t3code/`: 이 저장소 전용 lint 규칙입니다.
- `experiments/`: 일회성 프로토타입입니다. 배포되는 빌드에는 포함되지 않습니다.
- `docs/`: 이 문서 트리입니다.

## 임포트 규칙

`@t3tools/shared`와 `@t3tools/client-runtime`은 배럴 인덱스와 루트 익스포트 없이 명시적인 하위 경로 익스포트를 사용합니다. 패키지 루트 대신 좁은 경로(`@t3tools/shared/DrainableWorker`, `@t3tools/client-runtime/state/threads`)를 임포트하세요. 익스포트되지 않은 파일은 구현 세부사항입니다. `@t3tools/contracts`는 `./settings`, `./relay`와 함께 루트도 익스포트합니다.
