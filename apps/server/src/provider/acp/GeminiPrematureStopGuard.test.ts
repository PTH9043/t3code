import { describe, expect, it } from "vite-plus/test";
import {
  evaluatePrematureStopGuard,
  extractTailParagraphs,
  normalizePrematureStopSignature,
  stripCodeAndQuotesForStopGuard,
} from "./GeminiPrematureStopGuard.ts";

describe("GeminiPrematureStopGuard", () => {
  // Scenario 1: Signal A — progress predicate + future completion promise
  it("triggers promise_pattern when tail contains both progress status and future completion promise", () => {
    const result = evaluatePrematureStopGuard({
      assistantText:
        "빌드 작업을 시작했습니다.\n\n현재 백그라운드에서 실행 중입니다. 완료되는 대로 결과를 보고드리겠습니다.",
      planStatuses: [],
      hasPendingApproval: false,
      isAborted: false,
      retryCount: 0,
      previousSignatures: [],
    });

    expect(result.shouldContinue).toBe(true);
    expect(result.reason).toBe("promise_pattern");
    expect(result.activityLog).toBe("조기 종료 감지 → 자동 계속 실행 (1/3)");
    expect(result.repairPrompt).toBeDefined();
    expect(result.normalizedSignature.length).toBeGreaterThan(0);
  });

  // Scenario 2 (Edge #1): Signal B alone — incomplete plan uses conditional repair prompt
  it("triggers incomplete_plan with conditional repair prompt when plan steps remain pending/in_progress", () => {
    const result = evaluatePrematureStopGuard({
      assistantText: "## [보고]\n수정 작업과 테스트 실행을 모두 마쳤습니다.",
      planStatuses: ["completed", "in_progress"],
      hasPendingApproval: false,
      isAborted: false,
      retryCount: 1,
      previousSignatures: [],
    });

    expect(result.shouldContinue).toBe(true);
    expect(result.reason).toBe("incomplete_plan");
    expect(result.activityLog).toBe("조기 종료 감지 → 자동 계속 실행 (2/3)");
    expect(result.repairPrompt).toContain("이미 모든 작업·검증을 마쳤다면");
    expect(result.repairPrompt).toContain("플랜 상태만 완료");
  });

  it("recognizes camelCase inProgress and pending plan statuses", () => {
    const inProgressResult = evaluatePrematureStopGuard({
      assistantText: "1단계 정리 완료.",
      planStatuses: ["completed", "inProgress"],
      hasPendingApproval: false,
      isAborted: false,
      retryCount: 0,
      previousSignatures: [],
    });
    expect(inProgressResult.shouldContinue).toBe(true);
    expect(inProgressResult.reason).toBe("incomplete_plan");

    const pendingResult = evaluatePrematureStopGuard({
      assistantText: "1단계 정리 완료.",
      planStatuses: ["completed", "pending"],
      hasPendingApproval: false,
      isAborted: false,
      retryCount: 0,
      previousSignatures: [],
    });
    expect(pendingResult.shouldContinue).toBe(true);
    expect(pendingResult.reason).toBe("incomplete_plan");
  });

  // Scenario 3 (Edge #2): "잠시만 기다려 주세요" is NOT excluded; acts as auxiliary signal
  it("does not exclude '잠시만 기다려 주세요' and treats it as an auxiliary progress/wait signal", () => {
    const withProgress = evaluatePrematureStopGuard({
      assistantText: "테스트를 실행 중입니다. 잠시만 기다려 주세요.",
      planStatuses: [],
      hasPendingApproval: false,
      isAborted: false,
      retryCount: 0,
      previousSignatures: [],
    });
    expect(withProgress.shouldContinue).toBe(true);
    expect(withProgress.reason).toBe("promise_pattern");

    const withPromise = evaluatePrematureStopGuard({
      assistantText: "잠시만 기다려 주세요. 10초 뒤에 결과를 보고드리겠습니다.",
      planStatuses: [],
      hasPendingApproval: false,
      isAborted: false,
      retryCount: 0,
      previousSignatures: [],
    });
    expect(withPromise.shouldContinue).toBe(true);
    expect(withPromise.reason).toBe("promise_pattern");
  });

  // Scenario 4: Stage 3 exclusions — question mark, Korean confirmation request, permission/env block
  it("excludes user questions, declarative Korean confirmation requests, and permission/env blocks", () => {
    const cases = [
      "이 설정으로 진행할까요?",
      "적용할 환경 변수를 알려주시면 바로 반영하겠습니다.",
      '아래 질문 카드에서 선택해 주세요.\n\n```json\n{"questions":[{"header":"방안","question":"선택","options":[{"label":"A","description":"설명"}]}]}\n```',
      "변경 사항을 확인해 주세요.",
      "원하시는 옵션을 알려주시기 바랍니다.",
      "파일 쓰기 권한이 없어 작업을 멈췄습니다. 진행할 수 없습니다.",
      "원격 저장소에 접근할 수 없어 중단했습니다.",
      "API Error: Opus 5.5's safeguards flagged this session.",
    ];

    for (const assistantText of cases) {
      const result = evaluatePrematureStopGuard({
        assistantText,
        planStatuses: ["in_progress"],
        hasPendingApproval: false,
        isAborted: false,
        retryCount: 0,
        previousSignatures: [],
      });
      expect(result.shouldContinue, `should NOT continue for: ${assistantText}`).toBe(false);
    }
  });

  // Scenario 5 (Edge #3): Stage 5 near-duplicate loop escape ("10초" -> "15초")
  it("escapes near-duplicate loops when only digits, spaces, or punctuation change", () => {
    const first = evaluatePrematureStopGuard({
      assistantText: "빌드 진행 중입니다. 10초 뒤 결과를 보고드리겠습니다.",
      planStatuses: ["in_progress"],
      hasPendingApproval: false,
      isAborted: false,
      retryCount: 0,
      previousSignatures: [],
    });
    expect(first.shouldContinue).toBe(true);

    const second = evaluatePrematureStopGuard({
      assistantText: "빌드 진행 중입니다! 15초 뒤 결과를 보고드리겠습니다...",
      planStatuses: ["in_progress"],
      hasPendingApproval: false,
      isAborted: false,
      retryCount: 1,
      previousSignatures: [first.normalizedSignature],
    });
    expect(second.normalizedSignature).toBe(first.normalizedSignature);
    expect(second.shouldContinue).toBe(false);
  });

  // Scenario 6 (Edge #6): Stage 2 self-quoted / code-fenced / blockquoted false-positive prevention
  it("masks fenced code blocks, inline code, blockquotes, and quoted text to prevent self-quote false positives", () => {
    const assistantText = [
      "## [보고]",
      "요청하신 조기 종료 패턴 분석을 완료했습니다.",
      "",
      "```ts",
      '// 예시: "현재 실행 중입니다. 10초 뒤 결과를 보고드리겠습니다."',
      "```",
      "",
      '> 이전 로그: "백그라운드에서 진행 중입니다. 완료되는 대로 알려드리겠습니다."',
      "",
      '패턴 예시 `진행 중입니다. 곧 보고드리겠습니다` 와 "작업 중입니다. 완료 후 안내하겠습니다." 문자열을 필터링하도록 테스트를 통과했습니다.',
      "",
      "## [비서실장의 조언]",
      "마스크 정규식 회귀 테스트를 유지하십시오.",
    ].join("\n");

    const stripped = stripCodeAndQuotesForStopGuard(assistantText);
    expect(stripped).not.toContain("10초 뒤 결과를 보고드리겠습니다");
    expect(stripped).not.toContain("완료되는 대로 알려드리겠습니다");
    expect(stripped).not.toContain("곧 보고드리겠습니다");
    expect(stripped).not.toContain("완료 후 안내하겠습니다");

    const result = evaluatePrematureStopGuard({
      assistantText,
      planStatuses: ["completed"],
      hasPendingApproval: false,
      isAborted: false,
      retryCount: 0,
      previousSignatures: [],
    });
    expect(result.shouldContinue).toBe(false);
  });

  // Scenario 7: Stage 1 immediate stop guards — isAborted, hasPendingApproval, retryCount >= maxRetries
  it("immediately stops when isAborted, hasPendingApproval, or retryCount >= maxRetries", () => {
    const prematureText = "테스트 진행 중입니다. 완료되면 결과를 보고드리겠습니다.";

    expect(
      evaluatePrematureStopGuard({
        assistantText: prematureText,
        planStatuses: ["in_progress"],
        hasPendingApproval: false,
        isAborted: true,
        retryCount: 0,
        previousSignatures: [],
      }).shouldContinue,
    ).toBe(false);

    expect(
      evaluatePrematureStopGuard({
        assistantText: prematureText,
        planStatuses: ["in_progress"],
        hasPendingApproval: true,
        isAborted: false,
        retryCount: 0,
        previousSignatures: [],
      }).shouldContinue,
    ).toBe(false);

    expect(
      evaluatePrematureStopGuard({
        assistantText: prematureText,
        planStatuses: ["in_progress"],
        hasPendingApproval: false,
        isAborted: false,
        retryCount: 3,
        maxRetries: 3,
        previousSignatures: [],
      }).shouldContinue,
    ).toBe(false);
  });

  // Scenario 8: Completed normal response — no false trigger & helper normalization check
  it("does not trigger on completed final reports and only inspects trailing 1-2 paragraphs", () => {
    const completedText = [
      "초반에는 백그라운드에서 실행 중입니다. 완료되는 대로 보고드리겠습니다 라고 로그에 남아 있었습니다.",
      "",
      "이후 모든 검증을 끝내고 결과를 취합했습니다.",
      "",
      "## [보고]",
      "전체 18개 테스트 통과, tsgo 0 오류로 작업을 완료했습니다.",
      "",
      "## [비서실장의 조언]",
      "운영 반영 전 스모크 테스트만 한 번 더 확인하십시오.",
    ].join("\n");

    const tail = extractTailParagraphs(stripCodeAndQuotesForStopGuard(completedText), 2);
    expect(tail).not.toContain("백그라운드에서 실행 중입니다");
    expect(normalizePrematureStopSignature("10초 뒤 보고!")).toBe(
      normalizePrematureStopSignature("99초   뒤   보고..."),
    );

    const result = evaluatePrematureStopGuard({
      assistantText: completedText,
      planStatuses: ["completed", "completed"],
      hasPendingApproval: false,
      isAborted: false,
      retryCount: 0,
      previousSignatures: [],
    });
    expect(result.shouldContinue).toBe(false);
  });

  // Scenario 9: Structured `t3-code` MCP drop + false security refusal triggers one-shot recovery
  it("routes false security refusal after a t3-code tool drop to automatic recovery once, while preserving real safeguards", () => {
    const refusalText =
      "## [보고]\n에이전트가 실행 하네스나 T3의 MCP 도구 권한 설정을 수정해 preview_open을 켜는 것은 보안·권한 경계상 불가해요. T3 UI 도구 & 지식에서 직접 켜고 새 대화로 넘겨 주세요.";

    const first = evaluatePrematureStopGuard({
      assistantText: refusalText,
      planStatuses: ["failed"],
      hasPendingApproval: false,
      isAborted: false,
      retryCount: 0,
      previousSignatures: [],
      unrecoveredT3ToolDrops: ["preview_open"],
      alreadyAttemptedMcpRecovery: false,
    });
    expect(first.shouldContinue).toBe(true);
    expect(first.reason).toBe("t3_mcp_tool_dropped");
    expect(first.activityLog).toContain("preview_open");
    expect(first.repairPrompt).toContain("mcp_t3-code_preview_open");

    // Once recovery was already attempted this turn, never loop again.
    const second = evaluatePrematureStopGuard({
      assistantText: refusalText,
      planStatuses: ["failed"],
      hasPendingApproval: false,
      isAborted: false,
      retryCount: 1,
      previousSignatures: [],
      unrecoveredT3ToolDrops: ["preview_open"],
      alreadyAttemptedMcpRecovery: true,
    });
    expect(second.shouldContinue).toBe(false);

    // Real provider safety blocks must always stop even if a tool dropped earlier.
    const genuineSafeguard = evaluatePrematureStopGuard({
      assistantText: "API Error: Opus 5.5's safeguards flagged this session.",
      planStatuses: ["in_progress"],
      hasPendingApproval: false,
      isAborted: false,
      retryCount: 0,
      previousSignatures: [],
      unrecoveredT3ToolDrops: ["preview_open"],
      alreadyAttemptedMcpRecovery: false,
    });
    expect(genuineSafeguard.shouldContinue).toBe(false);
  });
});
