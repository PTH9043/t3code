# CI 품질 게이트

> 메인테이너용 문서입니다. T3 Code를 사용 중이신가요? [docs/user](../user/)를 참고하세요.

[`.github/workflows/ci.yml`](../../.github/workflows/ci.yml)은 풀 리퀘스트와 `main` 브랜치 푸시에서
네 개의 잡을 실행합니다.

- **Check**: `vp check`(포맷과 린트. 이 저장소는 린트 옵션에 `typeCheck: false`를 설정합니다)를
  실행한 뒤, 워크스페이스 전체 타입 검사를 위해 `vpr typecheck`를 실행합니다. 같은 잡에서 데스크톱
  파이프라인(`vp run build:desktop`)을 빌드하고, preload 번들이 존재하며 예상한 심벌을 여전히
  내보내는지 확인합니다.
- **Test**: 워크스페이스 전체에 대해 `vp run test`를 실행합니다.
- **Mobile Native Static Analysis**: macOS에서 `vp run lint:mobile`을 실행하며,
  `scripts/mobile-native-static-check.ts`를 감쌉니다.
- **Release Smoke**: `scripts/release-smoke.ts`로 릴리스에서만 사용하는 워크플로 단계를 실행해,
  릴리스가 깨지는 문제가 태그를 다는 시점이 아니라 PR 단계에서 드러나게 합니다.

`.github/workflows/release.yml`은 하나의 `v*.*.*` 태그에서 macOS(`arm64`와 `x64`), Linux(`x64`),
Windows(`x64`) 데스크톱 아티팩트를 빌드하고 GitHub 릴리스 하나를 게시합니다. 서명은 플랫폼 자격
증명이 있을 때만 자동으로 켜집니다. macOS 패스키 빌드에는 `APPLE_TEAM_ID`와
`MACOS_PROVISIONING_PROFILE` 시크릿이 추가로 필요하며, Windows는 Azure Trusted Signing을 사용합니다.
핵심 서명 자격 증명이 없어도 서명되지 않은 아티팩트를 릴리스합니다.

전체 릴리스·서명 설정 체크리스트는 [릴리스 체크리스트](../operations/release.md)를 참고하세요.
