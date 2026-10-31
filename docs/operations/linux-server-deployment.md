# Linux 서버 배포

현재 작업 사본의 웹과 백엔드를 하나의 이미지로 빌드한다. RAG, 첨부 파일, 예약 작업, 오케스트라와 제공자 실행은 이 서버에 속한다. 데스크톱 Electron과 모바일 앱은 접속 클라이언트로 사용한다.

## 구성

- `infra/server/Dockerfile`: Node 24 기반 Linux 이미지. 웹과 서버만 빌드하고 운영 의존성을 분리한다. Node와 Caddy 이미지는 확인한 digest로 고정했다.
- `infra/server/compose.yaml`: 서버, 영구 데이터, 선택적 HTTPS 프록시, 재시작과 로그 회전을 설정한다.
- `infra/server/Caddyfile`: 같은 주소에서 웹·API·WebSocket을 전달한다. Caddy가 HTTPS 인증서를 발급·갱신한다. [Caddy reverse_proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy), [자동 HTTPS](https://caddyserver.com/docs/automatic-https).
- `infra/server/healthcheck.mjs`: 환경 API의 실제 JSON과 웹 HTML을 모두 확인한다.

서버는 Docker Engine과 Compose를 설치한 Linux를 기준으로 한다. 실행할 AI·프로젝트의 메모리 요구량은 별도이며, 작은 서버에서는 우선 필요한 제공자만 연결한다. 로컬 의미 검색/Ollama는 기본 구성에 포함하지 않는다. SQLite 기반 키워드 RAG와 문서 추출은 서버에 포함된다.

## 빌드와 시작

저장소 루트에서 실행한다. 아래 명령은 Linux 셸 명령이다. Windows에서 빌드할 때도 Docker 명령은 CMD에서 사용할 수 있다.

```sh
cp infra/server/.env.example infra/server/.env
docker compose --env-file infra/server/.env -f infra/server/compose.yaml config --quiet
docker compose --env-file infra/server/.env -f infra/server/compose.yaml build server
docker compose --env-file infra/server/.env -f infra/server/compose.yaml up -d server
docker compose --env-file infra/server/.env -f infra/server/compose.yaml ps
```

기본 접속은 서버 자신의 `http://127.0.0.1:3773`이다. 원격에서 시험할 때는 SSH 포워딩을 사용할 수 있다.

```sh
ssh -L 3773:127.0.0.1:3773 user@server
```

브라우저를 열기 전에 서버 로그에서 최초 관리자 페어링 URL을 확인한다. 서버 내부 주소가 출력되면 **토큰을 포함한 전체 경로와 해시는 유지하고 origin만 실제 접속 주소로 교체한다.** 최초 관리자 토큰은 설정 → 연결 관리에도 필요하다.

```sh
docker compose --env-file infra/server/.env -f infra/server/compose.yaml logs --tail=150 server
```

추가 기기의 표준 권한 페어링 링크는 실행 중인 같은 데이터 홈을 지정해 발급한다. 최초 관리자 링크와 권한이 다르다.

```sh
docker compose --env-file infra/server/.env -f infra/server/compose.yaml exec server node /app/dist/bin.mjs pair --base-dir /home/node/.t3
```

## 도메인 HTTPS

`infra/server/.env`의 `T3_DOMAIN`을 실제 도메인으로 변경하고 DNS를 서버로 연결한다. 서버 방화벽에서 TCP 80·443을 허용한다. 3773은 loopback에만 게시된다. 다른 프록시가 이미 80·443을 사용한다면 기존 프록시에서 서버의 `127.0.0.1:3773`으로 HTTP와 WebSocket을 함께 전달한다.

```sh
docker compose --env-file infra/server/.env -f infra/server/compose.yaml --profile https up -d --no-build
```

앱은 같은 origin을 사용한다. `VITE_HTTP_URL`, `VITE_WS_URL`, `VITE_DEV_SERVER_URL`을 설정할 필요가 없다. Caddy는 WebSocket 업그레이드를 기본 지원한다.

## 제공자와 프로젝트

서버 이미지에는 Node, npm, Git, SSH 클라이언트, Python이 들어 있다. 모델 호출은 서버에 설치·인증한 제공자가 수행한다. 필요한 CLI는 비관리자 계정의 영구 홈에 설치한다. 예를 들어 Codex와 Claude를 사용할 경우:

```sh
docker compose --env-file infra/server/.env -f infra/server/compose.yaml exec server npm install --global @openai/codex @anthropic-ai/claude-code
```

그다음 앱의 설정 → 제공자에서 **이 서버 환경**의 계정을 연결한다. 제공자별 브라우저 로그인 또는 API 키 입력이 필요할 수 있다. 이미지 업데이트 후에도 설치한 CLI와 계정 파일은 `server_home`에 남는다. 프로젝트는 `/workspaces` 아래에 clone하거나 별도 bind mount로 연결한다. 개발에 필요한 다른 언어·컴파일러는 프로젝트 요구에 맞춰 이미지를 확장한다.

현재 Windows의 `D:` 프로젝트 경로, `E:/NewAutoUsage` 운영 DB, 제공자 자격 증명은 자동 복사하지 않는다. 기존 환경을 옮길 때는 일관된 SQLite snapshot과 첨부·프로젝트 파일을 함께 준비하고, 프로젝트·프로그램 실행 경로와 운영체제 차이를 검토한다. 서버에서 새 환경으로 시작하는 것과 Windows 운영 환경을 그대로 이전하는 것은 다른 작업이다.

## 데이터와 백업

Compose 프로젝트 이름의 기본값은 `newautousage`다. `server_home` 볼륨은 `/home/node`에 연결되며 `.t3/userdata/state.sqlite`, 첨부·OCR 캐시·설정·비밀 저장소, 제공자 로그인과 사용자 설치 CLI를 보관한다. `projects` 볼륨은 `/workspaces`, `caddy_data`는 인증서를 보관한다. 앱 컨테이너는 UID/GID 1000으로 실행한다. bind mount를 쓴다면 해당 계정이 쓸 수 있어야 한다.

전체 홈과 프로젝트의 일관된 파일 백업은 실행 중인 작업을 마친 뒤 서버를 중지하고 수행한다. Docker 볼륨은 `down`만으로 삭제되지 않는다. **`down --volumes`는 운영 데이터를 삭제하므로 사용하지 않는다.** 실행 중 DB를 일반 파일 복사로 백업하지 않는다.

```sh
docker compose --env-file infra/server/.env -f infra/server/compose.yaml stop server
# 이 시점에 server_home과 projects 볼륨을 백업한다.
docker compose --env-file infra/server/.env -f infra/server/compose.yaml up -d --no-build server
```

## 상태 확인과 업데이트

```sh
docker compose --env-file infra/server/.env -f infra/server/compose.yaml exec server node /app/healthcheck.mjs
curl --fail http://127.0.0.1:3773/.well-known/t3/environment
docker compose --env-file infra/server/.env -f infra/server/compose.yaml logs --tail=100 server
```

업데이트는 작업 종료 → 데이터 백업 → 새 이미지 빌드/로드 → 같은 볼륨으로 재생성 순서다. 이 사용자 정의 이미지는 원본 npm 릴리스와 별도로 관리하며, `npx t3@latest service update`로 교체하지 않는다. 이전 이미지는 별도 태그로 보존한다. 데이터 마이그레이션 후 구버전으로 돌아가려면 그 버전과 짝인 DB 백업도 필요하다.

소스 빌드 없이 배포할 대상에는 현재 컴퓨터에서 검증한 이미지를 `docker save`로 전달한 뒤 `docker load`한다. 서버에도 `infra/server` 설정 폴더를 같은 구조로 전달하고 `up -d --no-build`를 사용한다. HTTPS 프로필을 켜면 Caddy 공식 이미지도 내려받는다. Windows에서 만든 Linux 이미지는 Windows 실행 파일을 포함하지 않으며, CPU 아키텍처는 빌드한 이미지와 서버가 일치해야 한다.

## 검증 기록

2026-10-18에 Docker Desktop의 별도 Linux/amd64 컨테이너와 전용 볼륨·네트워크에서 확인했다.

- 저장소 잠금 파일을 유지한 웹·서버 빌드, 운영 의존성 218개 분리, 이미지 생성 통과.
- Compose HTTPS 프로필 설정 검사, Caddy의 실제 설정 검증 통과.
- 직접 접속 및 별도 Caddy HTTP 프록시를 통해 환경 JSON, 웹 HTML, 메인 JavaScript, 익명 상태, 비인증 요청 401, 최초 페어링, 인증 쿠키, WebSocket 티켓과 연결 업그레이드 통과.
- `node-pty`로 Linux 프로세스를 실제 실행해 출력과 정상 종료 확인.
- 서버 데이터 홈의 RAG 기억·검색·자동 개발 테이블 생성 확인. 같은 영구 볼륨을 사용하는 재시작과 컨테이너 삭제·교체 후에도 환경 ID 유지 및 인증·WebSocket 검사 통과.
- 새 상태 확인 스크립트의 문법·대상 lint·포맷 검사 통과.

이 검증은 서버/API 통합 검사다. 브라우저 화면 조작, 실제 도메인 인증서 발급, AI 제공자 로그인·유료 실행, ARM64 서버, Windows 운영 데이터 이전은 수행하지 않았다. 실제 서버의 접속 주소·도메인은 아직 지정되지 않았다. 빌드와 시험 과정에서 기존 Windows 런타임은 중지하지 않았다.

로컬 증거는 `.t3/server-deployment-build-locked-20261018.log`, `.t3/server-deployment-direct-receipt-20261018.json`, `.t3/server-deployment-proxy-receipt-20261018.json`, `.t3/server-deployment-replacement-receipt-20261018.json`에 있다. 전달용 이미지와 설정은 `.t3/server-deploy-20261018/`에 묶는다.
