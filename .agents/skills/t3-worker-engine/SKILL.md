---
name: t3-worker-engine
description: T3 작업자 엔진(`t3 worker` CLI 및 영속 메일박스 · 작업 ID 펜싱 · 5분 하트비트 · worktree diff→merge/discard 수명주기 · 결정 관문)을 호출·감독할 때 사용한다.
---

# T3 작업자 엔진 운영 스킬 (`t3 worker`)

## 언제 사용하나

- 병렬 하위 AI 작업자(Codex · Claude · Gemini/Antigravity · OpenCode)를 격리된 worktree에서 실행하고 결과를 유실 없이 회수할 때
- 외부 오케스트레이터(예: `personal-rl-agent`)나 감독 에이전트가 T3 작업자 엔진에 작업을 배정·확인·승인·병합할 때

## 핵심 규칙

1. **단기 분할 대기 (최대 120초)**: `check --wait --timeout-sec`은 **120초**를 넘기지 않는다(엔진이 자동 클램핑). 대기 중 15초마다 `stderr`로 `{"_keepalive":true,"_heartbeat":true,...}`가 출력되며 `stdout`은 최종 JSON만 유지한다.
2. **명시적 ACK**: `check`가 반환한 `deliveryId`를 처리한 뒤 반드시 `ack --delivery <deliveryId>`를 호출한다. 미확인(`outstanding`) 배달은 크래시·재시작 후 다음 `check`에서 동일 `deliveryId`로 재전달된다.
3. **중복 실행 방지**: 같은 스레드에서 동일한 `(role, target, model, spec, cwd)` 작업은 DB 유니크 인덱스로 자동 합류(`deduplicated: true`)된다. 재시도는 반드시 `--retry-of <dispatchId>`를 사용한다(연속 3회 실패 시 서킷 브레이커 작동).
4. **Worktree 선검토 후정리**: 쓰기 역할(`worker`, `writer`)은 기본 `isolated` worktree(`t3code/worker-<id>`)에서 실행되며 완료 후 삭제되지 않고 `review_ready`로 보존된다. 반드시 `worktree diff`를 확인한 뒤 `worktree merge` 또는 `worktree discard`로 정리한다.
5. **위험 작업 결정 관문**: 파괴적 변경·승인 필요 작업은 `--require-approval` 또는 `gate create`로 `blocked` 전환 후 사용자 승인(`gate resolve --decision approve|deny`)을 받는다.

## 표준 CLI 명령 (`--json` 권장)

```bash
# 1. 상태 확인
node apps/server/dist/bin.mjs worker status --thread <threadId> --json

# 2. 작업 배정 (쓰기 역할은 기본 isolated worktree)
node apps/server/dist/bin.mjs worker dispatch \
  --thread <threadId> \
  --run <runId> \
  --role worker \
  --target codex \
  --cwd <repoPath> \
  --worktree isolated \
  --spec "<작업 지시>" \
  --json

# 3. 메일박스 대기 확인 (최대 120초, 15초 stderr keepalive)
node apps/server/dist/bin.mjs worker check \
  --run <runId> \
  --wait \
  --timeout-sec 110 \
  --types worker_done,question,escalation,decision_gate,merge_ready \
  --json

# 4. 배달 확인 완료 표시
node apps/server/dist/bin.mjs worker ack --delivery <deliveryId> --json

# 5. Worktree diff 검토 후 병합 또는 폐기
node apps/server/dist/bin.mjs worker worktree diff --task <taskId> --json
node apps/server/dist/bin.mjs worker worktree merge --task <taskId> --json
# 또는: node apps/server/dist/bin.mjs worker worktree discard --task <taskId> --json

# 6. 결정 관문 조회 · 승인/거절 / 작업자 중단
node apps/server/dist/bin.mjs worker gate list --status open --json
node apps/server/dist/bin.mjs worker gate resolve --gate <gateId> --decision approve --reason "검토 완료" --json
node apps/server/dist/bin.mjs worker stop --dispatch <dispatchId> --reason "사용자 취소" --json
```
