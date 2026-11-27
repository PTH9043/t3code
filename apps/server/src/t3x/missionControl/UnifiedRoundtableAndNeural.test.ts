// @effect-diagnostics preferSchemaOverJson:off globalRandomInEffect:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ProjectId, ProviderDriverKind, ThreadId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { makeSqlitePersistenceLive } from "../../persistence/Layers/Sqlite.ts";
import {
  PEER_EQUALITY_CHARTER,
  evaluateMeetingEarlyStop,
  parseSynapsePacketFromText,
  selectTopSynapsePackets,
} from "./MeetingSynapseProtocol.ts";
import { isMissionCodingCapableModel } from "./MissionModelRouter.ts";
import {
  makeMissionOrchestrator,
  type MissionCrewStepInput,
  type MissionCrewStepOutput,
} from "./MissionOrchestratorService.ts";
import { classifyMissionDomainTag, selectSparseCrewForTopic } from "./MissionTriageRouter.ts";
import {
  DYLAN_MIN_SAMPLES_FOR_PRUNE,
  backpropagateMeetingImportance,
  isRecommendedForPruning,
} from "./SynapseBackpropEngine.ts";

const TestDbLayer = makeSqlitePersistenceLive(":memory:").pipe(Layer.provide(NodeServices.layer));

function makeProvider(
  instanceId: string,
  driver: ServerProvider["driver"],
  displayName: string,
  models: ReadonlyArray<string>,
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
    checkedAt: "2026-11-27T00:00:00.000Z",
    models: models.map((slug, idx) => ({
      slug,
      name: slug,
      isCustom: false,
      isDefault: idx === 0,
      supportsReasoning: true,
    })),
    slashCommands: [],
    skills: [],
  } as unknown as ServerProvider;
}

const TEST_PROVIDERS = [
  makeProvider("grok", ProviderDriverKind.make("grok"), "Grok", ["grok-4.7"]),
  makeProvider("claudeAgent", ProviderDriverKind.make("claudeAgent"), "Claude", [
    "claude-opus-5-5",
  ]),
  makeProvider("antseed_local", ProviderDriverKind.make("opencode"), "Antseed Gateway", [
    "t3_antseed/bytedance/seedance-2.0-fast",
    "t3_antseed/alibaba/wan-v3.0-video-prime",
    "t3_antseed/deepseek/deepseek-v4.1-flash-1017",
  ]),
  makeProvider("gemini", ProviderDriverKind.make("gemini"), "Antigravity CLI", [
    "gemini-pro-orchestrator-neon",
    "gemini-4-neon",
  ]),
];

describe("통합 자율 운영실 · 감독자 주도 동등 합석 회의실 · 4계층 신경망 엔진", () => {
  it("Layer 0 트리아지 · 비코딩 미디어 모델(seedance-2.0-fast) 제외 · SMoA 패킷 선별 · 비잔틴 조기 종료가 정확히 동작한다", () => {
    expect(isMissionCodingCapableModel("t3_antseed/bytedance/seedance-2.0-fast")).toBe(false);
    expect(isMissionCodingCapableModel("t3_antseed/alibaba/wan-v3.0-video-prime")).toBe(false);
    expect(isMissionCodingCapableModel("t3_antseed/deepseek/deepseek-v4.1-flash-1017")).toBe(true);
    expect(isMissionCodingCapableModel("t3_personal_orchestrator/personal-orchestrator-4b")).toBe(
      true,
    );

    expect(classifyMissionDomainTag("크라임 코인 백테스팅 1년 승률 50% 이상 전략 리서치")).toBe(
      "quant_data",
    );
    expect(classifyMissionDomainTag("보안 취약점 및 SQL 인젝션 회귀 감사")).toBe("security_review");
    expect(classifyMissionDomainTag("통합 아키텍처 개편 및 SQLite 마이그레이션 설계")).toBe(
      "architecture",
    );

    const roleTierByKey = new Map([
      ["planner", "L1_LEAD" as const],
      ["coder", "L2_SPECIALIST" as const],
      ["reviewer", "L1_LEAD" as const],
      ["digest", "L3_SUPPORT" as const],
    ]);

    const coderRole = {
      roleKey: "coder",
      displayName: "개발실 (구현·수정)",
      orgTier: "L2_SPECIALIST" as const,
    } as Parameters<typeof parseSynapsePacketFromText>[0]["speaker"];

    const upwardPkt = parseSynapsePacketFromText({
      meetingId: "mtg_unit_1",
      roundNum: 1,
      speaker: coderRole,
      roleTierByKey,
      nowMs: 1_700_000_000_000,
      rawText: `기획안의 지표 윈도우가 너무 길어 과적합 위험이 있습니다.\n<t3_synapse_packet>{"replyToRoleKeys":["planner"],"stance":"counter","claim":"30일 롤링 워크포워드 분할로 과적합을 차단해야 합니다","evidence":["표본 외 샤프지수 +0.42","수수료 0.1% 반영"],"riskOrCounter":"단일 기간 최적화는 실전 드로우다운 확대 위험"}</t3_synapse_packet>`,
    });
    expect(upwardPkt.upwardFeedback).toBe(true);
    expect(upwardPkt.stance).toBe("counter");
    expect(upwardPkt.replyToRoleKeys).toEqual(["planner"]);

    const dupPkt = {
      ...upwardPkt,
      id: "mpkt_dup_1",
      fromRoleKey: "digest",
      evidence: [],
      upwardFeedback: false,
      stance: "agree" as const,
    };
    const selection = selectTopSynapsePackets([upwardPkt, dupPkt], 2);
    expect(selection.selected.length).toBe(1);
    expect(selection.selected[0]?.id).toBe(upwardPkt.id);
    expect(selection.estimatedSavedTokens).toBeGreaterThan(0);

    const agreePkts = [
      { ...upwardPkt, id: "p1", stance: "agree" as const, riskOrCounter: "" },
      { ...upwardPkt, id: "p2", stance: "agree" as const, riskOrCounter: "" },
      { ...upwardPkt, id: "p3", stance: "agree" as const, riskOrCounter: "" },
      { ...upwardPkt, id: "p4", stance: "propose" as const, riskOrCounter: "" },
    ];
    const earlyStop = evaluateMeetingEarlyStop({
      roundPackets: agreePkts,
      currentRound: 1,
      maxRounds: 3,
    });
    expect(earlyStop.shouldStop).toBe(true);
    expect(earlyStop.reason).toContain("비잔틴 합의 조기 종료");

    const backprop = backpropagateMeetingImportance({
      packets: [upwardPkt],
      finalSynthesisMd: "30일 롤링 워크포워드 분할과 표본 외 샤프지수 검증을 최종 채택합니다.",
    });
    expect(backprop.roleDeltas[0]?.importanceScore).toBeGreaterThan(0.5);
    expect(backprop.synapseEdges).toEqual([
      expect.objectContaining({ fromRoleKey: "coder", toRoleKey: "planner" }),
    ]);

    expect(
      isRecommendedForPruning({
        domainTag: "quant_data",
        roleKey: "digest",
        providerInstanceId: "gemini",
        modelSlug: "gemini-4-neon",
        importanceEma: 0.25,
        tokenEfficiencyEma: 0.5,
        adoptionRate: 0.2,
        sampleCount: DYLAN_MIN_SAMPLES_FOR_PRUNE,
        pruned: false,
        updatedAtMs: 1,
      }),
    ).toBe(true);
  });

  it("합석 회의실(감독자 진행·전원 동등·하위→상급 반론·조기종료·DyLAN 역전파·디스크 RAG 색인) → 지속 목표 자율 미션 승격 → 가지치기/삭제 전 과정을 완주한다", async () => {
    const projectId = ProjectId.make("proj_unified_roundtable");
    const boundThreadId = ThreadId.make("thread_unified_roundtable");
    const promptsSeen: Array<{ roleKey: string; prompt: string }> = [];

    const program = Effect.scoped(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const orchestrator = yield* makeMissionOrchestrator({
          sql,
          reconcileOnBoot: false,
          resolveProjectContext: () =>
            Effect.succeed({
              projectId,
              projectTitle: "UnifiedOpsRepo",
              workspaceRoot: ".",
              providers: TEST_PROVIDERS,
            }),
          runCrewStep: (step: MissionCrewStepInput) =>
            Effect.sync(() => {
              promptsSeen.push({ roleKey: step.role.roleKey, prompt: step.prompt });

              // 합석 회의실: 감독자 최종 종합 (Layer 3 MoA Aggregator)
              if (step.prompt.includes("최종 메타 통합자(MoA Aggregator)")) {
                return {
                  resultText:
                    "1. 핵심 합의 결론: 30일 워크포워드 분할과 수수료·슬리피지 반영 백테스팅을 채택합니다.\n2. 하위 역할군(개발실)의 과적합 경고 반론을 전면 반영했습니다.\n3. 최소 단계: 데이터 정제 -> 백테스트 -> 리스크 검증.",
                  exitCode: 0,
                } satisfies MissionCrewStepOutput;
              }
              // 합석 회의실: 동등 참가자 라운드 1
              if (step.prompt.includes("라운드 1/")) {
                if (step.role.roleKey === "coder") {
                  return {
                    resultText: `하위 실무 관점에서 상급 기획안에 반론을 제기합니다.\n<t3_synapse_packet>{"replyToRoleKeys":["planner"],"stance":"counter","claim":"30일 워크포워드 분할과 수수료 0.1% 반영이 필수입니다","evidence":["과적합 드로우다운 38% 감소","기존 OHLCV 재사용"],"riskOrCounter":"단일 구간 피팅 위험"}</t3_synapse_packet>`,
                    exitCode: 0,
                  } satisfies MissionCrewStepOutput;
                }
                return {
                  resultText: `검수 관점에서 동의 및 리스크 기준을 제시합니다.\n<t3_synapse_packet>{"replyToRoleKeys":["coder"],"stance":"agree","claim":"승률 50% 이상과 MDD 상한 검증을 완료 조건에 포함하자","evidence":["페이퍼 트레이딩 기준"],"riskOrCounter":""}</t3_synapse_packet>`,
                  exitCode: 0,
                } satisfies MissionCrewStepOutput;
              }
              // 합석 회의실: 동등 참가자 라운드 2 (전원 동의 → 비잔틴 조기 종료)
              if (step.prompt.includes("라운드 2/")) {
                return {
                  resultText: `최종 수정안에 전면 동의합니다.\n<t3_synapse_packet>{"replyToRoleKeys":["coder","reviewer"],"stance":"agree","claim":"워크포워드 분할과 수수료 반영안에 동의합니다","evidence":["전원 합의"],"riskOrCounter":""}</t3_synapse_packet>`,
                  exitCode: 0,
                } satisfies MissionCrewStepOutput;
              }

              // 승격된 Track A 지속 목표 자율 미션 실행
              return {
                resultText: `<t3_mission_result>{"status":"ok","summary3Lines":["합의안 기반 지속 목표 단계 완료","워크포워드 백테스트 검증 통과","회귀 없음"],"changedFiles":["src/backtest.ts"],"verificationCmd":"vp test","recommendation":"다음 단계 진행"}</t3_mission_result>`,
                exitCode: 0,
                changedFiles: ["src/backtest.ts"],
              } satisfies MissionCrewStepOutput;
            }),
        });

        // 1. 기본 크루 자동 시드 확인 + 미디어 모델(seedance-2.0-fast)이 절대 배정되지 않았는지 확인
        const initSnap = yield* orchestrator.getSnapshot({ projectId });
        expect(initSnap.crewRoles.length).toBe(4);
        expect(initSnap.crewRoles.every((r) => isMissionCodingCapableModel(r.modelSlug))).toBe(
          true,
        );
        expect(initSnap.crewRoles.find((r) => r.roleKey === "planner")?.orgTier).toBe("L1_LEAD");
        expect(initSnap.crewRoles.find((r) => r.roleKey === "coder")?.orgTier).toBe(
          "L2_SPECIALIST",
        );

        // Layer 0 희소 활성화 유닛 검증
        const sparseRes = selectSparseCrewForTopic({
          topic: "크라임 코인 백테스팅 전략 리서치",
          roles: initSnap.crewRoles,
          autoSparseSelect: true,
          maxParticipants: 2,
        });
        expect(sparseRes.domainTag).toBe("quant_data");
        expect(sparseRes.selectedRoleKeys.length).toBe(2);

        // 2. 감독자 주도 동등 합석 회의 시작 (감독자=planner, 참가자=coder, reviewer)
        const meeting = yield* orchestrator.startRoundtableMeeting({
          projectId,
          threadId: boundThreadId,
          topic: "크라임 코인 백테스팅 100→1000달러 1년 승률 50% 이상 전략 합석 논의",
          meetingStyle: "roundtable",
          moderatorRoleKey: "planner",
          participantRoleKeys: ["coder", "reviewer"],
          autoSparseSelect: false,
          maxRounds: 3,
        });
        yield* orchestrator.awaitMeeting(meeting.id);

        const afterMeetSnap = yield* orchestrator.getSnapshot({ projectId });
        const finishedMeeting = (afterMeetSnap.meetings ?? []).find((m) => m.id === meeting.id)!;
        expect(finishedMeeting.status).toBe("CONSENSUS_REACHED");
        expect(finishedMeeting.finalSynthesisMd).toContain("워크포워드");
        // R1에 반론 1건 → R2 전원 동의로 비잔틴 조기 종료 (3라운드까지 가지 않고 2라운드 종료!)
        expect(finishedMeeting.currentRound).toBe(2);
        expect(finishedMeeting.earlyStopReason).toContain("비잔틴 합의 조기 종료");
        expect(finishedMeeting.estimatedSavedTokens).toBeGreaterThan(0);

        // 동등성 헌장 주입 & 하위→상급 의견 전달(upwardFeedback=true) 검증!
        expect(promptsSeen.some((p) => p.prompt.includes(PEER_EQUALITY_CHARTER))).toBe(true);
        expect(
          finishedMeeting.packets.some(
            (pkt) => pkt.fromRoleKey === "coder" && pkt.upwardFeedback === true,
          ),
        ).toBe(true);

        // Layer 4 DyLAN 역전파 가중치(mission_synapse_weights) 저장 확인!
        const weights = afterMeetSnap.synapseWeights ?? [];
        expect(weights.length).toBeGreaterThanOrEqual(2);
        const coderWeight = weights.find((w) => w.roleKey === "coder")!;
        expect(coderWeight.sampleCount).toBeGreaterThanOrEqual(1);
        expect(coderWeight.importanceEma).toBeGreaterThan(0.4);

        // 디스크 상주 SQLite RAG 키워드 그래프(workspace_routing_nodes)에 회의 합의문 색인 확인!
        const ragNodes = yield* sql<{ canonical_key: string }>`
          SELECT canonical_key
          FROM workspace_routing_nodes
          WHERE canonical_key = ${`meeting:${meeting.id}`}
        `;
        expect(ragNodes.length).toBe(1);

        // 3. 합석 회의 합의안을 Track A '지속 목표(persistent_goal)' 자율 미션으로 1클릭 승격!
        const promotedMission = yield* orchestrator.promoteMeetingToMission({
          projectId,
          meetingId: meeting.id,
          executionStyle: "persistent_goal",
          requireFinalApproval: false,
        });
        expect(promotedMission.sourceMeetingId).toBe(meeting.id);
        expect(promotedMission.executionStyle).toBe("persistent_goal");

        yield* orchestrator.awaitMission(promotedMission.id);
        const afterPromoteSnap = yield* orchestrator.getSnapshot({ projectId });
        expect(afterPromoteSnap.missions.find((m) => m.id === promotedMission.id)?.status).toBe(
          "COMPLETED",
        );
        expect(
          (afterPromoteSnap.meetings ?? []).find((m) => m.id === meeting.id)?.linkedMissionId,
        ).toBe(promotedMission.id);

        // 4. DyLAN 가지치기 토글(setSynapsePruned) 검증
        const pruneRes = yield* orchestrator.setSynapsePruned({
          projectId,
          domainTag: coderWeight.domainTag,
          roleKey: coderWeight.roleKey,
          providerInstanceId: coderWeight.providerInstanceId,
          modelSlug: coderWeight.modelSlug,
          pruned: true,
        });
        expect(pruneRes.updated).toBe(true);
        const afterPruneSnap = yield* orchestrator.getSnapshot({ projectId });
        expect(
          (afterPruneSnap.synapseWeights ?? []).find(
            (w) => w.roleKey === coderWeight.roleKey && w.domainTag === coderWeight.domainTag,
          )?.pruned,
        ).toBe(true);

        // 5. 종료된 회의 삭제 검증
        const delRes = yield* orchestrator.deleteMeeting({
          projectId,
          meetingId: meeting.id,
        });
        expect(delRes.deleted).toBe(true);
        const afterDelSnap = yield* orchestrator.getSnapshot({ projectId });
        expect((afterDelSnap.meetings ?? []).some((m) => m.id === meeting.id)).toBe(false);
      }),
    ).pipe(Effect.provide(TestDbLayer));

    await Effect.runPromise(program);
  });
});
