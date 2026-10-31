# T3 워크플로 스킬 분석과 적용 결정

T3의 AI Workflow에 스킬을 연결하려면 스킬의 발견·선택·버전·자료 로딩·실행 관측을 실행 그래프에 연결해야 한다. 스킬 본문은 작업 방법을 설명하고, T3 그래프는 단계·의존성·실행 상태·복구를 관리한다. `SKILL.md`의 자연어 절차를 실행 가능한 DAG로 자동 확정하지 않는다.

2026년 10월 26일 외부 저장소 5개의 스킬 파일 14개와 로컬 스킬 5개의 본문 또는 관련 절차를 분석했다. 공식 규격·제품 문서와 현재 T3 코드도 대조했다. 아래는 이 표본에서 채택할 설계이며 스킬 전체 생태계의 전수 검토나 해당 스크립트의 실행 검증 결과는 아니다. 구현 순서는 [T3 AI Workflow 개발 계획](t3-ai-workflow-development-plan-2026-10-26.md)에 반영한다.

## Claude와 공통 스킬 형식

[Agent Skills 규격](https://agentskills.io/specification)은 `SKILL.md`의 `name`·`description`, 선택적인 `compatibility`·`metadata`·`license`·`allowed-tools`, 부속 파일 구조를 정의한다. [통합 가이드](https://agentskills.io/client-implementation/adding-skills-support)는 목록의 메타데이터, 선택된 본문, 필요한 참조 파일을 차례로 읽는 방식을 설명한다. 규격은 모든 provider가 같은 설치 경로와 실행 방식을 사용한다고 정하지 않는다.

[Claude Code 공식 문서](https://code.claude.com/docs/en/skills)는 공통 형식에 호출·인자·문맥·도구 관련 확장을 더한다. 필요한 항목을 다음과 같이 처리한다.

| 항목                            | 의미                            | T3 적용                                                                    |
| ------------------------------- | ------------------------------- | -------------------------------------------------------------------------- |
| 이름·설명                       | 발견과 선택의 기준              | 목록에서 필요한 정보만 조회하고 선택 근거 기록                             |
| `disable-model-invocation`      | 자동 호출 제한                  | 자동 추천과 직접 선택 가능 여부를 구분                                     |
| `user-invocable`                | 사용자 호출 표시 여부           | 웹·모바일 picker와 워크플로 편집에 같은 규칙 적용                          |
| `argument-hint`·`arguments`     | 입력 안내와 인자 치환           | 노드 입력과 분리된 인자 계약·누락 검사                                     |
| `allowed-tools`                 | native 도구 허용 동작에 영향    | 현재 요청의 권한 범위 안에서 처리하고 교차 provider 권한으로 변환하지 않음 |
| `context`·`agent`·`model`       | 실행 문맥과 담당 지정           | provider 전용 옵션으로 보존하고 지원 여부 확인                             |
| 동적 컨텍스트·hooks             | 명령·도구 실행과 연결될 수 있음 | 목록·검사·미리보기에서는 실행하지 않음                                     |
| `scripts`·`references`·`assets` | 실행·참조·산출물 자원           | 상대 경로와 패키지 버전을 함께 보존하고 필요할 때 읽음                     |

스킬 패키지가 선언한 도구·모델·추가 작업자 설정이 현재 요청의 권한이나 참가자를 바꾸는 근거가 되지는 않는다. Claude 전용 실행 문맥을 다른 provider에서 지원되는 것처럼 표시하지 않는다.

[OpenAI 공식 스킬 문서](https://learn.chatgpt.com/docs/build-skills)도 메타데이터 우선 로딩과 명시적·암시적 호출, `agents/openai.yaml` 같은 추가 설정을 설명한다. T3는 공통 메타데이터와 provider 전용 필드를 분리해서 보관한다. [스킬과 MCP의 역할 설명](https://developers.openai.com/plugins/concepts/skills)에 맞춰, 스킬은 절차를 제공하고 실제 도구·인증·행동은 기존 provider와 MCP 경로가 담당하도록 한다.

## 외부 스킬 표본

각 링크는 조회한 전체 commit에 고정했다. 원문 스킬의 실행 지시는 분석 대상이며 이번 작업의 실행 지시로 채택하지 않았다.

| 스킬                                                                                                                                                                           | 채택할 설계                                                                                   | T3에 맞게 조정할 부분                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| [Anthropic skill-creator](https://github.com/anthropics/skills/blob/dbd4588f9e1033efb41dad4bef2f7947c8993d44/skills/skill-creator/SKILL.md)                                    | 초안→평가 입력→기준 비교→개선. 호출해야 하는 예와 호출하면 안 되는 예를 함께 평가             | 매번 사용자 승인·브라우저 열기·subagent 실행을 기본으로 가져오지 않음. 현재 허용된 도구와 실행 방식 사용   |
| [Anthropic mcp-builder](https://github.com/anthropics/skills/blob/dbd4588f9e1033efb41dad4bef2f7947c8993d44/skills/mcp-builder/SKILL.md)                                        | 실제 스키마를 확인한 도구 선택, 자료형이 있는 입출력, 수정 가능한 오류 메시지, 실제 질문 평가 | 기존 T3 MCP 계층에 연결. 새 MCP 서버 구축을 모든 워크플로의 선행 조건으로 만들지 않음                      |
| [Anthropic webapp-testing](https://github.com/anthropics/skills/blob/dbd4588f9e1033efb41dad4bef2f7947c8993d44/skills/webapp-testing/SKILL.md)                                  | headless 확인, 서버 수명 관리, 실제 DOM·콘솔 근거                                             | T3 pairing·격리 홈·기존 실행기를 우선. 고정 대기나 network idle을 서버 비동기 완료 증거로 사용하지 않음    |
| [Superpowers writing-plans](https://github.com/obra/superpowers/blob/2ce8aa15d05bd57213e6f746f953aafb7ded7a8b/skills/writing-plans/SKILL.md)                                   | 작업마다 수정 파일·입출력 인터페이스·검증 명령·기대 결과 명시                                 | 반복 승인·자동 커밋·원문의 계획 저장 위치를 강제하지 않음. 이 저장소의 문서 위치와 사용자 지시 유지        |
| [Superpowers executing-plans](https://github.com/obra/superpowers/blob/2ce8aa15d05bd57213e6f746f953aafb7ded7a8b/skills/executing-plans/SKILL.md)                               | 에이전트가 직접 연속 실행, 작업별 진행 기록, 문맥 축약 뒤 완료 작업 재실행 방지               | 자동 reviewer·모델 변경·전체 테스트·작업 기록 삭제를 그대로 가져오지 않음. 현재 요청의 실행 방식 유지      |
| [Superpowers systematic-debugging](https://github.com/obra/superpowers/blob/2ce8aa15d05bd57213e6f746f953aafb7ded7a8b/skills/systematic-debugging/SKILL.md)                     | 재현→계층별 근거→가설 하나→작은 수정→같은 증상 검증                                           | 횟수만으로 진단을 포기하거나 승인 작업 전체를 중단하지 않음. 새 근거와 독립 작업을 계속 처리               |
| [Superpowers verification-before-completion](https://github.com/obra/superpowers/blob/2ce8aa15d05bd57213e6f746f953aafb7ded7a8b/skills/verification-before-completion/SKILL.md) | 완료 주장과 그 주장을 증명하는 명령·출력 연결                                                 | 변경 범위의 필요한 검증만 실행. 테스트 통과·실제 적용·운영 정상 상태를 각각 기록                           |
| [ECC verification-loop](https://github.com/affaan-m/everything-claude-code/blob/25278e7d7b6cf6e6a4e7a6c8e10f14ff22f0eb5b/skills/verification-loop/SKILL.md)                    | build·type·lint·test·diff 결과를 구별해 보고                                                  | 전체 검사, 고정 coverage 목표, `HEAD~1` 기반 범위 선택을 기본으로 사용하지 않음                            |
| [ECC eval-harness](https://github.com/affaan-m/everything-claude-code/blob/25278e7d7b6cf6e6a4e7a6c8e10f14ff22f0eb5b/skills/eval-harness/SKILL.md)                              | 기능 평가와 회귀 평가 분리, 결정적 검사 우선, 버전·산출물 근거 연결                           | 원문이 자체 candidate 실행기를 비활성 상태로 설명하므로 운영 실행 엔진으로 도입하지 않음. 평가 설계만 참고 |
| [ECC iterative-retrieval](https://github.com/affaan-m/everything-claude-code/blob/25278e7d7b6cf6e6a4e7a6c8e10f14ff22f0eb5b/skills/iterative-retrieval/SKILL.md)                | 검색→관련성 평가→누락 자료 보강을 상한 안에서 반복                                            | 사용자 필수 지시와 출처는 유지. 점수·시간·토큰 절감 수치는 T3의 측정 결과로 전환하지 않음                  |
| [n8n workflow-patterns](https://github.com/czlonkowski/n8n-skills/blob/e037563e101749e630e6688d121d04529fe6ee7b/skills/n8n-workflow-patterns/SKILL.md)                         | 단계 설정, 연결 관계, 실제 데이터 결과를 별도로 검증. 반복 패턴을 템플릿화                    | webhook·외부 쓰기·활성화를 기본 템플릿에 자동 추가하지 않음. 구조 미리보기와 실제 실행 구분                |
| [n8n node-configuration](https://github.com/czlonkowski/n8n-skills/blob/e037563e101749e630e6688d121d04529fe6ee7b/skills/n8n-node-configuration/SKILL.md)                       | 작업 종류에 따라 필요한 입력을 보여주고 작은 스키마부터 확인                                  | n8n 필드·버전을 T3 계약에 복사하지 않음. T3 노드와 현재 provider의 실제 스키마 사용                        |
| [n8n validation-expert](https://github.com/czlonkowski/n8n-skills/blob/e037563e101749e630e6688d121d04529fe6ee7b/skills/n8n-validation-expert/SKILL.md)                         | 실행을 막는 오류, 검토할 경고, 선택 제안을 구분. 출력값까지 확인                              | n8n의 순환 허용을 T3 DAG에 이식하지 않음. 자동 수정으로 연결 의미·권한을 바꾸지 않음                       |
| [n8n-as-code n8n-architect](https://github.com/EtienneLescot/n8n-as-code/blob/97b7e53c9ebad9dd516345b7d3664cb397987580/skills/n8n-architect/SKILL.md)                          | backend의 실제 환경 확인, 스키마 기반 편집, 검증→실행 기록→결과 확인                          | T3 프로젝트에 n8n 설치·문서 갱신·push·배포를 자동 수행하지 않음. 초안 저장과 실제 적용을 구분              |

## 로컬 스킬 표본

| 스킬과 실제 파일                                                                                                          | 적용할 설계                                                                       | 현재 요청에서 유지할 제약                                                                            |
| ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| [t3-research-upgrade](../../.agents/skills/t3-research-upgrade/SKILL.md)                                                  | 원문 commit·원본/후보 해시, 집중 검사, 운영·복구 증거                             | 자료 수집·실험 통과·운영 적용을 구별                                                                 |
| [test-t3-app](../../.agents/skills/test-t3-app/SKILL.md)                                                                  | 환경 홈·포트·프로세스 소유권·pairing 상태를 재개 기록에 포함                      | 운영 DB와 테스트 분리, 허용된 headless 경로, 사용자 포커스 유지                                      |
| [test-t3-mobile](../../.agents/skills/test-t3-mobile/SKILL.md)                                                            | 변경에 맞는 JS 갱신·native 재빌드 선택, 실제 사용 가능한 플랫폼 확인              | 원문에 남은 PowerShell 예시는 사용하지 않음. Windows는 CMD·기존 실행기 사용, native 미검증 상태 구별 |
| HyperFrames `C:/Users/박태현/.codex/skills/hyperframes/SKILL.md`                                                          | 기존 프로젝트 상태에서 재개, 소유 workflow를 한 번 정하고 필요한 하위 자료만 로딩 | 원문의 preview 자동 열기·설치·업데이트를 이번 분석에서 실행하지 않음                                 |
| Documents `C:/Users/박태현/.codex/plugins/cache/openai-primary-runtime/documents/26.1020.11618/skills/documents/SKILL.md` | 생성 파일→렌더→검사→수정의 결과 검증 루프, 출력 manifest                          | 컨테이너 도구·renderer가 필요한 절차는 현재 호스트에서 사용 가능 여부부터 확인                       |

로컬에 목록이 존재하는 것과 현재 environment에서 실행 가능한 것은 다르다. 스킬의 참조 파일·도구 이름·컨테이너 경로·OS 요구 조건도 호환성 검사에 포함한다. 이 분석에서는 원본 스킬을 수정하거나 스크립트를 실행하지 않았다.

## 현재 T3와의 차이

| 코드 근거                                                                                                                          | 확인한 구조                                                                                                   | 개발 과제                                                                                            |
| ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| [ServerProviderSkill](../../packages/contracts/src/server.ts)                                                                      | 이름·설명·경로·범위·enabled·표시 이름 중심                                                                    | 호출 가능 여부, provider 확장, 패키지 식별·해시, 지원 상태를 선택 필드로 확장                        |
| [ClaudeSkills](../../apps/server/src/provider/Drivers/ClaudeSkills.ts)                                                             | 사용자·프로젝트 폴더 검색, 이름·설명 파싱, 프로젝트 동명 우선, 잘못된 YAML 제외                               | 공통 형식과 Claude native 형식의 차이, 호출 제한, 파싱 오류의 native 동작을 설치 버전별로 검증       |
| [ExtensionManager](../../apps/server/src/extensions/ExtensionManager.ts)                                                           | 로컬 폴더 복사, 관리 receipt, enable/disable/update와 교체 실패 복구                                          | 기존 관리 흐름에 파일 manifest·내용 해시·실행 버전 고정 추가                                         |
| 같은 두 모듈의 설정 경로                                                                                                           | discovery는 Claude instance `homePath`를 우선하지만 설치 context의 Claude home은 환경 변수·기본 경로에서 정함 | instance home과 설치·목록 경로가 일치하는지 우선 fixture로 검증. 현재는 경로 결정 차이를 확인한 상태 |
| [웹 검색](../../apps/web/src/providerSkillSearch.ts), [모바일 composer](../../apps/mobile/src/features/threads/ThreadComposer.tsx) | enabled 목록을 검색·표시                                                                                      | 수동 호출 제한·호환성·동명 namespace 처리를 공통 클라이언트 로직으로 연결                            |
| [WorkspaceAgentExecutor 입력](../../apps/server/src/orchestration/Services/WorkspaceAgentExecutor.ts)                              | provider·정책·프롬프트·실행 ID 전달                                                                           | 버전이 고정된 스킬 바인딩과 실제 적용 여부를 연결                                                    |

Claude SDK의 선언 의존성은 `^0.3.251`, 읽은 설치 package 버전은 `0.3.251`이다. SDK 버전만으로 내장 CLI의 모든 문서상 기능이 동작한다고 확정하지 않는다. native CLI·handshake와 호출 기록까지 확인해 capability 표를 완성한다.

## T3 스킬 연결 계약

첫 버전은 기존 에이전트 단계에 선택적인 `SkillBinding`을 붙인다. 새 스크립트 실행 엔진을 만들어 스킬의 `scripts/`를 자동 실행하지 않는다.

- `SkillRef`: environment, provider instance, scope·namespace, 원본 위치, 패키지 식별자, 내용 해시.
- `SkillBinding`: 선택한 참조, 인자, 직접 선택/자동 선택 구분, native/instruction 적용 방식, 필요한 capability.
- `SkillMetadata`: 공통 필드, provider 전용 원문 필드, 지원 상태, 진단 정보. 큰 본문과 자원은 목록 응답에 싣지 않는다.
- `SkillPackageSnapshot`: `SKILL.md`와 부속 파일의 상대 경로·내용 해시 manifest. 원본 폴더 밖 자원과 도구 의존성은 따로 표시한다.
- `SkillActivationRecord`: 호출 요청, 본문 로딩 관측, 실행 관측, 결과 검증을 각각 기록. provider가 실제 로딩을 노출하지 않으면 요청 상태로만 표시한다.

snapshot을 기록한 것만으로 native provider가 그 snapshot을 읽었다고 주장하지 않는다. 실제 provider가 참조할 수 있는 경로로 패키지를 연결하고 제출 시 해시를 확인한다. 버전이 바뀌었거나 부속 파일을 고정할 수 없으면 해당 단계를 재현 가능 상태로 표시하지 않는다. 지원하지 않는 native 옵션을 본문 텍스트로 조용히 대체하지 않는다.

원본 형식의 자동 변환과 별도로, 스킬에서 뽑은 절차를 T3 template 초안으로 제안할 수 있다. 이 초안은 입력·노드·의존성·정책 검사를 거쳐 저장하며 원문 스킬에 없던 도구·승인·참가자 요구를 사용자 선택으로 만들지 않는다.

## 선택과 로딩

1. 기존 provider 목록과 확장 관리 catalog에서 사용 가능한 스킬의 메타데이터를 가져온다. 같은 이름은 provider·scope·원본으로 구별한다.
2. 사용자가 직접 선택한 스킬을 먼저 연결한다. 자동 선택은 명시적 허용 범위와 호출 제한을 확인한 뒤 수행하고 선택 이유를 기록한다.
3. 선택된 스킬의 패키지·참조 파일과 현재 environment의 도구·OS·권한을 대조한다. 목록을 읽는 과정에서는 동적 컨텍스트나 hook을 실행하지 않는다.
4. native 호출을 지원하면 native 경로를 사용한다. T3가 동일 본문을 다시 주입해 중복 로딩하지 않는다. instruction 방식은 해당 스킬이 호환되는 경우에만 별도 방식으로 표시한다.
5. 재개 시 저장된 버전과 활성화 기록을 확인한다. 문맥 축약으로 필수 지시가 사라지지 않게 필요한 본문·참조를 다시 읽되 완료한 외부 행동은 재실행하지 않는다.

Claude의 별도 문맥 실행, Codex의 전용 설정 파일, 외부 도구 의존성은 각각 capability다. 스킬이 `allowed-tools`를 선언해도 전체 권한으로 바꾸지 않는다. 도구 허용을 현재 제한 안에 유지할 수 없는 조합은 구체적인 호환성 오류로 처리한다. 사용자 필수 지시는 선택·압축 예산과 무관하게 유지한다.

## 평가 설계

초기 스킬 선택 평가는 24개 고정 사례로 시작한다. 호출해야 하는 요청 8개, 키워드는 겹치지만 호출하지 않아야 하는 요청 8개, 직접 호출·인자 4개, 지원하지 않는 provider 확장 4개다. 여기에 기존 실행 복구·권한 회귀 사례를 연결한다.

정적 검사는 형식·경로·지원 여부를 확인하고, 실제 실행 평가는 산출물과 실행 결과를 확인한다. preview 성공, native 수락, 스킬 로딩 관측, 결과 검증을 서로 다른 상태로 둔다. baseline과 후보는 같은 fixture·provider·모델·설정에서 비교하고 정의·패키지·입력 해시를 남긴다. 가능한 판단은 코드 검사로 수행하고 주관적 품질만 별도 기준으로 평가한다.

선택 정확도, 누락·잘못된 호출, 결과 통과 여부, 재시도 수, 지연, provider가 보고한 사용량과 미보고 범위를 기록한다. 프롬프트 토큰 추정치를 실제 청구량으로 표시하지 않는다. 후보의 성공 사례만 보고 개선으로 판단하지 않으며 최종 확인용 사례를 분리한다. 평가 자체가 이미 승인된 개발 범위의 내부 검사라면 매 사례마다 재승인을 요구하지 않는다.

## 제가 수행할 개발 절차

구현 담당은 이 요청을 수행하는 Codex 에이전트다. 저장소·환경·로그로 확인할 내용을 먼저 조사하고, 기존 승인 범위의 수정·검증·적용을 연속해서 수행한다. 다른 작업이나 기능을 사용한다는 이유로 재승인을 요구하지 않는다. 별도 작업자는 현재 요청에서 허용된 경우에만 사용한다.

개발 작업은 파일·계약·검증 기준이 정해진 작은 단위로 나눈다. 각 단위의 시작 기준, 수정 범위, 실행한 명령·종료 코드·로그, 결과 해시, 남은 문제와 다음 작업을 기록한다. 다음 단위는 앞 단위의 실제 통과 기록을 읽고 시작한다. 문맥 축약이나 새 턴이 발생해도 같은 증거로 재개한다.

사용자가 정해야 할 정보가 실제로 없을 때만 해당 정보를 요청한다. 독립적으로 할 수 있는 작업은 계속한다. 새 credential 값·접근 불가능한 원본·사용자만 결정할 수 있는 요구 충돌은 필요한 입력으로 구별하되, 이를 구현 승인 전체를 다시 받는 절차로 바꾸지 않는다.

## 원문과 기준 기록

외부 source 확인 시각은 2026-10-26 06:42 UTC다. 아래 commit을 `git ls-remote`로 확인하고, 표의 스킬 원문을 해당 commit의 raw URL로 읽었다.

| 원본 저장소                                                                           | 전체 commit                                | 분석 파일 수 |
| ------------------------------------------------------------------------------------- | ------------------------------------------ | ------------ |
| [anthropics/skills](https://github.com/anthropics/skills)                             | `dbd4588f9e1033efb41dad4bef2f7947c8993d44` | 3            |
| [obra/superpowers](https://github.com/obra/superpowers)                               | `2ce8aa15d05bd57213e6f746f953aafb7ded7a8b` | 4            |
| [affaan-m/everything-claude-code](https://github.com/affaan-m/everything-claude-code) | `25278e7d7b6cf6e6a4e7a6c8e10f14ff22f0eb5b` | 3            |
| [czlonkowski/n8n-skills](https://github.com/czlonkowski/n8n-skills)                   | `e037563e101749e630e6688d121d04529fe6ee7b` | 3            |
| [EtienneLescot/n8n-as-code](https://github.com/EtienneLescot/n8n-as-code)             | `97b7e53c9ebad9dd516345b7d3664cb397987580` | 1            |

다음 SHA256은 읽기 시점 로컬 파일을 식별한다. 원본 스킬·실행 프로그램을 변경한 해시가 아니다.

| 로컬 파일                                                                                                       | SHA256                                                             |
| --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `.agents/skills/t3-research-upgrade/SKILL.md`                                                                   | `57a17d528d057af2a96421873e6eaa8466113570d8cf854c9024ab563c7dbf27` |
| `.agents/skills/test-t3-app/SKILL.md`                                                                           | `6e2062ea00e2b5e78d15af52e2e1dc74b797bdc447c94f440e0d97bc03d711bb` |
| `.agents/skills/test-t3-mobile/SKILL.md`                                                                        | `e203cc2847c2569bd73f68efed5cf928ccc70508c3d7e6ecb1b1fff538f69437` |
| `C:/Users/박태현/.codex/skills/hyperframes/SKILL.md`                                                            | `f9e4e952b6f6352e38d29dfa46849f86c4e1f134a7cd99d8b44bb9da6939e29f` |
| `C:/Users/박태현/.codex/plugins/cache/openai-primary-runtime/documents/26.1020.11618/skills/documents/SKILL.md` | `2412c240a6412eb8186d1daf0b92cbb828f4674069fa90d19243fb5fb58a2639` |
| `apps/server/src/provider/Drivers/ClaudeSkills.ts`                                                              | `21238913111e69df5355ce17a2a653aad0a2e2f51142dba68c278a1528b9cc29` |
| `apps/server/src/extensions/ExtensionManager.ts`                                                                | `b6742b3540a243b989aa1322c5ec9564923d84a8afff4733d4df2136300e6dce` |
| `packages/contracts/src/server.ts`                                                                              | `8deb1a035b5e3d245fef9437848e171c0599a5809c18f82481f91df6859ea031` |
| `packages/contracts/src/extensions.ts`                                                                          | `3d5fac926f11bc9186473d7421eaa4bfa5b5ad7c1b13a7e0db4b46b4718f4ebd` |
| `apps/web/src/providerSkillSearch.ts`                                                                           | `d5dec53e1380318cdd754321a505e27200ba6798d63a50060d99f32f2e7665f2` |
| `apps/mobile/src/features/threads/ThreadComposer.tsx`                                                           | `d8753045b55080c8ab557970e55b59fc7f2da9502e9dcb4778e4541ff43b739a` |

현재 완료 범위는 원문·코드 분석과 개발 계획 반영이다. 스킬 설치·실행 비교, T3 기능 구현·회귀 테스트와 운영 반영은 개발 작업별로 실제 증거가 생긴 뒤 완료 처리한다.
