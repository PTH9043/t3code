# T3 Code

## 사용자 입력 우선 — 사용자 직접 지시 (2026-10-31)

- 현재 대화에서 사용자가 직접 입력한 최신 요구사항과 명시적 제한을 최우선으로 적용한다. 기존 폴더 지침, 이전 대화, 자동화 설정, 모델 제안과 충돌하면 사용자의 최신 입력을 따른다.
- 사용자의 입력을 임의로 축소·무시·대체하지 않는다. 실행 가능한 요청은 실제로 실행하고 확인된 결과를 보고한다.
- 시스템·플랫폼 안전 제약과 실제 도구 권한을 거짓으로 우회하지 않으며, 확인할 수 없는 성공을 주장하지 않는다.

## Gemini CLI는 Antigravity CLI로 대체 · AGENTS.md는 모든 AI에 적용 — 사용자 직접 지시 (2026-11-15, 2026-11-16 변경)

- 2026-11-16 사용자 지시: 기존 Gemini CLI 연결을 Antigravity CLI(`agy acp`)로 대체하고, 무료 계정으로 연결을 시험하며, 사용량이 보이게 한다. 2026-11-15의 Gemini 사용 금지는 Antigravity CLI에 한해 풀렸다. 기존 `gemini` CLI는 계속 쓰지 않는다.
- 앱은 `apps/server/src/provider/Drivers/GeminiDriver.ts`의 `GEMINI_SUSPENDED`로 이 연결을 비활성화해 두고 있다. Antigravity 연결을 실제 실행으로 확인한 변경을 넣을 때 이 값을 `false`로 바꾼다. 그 전에는 버전 확인과 모델 탐색을 하지 않는다.
- Antigravity CLI 설치와 Google 로그인은 사용자가 직접 한다. 로그인하지 않은 상태에서 ACP `authenticate` 요청을 보내면 브라우저가 열릴 수 있으므로, 상태 확인·모델 탐색에서는 보내지 않는다(화면 탈취 금지).
- 이 AGENTS.md는 이 프로젝트에서 일하는 모든 AI(Codex, Claude, OpenCode, Cursor, Grok과 그 하위 에이전트)에 적용한다. AGENTS.md를 스스로 읽지 않는 Claude에는 앱이 세션을 시작할 때 내용을 전달하고(`apps/server/src/provider/projectAgentInstructions.ts`), Claude Code CLI는 `CLAUDE.local.md`의 `@AGENTS.md`로 읽는다.

## 작업 방식: 문서 확인 · 계획 · 검증 · 보고 — 사용자 직접 지시 (2026-11-15)

사용자가 제공한 코딩 에이전트 운영 프롬프트를 이 프로젝트에 맞게 옮긴 것이다. 이 문서의 다른 사용자 지시와 충돌하는 부분은 그 지시가 우선하며, 옮기지 않은 항목은 끝에 적었다.

- 세션 시작: 이 파일 → `progress.txt`(현재 상태) → `LESSONS.md`(반복하지 말 실수) → 작업과 관련된 문서(`docs/README.md` 색인에서 찾는다) 순서로 읽고 시작한다.
- 계획: 3단계 이상이거나 구조를 정하는 작업은 코드를 쓰기 전에 `PLAN:` 아래 "단계 — 이유"를 적는다. 사용자가 계획 모드나 질문하기를 켠 경우에만 승인을 기다리고, 그 밖에는 계획을 보인 뒤 바로 실행한다. 진행이 어긋나면 밀어붙이지 말고 멈춰 다시 계획한다.
- 가정: 문서·코드·로그로 확인할 수 없는 것을 추측으로 채우지 않는다. 통상적인 구현 선택은 직접 정하되 `가정:` 목록으로 드러내고, 요구사항·범위가 갈리거나 되돌리기 어려운 결정은 묻는다. 문서끼리 또는 문서와 코드가 충돌하면 어느 파일의 무엇이 충돌하는지 짚어 알린다.
- 범위: 요청받은 것만 고친다. 인접 코드 정리·리팩터링을 덤으로 하지 않고, 이해하지 못한 주석을 지우지 않는다. 변경 뒤 쓰이지 않게 된 코드는 목록으로 알리고 승인 없이 지우지 않는다.
- 회귀 방지: 기존 파일을 고치기 전에 현재 내용과 바꿀 내용을 대조한다. 동작하는 기능을 깨면서 새 기능을 넣지 않는다. 변경이 둘 이상의 시스템에 걸치면 각각 확인한다.
- 구현: 명백하고 단순한 방법으로 먼저 맞게 만들고 확인한 뒤, 필요할 때만 다듬는다. 저장소의 기존 패턴·이름·구조를 따른다. 100줄이면 될 것을 1000줄로 만들지 않는다. 단순하지 않은 로직은 성공 기준이 되는 테스트를 먼저 쓴다.
- 화면: 색·간격·모서리·그림자 값을 새로 지어내지 않고 기존 토큰과 컴포넌트를 쓴다. 참고 이미지에서는 요청받은 요소만 가져온다.
- 오류: 같은 방법을 말없이 되풀이하지 않는다. 두 번 실패하면 무엇을 시도했고 왜 실패했다고 보는지 알린다.
- 검증: 동작을 테스트·로그로 확인하기 전에는 완료라고 하지 않는다. 방법과 한계는 아래 "Verifying"을 따른다.
- 보고: 작업 뒤 "변경한 것(파일: 무엇을 왜)", "건드리지 않은 것", "우려 사항"을 적는다. "느려질 수 있다"가 아니라 수치로 쓴다.
- 반론: 요청에 분명한 문제가 있으면 구체적인 단점과 대안을 말한다. 사용자가 그대로 하라고 하면 따르고 위험만 남긴다.
- 기록: 사용자가 바로잡아 준 일이 있으면 그 패턴과 방지 규칙을 `LESSONS.md`에 더한다. 세션을 마칠 때 `progress.txt`를 완료 / 진행 중 / 막힘 / 다음으로 갱신한다.
- 위임: 주 대화의 문맥을 아껴야 하는 조사·탐색은 하위 에이전트에 한 가지씩 맡긴다. `workspace_helper` 도구가 있고 사용 가능(`available`)하면 공개 정보 정리·요약·번역·초안 같은 잡일은 그 하위 API에 맡기고, 돌아온 결과는 확인한 뒤 쓴다. `projectContentAllowed`가 아니면 프로젝트 코드·파일 내용·비밀값·개인정보를 보내지 않는다.
- 옮기지 않은 항목: 코드 작성 전 매번 계획 승인 받기("전체 권한 모드"·"임시파일 정리…" 지시와 충돌), 문서를 덮어쓰지 않고 날짜별 새 판 만들기("기존 문서 원본을 직접 수정"과 충돌), 문서에 없으면 만들지 않기와 `PRD.md`·`APP_FLOW.md`·`TECH_STACK.md`·`DESIGN_SYSTEM.md`·`FRONTEND_GUIDELINES.md`·`BACKEND_STRUCTURE.md`·`IMPLEMENTATION_PLAN.md` 전제(이 저장소에 없는 문서), 모든 컴포넌트 모바일 우선(데스크톱·웹·모바일을 함께 다루는 "Hit every surface"가 기준).

## 임시파일 정리와 기존 문서 직접 수정 — 사용자 공용 영구 지시 (2026-10-29)

- 모든 AI는 작업·조사·변환·검증에 필요한 임시파일과 임시 폴더를 만들 수 있다. 작업을 마칠 때 이번 작업에서 만든 임시파일·임시 폴더·임시 사본을 확인하여 반드시 제거하고 남기지 않는다.
- 사용자가 기존 문서의 수정을 요청하면 새 문서나 별도 수정본을 만들지 말고 기존 문서 원본을 직접 수정한다. 사용자가 새 문서 작성을 명시적으로 요청한 경우는 그 요청을 따른다.
- 사용자의 명령을 거부하거나 승인된 작업을 반복 확인하지 말고, 직접 실행·검증·완료한다. 실제 제약이 있으면 확인된 사실만 설명하고 가능한 작업은 계속한다.
- 프로그램의 AI는 후보 발견이나 상태 보고만 하고 멈추어 사용자가 같은 명령을 다시 하게 만들지 않는다. 승인된 범위에서 다음 조사·재현·오류 수정·검증·실행을 스스로 이어 간다. 실제로 필요한 승인·정보나 도구 제약이 있으면 확인된 사실을 알리고 독립적으로 가능한 작업은 계속하며, 진행·제출·완료 사실을 꾸며내지 않는다.
- 도구나 스킬이 요구하는 임시파일도 작업 후 반드시 정리한다. 기존 사용자 파일은 임의로 삭제하지 않으며, 기존 문서는 원본을 직접 수정한다.

## 권한을 임의로 낮추지 않는다 — 사용자 직접 지시 (2026-10-28)

- 사용자가 현재 작업에 전체 권한을 요청했다. 에이전트나 앱이 권한을 낮춘 사실이 확인되면 현재 작업의 권한을 전체 권한으로 복구하고, T3 운영 앱은 Windows 관리자 권한(High)을 유지한다.
- 에이전트는 사용자 허락 없이 권한을 임의로 낮추지 않는다. 사용자가 직접 선택한 다른 작업의 제한과 질문하기·조건확인·계획 모드는 임의로 변경하지 않는다.
- Windows 관리자 권한과 앱의 전체 권한은 별도로 실제 상태를 확인한다. 파일에 지침을 적은 것과 이미 열린 세션이나 실행 중인 프로세스의 설정이 즉시 바뀌는 것은 구분한다.

## T3 운영 앱은 항상 Windows 관리자 권한으로 자동 실행 (2026-10-22)

- T3 운영 프로그램은 항상 Windows 관리자 권한(High)으로 실행하며, 컴퓨터를 켠 뒤 사용자가 Windows에 로그인하면 실제 앱 창이 보이게 자동 실행한다. 일반 권한으로 낮추던 이전 운영 실행 지침보다 이 사용자 요청이 우선한다.
- 등록된 `\NewAutoUsage-T3-Administrator` 로그인 예약 작업과 기존 운영 실행기 `D:/__NewAutoUsage/.t3/honey-upgrade-20261011/runtime.py`를 사용한다. 예약 작업은 현재 사용자의 대화형 세션에서 가장 높은 권한으로 실행한다. 운영 데이터 `E:/NewAutoUsage`와 web/backend/desktop 범위를 유지한다.
- PowerShell을 직접·간접 실행하지 않는다. 공용 Node/Electron 실행 파일 전체에 관리자 호환성 옵션을 걸거나 Windows UAC·자동 로그인 설정을 바꾸지 않는다.
- 관리자 실행은 앱에서 선택한 전체/제한 권한, 질문하기·조건확인·계획 모드를 임의로 바꾸는 허가가 아니다. 창은 `showInactive()`로 표시하고 사용자 포커스·입력을 탈취하지 않는다. PID뿐 아니라 실제 데스크톱 토큰·창 표시·서버 상태를 확인한다.

## 운영 T3 재시작 시점 · 개발과 운영 분리 — 사용자 직접 지시 (2026-11-22)

- 다른 채팅방의 턴, 하위 모델 위임(`workspace_delegate`), 오케스트라·자동 작업이 실행 중일 때는 운영 T3 서버·데스크톱을 재시작하지 않는다. 전체 권한 모드나 "교체 후 항상 보이게 실행" 지시도 진행 중인 다른 작업을 끊고 재시작하는 근거가 아니다.
- 개발·수정·검증은 운영 프로세스를 건드리지 않고 먼저 끝낸다. 단위·통합 테스트, 타입 검사, 번들 빌드, 격리된 worktree·테스트 데이터 홈 실행으로 변경이 맞게 돌아가는지 확인한 뒤에야 운영 반영 단계로 넘어간다.
- 운영 T3에 반영할 때는 재시작 직전에 `python .t3\honey-upgrade-20261011\runtime.py active-work --production`으로 실행 중인 턴·위임·오케스트라를 먼저 확인한다(현재 방 외에 진행 중인 작업이 0건이어야 함).
  - 진행 중인 다른 작업이 있으면 그 작업이 끝날 때까지 기다렸다가(`--wait-idle <초>`) 재시작하거나, 즉시 재시작하지 않고 변경·검증 완료 상태만 `progress.txt`에 남긴 뒤 보고한다("소스 반영 · 운영 미반영").
  - 사용자가 "지금 진행 중인 작업이 끊겨도 바로 재시작해라"라고 명시한 경우에만 중단 후 재시작하고, 끊긴 작업 목록을 남긴다.
- 같은 작업 묶음 안에서는 수정·테스트·빌드를 모두 마친 뒤 운영 재시작을 마지막에 한 번만 한다. 파일 하나 고칠 때마다 운영을 여러 번 껐다 켜지 않는다.
- 운영 DB(`E:/NewAutoUsage/userdata/state.sqlite`)와 실행 중인 운영 프로세스에는 개발 중 직접 쓰거나 신호를 보내지 않는다(읽기 전용 조회와 백업 복사만 허용).
- **운영 DB 직접 변경(아카이브·`VACUUM`·마이그레이션 시험)은 서버 정지 상태에서만 허용 (2026-11-27 추가)**: `scripts/archive-event-logs.mjs --apply/--vacuum` 등 운영 `state.sqlite`를 변경하는 외부 작업은 반드시 운영 T3 서버가 완전히 정지된 상태에서만 실행한다(라이브 서버 가동 중 실행 시 스크립트가 fail-closed로 거부한다). 라이브 상태에서의 이벤트 아카이브는 서버 내부 유휴 소분 스케줄러(`EventLogArchiver`)만 사용한다.

## 프로그램 교체 후 항상 보이게 실행 — 사용자 공용 영구 지시 (2026-10-22)

- 프로그램을 수정·업그레이드하여 운영 프로그램과 교체한 뒤에는 항상 사용자의 눈에 보이게 실제 데스크톱 앱을 실행한다(단, 교체·재시작 시점은 위 "운영 T3 재시작 시점 · 개발과 운영 분리 (2026-11-22)"를 먼저 따른다). 이전 창이 최소화·숨김 상태였거나 검증을 백그라운드로 했다는 이유로 운영 앱을 숨겨 두지 않는다. 같은 실행 승인을 다시 묻지 않는다.
- 운영 창은 Electron `showInactive()` 등 포커스를 가져오지 않는 정상 앱 API로 표시한다. 사용자 입력·마우스·탭·작업 포커스를 바꾸거나 최상위 고정을 하지 않는다. 이 창 표시 허용은 화면·입력 탈취 허용이 아니다.
- 분리 테스트·브라우저·보조 프로그램은 계속 백그라운드 또는 headless로 검증한다. 운영 교체 실행에는 테스트용 숨김 옵션을 이어 붙이지 않으며, 남은 숨김 표시 파일보다 명시적인 비활성 표시 실행이 우선한다.
- 완료 전에 웹·백엔드 상태와 실제 데스크톱 창의 표시 및 렌더링을 확인한다. PID 생성이나 HTTP 응답만으로 눈에 보이게 실행했다고 보고하지 않는다.

## 앱의 권한 선택 유지 · 다른 작업을 이유로 재승인 요구 금지 (2026-10-22)

- 권한과 계획/일반 모드는 사용자가 앱에서 현재 요청에 선택한 값 그대로 적용한다. 다른 기능으로 전환하거나 오케스트라 참가자·추가 작업자가 바뀌었다는 이유로 기본값으로 덮어쓰거나 권한을 임의로 변경하지 않는다.
- 다른 프로그램·기능·작업이 실행 중이거나 이미 실행했다는 이유로 승인된 작업의 실행·적용·통상적인 재시작에 추가 승인을 요구하지 않는다. 요청 범위를 확인하고 필요한 작업을 직접 완료한다(단, 운영 T3 재시작 전 활성 작업 0건 확인은 위 "운영 T3 재시작 시점 · 개발과 운영 분리 (2026-11-22)"를 따른다).
- 전체 권한에서는 추가 실행 승인 없이 진행한다. 사용자가 선택한 제한 모드와 직접 켠 질문하기·조건확인·계획 모드, 화면·입력 탈취 금지와 PowerShell 금지는 그대로 지킨다.

## 전체 권한 모드 — 추가 실행 승인 없이 완료 (2026-10-22)

- 사용자가 전체 권한을 선택하면 일반 대화·오케스트라·자동 작업 등 기능에 관계없이 요청한 범위의 실행·수정·검증·적용·통상적인 종료와 재시작을 추가 승인 질문 없이 완료한다(단, 운영 T3 재시작은 위 "운영 T3 재시작 시점 · 개발과 운영 분리 (2026-11-22)"에 따라 다른 방 활성 작업이 없을 때 수행한다).
- 같은 작업의 실행 여부나 통상적인 적용 순서를 반복해서 묻지 않는다. 저장소·환경·로그에서 알 수 있는 정보는 직접 확인하고, 통상적인 구현 선택은 합리적으로 결정해 진행한다.
- 사용자가 직접 켠 질문하기·조건확인·계획 모드와 현재 요청의 명시적 제한을 유지한다. 작업에 꼭 필요한 정보가 실제로 없을 때만 해당 정보를 요청하며 독립적으로 가능한 승인 작업은 계속한다.
- 이 지시는 화면·입력 탈취 금지, PowerShell 금지 등 사용자의 명시적 금지를 해제하지 않는다. 전체 권한을 실제 작업 성공과 혼동하지 말고 확인한 결과만 보고한다.

## 화면 탈취 절대 금지 — 사용자 공용 영구 지시 (2026-10-21)

- 모든 프로젝트·RAG·기억·검증 작업에서 사용자의 화면과 입력을 탈취하지 않는다. 사용자 작업 포커스·탭·마우스·키보드 입력을 바꾸거나 주입하지 않는다. 운영 프로그램 교체 후의 비활성 창 표시는 위 지침대로 수행한다.
- **사용자 명시적 프로그램 실행 허용 (2026-11-21 추가)**: 사용자가 명시적으로 프로그램·앱 실행이나 화면 표시를 요청한 경우(개발한 프로그램 실행, 도구 띄우기 등)에는 T3에 연결된 모든 AI 모델(Gemini/Antigravity·Claude·Codex·OpenCode 등)이 화면 탈취 금지나 샌드박스 격리(`exebox`)를 이유로 거절하지 말고 T3 호스트 MCP 도구 `workspace_launch_app`으로 사용자의 실제 데스크톱(`WinSta0\Default`)에 해당 프로그램을 정상적으로 실행해 화면에 띄울 수 있다. 다만 자동 분리 테스트·백그라운드 검증에서는 계속 백그라운드/headless를 유지하고, 강제 마우스·키보드 입력 주입이나 불필요한 최상위 고정은 계속 금지한다.
- 분리 검증은 백그라운드 API/CLI/자동 테스트/headless 브라우저/로그/프로세스·포트·HTTP 검증으로 수행한다. 새 테스트 창을 표시하거나 사용자 작업 창을 조작하지 않는다. 운영 프로그램 교체 후에는 위 지침대로 실제 앱 창을 비활성 상태로 표시한다.
- 화면 활성화나 입력 주입을 요구하는 Computer Use/UI 자동화는 사용하지 않는다. 다른 도구로 같은 화면 탈취를 우회하지 않는다. 화면 검증이 불가능해도 독립적인 승인 작업을 계속하고 검증 한계를 명시한다.
- 이전의 실제 클라이언트·브라우저 검증 지침보다 이 사용자 지시가 우선한다. 공용 RAG와 사용자 필수 지침에 보존하고 검색 적중 여부에만 의존하지 않는다. 실제 확인한 저장·조회·주입 범위만 보고한다.

T3 Code is a minimal GUI for coding agents. A Node WebSocket server wraps provider CLIs (Codex, Claude Code, Gemini/Antigravity, Cursor, Grok, OpenCode) and serves web, desktop, and mobile clients.

- **3-Agent SSOT**: `AGENTS.md` is the single source of truth (`CLAUDE.md`, `CLAUDE.local.md`, `GEMINI.md` import `@AGENTS.md`). Shared skills live in `.agents/skills/` (`.claude/skills` and `.gemini/skills` are directory junctions). Read-only specialist agents live in `.codex/agents/`, `.claude/agents/`, and `.gemini/agents/`.
- **Background, philosophy, glossary, test data seeding, and PR conventions**: see `docs/internals/contributor-guide.md` (moved out to keep `AGENTS.md` safely below Codex CLI's 32 KiB `project_doc_max_bytes` ceiling).

## The three ways to hurt yourself

1. **Killing by pattern.** Never `pkill -f`, `pgrep | kill`, or `kill` a PID you found by matching a name, path, or worktree string. Your own agent process has this worktree's path in its argv, and this machine runs several other dev servers at once. Kill only a PID you captured at spawn, or the owner of your port from `ss -H -ltnp` after confirming `/proc/<pid>/cwd` is your worktree.
2. **Writing to the live install.** `~/.t3/userdata` is the developer's real T3 Code database, in use while you work. Reading it and copying from it are fine, and a good way to get real test data (see Test data). Never start a server against it, never open it read-write, never clean it up.
3. **Baking in origins.** Never set `VITE_HTTP_URL` or `VITE_WS_URL` for dev. Dev is single-origin and Vite proxies `/api`, `/ws`, `/oauth`, and `/.well-known`. Setting them bakes localhost into the bundle and silently breaks every remote browser.

## Hit every surface

The most common defect in this repo is a change that works on the path you tested and is missing everywhere else. Before calling frontend work done, walk this list and say which entries applied:

- **Entry points.** A behavior reachable from the chat view is usually also reachable from Settings, the command palette, and a keybinding. Fixing one is not fixing the feature.
- **Clients.** Web, desktop (wraps web, adds Electron shell/IPC), and mobile (React Native, separate navigation). Shared logic lives in `packages/client-runtime`
- **Providers.** Codex, Claude, Cursor, Grok, and OpenCode each have an adapter. Provider-shaped features need a decision per adapter, even if the decision is "not supported here".
- **Contracts.** Anything crossing the wire is typed in `packages/contracts`. Change the schema and the server, web, mobile, and desktop all follow.
- **Reverse states.** If you added a way in, add the way out and the way to see it. Snooze needs unsnooze. Close needs reopen. A one-way door is a bug.
- **Connection modes.** Local, remote/relay, and tunnel behave differently. Multi-device and multi-environment cases are real.
- **Docs.** `docs/` splits by audience. Behavior changes that a user would notice belong in `docs/user/` (shipped-product voice, no repo tooling or source paths); architecture and contributor changes in `docs/internals/`; runbooks in `docs/operations/`; new vocabulary in `docs/internals/glossary.md`.

## Dev servers

- For this user's Windows start/restart requests, read `docs/operations/windows-runtime-start.md` and preserve the requested web/backend/desktop scope. An existing explicit restart request authorizes the ordinary stop/start sequence; do not ask for the same permission again.
- For this user's Windows runtime, call `.t3/honey-upgrade-20261011/runtime.py active-work --production` first to verify zero active turns/delegations/orchestra runs in other threads, then `start --production --mode dev` (or `--mode dev:desktop` / `--wait-idle 60`) for production replacement; `status --production` checks the recorded runtime. Production startup uses the `\NewAutoUsage-T3-Administrator` scheduled task at Windows administrator integrity. Use CMD/Python/VBS; never invoke the legacy PowerShell entry point. Preserve the existing data home, exact process identity, ordinary ports, and inactive visible window. A script entry point does not override a tool denial.
- A failed tool invocation is evidence about that invocation only. Do not infer that every launch is impossible, identify Auto-review without evidence, repeat the same denied command without new grounds, or silently replace a full launch with a smaller app. Continue permitted diagnosis and independent authorized work; do not circumvent an actual policy denial.
- Use the existing runner and minimal required environment. Record process identity and logs, then verify every requested component. A dry-run or a created PID is not completion; web/backend success does not prove the desktop is running.
- `vp i` installs. Worktrees get this from the t3.json setup script; if module resolution looks broken, it probably did not run.
- `vp run dev` starts server and web. In a worktree, state defaults to that worktree's gitignored `.t3`, which deliberately outranks an ambient `T3CODE_HOME` so you cannot land on shared state by accident. An explicit `--home-dir` still wins.
- Ports derive from the worktree path and are stable across restarts, but read the real ones from the `[dev-runner]` line since occupied ports shift.
- Sharing over the tailnet is three steps: run `vp run dev --share` in the background, wait for the `pairingUrl:` line in its output, paste that full URL (token included) in your reply. Do not wire up `tailscale serve` by hand for this, and do not open the URL yourself.
- The web app requires pairing. Hand over the pairing URL, not the bare origin. A URL without its token is useless to whoever you gave it to. If the token got consumed, mint a fresh one with `node apps/server/src/bin.ts pair` — note it carries standard scopes, while the startup URL carries admin scopes (needed for Settings → Connections management).
- Stop what you started, by the PID you tracked. See rule 1.

## Test data & Pull requests

- Seed worktree test databases via read-only `VACUUM INTO` copy (never symlink or open `~/.t3/userdata` read-write). Never open a PR unless explicitly asked. Full instructions: `docs/internals/contributor-guide.md`.

## Verifying

### 프로젝트에 추가한 선택 도구 (2026-10-22)

- 보안 검토에는 `.agents/skills/security-audit/SKILL.md`의 증거·독립 검증 지침을 사용한다. 스킬 설치만으로 전체 감사를 완료했다고 보고하거나 일반 작업에 전체 감사를 자동으로 부과하지 않는다. 앱에서 사용자가 선택한 권한·질문하기·조건확인·계획 모드를 유지한다.
- Bun 1.4.4 도구는 `node scripts/bun-tools.mjs`로 호출한다. `fmt-check <파일...>`, `fmt <파일...>`, `check <프로젝트>`처럼 범위를 명시한다. Bun 타입 검사는 기존 Effect `tsgo`·lint·테스트를 대체하지 않는다. 운영 앱은 기존 Node/Electron 실행기를 사용한다.
- 설치·검증 범위와 원본 출처는 `docs/operations/security-audit-and-bun.md`에 기록했다.

### 기본 검증

- Smallest proof that the change works. `vp test run <files>` for the tests you touched, targeted lint and typecheck for the scope you changed.
- **Do not run repo-wide checks.** No `vp check`, no `vp run -r test`, no `vp run -r typecheck` unless I ask. CI owns the full suite.
- Backend behavior changes ship with focused tests for that behavior.
- The server is event-sourced and its async flows emit typed receipts. Wait on receipts and worker drains, never on sleeps or polling. A test that needs a timeout to pass is wrong.
- Upon request, user-visible frontend changes should get one integrated pass in a real client: `test-t3-app` for web, `test-t3-mobile` for mobile. The primary agent does this once after integrating. Subagents do not launch their own dev servers. Ask permission before doing computer use or spinning up browsers.

## How it works

Clients send typed WebSocket requests. The server turns them into _commands_, a pure _decider_ turns commands into persisted _events_, and a _projector_ derives the read model the UI renders. Provider CLIs run as subprocesses; per-provider _adapters_ translate their native protocols into orchestration events. Side effects run in queue-backed _reactors_ that emit _receipts_ when milestones land. Each turn ends with a _checkpoint_, a hidden git ref, so the app can diff and restore.

Full glossary with file links: `docs/internals/glossary.md`

## Where code lives

- `apps/server` - WebSocket, orchestration, providers, checkpointing. Effect-heavy: read `.repos/effect-smol/LLMS.md` before writing Effect code.
- `apps/web` - React/Vite UI. `apps/desktop` wraps it, `apps/mobile` is React Native, `apps/marketing` is the site.
- `packages/contracts` - Effect/Schema contracts plus small derived helpers. No heavy runtime logic.
- `packages/shared` - shared runtime utils, subpath exports, no barrel.
- `packages/client-runtime` - client code shared by web and mobile.
- `.repos/` - vendored read-only references. Prefer their patterns over invented ones. Never edit or import from them. Sync with `vpr sync:repos` when bumping the matching dependency.

## Taste

- Complexity belongs at the adapter boundary. Orchestration stays pure, UI stays dumb.
- Inferred types over annotations. `any` is the enemy.
- Comments describe how a thing is used, and move when the code moves. To be used mostly to describe functions, not to annotate every line of behavior.
- Our users drive agents all day and notice a dropped frame, a lying spinner, and a stale label. No continuously repainting animations; they peg the GPU on high-refresh displays.
- If a rule here fights the task in front of you, say so loudly and get a human sign-off before breaking it.

## Additional tips

- Don't verify with browsers or computer use unless the user explicitly agrees or requests it.
- Security is important, but should not be over-indexed on, especially for dev mode/maintainer-only features.
- **무손실 메모리 (`[PIN_EXACT]` & 3계층 검색)**: 절대 잊으면 안 되는 파일 경로·수치·제약은 `[PIN_EXACT]`로 표시해 원문 그대로 L0 핀 저장하며, 시크릿/토큰은 자동 마스킹한다. 시맨틱 임베딩 검색은 400ms 하드캡 후 FTS5/BM25로 즉시 폴백한다.
- **하위 모델 위임 (`workspace_delegate`)**: 2개 이상 독립 작업은 `start_parallel` 또는 `run_parallel`(호출당 140초 대기)로 병렬 실행하고, `wait(delegationIds)` 부분 결과와 대화(Thread) 단위 수명을 활용한다. 동일 작업 중복 스폰은 자동 합류(`deduplicated: true`)되며 5분 무활동 시 `stalled` 경고, 15분 무활동 시 자동 중단된다.
- **운영 재시작 보호 (`--wait-drain`)**: `runtime.py start --production`은 `active-work.json`을 확인해 활성 턴·위임 진행 중에는 재시작을 차단한다(`--wait-drain 60`으로 완료 대기, 긴급 시에만 `--force`). 개발/검증은 항상 별도 worktree/격리 데이터에서 수행한다.
