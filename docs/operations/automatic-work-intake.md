# 자동 업무 접수 도구

업무 양식은 프로젝트 운영 → 자동 작업 성과 → 자동 업무 접수함에서 먼저 저장한다. 아래 명령은 CMD에서 저장소 루트를 작업 디렉터리로 사용한다. 실행 중인 환경의 기존 데이터 홈을 `--home`으로 지정한다. 이 PC의 운영 홈은 `E:/NewAutoUsage`이며, 후보 검증은 해당 후보의 격리 홈을 사용한다.

```cmd
node scripts/workspace-task-inbox.mjs list --home E:/NewAutoUsage --project PROJECT_ID
node scripts/workspace-task-inbox.mjs submit --home E:/NewAutoUsage --file task.json
node scripts/workspace-task-inbox.mjs github-issue --home E:/NewAutoUsage --project PROJECT_ID --recipe RECIPE_ID --url https://github.com/OWNER/REPO/issues/123
```

GitHub 명령은 ‘이슈 수정 후보’ 양식의 `issueUrl`, `problem` 입력을 사용한다. 해당 입력을 가진 양식 ID를 선택한다. 이벤트 ID에는 저장소·이슈 번호·수정 시각을 넣으므로 같은 이슈 버전의 중복 수신은 기존 작업으로 연결된다. 본문을 임의로 잘라 지시를 잃지 않도록 4,000자를 넘는 자료는 거부한다. 긴 자료는 범위를 정한 JSON 입력과 원본 URL로 접수한다.

공개 이슈는 인증 없이 읽을 수 있다. 필요한 경우 호출 프로세스의 `GITHUB_TOKEN` 또는 `GH_TOKEN`을 사용하며 토큰을 접수 본문이나 표준 출력에 넣지 않는다. GitHub에는 GET 요청만 보낸다. [GitHub 이슈 조회 API](https://docs.github.com/en/rest/issues/issues#get-an-issue)

JSON 파일의 예시는 다음과 같다. `recipeRevision`을 생략하면 처음 접수할 때의 최신 활성 버전을 고정한다.

```json
{
  "projectId": "PROJECT_ID",
  "recipeId": "RECIPE_ID",
  "source": "external-monitor",
  "externalId": "event-2026-10-15-001",
  "inputs": { "topic": "지정한 저장소의 변경 조사" }
}
```

외부 감시기나 webhook 어댑터가 이 파일을 생성해 도구를 호출할 수 있다. 원격 연결은 기존 인증 WebSocket의 `workspaceTaskInbox.submit` RPC와 `AuthOrchestrationOperateScope`를 사용한다. 조회·상세는 읽기 권한, 양식 저장·접수·상태 변경은 실행 권한이 필요하다. 이 기능이 공개 webhook 서버를 별도로 열지는 않는다.

## GitHub 변경 확인 예제

`scripts/workspace-task-check-github.mjs`는 입력의 `repository` 값(`OWNER/REPO`)으로 최근 커밋을 읽고 fingerprint와 원문 링크를 출력하는 읽기 전용 확인 명령이다. 별도 상태 파일에 기준 버전을 앞당겨 저장하지 않는다. 서버가 정상 완료한 fingerprint를 기준으로 다음 실행을 판정한다.

업무 양식에 `repository` 입력과 조사 지시·산출물을 지정한다. ‘확인 명령이 변경을 보고할 때 실행’을 선택하고 이 예제 스크립트의 실제 절대 경로를 지정한다. 스크립트가 프로젝트 안에 있으면 상대 경로를 사용할 수 있다.

```cmd
node "D:/__NewAutoUsage/scripts/workspace-task-check-github.mjs"
```

스크립트는 최신 커밋을 알리는 예제다. 새 커밋 사이의 전체 변경 분석은 전달된 이전 완료 커밋과 현재 커밋을 비교하도록 업무 지시에 넣는다. 명령의 입력은 `T3_TASK_INPUTS_JSON`, 이전 정상 완료 버전은 `T3_TASK_PREVIOUS_FINGERPRINT`, 실행 식별자는 `T3_TASK_ID`·`T3_TASK_ATTEMPT` 환경 변수로 받는다.

실행기는 사전 확인 20초, 본 작업·각 검증 명령 120초, 출력 스트림별 32KB로 제한한다. 명령 출력 기록은 끝부분 최대 4,000자를 보여 주며 SHA-256을 함께 저장한다. 산출물 검사는 프로젝트 밖으로 벗어나는 경로·연결을 거부하고 일반 파일 8MB 이하를 확인한다.
