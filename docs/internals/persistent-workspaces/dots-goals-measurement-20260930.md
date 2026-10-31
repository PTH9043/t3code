# 목표 자동 개발 방식: 2026-09-30 실측

사용자가 원하는 것은 **dots 같은 목표 자동 진행을 현재 프로그램 안에 구현하는 것**이다. 외부 dots 설치·계정·브라우저 연결은 요구사항이 아니다. 이 문서는 설치된 Codex의 목표 실행 실측을 보존한다. 제품 구현은 별도의 [개발 목표 기능](development-goals.md)에 기록한다.

## 대상과 범위

| 대상                            | 확인 결과                                                                              |
| ------------------------------- | -------------------------------------------------------------------------------------- |
| Codex CLI                       | `0.159.2`; `features.goals`는 stable/true                                              |
| 설치된 Windows 앱               | `OpenAI.Codex` `26.924.2738.0`                                                         |
| ChatGPT/dots 계정과 컴퓨터 연결 | 현재 도구로 확인되지 않음; Codex 앱 설치나 로그인으로 대신 판정하지 않음               |
| 현재 T3 계약                    | `effect-codex-app-server`에 목표 요청/알림 타입 존재                                   |
| 현재 T3 provider/관리 코어      | 목표 설정 메서드, 목표 이벤트 투영, 목표 UI 연결 없음                                  |
| dots 연결 도구 검색             | Plugin Management의 `dots` 검색 결과 0개; 전체 서비스 존재 여부를 단정하는 근거는 아님 |

모든 실행은 `.t3/dots-goals-probe-20260930-v*`의 한글·공백 경로와 새 네이티브 세션에서 수행했다. 사용자의 Main/Owner를 다른 프로세스로 재개하지 않았으며, 운영 T3 DB와 설정은 수정하지 않았다. 읽기 전용 네이티브 세션에 공식 동적 도구를 제공해 서로 다른 턴의 도구 호출을 실제 파일로 기록했다. 모델은 설치된 `gpt-6.1-sol`을 사용했다.

### dots 화면 접근 시도

사용자는 브라우저 실측에 명시적으로 동의했다. 그 뒤 UI 도구에서 확인한 실제 상태는 `apps: [], browsers: []`였다. ChatGPT에 접근할 브라우저 선택은 `No browser is available`, 내장 브라우저 생성은 `Browser is not available: iab`로 실패했다. 사용자의 동의 부족이나 프로그램 전체의 실행 불가로 설명하지 않는다. 이 대화에 제어 가능한 브라우저가 노출되지 않은 상태이며, dots 계정이나 연결 상태를 열람하지 못했다.

이 접근 시도는 외부 dots 연결이 필요하다고 잘못 해석한 결과다. 사용자의 정정에 따라 외부 접근은 중단했으며 브라우저 설치나 연결은 필요하지 않다.

## 실제 결과

### v1: 예산 제한

12,000 토큰 예산으로 활성화하자 `turn/start` 요청 없이 첫 실행이 시작됐다. 첫 단계 이후 목표가 `budgetLimited`로 전환되어 후속 실행이 멈췄다. 보고 사용량은 24,047 토큰이었다. 이 런타임의 목표 예산은 토큰마다 요청을 정확하게 잘라내는 상한이 아니며, 이번 실측에서는 한 턴의 사용량 갱신으로 설정치를 넘었다.

예산 소진 후 `status=paused`를 요청해도 반환 상태는 `budgetLimited`였다. 요청한 상태 문자열을 실제 적용 상태로 간주하면 안 된다. v1은 두 단계 완료에 실패했으며 근거는 `.t3/dots-goals-probe-20260930-v1/evidence.json`에 보존했다.

### v2: 제어와 복구

첫 도구 호출 시 목표를 일시정지하고 첫 턴의 완료를 기다렸다. 이후 10초 관찰 동안 다음 턴이 시작되지 않았다. API로 재개하자 사용자 메시지 없이 다음 턴이 시작됐으며 사용량 기록은 유지됐다.

저장·조회·삭제, 빈 목표/4,001자 목표/음수 예산 거절, 프로세스 재시작 후 목표 복원, 같은 네이티브 세션 및 cwd 복원도 통과했다. 정지 요청 이후 이미 실행 중인 첫 턴은 완료됐다. 즉시 실행 중단에는 별도 턴 중단 처리가 필요하다.

근거: `.t3/dots-goals-probe-20260930-v2/evidence.json`. v2에는 테스트 클라이언트의 명시적인 목표 pause/resume이 있었으므로 무개입 연속 실행의 증거로는 v3를 사용한다.

### v3: 무개입 연속 실행

| 항목                                    | 실측값                                                |
| --------------------------------------- | ----------------------------------------------------- |
| 네이티브 세션                           | `01a0f133-68c5-7051-83ff-f7b134723dc7`                |
| 첫 턴                                   | `01a0f133-71fa-76c0-af97-2474f8074361`                |
| 다음 턴                                 | `01a0f133-9746-7653-8844-a585cd9199f7`                |
| 클라이언트의 `turn/start` 요청          | **0회**                                               |
| 두 단계 사이 사용자 입력 또는 목표 재개 | **없음**                                              |
| 실제 도구 결과                          | 서로 다른 두 턴에서 `step-1.json`, `step-2.json` 생성 |
| 달성 후 목표 상태                       | `complete`                                            |
| 설정 예산 / 보고 사용량                 | 40,000 / 24,735 토큰                                  |
| 보고 실행 시간                          | 17초                                                  |
| 재시작                                  | 같은 session ID, cwd, 목표 상태/사용량 복원           |

첫 턴 완료 알림 이후 두 번째 턴 시작 알림을 받았다. 단순 프롬프트의 “계속하겠다”라는 답변이 아니라 실제 네이티브 턴과 도구 결과를 대조했다. 이 작은 계측 과제의 성공을 전체 프로젝트 자동 개발이나 제품 통합 성공으로 확대하지 않는다.

근거: `.t3/dots-goals-probe-20260930-v3/evidence.json`. 비밀정보와 모델의 비공개 사고는 측정 기록에 포함하지 않았다. 측정용 프로세스는 종료했고 활성 목표를 남기지 않았다.

## 재현

새 테스트 경로를 사용한다. 기존 경로 재실행은 산출물을 덮어쓰므로 보존이 필요한 폴더를 재사용하지 않는다.

```powershell
codex app-server generate-json-schema --experimental --out <new-schema-directory>
codex features list

# 일시정지/재개 포함
node scripts/workspace-goals-probe.mjs <new-isolated-home> 80000

# 두 턴 사이 제어 개입 없이 연속 실행
node scripts/workspace-goals-probe.mjs <another-new-isolated-home> 40000 auto
```

목표 API는 `experimentalApi=false`에서도 동작했다. 계측용 `dynamicTools`는 별도의 실험 API 동의가 필요했다. 설치된 CLI가 생성한 JSON Schema에서 필드와 응답 형식을 확인했고 이벤트·응답으로 동기화했다. 10초 정지 관찰은 명시적인 관찰 창이며 장시간 안전성 보장은 아니다. 측정 스크립트의 scoped lint/format도 통과했다.

## dots와 Goals의 경계

공식 dots 문서는 지속 책임, 후속 실행, 지원되는 플러그인 사용과 연결된 컴퓨터의 Codex 작업 생성/재개를 설명한다. [dots 작업과 기억](https://learn.chatgpt.com/docs/dots/tasks-and-memory), [컴퓨터와 앱 연결](https://learn.chatgpt.com/docs/dots/computers-and-apps).

연결된 컴퓨터가 있다고 T3 세션이 dots 작업으로 자동 등록되거나 두 앱의 실행 큐가 공유된다는 보장은 확인되지 않았다. 확인한 공식 dots 문서와 문서 인덱스에서는 외부 앱이 직접 dots를 제어하는 공개 요청 계약을 찾지 못했다. 이를 API 부재의 확정 증거로 표현하지 않는다.

Goals는 Codex thread에 붙는 목표 API이며 dots와 구별한다. 실제 요청은 `thread/goal/set`, `thread/goal/get`, `thread/goal/clear`, 알림은 `thread/goal/updated`, `thread/goal/cleared`다. [공식 app-server 계약](https://learn.chatgpt.com/docs/app-server), [Goals 동작 설명](https://developers.openai.com/cookbook/examples/codex/using_goals_in_codex).

## 제품 구현에서 선택한 실행 경계

사용자는 같은 대화창에서 목표, 완료 기준과 허용 범위를 정하고 진행·일시정지·재개를 확인한다. Main이 필요한 개선점을 조사하고 기존 Codex/Claude Owner에게 배정한다. Owner 완료와 직접 요구 변경을 반영하고 정확한 커밋 검증·통합까지 이어간다.

네이티브 Codex Goals는 활성화 자체로 다음 턴을 시작한다. 이를 기존 관리 서비스의 Main 재개 큐와 동시에 활성화하면 입력 경쟁이 생길 수 있다. 제품은 provider 공통 관리 큐를 단일 실행 주체로 사용하고, 기존 Main의 정식 `thread.turn.start` 흐름을 재사용한다. Codex 전용 목표 API를 제품에서 활성화하거나 Claude에 흉내 내어 호출하지 않는다.

SQLite 목표 상태, 실제 Owner 완료 이벤트, Main의 구조화된 진행 보고와 Git 검증 결과를 결합한다. 독립적인 Owner 목표 루프는 켜지 않는다. Codex 네이티브 토큰 예산으로 Claude나 모든 Owner 비용까지 제한한다고 표시하지 않는다. 외부 dots 연결은 구현 범위에서 제외했다.
