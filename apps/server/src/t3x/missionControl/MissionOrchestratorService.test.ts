// @effect-diagnostics preferSchemaOverJson:off globalRandomInEffect:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ProjectId, ProviderDriverKind, ThreadId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import type { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { makeSqlitePersistenceLive } from "../../persistence/Layers/Sqlite.ts";

const TestDbLayer = makeSqlitePersistenceLive(":memory:").pipe(Layer.provide(NodeServices.layer));
import { makeMissionControlStore } from "./MissionControlStore.ts";
import { resolveMissionThreadModes } from "./MissionOrchestratorLive.ts";
import {
  makeMissionOrchestrator,
  type MissionCrewStepInput,
  type MissionCrewStepOutput,
} from "./MissionOrchestratorService.ts";

function makeProvider(
  instanceId: string,
  driver: ServerProvider["driver"],
  displayName: string,
  modelSlug: string,
): ServerProvider {
  return {
    provider: driver,
    instanceId,
    driver,
    displayName,
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-11-26T00:00:00.000Z",
    models: [
      {
        slug: modelSlug,
        name: modelSlug,
        isCustom: false,
        isDefault: true,
        supportsReasoning: true,
      },
    ],
    slashCommands: [],
    skills: [],
  } as unknown as ServerProvider;
}

const PROVIDERS = [
  makeProvider("codex", ProviderDriverKind.make("codex"), "Codex", "gpt-5.4"),
  makeProvider("claudeAgent", ProviderDriverKind.make("claudeAgent"), "Claude", "claude-opus-4-6"),
  makeProvider(
    "muse_cloud_1",
    ProviderDriverKind.make("museCloud"),
    "Muse Cloud (유나)",
    "muse-agent",
  ),
];

describe("MissionOrchestratorService 통합 테스트", () => {
  it("실제 대화창 바인딩 + 유동 모델 변경 + 이종 교차 검수 + 완료 보고까지 완주한다", async () => {
    const projectId = ProjectId.make("proj_mission_1");
    const boundThreadId = ThreadId.make("thread_live_chat_1");
    const executedSteps: Array<{ roleKey: string; instanceId: string; modelSlug: string }> = [];
    const postedMessages: Array<{ threadId: string; markdown: string }> = [];

    const program = Effect.scoped(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const orchestrator = yield* makeMissionOrchestrator({
          sql,
          reconcileOnBoot: false,
          resolveProjectContext: () =>
            Effect.succeed({
              projectId,
              projectTitle: "NewAutoUsage",
              workspaceRoot: ".",
              providers: PROVIDERS,
            }),
          publishThreadMessage: ({ threadId, markdown }) =>
            Effect.sync(() => {
              postedMessages.push({ threadId, markdown });
            }),
          runCrewStep: (step: MissionCrewStepInput) =>
            Effect.sync(() => {
              executedSteps.push({
                roleKey: step.role.roleKey,
                instanceId: step.providerInstanceId,
                modelSlug: step.modelSlug,
              });
              const payload =
                step.role.roleKey === "planner"
                  ? {
                      status: "ok",
                      summary3Lines: [
                        "로그인 모듈 수정 범위 확정",
                        "파일 1개 대상",
                        "단위 테스트 기준 수립",
                      ],
                      changedFiles: ["src/auth.ts"],
                      verificationCmd: null,
                      recommendation: "개발실로 인계",
                    }
                  : step.role.roleKey === "coder"
                    ? {
                        status: "ok",
                        summary3Lines: [
                          "세션 갱신 레이스 컨디션 수정",
                          "단위 테스트 5건 통과",
                          "회귀 없음",
                        ],
                        changedFiles: ["src/auth.ts"],
                        verificationCmd: "vp test",
                        recommendation: "이종 검수 요청",
                      }
                    : {
                        status: "ok",
                        summary3Lines: ["변경 범위 최소성 확인", "테스트 증거 일치", "승인 가능"],
                        changedFiles: ["src/auth.ts"],
                        verificationCmd: "vp test",
                        recommendation: "완료 승인",
                      };
              return {
                resultText: `<t3_mission_result>${JSON.stringify(payload)}</t3_mission_result>`,
                exitCode: 0,
                changedFiles: ["src/auth.ts"],
              } satisfies MissionCrewStepOutput;
            }),
        });

        // 1. 스냅샷 조회 시 4인 기본 크루 자동 시드 확인
        const initialSnap = yield* orchestrator.getSnapshot({ projectId });
        expect(initialSnap.crewRoles.length).toBe(4);

        // 2. 사용자가 유동적으로 coder 크루의 모델을 Muse Cloud로 변경!
        const updatedCoder = yield* orchestrator.upsertCrewRole({
          projectId,
          roleKey: "coder",
          displayName: "개발실 (유나 모드)",
          providerInstanceId: "muse_cloud_1",
          modelSlug: "muse-agent",
          modelTier: "TIER_A",
        });
        expect(updatedCoder.providerInstanceId).toBe("muse_cloud_1");
        expect(updatedCoder.modelSlug).toBe("muse-agent");

        // 3. 실제 대화창(boundThreadId)에서 자율 미션 실행 (requireFinalApproval=false로 자동 완료 검증)
        const mission = yield* orchestrator.createMission({
          projectId,
          threadId: boundThreadId,
          goalPrompt: "로그인 세션 갱신 버그를 고치고 테스트를 통과시켜줘",
          doneCriteria: ["단위 테스트 통과"],
          requireFinalApproval: false,
        });
        expect(mission.threadId).toBe(boundThreadId);

        yield* orchestrator.awaitMission(mission.id);

        const afterSnap = yield* orchestrator.getSnapshot({ projectId });
        const finished = afterSnap.missions.find((m) => m.id === mission.id)!;
        expect(finished.status).toBe("COMPLETED");
        expect(finished.digestLine).toBeTruthy();

        // 유동 변경된 모델로 coder가 실제로 실행됐고, reviewer는 coder와 다른 이종 프로바이더로 실행됨!
        const coderExec = executedSteps.find((s) => s.roleKey === "coder")!;
        const reviewerExec = executedSteps.find((s) => s.roleKey === "reviewer")!;
        expect(coderExec.instanceId).toBe("muse_cloud_1");
        expect(reviewerExec.instanceId).not.toBe(coderExec.instanceId);

        // 실제 대화창에 착수 보고 + 완료 보고가 게시됨!
        expect(
          postedMessages.some(
            (m) => m.threadId === boundThreadId && m.markdown.includes("자율 미션 착수"),
          ),
        ).toBe(true);
        expect(
          postedMessages.some(
            (m) => m.threadId === boundThreadId && m.markdown.includes("미션 완료 보고"),
          ),
        ).toBe(true);

        // 교신 원장(worker_mailbox_messages)에 CompactHandoffPacket이 기록됨!
        expect(afterSnap.handoffs.length).toBeGreaterThanOrEqual(3);
        expect(afterSnap.handoffs[0]?.packet?.schemaVersion).toBe("handoff.v2");

        // 일일 경영 보고서 Map-Reduce 즉시 생성
        const digest = yield* orchestrator.generateDigestNow({ projectId });
        expect(digest.scope).toBe("DAILY_DIGEST");
        expect(digest.bodyMd).toContain(finished.title);
      }),
    ).pipe(Effect.provide(TestDbLayer));

    await Effect.runPromise(program);
  });

  it("파괴적 작업은 Zero-Token 게이트가 즉시 Tier 2 결재함으로 동결하고, modify_resume / approve / reject_rollback / snooze를 지원한다", async () => {
    const projectId = ProjectId.make("proj_mission_2");
    let crewCalls = 0;

    const program = Effect.scoped(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const orchestrator = yield* makeMissionOrchestrator({
          sql,
          reconcileOnBoot: false,
          resolveProjectContext: () =>
            Effect.succeed({
              projectId,
              projectTitle: "SafetyRepo",
              workspaceRoot: ".",
              providers: PROVIDERS,
            }),
          runCrewStep: () =>
            Effect.sync(() => {
              crewCalls += 1;
              return {
                resultText: `<t3_mission_result>{"status":"ok","summary3Lines":["안전 범위만 실행 완료"],"changedFiles":[],"verificationCmd":null,"recommendation":"완료"}</t3_mission_result>`,
                exitCode: 0,
              };
            }),
        });

        // 1. 파괴적 연산 포함 목표 → LLM 0회 호출 상태로 즉시 AWAITING_APPROVAL!
        const m1 = yield* orchestrator.createMission({
          projectId,
          goalPrompt: "운영 DB에서 DROP TABLE old_logs 실행하고 git push 해줘",
          requireFinalApproval: false,
        });
        expect(m1.status).toBe("AWAITING_APPROVAL");
        expect(crewCalls).toBe(0);

        const snap1 = yield* orchestrator.getSnapshot({ projectId });
        expect(snap1.pendingApprovals.length).toBe(1);
        const gateId = snap1.pendingApprovals[0]!.gateId;
        expect(snap1.pendingApprovals[0]!.triggerReason).toBe("DESTRUCTIVE_OP");

        // 2. 1시간 보류 (snooze)
        const snapSnoozed = yield* orchestrator.decideApproval({
          projectId,
          gateId,
          action: "snooze",
          snoozeMinutes: 60,
        });
        expect(snapSnoozed.pendingApprovals[0]!.snoozedUntilMs).not.toBeNull();

        // 3. 수정 지시 후 Checkpoint 재개 (modify_resume) → 실행 완료!
        yield* orchestrator.decideApproval({
          projectId,
          gateId,
          action: "modify_resume",
          note: "DROP 대신 백업 SQL 파일만 생성하고 push는 하지 마세요.",
        });
        yield* orchestrator.awaitMission(m1.id);

        const snapDone = yield* orchestrator.getSnapshot({ projectId });
        expect(snapDone.missions.find((m) => m.id === m1.id)?.status).toBe("COMPLETED");
        expect(crewCalls).toBeGreaterThanOrEqual(3);

        // 4. reject_rollback 검증
        const m2 = yield* orchestrator.createMission({
          projectId,
          goalPrompt: "rm -rf /tmp/old_cache 실행",
        });
        const snap2 = yield* orchestrator.getSnapshot({ projectId });
        const gate2 = snap2.pendingApprovals.find((g) => g.missionId === m2.id)!;
        const afterReject = yield* orchestrator.decideApproval({
          projectId,
          gateId: gate2.gateId,
          action: "reject_rollback",
          note: "위험해서 취소",
        });
        expect(afterReject.missions.find((m) => m.id === m2.id)?.status).toBe("CANCELLED");
      }),
    ).pipe(Effect.provide(TestDbLayer));

    await Effect.runPromise(program);
  });

  it("이종 검수 2회 초과 반려 시 서킷 브레이커가 결재함으로 자동 차단하고, Kill Switch·Zero-Token 하트비트·lease_epoch 펜싱이 동작한다", async () => {
    const projectId = ProjectId.make("proj_mission_3");

    const program = Effect.scoped(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const store = makeMissionControlStore(sql);
        const orchestrator = yield* makeMissionOrchestrator({
          sql,
          reconcileOnBoot: false,
          resolveProjectContext: () =>
            Effect.succeed({
              projectId,
              projectTitle: "GuardRepo",
              workspaceRoot: ".",
              providers: PROVIDERS,
            }),
          runCrewStep: (step) =>
            Effect.sync(() => {
              if (step.role.roleKey === "reviewer") {
                return {
                  resultText: `<t3_mission_result>{"status":"fix_required","summary3Lines":["엣지 케이스 누락 ${Math.random().toString(36).slice(2, 6)}"],"changedFiles":[],"verificationCmd":"vp test","recommendation":"재수정 필요"}</t3_mission_result>`,
                  exitCode: 0,
                };
              }
              return {
                resultText: `<t3_mission_result>{"status":"ok","summary3Lines":["수정 시도 ${Math.random().toString(36).slice(2, 6)}"],"changedFiles":["src/x.ts"],"verificationCmd":"vp test","recommendation":"검수 요청"}</t3_mission_result>`,
                exitCode: 0,
              };
            }),
        });

        const mission = yield* orchestrator.createMission({
          projectId,
          goalPrompt: "복잡한 동시성 버그 수정",
          requireFinalApproval: false,
        });
        yield* orchestrator.awaitMission(mission.id);

        const snap = yield* orchestrator.getSnapshot({ projectId });
        const stalled = snap.missions.find((m) => m.id === mission.id)!;
        expect(stalled.status).toBe("AWAITING_APPROVAL");
        expect(stalled.circuitBreakerState).toBe("TRIPPED_TO_INBOX");
        expect(snap.pendingApprovals.length).toBeGreaterThanOrEqual(1);

        // lease_epoch 좀비 쓰기 펜싱 검증 (구 epoch로 업데이트 시도 시 FENCING_CONFLICT!)
        const zombieWrite = yield* Effect.result(
          store.updateMissionFenced(stalled.id, stalled.leaseEpoch + 99, {
            status: "COMPLETED",
          }),
        );
        expect(Result.isFailure(zombieWrite)).toBe(true);
        if (Result.isFailure(zombieWrite)) {
          expect(zombieWrite.failure.code).toBe("FENCING_CONFLICT");
        }

        // Zero-Token 하트비트 체크는 LLM을 0회 호출
        const hb = yield* orchestrator.runHeartbeatCheck({ projectId });
        expect(hb.llmCalled).toBe(false);

        // Kill Switch 활성화 시 신규 미션 차단 및 크루 IDLE 복귀
        const ksSnap = yield* orchestrator.killSwitch({
          projectId,
          active: true,
          reason: "긴급 점검",
        });
        expect(ksSnap.budget.killSwitchActive).toBe(true);
        expect(ksSnap.crewRoles.every((r) => r.currentStatus === "IDLE")).toBe(true);
        const blocked = yield* Effect.result(
          orchestrator.createMission({
            projectId,
            goalPrompt: "차단되어야 하는 미션",
          }),
        );
        expect(Result.isFailure(blocked)).toBe(true);
        if (Result.isFailure(blocked)) {
          expect(blocked.failure.code).toBe("KILL_SWITCH_ACTIVE");
        }

        // 결재 대기(AWAITING_APPROVAL) 미션을 cancelMission으로 종료하면 결재 게이트 닫힘 + DAG SKIPPED + CANCELLED
        const cancelled = yield* orchestrator.cancelMission({
          projectId,
          missionId: stalled.id,
          reason: "자율 운영실 전체 종료",
        });
        expect(cancelled.status).toBe("CANCELLED");
        expect(
          cancelled.dagSteps.every(
            (s) => s.status !== "RUNNING" && s.status !== "AWAITING_APPROVAL",
          ),
        ).toBe(true);

        const afterCancelSnap = yield* orchestrator.getSnapshot({ projectId });
        expect(afterCancelSnap.pendingApprovals.some((g) => g.missionId === stalled.id)).toBe(
          false,
        );
        expect(afterCancelSnap.crewRoles.every((r) => r.currentStatus === "IDLE")).toBe(true);

        // 운영실 재가동 (killSwitch false) 시 정상 복귀
        const resumedSnap = yield* orchestrator.killSwitch({
          projectId,
          active: false,
          reason: "사용자 운영실 재가동",
        });
        expect(resumedSnap.budget.killSwitchActive).toBe(false);

        // 종료된 미션 삭제 시 파이프라인 목록에서 완전히 제거됨
        const deleted = yield* orchestrator.deleteMission({
          projectId,
          missionId: stalled.id,
        });
        expect(deleted.deleted).toBe(true);
        const afterDeleteSnap = yield* orchestrator.getSnapshot({ projectId });
        expect(afterDeleteSnap.missions.some((m) => m.id === stalled.id)).toBe(false);
      }),
    ).pipe(Effect.provide(TestDbLayer));

    await Effect.runPromise(program);
  });

  it("크루가 빈 응답으로 종료되면 완료로 통과시키지 않고 FAILED 및 결재함 오류로 차단한다", async () => {
    const projectId = ProjectId.make("proj_mission_empty");
    const executedRoles: string[] = [];

    const program = Effect.scoped(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const orchestrator = yield* makeMissionOrchestrator({
          sql,
          reconcileOnBoot: false,
          resolveProjectContext: () =>
            Effect.succeed({
              projectId,
              projectTitle: "EmptyGuardRepo",
              workspaceRoot: ".",
              providers: PROVIDERS,
            }),
          runCrewStep: (step) =>
            Effect.sync(() => {
              executedRoles.push(step.role.roleKey);
              return {
                resultText: "   ",
                exitCode: 0,
              } satisfies MissionCrewStepOutput;
            }),
        });

        const mission = yield* orchestrator.createMission({
          projectId,
          goalPrompt: "기획 단계 빈 응답 차단 검증",
          requireFinalApproval: false,
        });
        yield* orchestrator.awaitMission(mission.id);

        const snap = yield* orchestrator.getSnapshot({ projectId });
        const after = snap.missions.find((m) => m.id === mission.id)!;
        expect(executedRoles).toEqual(["planner"]);
        expect(after.status).toBe("AWAITING_APPROVAL");
        expect(after.dagSteps.find((s) => s.stepId === "step_plan")?.status).toBe("FAILED");
        expect(snap.pendingApprovals.some((g) => g.missionId === mission.id)).toBe(true);
      }),
    ).pipe(Effect.provide(TestDbLayer));

    await Effect.runPromise(program);
  });

  it("자율 운영실 크루는 채팅방의 runtimeMode·interactionMode를 그대로 상속한다(full-access 격하 및 approval-required 우회 금지)", async () => {
    const fullAccessThread = ThreadId.make("thread_full_access");
    const approvalThread = ThreadId.make("thread_approval_req");
    const fakeQuery = {
      getThreadRuntimeContext: (tid: ThreadId) =>
        Effect.succeed(
          tid === fullAccessThread
            ? Option.some({
                runtimeMode: "full-access" as const,
                interactionMode: "default" as const,
              })
            : tid === approvalThread
              ? Option.some({
                  runtimeMode: "approval-required" as const,
                  interactionMode: "plan" as const,
                })
              : Option.none(),
        ),
      getShellSnapshot: () => Effect.succeed({ projects: [], threads: [] }),
    } as unknown as ProjectionSnapshotQuery["Service"];

    const fullModes = await Effect.runPromise(
      resolveMissionThreadModes(fakeQuery, fullAccessThread),
    );
    expect(fullModes).toEqual({ runtimeMode: "full-access", interactionMode: "default" });

    const approvalModes = await Effect.runPromise(
      resolveMissionThreadModes(fakeQuery, approvalThread),
    );
    expect(approvalModes).toEqual({ runtimeMode: "approval-required", interactionMode: "plan" });
  });
});
