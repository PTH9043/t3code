# T3 Code

## 이 포크에서 만든 AI 제어센터

여러 프로젝트에서 AI에게 작업을 요청하고 대화, 진행 상황, 결과를 한곳에서 확인하고 싶어 T3 Code를 포크했습니다. 그전에 AI 지원으로 개발하던 AutoUsage는 목표했던 상주 자율 AI 구현에 실패해 중단했습니다.

저는 필요한 기능과 우선순위, 작업 범위와 확인 기준을 정했습니다. AI가 코드를 구현하고 조사·시험을 지원했으며, 저는 실제 동작과 결과를 확인하고 필요한 수정을 다시 요청했습니다.

기술소개서에는 프로젝트별 작업 요청과 대화, 여러 AI의 작업 분담, 질문에 대한 답변, 파일과 결과 확인 과정을 담았습니다. 기본 T3 기능을 바탕으로 작업했으며, 추가하거나 수정한 범위와 원본 기능은 구분합니다.

### 공개 코드와 영상

- [AI 제어센터 소개 영상](https://youtu.be/d2IS_8vBK0c)
- 이 포크는 [T3 Code 원본](https://github.com/pingdotgg/t3code)을 기반으로 합니다. 원본 라이선스와 저작권 표기는 아래와 [LICENSE](./LICENSE)에 유지했습니다.
- 이 소개문을 추가하기 전 공개 브랜치의 마지막 코드 커밋은 2026년 9월입니다. PPT에 나오는 10월 작업과 일부 시연은 로컬 저장본 기준이므로 이 공개 브랜치에 모두 들어 있다고 보장하지 않습니다.

> 아래의 T3 Code 소개와 설치 안내는 원본 프로젝트의 안내입니다. 원본 패키지 설치가 이 포크에 추가한 기능을 설치한다는 뜻은 아닙니다.

T3 Code is an "agent harness control surface". It enables control of the agents on your machine with a best-in-class mobile app ([iOS](https://apps.apple.com/us/app/t3-code-remote-claude-more/id6787819824), [Android](https://play.google.com/store/apps/details?id=com.t3tools.t3code)), [web app](https://app.t3.codes) and [Electron-based desktop app](https://t3.codes).

Works with your subscriptions on Claude Code, Codex, Cursor, Grok Build, and OpenCode. If they're set up on your computer, T3 Code can control them.

> [!NOTE]
> This repository is a fork of [T3 Code](https://github.com/pingdotgg/t3code) and is being developed into an AI control center.
> The original T3 Code source is copyright T3 Tools Inc. and distributed under the [MIT License](https://github.com/pingdotgg/t3code/blob/main/LICENSE).
> The upstream copyright and license notice is preserved in this repository's [LICENSE](./LICENSE).

## "Wait, what are you selling me?"

Nothing. We built T3 Code because we wanted the best possible development experience with agents. We were inspired by existing solutions like the Codex desktop app, Conductor, Claude Desktop and Cursor Glass, but none met our bar.

We wanted something performant, remote-ready, and truly open. If we ever go the wrong direction, we want you to have everything you need to fork and build the editor that you want.

## Installation

> [!WARNING]
> T3 Code currently supports Codex, Claude, Cursor, Grok Build and OpenCode. Install and authenticate at least one provider before use:
>
> - Codex: install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`
> - Claude: install [Claude Code](https://claude.com/product/claude-code) and run `claude auth login`
> - Cursor: install [Cursor CLI](https://cursor.com/cli) and run `agent login`
> - Grok Build: install [Grok Build CLI](https://x.ai/cli) and run `grok login`
> - OpenCode: install [OpenCode](https://opencode.ai) and run `opencode auth login`

### Try it out (install-free)

The easiest way to test T3 Code is to run the server in your terminal (requires Node.js 22.16+, 23.11+, or 24.10+):

```bash
npx t3@latest
```

This will launch T3 Code's backend on your machine as well as the local web app to control your agents.

Tip: Use `npx t3@latest --help` for the full CLI reference.

### Desktop app

Install the latest version of the desktop app from [GitHub Releases](https://github.com/pingdotgg/t3code/releases), or from your favorite package registry:

#### Windows (`winget`)

```bash
winget install T3Tools.T3Code
```

#### macOS (Homebrew)

```bash
brew install --cask t3-code
```

#### Arch Linux (AUR)

```bash
yay -S t3code-bin
```

## Some notes

We are very very early in this project. Expect bugs.

We are (mostly) not accepting contributions yet. Small fixes may be considered. Big features will not be.

## Documentation

Full docs live in [docs/](./docs). There's no docs site yet.

- [Install and first run](./docs/user/install.md)
- [Permission modes](./docs/user/permission-modes.md)
- [Keyboard shortcuts](./docs/user/keybindings.md)
- [Remote access from a phone or another machine](./docs/user/remote-access.md)
- [Keeping app and server in sync](./docs/user/updating.md)
- [Source control integrations](./docs/user/source-control.md)
- Multiple accounts: [Codex](./docs/user/providers-codex.md) · [Claude](./docs/user/providers-claude.md)
- Linux: [run T3 Code as a background service](./docs/user/background-service.md)

Building from source? Start at [docs/internals/overview.md](./docs/internals/overview.md).

## If you REALLY want to contribute still.... read this first

### Install `vp`

T3 Code uses Vite+ so you'll need to install the global `vp` command-line tool.

#### macOS / Linux

```bash
curl -fsSL https://vite.plus | bash
```

#### Windows

```bash
irm https://vite.plus/ps1 | iex
```

Checkout their getting started guide for more information: https://viteplus.dev/guide/

### Install dependencies

```bash
vp i
```

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before opening an issue or PR.

Need support? Join the [Discord](https://discord.gg/jn4EGJjrvv).
