# Claude

이 문서는 T3 Code에서 Claude 설정을 두 개 이상 사용하려는 분들을 위한 안내입니다. Codex는
[Codex](./providers-codex.md)를 참고하세요. 처음 설치하는 경우에는 [T3 Code 설치](./install.md)를 참고하세요.

흔한 이유는 다음과 같습니다.

- 업무용과 개인용 Claude 계정을 분리해서 사용
- 주로 쓰는 설정을 건드리지 않고 다른 Claude Code 구성을 시험
- Claude Code Router 같은 라우터를 통해 Claude를 실행
- Claude 호환 워크플로로 제공되는 외부 제공자를 사용

## Claude 계정을 하나만 사용합니다

기본 제공자를 사용하세요.

평소처럼 Claude Code로 로그인합니다.

```bash
claude auth login
```

T3 Code **설정**에서 Claude 제공자를 다음 상태로 두어도 됩니다.

```text
Display name: Claude
Binary path: claude
CLAUDE_CONFIG_DIR path: empty
```

`CLAUDE_CONFIG_DIR path`가 비어 있으면 T3 Code는 Claude Code의 기본 설정 디렉터리를 사용합니다.

이 항목을 지정하면 T3 Code는 `CLAUDE_CONFIG_DIR` 환경 변수로 Claude Code가 해당 디렉터리를 바라보도록
지정합니다. `HOME`은 바꾸지 않으므로 시스템 키체인과 나머지 환경은 그대로 유지됩니다.

## 업무용과 개인용 Claude 계정을 함께 사용하고 싶습니다

계정마다 서로 다른 Claude 설정 디렉터리를 사용하세요.

예시:

```text
default config dir           work account
~/.claude_personal_home      personal account
```

### 첫 번째 계정 설정

평소처럼 로그인합니다.

```bash
claude auth login
```

T3 Code **설정**에서 다음과 같이 지정합니다.

```text
Display name: Claude Work
Binary path: claude
CLAUDE_CONFIG_DIR path: empty
```

### 두 번째 계정 설정

별도의 설정 디렉터리로 로그인합니다.

```bash
mkdir -p ~/.claude_personal_home
CLAUDE_CONFIG_DIR=~/.claude_personal_home claude auth login
```

`HOME`이 아니라 `CLAUDE_CONFIG_DIR`를 사용하세요. `HOME`을 지정하면 로그인 정보가
`~/.claude_personal_home/.claude`에 기록되는데, 이 경로는 T3 Code가 찾는 위치가 아닙니다.

그다음 T3 Code에 Claude 제공자를 하나 더 추가합니다.

```text
Display name: Claude Personal
Binary path: claude
CLAUDE_CONFIG_DIR path: ~/.claude_personal_home
```

각 제공자가 의도한 계정을 사용하는지는 **설정**에 표시되는 이메일로 확인하세요. 이메일은 기본적으로
흐리게 처리되며, 흐린 이메일을 클릭하면 내용이 드러납니다.

## 기존 대화에서 Claude 계정을 바꿀 수 있습니까?

대부분의 경우 바꿀 수 없습니다.

T3 Code는 기존 대화에 대해 같은 설정 디렉터리를 사용하는 Claude 제공자만 제시합니다. 설정 디렉터리가
다르면 다른 Claude 환경으로 취급합니다.

이는 권장하는 Codex 설정과 다릅니다. Claude Code는 계정과 로컬 상태를 설정 디렉터리 아래 여러 파일에
나누어 보관하므로, T3 Code는 상태 일부를 공유하려 하지 않고 서로 다른 설정 디렉터리를 격리된 상태로 유지합니다.

## OpenRouter를 사용하고 싶습니다

로컬 라우터를 실행하지 않고 Claude Code가 OpenRouter와 직접 통신하게 하려면 이 방법을 사용하세요.
외부 제공자 설정 중 가장 간단한 방법입니다.

OpenRouter는 Claude의 Anthropic 호환 환경 변수를 통해 Claude Code 연동을 제공합니다.

### Claude OpenRouter 제공자 설정

T3 Code **설정**에서 Claude 제공자를 추가하거나 수정합니다.

```text
Display name: Claude OpenRouter
Binary path: claude
CLAUDE_CONFIG_DIR path: ~/.claude_openrouter_home
```

해당 제공자의 **환경 변수** 섹션에 다음을 추가합니다.

```text
ANTHROPIC_BASE_URL   https://openrouter.ai/api
ANTHROPIC_AUTH_TOKEN sk-or-...                Sensitive
ANTHROPIC_API_KEY                              Empty value
```

`ANTHROPIC_AUTH_TOKEN`은 민감 정보로 표시하세요. T3 Code는 이 값을 서버 시크릿으로 저장하며 저장한
뒤에는 앱으로 다시 보내지 않습니다.

이 설정을 평소 사용하는 Claude 계정과 분리하려면 해당 Claude 홈을 먼저 만드세요.

```bash
mkdir -p ~/.claude_openrouter_home
```

같은 Claude 홈을 일반 Anthropic 로그인으로 사용한 적이 있다면, OpenRouter를 사용하기 전에 해당 홈의 Claude
Code 세션에서 `/logout`을 실행하세요. 그렇지 않으면 Claude Code가 OpenRouter 토큰 대신 캐시된 Anthropic
자격 증명을 계속 사용할 수 있습니다.

### OpenRouter 모델 선택

OpenRouter는 Claude Code의 기본 모델 역할을 OpenRouter 모델 ID로 연결할 수 있습니다.

예시:

```text
ANTHROPIC_DEFAULT_OPUS_MODEL    anthropic/claude-opus-4.6
ANTHROPIC_DEFAULT_SONNET_MODEL  anthropic/claude-sonnet-4.6
ANTHROPIC_DEFAULT_HAIKU_MODEL   anthropic/claude-haiku-4.5
CLAUDE_CODE_SUBAGENT_MODEL      anthropic/claude-sonnet-4.6
```

모델 선택을 고정하려면 같은 제공자의 **환경 변수** 섹션에 위 항목을 추가하세요.

### OpenRouter 사용 확인

Claude 세션을 열고 다음을 실행합니다.

```text
/status
```

Anthropic 기본 URL이 다음으로 설정되어 있어야 합니다.

```text
https://openrouter.ai/api
```

OpenRouter 활동 대시보드에서 자신의 API 키로 들어온 요청을 확인할 수도 있습니다.

### 자주 발생하는 OpenRouter 실수

- Claude Code에서는 `https://openrouter.ai/api/v1`이 아니라 `https://openrouter.ai/api`를 사용합니다.
- `ANTHROPIC_AUTH_TOKEN`에는 OpenRouter API 키를 지정합니다.
- Claude Code가 Anthropic 로그인을 사용하려 하지 않도록 `ANTHROPIC_API_KEY`는 빈 문자열로 지정합니다.
- 이 변수들은 전역 셸 시작 파일이 아니라 Claude 제공자 인스턴스에 지정합니다.

OpenRouter의 설정 방식은 시간이 지나면서 바뀔 수 있습니다. 최신 내용은 OpenRouter의 원본 Claude Code 안내를 참고하세요:
<https://openrouter.ai/docs/guides/guides/claude-code-integration>.

## Claude Code Router를 사용하고 싶습니다

Claude Code Router는 OpenRouter를 직접 연결하는 방식보다 더 세밀하게 제어할 수 있는 로컬 라우팅 계층이
필요할 때 유용합니다.

T3 Code에는 Claude Code Router 전용 제공자가 필요하지 않습니다. 라우터를 하나의 Claude 환경으로
다루세요. Claude 제공자에 고유한 `CLAUDE_CONFIG_DIR path`를 지정하고, 라우터가 내보내라고 안내하는 변수를
해당 제공자의 **환경 변수** 섹션에 넣습니다. 토큰과 API 키는 민감 정보로 표시하세요.

```text
Display name: Claude Router
Binary path: claude
CLAUDE_CONFIG_DIR path: ~/.claude_router_home
```

라우터 자체의 설치·시작·설정 절차는 원본 프로젝트의 README를 따르세요:
<https://github.com/musistudio/claude-code-router>.

## 계정이 아니라 Claude 설정만 다르게 쓰고 싶습니다

이름을 붙인 프리셋이 필요하면 같은 계정으로 Claude 제공자를 하나 더 만드세요.

예시:

- "Claude Default"
- "Claude Router"
- "Claude Experimental"

프리셋에 다른 Claude 파일이 필요하면 `CLAUDE_CONFIG_DIR path`를 다르게 지정하세요. 다른 API 키, 기본 URL,
라우터 설정이 필요하면 **환경 변수**를 사용하세요.

환경 변수 지정은 `Launch arguments`에 넣지 마세요.
