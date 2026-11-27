// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFs from "node:fs/promises";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";
import {
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ModelTargetRef,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Tracer from "effect/Tracer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { expect, it } from "@effect/vitest";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { makeCouncilStore } from "../../persistence/CouncilStore.ts";
import { activeWorkRegistry } from "../ActiveWorkTracker.ts";
import { verifyHostAuditChain } from "../HostApprovalGate.ts";
import { makeCouncilOrchestrator } from "./CouncilOrchestrator.ts";

function makeTarget(instanceId: string, driverId: string, modelId: string): ModelTargetRef {
  return {
    providerInstanceId: ProviderInstanceId.make(instanceId),
    driverId: ProviderDriverKind.make(driverId),
    modelId,
    displayName: `${instanceId} · ${modelId}`,
  };
}

it.effect(
  "runs full 7-stage FSM (Blind R1 -> B1 Ledger -> Anon R2 + Flip block -> B3 PinnedSpec -> CAS tamper guard -> 1-Click Delegate + Zero Self-Approval)",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const store = makeCouncilStore(sql);

      const tmpDir = yield* Effect.promise(() =>
        NodeFs.mkdtemp(NodePath.join(NodeOs.tmpdir(), "t3-council-e2e-")),
      );
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => NodeFs.rm(tmpDir, { recursive: true, force: true })),
      );
      yield* Effect.promise(async () => {
        await NodeFs.mkdir(NodePath.join(tmpDir, "src"), { recursive: true });
        await NodeFs.writeFile(
          NodePath.join(tmpDir, "src/auth.ts"),
          [
            "export function verifyToken(token: string | null): boolean {",
            "  if (!token) return false;",
            "  return token.startsWith('t3_');",
            "}",
            "export function parseScope(raw: string): string[] {",
            "  return raw.split(',').filter(Boolean);",
            "}",
          ].join("\n"),
          "utf8",
        );
      });

      const chair = makeTarget("chair_inst", "driver_chair", "chair-model");
      const subRed = makeTarget("sub_red", "driver_red", "red-model");
      const subArch = makeTarget("sub_arch", "driver_arch", "arch-model");

      const observedPrompts: Array<{
        readonly round: number;
        readonly seatId: string;
        readonly prompt: string;
      }> = [];
      const workerSpy: { worker: ModelTargetRef | null } = { worker: null };
      let launchedCount = 0;

      const orchestrator = yield* makeCouncilOrchestrator({
        store,
        sqlClient: sql,
        resolveContext: () =>
          Effect.succeed({
            projectRoot: tmpDir,
            chairModel: chair,
            configuredSubordinates: [
              { target: subRed, enabled: true, teamRole: "advisor" },
              { target: subArch, enabled: true, teamRole: "worker" },
            ],
            fallbackCandidates: [{ target: subArch }],
            assessTargetHealth: () => ({ healthy: true }),
            workspaceSummary: "src/auth.ts 인증 검증 모듈",
          }),
        runSeatTurn: ({ seat, roundNum, prompt }) =>
          Effect.sync(() => {
            observedPrompts.push({ round: roundNum, seatId: seat.seatId, prompt });

            if (roundNum === 1) {
              if (seat.seatId === "seat_chair") {
                return `<t3_council_proposal>${JSON.stringify({
                  claimKind: "PATCH_PROPOSAL",
                  severity: "P1",
                  statementKo: "verifyToken에서 공백 trim 및 길이 상한을 검사해야 합니다.",
                  proposedDiffSketch: "trim token and check length in verifyToken",
                  evidence: [
                    { filePath: "src/auth.ts", startLine: 1, endLine: 4, astSymbol: "verifyToken" },
                  ],
                  acceptanceCommands: ["node -e process.exit(0)"],
                })}</t3_council_proposal>`;
              }
              if (seat.assignedRole === "CONTRARIAN_RED") {
                return `<t3_council_proposal>${JSON.stringify({
                  claimKind: "CONTRARIAN_CHALLENGE",
                  severity: "P0",
                  statementKo: "parseScope가 중복 스코프를 제거하지 않아 권한 검증이 중복됩니다.",
                  proposedDiffSketch: "deduplicate parseScope output",
                  evidence: [
                    { filePath: "src/auth.ts", startLine: 5, endLine: 7, astSymbol: "parseScope" },
                  ],
                })}</t3_council_proposal>`;
              }
              return `<t3_council_proposal>${JSON.stringify({
                claimKind: "PATCH_PROPOSAL",
                severity: "P1",
                statementKo: "존재하지 않는 파일에 대한 환각 제안입니다.",
                proposedDiffSketch: "edit nonexistent.ts",
                evidence: [
                  { filePath: "src/ghost.ts", startLine: 1, endLine: 5, astSymbol: "ghostFn" },
                ],
              })}</t3_council_proposal>`;
            }

            if (roundNum === 2) {
              // Chair resolves the P0 challenge cleanly with NEW_EVIDENCE_ADDED
              if (seat.seatId === "seat_chair") {
                const p0Match = /claimId=(clm_[^\s,)]+)/u.exec(
                  prompt.slice(Math.max(0, prompt.indexOf("CONTRARIAN_CHALLENGE") - 120)),
                );
                const p0Id = p0Match?.[1] ?? null;
                return `<t3_council_critique>${JSON.stringify({
                  claimKind: "REBUTTAL_DEFENSE",
                  severity: null,
                  targetClaimId: p0Id,
                  responseTaxonomy: "NEW_EVIDENCE_ADDED",
                  statementKo: "parseScope 중복 제거를 verifyToken 패치 범위에 통합합니다.",
                  proposedDiffSketch: "trim token in verifyToken and dedup parseScope",
                  evidence: [
                    { filePath: "src/auth.ts", startLine: 5, endLine: 7, astSymbol: "parseScope" },
                  ],
                })}</t3_council_critique>`;
              }
              // subArch attempts sycophantic flip without new verified evidence -> MUST BE BLOCKED
              if (seat.assignedRole === "SYSTEM_ARCHITECT") {
                return `<t3_council_critique>${JSON.stringify({
                  claimKind: "REBUTTAL_DEFENSE",
                  severity: null,
                  targetClaimId: null,
                  responseTaxonomy: "CONFIDENCE_REDUCED",
                  statementKo: "다수 의견에 무근거로 동조합니다.",
                  proposedDiffSketch: "completely changed stance with zero new evidence",
                  evidence: [],
                })}</t3_council_critique>`;
              }
              return `<t3_council_critique>${JSON.stringify({
                claimKind: "REBUTTAL_DEFENSE",
                severity: null,
                targetClaimId: null,
                responseTaxonomy: "SCOPE_NARROWED",
                statementKo: "parseScope 중복 제거가 반영되면 P0 우려가 해소됩니다.",
                proposedDiffSketch: "deduplicate parseScope output",
                evidence: [
                  { filePath: "src/auth.ts", startLine: 5, endLine: 7, astSymbol: "parseScope" },
                ],
              })}</t3_council_critique>`;
            }

            // Round 3 synthesis
            return `<t3_council_synthesis>${JSON.stringify({
              titleKo: "auth.ts 토큰 검증 및 스코프 중복 제거",
              executiveSummaryKo:
                "verifyToken trim 가드와 parseScope 중복 제거를 최소 침습으로 적용합니다.",
              acceptedClaimIds: [],
              targetFiles: [
                {
                  filePath: "src/auth.ts",
                  patchIntentKo: "verifyToken trim 및 parseScope Set 중복 제거",
                  relatedEvidenceIds: [],
                },
              ],
              acceptanceChecks: [
                {
                  label: "Node 무결성 검증",
                  command: "node",
                  args: ["-e", "process.exit(0)"],
                },
              ],
              unresolvedDisagreementsKo: [],
              uniqueFindingsKo: ["parseScope 중복 스코프 정규화 필요"],
            })}</t3_council_synthesis>`;
          }),
        launchWorker: (args) =>
          Effect.sync(() => {
            launchedCount += 1;
            workerSpy.worker = args.worker;
            return {
              delegationId: `del_run_${launchedCount}`,
              outputText: "src/auth.ts 패치 및 검증을 완료했습니다.",
              workerSessionId: `wsess_${launchedCount}`,
            };
          }),
        runIndependentChecker: ({ checker }) =>
          Effect.succeed({
            decision: "approve",
            evidence: `독립 검증자(${checker.displayName})가 결정론적 테스트 통과를 확인했습니다.`,
            checkerSessionId: "chk_independent_1",
          }),
      });

      const threadId = ThreadId.make("thr_council_1");
      const projectId = ProjectId.make("prj_council_1");

      const capturedSpans: Array<{
        readonly name: string;
        readonly attrs: ReadonlyMap<string, unknown>;
      }> = [];
      const captureTracer = Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options);
          const end = span.end.bind(span);
          span.end = (endTime, exit) => {
            end(endTime, exit);
            capturedSpans.push({ name: span.name, attrs: new Map(span.attributes) });
          };
          return span;
        },
      });

      const started = yield* orchestrator
        .startAutoSeat({
          threadId,
          projectId,
          userPrompt: "src/auth.ts 인증 토큰과 스코프 파싱을 강화해줘",
          forceCouncil: true,
        })
        .pipe(Effect.withTracer(captureTracer));

      const settled = yield* orchestrator.awaitCouncil(started.councilId);
      expect(settled).not.toBeNull();
      expect(settled!.state).toBe("PINNED_READY");
      expect(settled!.pinnedSpec).not.toBeNull();
      // ActiveWork must be unregistered after council settles
      expect(
        activeWorkRegistry.snapshot().items.some((item) => item.id === started.councilId),
      ).toBe(false);

      // Verify Blind Round 1 isolation: no Round-1 prompt mentions another seat's statement or Proposal-1
      const r1Prompts = observedPrompts.filter((p) => p.round === 1);
      expect(r1Prompts.length).toBe(3);
      for (const p of r1Prompts) {
        expect(p.prompt).not.toContain("Proposal-1");
        expect(p.prompt).not.toContain("parseScope가 중복 스코프를");
      }

      // Verify Round 2 anonymization: no provider/model IDs leaked in Round-2 prompts
      const r2Prompts = observedPrompts.filter((p) => p.round === 2);
      expect(r2Prompts.length).toBe(3);
      for (const p of r2Prompts) {
        expect(p.prompt).toContain("Proposal-1");
        expect(p.prompt).not.toContain("chair-model");
        expect(p.prompt).not.toContain("red-model");
        expect(p.prompt).not.toContain("arch-model");
      }

      // Verify hallucinated ghost.ts was rejected in B1 and sycophantic flip was blocked in B2
      expect(
        settled!.ledgerEntries.some(
          (e) => e.filePath === "src/ghost.ts" && e.verificationStatus === "REJECTED_FILE_MISSING",
        ),
      ).toBe(true);
      expect(settled!.flipBlockedCount).toBeGreaterThanOrEqual(1);

      const pinned = settled!.pinnedSpec!;

      // TC-06 Part A: 1-byte file tamper MUST block execution with STALE_PINNED_SPEC
      yield* Effect.promise(() =>
        NodeFs.appendFile(NodePath.join(tmpDir, "src/auth.ts"), "\n// external edit", "utf8"),
      );
      const staleExit = yield* Effect.exit(
        orchestrator.executePinnedSpec({
          pinnedSpecId: pinned.pinnedSpecId,
          isolateInWorktree: false,
          idempotencyKey: "idem_key_stale_0001",
        }),
      );
      expect(staleExit._tag).toBe("Failure");
      if (staleExit._tag === "Failure") {
        const squashed = Cause.squash(staleExit.cause) as { code?: string; message?: string };
        expect(squashed.code).toBe("STALE_PINNED_SPEC");
        expect(squashed.message).toContain("STALE_PINNED_SPEC");
      }

      // Re-verify locks against disk & execute with explicit UI worker override (`subArch`)
      const reverified = yield* orchestrator
        .reverifyPinnedSpec({
          pinnedSpecId: pinned.pinnedSpecId,
        })
        .pipe(Effect.withTracer(captureTracer));
      expect(reverified.pinnedSpec?.specHashSha256).not.toBe(pinned.specHashSha256);

      const execRes = yield* orchestrator
        .executePinnedSpec({
          pinnedSpecId: pinned.pinnedSpecId,
          selectedWorkerOverride: subArch,
          isolateInWorktree: false,
          idempotencyKey: "idem_key_exec_0002",
        })
        .pipe(Effect.withTracer(captureTracer));
      expect(execRes.deduplicated).toBe(false);
      expect(workerSpy.worker?.modelId).toBe("arch-model");
      expect(launchedCount).toBe(1);

      // Idempotency: duplicate call with same key must not re-launch worker
      const dupRes = yield* orchestrator.executePinnedSpec({
        pinnedSpecId: pinned.pinnedSpecId,
        selectedWorkerOverride: subArch,
        isolateInWorktree: false,
        idempotencyKey: "idem_key_exec_0002",
      });
      expect(dupRes.deduplicated).toBe(true);
      expect(launchedCount).toBe(1);

      // Final state must be COMPLETED with Zero Self-Approval gate PASS & intact audit hash chain
      const finalSnap = yield* orchestrator.getSession(started.councilId);
      expect(finalSnap.state).toBe("COMPLETED");
      expect(finalSnap.pinnedSpec?.specGateOutcome).toBe("pass");

      const audit = yield* verifyHostAuditChain();
      expect(audit.valid).toBe(true);
      const auditRows = yield* sql<{
        readonly cnt: number;
      }>`SELECT COUNT(*) AS cnt FROM host_audit_chain`;
      expect(auditRows[0]?.cnt ?? 0).toBeGreaterThanOrEqual(2);

      // TC-07: Restart recovery marks stale active sessions as INTERRUPTED_BY_RESTART
      yield* store.createSession({
        councilId: "cnc_stale_restart",
        threadId,
        projectId,
        userPrompt: "interrupted session",
        chairModel: chair,
        roster: settled!.roster,
        state: "BLIND_ROUND_1",
        triageScore: 0.9,
      });
      const closed = yield* store.closeStaleCouncilSessions();
      expect(closed).toBe(1);
      const recovered = yield* store.getSessionSnapshot("cnc_stale_restart");
      expect(recovered?.state).toBe("INTERRUPTED_BY_RESTART");

      // W1-2: Verify correlation IDs attached to real Effect trace spans
      const startSpan = capturedSpans.find((s) => s.name === "CouncilOrchestrator.startAutoSeat");
      expect(startSpan?.attrs.get("t3.thread_id")).toBe(threadId);
      expect(startSpan?.attrs.get("t3.project_id")).toBe(projectId);
      expect(startSpan?.attrs.get("t3.council_id")).toBe(started.councilId);

      const execSpan = capturedSpans.find(
        (s) => s.name === "CouncilOrchestrator.executePinnedSpec",
      );
      expect(execSpan?.attrs.get("t3.thread_id")).toBe(threadId);
      expect(execSpan?.attrs.get("t3.council_id")).toBe(started.councilId);
      expect(execSpan?.attrs.get("t3.pinned_spec_id")).toBe(pinned.pinnedSpecId);

      const reverifySpan = capturedSpans.find(
        (s) => s.name === "CouncilOrchestrator.reverifyPinnedSpec",
      );
      expect(reverifySpan?.attrs.get("t3.thread_id")).toBe(threadId);
      expect(reverifySpan?.attrs.get("t3.pinned_spec_id")).toBe(pinned.pinnedSpecId);
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect(
  "releases delegatedTaskId lock and restores PINNED_READY when worker launch fails, allowing immediate retry and clean abort",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const store = makeCouncilStore(sql);

      const tmpDir = yield* Effect.promise(() =>
        NodeFs.mkdtemp(NodePath.join(NodeOs.tmpdir(), "t3-council-rollback-")),
      );
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => NodeFs.rm(tmpDir, { recursive: true, force: true })),
      );
      yield* Effect.promise(async () => {
        await NodeFs.mkdir(NodePath.join(tmpDir, "src"), { recursive: true });
        await NodeFs.writeFile(
          NodePath.join(tmpDir, "src/app.ts"),
          "export const answer = 42;\n",
          "utf8",
        );
      });

      const chair = makeTarget("chair_inst", "driver_chair", "chair-model");
      const subRed = makeTarget("sub_red", "driver_red", "red-model");
      let attemptCount = 0;
      const seenDelegationIds: Array<string | undefined> = [];

      const orchestrator = yield* makeCouncilOrchestrator({
        store,
        sqlClient: sql,
        resolveContext: () =>
          Effect.succeed({
            projectRoot: tmpDir,
            chairModel: chair,
            configuredSubordinates: [{ target: subRed, enabled: true, teamRole: "advisor" }],
            fallbackCandidates: [],
            assessTargetHealth: () => ({ healthy: true }),
            workspaceSummary: "src/app.ts",
          }),
        runSeatTurn: ({ roundNum }) =>
          Effect.sync(() => {
            if (roundNum === 3) {
              return `<t3_council_synthesis>${JSON.stringify({
                titleKo: "app.ts 업데이트",
                executiveSummaryKo: "실패 시 롤백 후 재실행 검증",
                acceptedClaimIds: [],
                targetFiles: [
                  { filePath: "src/app.ts", patchIntentKo: "수정", relatedEvidenceIds: [] },
                ],
                acceptanceChecks: [
                  { label: "ok", command: "node", args: ["-e", "process.exit(0)"] },
                ],
                unresolvedDisagreementsKo: [],
                uniqueFindingsKo: [],
              })}</t3_council_synthesis>`;
            }
            const tag = roundNum === 1 ? "t3_council_proposal" : "t3_council_critique";
            return `<${tag}>${JSON.stringify({
              claimKind: "PATCH_PROPOSAL",
              severity: "P1",
              statementKo: "app.ts 검증 완료",
              proposedDiffSketch: "update answer",
              evidence: [{ filePath: "src/app.ts", startLine: 1, endLine: 1, astSymbol: "answer" }],
            })}</${tag}>`;
          }),
        launchWorker: (args) =>
          Effect.gen(function* () {
            attemptCount += 1;
            seenDelegationIds.push(args.delegationId);
            if (attemptCount === 1) {
              return yield* Effect.fail(new Error("일시적 워커 오류"));
            }
            return {
              delegationId: args.delegationId ?? "cdel_fallback",
              outputText: "패치 성공",
              workerSessionId: args.delegationId ?? "cdel_fallback",
            };
          }),
        runIndependentChecker: () =>
          Effect.succeed({
            decision: "approve",
            evidence: "독립 검증 통과",
            checkerSessionId: "chk_rollback_1",
          }),
      });

      const started = yield* orchestrator.startAutoSeat({
        threadId: ThreadId.make("thr_rollback_1"),
        projectId: ProjectId.make("prj_rollback_1"),
        userPrompt: "실패 후 잠금 해제 테스트",
        forceCouncil: true,
      });
      const settled = yield* orchestrator.awaitCouncil(started.councilId);
      expect(settled?.state).toBe("PINNED_READY");
      const pinnedId = settled!.pinnedSpec!.pinnedSpecId;

      // 1st attempt fails -> must release lock and restore PINNED_READY with errorMessage
      const firstExit = yield* Effect.exit(
        orchestrator.executePinnedSpec({
          pinnedSpecId: pinnedId,
          isolateInWorktree: false,
          idempotencyKey: "idem_retryable_001",
        }),
      );
      expect(firstExit._tag).toBe("Failure");

      const afterFailure = yield* orchestrator.getSession(started.councilId);
      expect(afterFailure.state).toBe("PINNED_READY");
      expect(afterFailure.pinnedSpec?.delegatedTaskId).toBeNull();
      expect(afterFailure.errorMessage).toContain("일시적 워커 오류");

      // 2nd attempt with the SAME idempotencyKey must acquire cleanly and complete
      const retryRes = yield* orchestrator.executePinnedSpec({
        pinnedSpecId: pinnedId,
        isolateInWorktree: false,
        idempotencyKey: "idem_retryable_001",
      });
      expect(retryRes.deduplicated).toBe(false);
      expect(attemptCount).toBe(2);
      expect(seenDelegationIds[1]).toBe(retryRes.delegationId);

      const afterSuccess = yield* orchestrator.getSession(started.councilId);
      expect(afterSuccess.state).toBe("COMPLETED");
      expect(afterSuccess.pinnedSpec?.delegatedTaskId).toBe(retryRes.delegationId);

      // Verify closeStaleCouncilSessions clears orphaned delegated_task_id on ABORTED specs
      // without touching COMPLETED (spec_gate_outcome='pass') specs.
      yield* store.createSession({
        councilId: "cnc_aborted_orphan",
        threadId: ThreadId.make("thr_rollback_1"),
        projectId: ProjectId.make("prj_rollback_1"),
        userPrompt: "중단된 고아 잠금 정리",
        chairModel: chair,
        roster: settled!.roster,
        state: "ABORTED",
        triageScore: 1.0,
      });
      yield* store.savePinnedSpec({
        ...afterSuccess.pinnedSpec!,
        pinnedSpecId: "pspec_aborted_orphan",
        councilId: "cnc_aborted_orphan",
        delegatedTaskId: "cdel_orphaned_1234",
        specGateOutcome: null,
        specProofSummary: null,
      });
      yield* store.closeStaleCouncilSessions();

      const cleanedAborted = yield* store.getSessionSnapshot("cnc_aborted_orphan");
      expect(cleanedAborted?.pinnedSpec?.delegatedTaskId).toBeNull();
      const untouchedCompleted = yield* store.getSessionSnapshot(started.councilId);
      expect(untouchedCompleted?.pinnedSpec?.delegatedTaskId).toBe(retryRes.delegationId);
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.live(
  "completes discussion mode without forced PinnedSpec, posts timeline markdown report, and cuts off slow straggler via quorum grace",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const store = makeCouncilStore(sql);

      const tmpDir = yield* Effect.promise(() =>
        NodeFs.mkdtemp(NodePath.join(NodeOs.tmpdir(), "t3-council-discussion-quorum-")),
      );
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => NodeFs.rm(tmpDir, { recursive: true, force: true })),
      );
      yield* Effect.promise(async () => {
        await NodeFs.mkdir(NodePath.join(tmpDir, "docs"), { recursive: true });
        await NodeFs.writeFile(
          NodePath.join(tmpDir, "docs/stats.json"),
          JSON.stringify({ summary: { pf: 1.27, winRate: 0.54 } }, null, 2),
          "utf8",
        );
      });

      const chair = makeTarget("chair_inst", "driver_chair", "chair-model");
      const subRed = makeTarget("sub_red", "driver_red", "red-model");
      const subSlow = makeTarget("sub_slow", "driver_slow", "slow-local-model");

      const timelineReports: string[] = [];
      const abortedSeats: string[] = [];

      const orchestrator = yield* makeCouncilOrchestrator({
        store,
        sqlClient: sql,
        quorumRatio: 0.67,
        stragglerGraceMs: 40,
        round1SeatTimeoutMs: 5_000,
        round2SeatTimeoutMs: 5_000,
        resolveContext: () =>
          Effect.succeed({
            projectRoot: tmpDir,
            chairModel: chair,
            configuredSubordinates: [
              {
                target: subRed,
                enabled: true,
                teamRole: "advisor",
                preferredRoleOverride: "CONTRARIAN_RED",
              },
              {
                target: subSlow,
                enabled: true,
                teamRole: "worker",
                explicitCapabilities: ["code_edit"],
              },
            ],
            fallbackCandidates: [],
            assessTargetHealth: () => ({ healthy: true }),
            workspaceSummary: "docs/stats.json",
          }),
        runSeatTurn: ({ seat, roundNum }) => {
          // Slow 3rd seat hangs for 10s -> must be cut off after 40ms quorum grace once 2/3 finish
          if (seat.targetModel.modelId === "slow-local-model" && roundNum <= 2) {
            return Effect.sleep("10 seconds").pipe(Effect.as("too late"));
          }
          if (roundNum === 3) {
            return Effect.succeed(
              `<t3_council_synthesis>${JSON.stringify({
                titleKo: "급락 후 반등 +30% 고정 익절 유효성 진단",
                executiveSummaryKo:
                  "PF 1.27 및 도달률 54%는 고정 익절 덕분이며 홀딩 시 손실 전환됩니다.",
                acceptedClaimIds: [],
                targetFiles: [],
                acceptanceChecks: [],
                unresolvedDisagreementsKo: [],
                uniqueFindingsKo: ["최근 30일 미완결 표본은 별도 분리 필요"],
              })}</t3_council_synthesis>`,
            );
          }
          const tag = roundNum === 1 ? "t3_council_proposal" : "t3_council_critique";
          return Effect.succeed(
            `<${tag}>${JSON.stringify({
              claimKind: roundNum === 1 ? "ROOT_DIAGNOSIS" : "REBUTTAL_DEFENSE",
              severity: "P1",
              responseTaxonomy: roundNum === 1 ? "INITIAL" : "SCOPE_NARROWED",
              statementKo: "stats.json의 PF 1.27과 승률 54%를 검증했습니다.",
              proposedDiffSketch: null,
              evidence: [
                {
                  filePath: "docs/stats.json",
                  startLine: 1,
                  endLine: 5,
                  astSymbol: "summary.pf",
                },
              ],
            })}</${tag}>`,
          );
        },
        launchWorker: () =>
          Effect.fail(new Error("discussion mode must never launch a code-patch worker")),
        publishTimelineReport: ({ markdown }) =>
          Effect.sync(() => {
            timelineReports.push(markdown);
          }),
        abortSeatDispatch: ({ seatId }) =>
          Effect.sync(() => {
            abortedSeats.push(seatId);
          }),
      });

      const t0 = Date.now();
      const started = yield* orchestrator.startAutoSeat({
        threadId: ThreadId.make("thr_disc_1"),
        projectId: ProjectId.make("prj_disc_1"),
        userPrompt: "크라임 코인 봇 신호가 어떻게 성공했는지 분석",
        mode: "auto",
        forceCouncil: true,
      });
      expect(started.mode).toBe("discussion");

      // Duplicate concurrent start in the same thread must be rejected
      const dupExit = yield* Effect.exit(
        orchestrator.startAutoSeat({
          threadId: ThreadId.make("thr_disc_1"),
          projectId: ProjectId.make("prj_disc_1"),
          userPrompt: "중복 실행 시도",
          mode: "auto",
          forceCouncil: true,
        }),
      );
      expect(dupExit._tag).toBe("Failure");

      const settled = yield* orchestrator.awaitCouncil(started.councilId);
      const elapsedMs = Date.now() - t0;

      // Must finish well under 3s (not waiting 20s for the 10s straggler across R1+R2)
      expect(elapsedMs).toBeLessThan(3_000);
      expect(settled?.state).toBe("COMPLETED");
      expect(settled?.mode).toBe("discussion");
      expect(settled?.pinnedSpec).toBeNull();
      expect(settled?.synthesisReportMarkdown).toContain("급락 후 반등 +30% 고정 익절 유효성 진단");
      expect(timelineReports.length).toBe(1);
      expect(timelineReports[0]).toContain("docs/stats.json:1-5");
      expect(abortedSeats.length).toBeGreaterThanOrEqual(1);
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect(
  "completes discussion mode with unresolved P0 as report without AWAITING_OVERRIDE, and passes Checker gate when Worker equals CONTRARIAN_RED",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const store = makeCouncilStore(sql);

      const tmpDir = yield* Effect.promise(() =>
        NodeFs.mkdtemp(NodePath.join(NodeOs.tmpdir(), "t3-council-checker-actor-")),
      );
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => NodeFs.rm(tmpDir, { recursive: true, force: true })),
      );
      yield* Effect.promise(async () => {
        await NodeFs.writeFile(
          NodePath.join(tmpDir, "engine.py"),
          "def run_scan_once():\n    return True\n",
          "utf8",
        );
      });

      const chairClaude = makeTarget("claudeAgent", "claudeAgent", "claude-opus-5-5");
      const subCodex = makeTarget("codex", "codex", "gpt-6.2-sol");
      const publishedReports: string[] = [];
      let observedCheckerCwd: string | undefined;
      let observedCheckerModel: string | undefined;

      const orchestrator = yield* makeCouncilOrchestrator({
        store,
        sqlClient: sql,
        resolveContext: () =>
          Effect.succeed({
            projectRoot: tmpDir,
            chairModel: chairClaude,
            // Both CONTRARIAN_RED and SYSTEM_ARCHITECT share `codex:gpt-6.2-sol` (exact live bug setup!)
            configuredSubordinates: [
              { target: subCodex, enabled: true, teamRole: "advisor" },
              {
                target: subCodex,
                enabled: true,
                teamRole: "worker",
                explicitCapabilities: ["code_edit"],
              },
            ],
            fallbackCandidates: [],
            assessTargetHealth: () => ({ healthy: true }),
            workspaceSummary: "engine.py",
          }),
        runSeatTurn: ({ seat, roundNum }) =>
          Effect.sync(() => {
            if (roundNum === 3) {
              return `<t3_council_synthesis>${JSON.stringify({
                titleKo: "언락 숏 업그레이드는 고정 C1 기준으로 3층 분리 검증한다",
                executiveSummaryKo:
                  "지표 추가 탐색을 멈추고 창 효과·타이밍·체결을 분리 검증합니다.",
                acceptedClaimIds: [],
                targetFiles: [
                  {
                    filePath: "engine.py",
                    patchIntentKo: "스캔 검증 추가",
                    relatedEvidenceIds: [],
                  },
                ],
                acceptanceChecks: [
                  { label: "ok", command: "node", args: ["-e", "process.exit(0)"] },
                ],
                unresolvedDisagreementsKo: [],
                uniqueFindingsKo: [],
              })}</t3_council_synthesis>`;
            }
            const tag = roundNum === 1 ? "t3_council_proposal" : "t3_council_critique";
            // CONTRARIAN_RED keeps P0 unresolved across R1 & R2
            const isRed = seat.assignedRole === "CONTRARIAN_RED";
            return `<${tag}>${JSON.stringify({
              claimKind: isRed
                ? "CONTRARIAN_CHALLENGE"
                : roundNum === 1
                  ? "ROOT_DIAGNOSIS"
                  : "REBUTTAL_DEFENSE",
              severity: isRed ? "P0" : "P1",
              targetClaimId: null,
              responseTaxonomy: roundNum === 1 ? "INITIAL" : "NEW_EVIDENCE_ADDED",
              statementKo: "engine.py 스캔 검증 필요",
              proposedDiffSketch: "update run_scan_once",
              evidence: [
                { filePath: "engine.py", startLine: 1, endLine: 2, astSymbol: "run_scan_once" },
              ],
            })}</${tag}>`;
          }),
        launchWorker: (args) =>
          Effect.succeed({
            delegationId: args.delegationId ?? "cdel_codex_1",
            outputText: "engine.py 수정 완료",
            workerSessionId: args.delegationId ?? "cdel_codex_1",
          }),
        runIndependentChecker: (args) =>
          Effect.sync(() => {
            observedCheckerCwd = args.cwd;
            observedCheckerModel = args.checker.modelId;
            return {
              decision: "approve" as const,
              evidence: "Checked against engine.py directly.",
              checkerSessionId: "chk_claude_1",
            };
          }),
        publishTimelineReport: ({ markdown }) =>
          Effect.sync(() => {
            publishedReports.push(markdown);
          }),
      });

      // Part 1: Discussion mode ("방향을 확정") with unresolved P0 MUST complete directly with Chair's R3 report,
      // NEVER halting at AWAITING_OVERRIDE or promoting a PinnedSpec!
      const discStarted = yield* orchestrator.startAutoSeat({
        threadId: ThreadId.make("thr_disc_p0"),
        projectId: ProjectId.make("prj_disc_p0"),
        userPrompt: "RAG를 파악하고 다시 언락 숏 전략을 업그레이드 할 방향을 확정",
        mode: "auto",
        forceCouncil: true,
      });
      expect(discStarted.mode).toBe("discussion");
      const discSettled = yield* orchestrator.awaitCouncil(discStarted.councilId);
      expect(discSettled?.state).toBe("COMPLETED");
      expect(discSettled?.pinnedSpec).toBeNull();
      expect(discSettled?.synthesisReportMarkdown).toContain(
        "언락 숏 업그레이드는 고정 C1 기준으로 3층 분리 검증한다",
      );
      expect(publishedReports.length).toBe(1);

      // Part 2: Code-patch mode where Worker === CONTRARIAN_RED (`codex:gpt-6.2-sol`) and Chair (`claude-opus-5-5`)
      // is the only distinct model MUST pass Independent Checker (`COMPLETED`, NOT `refused_missing_checker`)!
      const patchStarted = yield* orchestrator.startAutoSeat({
        threadId: ThreadId.make("thr_patch_checker"),
        projectId: ProjectId.make("prj_disc_p0"),
        userPrompt: "engine.py 스캔 버그를 수정해줘",
        mode: "code_patch",
        forceCouncil: true,
      });
      const patchHeld = yield* orchestrator.awaitCouncil(patchStarted.councilId);
      expect(patchHeld?.state).toBe("AWAITING_OVERRIDE");
      // Chair's R3 synthesis must be preserved on AWAITING_OVERRIDE
      expect(patchHeld?.synthesisReportMarkdown).toContain(
        "언락 숏 업그레이드는 고정 C1 기준으로 3층 분리 검증한다",
      );

      const overridden = yield* orchestrator.approveOverride({
        councilId: patchStarted.councilId,
        reason: "P0 확인 후 패치 진행",
      });
      expect(overridden.state).toBe("PINNED_READY");

      const execOut = yield* orchestrator.executePinnedSpec({
        pinnedSpecId: overridden.pinnedSpec!.pinnedSpecId,
        selectedWorkerOverride: subCodex,
        isolateInWorktree: false,
        idempotencyKey: "idem_codex_worker_claude_checker",
      });
      expect(execOut.executedWorker.modelId).toBe("gpt-6.2-sol");
      expect(observedCheckerModel).toBe("claude-opus-5-5");
      expect(observedCheckerCwd).toBe(tmpDir);

      const patchDone = yield* orchestrator.getSession(patchStarted.councilId);
      expect(patchDone.state).toBe("COMPLETED");
      expect(patchDone.pinnedSpec?.specGateOutcome).toBe("pass");
      expect(patchDone.errorMessage).toBeNull();
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
);
