# 환경 인증 프로파일

> 메인테이너용 문서입니다. T3 Code를 사용 중이신가요? [docs/user](../user/)를 참고하세요.

환경 서버와 relay(중계 서버)는 서로 다른 자격 증명, 발급자, 신뢰 경계를 사용합니다. 두
곳은 의도적으로 비슷한 OAuth 형태의 모델을 사용하며, 그래야 권한 검사와 토큰 교환
동작을 이미 확립된 개념에 비추어 감사할 수 있습니다.

## 인가 모델

환경 인가는 권한 단위(capability) 기반입니다. 세션은 OAuth 형식의 스코프 문자열을 0개
이상 가집니다.

| 스코프                  | 권한                                                              |
| ----------------------- | ----------------------------------------------------------------- |
| `orchestration:read`    | 스냅샷, 상태, 이벤트, 설정, 파일시스템/VCS 상태를 읽습니다.       |
| `orchestration:operate` | 사용자 작업을 전달하고 환경 쪽 프로젝트 상태를 변경합니다.        |
| `terminal:operate`      | 터미널을 생성, 연결, 입력, 크기 조절, 비우기, 재시작, 종료합니다. |
| `review:write`          | 리뷰 피드백을 작성할 때 사용하는 리뷰 diff 미리보기를 읽습니다.   |
| `access:read`           | 페어링 링크와 클라이언트 세션을 조회합니다.                       |
| `access:write`          | 페어링 링크와 클라이언트 세션을 생성하거나 취소합니다.            |
| `relay:read`            | 관리형 relay 연결 상태를 조회합니다.                              |
| `relay:write`           | 관리형 relay 연결을 연결하거나 설정하거나 해제합니다.             |

일반 페어링 링크는 클라이언트 작업용 스코프 네 개와 관리형 relay 연결에 대한 읽기
권한을 부여합니다:
`orchestration:read orchestration:operate terminal:operate review:write relay:read`.
데스크톱 부트스트랩 자격 증명과 명령줄 관리용 부트스트랩 자격 증명은 여기에 더해
`access:read access:write relay:write`를 부여합니다.

## 인증 흐름

### 브라우저 세션

`POST /api/auth/browser-session`은 일회용 부트스트랩 자격 증명을 소비해 브라우저 세션
쿠키를 만듭니다. 이 쿠키는 동일한 스코프 기반 세션 모델을 위한 HTTP 트랜스포트
어댑터이며, 응답이 세션 비밀값을 브라우저 JavaScript에 노출하는 일은 없습니다.

### Bearer 액세스 토큰

브라우저가 아닌 클라이언트는 `application/x-www-form-urlencoded` 본문과 함께
`POST /oauth/token`을 사용합니다.

```text
grant_type=urn:ietf:params:oauth:grant-type:token-exchange
subject_token=<bootstrap credential>
subject_token_type=urn:t3:params:oauth:token-type:environment-bootstrap
requested_token_type=urn:ietf:params:oauth:token-type:access_token
scope=orchestration:read orchestration:operate terminal:operate review:write relay:read
```

클라이언트는 `client_label`, `client_device_type`, `client_os` 확장 매개변수를 추가로
보낼 수 있으며, 그러면 인가된 클라이언트 UI가 세션을 맺은 기기를 식별할 수 있습니다.
이 값들은 표시용 힌트일 뿐이며, 환경은 IP 주소나 사용자 에이전트 같은 트랜스포트
메타데이터를 요청에서 얻고 이 필드를 인가에 사용하지 않습니다.

응답은 토큰 교환 형식을 따릅니다.

```json
{
  "access_token": "<opaque session token>",
  "issued_token_type": "urn:ietf:params:oauth:token-type:access_token",
  "token_type": "Bearer",
  "expires_in": 2592000,
  "scope": "orchestration:read orchestration:operate terminal:operate review:write relay:read"
}
```

일반 bearer 교환으로 발급된 세션은 저장소의 `DEFAULT_SESSION_TTL`인 30일을 사용합니다.
더 짧은 한 시간짜리 `expires_in: 3600`은 DPoP 바인딩 교환에만 적용되며, 이때 토큰은
증명 키로 추가 제약을 받습니다. `SessionStore.ts`와 `EnvironmentAuth.ts`를 참고하세요.

요청한 스코프는 일회용 부트스트랩 자격 증명이 부여한 범위의 부분집합이어야 합니다.
따라서 일반적으로 페어링된 클라이언트는 자신이 받은 권한을 `access:read`,
`access:write`, `relay:write`로 교환할 수 없습니다.

### DPoP 바인딩 액세스 토큰

같은 `/oauth/token` 교환은 소유 증명 토큰도 지원합니다. `DPoP` 헤더를 보낸 클라이언트는
`verifyRequestDpopProof`로 증명을 검증받으며, 그 결과로 나온 JWK 지문이 세션에 저장되고
해당 세션은 bearer 기본값 대신 `dpop-access-token` 방식과 한 시간 TTL로 발급됩니다.
증명이 유효하지 않으면 bearer 토큰 대신 DPoP 챌린지 헤더와 자격 증명 오류를 받습니다.

`dpop-access-token`은 디스크립터의 `sessionMethods`(`EnvironmentAuthPolicy.ts`)에서
`browser-session-cookie`, `bearer-access-token`과 함께 알려지므로, 클라이언트는 지원
여부를 넘겨짚지 않고 확인할 수 있습니다. relay를 거치는 클라이언트는 이 방식을
사용하므로, 토큰이 유출되어도 대응하는 키 없이는 재사용할 수 없습니다.

### WebSocket 티켓

`POST /api/auth/websocket-ticket`은 인증된 세션이면 모두 받아들여,
`EnvironmentAuth.issueWebSocketTicket`을 통해 기본 5분 TTL로 발급되는 수명이 짧고 용도가
하나뿐인 WebSocket 티켓을 반환합니다. 클라이언트는 헤더에 bearer 또는 DPoP 자격 증명을
담아 티켓을 받은 뒤, 소켓 URL에는 그 티켓만 `wsTicket`으로 붙입니다. 이렇게 하면 수명이
긴 토큰과 브라우저 쿠키를 WebSocket URL 밖에 두면서도 핸드셰이크에서 인증할 수
있습니다.

티켓은 자신이 속한 세션의 스코프를 함께 가지며, 이후 각 RPC 메서드는
`apps/server/src/auth/RpcAuthorization.ts`의 `RPC_REQUIRED_SCOPES`를 통해
`orchestration:read`, `orchestration:operate`, `terminal:operate`, `review:write`,
`relay:write`, `access:read` 중 알맞은 스코프를 요구합니다. 리뷰 피드백 제출은 현재
오케스트레이션 작업을 전달하므로, 이를 수행하는 클라이언트에는 `orchestration:operate`도
필요합니다. 티켓을 만들었다고 해서 모든 RPC 메서드를 호출할 인가가 생기는 것은 아닙니다.

## 표준 정합성

- Bearer 액세스 토큰은 RFC 6750의 `Authorization: Bearer` 방식으로 사용합니다.
- 토큰 엔드포인트는 OAuth 2.0 토큰 교환(RFC 8693)의 요청·응답 어휘를 프로파일로 삼으며,
  여기에는 `subject_token`, `requested_token_type`, `access_token`,
  `issued_token_type`, `token_type`이 포함됩니다.
- 스코프 값은 공백으로 구분되고 순서가 없으며 교환 시 부분집합 검사를 거치는 권한
  단위로, RFC 6749의 OAuth 2.0 스코프 모델을 따릅니다.

이것은 의도적으로 범용 OAuth 인가 서버가 아닙니다. 환경 부트스트랩 토큰 타입은
비공개이고, 부트스트랩 쿠키와 WebSocket 연결 토큰 경로는 제품 전용 어댑터이며, API는
모든 OAuth 오류 응답 표면을 구현하는 대신 타입이 정해진 `HttpApi` 오류를 반환합니다.

## 업그레이드 동작

마이그레이션 `031_AuthAuthorizationScopes`는 역할을 담고 있던 인증 레코드에서 스코프
기반 레코드로 한 번에 전환합니다. 이 마이그레이션은 기존 페어링 링크와 세션을
삭제하지만 인증과 무관한 환경 상태는 그대로 둡니다. 업그레이드한 클라이언트는 다시
페어링해야 하며, 예전 `owner` 또는 `client` 자격 증명이 새 권한 단위로 조용히 매핑되는
일은 없습니다.

## relay 경계

relay가 관리하는 터널은 자체 토큰과 키를 사용합니다. relay는 스코프 파싱과 토큰 교환
관례를 재사용할 수 있지만, 환경 액세스 토큰은 relay 토큰이 아니며 relay에 제시할 수
없습니다.
