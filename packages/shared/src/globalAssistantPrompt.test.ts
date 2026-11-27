import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_GLOBAL_ASSISTANT_ENFORCEMENT,
  DEFAULT_SERVER_SETTINGS,
  deriveGlobalAssistantFromLegacyResponseStyle,
  resolveEffectiveGlobalAssistant,
  resolveResponseStyle,
  resolveSubordinateTeam,
  ThreadId,
  ProviderInstanceId,
  verifyGlobalOutputContract,
} from "@t3tools/contracts";
import {
  buildOutputContractRepairPrompt,
  compileGlobalAssistantPrompts,
} from "./globalAssistantPrompt.ts";
import { applyServerSettingsPatch } from "./serverSettings.ts";

const sampleLegacyStyle = {
  preset: "professional" as const,
  tone: "냉철하고 전문적인 전속 비서실장 어조로 보고합니다.",
  length: "질문 난이도에 맞춰 핵심부터 상세히 작성합니다.",
  explanation: "서론 없이 결론부터 제시하고 사실 상태를 구분합니다.",
  instructions: `[절대 운영 원칙]
1. 객관성·반대 검증: 동의 전 반드시 반대 근거와 위험을 먼저 검토한다.
2. 상태 분리: 구현 완료와 검증 완료를 구분한다.

[산하 전문 본부]
- A(투자·자산): 주식·재무·밸류에이션 및 리스크 평가
- B(SW·시스템): C++·서버·DB·동시성·성능 최적화

[최종 응답 형식]
- ## [보고]: 핵심 결론과 근거를 먼저 제시한다.
- ## [비서실장의 조언]: 모든 답변 맨 마지막에 반드시 단 한 줄로만 작성한다.`,
};

describe("Unified Global Assistant contract, compiler & verifier", () => {
  it("losslessly upcasts legacy globalResponseStyle into structured principles, playbooks, and output sections", () => {
    const derived = deriveGlobalAssistantFromLegacyResponseStyle(sampleLegacyStyle);
    expect(derived).not.toBeNull();
    expect(derived!.corePrinciples).toHaveLength(2);
    expect(derived!.domainPlaybooks.map((p) => p.title)).toEqual(["A(투자·자산)", "B(SW·시스템)"]);
    expect(derived!.outputSections).toHaveLength(2);
    expect(derived!.outputSections[0]).toMatchObject({
      heading: "## [보고]",
      position: "start",
      required: true,
    });
    expect(derived!.outputSections[1]).toMatchObject({
      heading: "## [비서실장의 조언]",
      position: "end",
      required: true,
      maxLines: 1,
    });
  });

  it("compiles Tier A system contract, topic-matched Tier B playbooks, Tier C recency anchor, and subordinate principles", () => {
    const derived = deriveGlobalAssistantFromLegacyResponseStyle(sampleLegacyStyle)!;
    const withExamples = {
      ...derived,
      personaName: "전속 비서실장",
      styleExamples: [
        {
          situation: "보고 시작",
          goodExample: "결론부터 보고드립니다. 원인은 방별 오버라이드 충돌입니다.",
          badExample: "안녕하세요! 무엇을 도와드릴까요?",
        },
      ],
    };

    const swCompiled = compileGlobalAssistantPrompts(withExamples, {
      userMessage: "서버 동시성 버그와 DB 성능을 분석해줘",
    });
    expect(swCompiled.active).toBe(true);
    expect(swCompiled.suppressDefaultNaturalWriting).toBe(true);
    expect(swCompiled.systemInstructions).toContain('<t3_global_contract priority="mandatory">');
    expect(swCompiled.systemInstructions).toContain("전속 비서실장");
    expect(swCompiled.systemInstructions).toContain("모범 말투");
    expect(swCompiled.matchedPlaybooks.map((p) => p.title)).toEqual(["B(SW·시스템)"]);
    expect(swCompiled.playbookBlock).toContain("B(SW·시스템)");
    expect(swCompiled.playbookBlock).not.toContain("A(투자·자산)");
    expect(swCompiled.recencyAnchor).toContain("<t3_turn_contract_anchor>");
    expect(swCompiled.recencyAnchor).toContain("## [보고]");
    expect(swCompiled.recencyAnchor).toContain("## [비서실장의 조언]");
    expect(swCompiled.systemInstructions).toContain("[필수 출력 골격");
    expect(swCompiled.subordinatePrinciplesBlock).toContain("<t3_global_principles>");
    expect(swCompiled.subordinatePrinciplesBlock).toContain("객관성·반대 검증");

    // Providers that narrate between tool calls are held to the skeleton once, at the end.
    const interimRule = "도구 호출 사이의 중간 진행 메모는 답변이 아닙니다.";
    expect(swCompiled.systemInstructions).toContain(
      "짧은 답변·확인 질문·자동 복구 응답 포함 예외 없이",
    );
    expect(swCompiled.systemInstructions).not.toContain(interimRule);
    expect(swCompiled.recencyAnchor).not.toContain(interimRule);
    expect(swCompiled.recencyAnchor).toContain("짧은 최종 보고·차단 사유 안내 포함");
    expect(swCompiled.recencyAnchor).toContain("미완료 작업이나 남은 계획 단계가 있으면");
    expect(swCompiled.recencyAnchor).toContain("텍스트 질문 JSON 코드 블록을 함께 출력할 때도");
    expect(swCompiled.recencyAnchor).toContain("`## [비서실장의 조언]`");
    const finalOnly = compileGlobalAssistantPrompts(withExamples, {
      userMessage: "서버 동시성 버그와 DB 성능을 분석해줘",
      finalAnswerOnly: true,
    });
    expect(finalOnly.systemInstructions).toContain("턴을 마치는 마지막 답변 한 번에 적용");
    expect(finalOnly.systemInstructions).toContain(
      "짧은 답변·확인 질문·자동 복구 응답도 예외 없이",
    );
    expect(finalOnly.systemInstructions).not.toContain("진행 보고·자동 복구 응답 포함 예외 없이");
    expect(finalOnly.systemInstructions).toContain(interimRule);
    expect(finalOnly.recencyAnchor).toContain(interimRule);
    expect(finalOnly.recencyAnchor).toContain("짧은 최종 보고·차단 사유 안내 포함");
    expect(finalOnly.recencyAnchor).toContain("## [비서실장의 조언]");

    const investCompiled = compileGlobalAssistantPrompts(withExamples, {
      userMessage: "이 주식의 밸류에이션과 리스크를 검토해줘",
    });
    expect(investCompiled.matchedPlaybooks.map((p) => p.title)).toEqual(["A(투자·자산)"]);
  });

  it("verifies output sections in 0ms and builds concise repair instructions on violations", () => {
    const config = deriveGlobalAssistantFromLegacyResponseStyle(sampleLegacyStyle)!;

    const validReply = `## [보고]\n핵심 원인 분석 완료.\n\n## [비서실장의 조언]\n먼저 단위 테스트부터 고정하십시오.`;
    expect(verifyGlobalOutputContract(config, validReply)).toEqual({
      checked: true,
      passed: true,
      violations: [],
    });

    const missingAdvice = `## [보고]\n핵심 원인 분석 완료.`;
    const missingCheck = verifyGlobalOutputContract(config, missingAdvice);
    expect(missingCheck.passed).toBe(false);
    expect(missingCheck.violations.some((v) => v.reason === "missing-heading")).toBe(true);

    const twoLineAdvice = `## [보고]\n분석 완료.\n\n## [비서실장의 조언]\n첫 번째 줄.\n두 번째 줄.`;
    const lineCheck = verifyGlobalOutputContract(config, twoLineAdvice);
    expect(lineCheck.passed).toBe(false);
    expect(lineCheck.violations.some((v) => v.reason === "exceeds-max-lines")).toBe(true);

    const repairPrompt = buildOutputContractRepairPrompt(config, lineCheck);
    expect(repairPrompt).toContain("## [비서실장의 조언]");
    expect(repairPrompt).toContain("최대 1줄");
  });

  it("enforces global-only resolution and clears stale per-room overrides when saving globalAssistant", () => {
    const roomId = ThreadId.make("room-1");
    const globalStyle = sampleLegacyStyle;
    const oldRoomStyle = {
      preset: "friendly" as const,
      tone: "옛 방 말투",
      length: "짧게",
      explanation: "",
      instructions: "",
    };
    expect(
      resolveResponseStyle(
        { globalResponseStyle: globalStyle, threadResponseStyles: { [roomId]: oldRoomStyle } },
        roomId,
      ).style,
    ).toEqual(globalStyle);

    const globalMember = {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-6.2-sol",
      role: "worker" as const,
    };
    const roomMember = {
      instanceId: ProviderInstanceId.make("opencode"),
      model: "deepseek",
      role: "scout" as const,
    };
    expect(
      resolveSubordinateTeam(
        {
          globalSubordinateTeam: [globalMember],
          threadSubordinateTeams: { [roomId]: [roomMember] },
        },
        roomId,
      ),
    ).toEqual({ source: "global", members: [globalMember] });

    const next = applyServerSettingsPatch(
      {
        ...DEFAULT_SERVER_SETTINGS,
        threadResponseStyles: { [roomId]: oldRoomStyle },
        threadSubordinateTeams: { [roomId]: [roomMember] },
        threadAssistantProfiles: { [roomId]: { name: "옛 비서", instructions: "옛 지시" } },
      },
      {
        globalAssistant: {
          enabled: true,
          defaultModelSelection: null,
          personaName: "비서실장",
          preset: "professional",
          voiceAndTone: "단호하게",
          styleExamples: [],
          corePrinciples: ["원칙 1"],
          lengthPolicy: "상세",
          explanationPolicy: "결론 우선",
          outputSections: [],
          domainPlaybooks: [],
          extraInstructions: "",
          enforcement: DEFAULT_GLOBAL_ASSISTANT_ENFORCEMENT,
          characterOverridesVoice: false,
        },
      },
    );
    expect(next.threadResponseStyles).toEqual({});
    expect(next.threadSubordinateTeams).toEqual({});
    expect(next.threadAssistantProfiles).toEqual({});
    expect(resolveEffectiveGlobalAssistant(next)?.personaName).toBe("비서실장");
    expect(next.globalResponseStyle?.tone).toBe("단호하게");
  });

  it("integrates activePersonaId, 9-axis traitGenome, situation mode, PAD delta, and recalled memories into compiled prompts", () => {
    const derived = deriveGlobalAssistantFromLegacyResponseStyle(sampleLegacyStyle)!;
    const compiled = compileGlobalAssistantPrompts(
      {
        ...derived,
        activePersonaId: "preset-pacemaker-soyul",
        personaName: "동료 한소율",
        enableLivingAffectEngine: true,
        traitGenome: {
          ocean: {
            openness: 0.65,
            conscientiousness: 0.9,
            extraversion: 0.5,
            agreeableness: 0.6,
            neuroticism: -0.2,
          },
          koreanPragmatics: {
            firmness: 0.85,
            warmth: 0.8,
            wit: 0.55,
            intimacy: 0.85,
          },
        },
      },
      {
        userMessage: "이미 많이 투자했는데 아까워서 물타기 더 할까?",
        padDelta: { p: -0.2, a: 0.25, d: 0.3 },
        humanFacts: ["사용자는 리스크 한도를 엄격히 지킨다"],
        personaMemories: ["지난주 과매수 경고를 함께 점검했다"],
      },
    );

    expect(compiled.activePersonaId).toBe("preset-pacemaker-soyul");
    expect(compiled.livingAffectActive).toBe(true);
    expect(compiled.situationMode).toBe("SUNK_COST_BRAKE");
    expect(compiled.systemInstructions).toContain("활성 페르소나 ID: preset-pacemaker-soyul");
    expect(compiled.systemInstructions).toContain("[성격 기질 및 대화 호흡 (비수치 내면화)]");
    expect(compiled.recencyAnchor).toContain("상황·정서 호흡(SUNK_COST_BRAKE)");
    expect(compiled.recencyAnchor).toContain("사용자 맥락: 사용자는 리스크 한도를 엄격히 지킨다");
    expect(compiled.recencyAnchor).toContain("페르소나 기억: 지난주 과매수 경고를 함께 점검했다");
    expect(compiled.systemInstructions).toContain("Scope Firewall");
  });

  it("caps Tier A styleExamples to 2 concise exemplars and strips decorative divider lines from extraInstructions", () => {
    const derived = deriveGlobalAssistantFromLegacyResponseStyle(sampleLegacyStyle)!;
    const compiled = compileGlobalAssistantPrompts({
      ...derived,
      personaName: "소율",
      styleExamples: [
        { situation: "s1", goodExample: "첫 번째 예시입니다.", badExample: "안 좋은 1" },
        { situation: "s2", goodExample: "두 번째 예시입니다.", badExample: "안 좋은 2" },
        { situation: "s3", goodExample: "세 번째 예시는 생략됩니다.", badExample: "안 좋은 3" },
      ],
      extraInstructions: "핵심 규칙 1\n==========\n\n\n\n핵심 규칙 2\n----------",
    });

    expect(compiled.systemInstructions).toContain("첫 번째 예시입니다.");
    expect(compiled.systemInstructions).toContain("두 번째 예시입니다.");
    expect(compiled.systemInstructions).not.toContain("세 번째 예시는 생략됩니다.");
    expect(compiled.systemInstructions).not.toContain("==========");
    expect(compiled.systemInstructions).not.toContain("----------");
  });
});
