# 스크립트

> 메인테이너용 문서입니다. T3 Code를 사용 중이신가요? [docs/user](../user/)를 참고하세요.

## 최초 체크아웃

T3 Code는 [Vite+](https://viteplus.dev/guide/)를 사용합니다. 전역 `vp` 명령을 설치하고 의존성을 설치한
뒤 개발 스택을 시작하세요.

```bash
curl -fsSL https://vite.plus | bash   # Windows: irm https://vite.plus/ps1 | iex
vp i
vp run dev
```

Node 24가 필요합니다. Bun은 필요하지 않습니다. 서버는 Bun을 감지하면 Bun 어댑터를 선택하고 그렇지 않으면
Node로 대체하며, 기여자 설정에서 Bun을 요구하는 부분은 없기 때문입니다.

`vp run dev`는 일회용 페어링 URL을 출력합니다. 이 URL을 열어 첫 브라우저 접속이 인증된 상태가 되도록
하세요.

## 개발

- `vp run dev`: contracts, server, web을 워치 모드로 시작합니다.
- `vp run dev --share`: web 포트를 이 컴퓨터의 tailnet에 HTTPS로 함께 공개합니다. 시작 시 출력되는
  페어링 URL은 공유된 origin을 기준으로 만들어지며, 종료할 때 매핑이 제거됩니다. 공유 실행은 기본적으로
  Vite의 번들 개발 모드(`T3CODE_BUNDLED_DEV=1`)를 사용합니다. 번들하지 않는 개발 모드에서는 원격
  브라우저가 import 단계마다 네트워크 왕복 비용을 치르므로, 캐시가 없는 모듈 그래프가 수 분짜리 워터폴로
  바뀌기 때문입니다. 공유 실행에서 이 동작을 해제하려면 `T3CODE_BUNDLED_DEV=0`을 설정하세요.
- `vp run dev --browser`: 브라우저를 자동으로 엽니다. 기본값은 꺼짐입니다. 개발 실행기가 이 플래그를 보고
  `T3CODE_NO_BROWSER`를 직접 설정하므로, 환경에서 `T3CODE_NO_BROWSER=0`을 지정해도 효과가 없습니다.
  `--browser`를 사용하세요.
- `vp run dev:server`: 서버만 시작합니다. Node(`node --watch src/bin.ts`)에서 실행되므로 Bun이 없으면
  `NodePtyAdapter`와 `NodeHttpServer`를 선택합니다.
- `vp run dev:web`: 웹 앱용 Vite 개발 서버만 시작합니다.
- `vp run dev:desktop`: 개발 서버에 연결되는 Electron 셸을 시작합니다.
- `vp run dev:marketing`: Astro 마케팅 사이트를 시작합니다.
- 개발 실행기 플래그는 루트 작업 이름 바로 뒤에 전달합니다. 예:
  `vp run dev --home-dir /tmp/t3code-dev`

### 개발 상태 디렉터리

- 연결된 **git 워크트리**에서 실행한 개발 명령은 `T3CODE_HOME`이 설정되어 있더라도 기본적으로 해당
  워크트리의 gitignore된 `.t3`를 사용하며, 상태를 `<worktree>/.t3/userdata`에 저장합니다. 다른 격리
  디렉터리를 명시적으로 지정하려면 `--home-dir <path>`를 전달하세요. 서브모듈은 워크트리가 아니므로
  일반적인 우선순위를 그대로 따릅니다.
- **메인 체크아웃**에서 실행한 개발 명령은 암묵적으로 `~/.t3/dev`를 사용해 개발 상태를
  `~/.t3/userdata`와 분리합니다. `--home-dir <path>`를 명시하면 상태를 `<path>/userdata` 아래에
  저장하며, 기준 디렉터리는 캐시·워크트리를 비롯한 공유 데이터용으로 계속 사용할 수 있습니다.

## 빌드·검사·테스트

- `vp run build`: `apps/*`, `packages/*`, `oxlint-plugin-t3code`, `scripts`로 작업을 분배합니다. 빌드
  작업을 정의한 워크스페이스, 즉 desktop, marketing, server(web에 의존), web이 빌드를 실행합니다. 공유
  패키지는 따로 빌드하지 않고 사용처에서 전이적으로 번들됩니다.
- `vp run build:desktop`: 데스크톱 파이프라인(desktop과 server)을 빌드합니다.
- `vp run start`: 프로덕션 서버를 실행합니다(빌드된 웹 앱을 정적 파일로 제공합니다).
- `vp check`: Vite+의 포맷·린트·타입 검사입니다. 이 저장소는 린트 옵션에 `typeCheck: false`를 설정하므로
  워크스페이스 타입 검사는 별도로 실행됩니다.
- `vp run typecheck`: 모든 패키지에 대한 엄격한 TypeScript 검사입니다.
- `vp run test`: 워크스페이스 테스트를 실행합니다.
- `vp run lint:mobile`: 모바일 네이티브 정적 분석입니다(`scripts/mobile-native-static-check.ts`).
- `node apps/server/scripts/t3-sqlite-state.ts <query|exec> --base-dir <path> ...`: 격리된 T3 SQLite
  데이터베이스를 조회하거나 초기 데이터를 넣습니다. 쓰기 작업은 먼저 비공개 백업을 만듭니다.

## 데스크톱 아티팩트

- `vp run dist:desktop:artifact --platform <mac|linux|win> --target <target> --arch <arch>`: 지정한 플랫폼/타깃/아키텍처에 맞는 데스크톱 아티팩트를 빌드합니다.
- `vp run dist:desktop:dmg`: 공유할 수 있는 macOS `.dmg`를 `./release`에 빌드합니다. 아키텍처는 기본적으로
  호스트를 따르므로 Apple Silicon에서는 arm64 DMG가 만들어집니다. 특정 아키텍처를 강제하려면
  `dist:desktop:dmg:arm64`나 `dist:desktop:dmg:x64`를 사용하거나 `--arch <arm64|x64|universal>`을 전달하세요.
- `vp run dist:desktop:linux`: Linux AppImage를 `./release`에 빌드합니다.
- Windows에서는 저장소 루트에서 `node scripts/build-desktop-artifact.ts --platform win --target nsis --arch x64`를 실행합니다. ARM64는 `--arch arm64`를 사용합니다. 기본 실행은 웹·서버·데스크톱을 먼저 빌드하고 NSIS 설치 파일을 `release/`에 만듭니다. 기존 번들을 패키징할 때만 `--skip-build`를 추가합니다. WSL용 node-pty 바이너리는 기존 `--wsl-prebuild <pty.node 경로>`로 전달합니다.
- Windows 패키징은 루트 `package.json`에 고정된 pnpm을 Node로 실행합니다. `pnpm@11.10.0`은 저장소 또는 사용자 Vite+ 캐시의 `package_manager/pnpm/11.10.0/pnpm/bin/pnpm.cjs`, 또는 Corepack 캐시의 `v1/pnpm/11.10.0/bin/pnpm.cjs`에서 찾습니다. 스테이지는 이 체크아웃의 `pnpm-lock.yaml`에서 서버·데스크톱의 해석 버전과 피어·패치 정보를 가져와 `install --prod --frozen-lockfile --ignore-scripts`로 설치합니다. Clerk와 WSL 네이티브 파일은 이어지는 스테이징 단계에서 복사합니다.
- 리소스 모니터는 기본적으로 임시 스테이지의 `cargo-target/`에서 빌드합니다. `CARGO_TARGET_DIR`가 있으면 Cargo 출력과 바이너리 복사에 같은 경로를 사용합니다. 상대 경로의 기준은 저장소 루트입니다.

### Windows Azure 서명

Windows 패키징 명령에 `--signed`를 추가하면 로컬 도구와 환경 변수를 검사한 뒤 빌드를 시작합니다. `SIGNTOOL_PATH`로 Windows SDK의 `signtool.exe`, `AZURE_TRUSTED_SIGNING_DLIB`로 같은 아키텍처의 `Azure.CodeSigning.Dlib.dll` 절대 경로를 지정할 수 있습니다. 기본 경로는 Windows Kits의 x64 SignTool과 `%ProgramFiles(x86)%/Microsoft/ArtifactSigningClientTools/bin`입니다. Microsoft 클라이언트 패키지의 DLL과 runtimeconfig 파일을 함께 두고, 해당 설정이 요구하는 아키텍처와 버전의 .NET 런타임을 설치합니다.

서비스 주체는 `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`으로 인증합니다. 서명 계정에는 `AZURE_TRUSTED_SIGNING_ENDPOINT`, `AZURE_TRUSTED_SIGNING_ACCOUNT_NAME`, `AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME`, `AZURE_TRUSTED_SIGNING_PUBLISHER_NAME`이 필요합니다. Microsoft의 Dlib 메타데이터는 앱 디렉터리 밖에 생성되며 환경 자격 증명만 사용합니다. 기존 파일·타임스탬프 해시와 RFC 3161 서버 설정을 지원합니다. [Microsoft 서명 통합 문서](https://learn.microsoft.com/en-us/azure/artifact-signing/how-to-signing-integrations)

서명 훅은 각 파일에 SignTool을 직접 실행하고 타임스탬프와 서명을 검증합니다. 최종 Windows 설치 파일은 `release/`로 복사하기 전에 다시 검증합니다. CI는 서명 설정 일부만 있는 경우 실패하며, 서명이 구성된 경우 SHA-512로 확인한 Microsoft.ArtifactSigning.Client 1.0.151을 러너 임시 폴더에 풉니다. 이 버전은 .NET 10을 사용합니다. [Microsoft NuGet 패키지](https://www.nuget.org/packages/Microsoft.ArtifactSigning.Client/1.0.151)

### 데스크톱 `.dmg` 패키징 참고 사항

- 기본 빌드는 로컬 공유용이므로 서명과 공증이 되어 있지 않습니다.
- DMG 빌드는 `assets/prod/black-macos-1024.png`를 프로덕션 앱 아이콘 원본으로 사용합니다.
- 데스크톱 프로덕션 창은 번들된 UI를 `t3code://app/` 루트 URL에서 불러옵니다(`127.0.0.1` 문서 URL이나
  명시적인 `index.html` 경로가 아닙니다).
- 데스크톱 패키징에는 `apps/server/dist`(`t3` 백엔드)가 포함되며, WebSocket/API 트래픽용 인증 토큰과 함께
  루프백에서 이를 시작합니다.
- 테스터는 macOS에서 처음 실행할 때 앱을 오른쪽 클릭하고 **열기**를 선택해 그대로 열 수 있습니다.
- 패키지 내용을 디버깅하기 위해 스테이징 파일을 남기려면 `vp run dist:desktop:dmg --keep-stage`를 실행하세요.
- CI/시크릿에 설정된 코드 서명·공증을 사용하려면 `--signed`를 추가하세요.
- 서명된 macOS 빌드에는 `T3CODE_APPLE_TEAM_ID`와
  `T3CODE_MACOS_PROVISIONING_PROFILE`도 필요합니다. 패스키 RP 도메인은
  `T3CODE_CLERK_PASSKEY_RP_DOMAINS`가 재정의하지 않는 한 `T3CODE_CLERK_PUBLISHABLE_KEY`에서 유도합니다.
- Windows의 `--signed`는 Azure Trusted Signing을 사용하며 다음 값을 요구합니다.
  `AZURE_TRUSTED_SIGNING_ENDPOINT`, `AZURE_TRUSTED_SIGNING_ACCOUNT_NAME`,
  `AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME`, `AZURE_TRUSTED_SIGNING_PUBLISHER_NAME`.
- Azure 인증 환경 변수도 필요합니다(예: 시크릿을 사용하는 서비스 주체).
  `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`.

## 브라우저 개발

`dev`와 `dev:web`은 `VITE_HTTP_URL`과 `VITE_WS_URL`을 설정하지 않은 채로 두므로 브라우저가
`window.location.origin`에서 백엔드를 확인합니다. Vite는 `/api`, `/ws`, `/oauth`, `/.well-known`을 서버로
프록시하므로 같은 번들이 localhost에서도 tailnet 호스트 이름에서도 동작합니다.

## 여러 개발 인스턴스 실행

워크트리는 자신의 경로에서 선호 포트 오프셋을 유도합니다.

- 기본 포트: server `13773`, web `5733`
- 이동된 포트: `base + offset`
- 예: `T3CODE_DEV_INSTANCE=branch-a vp run dev:desktop`

오프셋은 다음 순서로 결정합니다.

1. `T3CODE_PORT_OFFSET`이며, 0 이상의 정수여야 합니다. 음수 값은 거부됩니다.
2. `T3CODE_DEV_INSTANCE`. 값이 모두 숫자면 오프셋으로 그대로 사용하고, 그 외의 비어 있지 않은
   값은 해시해서 오프셋으로 만듭니다.
3. 워크트리 경로 해시.

충돌 검사는 모드에 따라 다릅니다. `dev:web`은 web 포트만 검사하고 web 오프셋만 이동합니다. `dev:server`는
server 포트만 검사합니다. `dev`와 `dev:desktop`은 둘 다 검사하고 하나의 공유 오프셋으로 함께 이동합니다.
서버나 개발 URL을 명시적으로 재정의하면 해당 포트는 가용성 검사에서 제외됩니다. `[dev-runner]` 출력을 최종
기준으로 삼으세요.
