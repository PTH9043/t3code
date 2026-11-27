import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_GLOBAL_ASSISTANT_ENFORCEMENT,
  type GlobalAssistantConfig,
  verifyGlobalOutputContract,
} from "./globalAssistant.ts";

const executiveConfig: GlobalAssistantConfig = {
  enabled: true,
  defaultModelSelection: null,
  personaName: "전속 비서실장",
  preset: "professional",
  voiceAndTone: "냉철하고 전문적인 어조",
  styleExamples: [],
  corePrinciples: ["사실과 추정을 구분한다."],
  lengthPolicy: "",
  explanationPolicy: "",
  outputSections: [
    {
      id: "section-1",
      heading: "## [보고]",
      position: "start",
      required: true,
      constraint: "핵심 결론과 근거를 먼저 제시한다.",
    },
    {
      id: "section-2",
      heading: "## [비서실장의 조언]",
      position: "end",
      required: true,
      constraint: "모든 답변 맨 마지막에 반드시 단 한 줄로만 작성한다.",
      maxLines: 1,
    },
  ],
  domainPlaybooks: [],
  extraInstructions: "",
  enforcement: DEFAULT_GLOBAL_ASSISTANT_ENFORCEMENT,
  characterOverridesVoice: false,
};

const sampleQuestionCardBlock = [
  "아래 질문 카드에서 선택해 주세요.",
  "",
  "```json",
  JSON.stringify({
    questions: [
      {
        header: "실행 방식",
        question: "어느 방안으로 진행할까요?",
        options: [
          { label: "방안 1 (권장)", description: "빠른 수정" },
          { label: "방안 2", description: "전체 재구성" },
        ],
      },
    ],
  }),
  "```",
].join("\n");

describe("verifyGlobalOutputContract", () => {
  it("passes when a trailing text-question JSON card follows a valid 1-line advice section", () => {
    const reply = [
      "## [보고]",
      "요청하신 분석을 마쳤습니다.",
      "",
      "## [비서실장의 조언]",
      "영향 범위가 적은 방안 1부터 적용하십시오.",
      "",
      sampleQuestionCardBlock,
    ].join("\n");

    expect(verifyGlobalOutputContract(executiveConfig, reply)).toEqual({
      checked: true,
      passed: true,
      violations: [],
    });
  });

  it("skips contract verification on pure question-card-only short confirmation turns", () => {
    expect(verifyGlobalOutputContract(executiveConfig, sampleQuestionCardBlock)).toEqual({
      checked: false,
      passed: true,
      violations: [],
    });

    const shortConfirmTurn = `적용 범위를 먼저 확인하겠습니다.\n\n${sampleQuestionCardBlock}`;
    expect(verifyGlobalOutputContract(executiveConfig, shortConfirmTurn)).toEqual({
      checked: false,
      passed: true,
      violations: [],
    });
  });

  it("still flags missing advice when a full report with ## [보고] omits ## [비서실장의 조언] before a question card", () => {
    const reply = [
      "## [보고]",
      "핵심 원인 3가지를 정리했습니다.",
      "",
      sampleQuestionCardBlock,
    ].join("\n");

    const result = verifyGlobalOutputContract(executiveConfig, reply);
    expect(result.checked).toBe(true);
    expect(result.passed).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toMatchObject({
      heading: "## [비서실장의 조언]",
      reason: "missing-heading",
    });
  });

  it("returns unchecked/passed for API Error and safety refusal messages", () => {
    const errorMessages = [
      "API Error: Opus 5.5's safeguards flagged this session (https://www.anthropic.com/legal/aup). Details: `[cyber]`",
      "API Error: 429 rate_limit_error",
      "Anthropic 안전장치가 이 요청을 거절했습니다 [cyber]. 새 대화를 열거나 다른 모델을 선택해 주세요.",
    ];

    for (const message of errorMessages) {
      expect(verifyGlobalOutputContract(executiveConfig, message)).toEqual({
        checked: false,
        passed: true,
        violations: [],
      });
    }
  });

  it("accepts mild markdown heading variants and trailing horizontal rules without false warnings", () => {
    const variants = [
      "## [보고]\n분석 완료.\n\n### [비서실장의 조언]\n테스트를 먼저 고정하십시오.",
      "## [보고]\n분석 완료.\n\n## 비서실장의 조언\n테스트를 먼저 고정하십시오.\n---",
      "## [보고]\n분석 완료.\n\n**[비서실장의 조언]**\n테스트를 먼저 고정하십시오.\n***",
      "## 보고\n분석 완료.\n\n## **[비서실장의 조언]**\n테스트를 먼저 고정하십시오.",
    ];

    for (const reply of variants) {
      expect(verifyGlobalOutputContract(executiveConfig, reply)).toEqual({
        checked: true,
        passed: true,
        violations: [],
      });
    }
  });

  it("still catches empty advice body, genuinely missing advice, and multi-line advice", () => {
    const emptyAdvice = "## [보고]\n분석 완료.\n\n## [비서실장의 조언]\n---\n";
    const emptyResult = verifyGlobalOutputContract(executiveConfig, emptyAdvice);
    expect(emptyResult.passed).toBe(false);
    expect(emptyResult.violations[0]?.reason).toBe("empty-content");

    const plainMentionNotHeading = "## [보고]\n비서실장의 조언을 참고해서 수정했습니다.";
    const missingResult = verifyGlobalOutputContract(executiveConfig, plainMentionNotHeading);
    expect(missingResult.passed).toBe(false);
    expect(missingResult.violations[0]?.reason).toBe("missing-heading");

    const twoLines =
      "## [보고]\n분석 완료.\n\n## [비서실장의 조언]\n첫 번째 줄입니다.\n두 번째 줄입니다.";
    const lineResult = verifyGlobalOutputContract(executiveConfig, twoLines);
    expect(lineResult.passed).toBe(false);
    expect(lineResult.violations[0]?.reason).toBe("exceeds-max-lines");
  });
});
