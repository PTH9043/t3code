import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ProjectId, ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { makeSqlitePersistenceLive } from "../../persistence/Layers/Sqlite.ts";

const TestDbLayer = makeSqlitePersistenceLive(":memory:").pipe(Layer.provide(NodeServices.layer));
import {
  computeCacheHitRatePercent,
  computeErrorFingerprint,
  estimateMissionStepCostUsd,
  evaluateMissionCircuitBreaker,
} from "./MissionBudgetGuard.ts";
import { buildDefaultCrewRoles, resolveCrewExecutionTarget } from "./MissionModelRouter.ts";
import {
  assembleCacheAlignedMissionPrompt,
  estimateCachedPromptTokens,
} from "./MissionPromptCacheAssembler.ts";
import {
  buildCompactHandoffPacket,
  inspectCcrArtifactById,
  runToolOutputValve,
} from "./MissionToolOutputValve.ts";
import {
  classifyGoalRiskZeroToken,
  evaluateVerificationExitZeroToken,
} from "./MissionZeroTokenGate.ts";

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

describe("Mission Control 7대 토큰 최적화 아키텍처", () => {
  it("1. Pass-by-Reference: CompactHandoffPacket은 3줄×80자·비밀값 마스킹·400T 이하를 강제한다", () => {
    const packet = buildCompactHandoffPacket({
      missionId: "msn_test_1",
      hopCount: 1,
      reworkCycle: 0,
      fromRole: "planner",
      toRole: "coder",
      intent: "IMPLEMENT",
      summaryLines: [
        "아주 긴 줄을 넣었을 때 반드시 80자 이내로 절단되고 sk-proj-secret1234567890abcdef1234567890 같은 시크릿은 마스킹되어야 한다",
        "두 번째 요약 줄: 핵심 파일 2개만 수정",
        "세 번째 요약 줄: 단위 테스트 통과 기준",
        "네 번째 줄은 잘려야 함",
      ],
      worktreePath: "D:/repo/.t3/wt-1",
      changedFiles: ["src/a.ts", "src/b.ts"],
      artifactIds: ["ccr_0123456789abcdef"],
      verificationCriteria: ["tsgo 통과", "테스트 100% 통과"],
    });

    expect(packet.schemaVersion).toBe("handoff.v2");
    expect(packet.summary3Lines.length).toBe(3);
    expect(packet.summary3Lines[0]!.length).toBeLessThanOrEqual(80);
    expect(packet.summary3Lines.join("\n")).not.toContain("sk-proj-secret");
    expect(packet.estimatedTokens).toBeLessThanOrEqual(400);
  });

  it("2. Tool Output Valve: 성공은 ~20T 1줄 JSON, 실패는 ±15줄 + ccr_<16hex>, 300줄 초과 diff는 --stat 절단 및 원문 복원 가능", async () => {
    const program = Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      const passOut = yield* runToolOutputValve(sql, {
        threadId: "thread-valve-1",
        toolName: "run_tests",
        exitCode: 0,
        rawOutput: `${"PASS test case line\n".repeat(120)}All 42 tests passed`,
      });
      expect(passOut.status).toBe("PASS");
      expect(passOut.estimatedTokens).toBeLessThan(60);
      expect(passOut.artifactId).toMatch(/^ccr_[0-9a-f]{16}$/);

      const failLines = [
        ...Array.from({ length: 40 }, (_, i) => `setup line ${i}`),
        "AssertionError: expected 200 to equal 500",
        ...Array.from({ length: 40 }, (_, i) => `trailing line ${i}`),
      ].join("\n");
      const failOut = yield* runToolOutputValve(sql, {
        threadId: "thread-valve-1",
        toolName: "run_tests",
        exitCode: 1,
        rawOutput: failLines,
      });
      expect(failOut.status).toBe("FAIL");
      expect(failOut.errorHash).toBeTruthy();
      expect(failOut.artifactId).toMatch(/^ccr_[0-9a-f]{16}$/);
      expect(failOut.compactText.split("\n").length).toBeLessThanOrEqual(35);

      const restored = yield* inspectCcrArtifactById(sql, failOut.artifactId!);
      expect(restored).not.toBeNull();
      expect(restored?.content).toContain("AssertionError: expected 200 to equal 500");

      const bigDiff = [
        "diff --git a/src/foo.ts b/src/foo.ts",
        "@@ -1,3 +1,350 @@",
        ...Array.from({ length: 340 }, (_, i) => `+const v${i} = ${i};`),
      ].join("\n");
      const diffOut = yield* runToolOutputValve(sql, {
        threadId: "thread-valve-1",
        toolName: "git_diff",
        exitCode: 0,
        rawOutput: bigDiff,
        isDiff: true,
      });
      expect(diffOut.status).toBe("DIFF_STAT");
      expect(diffOut.compactText).toContain("[DIFF_STAT]");
      expect(diffOut.artifactId).toMatch(/^ccr_[0-9a-f]{16}$/);
    }).pipe(Effect.provide(TestDbLayer));

    await Effect.runPromise(program);
  });

  it("3. Prompt Caching 3단 조립기: Layer 1/2에 휘발성 timestamp 0건, 동일 Prefix 해시 캐시 히트, 12K 초과 시 THROTTLED 압축", () => {
    const role = {
      roleKey: "coder",
      displayName: "개발실",
      systemDirective:
        "코드를 정확히 수정하라.\nCurrentTime: 2026-11-26T18:00:00Z\n테스트를 통과시켜라.",
      allowedTools: [
        "write_file",
        "read_file",
        "apply_patch",
        "run_tests",
        "search_code",
        "extra_tool",
      ],
    };

    const turn1 = assembleCacheAlignedMissionPrompt({
      role,
      projectTitle: "T3",
      missionTitle: "로그인 버그 수정",
      goalPrompt: "세션 갱신 오류를 고친다",
      doneCriteria: ["단위 테스트 통과"],
      turnNumber: 1,
      nowIso: "2026-11-26T18:01:00.000Z",
    });
    const turn2 = assembleCacheAlignedMissionPrompt({
      role,
      projectTitle: "T3",
      missionTitle: "로그인 버그 수정",
      goalPrompt: "세션 갱신 오류를 고친다",
      doneCriteria: ["단위 테스트 통과"],
      turnNumber: 2,
      nowIso: "2026-11-26T18:02:00.000Z",
    });

    // 휘발성 timestamp는 Layer 1/2에서 제거되어 Layer 3로 이동됨
    expect(turn1.layer1ImmutablePrefix).not.toContain("2026-11-26T");
    expect(turn1.layer2MissionSemiStatic).not.toContain("2026-11-26T");
    expect(turn1.relocatedVolatileLinesCount).toBeGreaterThanOrEqual(1);
    // 도구는 최대 5개 알파벳 순 고정
    expect(turn1.allowedTools).toEqual([
      "apply_patch",
      "extra_tool",
      "read_file",
      "run_tests",
      "search_code",
    ]);
    // 턴 1과 턴 2의 Prefix 해시가 100% 일치하여 캐시 히트 발생!
    expect(turn1.prefixHash).toBe(turn2.prefixHash);
    const cached = estimateCachedPromptTokens({
      previousPrefixHash: turn1.prefixHash,
      currentPrefixHash: turn2.prefixHash,
      layer1Tokens: turn2.layer1Tokens,
      layer2Tokens: turn2.layer2Tokens,
    });
    expect(cached).toBe(turn2.layer1Tokens + turn2.layer2Tokens);
    expect(computeCacheHitRatePercent(turn2.totalTokens, cached)).toBeGreaterThan(60);

    // 12,000T 초과 입력 시 자동 압축(throttled=true)
    const huge = assembleCacheAlignedMissionPrompt({
      role,
      projectTitle: "T3",
      missionTitle: "대형 로그",
      goalPrompt: "분석".repeat(100),
      doneCriteria: ["완료"],
      compressedToolOutput: "로그 데이터 ".repeat(9000),
      turnNumber: 3,
      nowIso: "2026-11-26T18:03:00.000Z",
    });
    expect(huge.throttled).toBe(true);
    expect(huge.totalTokens).toBeLessThanOrEqual(12_500);
  });

  it("4. 4계층 서킷 브레이커 & 동일 에러 SHA-256 2회 반복 자동 차단 & Zero-Token 게이트", () => {
    const h1 = computeErrorFingerprint(
      "TypeError at 2026-11-26T18:00:01Z line 12: foo is undefined",
    );
    const h2 = computeErrorFingerprint(
      "TypeError at 2026-11-26T18:05:44Z line 19: foo is undefined",
    );
    expect(h1).toBe(h2);

    const tripped = evaluateMissionCircuitBreaker({
      turnInputTokens: 2000,
      turnCount: 3,
      hopCount: 2,
      reworkCount: 0,
      taskElapsedMs: 10_000,
      missionElapsedMs: 20_000,
      missionTotalTokens: 5000,
      missionTotalCostUsd: 0.05,
      missionBudgetLimitUsd: 1.5,
      dailySpentUsd: 0.1,
      dailyLimitUsd: 10.0,
      dailyRateLimitErrors: 0,
      repeatErrorCount: 2,
      killSwitchActive: false,
    });
    expect(tripped.state).toBe("TRIPPED_TO_INBOX");
    expect(tripped.trigger).toBe("REPEAT_ERROR_HASH");

    // 캐시 히트 시 비용 절감 확인
    const noCacheCost = estimateMissionStepCostUsd({
      modelTier: "TIER_S",
      promptTokens: 100_000,
      cachedTokens: 0,
      completionTokens: 1_000,
    });
    const highCacheCost = estimateMissionStepCostUsd({
      modelTier: "TIER_S",
      promptTokens: 100_000,
      cachedTokens: 90_000,
      completionTokens: 1_000,
    });
    expect(highCacheCost).toBeLessThan(noCacheCost * 0.35);

    // Zero-Token 결정론적 판정
    const passVerdict = evaluateVerificationExitZeroToken({
      command: "vp test",
      exitCode: 0,
      stdout: "ok",
      stderr: "",
    });
    expect(passVerdict.llmCalled).toBe(false);
    expect(passVerdict.passed).toBe(true);

    const risk = classifyGoalRiskZeroToken("운영 DB에서 DROP TABLE users 실행 후 git push");
    expect(risk.llmCalled).toBe(false);
    expect(risk.requiresTier2Approval).toBe(true);
    expect(risk.triggerReason).toBe("DESTRUCTIVE_OP");
  });

  it("5. 유동 모델 라우터: 이종 프로바이더 교차 검수 배정 및 즉석 모델 오버라이드 최우선 적용", () => {
    const providers = [
      makeProvider("codex", ProviderDriverKind.make("codex"), "Codex", "gpt-5.4"),
      makeProvider(
        "claudeAgent",
        ProviderDriverKind.make("claudeAgent"),
        "Claude",
        "claude-opus-4-6",
      ),
      makeProvider(
        "muse_cloud_1",
        ProviderDriverKind.make("museCloud"),
        "Muse Cloud (유나)",
        "muse-agent",
      ),
    ];
    const roles = buildDefaultCrewRoles({
      projectId: ProjectId.make("proj_1"),
      providers,
      nowMs: 1_700_000_000_000,
    });
    const coder = roles.find((r) => r.roleKey === "coder")!;
    const reviewer = roles.find((r) => r.roleKey === "reviewer")!;
    expect(reviewer.providerInstanceId).not.toBe(coder.providerInstanceId);

    // 즉석 오버라이드가 사용자 크루 설정보다 우선 적용됨
    const overridden = resolveCrewExecutionTarget({
      role: coder,
      providers,
      roleModelOverrides: [
        {
          roleKey: "coder",
          providerInstanceId: "muse_cloud_1",
          modelSlug: "muse-agent",
        },
      ],
    });
    expect(overridden.providerInstanceId).toBe("muse_cloud_1");
    expect(overridden.modelSlug).toBe("muse-agent");

    // 이종 검수: excludeProviderIds에 코더 프로바이더가 포함되면 자동 이종 프로바이더 선택
    const crossReview = resolveCrewExecutionTarget({
      role: { ...reviewer, providerInstanceId: "codex", modelSlug: "gpt-5.4" },
      providers,
      excludeProviderIds: new Set(["codex"]),
    });
    expect(crossReview.providerInstanceId).not.toBe("codex");
    expect(crossReview.crossModelDistinct).toBe(true);
  });
});
