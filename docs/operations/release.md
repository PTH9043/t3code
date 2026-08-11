# 릴리스 체크리스트

> 메인테이너용 문서입니다. T3 Code를 사용 중이신가요? [docs/user](../user/)를 참고하세요.

이 문서는 안정 채널과 나이틀리 데스크톱 릴리스를 위한 통합 릴리스 워크플로를 설명합니다.

## 워크플로가 하는 일

- 워크플로: `.github/workflows/release.yml`
- 트리거:
  - 안정 릴리스를 위한 `v*.*.*` 형식 태그 푸시
  - 3시간마다 실행되는 나이틀리 예약 확인
  - 두 채널 모두에 대한 수동 `workflow_dispatch`
- 품질 게이트를 먼저 실행합니다: lint, typecheck, test.
- 클라이언트를 패키징하기 전에 공유 프로덕션 T3 Connect relay(중계 서버) URL과 Clerk 클라이언트 설정을 읽습니다.
- 두 채널 모두에 대해 네 가지 아티팩트를 병렬로 빌드합니다:
  - macOS `arm64` DMG
  - macOS `x64` DMG
  - Linux `x64` AppImage
  - Windows `x64` NSIS 설치 프로그램
- 생성된 모든 파일을 담은 GitHub Release 하나를 게시합니다.
  - `X.Y.Z` 뒤에 접미사가 붙은 안정 태그(예: `1.2.3-alpha.1`)는 GitHub 프리릴리스로 게시됩니다.
  - 일반 안정 `X.Y.Z` 릴리스만 저장소의 최신 릴리스로 표시됩니다.
  - 나이틀리 실행은 항상 GitHub 프리릴리스이며 최신으로 표시되지 않습니다.
  - 자동 생성되는 릴리스 노트는 같은 채널의 이전 태그를 기준으로 고정되므로, 안정 채널은 이전 안정 태그와 비교하고 나이틀리 채널은 이전 나이틀리 태그와 비교합니다.
- 릴리스 자산에 Electron 자동 업데이트 메타데이터(예: `latest*.yml`, `nightly*.yml`, `*.blockmap`)를 포함합니다.
- 같은 워크플로 파일에서 OIDC 신뢰 게시로 CLI 패키지(`apps/server`, npm 패키지 `t3`)를 게시합니다:
  - 안정 릴리스는 npm dist-tag `latest`로 게시합니다
  - 나이틀리 릴리스는 npm dist-tag `nightly`로 게시합니다
- 릴리스가 게시된 뒤에만 호스팅 웹 앱을 Vercel에 배포합니다:
  - 안정 릴리스는 `latest` 호스팅 앱 채널에 별칭으로 연결됩니다
  - 나이틀리 릴리스는 `nightly` 호스팅 앱 채널에 별칭으로 연결됩니다
- 서명은 선택 사항이며 시크릿을 기준으로 플랫폼마다 자동 감지됩니다.

## 릴리스에 필요한 자격 증명

안정 릴리스에는 아래에 설명한 플랫폼 및 배포 자격 증명 외에 다음 GitHub Actions 시크릿이 필요합니다:

- `RELEASE_APP_ID`
- `RELEASE_APP_PRIVATE_KEY`

finalize 작업은 이 값을 사용해 정렬된 패키지 버전을 Release App 명의로 `main`에 커밋하고 푸시합니다.
GitHub Release 게시는 저장소 범위 워크플로 토큰을 사용하므로, 공유 Release App 설치와 독립적인
요청 한도 할당량을 갖습니다.

## T3 Connect relay 배포

relay는 클라이언트 릴리스와 별도로 버전이 관리되는 공유 제어 평면입니다. 안정 클라이언트 빌드와
나이틀리 클라이언트 빌드는 같은 relay를 가리켜야 하며, 그래야 사용자가 릴리스 채널을 바꿔도 동일한
연결 환경을 볼 수 있습니다.

`.github/workflows/deploy-relay.yml`은 `main`에 푸시할 때마다 Alchemy 스테이지 `prod`를 배포합니다.
릴리스 워크플로는 데스크톱, CLI, 호스팅 웹 아티팩트를 빌드하기 전에 기존 `production`
GitHub Actions 환경에서 relay URL과 Clerk 클라이언트 설정을 읽습니다.

relay 배포가 공유하는 필수 저장소 변수:

- `CLOUDFLARE_ACCOUNT_ID`
- `PLANETSCALE_ORGANIZATION`
- `AXIOM_ORG_ID`

relay 배포가 공유하는 필수 저장소 시크릿:

- `CLOUDFLARE_API_TOKEN`
- `PLANETSCALE_API_TOKEN_ID`
- `PLANETSCALE_API_TOKEN`
- `AXIOM_TOKEN`

필수 `production` 환경 변수:

- `RELAY_API_ZONE_NAME`
- `RELAY_TUNNEL_ZONE_NAME`
- `CLERK_PUBLISHABLE_KEY`
- `CLERK_JWT_AUDIENCE`
- `CLERK_JWT_TEMPLATE`
- `CLERK_CLI_OAUTH_CLIENT_ID`
- `APNS_ENVIRONMENT`
- `APNS_TEAM_ID`
- `APNS_KEY_ID`
- `APNS_BUNDLE_ID`

선택 `production` 환경 변수:

- 파생된 `relay.<RELAY_API_ZONE_NAME>` 도메인을 재정의할 때 사용하는 `RELAY_DOMAIN`

필수 `production` 환경 시크릿:

- `CLERK_SECRET_KEY`
- `APNS_PRIVATE_KEY`

계정 범위 저장소 자격 증명은 Alchemy가 relay 스테이지를 프로비저닝하는 동안 사용하며, relay Worker에는
포함되지 않습니다. 프로덕션 배포는 Axiom 개인 액세스 토큰을 사용하므로 `AXIOM_ORG_ID`가 `AXIOM_TOKEN`과
함께 있어야 합니다. `prod` 스테이지는 보존되는 PlanetScale 데이터베이스를 소유합니다. 로컬 개인
스테이지는 이 데이터베이스에서 격리된 브랜치를 프로비저닝하며 CI가 배포하지 않습니다.
프로덕션은 설정된 relay API와 터널 DNS 존을 보존되는 Cloudflare 리소스로 채택합니다.
개인 스테이지는 프로덕션이 소유한 존을 참조합니다.

개발자는 풀 리퀘스트 자동화가 아니라 로컬에서 개인 스테이지를 배포합니다:

```sh
vp run --filter t3code-relay deploy -- --stage "$USER" --env-file .env.local
```

## 호스팅 웹 앱 릴리스 배포

호스팅 앱은 의도적으로 Vercel의 Git 연동으로 배포하지 않습니다. 웹 프로젝트는
`apps/web/vercel.ts`에서 `git.deploymentEnabled: false`로 자동 Git 배포를
비활성화하며, GitHub Release가 성공한 뒤 `.github/workflows/release.yml`이
Vercel CLI로 웹 앱을 배포합니다.

필수 GitHub Actions 시크릿:

- `VERCEL_TOKEN`
- `VERCEL_ORG_ID`
- `VERCEL_PROJECT_ID`

선택 GitHub Actions 변수:

- `VERCEL_TEAM_SLUG`: `VERCEL_ORG_ID` 시크릿보다 팀 슬러그를 사용하려는 경우 Vercel CLI 스코프를 재정의합니다.
- `T3CODE_WEB_ROUTER_URL`: 기본값은 `https://app.t3.codes`입니다.
- `T3CODE_WEB_LATEST_DOMAIN`: 기본값은 `latest.app.t3.codes`입니다.
- `T3CODE_WEB_NIGHTLY_DOMAIN`: 기본값은 `nightly.app.t3.codes`입니다.

필수 Vercel 도메인:

- `app.t3.codes`: 사용자가 여는 라우터 도메인이며, 안정 릴리스가 갱신합니다.
- `latest.app.t3.codes`: 안정 릴리스가 갱신하는 채널 별칭입니다.
- `nightly.app.t3.codes`: 나이틀리 릴리스가 갱신하는 채널 별칭입니다.

라우터 도메인은 `apps/web/vercel.ts`의 라우트를 사용합니다. 사용자는
`/__t3code/channel?channel=latest` 또는 `/__t3code/channel?channel=nightly`를
방문해 채널을 선택하며, 라우터는 `t3code_web_channel` 쿠키를 저장하고 이후
`app.t3.codes`로 오는 요청을 해당 채널 별칭으로 다시 씁니다.

릴리스 배포 작업은 업로드 전에 릴리스 패키지 버전을 다시 기록하므로 호스팅 앱의
정보 패널에 릴리스 버전이 표시됩니다. 안정 배포는 같은 배포를 `latest` 채널과
라우터 도메인 양쪽에 별칭으로 연결해 라우터 규칙을 최신 상태로 유지합니다.
나이틀리 배포는 `nightly` 채널에만 별칭을 연결합니다. 이 작업은
`VITE_HOSTED_APP_CHANNEL=latest|nightly`도 전달하며, 이 값이 정보 패널에 호스팅
업데이트 트랙 선택기를 표시합니다. 선택기를 바꾸면 라우터 도메인의
`/__t3code/channel`을 거쳐 이동하므로, 호스팅 앱 루트로 리디렉션하기 전에
사용자의 채널 쿠키가 갱신됩니다.

Vercel 대시보드 최초 설정:

1. 웹 프로젝트 루트 디렉터리가 `apps/web`인지 확인합니다.
2. 위 세 도메인을 웹 프로젝트에 추가합니다.
3. 원한다면 대시보드에서 자동 Git 배포를 비활성화할 수 있으며, 커밋된
   `vercel.ts` 설정이 기준이지만 대시보드에서 Git 연결을 해제해도 안전합니다.
4. 안정 릴리스 배포를 한 번 실행하거나 현재 안정 배포에 수동으로 별칭을 연결해,
   `app.t3.codes`가 `apps/web/vercel.ts`의 라우터 규칙을 포함한 배포를 가리키게
   합니다. 이후 안정 릴리스는 이 별칭을 계속 최신 상태로 유지합니다.

## 나이틀리 빌드

- 워크플로: `.github/workflows/release.yml`
- 트리거:
  - 3시간마다 실행되는 예약 확인
  - `channel=nightly`를 지정한 수동 `workflow_dispatch`
- 태그 릴리스 흐름과 동일한 데스크톱 품질 게이트와 아티팩트 매트릭스를 실행합니다.
- GitHub 프리릴리스만 게시합니다:
  - 현재 태그 형식: `vX.Y.Z-nightly.YYYYMMDD.<run_number>`
  - `nightly-v...`는 레거시 이전 나이틀리 태그로만 허용됩니다
  - 릴리스 이름에 짧은 커밋 SHA가 포함됩니다
  - `make_latest`는 항상 `false`입니다
- 다음 안정 패치 버전을 나이틀리 기준으로 사용합니다. 예를 들어 `0.0.17`은 `0.0.18-nightly.*` 형식의 나이틀리를 만듭니다.
- Electron 자동 업데이트 메타데이터를 전용 `nightly` 업데이터 채널에 게시하므로, 데스크톱 사용자는 안정 채널과 무관하게 해당 트랙을 선택할 수 있습니다.
- 같은 나이틀리 버전을 사용해 CLI 패키지(`apps/server`, npm 패키지 `t3`)를 `nightly` npm dist-tag에 게시합니다.
- 버전 상향을 `main`에 커밋하지 않습니다.

## 서버 자체 업데이트 릴리스 불변 조건

연결된 서버는 npm dist-tag가 아니라 클라이언트의 정확한 버전으로 업데이트합니다. 따라서 릴리스된 모든
데스크톱 또는 호스팅 클라이언트 버전은, 사용자가 해당 클라이언트를 받기 전에 npm에 대응하는
`t3@<version>` 패키지가 준비되어 있어야 합니다.

워크플로는 다음 순서를 강제합니다:

1. `publish_cli`가 정확한 안정 또는 나이틀리 버전을 npm에 게시합니다.
2. `release`는 GitHub Releases에 데스크톱 아티팩트를 노출하기 전에 `publish_cli`에 의존합니다.
3. `deploy_web`은 호스팅 채널을 새 클라이언트로 옮기기 전에 `release`에 의존합니다.

릴리스 그래프를 변경할 때 이 의존 관계를 유지하세요. 클라이언트를 먼저 게시하면 **서버 업데이트**
작업이 아직 존재하지 않는 패키지 버전을 가리키게 됩니다.

릴리스 스모크 테스트에서는 `npm view t3@<version> version`이 예상한 버전을 반환하는지 확인한 뒤, 새
클라이언트를 이전 버전 서버에 연결해 업데이트 작업이 일치하는 서버로 다시 연결되는지 검증하세요.
자동 경로에는 마이그레이션 매니페스트가 동일한 릴리스를 사용하세요. 매니페스트가 바뀐 경우에는 원격
작업이 재시작 전에 멈추고 정확한 로컬 `npx t3@<version> service update` 명령을 표시하는지 검증하세요.
해당 환경을 사용할 수 있다면 수동 안내나 데스크톱 관리 안내도 테스트하세요.

## 데스크톱 자동 업데이트 참고 사항

- 업데이터 런타임: `apps/desktop/src/updates/DesktopUpdates.ts`.
- `electron-updater` 어댑터: `apps/desktop/src/electron/ElectronUpdater.ts`.
- `apps/desktop/src/main.ts`는 업데이터 레이어를 데스크톱 런타임에 연결하기만 합니다.
- 업데이트 사용자 경험:
  - 백그라운드 확인은 시작 지연 후 일정 간격으로 실행됩니다.
  - 자동 다운로드나 자동 설치는 없습니다.
  - 업데이트가 있으면 데스크톱 UI에 로켓 모양 업데이트 버튼이 표시되며, 한 번 누르면 다운로드하고 다운로드가 끝난 뒤 다시 누르면 재시작·설치합니다.
- 제공자: 빌드 시점에 설정되는 GitHub Releases(`provider: github`).
- 저장소 슬러그 출처:
  - 설정된 경우 `T3CODE_DESKTOP_UPDATE_REPOSITORY`(형식 `owner/repo`).
  - 그렇지 않으면 GitHub Actions의 `GITHUB_REPOSITORY`.
- 업데이터에 필요한 릴리스 자산:
  - 플랫폼 설치 파일(`.exe`, `.dmg`, `.AppImage`, 그리고 Squirrel.Mac 업데이트 페이로드용 macOS `.zip`)
  - 채널 메타데이터: 안정 릴리스는 `latest*.yml`, 나이틀리 릴리스는 `nightly*.yml`
  - `*.blockmap` 파일(차분 다운로드에 사용)
- macOS 메타데이터 참고:
  - `electron-updater`는 Intel과 Apple Silicon 모두에서 안정 채널은 `latest-mac.yml`을, 나이틀리 채널은 `nightly-mac.yml`을 읽습니다.
  - 워크플로는 GitHub Release를 게시하기 전에 아키텍처별 mac 매니페스트를 채널별 mac 매니페스트 하나로 병합합니다.

## 0) npm OIDC 신뢰 게시 설정 (CLI)

워크플로는 패키지 버전을 정렬한 뒤 `node apps/server/scripts/cli.ts publish`를 실행합니다. 이
스크립트는 `t3` 패키지를 임시로 준비한 다음, 워크스페이스 게시 설정이 올바르게 적용되도록 저장소
루트에서 `vp pm publish --filter t3 ...`를 실행합니다.

체크리스트:

1. npm 조직 또는 사용자가 `t3` 패키지를 소유하고 있는지 확인합니다(필요하면 패키지 이름을 먼저 변경합니다).
2. npm 패키지 설정에서 신뢰 게시자를 설정합니다:
   - 제공자: GitHub Actions
   - 저장소: 이 저장소
   - 워크플로 파일: `.github/workflows/release.yml`
   - 환경(사용하는 경우): npm 신뢰 게시 설정과 일치시킵니다
3. npm 계정과 조직 정책이 해당 패키지의 신뢰 게시를 허용하는지 확인합니다.
4. 릴리스 태그 `vX.Y.Z`를 만들어 푸시하면 워크플로가 다음을 수행합니다:
   - 릴리스 패키지 버전을 `X.Y.Z`로 정렬합니다
   - 웹과 서버를 빌드합니다
   - npm dist-tag `latest`로 CLI 게시 스크립트를 실행합니다
5. 나이틀리 실행은 npm dist-tag `nightly`로 같은 게시 스크립트를 실행합니다.

## 1) 릴리스 검증과 서명되지 않은 빌드

드라이런 태그 경로는 없습니다. `v0.0.0-test.1`을 포함해 허용되는 나이틀리가 아닌 태그를 푸시하면 그
실행은 안정 채널로 분류됩니다. 이 실행은 npm dist-tag `latest`로 `t3`를 게시하고, 실제 GitHub Release를
만들고, 호스팅 앱을 `latest.app.t3.codes`와 `app.t3.codes`에 별칭으로 연결하며, finalize 작업에서
`main`에 버전 상향을 커밋할 수도 있습니다. 워크플로를 검증하려고 테스트 태그를 푸시하지 마세요.

워크플로에는 게시하지 않는 `workflow_dispatch` 모드가 없습니다. 출시 없이 검사와 빌드를 검증하려면
일반 CI나 로컬 품질 게이트를 사용하세요. 안정 채널의 위험을 낮추면서 전체 릴리스 그래프를 실행해
보려면 `channel=nightly`를 수동으로 디스패치할 수 있으며, 이 경우에도 실제 나이틀리 npm 패키지, GitHub
프리릴리스, 데스크톱 업데이터 릴리스, 호스팅 나이틀리 별칭이 게시되지만, 안정 별칭을 갱신하거나
`main`에 버전 상향을 커밋하지는 않습니다. 실제 나이틀리 릴리스를 감수할 수 있을 때만 실행하세요.

버전을 입력해 수동으로 `channel=stable`을 실행하는 것도 실제 안정 채널 릴리스입니다. 서명 시크릿을
생략하면 플랫폼 아티팩트가 서명되지 않을 뿐이며, 게시를 막지는 않습니다.

## 2) Apple 서명 + 공증 설정 (macOS)

워크플로가 사용하는 필수 시크릿:

- `CSC_LINK`
- `CSC_KEY_PASSWORD`
- `APPLE_API_KEY`
- `APPLE_API_KEY_ID`
- `APPLE_API_ISSUER`
- `MACOS_PROVISIONING_PROFILE`(Associated Domains가 포함된 base64 인코딩 프로비저닝 프로파일)

필수 저장소 변수:

- `APPLE_TEAM_ID`

선택 저장소 변수:

- `CLERK_PASSKEY_RP_DOMAINS`: 쉼표로 구분한 RP 도메인 재정의 값입니다. 기본적으로 빌드는 프로덕션
  Clerk 게시 가능 키에서 도메인을 파생합니다.

체크리스트:

1. Apple Developer 계정 접근 권한:
   - 팀에 Developer ID 인증서를 만들 권한이 있어야 합니다.
2. `com.t3tools.t3code`용 명시적 App ID를 만들고 Associated Domains를 활성화합니다.
3. `Developer ID Application` 인증서와, Associated Domains가 활성화된 해당 App ID용 호환 프로비저닝
   프로파일을 만듭니다.
4. 키체인에서 인증서와 개인 키를 `.p12`로 내보냅니다.
5. `.p12`를 base64로 인코딩해 `CSC_LINK`에 저장합니다.
6. 프로비저닝 프로파일을 base64로 인코딩해 `MACOS_PROVISIONING_PROFILE`에 저장합니다.
7. `.p12` 내보내기 암호를 `CSC_KEY_PASSWORD`에 저장하고, `APPLE_TEAM_ID`에 10자리 Apple Developer
   팀 ID를 설정합니다.
8. App Store Connect에서 API 키(팀 키)를 만듭니다.
9. API 키 값을 추가합니다:
   - `APPLE_API_KEY`: 내려받은 `.p8`의 내용
   - `APPLE_API_KEY_ID`: 키 ID
   - `APPLE_API_ISSUER`: 발급자 ID
10. [T3 Connect Clerk 설정](../internals/t3-connect.md#데스크톱-패스키)에서 Clerk Native API와 AASA 설정을 완료합니다.
11. 태그 릴리스를 다시 실행해 macOS 아티팩트가 서명·공증되었고 예상한
    `com.apple.developer.associated-domains` 엔타이틀먼트를 포함하는지 확인합니다.

참고:

- `APPLE_API_KEY`는 시크릿에 원본 키 텍스트로 저장됩니다.
- 워크플로는 실행 시점에 이 값을 임시 `AuthKey_<id>.p8` 파일에 씁니다.
- 워크플로는 `MACOS_PROVISIONING_PROFILE`을 디코딩하고 `security cms`로 검증한 뒤 데스크톱 패키저에
  전달합니다.

## 3) Azure Trusted Signing 설정 (Windows)

워크플로가 사용하는 필수 시크릿:

- `AZURE_TENANT_ID`
- `AZURE_CLIENT_ID`
- `AZURE_CLIENT_SECRET`
- `AZURE_TRUSTED_SIGNING_ENDPOINT`
- `AZURE_TRUSTED_SIGNING_ACCOUNT_NAME`
- `AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME`
- `AZURE_TRUSTED_SIGNING_PUBLISHER_NAME`

체크리스트:

1. Azure Trusted Signing 계정과 인증서 프로파일을 만듭니다.
2. ATS 값을 기록합니다:
   - 엔드포인트
   - 계정 이름
   - 인증서 프로파일 이름
   - 게시자 이름
3. Entra 앱 등록(서비스 주체)을 만들거나 선택합니다.
4. Trusted Signing에 필요한 권한을 서비스 주체에 부여합니다.
5. 서비스 주체용 클라이언트 시크릿을 만듭니다.
6. 위에 나열한 Azure 시크릿을 GitHub Actions 시크릿에 추가합니다.
7. 태그 릴리스를 다시 실행해 Windows 설치 프로그램이 서명되었는지 확인합니다.

## 4) 상시 릴리스 체크리스트

1. CI에서 `main`이 통과 상태인지 확인합니다.
2. 필요에 따라 앱 버전을 올립니다.
3. 릴리스 태그를 만듭니다: `vX.Y.Z`.
4. 태그를 푸시합니다.
5. 워크플로 단계를 확인합니다:
   - 프리플라이트 통과
   - 모든 매트릭스 빌드 통과
   - `publish_cli`가 릴리스 작업 전에 정확한 릴리스 버전을 게시
   - 릴리스 작업이 예상한 파일을 업로드
6. 내려받은 아티팩트를 스모크 테스트합니다.

## 5) 문제 해결

- 서명될 것으로 예상한 macOS 빌드가 서명되지 않은 경우:
  - 모든 Apple 시크릿과 `APPLE_TEAM_ID`가 채워져 있고 비어 있지 않은지 확인합니다.
  - 프로비저닝 프로파일이 `APPLE_TEAM_ID.com.t3tools.t3code`에 속하고 Associated Domains를
    포함하는지 확인합니다.
- 서명될 것으로 예상한 Windows 빌드가 서명되지 않은 경우:
  - 모든 Azure ATS 및 인증 시크릿이 채워져 있고 비어 있지 않은지 확인합니다.
- 서명 오류로 빌드가 실패하는 경우:
  - 시크릿을 제거하고 다시 시도해 서명 없는 경로가 여전히 동작하는지 확인합니다.
  - 인증서·프로파일 이름과 테넌트·클라이언트 자격 증명을 다시 확인합니다.
