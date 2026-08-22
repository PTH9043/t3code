# 모니터링 모드 — 남은 일 (2026-08-21 밤, 자고 일어나서 볼 것)

> 상태 (2026-08-22 갱신): 아래 1·2·3절은 모두 처리됨 — 3분할 커밋(`96409201b` perf, `7372099a3` 모니터링, `8108f85ab` 회의 후속), 남은 구현 3건(`8bcafb2dc`), 기존 버그 2건(`11cce4491`, `840e8512a`), 렌더러 프로파일·수정(`689e7dbe2`). 남은 것: `monitor-test` 프로젝트 삭제(UI에서), 자체 감시 수신 프로젝트 변경(사용자가 "삭제만" 선택 — 수신은 그대로).

## 1. 먼저 결정할 것

- [x] **커밋 여부** — `git status`에 모니터링 변경분 + 오늘 아침 `subscribeWorkspaceRuntime` 성능 수정 + 기존 작업이 섞여 있음. 커밋하려면 덩어리 셋으로 나누는 게 좋음: ① 성능 수정(ws.ts / ProjectionSnapshotQuery / RepositoryIdentityResolver / ChatView selector) ② 모니터링 모드 ③ 그 전의 회의 모드 작업.
- [ ] **테스트 프로젝트 정리** (남음) — `monitor-test`(C:\Users\Public\monitor-test)가 실제 T3 데이터에 등록돼 있고 모니터링 ON·2판 계획 승인·자체 감시 수신 중. 남겨두면 이상 없을 땐 턴을 안 쓰지만, 앱을 재시작할 때마다 프로그램이 죽어 health 이상 1건(예산 1턴)이 나감. 지우려면: 제어센터에서 프로젝트 삭제 → 폴더 삭제.
- [ ] **자체 감시 수신 프로젝트** (사용자 결정: 일단 그대로) — 지금은 `monitor-test`가 받고 있음(설정 → 권한 → T3 Code 자체 감시). 실제 쓸 프로젝트(`__OnChainBot` 등)로 바꾸고 그 프로젝트에서 모니터링 ON + 다시 분석.

## 2. 남은 구현 (작은 것부터)

- [x] **`process` 대상 실제 수집** — 지금은 텔레메트리 사이드카가 추적하는 트리(서버가 띄운 프로그램 + Electron) 안의 PID만 읽힘. 트리 밖 PID는 `ResourceTelemetry`에 `setExternalProcesses`를 **가산** 방식으로 노출해야 함. 현재 유일 호출자(`apps/server/src/resourceTelemetry/*`, Electron PID)가 교체 방식이라 Electron PID를 떨어뜨리지 않게 merge 필요. 등록 전 `validateProcessIdentity({pid, startTimeMs})`로 확인. 끄면 Electron 전용으로 복귀.
- [x] **장애에 "실패 사유" 붙이기** — 헬스체크 실패가 타임아웃인지 연결 거부인지 `WorkspaceIncident`/run에 남기면 "감시 서버 자체가 느려서 난 오탐"을 AI가 가설이 아니라 사실로 판정할 수 있음. 오늘 22:10에 실제로 이 오탐이 1건 있었음(dev 빌드 버스트로 이벤트 루프 5초+ 정지 → 프로그램 헬스 3회 실패로 기록).
- [x] **헬스 프로브 타임아웃 재고** (기본 10초 + 감시 서버 정지 시 `inconclusive` 보류) — 위와 같은 맥락. 기본 5초가 개발 머신 빌드 중엔 짧음. 프로그램별 설정은 이미 있으니(`healthCheck.timeoutSeconds`) 기본값만 올리거나, 감시 서버 이벤트 루프 p99가 높을 때는 그 창의 헬스 실패를 보류하는 게 더 근본적.

## 3. 오늘 발견한 기존 버그 (모니터링과 무관, 별도 이슈)

- [x] **질문 대기 중 앱 재시작 → 턴이 "작업 중"에 영구히 갇힘.** `SessionRecoveryReactor`가 턴을 복구하지만 제공자에겐 그 `user-input` 요청이 없어서(`Unknown pending user-input request`) 답할 수도, 중지(인터럽트)도 안 됨. 재현: AI가 질문 띄운 상태에서 서버 빌드 → 앱 재시작. 우회: 스레드 삭제. 고칠 곳: 복구 시 pending user-input이 있으면 턴을 interrupted로 정착시키거나 질문을 다시 띄우기.
- [x] **`dev-electron.mjs` 파일 감시가 `server/dist/bin.mjs` 변경을 종종 놓침** (오늘 2회). 빌드 후 앱이 재시작 안 하면 `apps/desktop/dist-electron/main.cjs`를 touch하면 됨. `fs.watch` → mtime 폴링 병행이 간단한 해법.
- [x] **Chrome에서 제어센터 페이지 스크린샷(CDP)이 자주 타임아웃** — 렌더러가 무거운 듯. 사용자 체감 렉과 관련 있을 수 있으니 한 번은 프로파일 볼 가치 있음(`T3CODE_DESKTOP_REMOTE_DEBUGGING_PORT`로 띄워서).

## 4. 운영 메모

- 서버 리빌드 = 앱 재시작 = **서버가 띄운 프로그램 전부 종료** → 모니터링이 바로 health 이상 1건 보고(예산 1턴). 개발 중엔 테스트 프로젝트 모니터링을 끄고 작업하는 게 조용함.
- `packages/contracts`·`client-runtime` 수정도 데스크톱 메인 번들 리빌드로 앱이 재시작됨. 한꺼번에 고치고 한 번만 빌드.
- 예산 시간당 상한 12, 일당 60(코드 상수). 테스트 프로젝트는 현재 8/24.
- 같은 이상 재보고 쿨다운 30분(지표 창이 더 길면 그 길이).
- 문서: `docs/user/program-monitoring.md`, `docs/internals/workspace-monitoring.md`, 용어집. 메모리: `program-monitoring-mode.md`, `desktop-dev-launch.md`.

## 5. 검증 상태 (참고)

- 타입체크 전체 0 에러(모바일 포함). 서버 orchestration+diagnostics+observability 450 passed, 웹 111, contracts 234, client-runtime 589.
- `server.test.ts`의 `subscribeServerConfig`·`terminal methods` 2건은 **내 변경 전부터 실패** (stash로 확인).
- 라이브로 닫은 루프: 켜기 → 계획 제안 → 승인(웹 배너/제어센터) → kill → 장애=health 초과 → 발견 턴 → AI 질문 → 답 → 행동 블록 → 서버가 `restart-program` 실행 → 복구. 예산 보류, 스레드 삭제→재생성, 끄기→텔레메트리 해제, 자체 감시 p99 273ms 발화, 2판 계획(self-server 포함) 승인까지 확인.
