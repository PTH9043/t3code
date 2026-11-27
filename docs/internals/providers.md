# 제공자 아키텍처

> 메인테이너용 문서입니다. T3 Code를 사용 중이신가요? [docs/user](../user/)를 참고하세요.

제공자는 실제 작업을 수행하는 에이전트 런타임입니다. T3 Code는 여러 제공자를 지원하며,
오케스트레이션 계층은 대화 뒤에 어떤 제공자가 있는지 알지 못합니다.

## 내장 드라이버

[`builtInDrivers.ts`][drivers]는 항목 여섯 개를 담은 `BUILT_IN_DRIVERS`를 내보냅니다.

| 드라이버 종류 | 드라이버 소스                           |
| ------------- | --------------------------------------- |
| `codex`       | [`Drivers/CodexDriver.ts`][codex]       |
| `claudeAgent` | [`Drivers/ClaudeDriver.ts`][claude]     |
| `cursor`      | [`Drivers/CursorDriver.ts`][cursor]     |
| `gemini`      | [`Drivers/GeminiDriver.ts`][gemini]     |
| `grok`        | [`Drivers/GrokDriver.ts`][grok]         |
| `opencode`    | [`Drivers/OpenCodeDriver.ts`][opencode] |

각 드라이버는 자신의 `driverKind`, `configSchema`, 그리고 자식 스코프에서 어댑터를 만드는
`create` 함수를 선언합니다. 어댑터 구현은 그 옆의
`apps/server/src/provider/Layers/`(`CodexAdapter.ts`, `ClaudeAdapter.ts` 등)에 있으며
[`ProviderAdapter.ts`][adapter]를 따릅니다. 특정 에이전트의 전송 방식, 설정, 이벤트 형태가 어떻게
대응되는지 보려면 드라이버와 그 어댑터를 함께 읽으세요.

Antigravity(`gemini` 드라이버)는 [`AntigravityLaunch.ts`](../../apps/server/src/provider/Drivers/AntigravityLaunch.ts)로
`agy acp --gemini-dir <geminiDir> --app-data-dir antigravity-cli --process-per-session` 실행 인자를 구성하며(`full-access` 세션에 한해 `--dangerously-skip-permissions` 추가),
Google OAuth 로그인은 [`GeminiAuth.ts`][geminiauth]가 `agy acp --login`의 브라우저 루프백 콜백 및 원격 코드 제출
흐름을 모두 처리합니다. 각 인스턴스는 격리된 `--gemini-dir` 아래에 동기화된 `config/skills.json` 및 `config/plugins.json`
매니페스트를 유지해 글로벌·플러그인·프로젝트 스킬을 공유합니다.
[`GeminiMcpToolRecovery.ts`](../../apps/server/src/provider/acp/GeminiMcpToolRecovery.ts)와
[`GeminiAdapter.ts`](../../apps/server/src/provider/Layers/GeminiAdapter.ts)는 Antigravity 세션 도구 선언 한도를
보호하기 위해 `t3-code`를 MCP 목록 1순위로 고정하고 기본 환경에서 내장 기능 중복 서버(`t3-filesystem`, `t3-thinking`)를
제외하며, 세션 중 `t3-code` 도구 누락(`is not enabled for server t3-code` / `unknown tool`)과 오탐 보안 거절이
감지되면 `t3-code` 단독 구성으로 `session/load` 무중단 자동 재연결(턴당 최대 1회)을 수행합니다. 또한 에이전트가
`_meta.antigravity.systemPrompt.append`를 광고할 때 [`t3CoreToolInstructions.ts`](../../apps/server/src/provider/t3CoreToolInstructions.ts)의
협업 브라우저·도구 오류 규약을 네이티브 시스템 채널로 전달합니다.

### 사용자에게 묻는 질문

에이전트가 선택지를 갖춘 질문을 던지면 `user-input.requested` 런타임 이벤트가 되고, 클라이언트는
제공자와 무관하게 같은 카드를 그립니다. 답은 `thread.user-input.respond` 명령으로 돌아갑니다.
제공자마다 이 이벤트를 만드는 출처가 다릅니다. Claude는 `AskUserQuestion` 도구 호출을 권한
콜백에서 가로채고, Codex는 app-server가 보내는 `item/tool/requestUserInput` 요청을 받습니다.

Codex의 `request_user_input` 도구는 Plan 모드에서만 열려 있어서, Default 모드에서 호출하면
`request_user_input is unavailable in Default mode`가 돌아오고 모델은 평범한 문장으로 질문하게
됩니다. Default 모드에서도 같은 카드가 뜨도록 [`codexLaunchArgs.ts`][codexargs]가 app-server를
`-c features.default_mode_request_user_input=true`로 띄웁니다. `--enable`이 아니라 `-c`인 이유는
그 파일의 주석에 적어 두었습니다.

## 레지스트리와 라우팅

레지스트리 두 개가 설정과 실행 중인 프로세스를 분리합니다.

- [`ProviderInstanceRegistry`][instances]는 설정된 인스턴스를 `ProviderInstanceId`로 키를 잡습니다.
  인스턴스를 만들 때는 `driverKind`로 드라이버를 찾고, 그 드라이버의 스키마로 `entry.config`를
  디코딩하고, 자식 스코프를 연 뒤 `driver.create`를 호출합니다.
- [`ProviderAdapterRegistry`][registry]는 `getByInstance`로 인스턴스 ID를 실행 중인 어댑터로
  해석합니다.

그 위에 [`ProviderService`][service]가 놓입니다. 어댑터 레지스트리와 제공자 세션 디렉터리를 결합해
대화의 세션·턴 작업을 라우팅하므로, 호출자는 에이전트가 아니라 대화를 지정합니다.

드라이버를 추가한다는 것은 드라이버와 어댑터를 작성해 `BUILT_IN_DRIVERS`에 넣는다는 뜻입니다.
일반적인 경우에는 오케스트레이션, 컨트랙트, 클라이언트를 변경할 필요가 없습니다.

## 제공자 작업을 요청하는 방식

클라이언트는 제공자를 직접 호출하지 않습니다. 클라이언트는 RPC 메서드
`orchestration.dispatchCommand`로 오케스트레이션 명령을 디스패치하며, 이 메서드는 나머지
오케스트레이션 인터페이스와 함께 [`orchestration.ts`][contracts]에 정의되어 있습니다. 클라이언트가
디스패치할 수 있는
제공자 관련 명령은 `thread.turn.start`, `thread.turn.interrupt`, `thread.approval.respond`,
`thread.user-input.respond`, `thread.checkpoint.revert`, `thread.session.stop`과 모드 설정 명령인
`thread.runtime-mode.set`, `thread.interaction-mode.set`입니다.

엔진은 명령에 대한 이벤트를 저장하고, 서버 쪽 reactor(후속 작업을 처리하는 워커)가 제공자 호출을
수행합니다. 제공자 출력은 `thread.message.assistant.delta`, `thread.session.set` 같은 내부 명령으로
돌아오며, 클라이언트는 `orchestration.subscribeThread`로 이를 관찰합니다. 명령/이벤트 루프는
[overview.md](./overview.md)를 참고하세요.

## 서버 쪽 워커

제공자 작업은 큐 기반 워커 세 개를 거칩니다. 세 워커 모두 [`DrainableWorker.ts`][worker]의
`makeDrainableWorker`로 만들어지며, 결정적인 테스트 동기화를 위해 `drain`을 노출합니다.

1. [`ProviderRuntimeIngestion`][ingest]은 제공자 런타임 스트림을 소비해 오케스트레이션 명령을
   내보냅니다.
2. [`ProviderCommandReactor`][cmd]는 오케스트레이션 의도 이벤트에 반응해 제공자 호출을
   디스패치합니다.
3. [`CheckpointReactor`][checkpoint]는 턴 시작과 완료 시점에 프로젝트 체크포인트를 캡처하고
   되돌리기를 수행합니다.

### 버퍼링된 어시스턴트 전달

어시스턴트 전달 모드가 `buffered`인 대화는 델타를 하나씩 스트리밍하지 않고 어시스턴트 텍스트를
누적합니다. 버퍼를 턴이 끝날 때까지 들고 있지는 않습니다. [`ProviderRuntimeIngestion`][ingest]에서
`MAX_BUFFERED_ASSISTANT_CHARS`는 24,000입니다. 이 한도를 넘기게 되는 덧붙이기 작업이 버퍼를
무효화하고 누적된 텍스트 전체를 델타 하나로 쏟아냅니다. 버퍼는 요청이 열리거나(승인) 사용자 입력이
요청되는 상호작용 경계에서도 `flushBufferedAssistantMessagesForTurn`을 통해 비워집니다.

[drivers]: ../../apps/server/src/provider/builtInDrivers.ts
[codex]: ../../apps/server/src/provider/Drivers/CodexDriver.ts
[codexargs]: ../../apps/server/src/provider/Layers/codexLaunchArgs.ts
[claude]: ../../apps/server/src/provider/Drivers/ClaudeDriver.ts
[cursor]: ../../apps/server/src/provider/Drivers/CursorDriver.ts
[gemini]: ../../apps/server/src/provider/Drivers/GeminiDriver.ts
[geminiauth]: ../../apps/server/src/provider/GeminiAuth.ts
[grok]: ../../apps/server/src/provider/Drivers/GrokDriver.ts
[opencode]: ../../apps/server/src/provider/Drivers/OpenCodeDriver.ts
[adapter]: ../../apps/server/src/provider/Services/ProviderAdapter.ts
[instances]: ../../apps/server/src/provider/Services/ProviderInstanceRegistry.ts
[registry]: ../../apps/server/src/provider/Services/ProviderAdapterRegistry.ts
[service]: ../../apps/server/src/provider/Layers/ProviderService.ts
[contracts]: ../../packages/contracts/src/orchestration.ts
[worker]: ../../packages/shared/src/DrainableWorker.ts
[ingest]: ../../apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts
[cmd]: ../../apps/server/src/orchestration/Layers/ProviderCommandReactor.ts
[checkpoint]: ../../apps/server/src/orchestration/Layers/CheckpointReactor.ts
