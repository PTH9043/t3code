# 소스 컨트롤 연동

T3 Code는 Git 호스팅 제공자에 연결되므로 앱을 벗어나지 않고 풀 리퀘스트를 만들고, 코드를 리뷰하고, 저장소를 관리할 수 있습니다.

## 지원 제공자

T3 Code는 팀이 이미 사용하고 있는 플랫폼과 함께 동작합니다.

- **GitHub** – 풀 리퀘스트, 저장소 생성, 클론 연동
- **GitLab** – 머지 리퀘스트, 저장소 게시, 호스팅 저장소 클론
- **Bitbucket** – 풀 리퀘스트 워크플로 (API 토큰 인증 방식)
- **Azure DevOps** – Microsoft 호스팅 저장소의 풀 리퀘스트 지원

## 할 수 있는 일

### 어디서든 프로젝트 시작

**저장소 바로 클론하기**

- 명령 팔레트(`Cmd/Ctrl + K`)를 열고 → **프로젝트 추가**를 선택합니다
- **GitHub 저장소**, **GitLab 저장소**, **Bitbucket 저장소**, **Azure DevOps 저장소** 중에서 선택하거나 아무 **Git URL**이나 붙여 넣습니다
- 저장소 경로(`owner/repo`, `group/project`, `workspace/repository`, `project/repository`)나 전체 Git URL을 입력하고 저장 위치를 고른 뒤 코딩을 시작합니다

**로컬 프로젝트를 클라우드에 게시하기**

- 원격이 없는 로컬 Git 저장소가 있습니까?
- **저장소 게시** 작업을 사용하면 새 호스팅 저장소(GitHub, GitLab, Bitbucket, Azure DevOps)를 만들고, origin 원격으로 추가하고, 푸시하는 과정을 한 번에 처리합니다
- 로컬 저장소에 아직 커밋이 없으면 게시할 때 원격을 만들어 연결하기만 하고 푸시하지는 않습니다. 커밋을 만든 다음 평소처럼 푸시하세요.

### 화면 전환 없이 코드 리뷰 관리

**작업하면서 풀 리퀘스트 만들기**

- 툴바의 Git 작업 컨트롤에서 브랜치를 푸시하고 풀 리퀘스트를 만듭니다
- T3 Code는 커밋을 바탕으로 제목과 설명을 제안할 수 있습니다
- GitHub Pull Requests, GitLab Merge Requests, Bitbucket Pull Requests, Azure DevOps Pull Requests를 지원합니다

**열린 리뷰 놓치지 않기**

- 현재 브랜치에 이미 열린 PR/MR이 있는지 확인합니다
- 클릭 한 번으로 브라우저에서 리뷰를 바로 엽니다
- 동료의 브랜치를 체크아웃해 코드를 로컬에서 리뷰합니다

### 설정 상태 한눈에 확인

**소스 컨트롤 설정** 페이지에는 무엇이 연결되어 있는지 정확히 표시됩니다.

- ✅ 인증을 마치고 사용할 준비가 된 제공자
- ⚠️ 빠진 항목과 해결 방법
- 👤 로그인되어 있는 계정 (확인할 수 있는 경우)

새 컴퓨터를 설정했거나 자격 증명을 변경한 뒤에는 **다시 검사**를 한 번 실행하세요.

## 시작하기

### GitHub의 경우 (대부분의 사용자에게 권장)

1. T3 Code를 실행하는 컴퓨터에 GitHub CLI를 설치합니다.
   ```bash
   brew install gh
   ```
2. 로그인합니다.
   ```bash
   gh auth login
   ```
3. T3 Code에서 **설정 → 소스 컨트롤**을 열고 GitHub이 인증됨으로 표시되는지 확인합니다

이제 클론, 게시, 풀 리퀘스트 생성을 사용할 수 있습니다.

### GitLab의 경우

1. GitLab CLI를 설치합니다.
   ```bash
   brew install glab
   ```
2. 인증합니다.
   ```bash
   glab auth login
   ```
3. **설정 → 소스 컨트롤**에서 연결을 확인합니다

### Bitbucket의 경우

Bitbucket은 CLI 도구 대신 토큰을 사용합니다. 두 가지 방법이 있으며, 둘 다 T3 Code를 실행하는
컴퓨터의 환경 변수로 설정합니다.

권장 방법은 Bitbucket 액세스 토큰입니다.

```bash
export T3CODE_BITBUCKET_ACCESS_TOKEN="your-access-token"
```

또는 풀 리퀘스트와 저장소에 대한 읽기/쓰기 권한이 있는 Atlassian 계정 이메일과 API 토큰을
사용합니다.

```bash
export T3CODE_BITBUCKET_EMAIL="you@example.com"
export T3CODE_BITBUCKET_API_TOKEN="your-token"
```

둘 다 설정되어 있으면 액세스 토큰이 우선합니다. T3 Code를 다시 시작하고 **소스 컨트롤
설정**에서 연결을 확인하세요.

### Azure DevOps의 경우

1. Azure CLI를 설치합니다.
   ```bash
   brew install azure-cli
   ```
2. DevOps 확장을 추가합니다.
   ```bash
   az extension add --name azure-devops
   ```
3. 로그인합니다.
   ```bash
   az login
   ```

---

## 요구 사항과 문제 해결

**Git이 필요합니다** – T3 Code는 모든 로컬 작업에 Git을 사용합니다. 서버에 `git`이 설치되어 있는지 확인하세요.

**서버 쪽 설정** – 인증은 로컬 브라우저가 아니라 T3 Code를 실행하는 컴퓨터(서버)에서 이루어집니다. 호스팅 인스턴스나 팀 인스턴스를 사용하고 있다면 관리자가 이미 제공자를 설정해 두었을 수 있습니다.

**자주 발생하는 문제:**

- **제공자가 "인증되지 않음"으로 표시됨** – 서버의 터미널에서 해당 제공자의 로그인 명령(예: `gh auth login`)을 실행한 뒤 설정에서 다시 검사하세요
- **Bitbucket이 연결되지 않음** – 환경 변수가 올바른 셸 프로필에 설정되어 있는지, 서버를 다시 시작했는지 다시 확인하세요
- **원격에 푸시할 수 없음** – Git 원격 URL이 인증한 제공자와 일치하는지 확인하세요 (SSH 원격과 HTTPS 원격은 서로 다른 자격 증명이 필요할 수 있습니다)

**도움이 더 필요합니까?** 사용 중인 제공자의 CLI 문서를 확인하세요.

- [GitHub CLI](https://cli.github.com/)
- [GitLab CLI](https://gitlab.com/gitlab-org/cli)
- [Azure CLI](https://learn.microsoft.com/en-us/cli/azure/)
