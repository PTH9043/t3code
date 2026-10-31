# T3 Code

## 사용자 입력 우선 — 사용자 직접 지시 (2026-10-31)

- 현재 대화에서 사용자가 직접 입력한 최신 요구사항과 명시적 제한을 최우선으로 적용한다. 기존 폴더 지침, 이전 대화, 자동화 설정, 모델 제안과 충돌하면 사용자의 최신 입력을 따른다.
- 사용자의 입력을 임의로 축소·무시·대체하지 않는다. 실행 가능한 요청은 실제로 실행하고 확인된 결과를 보고한다.
- 시스템·플랫폼 안전 제약과 실제 도구 권한을 거짓으로 우회하지 않으며, 확인할 수 없는 성공을 주장하지 않는다.

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

## 프로그램 교체 후 항상 보이게 실행 — 사용자 공용 영구 지시 (2026-10-22)

- 프로그램을 수정·업그레이드하여 운영 프로그램과 교체한 뒤에는 항상 사용자의 눈에 보이게 실제 데스크톱 앱을 실행한다. 이전 창이 최소화·숨김 상태였거나 검증을 백그라운드로 했다는 이유로 운영 앱을 숨겨 두지 않는다. 같은 실행 승인을 다시 묻지 않는다.
- 운영 창은 Electron `showInactive()` 등 포커스를 가져오지 않는 정상 앱 API로 표시한다. 사용자 입력·마우스·탭·작업 포커스를 바꾸거나 최상위 고정을 하지 않는다. 이 창 표시 허용은 화면·입력 탈취 허용이 아니다.
- 분리 테스트·브라우저·보조 프로그램은 계속 백그라운드 또는 headless로 검증한다. 운영 교체 실행에는 테스트용 숨김 옵션을 이어 붙이지 않으며, 남은 숨김 표시 파일보다 명시적인 비활성 표시 실행이 우선한다.
- 완료 전에 웹·백엔드 상태와 실제 데스크톱 창의 표시 및 렌더링을 확인한다. PID 생성이나 HTTP 응답만으로 눈에 보이게 실행했다고 보고하지 않는다.

## 앱의 권한 선택 유지 · 다른 작업을 이유로 재승인 요구 금지 (2026-10-22)

- 권한과 계획/일반 모드는 사용자가 앱에서 현재 요청에 선택한 값 그대로 적용한다. 다른 기능으로 전환하거나 오케스트라 참가자·추가 작업자가 바뀌었다는 이유로 기본값으로 덮어쓰거나 권한을 임의로 변경하지 않는다.
- 다른 프로그램·기능·작업이 실행 중이거나 이미 실행했다는 이유로 승인된 작업의 실행·적용·통상적인 재시작에 추가 승인을 요구하지 않는다. 요청 범위를 확인하고 필요한 작업을 직접 완료한다.
- 전체 권한에서는 추가 실행 승인 없이 진행한다. 사용자가 선택한 제한 모드와 직접 켠 질문하기·조건확인·계획 모드, 화면·입력 탈취 금지와 PowerShell 금지는 그대로 지킨다.

## 전체 권한 모드 — 추가 실행 승인 없이 완료 (2026-10-22)

- 사용자가 전체 권한을 선택하면 일반 대화·오케스트라·자동 작업 등 기능에 관계없이 요청한 범위의 실행·수정·검증·적용·통상적인 종료와 재시작을 추가 승인 질문 없이 완료한다.
- 같은 작업의 실행 여부나 통상적인 적용 순서를 반복해서 묻지 않는다. 저장소·환경·로그에서 알 수 있는 정보는 직접 확인하고, 통상적인 구현 선택은 합리적으로 결정해 진행한다.
- 사용자가 직접 켠 질문하기·조건확인·계획 모드와 현재 요청의 명시적 제한을 유지한다. 작업에 꼭 필요한 정보가 실제로 없을 때만 해당 정보를 요청하며 독립적으로 가능한 승인 작업은 계속한다.
- 이 지시는 화면·입력 탈취 금지, PowerShell 금지 등 사용자의 명시적 금지를 해제하지 않는다. 전체 권한을 실제 작업 성공과 혼동하지 말고 확인한 결과만 보고한다.

## 화면 탈취 절대 금지 — 사용자 공용 영구 지시 (2026-10-21)

- 모든 프로젝트·RAG·기억·검증 작업에서 사용자의 화면과 입력을 탈취하지 않는다. 사용자 작업 포커스·탭·마우스·키보드 입력을 바꾸거나 주입하지 않는다. 운영 프로그램 교체 후의 비활성 창 표시는 위 지침대로 수행한다.
- 분리 검증은 백그라운드 API/CLI/자동 테스트/headless 브라우저/로그/프로세스·포트·HTTP 검증으로 수행한다. 새 테스트 창을 표시하거나 사용자 작업 창을 조작하지 않는다. 운영 프로그램 교체 후에는 위 지침대로 실제 앱 창을 비활성 상태로 표시한다.
- 화면 활성화나 입력 주입을 요구하는 Computer Use/UI 자동화는 사용하지 않는다. 다른 도구로 같은 화면 탈취를 우회하지 않는다. 화면 검증이 불가능해도 독립적인 승인 작업을 계속하고 검증 한계를 명시한다.
- 이전의 실제 클라이언트·브라우저 검증 지침보다 이 사용자 지시가 우선한다. 공용 RAG와 사용자 필수 지침에 보존하고 검색 적중 여부에만 의존하지 않는다. 실제 확인한 저장·조회·주입 범위만 보고한다.

T3 Code is a minimal GUI for coding agents. A Node WebSocket server wraps provider CLIs (Codex, Claude Code, Cursor, Grok, OpenCode) and serves web, desktop, and mobile clients.

You can think of T3 Code as an open source "bring-your-own-subscription" alternative to apps like Claude Desktop, Codex App, Cursor Glass and Conductor.

## What makes T3 Code special?

We have over 100,000 users who love T3 Code. It's important we maintain the things they love as we continue to iterate on the product. Here's a brief list of the things we can never compromise on.

### 1. Open at the core

T3 Code is truly open. We share our roadmap, we share how we think about things, and of course we share all our code. A large number of our users run forks. We work in the open, and should strive to stay that way.

### 2. Performance without compromise

Lots of apps have gotten bogged down with bad tech decisions and "slop". We have not, and we're proud of the performance of T3 Code. We regularly audit for performance regressions, often caused by sending too much data over websockets, css animations causing gpu spikes, lists being hard to render, and more. Make sure all changes are considerate of performance impact.

### 3. Remote ready

The architecture of T3 Code's websocket layer (npx t3) enables a lot of awesome remote features. These have become core to the product. Whether users are connecting directly over their local network, using Tailscale, or leaning in fully with T3 Connect (our tunnel solution, also in this repo), we need to make sure new features are properly supported.

### 4. Multi-surface

T3 Code has 3 key app surfaces: **web**, **desktop**, and **mobile**.

**Web** is kind of two surfaces, as we have the public facing "app.t3.codes" as well as locally hosting the web app through the `npx t3` command. Both need to be supported by all new features where reasonable.

**Desktop** is the main surface most users install first. It's a full Electron app that bundles the server runner as well. The desktop app can also be used as the host server, allowing remote connections from app.t3.codes or the mobile app.

**Mobile** is a React Native app for both iOS and Android, available on the App Store and Google Play. The mobile app allows for connecting to any T3 Code server to control work remotely.

## A note from Theo

I like ambitious ideas, simple systems, and software that feels obvious. Do not preserve complexity just because it already exists. Do not introduce machinery because it looks architecturally impressive. Understand the real constraint, then fight for the smallest model that makes the correct behavior unsurprising.

Channel both "measure twice, cut once" and "yagni". Fight scope creep. Try to honor the dev's intent in both a minimal and realistic fashion.

The rest of this document is meant to help you navigate the codebase and make changes effectively. Think of these instructions less as "hard rules", more as "good defaults". The developer's preferences should be able to override anything here.

Of note: Most T3 Code contributions will come from T3 Code itself, often controlled remotely. This means you should be careful about accessing data, killing dev servers, and other things that may damage the T3 Code instance that the contributor is using.

## A small glossary

We need to be on the same page with terminology. When communicating, use this language:

- **you** means the agent reading this file and changing T3 Code.
- **we, us, and maintainers** mean Theo, Julius and the people building T3 Code. These are who you are talking to now.
- **user** means the person using T3 Code to direct coding agents.
- **agent** means the coding agent a user runs inside T3 Code. Depending on context, that may also include you.
- **provider** means the agent runtime or harness T3 Code talks to, such as Codex, Claude, Cursor, or OpenCode.
- **client** means the web, desktop, or mobile UI.
- **environment** means one running T3 server and the machine, filesystem, provider credentials, and state it owns.
- **project** means an environment-local workspace record rooted at a directory.
- **thread** means the durable conversation and work history for a project.
- **turn** means one user-to-agent cycle, including follow-up work such as checkpointing.
- **T3 home** means the base data directory. Runtime state normally lives below its userdata directory.

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
- For this user's Windows runtime, call `.t3/honey-upgrade-20261011/runtime.py start --production --mode dev` for web/backend or `--mode dev:desktop` for the full desktop scope; `status --production` checks the recorded runtime. Production startup uses the `\NewAutoUsage-T3-Administrator` scheduled task at Windows administrator integrity. Use CMD/Python/VBS; never invoke the legacy PowerShell entry point. Preserve the existing data home, exact process identity, ordinary ports, and inactive visible window. A script entry point does not override a tool denial.
- A failed tool invocation is evidence about that invocation only. Do not infer that every launch is impossible, identify Auto-review without evidence, repeat the same denied command without new grounds, or silently replace a full launch with a smaller app. Continue permitted diagnosis and independent authorized work; do not circumvent an actual policy denial.
- Use the existing runner and minimal required environment. Record process identity and logs, then verify every requested component. A dry-run or a created PID is not completion; web/backend success does not prove the desktop is running.
- `vp i` installs. Worktrees get this from the t3.json setup script; if module resolution looks broken, it probably did not run.
- `vp run dev` starts server and web. In a worktree, state defaults to that worktree's gitignored `.t3`, which deliberately outranks an ambient `T3CODE_HOME` so you cannot land on shared state by accident. An explicit `--home-dir` still wins.
- Ports derive from the worktree path and are stable across restarts, but read the real ones from the `[dev-runner]` line since occupied ports shift.
- Sharing over the tailnet is three steps: run `vp run dev --share` in the background, wait for the `pairingUrl:` line in its output, paste that full URL (token included) in your reply. Do not wire up `tailscale serve` by hand for this, and do not open the URL yourself.
- The web app requires pairing. Hand over the pairing URL, not the bare origin. A URL without its token is useless to whoever you gave it to. If the token got consumed, mint a fresh one with `node apps/server/src/bin.ts pair` — note it carries standard scopes, while the startup URL carries admin scopes (needed for Settings → Connections management).
- Stop what you started, by the PID you tracked. See rule 1.

## Test data

An empty database is a bad test. Seed your worktree's `.t3` with a copy of real data instead of pointing at live state:

- Copy from `~/.t3/userdata` (the developer's real data, the most realistic test set) or `~/.t3/dev`. Worktree state lives at `<worktree>/.t3/userdata`.
- Snapshot the database with `VACUUM INTO`, which is safe even while a server has the source open and yields one consistent file:

  ```bash
  mkdir -p .t3/userdata
  rm -f .t3/userdata/state.sqlite*  # VACUUM INTO refuses to overwrite
  bun -e "new (require('bun:sqlite').Database)(process.env.HOME + '/.t3/userdata/state.sqlite', { readonly: true }).run(\"VACUUM INTO '.t3/userdata/state.sqlite'\")"
  ```

  A plain `cp` is only safe when no server has the source open, and must bring the `-wal` and `-shm` siblings along. A live file copy is a corrupt copy.

- Bring `secrets` and `settings.json` only if the flow under test needs them.
- Copy in, never symlink. Data flows one way: into your sandbox, never back out.

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

## Pull requests

- Never make a PR unless the developer explicitly asks you to do so.
- Conventional commit titles, plain language: `fix(web): new threads no longer spike CPU`.
- Body: the problem in a sentence or two, then how you fixed it. End with the model and harness that did the work.
- **Rebase onto latest main before opening.** Stale branches conflict and burn a review round.
- UI changes need before/after images. Motion or timing needs a short video.
- One concern per PR. If the description says "also", split it.
- When babysitting: poll checks and comments newer than the last push, verify each bot finding against the source, fix real ones, dismiss false positives with a written reason. Stay quiet when nothing is new. Stop when the bots are green on the latest commit.

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
