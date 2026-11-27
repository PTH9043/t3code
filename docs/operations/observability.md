# 관측성

> 메인테이너용 문서입니다. T3 Code를 사용 중이신가요? [docs/user](../user/)를 참고하세요.

T3 Code의 서버 측 관측성 모델은 하나입니다.

- 사람이 읽기 좋은 형식의 로그는 stdout으로 나갑니다
- 완료된 스팬은 로컬 NDJSON 트레이스 파일로 들어갑니다
- 트레이스와 메트릭은 OTLP를 통해 Grafana LGTM 같은 실제 백엔드로 내보낼 수도 있습니다

일반적인 로컬 실행에서는 로컬 트레이스 파일이 영속화된 단일 기준입니다. 이런 실행은 별도의 서버 로그 파일을
쓰지 않지만, SSH로 관리되는 실행은 원격 프로세스의 stdout/stderr도 `~/.t3/ssh-launch/<state>/server.log`에
남깁니다.

## 확인 위치

### 로그

로그는 사람이 보기 위한 것입니다.

- 대상: stdout
- 형식: `Logger.consolePretty()`
- 일반 로컬 영속화: 없음
- SSH 관리 실행의 영속화: `~/.t3/ssh-launch/<state>/server.log`

로그 메시지를 트레이스 파일에 남기고 싶다면 활성 스팬 안에서 `Effect.log...`으로 기록하세요. `Logger.tracerLogger`가 이를 스팬 이벤트로 붙여 줍니다.

### 트레이스

완료된 스팬은 NDJSON 레코드로 `serverTracePath`에 기록됩니다. 기본값은 서버를 시작한 방식에 따라
달라집니다. 프로덕션과 홈을 명시적으로 설정한 경우에는
`<home>/userdata/logs/server.trace.ndjson`을 사용하고(따라서 기본값은 `~/.t3/userdata/...`이며,
`--home-dir /custom/path`를 지정하면 `/custom/path/userdata/...`입니다), 연결된 워크트리에서 실행한
개발 서버는 `<worktree>/.t3/userdata/logs/server.trace.ndjson`을, 연결된 워크트리 밖에서 암묵적으로
실행한 개발 서버는 `~/.t3/dev/logs/server.trace.ndjson`을 사용합니다.

로컬 파일에는 읽을 가치가 있는 스팬만 남깁니다. 성공했고 이벤트가 없으며 50ms 미만으로 끝난 서버 스팬(SQL 한 문장, 프로젝터 한 단계 등)은 기록하지 않습니다. 실패·중단된 스팬, 이벤트가 있는 스팬, 50ms 이상 걸린
스팬, 브라우저에서 온 스팬은 그대로 기록합니다. 기준은 `apps/server/src/observability/traceRetention.ts`의
`ROUTINE_SPAN_MAX_DURATION_MS`입니다. OTLP 내보내기와 서버 자체 감시 지표에는 모든 스팬이 그대로 전달됩니다.
파일은 10MB씩 10개까지 회전하므로, 걸러내지 않으면 30분 남짓한 기록만 남습니다.

두 레코드 유형에 공통으로 있는 주요 필드입니다.

- `type`: `effect-span` 또는 `otlp-span`
- `name`: 스팬 이름
- `traceId`, `spanId`, `parentSpanId`: 상관관계
- `durationMs`: 경과 시간
- `attributes`: 구조화된 컨텍스트
- `events`: 내장 로그와 사용자 지정 이벤트

`effect-span` 레코드에는 `Success`, `Failure`, `Interrupted` 중 하나를 담은 `exit`도 있습니다. `otlp-span`
레코드는 대신 OTLP 리소스, 스코프, 선택적 상태 필드를 담습니다.

`TraceRecord`, `EffectTraceRecord`, `OtlpTraceRecord` Schema는
`packages/shared/src/observability.ts`에 있습니다.

### 메트릭

메트릭은 로컬 파일로 기록되지 않습니다.

- 로컬 영속화: 없음
- 원격 내보내기: 설정한 경우에만 OTLP로
- 현재 정의: `apps/server/src/observability/Metrics.ts`

OTLP를 설정하지 않아도 메트릭은 프로세스 안에 그대로 존재하지만, 확인할 수 있는 로컬 아티팩트는 없습니다.

### 관련 아티팩트

제공자 런타임 스트림을 위한 제공자 이벤트 NDJSON 파일은 여전히 존재합니다. 이 파일은 기본 서버 트레이스 파일과 별개입니다.

## 계측 모드로 서버 실행

유용한 모드는 두 가지입니다.

- 로컬 전용: stdout + 로컬 `server.trace.ndjson`
- 완전한 로컬 관측성: stdout + 로컬 트레이스 파일 + Grafana/Tempo/Prometheus로 OTLP 내보내기

로컬 트레이스 파일은 항상 켜져 있습니다. OTLP 내보내기는 직접 켜야 합니다.

### 선택 1: 로컬 트레이스만 사용

추가 환경 변수는 필요하지 않습니다. 앱을 평소대로 실행하고 `server.trace.ndjson`을 확인하세요.

예시입니다.

```bash
npx t3
```

```bash
node --run dev
```

```bash
node --run dev:desktop
```

### 선택 2: 로컬 LGTM 스택과 함께 실행

#### 1. Grafana LGTM 시작

```bash
docker run --name lgtm \
  -p 3000:3000 \
  -p 4317:4317 \
  -p 4318:4318 \
  --rm -ti \
  grafana/otel-lgtm
```

그다음 `http://localhost:3000`을 엽니다.

Grafana 기본 로그인 정보입니다.

- 사용자 이름: `admin`
- 비밀번호: `admin`

#### 2. OTLP 환경 변수 내보내기

```bash
export T3CODE_OTLP_TRACES_URL=http://localhost:4318/v1/traces
export T3CODE_OTLP_METRICS_URL=http://localhost:4318/v1/metrics
export T3CODE_OTLP_SERVICE_NAME=t3-local
```

선택 사항입니다.

```bash
export T3CODE_TRACE_MIN_LEVEL=Info
export T3CODE_TRACE_TIMING_ENABLED=true
```

#### 3. 같은 셸에서 앱 실행

CLI:

```bash
npx t3
```

모노레포 웹·서버 개발:

```bash
node --run dev
```

모노레포 데스크톱 개발:

```bash
node --run dev:desktop
```

패키징된 데스크톱 앱:

데스크톱 앱과 내장 백엔드가 `T3CODE_OTLP_*`를 물려받도록 같은 셸에서 실제 앱 실행 파일을 실행하세요.

macOS 앱 번들 예시입니다.

```bash
T3CODE_OTLP_TRACES_URL=http://localhost:4318/v1/traces \
T3CODE_OTLP_METRICS_URL=http://localhost:4318/v1/metrics \
T3CODE_OTLP_SERVICE_NAME=t3-desktop \
"/Applications/T3 Code.app/Contents/MacOS/T3 Code"
```

바이너리 직접 실행 예시입니다.

```bash
T3CODE_OTLP_TRACES_URL=http://localhost:4318/v1/traces \
T3CODE_OTLP_METRICS_URL=http://localhost:4318/v1/metrics \
T3CODE_OTLP_SERVICE_NAME=t3-desktop \
./path/to/your/desktop-app-binary
```

셸에서 환경 변수를 설정한 뒤 Finder, Spotlight, 독, 시작 메뉴로 앱을 실행하는 방식에 의존하지 마세요. 이렇게 실행하면 대개 환경 변수가 전달되지 않습니다.

#### 4. 환경 변수를 바꾼 뒤 완전히 재시작

백엔드는 프로세스가 시작될 때 관측성 설정을 읽습니다. OTLP 환경 변수를 바꿨다면 앱을 완전히 종료한 뒤 다시 시작하세요.

## 트레이스와 메트릭으로 서버를 디버깅하는 방법

### 로컬 트레이스 파일부터 확인

원시 스팬 데이터를 확인하는 가장 빠른 방법은 트레이스 파일입니다.

실행 방식에 맞는 경로를 한 번 확인해 두세요. 프로덕션과 홈을 명시적으로 설정한 경우에는 런타임 상태를
기준 디렉터리의 `userdata` 폴더 아래에 저장합니다.

```bash
TRACE_FILE="${T3CODE_HOME:-$HOME/.t3}/userdata/logs/server.trace.ndjson"
```

연결된 워크트리에서 시작한 개발 서버는 기본적으로 해당 워크트리의 로컬 홈을 사용합니다.

```bash
TRACE_FILE="$WORKTREE/.t3/userdata/logs/server.trace.ndjson"
```

연결된 워크트리 밖에서 암묵적으로 실행한 개발 서버만 공용 개발 디렉터리를 사용합니다.

```bash
TRACE_FILE="$HOME/.t3/dev/logs/server.trace.ndjson"
```

선택한 파일을 실시간으로 확인합니다.

```bash
tail -f "$TRACE_FILE"
```

실패한 스팬을 표시합니다.

```bash
jq -c 'select(.type == "effect-span" and .exit._tag != "Success") | {
  name,
  durationMs,
  exit,
  attributes
}' "$TRACE_FILE"
```

느린 스팬을 표시합니다.

```bash
jq -c 'select(.durationMs > 1000) | {
  name,
  durationMs,
  traceId,
  spanId
}' "$TRACE_FILE"
```

내장된 로그 이벤트를 확인합니다.

```bash
jq -c 'select(any(.events[]?; .attributes["effect.logLevel"] != null)) | {
  name,
  durationMs,
  events: [
    .events[]
    | select(.attributes["effect.logLevel"] != null)
    | {
        message: .name,
        level: .attributes["effect.logLevel"]
      }
  ]
}' "$TRACE_FILE"
```

트레이스 하나를 따라갑니다.

```bash
jq -r 'select(.traceId == "TRACE_ID_HERE") | [
  .name,
  .spanId,
  (.parentSpanId // "-"),
  .durationMs
] | @tsv' "$TRACE_FILE"
```

오케스트레이션 명령을 필터링합니다.

```bash
jq -c 'select(.attributes["orchestration.command_type"] != null) | {
  name,
  durationMs,
  commandType: .attributes["orchestration.command_type"],
  aggregateKind: .attributes["orchestration.aggregate_kind"]
}' "$TRACE_FILE"
```

git 활동을 필터링합니다.

```bash
jq -c 'select(.attributes["git.operation"] != null) | {
  name,
  durationMs,
  operation: .attributes["git.operation"],
  cwd: .attributes["git.cwd"],
  hookEvents: [
    .events[]
    | select(.name == "git.hook.started" or .name == "git.hook.finished")
  ]
}' "$TRACE_FILE"
```

### 제대로 된 트레이스 뷰어가 필요할 때는 Tempo 사용

다음과 같은 작업에는 원시 NDJSON보다 Tempo가 낫습니다.

- 여러 트레이스를 가로질러 검색
- 부모·자식 관계를 시각적으로 확인
- 느린 트레이스를 여러 개 비교
- `traceId`로 직접 이어 붙이지 않고 실패한 요청 하나를 파고들기

Grafana에서 권장하는 흐름입니다.

1. `Explore`를 엽니다.
2. `Tempo` 데이터 소스를 선택합니다.
3. 시간 범위를 `Last 15 minutes`처럼 최근 구간으로 설정합니다.
4. 넓게 시작합니다. 아주 좁은 쿼리로 시작하지 마세요.
5. 설정한 서비스 이름의 스팬을 찾은 뒤 스팬 이름이나 속성으로 범위를 좁힙니다.

처음 검색하기 좋은 항목입니다.

- `t3-local`, `t3-dev`, `t3-desktop` 같은 서비스 이름
- `sendTurn` 같은 스팬 이름이나 `GitVcsDriver.statusDetails.status` 같은 Git 작업
- `git.operation` 속성으로 작업을 식별할 수 있는 Git 스팬
- `orchestration.command_type` 같은 속성이 있는 오케스트레이션 스팬

트레이스가 들어오고 있음을 확인했다면 `sendTurn` 같은 이름이나 Git 작업 이름을 겨냥한 더 좁은 TraceQL
쿼리가 유용해집니다.

### 메트릭으로 전반적인 문제 파악

트레이스는 요청 하나를 볼 때 가장 좋습니다. 메트릭은 추세를 볼 때 가장 좋습니다.

지켜보기 좋은 메트릭 계열입니다.

- `t3_rpc_request_duration`
- `t3_orchestration_command_duration`
- `t3_orchestration_command_ack_duration`
- `t3_provider_turn_duration`
- `t3_git_command_duration`

카운터는 처리량과 실패율을 알려 줍니다.

- `t3_rpc_requests_total`
- `t3_orchestration_commands_total`
- `t3_provider_turns_total`
- `t3_git_commands_total`

다음과 같은 질문에는 메트릭을 사용하세요.

- "이건 항상 느린가?"
- "변경 이후에 더 나빠졌나?"
- "어떤 명령 유형이 가장 자주 실패하나?"

다음과 같은 질문에는 트레이스를 사용하세요.

- "이 특정 요청에서 무슨 일이 일어났나?"
- "이 느린 상호작용을 유발한 자식 스팬은 무엇인가?"
- "실패한 흐름 안에서 어떤 로그가 발생했나?"

### 새 ack 메트릭의 의미

`t3_orchestration_command_ack_duration`이 측정하는 구간입니다.

- 시작: 명령 디스패치가 오케스트레이션 엔진에 들어가는 시점
- 끝: 해당 명령에 대해 처음 커밋된 도메인 이벤트를 서버가 발행하는 시점

이는 서버 측 확인 응답 메트릭입니다. 다음은 측정하지 않습니다.

- 브라우저까지의 WebSocket 전송
- 클라이언트 수신
- React 렌더링 시간

나중에 이런 값이 필요하면 클라이언트 측 계측이나 전용 서버 팬아웃 메트릭을 추가하세요.

## 자주 쓰는 작업 흐름

### "이 요청은 왜 실패했나요?"

1. 로컬 NDJSON 파일부터 확인합니다.
2. `exit._tag != "Success"`인 `effect-span` 레코드를 찾습니다.
3. `traceId`로 묶습니다.
4. 형제 스팬과 스팬 이벤트를 확인합니다.
5. 필요하면 Tempo로 옮겨 전체 트레이스 트리를 봅니다.

### "UI가 왜 느리게 느껴지나요?"

1. 트레이스 파일이나 Tempo에서 느린 최상위 스팬을 검색합니다.
2. 자식 스팬에서 sqlite, git, 제공자, 터미널 작업을 확인합니다.
3. 대응하는 소요 시간 메트릭을 보고 느린 현상이 전반적인지 확인합니다.

### "이 명령의 확인 응답이 너무 오래 걸렸나요?"

1. `t3_orchestration_command_ack_duration`을 `commandType`별로 확인합니다.
2. 값이 높으면 해당 오케스트레이션 트레이스를 살펴봅니다.
3. 자식 스팬에서 프로젝션, sqlite, 제공자, git 작업을 확인합니다.

### "git 훅이 지연을 유발하나요?"

1. `git.operation` 스팬을 필터링합니다.
2. `git.hook.started`와 `git.hook.finished` 이벤트를 확인합니다.
3. 훅의 소요 시간을 이를 감싸는 git 스팬의 소요 시간과 비교합니다.

### "로컬에는 스팬이 있는데 Grafana에는 아무것도 없나요?"

보통 다음 중 하나가 원인입니다.

- `T3CODE_OTLP_TRACES_URL`을 설정하지 않았습니다
- 환경 변수를 내보낸 곳과 다른 환경에서 앱을 실행했습니다
- 환경 변수를 바꾼 뒤 앱을 완전히 재시작하지 않았습니다
- Grafana가 잘못된 시간 범위나 서비스 이름을 보고 있습니다

로컬 NDJSON 파일이 갱신되고 있다면 로컬 트레이싱은 동작하는 것입니다. 문제는 거의 항상 OTLP 내보내기 설정이나 프로세스 시작 방식에 있습니다.

## 앞으로 작성할 코드에 트레이싱을 추가할 때의 기준

### 작은 헬퍼보다 경계를 우선

좋은 스팬 경계입니다.

- RPC 메서드
- 오케스트레이션 명령 처리
- 제공자 어댑터 호출
- 외부 프로세스 호출
- 영속화 쓰기
- 큐 전달

작은 헬퍼마다 트레이싱을 붙이지 마세요. 대부분의 헬퍼는 새 스팬을 만들기보다 활성 스팬을 물려받아야 합니다.

### 이미 있는 `Effect.fn(...)` 재사용

이 코드베이스는 이미 `Effect.fn("name")`을 광범위하게 사용합니다. 보통 이것이 첫 번째 트레이싱 경계가 되어야 합니다.

일회성 작업이라면 다음과 같이 씁니다.

```ts
import { Effect } from "effect";

const runThing = Effect.gen(function* () {
  yield* Effect.annotateCurrentSpan({
    "thing.id": "abc123",
    "thing.kind": "example",
  });

  yield* Effect.logInfo("starting thing");
  return yield* doWork();
}).pipe(Effect.withSpan("thing.run"));
```

### 카디널리티가 높은 세부 정보는 스팬에

ID, 경로를 비롯한 상세한 컨텍스트에는 스팬 애너테이션을 사용하세요.

```ts
yield *
  Effect.annotateCurrentSpan({
    "provider.thread_id": input.threadId,
    "provider.request_id": input.requestId,
    "git.cwd": input.cwd,
  });
```

### 메트릭 라벨은 카디널리티를 낮게 유지

좋은 메트릭 라벨입니다.

- 작업 종류
- 메서드 이름
- 제공자 종류
- 애그리게이트 종류
- 결과

나쁜 메트릭 라벨입니다.

- 원시 대화 ID
- 명령 ID
- 파일 경로
- cwd
- 전체 프롬프트
- 정규화된 계열 라벨로 충분한 상황에서의 전체 모델 문자열

상세한 컨텍스트는 메트릭이 아니라 스팬에 넣습니다.

### 로그를 스팬 이벤트로 활용

스팬 안의 로그는 트레이스가 들려주는 이야기의 일부가 됩니다.

```ts
yield * Effect.logInfo("starting provider turn");
yield * Effect.logDebug("waiting for approval response");
```

`Logger.tracerLogger`가 설치되어 있으므로 이 메시지들은 스팬 이벤트로 나타납니다.

### 파이프 가능한 메트릭 API 사용

`withMetrics(...)`는 Effect에 카운터와 타이머를 붙이는 기본 방법입니다.

```ts
import { someCounter, someDuration, withMetrics } from "../observability/Metrics.ts";

const program = doWork().pipe(
  withMetrics({
    counter: someCounter,
    timer: someDuration,
    attributes: {
      operation: "work",
    },
  }),
);
```

## 상세 API 참조

### 런타임 구성

서버 관측성 레이어는 `apps/server/src/observability/Layers/Observability.ts`에서 조립됩니다.

제공하는 것은 다음과 같습니다.

- 보기 좋은 형식의 stdout 로거
- `Logger.tracerLogger`
- 로컬 NDJSON 트레이서
- 선택적 OTLP 트레이스 익스포터
- 선택적 OTLP 메트릭 익스포터
- Effect 트레이스 레벨·타이밍 ref

### 환경 변수

로컬 트레이스 파일입니다.

- `T3CODE_TRACE_FILE`: 트레이스 파일 경로 재정의
- `T3CODE_TRACE_MAX_BYTES`: 파일당 로테이션 크기, 기본값 `10485760`
- `T3CODE_TRACE_MAX_FILES`: 로테이션 파일 개수, 기본값 `10`
- `T3CODE_TRACE_BATCH_WINDOW_MS`: 플러시 윈도, 기본값 `200`
- `T3CODE_TRACE_MIN_LEVEL`: 최소 트레이스 레벨, 기본값 `Info`
- `T3CODE_TRACE_TIMING_ENABLED`: 타이밍 메타데이터 활성화, 기본값 `true`

OTLP 내보내기입니다.

- `T3CODE_OTLP_TRACES_URL`: OTLP 트레이스 엔드포인트
- `T3CODE_OTLP_METRICS_URL`: OTLP 메트릭 엔드포인트
- `T3CODE_OTLP_EXPORT_INTERVAL_MS`: 내보내기 주기, 기본값 `10000`
- `T3CODE_OTLP_SERVICE_NAME`: 서비스 이름, 기본값 `t3-server`

OTLP URL을 설정하지 않아도 로컬 트레이싱은 그대로 동작하며 메트릭은 프로세스 안에만 남습니다.

### 현재 계측 대상

지금 가치가 높은 스팬·메트릭 경계는 다음과 같습니다.

- `effect/rpc`에서 나오는 Effect RPC WebSocket 요청 스팬
- `apps/server/src/observability/RpcInstrumentation.ts`의 RPC 요청 메트릭
- 시작 단계
- 오케스트레이션 명령 처리
- 오케스트레이션 명령 확인 응답 지연
- 제공자 세션·턴 작업
- git 명령 실행과 git 훅 이벤트
- 터미널 세션 수명 주기
- sqlite 쿼리 실행

### 현재 제약

- 스팬 밖의 로그는 트레이스 파일에 남지 않지만, SSH로 관리되는 실행의 stdout/stderr는 여전히 해당 실행기
  로그에 기록됩니다
- 메트릭은 로컬에 스냅샷으로 저장되지 않습니다
- 기존 `serverLogPath`는 호환성을 위해 설정에 남아 있지만, 구조화된 형태로 영속화되는 주된 아티팩트는
  트레이스 파일입니다
