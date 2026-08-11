# T3 Code 설치

T3 Code는 사용자 컴퓨터에서 코딩 에이전트를 실행하는 웹·데스크톱 GUI입니다.

## 요구 사항

T3 Code 서버를 실행하는 컴퓨터에 Node.js `^22.16 || ^23.11 || >=24.10`이 필요합니다.

설치와 인증을 마친 제공자 CLI가 최소 하나 필요합니다. 아래 [제공자](#제공자)를 참고하세요.

## 설치 없이 실행

```bash
npx t3@latest
```

이 명령은 사용자 컴퓨터에서 T3 Code 서버를 시작하고 로컬 웹 앱을 엽니다. 전체 CLI 참고 문서는
`npx t3@latest --help`로 확인하세요.

## 데스크톱 앱

[GitHub Releases](https://github.com/pingdotgg/t3code/releases)에서 최신 릴리스를 내려받거나,
패키지 레지스트리에서 설치하세요.

Windows:

```bash
winget install T3Tools.T3Code
```

macOS:

```bash
brew install --cask t3-code
```

Arch Linux:

```bash
yay -S t3code-bin
```

## 제공자

T3 Code는 제공자 CLI를 구동할 뿐 함께 배포하지는 않습니다. 사용할 제공자마다 CLI를 설치한 다음
인증하세요.

| 제공자     | CLI                                                   | 기본 바이너리  | 로그인 명령           |
| ---------- | ----------------------------------------------------- | -------------- | --------------------- |
| Codex      | [Codex CLI](https://developers.openai.com/codex/cli)  | `codex`        | `codex login`         |
| Claude     | [Claude Code](https://claude.com/product/claude-code) | `claude`       | `claude auth login`   |
| Cursor     | [Cursor CLI](https://cursor.com/cli)                  | `cursor-agent` | `agent login`         |
| Grok Build | [Grok Build CLI](https://x.ai/cli)                    | `grok`         | `grok login`          |
| OpenCode   | [OpenCode](https://opencode.ai)                       | `opencode`     | `opencode auth login` |

Cursor는 특히 주의해야 하는데, T3 Code가 찾는 `cursor-agent` 바이너리를 제공하는 Cursor CLI를
설치하되 인증은 `cursor-agent login`이 아니라 `agent login`으로 해야 합니다.

로그인 명령은 브라우저로 접속하는 기기가 아니라 T3 Code 서버를 실행하는 컴퓨터에서 실행하세요.

### 바이너리 탐색

각 제공자 CLI는 서버의 `PATH`에 있거나, **설정** → 해당 제공자 인스턴스 → **바이너리 경로**에
경로가 명시되어 있어야 합니다. 버전 관리자나 비표준 설치 위치 때문에 T3 Code를 시작한 셸의
`PATH`에서 CLI를 찾을 수 없다면 경로를 직접 지정하세요.

### 인증이 필요한 시점

제공자 인증은 T3 Code를 시작하기 전이 아니라 해당 제공자로 세션을 시작하기 전에 필요합니다.
T3 Code를 설치하고 실행한 다음 제공자를 추가해도 됩니다. 인증되지 않은 제공자는 **설정**에
상태가 표시되며, 실행할 로그인 명령과 함께 세션 시작 단계에서 실패합니다.

여러 계정을 사용하는 설정은 [Codex](./providers-codex.md)와 [Claude](./providers-claude.md)를
참고하세요.

## 다음 단계

- [권한 모드](./permission-modes.md): T3 Code가 작업 전에 얼마나 확인하는지
- [원격 접속](./remote-access.md): 휴대폰, 태블릿 또는 다른 데스크톱에서 접속하기
- [T3 Code 버전 맞추기](./updating.md): 클라이언트와 서버의 버전 차이
- [T3 Code 백그라운드 실행](./background-service.md): 리눅스 백그라운드 서비스
