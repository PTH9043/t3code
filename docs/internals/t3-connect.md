# T3 Connect

> 메인테이너용 문서입니다. T3 Code를 사용 중이신가요? [docs/user](../user/)를 참고하세요.

T3 Connect는 웹·데스크톱·모바일 인증에 하나의 Clerk 애플리케이션을 사용합니다. relay(중계 서버)는 두
종류의 bearer 자격 증명을 검증합니다: 공유 audience `t3-code-relay`로 `t3-relay` 템플릿에서 생성한
템플릿 JWT, 그리고 CLI에 발급된 Clerk OAuth 토큰입니다. `infra/relay/src/http/Api.ts`의
`verifyRelayClientBearerToken`은 템플릿/세션 경로를 먼저 시도하고 실패하면 OAuth 검증
(`acceptsToken: "oauth_token"`)으로 넘어가므로, CLI의 OAuth 자격 증명은 JWT 템플릿 없이도 동작합니다.

전체 시스템 다이어그램은
[t3-code-connect-auth-flow.html](./t3-code-connect-auth-flow.html)을 참고하세요.

## 애플리케이션 키

새로 클론한 저장소에서는 T3 Connect가 비활성화되어 있습니다. 프로덕션 배포를 대상으로 하는 소스
빌드에서 활성화하려면, 저장소 루트의 예시 파일을 복사하세요:

```sh
cp .env.example .env
```

`.env.example`에는 프로덕션 공개 식별자가 들어 있습니다(공식 릴리스 빌드에 포함된 값과 동일합니다).
다른 Clerk 애플리케이션이나 relay를 사용하려면, 저장소 루트의 `.env` 또는 `.env.local` 파일에 값을
직접 설정하세요:

```dotenv
T3CODE_CLERK_PUBLISHABLE_KEY=<publishable key>
T3CODE_CLERK_JWT_TEMPLATE=<JWT template name>
T3CODE_CLERK_CLI_OAUTH_CLIENT_ID=<public OAuth application client ID>
T3CODE_RELAY_URL=https://relay.example.com
```

공용 클라이언트 로더는 이 표준 값들을 프레임워크별 `VITE_*` 및 `EXPO_PUBLIC_*` 별칭으로 투영합니다.
기존 별칭도 호환성을 위해 재정의 값으로 계속 허용하지만, 새로 작성하는 클라이언트 설정에는 표준 이름을
사용해야 합니다.

설정 우선순위는 다음과 같습니다.

1. 프로세스 또는 CI 환경 변수.
2. 저장소 루트의 `.env.local`.
3. 저장소 루트의 `.env`.

Clerk publishable key, JWT 템플릿 이름, CLI OAuth 클라이언트 ID, relay URL은 비밀 값이 아니라 공개
식별자입니다.
웹·데스크톱·모바일·번들 서버 빌드는 각자 사용하는 값을 빌드 단계에서 정적으로 주입합니다. 빌드된
아티팩트는 런타임에 환경 파일이 필요하지 않습니다. CI 릴리스 빌드는 빌드 전에
`T3CODE_CLERK_PUBLISHABLE_KEY`, `T3CODE_CLERK_JWT_TEMPLATE`,
`T3CODE_CLERK_CLI_OAUTH_CLIENT_ID`, `T3CODE_RELAY_URL`을 설정해야 합니다. EAS 프리뷰·프로덕션
빌드는 EAS 환경에 Clerk publishable key, JWT 템플릿 이름, relay URL만 있으면 됩니다.

클라이언트에 노출되는 공개 값이 하나라도 없으면 클라우드 UI는 표시되지 않습니다. `t3 connect` 명령
그룹은 항상 등록됩니다: CLI 공개 값이 없으면 `apps/server/src/bin.ts`의 `makeCli`가 숨김 처리된 대체
`connect` 명령을 등록해, 도움말에서 조용히 사라지는 대신 누락된 설정을 알려 줍니다. 번들 서버는 자체
호스팅이나 운영자 관리 배포를 위해 런타임 재정의를 계속 허용합니다.

호스팅 relay 배포에서는 `infra/relay/.env.example`을 `infra/relay/.env`로 복사하세요. relay 배포는
`RELAY_DOMAIN`, `RELAY_API_ZONE_NAME`, `RELAY_TUNNEL_ZONE_NAME`,
`CLERK_PUBLISHABLE_KEY`, `CLERK_JWT_AUDIENCE`를 Effect `Config`로 읽습니다. 저장소에 커밋된 배포
기본값은 없습니다.
`vp run --filter t3code-relay deploy`는 relay 디렉터리에서 Alchemy를 실행하므로, Alchemy가
`infra/relay/.env`를 읽습니다. 배포에 성공하면 래퍼가 저장소 루트의 `.env`를 배포된 HTTPS relay URL로
갱신합니다. relay에는 여전히 Alchemy 시크릿으로 `CLERK_SECRET_KEY`가 필요합니다.
`CLERK_SECRET_KEY`를 클라이언트 애플리케이션 환경에 넣거나 저장소에 커밋하지 마세요.

`prod` Alchemy 스테이지가 보존되는 PlanetScale 데이터베이스를 소유합니다. 비프로덕션 스테이지는 그
데이터베이스를 참조하면서 격리된 PlanetScale 브랜치를 생성하므로, 개인 개발 스테이지를 만들기 전에
`prod`를 먼저 배포하세요.

## 헤드리스 CLI OAuth 애플리케이션

`t3 connect` 명령은 별도의 Clerk OAuth 애플리케이션으로 헤드리스 환경을 인가합니다. 이 방식은 PKCE를
사용하는 OAuth 공개 클라이언트를 쓰므로, CLI는 클라이언트 시크릿을 저장하지 않습니다.

**Clerk Dashboard → OAuth 애플리케이션**에서 다음을 진행합니다.

1. T3 CLI용 OAuth 애플리케이션을 만듭니다.
2. 인가 코드 교환이 PKCE를 사용하도록 **공개** 옵션을 켭니다.
3. 허용 리디렉트 URI를 **둘 다** 추가합니다.
   - 루프백 리스너용 `http://127.0.0.1:34338/callback`;
   - 호스팅 아웃오브밴드 흐름용 `https://app.t3.codes/connect/callback`. 이 값은
     `packages/shared/src/connectAuth.ts`의 `connectCallbackUrl(DEFAULT_HOSTED_APP_URL)`이므로,
     `T3CODE_HOSTED_APP_URL`을 직접 지정하면 `$T3CODE_HOSTED_APP_URL/connect/callback`이 됩니다.
     이 항목을 빠뜨리면 헤드리스와 SSH 인가가 동작하지 않습니다.
4. `openid`, `profile`, `email` 스코프를 활성화합니다.
5. 저장소 루트의 `.env` 파일과 릴리스 빌드 환경에서 `T3CODE_CLERK_CLI_OAUTH_CLIENT_ID`를 생성된 공개
   클라이언트 ID로 설정합니다.

CLI는 publishable key에서 Clerk의 프런트엔드 API URL을 유도하고 Clerk의 `/oauth/authorize`,
`/oauth/token` 엔드포인트를 직접 호출합니다. relay는 OAuth 핸드셰이크에 관여하지 않으며, CLI가 환경
연결을 관리할 때 발급된 Clerk bearer 토큰만 검증합니다.

connect 명령 그룹은 다음과 같습니다.

```sh
t3 connect            # default: onboarding
t3 connect login
t3 connect link       # --publish-only
t3 connect status     # --json
t3 connect publish    # --disable
t3 connect unlink
t3 connect logout
```

`t3 serve`는 connect 하위 명령이 아니라 별도의 최상위 명령입니다.

`t3 connect login`은 Clerk 인가 흐름을 열고 클라우드 노출을 활성화하지 않은 채 CLI 자격 증명을
저장합니다. `t3 connect link`는 필요할 때 고정된 관리형 `cloudflared` 바이너리를 설치하고, 필요할 때
인가를 진행하며, 환경을 노출하겠다는 의도를 영구적으로 기록합니다. 이 명령은 T3 서버가 실행 중이 아니어도
동작합니다. 다음번 `t3 serve` 또는 `t3 start`가 relay 연결을 조정하고 관리형 터널을 실행합니다.
`t3 connect unlink`는 비활성화 의도를 즉시 기록하고, 접근 가능한 실행 중 커넥터를 중지하며, relay 쪽 환경
기록의 취소를 시도합니다. 저장된 CLI 인가는 유지하므로 `t3 connect link`로 브라우저 흐름을 다시 거치지
않고 노출을 다시 활성화할 수 있습니다. `t3 connect
logout`은 같은 정리 작업을 수행하고 저장된 CLI 인가도 제거합니다.

백그라운드 서비스는 독립적인 수명 주기를 가집니다. Connect 설정 과정에서 설치를 제안할 수 있지만
logout은 서비스를 계속 실행 상태로 두므로, `t3 service status`, `install`, `update`, `uninstall`로
관리하세요.

### 헤드리스 및 SSH 인가

루프백 OAuth 콜백 리스너는 `34338` 포트에 바인딩합니다. 이 경로는 같은 컴퓨터의 브라우저가 접근할 수
있을 때만 동작하므로, `apps/server/src/cli/connect.ts`의 `authorizeCli`는 `--headless`가 전달되었거나
`SSH_CONNECTION` 또는 `SSH_TTY`로 SSH를 감지한 경우 자동으로 아웃오브밴드 흐름을 선택합니다.
아웃오브밴드 흐름은 호스팅 `/connect` 인가 URL을 출력하고 붙여 넣은 인가 코드를 받으므로, 포트를
사용하지 않습니다.

따라서 포트 포워딩은 필수가 아니라 선택입니다. SSH에서 굳이 루프백 흐름을 사용하려는 경우에만 포트를
포워딩하세요:

```sh
ssh -L 34338:127.0.0.1:34338 <host>
```

## JWT 템플릿

**Clerk Dashboard → JWT 템플릿**에서 다음 내용으로 템플릿을 만드세요.

| 설정   | 값                           |
| ------ | ---------------------------- |
| 이름   | `t3-relay`                   |
| 클레임 | `{ "aud": "t3-code-relay" }` |

저장소 루트의 `.env`에 `T3CODE_CLERK_JWT_TEMPLATE=t3-relay`를, `infra/relay/.env`에
`CLERK_JWT_AUDIENCE=t3-code-relay`를 설정하세요. 프로덕션 relay 배포 환경에도 `CLERK_JWT_TEMPLATE`과
`CLERK_JWT_AUDIENCE`를 정의하세요. 이 고정된 `aud` 값은 프로덕션과 비프로덕션 relay 스테이지가 함께
사용합니다. 클라이언트에 노출되는 `T3CODE_RELAY_URL`이 구체적인 relay 배포를 선택하는 역할은
그대로지만, 이 URL을 바꾼다고 JWT 템플릿을 바꿀 필요는 없습니다.

## 데스크톱 OAuth 리디렉트 허용 목록

데스크톱 앱은 시스템 브라우저에서 OAuth를 열고 사용자 지정 URL 스킴으로 앱에 복귀합니다.
**Clerk Dashboard → 네이티브 애플리케이션**에서 Native API를 활성화하고, 모바일 SSO 리디렉트 허용
목록에 다음 항목을 추가하세요:

```text
t3code-dev://app/
t3code://app/
```

로컬 데스크톱 개발에서는 `t3code-dev://app`을, 패키징된 빌드에서는 `t3code://app`을 사용합니다. 각
Clerk 인스턴스의 Backend API `allowed_origins` 배열에도 해당 오리진을 추가하세요. 개발용 Clerk
인스턴스에는 `t3code-dev://app`만, 프로덕션 Clerk 인스턴스에는 `t3code://app`만 있으면 됩니다.
`@clerk/electron`이 네이티브 요청 어댑터, Clerk 토큰의 암호화 저장, 외부 브라우저 OAuth 트랜스포트, 최초
로그인 및 계정 연동 흐름의 콜백 전달을 담당합니다.

현재 `allowed_origins`를 설정하는 대시보드 UI는 없습니다. 기존 항목을 유지한 채 Backend API로 인스턴스를
갱신하세요:

```sh
curl -X PATCH https://api.clerk.com/v1/instance \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $CLERK_SECRET_KEY" \
  -d '{"allowed_origins":["t3code://app"]}'
```

`CLERK_SECRET_KEY`를 데스크톱 앱, 클라이언트에 노출되는 환경 파일, 빌드 아티팩트에 넣지 마세요.

## 데스크톱 패스키

프로덕션 macOS 번들 ID는 `com.t3tools.t3code`입니다. 네이티브 패스키를 활성화하려면 다음을 수행하세요.

1. Apple Developer 포털에서 `com.t3tools.t3code`용 명시적 macOS App ID를 만들고 **연결된 도메인**을
   활성화합니다.
2. 해당 App ID와 배포용 앱 서명에 사용하는 인증서에 맞는 macOS 프로비저닝 프로파일을 만듭니다.
3. Clerk의 Native API 설정에서 동일한 Apple Team ID와 번들 ID로 iOS 앱을 추가합니다. 이 항목이
   Electron/macOS 패스키의 설정 지점이기도 합니다.
4. Clerk가 `https://<frontend-api>/.well-known/apple-app-site-association`을 제공하는지, 그리고
   `webcredentials.apps`에 `<TEAM_ID>.com.t3tools.t3code`가 들어 있는지 확인합니다.
5. 아래에 설명한 로컬 또는 CI 서명 설정을 구성합니다.

로컬 서명 빌드에서는 다음 값을 `.env.local`에 추가하거나, 데스크톱 아티팩트 명령을 실행하기 전에 export
하세요:

```dotenv
T3CODE_APPLE_TEAM_ID=ABC1234567
T3CODE_MACOS_PROVISIONING_PROFILE=/absolute/path/to/t3code.provisionprofile
# Optional: comma-separated override when Clerk's RP ID differs from the Frontend API hostname.
T3CODE_CLERK_PASSKEY_RP_DOMAINS=example.clerk.accounts.dev,clerk.example.com
```

`T3CODE_CLERK_PASSKEY_RP_DOMAINS`가 없으면 빌드가 `T3CODE_CLERK_PUBLISHABLE_KEY`에서 RP 도메인을
유도합니다. 서명된 macOS 빌드는 Team ID, 프로비저닝 프로파일, RP 도메인 설정이 없으면 초기에 실패합니다.
생성되는 메인 앱 entitlements에는 설정된 모든 `webcredentials:<domain>` 항목이 포함되고, 헬퍼 앱은
Electron의 최소 기본 entitlements를 유지합니다.

일반 `dev:desktop` 실행기는 서명되지 않아 macOS 패스키 절차를 완료할 수 없습니다. 렌더러 HMR을
사용하려면 먼저 서명된 앱을 빌드해 설치하고, 렌더러 개발 서버를 실행한 다음, `VITE_DEV_SERVER_URL`과
`T3CODE_PORT`를 설정한 상태로 설치된 앱 실행 파일을 실행하세요. 네이티브 의존성, 메인 프로세스,
preload, entitlement, 프로비저닝, 서명이 변경되면 서명된 앱을 다시 빌드해야 하며, 렌더러만 변경된
경우에는 설치된 앱을 그대로 사용할 수 있습니다.

기본 개발 포트를 사용하려면 한 터미널에서 `pnpm dev:web`을 실행하고 다른 터미널에서 설치된 바이너리를
실행하세요:

```sh
VITE_DEV_SERVER_URL=http://127.0.0.1:5733 \
T3CODE_PORT=13773 \
  "/Applications/T3 Code (Alpha).app/Contents/MacOS/T3 Code (Alpha)"
```

macOS가 같은 앱/버전 조합에 대해 오래된 Shared Web Credentials 메타데이터를 재사용할 수 있으므로,
연결된 도메인을 변경한 뒤에는 다시 빌드하기 전에 빌드 버전을 올리세요.

테스트 전에 설치된 번들을 확인하세요:

```sh
codesign --verify --deep --strict "/Applications/T3 Code (Alpha).app"
codesign -d --entitlements :- "/Applications/T3 Code (Alpha).app"
```

현재 모바일 UI는 Clerk의 네이티브 인증 화면을 사용합니다. 앞으로 모바일 브라우저 OAuth 흐름이 사용자
지정 리디렉트 URI를 사용하게 되면, 그 URI를 그대로 같은 허용 목록에 추가하세요.

## 로그인 진입 지점

로그인한 사용자는 **연결**에서 T3 Connect를 관리합니다. 설정 사이드바에도 `SettingsSidebarNav.tsx`가
렌더링하는 전용 컨트롤이 있습니다: 로그아웃 상태에서는 푸터의 `T3ConnectSidebarSignIn`이
**T3 Connect 로그인** 버튼을 보여 주고, 로그인 상태에서는 `T3ConnectSidebarAvatar`가 Clerk
`UserButton` 계정 컨트롤을 보여 줍니다. 둘 다 클라우드 공개 설정이 있어야 표시됩니다.
데스크톱은 동일한 웹 번들을 렌더링하므로 데스크톱에도 함께 표시됩니다. 비공개 베타 시절의 대기자 등록
흐름은 Connect가 정식 출시되면서 제거되었고, 아래의 Clerk 제한을 켜지 않는 한 가입은 열려 있습니다.

## 가입 제한: 사전 등록 사용자 허용 목록

허용된 사용자를 모두 미리 알고 있는 폐쇄형 배포에서는 가입을 허용된 이메일 주소나 도메인으로
제한하세요.

1. **Clerk Dashboard → 제한 → 허용 목록**에서 허용할 이메일 주소나 이메일 도메인을 하나씩
   추가합니다.
2. 허용 목록을 활성화하고 저장합니다.
3. 모든 신규 사용자를 명시적으로 초대하거나 직접 생성해야 한다면, 대신 **제한 모드**를 활성화합니다.

비어 있는 허용 목록은 활성화하지 마세요: 모든 신규 가입이 차단됩니다.

Clerk 허용 목록은 누가 가입할 수 있는지를 제어합니다. 이미 존재하는 사용자의 활성 클라우드 접근 권한을
취소하지는 않습니다. 이미 생성된 사용자의 접근을 없애려면 Clerk에서 해당 사용자를 차단하여 활성 세션이
종료되고 이후 로그인이 거부되도록 하세요.
