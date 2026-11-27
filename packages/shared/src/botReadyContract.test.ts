import { describe, expect, it } from "vite-plus/test";
import { DEFAULT_GLOBAL_ASSISTANT_CONFIG, validateHandoffEnvelope } from "@t3tools/contracts";
import { parseAgentOrgChartJson, scoreGlobalAssistantBotReady } from "./botReadyContract.ts";

describe("botReadyContract & handoff validation", () => {
  it("scores a complete global assistant contract >= 90 and rejects leaked raw secrets", () => {
    const strong = scoreGlobalAssistantBotReady({
      ...DEFAULT_GLOBAL_ASSISTANT_CONFIG,
      enabled: true,
      personaName: "전속 비서실장",
      voiceAndTone: "품격 있고 단호한 25세 여성 전속 비서실장 해요체. 관료체 금지.",
      lengthPolicy: "질문 난이도에 맞춰 핵심부터 상세히 작성",
      explanationPolicy: "결론 우선, 사실 5단계 구분",
      corePrinciples: [
        "확인 완료·추정·미확인 사실을 분리 보고하고 근거 없으면 추측 금지",
        "외부 배포·삭제 전 반드시 사용자 승인 후 실행",
      ],
      outputSections: [
        {
          id: "s1",
          heading: "## [보고]",
          position: "start",
          required: true,
          constraint: "핵심 결론 우선",
        },
      ],
      domainPlaybooks: [
        {
          id: "d1",
          title: "SW·시스템",
          keywords: ["서버", "DB"],
          alwaysInclude: false,
          rules: "동시성 버그와 성능 병목을 수치 근거로 감사한다.",
        },
      ],
      styleExamples: [
        {
          situation: "보고 시작",
          goodExample: "## [보고]\n요청하신 검증을 [확인 완료]했어요.",
        },
      ],
    });
    expect(strong.totalScore).toBe(100);
    expect(strong.ready).toBe(true);
    expect(strong.recommendedAutonomy).toBe("L2 Approved Action");

    const leaked = scoreGlobalAssistantBotReady({
      ...DEFAULT_GLOBAL_ASSISTANT_CONFIG,
      enabled: true,
      personaName: "봇",
      voiceAndTone: "내 키는 sk-or-v1-1234567890abcdef1234567890 입니다.",
    });
    expect(leaked.ready).toBe(false);
    expect(leaked.dimensions.find((d) => d.id === "share_safe")?.passed).toBe(false);
  });

  it("imports valid agent-org-chart chart.json and blocks non-vault secrets policy", () => {
    const ok = parseAgentOrgChartJson(
      JSON.stringify({
        id: "engineering",
        roles: [
          { id: "lead", kind: "orchestrator", in_scope: ["triage"], out_of_scope: ["merge"] },
          { id: "verifier", kind: "specialist", in_scope: ["review"], out_of_scope: ["edit"] },
        ],
        handoffs: [{ from_role_id: "lead", to_role_id: "verifier", when: "PR opened" }],
        spawn: { do_not_fanout_until_first_goal: true, secrets: "vault_only" },
      }),
    );
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.chart.doNotFanoutUntilFirstGoal).toBe(true);
      expect(ok.chart.secretsPolicy).toBe("vault_only");
    }

    const badSecrets = parseAgentOrgChartJson(
      JSON.stringify({
        id: "unsafe",
        roles: [{ id: "lead", kind: "orchestrator" }],
        spawn: { secrets: "chat_plaintext" },
      }),
    );
    expect(badSecrets.ok).toBe(false);
  });

  it("validates 6-field handoff contracts and rejects raw tokens in refs", () => {
    const good = validateHandoffEnvelope({
      owner: "tester-codex",
      goal: "Run isolated verification on HostApprovalGate",
      refs: ["apps/server/src/orchestration/HostApprovalGate.ts"],
      write_policy: "read",
      done_when: "All 4 tests pass with 0 type errors",
      evidence_or_blocker: {
        observed_facts: ["Migration 104 registered"],
        assumptions: [],
        unverified_claims: ["Pending live run"],
      },
    });
    expect(good.valid).toBe(true);

    const leaky = validateHandoffEnvelope({
      owner: "tester-codex",
      goal: "Use Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload",
      refs: [],
      write_policy: "read",
      done_when: "Done",
      evidence_or_blocker: { observed_facts: [], assumptions: [], unverified_claims: [] },
    });
    expect(leaky.valid).toBe(false);
  });
});
