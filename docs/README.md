# T3 Code 문서

## T3 Code 사용하기

- [설치와 첫 실행](./user/install.md)
- [권한 모드](./user/permission-modes.md)
- [키보드 단축키](./user/keybindings.md)
- [대화 정리](./user/thread-sidebar.md)
- [작업 토큰 사용량](./user/token-usage.md)
- [대화별 인계 문맥 절약](./user/conversation-handoff.md)
- [원격 접속](./user/remote-access.md)
- [앱과 서버 동기화 유지](./user/updating.md)
- [프로젝트 프로그램 운영](./user/workspace-programs.md)
- [페이블 작업 오케스트레이션](./user/workspace-orchestration.md)
- [소스 컨트롤 연동](./user/source-control.md)
- [백그라운드 서비스(리눅스)](./user/background-service.md)
- 제공자: [Codex](./user/providers-codex.md) · [Claude](./user/providers-claude.md) ·
  [Gemini](./user/providers-gemini.md)

모바일 앱: [apps/mobile/README.md](../apps/mobile/README.md)

---

## T3 Code 개발하기

아래 내용은 모두 메인테이너용입니다. 설치와 설정은 [루트 README](../README.md),
정책은 [CONTRIBUTING.md](../CONTRIBUTING.md), 에이전트 규칙은 [AGENTS.md](../AGENTS.md)에 있습니다.

- [아키텍처 개요](./internals/overview.md)
- [워크스페이스 구조](./internals/workspace-layout.md)
- [용어집](./internals/glossary.md)
- [스크립트](./internals/scripts.md)
- [연결 런타임](./internals/connection-runtime.md)
- [제공자](./internals/providers.md)
- [원격 환경](./internals/remote.md)
- [서버 업데이트](./internals/server-updates.md)
- [리소스 텔레메트리](./internals/resource-telemetry.md)
- [환경 인증](./internals/environment-auth.md)
- [프로젝트 협업 작업 그래프](./internals/workspace-collaboration.md)
- [토큰 효율 개선 설계](./internals/token-efficiency-design.md)
- [토큰 사용량 구현과 검증](./internals/token-usage-implementation.md)
- [대화별 인계 문맥 절약 구현](./internals/conversation-handoff-implementation.md)
- [T3 Connect](./internals/t3-connect.md)
- [CI 게이트](./internals/ci.md)

### 운영 절차서

- [릴리스](./operations/release.md)
- [관측성](./operations/observability.md)
- [relay(중계 서버) 관측성](./operations/relay-observability.md)
- [모바일 앱스토어 스크린샷](./operations/mobile-app-store-screenshots.md)
