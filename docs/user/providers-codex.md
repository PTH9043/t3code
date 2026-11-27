# Codex

이 문서는 T3 Code에서 Codex 계정을 두 개 이상 사용하려는 분을 위한 안내입니다. Claude는
[Claude](./providers-claude.md)를 참고하세요. 처음 설치하는 경우에는 [T3 Code 설치](./install.md)를 참고하세요.

흔한 이유는 다음과 같습니다.

- 업무 프로젝트에는 업무 계정 사용
- 개인 프로젝트에는 개인 계정 사용
- 한 계정이 사용 한도에 도달하면 다른 계정으로 전환
- 별도의 Codex 구성을 두 벌 유지하는 대신 공유된 Codex 기록 하나를 유지

## Codex 계정을 하나만 사용하는 경우

기본 제공자를 사용하세요.

**설정**에서 Codex 제공자는 다음 상태로 두어도 됩니다.

```text
Display name: Codex
CODEX_HOME path: ~/.codex
Shadow home path: empty
```

평소처럼 Codex에 로그인합니다.

```bash
codex login
```

## 업무용과 개인용 Codex 계정을 함께 쓰는 경우

실제 Codex 홈 하나와 섀도 홈 하나를 사용합니다.

권장 구성은 다음과 같습니다.

```text
~/.codex      shared Codex home
~/.codex_p    second account auth
```

의도는 다음과 같습니다.

- 두 계정이 같은 T3/Codex 세션을 볼 수 있습니다
- 각 계정이 자체 로그인을 유지합니다
- 기존 대화를 어느 계정으로든 이어서 진행할 수 있습니다

### 첫 번째 계정 설정

평소처럼 로그인합니다.

```bash
codex login
```

`~/.codex`가 사용하는 계정입니다.

T3 Code **설정**에서 알아보기 쉬운 이름을 지정하세요.

```text
Display name: Codex Work
CODEX_HOME path: ~/.codex
Shadow home path: empty
```

### 두 번째 계정 설정

별도의 Codex 홈으로 로그인합니다.

```bash
mkdir -p ~/.codex_p
CODEX_HOME=~/.codex_p codex login
```

T3 Code **설정**에서 Codex 제공자를 하나 더 추가하세요.

```text
Display name: Codex Personal
CODEX_HOME path: ~/.codex
Shadow home path: ~/.codex_p
```

중요한 점은 두 제공자가 같은 `CODEX_HOME path`를 사용하되, 두 번째 제공자에만
`Shadow home path`가 설정된다는 것입니다.

## 지금 어느 계정을 사용 중입니까?

**설정**을 열고 제공자 행을 확인하세요.

T3 Code는 이메일을 보고하는 제공자에 대해 인증된 이메일을 표시합니다. 이메일은 기본적으로 흐리게 처리되며,
흐린 이메일을 클릭하면 내용이 드러납니다.

모델 선택기에서 계정을 쉽게 구분할 수 있도록 표시 이름과 강조 색상을 활용하세요.

## OpenAI API 키로 대화하기

설정의 제공자 목록에서 **계정 추가 → OpenAI API 계정 연결**을 엽니다. 계정 이름, 사용할 API 모델 ID, API 키를 입력합니다. 모델을 여러 개 등록할 때는 쉼표로 구분합니다. 키는 서버에 비밀값으로 저장되며, 계정을 편집할 때 키 입력란을 비워 두면 기존 키를 유지합니다.

대화방의 모델 선택기에서 등록한 계정과 모델을 선택하면 다음 요청에 적용됩니다. 이 계정으로 보낸 요청에는 OpenAI API 요금이 적용됩니다. 기존 Codex 로그인과 모델 선택은 별도로 관리할 수 있습니다.

## 다른 API 키나 엔드포인트가 필요한 경우

**설정**에서 해당 제공자의 **환경 변수** 섹션을 사용하세요.

Codex 호환 구성에 계정별 변수가 필요할 때 유용합니다. 변수를 받아야 하는 제공자 인스턴스에 변수를 추가하고,
API 키나 토큰은 민감 정보로 표시하세요. 민감한 값은 서버 시크릿으로 저장되며 저장한 뒤에는 앱으로 다시
전송되지 않습니다.

## 기존 대화에서 계정을 전환할 수 있습니까?

두 Codex 제공자가 같은 `CODEX_HOME path`를 공유한다면 가능합니다.

예를 들면 다음과 같습니다.

```text
Codex Work      CODEX_HOME path: ~/.codex
Codex Personal  CODEX_HOME path: ~/.codex, Shadow home path: ~/.codex_p
```

이 두 제공자는 대화를 이어가기에 호환되는 것으로 간주되므로, 잠긴 모델 선택기에 둘 다 표시될 수 있습니다.

완전히 다른 `CODEX_HOME path`를 사용하는 세 번째 Codex 제공자를 추가하면 T3 Code는 이를 다른 프로젝트로
취급합니다. 이 제공자는 `~/.codex` 아래에서 만들어진 기존 대화에는 제공되지 않습니다.

## 두 계정이 똑같아 보이는 경우

두 Codex 제공자가 같은 계정을 표시하거나 예상과 다른 동일한 모델 목록을 보여준다면 다음을 확인하세요.

1. **설정**에서 이메일을 확인합니다.
2. 제공자 상태를 새로 고칩니다.
3. 두 번째 제공자에 `Shadow home path`가 설정되어 있는지 확인합니다.
4. 섀도 디렉터리에 자체 `auth.json`이 있는지 확인합니다.
5. `~/.codex`를 섀도 디렉터리로 복사했다면 `auth.json`을 제외한 나머지를 모두 삭제합니다.

정리 예시는 다음과 같습니다.

```bash
find ~/.codex_p -mindepth 1 ! -name auth.json -exec rm -rf {} +
```

## 별도의 CODEX_HOME을 사용해야 할 때

완전히 분리된 `CODEX_HOME path`는 Codex 프로젝트를 따로 두고 싶을 때만 사용하세요.

이 경우 세션이 분리되고 기존 대화 안에서 계정을 전환하는 일이 줄어듭니다. 계정을 두 개 쓰는 대부분의
사용자는 공유 홈과 섀도 홈을 함께 쓰는 구성을 사용하는 편이 좋습니다.
