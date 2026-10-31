# NewAutoUsage 개발에 참고할 GitHub 저장소

기준일은 2026년 10월 15일이다. 로컬 기준은 커밋 `1c42b71116f2` 위의 현재 작업 트리이며 미커밋 변경도 포함한다. 우선순위는 현재 구조와의 적합성, 기존 기능의 검증에 주는 도움, Windows 적용 조건, 추가 운영 부담으로 정했다.

먼저 참고할 자료는 Emdash의 작업실 초기화, ccusage의 사용량 회귀 테스트, Pi의 컨텍스트 축약과 취소 처리, node-pty의 Windows 테스트다. 검색은 이미 구현된 하이브리드 검색을 기준으로 QMD의 평가 방법을 적용하고, sqlite-vec 도입 여부는 측정 후 결정하는 것이 적절하다.

## 현재 코드와 비교한 기준

| 영역           | 현재 구현                                                                                                    | 자료를 적용할 지점                                                            |
| -------------- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| 지속 작업실    | Main과 Owner의 세션 바인딩, 전달 영수증, 직접 인수, 검증과 통합이 있다.                                      | 새 협업 엔진 도입보다 초기화 순서와 실패 복구의 회귀 사례 대조가 먼저다.      |
| 실행 복구      | 전달 불확실성, 실패 분류, 반복 실패 방지와 복구 전략을 구분한다.                                             | 이미 수락된 입력, 부분 완료, 취소와 재시작이 겹치는 사례를 보강한다.          |
| 사용량         | 이벤트 원장과 projection이 요청·작업·시도별 사용량 및 누락 상태를 관리한다.                                  | 외부 로그 파서의 중복 제거 사례를 현재 이벤트 모델의 fixture로 옮겨 비교한다. |
| 예산           | 목표와 일일 보고 토큰을 기준으로 새 자동 실행을 제한한다.                                                    | 실제 과금액과 구독 사용 한도, 추정 비용을 구분한 채 정확도를 평가한다.        |
| RAG            | FTS, Ollama 임베딩, RRF, 프로젝트·폴더 필터와 부분 색인 표시가 있다. 의미 검색 후보는 요청당 최대 1,000개다. | 한국어 검색 평가와 캐시 재사용을 먼저 측정한다.                               |
| Windows 터미널 | node-pty를 사용하며 Windows의 kill 인자 처리도 이미 있다.                                                    | 인자 인코딩, ConPTY 준비 시점, 종료 경쟁 상태의 회귀 사례를 대조한다.         |

로컬 근거는 [지속 작업실 설계](persistent-workspaces/README.md), [복구 정책](../../apps/server/src/orchestration/workspaceDevelopmentRecovery.ts), [사용량 projection](../../apps/server/src/orchestration/Layers/TokenUsageProjection.ts), [예산 계산](../../apps/server/src/orchestration/workspaceDevelopmentUsage.ts), [검색](../../apps/server/src/documents/semanticSearch.ts), [RAG 조회](../../apps/server/src/persistence/Layers/ProjectionWorkspaceRag.ts), [Windows PTY 어댑터](../../apps/server/src/terminal/NodePtyAdapter.ts)다.

## 저장소별 우선순위

‘우선’은 다음 개발에서 코드·테스트를 대조할 대상이다. ‘검증 후’는 데이터 연결이나 성능 측정이 필요한 후보이며, ‘비교’는 설계와 UX를 참고할 대상이다.

| 자료                                                                                                      | 우선순위  | NewAutoUsage에 유용한 부분                                     | 적용 조건                                                                               |
| --------------------------------------------------------------------------------------------------------- | --------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| [pingdotgg/t3code](https://github.com/pingdotgg/t3code)                                                   | 상시      | 동일 기반의 provider, 원격 연결, 웹·데스크톱·모바일 변경 추적  | 현재 포크의 변경과 수정 단위로 비교한다.                                                |
| [generalaction/emdash](https://github.com/generalaction/emdash)                                           | 우선      | Electron·SQLite·worktree, 준비 작업과 실행의 순서, 원격 작업실 | 수명 주기 설계와 테스트를 참고한다. Apache 2.0.                                         |
| [ccusage/ccusage](https://github.com/ccusage/ccusage)                                                     | 우선      | 여러 CLI의 사용량 파싱과 중복·상속·축약 사용량 검증            | 현재 주요 파서는 Rust다. 로컬 파일 집계와 실시간 이벤트 집계를 구분한다.                |
| [earendil-works/pi](https://github.com/earendil-works/pi)                                                 | 우선      | 컨텍스트 축약, 후속 입력, 취소와 스트림 오류의 회귀 테스트     | provider 내부 컨텍스트와 앱이 만드는 인계 자료의 경계를 유지한다. MIT.                  |
| [steipete/CodexBar](https://github.com/steipete/CodexBar)                                                 | 우선      | 계정별 한도, 마지막 정상 값, 조회 오류와 출처 표시             | Swift 중심의 macOS·Linux 제품이다. 상태 모델과 UX를 참고한다. MIT.                      |
| [microsoft/node-pty](https://github.com/microsoft/node-pty)                                               | 우선      | Windows 인자 처리, 준비 전 PID, 생성 실패, 종료 경쟁 상태      | 이미 사용하는 의존성이다. 설치 버전과 upstream 수정 포함 여부를 대조한다.               |
| [modelcontextprotocol/inspector](https://github.com/modelcontextprotocol/inspector)                       | 우선      | MCP 연결·도구 목록·실제 호출·오류 종류의 자동 검사             | 개발 검증용으로 버전을 고정하고 현재 MCP 계약과 맞춘다.                                 |
| [tobi/qmd](https://github.com/tobi/qmd)                                                                   | 우선      | 로컬 검색 평가, 키워드·벡터·혼합·재순위화 비교                 | 한국어 정답셋과 현재 모델·하드웨어에서 평가한다.                                        |
| [anomalyco/models.dev](https://github.com/anomalyco/models.dev)                                           | 검증 후   | 모델 기능, 컨텍스트·출력 한도, 가격과 provider별 차이          | 카탈로그와 실제 계정의 모델 가용성, 구독 한도를 구분한다.                               |
| [promptfoo/promptfoo](https://github.com/promptfoo/promptfoo)                                             | 검증 후   | RAG·프롬프트 설정별 답변 평가                                  | 모델 채점의 변동성과 평가 호출 비용을 함께 기록한다.                                    |
| [agentskills/agentskills](https://github.com/agentskills/agentskills)                                     | 검증 후   | SKILL.md 메타데이터와 배포 구조의 표준                         | provider별 확장 기능을 별도 capability로 표시한다.                                      |
| [langchain-ai/langgraphjs](https://github.com/langchain-ai/langgraphjs)                                   | 비교      | 체크포인트·중단·재개·영속 상태의 설계                          | 기존 Effect와 이벤트 원장의 복구 정책을 대조할 자료다.                                  |
| [asg017/sqlite-vec](https://github.com/asg017/sqlite-vec)                                                 | 검증 후   | SQLite 안의 벡터 검색과 범위 필터                              | pre-v1이다. 현재 후보 수에서 이득과 native 패키징을 측정한다.                           |
| [restic/restic](https://github.com/restic/restic)                                                         | 검증 후   | Windows 지원 백업, 무결성 검사와 별도 경로 복원                | SQLite의 일관된 스냅샷 생성과 복구 시나리오를 먼저 설계한다.                            |
| [slopus/happy](https://github.com/slopus/happy)                                                           | 비교      | 모바일 원격 제어와 암호화 동기화, 클라이언트 분리              | 현재 T3 환경 연결·권한 모델과 대응시킨다.                                               |
| [tiann/hapi](https://github.com/tiann/hapi)                                                               | 비교      | hub·runner 구조, 로컬과 원격 간 인수인계, 승인 요청            | AGPL 3.0이다. 코드 재사용은 해당 조건을 검토한다.                                       |
| [agentclientprotocol/agent-client-protocol](https://github.com/agentclientprotocol/agent-client-protocol) | 상시      | 기존 ACP 어댑터의 메시지와 버전 대응                           | provider가 실제 지원하는 기능을 개별 확인한다.                                          |
| [BloopAI/vibe-kanban](https://github.com/BloopAI/vibe-kanban)                                             | 비교      | 작업실, diff 댓글, 미리보기와 변경 검토 UX                     | 운영사 종료와 커뮤니티 유지 전환 공지가 있다.                                           |
| [superset-sh/superset](https://github.com/superset-sh/superset)                                           | 비교      | 병렬 작업실과 터미널 중심의 조작 흐름                          | 현재 라이선스는 ELv2다. 이전 fork의 Apache 표기를 그대로 적용하지 않는다.               |
| [getzep/graphiti](https://github.com/getzep/graphiti)                                                     | 장기 검토 | 사실의 유효 기간, 원본 근거, 변경 이력 모델                    | Python과 그래프 저장소 운영이 추가된다. 현재 요구는 기존 revision 구조로 먼저 평가한다. |
| [restatedev/restate](https://github.com/restatedev/restate)                                               | 장기 검토 | 외부 부수 효과의 실행 기록과 장애 복구 설계                    | 별도 실행 플랫폼이며 서버 라이선스는 BSL 1.1이다.                                       |

## 코드와 테스트에서 참고할 내용

### Emdash의 작업실 초기화

Emdash는 worktree 생성과 준비 파일 복사, prepare·setup·run을 구분한다. 초기 화면에 작업실을 표시하는 시점과 에이전트가 실제 작업을 시작해도 되는 시점을 별도로 다룬다. 복사 대상은 프로젝트 설정으로 명시하며 Windows에서는 로컬 tmux를 끈다. [작업실 수명 주기](https://github.com/generalaction/emdash/blob/79f37d920bd576dc18ca5421856fd2cc9ec8abac/agents/workflows/worktrees.md)

[초기화 gate 테스트](https://github.com/generalaction/emdash/blob/79f37d920bd576dc18ca5421856fd2cc9ec8abac/packages/core/src/runtimes/workspace-registry/node/activation-gate.test.ts)는 준비 파일 처리와 초기화 명령의 순서를 확인한다. 파일 처리 실패 뒤 진행을 허용하는 정책도 있으므로, NewAutoUsage에서는 필수 준비 파일과 선택 파일의 실패를 구분해 결정해야 한다. 해당 테스트의 고정 시간 대기는 프로젝트의 receipt·worker drain 방식에 맞춰 바꿔야 한다.

적용 지점은 [WorkspaceDevelopmentGit](../../apps/server/src/orchestration/WorkspaceDevelopmentGit.ts)과 [WorkspaceDevelopment](../../apps/server/src/orchestration/WorkspaceDevelopment.ts)다. 초기화 중 취소, 서버 재시작, 필수 파일 복사 실패 뒤 Owner 배정을 허용하는지 대조할 가치가 있다.

### ccusage의 사용량 정확도

현재 정식 저장소는 `ccusage/ccusage`이며 `ryoppippi/ccusage`에서 이전됐다. 확인한 snapshot의 Codex 파서는 Rust이고, 루트 LICENSE는 실제 MIT 파일을 가리킨다. [파서 자료](https://github.com/ccusage/ccusage/blob/482f757497392c48d0f56e9804d529cebc729080/rust/adapters/codex/src/README.md), [라이선스](https://github.com/ccusage/ccusage/blob/482f757497392c48d0f56e9804d529cebc729080/apps/ccusage/LICENSE)

가치가 큰 자료는 [축약 사용량 테스트](https://github.com/ccusage/ccusage/blob/482f757497392c48d0f56e9804d529cebc729080/rust/adapters/codex/src/compaction_tests.rs)와 [압축 세션 테스트](https://github.com/ccusage/ccusage/blob/482f757497392c48d0f56e9804d529cebc729080/rust/adapters/codex/src/compression_tests.rs)다. 원본과 압축 사본의 중복, 부모 기록을 상속한 자식 세션, 조회 기간 밖의 부모, 축약 사용량의 이중 반영을 검증한다.

NewAutoUsage는 실시간 provider 이벤트를 원장에 저장하므로 오프라인 파일 집계와 입력 경로가 다르다. 테스트의 상황과 기대 합계를 현재 이벤트 fixture로 변환해 [사용량 projection 테스트](../../apps/server/src/orchestration/Layers/TokenUsageProjection.test.ts)에 대조하는 방식이 적절하다. 실제 CLI가 보고한 사용량, 누락 범위, 가격 기반 추정액을 유지해야 하며 구독 청구액으로 표시해서는 안 된다.

### CodexBar의 계정 한도와 마지막 정상 값

CodexBar의 [계정 snapshot 저장](https://github.com/steipete/CodexBar/blob/278e9056e830000532e4c3a6342dc0b2c75f00d6/Sources/CodexBar/CodexAccountUsageSnapshotStore.swift)은 계정 identity, 사용량 snapshot, 오류, 출처와 크레딧 정보를 함께 관리한다. [마지막 정상 값 표시](https://github.com/steipete/CodexBar/blob/278e9056e830000532e4c3a6342dc0b2c75f00d6/Sources/CodexBar/LastKnownUsagePresentation.swift)는 값의 수집 시점을 보여 준다. [갱신 정책](https://github.com/steipete/CodexBar/blob/278e9056e830000532e4c3a6342dc0b2c75f00d6/Sources/CodexBar/UsageStore+AccountRefreshPolicy.swift)은 인증 방식에 따라 여러 계정을 일괄 조회할지 구분한다.

적용 지점은 [계정 사용량 파싱](../../apps/server/src/provider/providerAccountUsage.ts)과 [계정 사용량 화면](../../apps/web/src/components/settings/ProviderAccountUsage.tsx)이다. 조회 실패 때 이전 값을 계속 표시한다면 최신 조회 실패와 이전 값의 나이를 함께 표시하고, 계정 전환 후 이전 계정의 수치를 재사용하지 않는지 확인한다. Swift 코드는 상태 모델의 참고 자료로 사용한다.

### Pi의 컨텍스트 축약과 취소

`badlogic/pi-mono`의 현재 정식 주소는 `earendil-works/pi`다. [축약 문서](https://github.com/earendil-works/pi/blob/b06c1f2cf1dea6af8748ddeee18c23587d2cb7c6/packages/coding-agent/docs/compaction.md)는 도구 호출과 결과의 경계, 최근 작업 보존과 파일 작업 이력을 다룬다.

특히 [잘린 요약 회귀 테스트](https://github.com/earendil-works/pi/blob/b06c1f2cf1dea6af8748ddeee18c23587d2cb7c6/packages/coding-agent/test/suite/regressions/7048-compaction-truncated-summary.test.ts)는 출력 한도에 걸린 요약을 정상 축약 결과로 저장하지 않는다. [취소 회귀 테스트](https://github.com/earendil-works/pi/blob/b06c1f2cf1dea6af8748ddeee18c23587d2cb7c6/packages/coding-agent/test/suite/regressions/9340-9777-auto-compaction-cancellation.test.ts)는 중단 이후의 자동 축약, 요약 인증 중 취소와 확장 기능 취소를 구분한다.

NewAutoUsage의 [인계 입력 구성](../../apps/server/src/orchestration/workspacePrompt.ts)에 적용할 후보는 요약 실패 시 원문 유지, 중단 후 후속 작업 차단, 요구사항 revision과 근거 참조의 보존이다. CLI 내부 세션을 관리하는 축약은 해당 provider에 맡기고, 앱이 작성하는 인계·기억 자료의 축약을 다룬다.

### node-pty의 Windows 회귀 사례

[Windows 인자와 연결 테스트](https://github.com/microsoft/node-pty/blob/d182c6079fc31bab364c1754ee0dca103cd0a7bc/src/windowsPtyAgent.test.ts)는 공백·따옴표·역슬래시·빈 인자와 출력 worker 준비 시점을 다룬다. [터미널 테스트](https://github.com/microsoft/node-pty/blob/d182c6079fc31bab364c1754ee0dca103cd0a7bc/src/windowsTerminal.test.ts)는 준비 전 PID, 실행 파일 생성 실패, 종료 코드와 kill·resize 경쟁 상태를 다룬다.

[현재 어댑터](../../apps/server/src/terminal/NodePtyAdapter.ts)는 이미 Windows에서 signal 인자를 제거해 kill을 호출한다. 이 처리를 다시 만드는 것보다 [현재 테스트](../../apps/server/src/terminal/NodePtyAdapter.test.ts)와 upstream의 준비·종료 사례를 대조하는 것이 유용하다. upstream 일부 fixture는 PowerShell을 실행하므로 이 PC에서 검증할 때는 CMD와 직접 실행 프로그램으로 구성한다. 최신 main의 수정이 현재 설치한 패키지에 포함됐는지는 별도로 확인한다.

### QMD와 sqlite-vec의 검색 평가

QMD의 [평가 fixture](https://github.com/tobi/qmd/blob/main/src/bench/fixtures/example.json)와 [평가 설명](https://github.com/tobi/qmd#benchmarking)은 같은 정답 문서로 키워드, 벡터, 혼합, 재순위화 결과를 비교한다. 현재 한국어 holdout 자료를 유지하면서 Recall@k·MRR, 검색 지연, 첫 색인 시간, 메모리를 함께 기록하는 데 참고할 수 있다. 예제 데이터의 성적을 한국어 자료의 성능으로 일반화하지 않는다.

현재 [semanticSearch](../../apps/server/src/documents/semanticSearch.ts)는 프로젝트·endpoint·모델로 캐시 파일을 정하고, 저장할 때 현재 검색 후보의 content key만 남긴다. [호출 경로](../../apps/server/src/persistence/Layers/ProjectionWorkspaceRag.ts)는 폴더·자료 제외 등의 조건을 적용한 후보를 넘긴다. 따라서 A 범위에서 색인한 뒤 B 범위를 검색하고 다시 A로 돌아오면 A 전용 캐시가 제거돼 재임베딩될 가능성이 있다. 이는 코드에서 도출한 재현 후보이며 사용자 환경에서 측정된 장애는 아니다.

먼저 A→B→A fixture에서 임베딩 호출 수와 검색 범위 준수를 확인한다. 캐시의 수명과 조회 범위를 분리할 필요가 확인되면 기존 JSON 캐시에서 해결할 수 있는 범위를 평가한다.

sqlite-vec는 Windows와 Node를 지원하는 SQLite 벡터 확장이고 partition key 관련 테스트도 있다. 다만 README가 pre-v1 변경 가능성을 명시하며, 현재 후보 제한에서 native 확장이 더 빠르다는 결론은 측정 전에는 낼 수 없다. [README](https://github.com/asg017/sqlite-vec/blob/04d28bd21773981e2d266bbf6aa4efbd011eb4f6/README.md), [범위 분리 테스트](https://github.com/asg017/sqlite-vec/blob/04d28bd21773981e2d266bbf6aa4efbd011eb4f6/tests/test-partition-keys.py)

### MCP와 스킬의 호환성 검증

Inspector의 [CLI 검증 가이드](https://github.com/modelcontextprotocol/inspector/blob/main/docs/cli-smoke-testing.md)는 연결, 도구 발견, 실제 호출, 기계 판독 결과와 실패 종류를 연결한다. [ManagedMcpTools](../../apps/server/src/mcp/ManagedMcpTools.ts)의 현재 검사에 필요한 최소 절차를 선택하고, 설치 버전을 고정해 재현성을 유지할 수 있다.

[Agent Skills 규격](https://github.com/agentskills/agentskills/blob/69ef37e9424c0a7ea9dd2293b559e43ec8176379/docs/specification.mdx)은 스킬의 메타데이터와 디렉터리 구조를 정의한다. [확장 도구 계약](../../packages/contracts/src/extensions.ts)에서 공통 메타데이터 검증과 provider별 지원 기능을 구분할 때 참고한다. ACP는 에이전트와 클라이언트의 통신, MCP는 에이전트와 도구의 연결이라는 각각의 역할에 맞게 기존 어댑터를 대조한다. [ACP 스키마](https://github.com/agentclientprotocol/agent-client-protocol)

### 모델 데이터와 답변 품질 평가

models.dev는 모델 공통 정보와 provider별 가격·한도 정보를 분리하고 JSON API를 제공한다. 모델 선택기와 API 연결 설정의 공통 데이터 후보로 적합하다. 동기화 실패 때 사용할 snapshot, 갱신 시각, 사용자 지정 값의 우선순위를 정해야 한다. 실제 계정에 허용된 모델과 구독 한도는 provider 조회가 기준이다. [데이터 구조](https://github.com/anomalyco/models.dev#api)

Promptfoo의 [RAG 평가 예제](https://github.com/promptfoo/promptfoo/tree/main/examples/eval-rag-full)는 문서 수집·검색·평가 구성을 분리한다. 검색 결과의 정답 문서 포함 여부는 고정 정답셋으로, 최종 답변의 근거 충실도는 반복 평가로 다룬다. 모델 채점 결과의 변동과 토큰 사용량을 함께 기록한다.

## 조건을 확인한 뒤 검토할 자료

Superset의 현재 [LICENSE](https://github.com/superset-sh/superset/blob/main/LICENSE.md)는 Elastic License 2.0이다. 오래된 fork나 검색 결과의 Apache 표기만으로 코드 재사용 조건을 판단하면 안 된다. 작업실·터미널 UX 비교 대상으로 두는 것이 적절하다.

Restate 서버의 [LICENSE](https://github.com/restatedev/restate/blob/main/LICENSE)는 BSL 1.1이며 추가 사용 허용 조건과 전환 조건이 있다. SDK와 서버의 조건을 구분해야 한다. 현재 Effect·SQLite 원장 옆에 별도 실행 플랫폼을 더할 필요가 있는지 먼저 확인한다.

Graphiti는 시간에 따른 사실의 변경과 원본 근거 연결을 모델링한다. 현재 문서상 Python과 그래프 저장소 구성이 필요하다. 요구사항 revision과 근거 이력의 유용한 개념을 먼저 검토하고, 저장소 추가는 실제 조회 요구로 정한다. [구조와 요구 조건](https://github.com/getzep/graphiti#installation)

Vibe Kanban은 운영사 bloop의 종료와 커뮤니티 유지 전환을 공지했다. 로컬 작업실은 계속 동작한다고 설명하며 원격 서비스 종료도 안내한다. 프로젝트 전체를 사용 불가능하거나 이미 archived 상태라고 취급할 근거는 아니다. [공식 공지](https://www.vibekanban.com/blog/shutdown)

HAPI는 [AGPL 3.0](https://github.com/tiann/hapi/blob/main/LICENSE)이다. hub·runner와 인수인계 설계의 비교 자료로 유용하며 코드 재사용은 배포 형태에 맞는 검토가 필요하다. Happy는 모바일·CLI·relay와 desktop·agent runtime의 저장소가 분리돼 있으므로 목적에 맞는 저장소를 선택한다. [Happy 구성](https://github.com/slopus/happy#how-happy-fits-together)

restic은 Windows를 지원하며 별도 위치 복원과 복원 결과 검증을 제공한다. NewAutoUsage의 백업 기능 후보로 삼으려면 SQLite의 일관된 스냅샷, 첨부·검증 산출물 범위, secrets 보관 정책을 정하고 임시 디렉터리에서 복구를 검증해야 한다. 살아 있는 SQLite 파일을 단순 복사하는 방식은 프로젝트의 데이터 복제 원칙과 맞지 않는다. [지원 운영체제](https://github.com/restic/restic), [복원 절차](https://restic.readthedocs.io/en/stable/050_restore.html)

## 다음 개발 과제 후보

| 순서 | 작업                                | 참고 자료                              | 완료 조건                                                                                                                             |
| ---- | ----------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | 사용량 집계의 외부 fixture 대조     | ccusage, CodexBar                      | 부모·자식, 재전달·재개, 축약·부분 보고와 계정 전환을 재현한다. 합계·누락 범위·계정 identity가 예상과 일치한다.                        |
| 2    | RAG 캐시 재사용과 한국어 검색 평가  | QMD, 기존 holdout, sqlite-vec는 조건부 | A→B→A의 임베딩 호출 수를 확인하고 범위 밖 자료가 결과에 섞이지 않는다. 변경 전후 Recall@k·MRR·지연·메모리를 동일 조건으로 비교한다.   |
| 3    | 작업실 준비와 취소 상태의 회귀 검증 | Emdash, Pi, 기존 복구 테스트           | 필수 준비 실패 시 Owner가 시작하지 않는다. 중단 뒤 자동 축약·후속 배정이 새로 시작되지 않고, 잘린 요약이 정상 결과를 대체하지 않는다. |
| 4    | Windows PTY와 MCP의 통합 검사       | node-pty, Inspector                    | CMD의 공백·한글 경로·인자를 검증하고 준비 전 실패와 종료를 구분한다. MCP 연결·도구 호출·오류 분류가 실제 출력과 일치한다.             |
| 5    | 모델 정보 동기화와 계정 한도 표시   | models.dev, CodexBar                   | 오프라인 snapshot과 사용자 지정 값이 유지된다. 조회 실패·수집 시각·계정·추정 비용이 일관되게 표시된다.                                |

변경 범위별 집중 테스트를 사용한다. 협업·사용량·검색의 서버 동작을 바꾸면 해당 fixture와 회귀 테스트를 추가하고, 상태가 클라이언트로 전달되는 변경은 contracts·공유 client runtime·웹·데스크톱·모바일의 적용 범위를 확인한다.

## 소스 기준과 갱신

아래 일곱 저장소의 상세 소스 링크는 확인한 commit에 고정했다. 다음 값은 GitHub API에서 확인한 최근 push 시각의 UTC 날짜이며 안정성이나 릴리즈 포함 여부를 뜻하지 않는다. 가격 snapshot과 의존성 갱신만으로도 날짜가 바뀔 수 있다.

| 저장소       | 코드 기준      | 최근 push UTC    |
| ------------ | -------------- | ---------------- |
| Emdash       | `79f37d920bd5` | 2026년 10월 14일 |
| ccusage      | `482f75749739` | 2026년 10월 14일 |
| Pi           | `b06c1f2cf1de` | 2026년 10월 14일 |
| CodexBar     | `278e9056e830` | 2026년 10월 14일 |
| node-pty     | `d182c6079fc3` | 2026년 10월 3일  |
| sqlite-vec   | `04d28bd21773` | 2026년 5월 18일  |
| Agent Skills | `69ef37e9424c` | 2026년 8월 9일   |

새 의존성을 선택할 때는 고정할 릴리즈, Windows native 바이너리, Electron·Node ABI, 패키지별 라이선스와 서버·SDK의 경계를 다시 확인한다. 제시한 성능·정확도 개선은 위 완료 조건을 통과한 뒤 채택한다.
