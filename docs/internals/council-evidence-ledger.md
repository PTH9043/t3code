# 다자간 위원회 · 코드 근거 원장 · PinnedSpec 아키텍처

본 문서는 모델-불가지론적 다자간 위원회(`council`), Append-Only 코드 근거 원장(`EvidenceLedger`), 아첨/동조 방어(Flip-Test), 그리고 기존 `PinnedSpecGate` 및 `WorktreeProvisionService`와의 통합 구조를 설명합니다.

## 1. 모듈 구성

- **계약 (`@t3tools/contracts`)**
  - `packages/contracts/src/council.ts`: `ModelTargetRef`, `SubordinateCapabilityTag`, `CouncilRoleArchetype`, `CouncilSeatAssignment`, `EvidenceLedgerEntry`, `CouncilClaimNode`, `CouncilPinnedSpec`, `CouncilSessionSnapshot`, `COUNCIL_WS_METHODS`(9종 RPC).
  - `packages/contracts/src/threadModelTeam.ts`: `ThreadTeamMember`에 역호환 optional 필드(`enabled?`, `capabilities?`, `councilRoleOverride?`) 확장.
  - `packages/contracts/src/rpc.ts` & `apps/server/src/auth/RpcAuthorization.ts`: `WsRpcGroup` 및 스코프 매핑 등록.
- **영속성 (`state.sqlite` WAL, Migration 107)**
  - `apps/server/src/persistence/Migrations/107_CouncilEvidenceLedger.ts`: `council_sessions`, `council_evidence_ledger`, `council_claims`, `council_pinned_specs` 4개 테이블 및 인덱스 4종.
  - `apps/server/src/persistence/CouncilStore.ts`: CRUD, `idempotency_key` UNIQUE 멱등 잠금, 재시작 시 `closeStaleCouncilSessions` → `INTERRUPTED_BY_RESTART`.
- **오케스트레이션 엔진 (`apps/server/src/orchestration/council/`)**
  - `CouncilTriage.ts`: 0ms 결정론적 복잡도/위험도 점수기.
  - `DynamicCouncilRoster.ts`: `resolveDynamicCouncilRoster` — 가변 `0..N` 슬롯 스케일링, `CONTRARIAN_RED` 최우선 배정, 동종 모델 샤드·온도 다양화, `ProviderRegistry` 스냅샷+최근 429 기반 폴백 치환.
  - `CouncilEvidenceVerifier.ts`: Boundary 1 — 경로 탈출/심볼릭 링크 이탈 차단, UTF-8 라인 SHA-256 검증, `CodeGraphIndex` AST 심볼 위치 교차 검증, CAS 해시 대조.
  - `CouncilAntiSycophancy.ts`: Boundary 2 — HMAC-SHA256 `Proposal-1..M` 익명 순열, 자가 모델명 스크러빙, `enforceEvidenceGatedFlipRule`, Claim DAG 사이클 검출, Subjective Logic `ω=(b,d,u,a)`, P0 미해결 판정.
  - `CouncilExecutionBridge.ts`: Boundary 3 — `electOptimalExecutionWorkerChain`, 기존 `PinnedSpecGate.pinTaskSpec` 1:1 동시 등록, CAS 보호 실행, `runDeterministicVerifier`(`execFile` 직접 실행), 독립 Checker Zero Self-Approval(`submitIndependentCheckerVerdict` → `evaluateSpecCompletionGate`).
  - `CouncilOrchestrator.ts` & `CouncilOrchestratorLive.ts`: 7단계 결정론적 FSM, `ActiveWorkTracker` 등록/해제, `PubSub` 실시간 스트림 발행.
- **웹 UI (`apps/web/src/components/council/`)**
  - `ThreadCouncilDock.tsx`, `ChatCouncilStrip.tsx`, `CouncilPinnedSpecCard.tsx`, `CouncilEvidenceDrawer.tsx`: 100% T3 시맨틱 토큰(6종 테마 대비비 준수), 기존 `ChatView`·`MeetingModePanel`·`ThreadModelTeamSettings` 연동.

## 2. 기존 시스템과의 공존 원칙

- 기존 `apps/server/src/orchestration/workspaceMeeting.ts`(947줄)와 `WorkspaceCollaborationReactor.ts`의 오케스트라 회의 경로는 변경하지 않아 회귀 위험을 제거했습니다.
- `council_pinned_specs`는 기존 Migration 104 `pinned_task_specs`/`pinned_spec_verdicts`/`host_audit_chain`에 1:1 기록되어 Zero Self-Approval과 해시 체인 감사를 공유합니다.
