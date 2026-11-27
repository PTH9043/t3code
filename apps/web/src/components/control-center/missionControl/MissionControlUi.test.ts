import {
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type MissionRun,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  EXECUTION_STYLE_META,
  MEETING_STANCE_META,
  MEETING_STATUS_META,
  MEETING_STYLE_META,
  ORG_TIER_META,
  QUICK_MISSION_PRESETS,
  buildMissionProviderOptions,
  filterMissionsByStatus,
  formatTokensCompact,
  isMissionCodingCapableModel,
  isMissionTerminable,
} from "./missionControlUi.logic";

function makeProvider(
  instanceId: string,
  driver: string,
  displayName: string,
  enabled: boolean,
  models: Array<{ slug: string; name: string }>,
): ServerProvider {
  return {
    provider: ProviderDriverKind.make(driver),
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make(driver),
    displayName,
    enabled,
    installed: true,
    version: "1.0.0",
    status: enabled ? "ready" : "disabled",
    auth: { status: "authenticated" },
    checkedAt: "2026-11-26T00:00:00.000Z",
    models: models.map((m) => ({
      slug: m.slug,
      name: m.name,
      isCustom: false,
      isDefault: false,
      supportsReasoning: true,
    })),
    slashCommands: [],
    skills: [],
  } as unknown as ServerProvider;
}

function makeMission(id: string, status: MissionRun["status"]): MissionRun {
  return {
    id,
    projectId: ProjectId.make("proj_1"),
    threadId: ThreadId.make(`thread_${id}`),
    title: `미션 ${id}`,
    goalPrompt: "목표",
    doneCriteria: [],
    status,
    activeRoleId: null,
    plannerTaskId: null,
    activeTaskId: null,
    worktreePath: null,
    worktreeBranch: null,
    assignedRoles: ["planner", "coder", "reviewer"],
    dagSteps: [],
    hopCount: 1,
    reworkCount: 0,
    turnCount: 1,
    totalTokensUsed: 1500,
    totalCachedTokens: 900,
    totalCostUsd: 0.01,
    budgetLimitUsd: 1.5,
    circuitBreakerState: "OK",
    lastErrorHash: null,
    repeatErrorCount: 0,
    leaseOwner: "host",
    leaseEpoch: 1,
    leaseExpiresAtMs: null,
    digestLine: null,
    createdAtMs: 1_700_000_000_000,
    updatedAtMs: 1_700_000_000_000,
    completedAtMs: null,
  };
}

describe("Mission Control UI 로직 (유동 모델 선택·필터·프리셋)", () => {
  it("등록된 활성 프로바이더 계정과 모델만 유동 선택지 목록으로 구성한다", () => {
    const providers = [
      makeProvider("codex", "codex", "Codex", true, [{ slug: "gpt-5.4", name: "GPT-5.4" }]),
      makeProvider("muse_cloud_yuna", "museCloud", "Muse Cloud (유나)", true, [
        { slug: "muse-agent", name: "Muse Agent" },
        { slug: "muse-chat", name: "Muse Chat" },
      ]),
      makeProvider("disabled_acc", "claudeAgent", "비활성 클로드", false, [
        { slug: "claude-opus-4-6", name: "Opus 4.6" },
      ]),
    ];

    const options = buildMissionProviderOptions(providers);
    expect(options.length).toBe(2);
    expect(options.map((o) => o.providerInstanceId)).toContain("muse_cloud_yuna");
    expect(options.find((o) => o.providerInstanceId === "muse_cloud_yuna")?.models.length).toBe(2);
    expect(options.map((o) => o.providerInstanceId)).not.toContain("disabled_acc");
  });

  it("미션 상태 필터 칩(전체/일하는 중/결재 대기/완료)이 정확히 동작한다", () => {
    const missions = [
      makeMission("m1", "EXECUTING"),
      makeMission("m2", "AWAITING_APPROVAL"),
      makeMission("m3", "COMPLETED"),
      makeMission("m4", "VERIFYING"),
    ];
    expect(filterMissionsByStatus(missions, "all").length).toBe(4);
    expect(filterMissionsByStatus(missions, "active").map((m) => m.id)).toEqual(["m1", "m4"]);
    expect(filterMissionsByStatus(missions, "approval").map((m) => m.id)).toEqual(["m2"]);
    expect(filterMissionsByStatus(missions, "completed").map((m) => m.id)).toEqual(["m3"]);
  });

  it("토큰 포맷 및 4종 빠른 프리셋이 정상 정의되어 있다", () => {
    expect(formatTokensCompact(850)).toBe("850");
    expect(formatTokensCompact(12_400)).toBe("12.4K");
    expect(formatTokensCompact(1_250_000)).toBe("1.25M");
    expect(QUICK_MISSION_PRESETS.length).toBe(4);
  });

  it("비디오·이미지·임베딩 등 비코딩 미디어 모델(wan-v3.0-video-prime, seedance-2.0-fast 등)을 코딩 크루 선택지에서 자동 제외한다", () => {
    expect(isMissionCodingCapableModel("t3_antseed/alibaba/wan-v3.0-video-prime")).toBe(false);
    expect(isMissionCodingCapableModel("t3_antseed/bytedance/seedance-2.0-fast")).toBe(false);
    expect(isMissionCodingCapableModel("openai/sora-2-video")).toBe(false);
    expect(isMissionCodingCapableModel("claude-opus-5-5")).toBe(true);
    expect(isMissionCodingCapableModel("grok-4.7")).toBe(true);
    expect(isMissionCodingCapableModel("t3_personal_orchestrator/personal-orchestrator-4b")).toBe(
      true,
    );

    const providers = [
      makeProvider("antseed_local", "opencode", "Antseed Gateway", true, [
        { slug: "t3_antseed/alibaba/wan-v3.0-video-prime", name: "alibaba/wan-v3.0-video-prime" },
        { slug: "t3_antseed/bytedance/seedance-2.0-fast", name: "bytedance/seedance-2.0-fast" },
        { slug: "t3_antseed/deepseek/deepseek-v4.1-flash", name: "deepseek/deepseek-v4.1-flash" },
      ]),
    ];
    const options = buildMissionProviderOptions(providers);
    expect(options[0]?.models.map((m) => m.slug)).toEqual([
      "t3_antseed/deepseek/deepseek-v4.1-flash",
    ]);
  });

  it("통합 조직 계층·지속 목표·합석 회의 UI 메타데이터가 누락 없이 정의되어 있다", () => {
    expect(ORG_TIER_META.L0_COMMANDER.label).toContain("L0");
    expect(ORG_TIER_META.L1_LEAD.label).toContain("L1");
    expect(ORG_TIER_META.L2_SPECIALIST.label).toContain("L2");
    expect(ORG_TIER_META.L3_SUPPORT.label).toContain("L3");
    expect(EXECUTION_STYLE_META.hierarchical_ops.label).toBeTruthy();
    expect(EXECUTION_STYLE_META.persistent_goal.label).toBeTruthy();
    expect(MEETING_STYLE_META.roundtable.label).toBeTruthy();
    expect(MEETING_STYLE_META.blind_audit.label).toBeTruthy();
    expect(MEETING_STATUS_META.COMPLETED.label).toBeTruthy();
    expect(MEETING_STANCE_META.counter.label).toBeTruthy();
  });

  it("실행 중·결재 대기 미션은 모두 종료 가능하고 완료·실패·중단 미션은 종료 대상에서 제외한다", () => {
    expect(isMissionTerminable("CREATED")).toBe(true);
    expect(isMissionTerminable("PLANNING")).toBe(true);
    expect(isMissionTerminable("EXECUTING")).toBe(true);
    expect(isMissionTerminable("VERIFYING")).toBe(true);
    expect(isMissionTerminable("AWAITING_APPROVAL")).toBe(true);
    expect(isMissionTerminable("COMPLETED")).toBe(false);
    expect(isMissionTerminable("FAILED")).toBe(false);
    expect(isMissionTerminable("CANCELLED")).toBe(false);
  });
});
