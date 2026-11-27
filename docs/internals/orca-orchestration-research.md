# Orca 오케스트레이션 소스 분석 및 T3 작업자 엔진 매핑 보고서 (Stage 1)

> **문서 목적**: `github.com/stablyai/orca`의 오케스트레이션 핵심 설계를 실제 소스 코드 수준에서 분석해, Orca 앱을 설치하지 않고 T3 네이티브 기능(**T3 작업자 엔진**, `apps/server/src/t3x/workerEngine/` + `Migration 109` + `t3 worker` CLI)으로 이식할 설계 기준선과 채택·비채택 경계를 확정한다.

---

## 1. 고정 기준점 및 라이선스 준수

| 항목                     | 실사 확인값                                                                                                                                             |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **대상 저장소**          | `https://github.com/stablyai/orca` (문서: `https://orca.dev/docs/cli/orchestration`)                                                                    |
| **기준 릴리스 태그**     | **`v1.4.270`** (`2026-11-22T11:24:52Z`)                                                                                                                 |
| **기준 `main` 커밋 SHA** | **`22ad3bbe244a0f61bc403d83aae03b68f58c1264`** (`2026-11-22T11:09:44Z`)                                                                                 |
| **SQLite 스키마 버전**   | `SCHEMA_VERSION = 50` (`src/main/runtime/orchestration/db/contract-constants.ts`)                                                                       |
| **라이선스**             | **MIT License — `Copyright (c) 2026 Lovecast Inc.`**                                                                                                    |
| **저작권 보존 원칙**     | 설계 참조뿐 아니라 소형 코드 조각(`check-keepalive.ts` 등)을 이식할 때 해당 파일 상단과 `THIRD_PARTY_NOTICES`에 아래 MIT 라이선스 고지를 원문 보존한다. |

```text
MIT License

Copyright (c) 2026 Lovecast Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.
```

---

## 2. Orca 6대 핵심 메커니즘 실사 분석

### 2.1 메일박스 & 배달 ACK (`messages` · `deliveries` · `consumer_generation` 펜싱)

- **원본 파일**:
  - `src/main/runtime/orchestration/db/schema/create-core-tables-sql.ts`
  - `src/main/runtime/orchestration/db/messages/mail-taker.ts`
  - `src/main/runtime/orchestration/db/messages/mailbox-delivery-finalization.ts`
- **핵심 스키마**:
  - `runs(id, objective, coordinator_handle, consumer_generation, created_at, updated_at)`
  - `messages(id, run_id, delivery_contract, from_handle, to_handle, subject, body, type, priority, thread_id, payload, read, sequence AUTOINCREMENT, created_at, delivered_at)`
    - 메시지 유형(`CHECK`): `'status' | 'dispatch' | 'worker_done' | 'merge_ready' | 'escalation' | 'handoff' | 'decision_gate' | 'question' | 'heartbeat'`
  - `deliveries(id, run_id, mailbox_handle, consumer_generation, message_ids, status, created_at, acknowledged_at)`
    - 배달 상태(`CHECK`): `'outstanding' | 'acknowledged' | 'fenced'`
- **작동 원리**:
  1. `sequence INTEGER PRIMARY KEY AUTOINCREMENT` 기반 엄격한 **FIFO 순서** 보장.
  2. 감독이 `check`로 미확인 메일을 가져가면 `deliveries` 행(`status='outstanding'`, `message_ids` JSON 배열)을 생성한다.
  3. **재전달 보장**: 감독이 응답을 처리하기 전에 크래시하거나 서버가 재시작되면 `acknowledged`되지 않은 `outstanding` 배달이 DB에 그대로 남아 다음 `check` 시 동일 `delivery_id`로 재전달된다.
  4. **소비자 펜싱(`consumer_generation`)**: `finalizeMailboxDelivery`는 단일 쓰기 트랜잭션 안에서 `raw.consumer_generation === params.consumerGeneration`과 `raw.status !== 'fenced'`를 검사한다. 세대가 바뀐 구 소비자의 ACK는 `consumer_fenced` 오류로 거부한다.
  5. `--peek` / `--all`은 소비하지 않으며 `delivery_id`를 발급하지 않는다.

### 2.2 작업 ID · 디스패치 생명주기 · 멱등성 & 서킷 브레이커

- **원본 파일**:
  - `src/main/runtime/orchestration/db/schema/create-graph-tables-sql.ts`
  - `src/main/runtime/orchestration/db/tasks/task-start-claim.ts`
  - `src/main/runtime/orchestration/db/dispatch-context/dispatch-completion.ts`
- **핵심 스키마**:
  - `tasks(id, run_id, parent_id, task_title, spec, status, deps, result, created_at, completed_at)`
    - 상태: `'pending' | 'ready' | 'dispatched' | 'completed' | 'failed' | 'blocked'`
  - `dispatch_contexts(id, run_id, task_id, retry_of_dispatch_id, creator_dispatch_id, status, failure_count, last_failure, termination_reason, depth, consumer_generation, dispatched_at, completed_at, last_heartbeat_at)`
    - 상태: `'pending' | 'dispatched' | 'completed' | 'failed' | 'circuit_broken'`
  - `worker_dispatches(dispatch_id, runtime_epoch, state, stage, worktree_id, agent_terminal_handle, setup_state, last_error)`
    - 상태: `'starting' | 'ready' | 'start_unknown' | 'failed' | 'succeeded' | 'stopping' | 'stop_unknown' | 'stopped' | 'abandoned'`
  - `mutation_receipts(caller_fingerprint, request_id, method, payload_hash, state, receipt)` — 명령 멱등성 영수증.
- **작동 원리**:
  1. **Run → Task → Dispatch 3계층 분리**: 작업 정의(`Task`)와 개별 실행 시도(`Dispatch`)를 분리해, 재시도(`--retry-of <dispatchId>`)마다 새 `dispatch_id`를 발급한다.
  2. **완료 권한 검증**: `worker_done`은 `(taskId, dispatchId)`가 해당 `Task`의 현재 활성 `Dispatch`와 일치할 때만 수락하며(`SAVEPOINT complete_dispatch_transition`), 오래된 재시도가 완료 상태를 덮어쓰지 못하게 차단한다.
  3. **서킷 브레이커(`circuit_broken`)**: `claimTaskForStart`가 직전 디스패치의 `status === 'circuit_broken'`을 확인하면 무한 재시도를 거부하고 실패 횟수·마지막 오류를 사용자에게 보고하도록 강제한다.

### 2.3 2계층 하트비트 & 15초 CLI Keepalive

- **원본 파일**:
  - `src/cli/orchestration/messages/check-keepalive.ts` (34줄 — MIT 귀속 소형 이식 대상)
  - `src/main/runtime/orchestration/workers/lifecycle/session-worker-liveness.ts`
  - `dispatch_contexts.last_heartbeat_at`
- **작동 원리**:
  1. **CLI 대기 Keepalive (`check-keepalive.ts`)**: `--wait` 대기 중 기본 **`15,000ms`(15초)** 간격(환경 변수로 테스트 단축 가능)으로 **`stderr`**에 `{"_keepalive":true,"_heartbeat":true,"elapsedMs":...,"deadlineMs":...}\n`를 출력한다. `interval.unref()`로 프로세스 종료를 막지 않으며 **`stdout`은 최종 JSON 결과만 유지**해 파서 오염을 방지한다.
  2. **작업자 활성 감시**: `dispatch_contexts.last_heartbeat_at`과 런타임 세션 관찰자(`createDispatchSessionLivenessReader`)로 `live | exited | unverifiable` 상태를 판별해 멈춘(stalled) 작업자를 탐지하고 감독에게 `escalation` 메일을 발행한다.

### 2.4 결정 관문 (Decision Gate)

- **원본 파일**:
  - `src/main/runtime/orchestration/db/decision-gates/decision-gate-store.ts`
  - `src/main/runtime/orchestration/db/schema/create-graph-tables-sql.ts` (`decision_gates`)
  - `src/cli/orchestration/gates/gate-handlers.ts`
- **핵심 스키마**:
  - `decision_gates(id, run_id, task_id, question, options, status, resolution, created_at, resolved_at)`
    - 상태: `'pending' | 'resolved' | 'timeout'`
- **작동 원리**:
  1. `SAVEPOINT create_gate` 트랜잭션 안에서 ① 작업 존재 확인, ② 요청자가 해당 `Task`의 활성 `Dispatch` 소유자인지 검증(`consumer_fenced`), ③ 감독형 워커가 아직 살아 있으면 먼저 정지/정산하도록 강제(`task_not_startable`), ④ `decision_gates` 삽입 + `Task`를 `blocked` 전이한다.
  2. 사용자·감독이 `gate-resolve --id <gateId> --resolution "..."`를 호출하면 `status='resolved'` 기록 후 `Task`를 재개 가능 상태로 돌리고 메일박스에 결과를 전달한다.

### 2.5 Worktree 격리 및 명시적 수명주기

- **원본 파일**:
  - `docs/site/content/docs/cli/orchestration.mdx`
  - `src/main/runtime/orchestration/db/schema/create-core-tables-sql.ts` (`worker_terminal_resources`)
- **작동 원리**:
  - `worker-start --worktree new-child --name <slug> --agent <id> --setup run`으로 작업별 독립 git worktree를 생성한다.
  - 작업이 `worker_done`을 보고해도 즉시 worktree를 삭제하지 않고 브랜치·산출물을 보존한 뒤, 감독이 diff·산출물을 확인하고 명시적으로 `release`·병합·폐기 결정을 내린 뒤에 정리한다.
  - `--retry-of <dispatchId>`는 이전 배치를 암묵 상속하지 않고 worktree/대상 명시를 강제해 사고를 막는다.

### 2.6 CLI 명령 구조 및 출력 계약

- **원본 파일**:
  - `src/cli/orchestration/orchestration-handlers.ts`
  - `docs/site/content/docs/cli/orchestration.mdx`
- **출력 계약**:
  - 기본 출력: 짧은 요약(ID·현재 상태·다음 명령 안내).
  - `--json`: 단일 라인 JSON `{"ok":true,"result":{...}}`.
  - 실패 시: 비정상 종료 코드 + `stderr`에 `error: <code>: <message>`.
  - `worker_done`은 반드시 `--outcome succeeded|failed`와 `--task-id`, `--dispatch-id`, `--body`, `--files-modified`를 포함한다.

---

## 3. T3 작업자 엔진(`Migration 109` + `t3x/workerEngine/`) 1:1 매핑표

| 해결 대상 문제 (T3 & `personal-rl-agent`)                                          | Orca 메커니즘                                                            | T3 네이티브 구현 설계                                                                                                                                                                                                                                                                                                              |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workspaceDelegate.ts` 재시작 시 위임 결과 유실(12건 중 ~3건만 전달)               | `messages` + `deliveries` + 명시적 `ack`                                 | `Migration 109` (`worker_mailbox_messages`, `worker_mailbox_deliveries`) + Effect `WorkerMailboxService`. 미확인 `outstanding` 배달은 재시작 후 재조회 시 100% 재전달. 실행 중이던 디스패치는 부팅 시 `interrupted_by_restart` + `escalation` 메일 발행.                                                                           |
| 동일 조사 3회 중복 실행 & 오래된 재시도 덮어쓰기                                   | `tasks` + `dispatch_contexts` + `mutation_receipts` + 활성 디스패치 검증 | `worker_tasks`에 `dedup_key` 부분 유니크 인덱스(`status IN ('pending','ready','dispatched','blocked')`), `idempotency_key` 유니크 제약, 단조 증가 `fencing_epoch`/`fencing_token` 검증.                                                                                                                                            |
| 고아/멈춘 하위 에이전트(12~20분) 미감지                                            | `last_heartbeat_at` + 5분 하트비트 + 15초 CLI `stderr` keepalive         | `WorkerHeartbeatMonitor`: `WorkspaceAgentExecutor` 이벤트 스트림으로 30초 디바운스 DB 하트비트 기록, 5분 무신호 시 `stalled` + `escalation` 메일 발행, 15분/역할별 wall-time 초과 시 안전 중단. CLI `--wait` 중 15초 `stderr` keepalive(`check-keepalive.ts` MIT 귀속).                                                            |
| `DELEGATE_WAIT` 4분 vs Antigravity MCP 180초 끊김 & 일괄 대기 실패                 | 짧은 분할 `check --wait` + 개별 항목 조회                                | 대기 상한 **`120초`**(`WORKER_ENGINE_MAX_WAIT_SECONDS = 120`, 10~120초 클램핑) + `DELEGATE_MAX_RUNNING = 6` 단일 상수 공유 + 일괄 대기 항목별 부분 결과 반환 유지.                                                                                                                                                                 |
| 호출자 cwd 직접 실행 및 `fleet_cli.py` worktree 즉시 삭제                          | `--worktree new-child` + 완료 후 보존 + 명시적 release                   | `WorkerWorktreeLifecycle` + 기존 `WorktreeProvisionService`: 쓰기 역할 기본 `isolated` worktree 생성(`t3code/worker-<taskId8>`), 완료 시 삭제하지 않고 `review_ready` + `merge_ready` 메일 발행 → `diff` 검토 후 `merge` 또는 `discard` 시점에만 삭제.                                                                             |
| 위험 작업 사전 승인 부재                                                           | `decision_gates` (`SAVEPOINT`, `blocked` 전이)                           | `WorkerDecisionGateService` + `worker_decision_gates` 테이블 + T3 기존 `HostApprovalGate` 감사 해시체인 연동.                                                                                                                                                                                                                      |
| 외부 프로그램(`personal-rl-agent`) 호출·다중 드라이버·`convene_fleet_council` 누락 | `orca orchestration` JSON CLI                                            | `apps/server/src/cli/worker.ts` (`t3 worker status/dispatch/check/ack/stop/gate/worktree --json`) + `.agents/skills/t3-worker-engine/SKILL.md` + `T3WorkerDriver`(Codex·Claude·Gemini·DeepSeek 전수 지원, 110초 단기 대기 + 메일박스 이어받기, `convene_fleet_council` 병렬 디스패치, 장애 시 `CodexWorktreeCliDriver` 최종 폴백). |
| 위임·오케스트라·Council·`fleet_cli.py` 중복 & 스팬 속성 연결                       | 단일 엔진 + 스팬 상관관계                                                | `WorkerEngineService`를 단일 실행 백엔드로 두고 Strangler Fig 순서(`tester` 파일럿 → `workspaceDelegate` 전면 → `CouncilOrchestrator` → `WorkspaceCollaborationReactor`)로 이관. 모든 실행을 `UnifiedExecutionLedger` (`Migration 108`) + OTel 스팬(`t3.thread_id`, `t3.turn_id`, `t3.task_id`, `t3.dispatch_id`)에 연결.          |

---

## 4. 채택 vs 비채택 경계 (과도 설계 방지)

| 구분                           | 항목                                                                                                                                                                                                                                                                                                                                                                                                                | 사유                                                                                                                                                                                                           |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **채택 (설계/소형 코드 이식)** | ① SQLite FIFO 메일박스 + `delivery_id` ACK + `consumer_generation` 펜싱<br/>② `Task`–`Dispatch` 분리 + `dedup_key`/멱등 키 + `fencing_token` + 서킷 브레이커<br/>③ 5분 작업자 하트비트 + 15초 CLI `stderr` keepalive(`check-keepalive.ts` MIT)<br/>④ `SAVEPOINT` 결정 관문(`decision_gates`)<br/>⑤ Worktree 완료 후 보존 → `diff → merge/discard` 수명주기<br/>⑥ `--json` 단일 라인 + 비정상 종료 `stderr` CLI 계약 | T3와 `personal-rl-agent`의 실측 장애 11건을 직접 해결하며 Effect 4 + SQLite 구조에 자연스럽게 맞물림.                                                                                                          |
| **비채택 (이식 금지)**         | ① SSH 원격 페더레이션(`federated_dispatches`, `remote_dispatch_attachments`, `federation_relay_items`)<br/>② 터미널 PTY 포인터 입력 주입(`pointer_enter_pending`, `pointer_pty_id`, `worker_terminal_resources`)<br/>③ 봇 커넥터(`bot_requests`, `bot_conversation_acts_for`)<br/>④ Orca 50단계 스키마 마이그레이션 및 556개 파일 통째 복사                                                                         | T3는 이미 Effect `WorkspaceAgentExecutor`로 CLI 스트림을 직접 제어하고, `UnifiedExecutionLedger`·`WorktreeProvisionService`·`CouncilOrchestrator`를 자체 보유하므로 통째 이식은 충돌과 유지보수 폭증을 유발함. |

---

## 5. 확정된 연계 결정사항 및 주간 업스트림 감시 체계

1. **나만의 AI 대화 화면 (옵션 A 확정)**: `personal-rl-agent`에 별도 대화 UI를 중복 개발하지 않고, Phase 4에서 로컬 루프백 OpenAI 호환 서버(`personal-orchestrator-4b`)로 T3에 모델 등록해 T3 대화 UI·기억 원본(`state.sqlite`)·Council 카드·worktree diff 검토·`/fix` 교정·사용량 집계를 그대로 재사용한다.
2. **규칙 단일 원본 (옵션 A 확정)**: T3 `AGENTS.md` 및 공용 스킬(`.agents/skills/`)을 단일 원본(SSOT)으로 유지하고, `personal-rl-agent`는 읽기 전용 동기화만 수행한다. `D:\___AIModel\personal-rl-agent\config\agent_tools.json` (`v1.0.0`)은 절대 수정하지 않는다.
3. **주간 Orca 업스트림 감시 (Stage 5)**:
   - 기준 매니페스트 `docs/operations/orca-upstream-manifest.json`에 기준 태그(`v1.4.270`)·SHA(`22ad3bbe244a0f61bc403d83aae03b68f58c1264`) 및 감시 경로(`src/main/runtime/orchestration/db/**`, `src/main/runtime/orchestration/workers/lifecycle/**`, `src/cli/orchestration/**`, `docs/site/content/docs/cli/orchestration.mdx`)를 고정한다.
   - `scripts/watch-orca-upstream.mjs`가 주 1회 GitHub API로 감시 경로 교집합 변경만 추출해 한국어 패치 제안서를 생성하고, **자동 반영 없이 사용자 승인 후에만 수동 포팅**한다.
