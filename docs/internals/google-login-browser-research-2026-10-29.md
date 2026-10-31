# Google 로그인과 에이전트 브라우저 조사

조사일: 2026-10-29. 이 문서는 현재 코드와 공개 자료를 비교한 기록이다. 사용자는 T3 자체 Google 로그인과 T3 내부 브라우저 제어를 요청했고, 기존 페어링을 유지하면서 로그인을 추가하도록 선택했다.

## 현재 T3 코드

- `apps/desktop/src/preview/BrowserSession.ts`는 Electron 미리보기 세션을 `persist:t3code-preview-` 파티션에 저장한다. 세션은 범위 문자열을 해시해 나눈다. Electron 식별자를 사용자 에이전트에서 제거하지만, 이것만으로 일반 Chrome 창이 되지는 않는다.
- `apps/desktop/src/preview/Manager.ts`의 `setWindowOpenHandler`는 새 창 요청을 거부하고 기존 탭을 요청 URL로 이동한다. 새 창의 `window.opener`를 사용하는 사이트 로그인 흐름과는 동작 방식이 다르다.
- `apps/server/src/mcp/toolkits/preview/tools.ts`는 미리보기의 열기, 탐색, 스냅샷, 클릭, 입력, JavaScript 실행 등을 에이전트에 제공한다. 이 도구는 현재 Electron 미리보기 제어 경로이며 별도의 일반 Chrome 창을 만들지는 않는다.
- T3의 환경 접근은 기존 페어링과 세션 인증에 의존한다. 다른 웹사이트의 Google 로그인은 해당 사이트와 Google의 인증 흐름이며 T3 환경 인증과 별개다.

## 참고한 구현과 제약

1. [Microsoft Playwright MCP](https://github.com/microsoft/playwright-mcp/blob/0c4107acbecb75472b23c05c0e42471a0011874f/README.md), `0c4107acbecb75472b23c05c0e42471a0011874f`(2026-10-29 UTC 확인)는 별도 지속 프로필과 기존 브라우저 확장 연결을 지원한다. 지속 프로필은 쿠키와 로그인 상태를 보관하며 같은 프로필을 여러 브라우저 인스턴스가 동시에 사용할 수 없다. [Playwright BrowserType 문서](https://playwright.dev/docs/api/class-browsertype)는 자동화에 기본 Chrome 사용자 데이터 디렉터리를 직접 쓰지 말고 별도 디렉터리를 사용하라고 설명한다. 이는 프로젝트의 공개 구현 설명이며 T3에서 해당 브라우저를 설치하거나 로그인에 성공했다고 검증한 것은 아니다.
2. [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp)는 Chrome DevTools를 에이전트에 연결한다. [Google Chrome의 기존 브라우저 연결 설명](https://developer.chrome.com/blog/chrome-devtools-mcp-debug-your-browser-session)은 사용자 승인 대화상자를 설명한다. 사용자가 기존 작업 중인 브라우저나 입력을 건드리지 말라는 지시와 연결 범위를 검토해야 한다.
3. [Chrome 원격 디버깅 변경 설명](https://developer.chrome.com/blog/remote-debugging-port)에 따르면 Chrome 136부터 기본 사용자 데이터 디렉터리에는 원격 디버깅 포트·파이프 옵션이 적용되지 않는다. 별도 프로필은 이 제한에 맞는 후보지만, 특정 Google 계정 로그인 성공을 보장하지는 않는다.
4. [Google OAuth 정책](https://developers.google.com/identity/protocols/oauth2/policies)은 개발자가 스크립트 삽입이나 쿠키 접근 등을 제어하는 내장 사용자 에이전트에 Google OAuth 인증을 보내지 못하게 한다. 외부 브라우저를 사용하더라도 Google과 개별 사이트의 보안 판단, 팝업, 2단계 인증 등은 실제 계정에서 별도로 확인해야 한다. 사용자 에이전트 문자열 변경을 정책 준수나 로그인 성공의 근거로 삼지 않는다.
5. [Google 데스크톱 OAuth 문서](https://developers.google.com/identity/protocols/oauth2/native-app)는 데스크톱 앱 자체가 Google 인증이나 API 권한을 받는 흐름에서 시스템 브라우저, 로컬 루프백 리디렉션, PKCE를 설명한다. 이 흐름을 구현하려면 해당 앱에 등록된 OAuth 클라이언트가 필요하다. Google 계정으로 T3에 로그인하는 것과 임의의 다른 사이트에 로그인하는 것은 서로 다른 기능이다.
6. 같은 데스크톱 문서는 인증 코드 요청에 PKCE 사용을 요구하고 요청·응답을 연결하는 `state`를 안내한다. 토큰 교환에서 데스크톱 클라이언트의 `client_secret`은 선택 항목이며, 데스크톱 앱은 비밀을 안전하게 보관하는 클라이언트로 간주되지 않는다. [Google OpenID Connect 문서](https://developers.google.com/identity/openid-connect/openid-connect)는 `nonce`를 통한 재사용 공격 방지와 `state` 확인을 설명한다. [Google ID 토큰 검증 문서](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token)는 토큰 서명과 발급자·대상 클라이언트·만료 시각 검증 및 계정 식별자로 `sub`를 사용할 것을 안내한다.

## 비교할 선택지

| 대상                          | 사용 흐름                                                                                                  | 범위와 확인 사항                                                                                                                                                          |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 별도 브라우저의 사이트 로그인 | 사용자가 별도 일반 브라우저에서 Google 및 대상 사이트에 로그인하고, 에이전트가 허용된 브라우저 세션을 제어 | 브라우저 프로필의 저장·분리, 팝업 처리, 연결 해제, 사용자 작업 창과의 분리, 사이트별 Google 로그인 결과 확인 필요. 대상 사이트의 OAuth 클라이언트는 그 사이트가 관리한다. |
| T3 자체의 Google 로그인       | Google 인증 후 T3가 사용자의 신원을 받아 기존 환경 접근과 연결                                             | T3의 OAuth 클라이언트, 콜백, 계정과 기존 페어링 관계, 세션·로그아웃 처리가 필요. 이 로그인만으로 다른 사이트의 로그인 세션이 생기지는 않는다.                             |
| 두 기능 모두                  | 두 흐름을 각각 제공                                                                                        | 각 기능의 설정, 보관 범위와 검증을 따로 확인해야 한다.                                                                                                                    |

로그인된 브라우저를 에이전트에 연결하면 해당 세션에서 가능한 읽기와 조작이 에이전트의 도구 범위에 들어온다. 비밀번호, 쿠키, 인증 코드를 로그나 대화에 전달하는 방식은 선택하지 않았다.

기존 로컬 인증은 데스크톱 부트스트랩 또는 일회용 페어링 자격 증명을 T3 세션으로 교환한다. Google 계정을 확인하는 것과 그 계정에 T3 환경 접근 권한을 부여하는 것은 별개이므로, 기존 페어링과의 관계가 정해지기 전에는 Google 계정의 확인만으로 임의의 사용자에게 T3 권한을 부여하는 것으로 간주하지 않는다.

## 선택과 구현 상태

사용자는 기존 페어링을 유지하면서 Google 로그인을 추가하도록 선택했고, OAuth 클라이언트 준비 여부는 모른다고 답했다. 현재 환경에서 클라이언트 ID는 확인되지 않았다. 후보 코드는 시스템 브라우저와 루프백 콜백을 사용해 Google 신원을 확인하고 데스크톱 실행 중에만 그 결과를 유지한다. 설정 화면은 이 확인이 기존 T3 환경 접근권을 부여하거나 다른 웹사이트 세션을 만들지 않는다는 점을 명시한다. 기존 페어링을 유지한 실제 T3 환경 로그인과 별도 제어 브라우저의 사이트 로그인 연결은 아직 완성하거나 실계정으로 검증하지 않았다.
