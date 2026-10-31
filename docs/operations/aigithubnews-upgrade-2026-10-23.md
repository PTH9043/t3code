# aigithubnews 첫 업데이트와 검증 기록

2026-10-23 사용자의 “별도 프로그램에서 테스트·수정 후 교체, 렌더링과 프로그램 오류 확인” 요청에 따라 진행했다. 운영 web/backend/desktop 전체를 기존 실행기로 교체 실행했고, 관리자 토큰·실제 창·렌더링·검색을 확인했다.

## 이번에 반영한 변경

| 확인한 문제                                                      | 반영한 동작                                                                                                                                                         | 근거                                                               |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| 설정한 `bge-m3:latest`가 Ollama에 없어 의미 검색이 대체됨        | 기존 선택 모델을 복구했다. CPU에서 한국어 입력의 1,024차원 임베딩을 확인했고 모델 설정을 바꾸지 않았다.                                                             | `embedding-restored.json`, `post-verification.json`                |
| 모델 미설치·연결 실패·시간 초과·잘못된 응답이 같은 문구로 표시됨 | 오류 종류를 구분한다. 키워드 결과를 보존하며 원격 이용자에게 서버의 모델을 준비해야 한다고 안내한다. 서버의 원시 오류 본문은 표시하지 않는다.                       | `OllamaEmbeddings.test.ts`, `ProjectionWorkspaceRag.test.ts`       |
| 의미 색인 0개인데도 hybrid로 표시됨                              | 준비된 의미 색인이 없으면 키워드 검색으로 표시한다. 준비 중인 상태와 실패 원인을 구분한다.                                                                          | 검색 통합 회귀 테스트                                              |
| 색인 실패 사유가 재시작 뒤 사라짐                                | 파생 색인 작업에 실패 분류를 저장한다. 기존 재시도 간격을 유지하고 정상 처리 후 실패 사유를 지운다.                                                                 | migration 76, 색인 재시도·새 service scope·기존 데이터 이전 테스트 |
| 연결 준비 전에 MCP catalog를 조회해 “연결되지 않음” 알림 발생    | 선택한 환경이 연결될 때까지 조회·수정을 기다린다. 연결이 바뀌면 이전 요청의 응답을 버리고 재연결 후 목록을 다시 읽는다. 실제 연결 후 발생하는 오류는 계속 표시한다. | `McpToolsSection.test.tsx`, 화면의 초기 오류 감시                  |

외부 코드나 새 프레임워크를 가져온 변경은 없다. 수집 목록의 [Ollama](https://github.com/ollama/ollama), 로컬 모델 준비 상태와 관측 관련 자료를 기존 T3 코드 및 실제 실패와 대조했다. 모델 API 형식은 [Ollama embedding 문서](https://docs.ollama.com/api/embed)와 [model pull 문서](https://docs.ollama.com/api/pull)를 확인했다.

## 분리 실행과 검사

- 후보 프로그램: `D:/__NewAutoUsage-aigithubnews-20261023`.
- 후보 데이터: 해당 폴더의 `.t3/runtime-data`. 운영 SQLite는 읽기 전용 연결에서 `VACUUM INTO`로 일관된 복사본을 만들었다. 복사 크기는 9,197,899,776바이트였다. 운영 DB를 테스트 서버에 연결하지 않았다.
- 후보 포트: backend 14915, web 6875. 동일한 `scripts/dev-runner.ts dev:desktop`으로 실행했다. 테스트 Electron 창은 숨기고 headless Chrome에서 화면을 검사했다.
- 서버 집중 테스트 7개 파일의 40개, 웹 MCP 연결 수명 테스트 1개 파일의 3개가 통과했다. 서버·웹 각각 `tsgo --noEmit`, 변경 파일 lint·format 검사가 통과했다. 저장소 전체 검사는 실행하지 않았다.
- 후보의 backend 제공 정적 화면과 Vite web에서 전체 현황·프로젝트 지식/RAG·설정을 확인했다. 1440×1000 6건과 390×844 3건이 통과했다. 한국어·영문 연구 자료 검색, 의미 색인 상태, 페이지 예외·콘솔 오류·실패 HTTP·가로 넘침·MCP 초기 오류 안내를 확인했다.
- 숨김 Electron의 DOM과 desktop bridge 로딩, 예외 0건을 확인했다. 숨김 창의 비트맵 캡처는 응답 제한을 넘겨 완료하지 못했다. 프런트엔드 그림은 headless로 검증하고 실제 운영 Electron 창의 픽셀 캡처를 별도로 확인했다. 숨김 창을 검사 목적으로 표시하거나 활성화하지 않았다.

주요 테스트는 모델 부재·잘못된 API 경로·응답 오류·연결 복구, 검색 deadline과 색인 대기, 실패 원인의 재시작 후 보존, 변경 중인 원문의 오래된 색인 방지, 프로젝트·폴더·제외 범위, 기존 작업 복구, MCP 초기 연결·재연결·실제 조회 실패를 포함한다.

## 운영 반영과 확인

2026-10-23 17:17 KST에 신원을 확인한 기존 런타임 구성 요소 15개를 종료하고 검증한 서버·테스트·사용자 문서 10개 파일을 반영했다. 다른 프로젝트 및 도구 프로세스 82개는 종료 대상으로 지정하지 않았다. 진행 중이던 대화 3개는 기존 시작 복구가 재개했고 이후 같은 thread ID와 오류 없는 세션 상태를 조회했다.

기존 `.t3/honey-upgrade-20261011/runtime.py start --production --mode dev:desktop`으로 시작했다. 실행한 사용자 토큰은 이미 High였으며 기존 관리자 로그인 예약 작업 설정을 변경하지 않았다. 데이터 홈 `E:/NewAutoUsage`, backend 13773, web 5733을 유지했다. migration 76의 정상 완료를 운영 로그에서 확인했다.

MCP 초기 연결 문제는 추가 화면 검사에서 발견해 후보 앱에서 수정했다. 연결 테스트 3개와 후보 화면 9건을 통과한 뒤 웹 소스·테스트 2개 및 새 정적 자산 17개를 추가 반영했다. Vite HMR과 정적 자산 선배치·`index.html` 마지막 교체를 사용했다. 이 화면 반영에서는 서버를 다시 종료하지 않았다. 공개 빌드 설정이 운영과 같고 테스트 포트가 정적 JS·HTML에 들어 있지 않은지 대조했다.

최종 운영 화면도 1440×1000 6건과 390×844 3건을 통과했다. 감시한 페이지 예외·콘솔 오류·실패한 HTTP 요청·MCP 초기 알림·가로 넘침은 0건이었다. 실제 Electron은 보이는 정상 창이며 최소화되지 않았고 이미지에서 내용이 렌더링된 것을 확인했다. 메인 Electron과 backend 프로세스의 무결성 수준을 각각 High(12288)로 읽었다. 초기 운영 로그의 `main window shown without activation`과 최초 확인의 비활성 창 상태를 확인했다. 창 검사에는 입력·포커스 변경 API를 사용하지 않았다.

서버 설정의 전후 SHA-256은 `2178a404a4180bca63f9c768d71550dd264119f9c5871c5fbc019143ac257798`로 같았다. 프로젝트별 사용자 구성도 같았다. 진행 중인 모니터링의 실행 시각과 실행 이력만 정상 갱신됐다. 복구한 대화의 현재 권한·상호작용 모드도 확인했다.

운영 RAG 확인 시 기존 프로젝트의 의미 색인 1,382/1,382개가 준비됐고 hybrid 검색으로 8개 결과를 반환했다. 이 수는 기존 프로젝트 기억의 청크 수이며 수집 GitHub 저장소 수와 다르다. 뒤에 저장하는 이번 검토·업데이트 기록은 새 자료로 색인된다.

## 전체 학습 계획의 진행 상태

수집 주소 8,682개와 검토 단위 8,578개는 계속 전부 대상이다. 기존 README 검토 35개를 구조화했고 별도의 100개에 발췌 선별 기록을 추가했다. 선별 결과는 실험 후보 24개·참고 62개·보류 14개이며 초기 자동 분류 22개를 수정 제안했다. README가 없는 표본 1개도 원문 확보 과제로 남겼다. [표본별 판단](../internals/aigithubnews-pilot-screening-2026-10-23.md)을 참고한다.

전체 상세 내용 검토 미완료는 8,543개다. 100개 발췌 선별을 전체 README·소스·실험 검토로 집계하지 않는다. 처리량 측정과 나머지 전체 검토·실험·개발 과제는 [전체 계획표](../internals/aigithubnews-execution-schedule-2026-10-23.md)에 남겨 두었다. 현재 재현된 운영 결함을 먼저 수정한 것이며 전체 후보를 기존 35개로 제한한 결정이 아니다.

한국어 120문항의 품질·holdout 평가, Recall@5·토큰 절감·P95 비교와 분야별 소스 실험은 아직 수행하지 않았다. 네이티브 iOS/Android, 실제 원격·relay 연결, 모든 provider의 새 턴 실행을 이 기록의 검증 범위로 표시하지 않는다. 이번에는 공통 검색 응답과 웹·데스크톱 MCP 화면을 변경했으며 provider 어댑터와 wire contract는 변경하지 않았다. 기존 대용량 번들·source map·Node deprecation 경고는 빌드 로그에 남아 있다.

## 증거와 되돌리기 자료

증거 폴더는 `D:/__NewAutoUsage/.t3/aigithubnews-upgrade-20261023/`다.

- `source-baseline.json`, `candidate.json`: 후보의 기준 소스와 분리 복사 기록.
- `promotion.json`, `backups/`: 첫 반영 파일의 이전·검증 SHA-256, 종료 대상의 PID·생성 시각·명령, 이전 파일.
- `frontend-promotion.json`, `frontend-backups/`: 추가 화면 반영·이전 파일·정적 자산 기록.
- `embedding-restored.json`: 설치 전후 모델 목록과 CPU 한국어 embedding probe.
- `candidate-rendering.json`, `candidate-narrow-rendering.json`: 최종 후보 화면 9건.
- `production-rendering.json`, `production-narrow-rendering.json`: 최종 운영 화면 9건.
- `candidate-electron-dom.json`, `production-visible-proof.json`, `production-window.png`, `backend-token-proof.json`: DOM·실제 창·렌더링·권한 확인.
- `post-verification.json`, `public-config-proof.json`: 설정·현재 세션·검색·공개 빌드 설정 대조.
- `pilot-screening.json`, `review-progress.json`: 발췌 선별과 상세 검토 상태.

되돌릴 때도 현재 실행의 신원과 최신 변경을 먼저 대조한다. migration 76은 파생 작업 테이블의 nullable 열 추가이므로 사용자 대화·원문을 되돌리거나 삭제하지 않는다. 이전 논리로 복구할 때도 이 migration 등록은 유지해 기존 운영 DB의 최신 migration 이력과 맞춘다.
