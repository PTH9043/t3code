# T3 Code Contributor & Philosophy Guide

이 문서는 루트 [`AGENTS.md`](../../AGENTS.md)의 크기(Codex CLI 32KiB 기본 한도)를 안정적으로 유지하기 위해 분리된 프로젝트 배경, 설계 철학, 기본 용어, 테스트 데이터 시딩, PR 가이드입니다.
프로젝트의 필수 운영 지침과 사용자 영구 지시는 항상 루트 `AGENTS.md`를 최우선으로 따릅니다.

## What makes T3 Code special?

We have over 100,000 users who love T3 Code. It's important we maintain the things they love as we continue to iterate on the product. Here's a brief list of the things we can never compromise on.

### 1. Open at the core

T3 Code is truly open. We share our roadmap, we share how we think about things, and of course we share all our code. A large number of our users run forks. We work in the open, and should strive to stay that way.

### 2. Performance without compromise

Lots of apps have gotten bogged down with bad tech decisions and "slop". We have not, and we're proud of the performance of T3 Code. We regularly audit for performance regressions, often caused by sending too much data over websockets, css animations causing gpu spikes, lists being hard to render, and more. Make sure all changes are considerate of performance impact.

### 3. Remote ready

The architecture of T3 Code's websocket layer (`npx t3`) enables a lot of awesome remote features. These have become core to the product. Whether users are connecting directly over their local network, using Tailscale, or leaning in fully with T3 Connect (our tunnel solution, also in this repo), we need to make sure new features are properly supported.

### 4. Multi-surface

T3 Code has 3 key app surfaces: **web**, **desktop**, and **mobile**.

- **Web** is kind of two surfaces, as we have the public facing `app.t3.codes` as well as locally hosting the web app through the `npx t3` command. Both need to be supported by all new features where reasonable.
- **Desktop** is the main surface most users install first. It's a full Electron app that bundles the server runner as well. The desktop app can also be used as the host server, allowing remote connections from `app.t3.codes` or the mobile app.
- **Mobile** is a React Native app for both iOS and Android, available on the App Store and Google Play. The mobile app allows for connecting to any T3 Code server to control work remotely.

## A note from Theo

I like ambitious ideas, simple systems, and software that feels obvious. Do not preserve complexity just because it already exists. Do not introduce machinery because it looks architecturally impressive. Understand the real constraint, then fight for the smallest model that makes the correct behavior unsurprising.

Channel both "measure twice, cut once" and "yagni". Fight scope creep. Try to honor the dev's intent in both a minimal and realistic fashion.

The rest of these contributor notes are meant to help you navigate the codebase and make changes effectively. Think of these instructions less as "hard rules", more as "good defaults". The developer's preferences should be able to override anything here.

Of note: Most T3 Code contributions will come from T3 Code itself, often controlled remotely. This means you should be careful about accessing data, killing dev servers, and other things that may damage the T3 Code instance that the contributor is using.

## A small glossary

We need to be on the same page with terminology. When communicating, use this language:

- **you** means the agent reading this file and changing T3 Code.
- **we, us, and maintainers** mean Theo, Julius and the people building T3 Code. These are who you are talking to now.
- **user** means the person using T3 Code to direct coding agents.
- **agent** means the coding agent a user runs inside T3 Code. Depending on context, that may also include you.
- **provider** means the agent runtime or harness T3 Code talks to, such as Codex, Claude, Cursor, Gemini(Antigravity), Grok, or OpenCode.
- **client** means the web, desktop, or mobile UI.
- **environment** means one running T3 server and the machine, filesystem, provider credentials, and state it owns.
- **project** means an environment-local workspace record rooted at a directory.
- **thread** means the durable conversation and work history for a project.
- **turn** means one user-to-agent cycle, including follow-up work such as checkpointing.
- **T3 home** means the base data directory. Runtime state normally lives below its userdata directory.

Full glossary with file links: [`docs/internals/glossary.md`](./glossary.md)

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

## Pull requests

- Never make a PR unless the developer explicitly asks you to do so.
- Conventional commit titles, plain language: `fix(web): new threads no longer spike CPU`.
- Body: the problem in a sentence or two, then how you fixed it. End with the model and harness that did the work.
- **Rebase onto latest main before opening.** Stale branches conflict and burn a review round.
- UI changes need before/after images. Motion or timing needs a short video.
- One concern per PR. If the description says "also", split it.
- When babysitting: poll checks and comments newer than the last push, verify each bot finding against the source, fix real ones, dismiss false positives with a written reason. Stay quiet when nothing is new. Stop when the bots are green on the latest commit.

## Fork Boundary & Custom Extension Policy (`t3x/`)

이 저장소는 원본 `upstream` (`pingdotgg/t3code`) 기반 포크(`origin`)로 운영된다. 원본 업데이트 병합 충돌과 거대 파일 비대화를 막기 위해 다음 포크 경계 원칙을 따른다.

1. **신규 커스텀 모듈 격리 (`t3x/`)**:
   - 서버 신규 커스텀 기능·인프라 모듈은 `apps/server/src/t3x/<feature>/` 아래에 배치한다(예: `apps/server/src/t3x/executionLedger/`).
   - 웹 신규 커스텀 기능·패널은 `apps/web/src/t3x/<feature>/` 아래에 배치한다.
   - 공유 계약은 `packages/contracts/src/<feature>.ts` 단일 파일로 추가하고 `packages/contracts/src/index.ts`에서 1줄만 재내보낸다.
2. **원본 핵심 파일 최소 침습(Thin Hook)**:
   - `server.ts`, `ws.ts`, `ClaudeAdapter.ts`, `CodexAdapter.ts`, `ProviderCommandReactor.ts`, `ChatView.tsx`, `ChatComposer.tsx` 등 원본 핵심 파일에는 **생명주기 훅(1~5줄) 또는 라우트 등록 1줄**만 추가하고, 도메인 상태·영속 로직·UI 서브트리는 `t3x/` 또는 분리된 도메인 모듈에 둔다.
3. **9종 협업 공통 실행 원장 의무**:
   - 멀티에이전트·협업·백그라운드 실행 경로는 반드시 `apps/server/src/t3x/executionLedger/UnifiedExecutionLedger.ts`를 통해 `ActiveWorkTracker` 등록/해제, `unified_execution_runs`(SQLite `Migration 108`) 영속화, `t3.execution_kind` 스팬 태깅, 재시작 시 일괄 `interrupted_by_restart` 복구를 적용한다.
4. **포크 변경 커밋 위생**:
   - 대규모 미커밋 작업 트리는 기능 묶음(예: UI 200p, GitHub 10대 저장소, Council, 안정화 Wave 0~4) 단위로 분리 커밋하는 것을 원칙으로 하며, 원본 원격 텔레메트리(PostHog 등)는 기본 비활성화 및 키 공백 상태를 유지한다.
