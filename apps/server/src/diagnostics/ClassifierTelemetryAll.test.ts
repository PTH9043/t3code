import {
  detectDeferredBackgroundClaim,
  getClassifierTelemetrySnapshot,
  resetClassifierTelemetryRegistry,
} from "@t3tools/contracts";
import { classifySmartModelRoute } from "@t3tools/shared/smartModelRouter";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { evaluateCouncilTriage } from "../orchestration/council/CouncilTriage.ts";
import { parseExaoneTextQuestions } from "../orchestration/exaoneTextQuestions.ts";
import { parseTextQuestions } from "../orchestration/textQuestions.ts";
import { evaluatePrematureStopGuard } from "../provider/acp/GeminiPrematureStopGuard.ts";
import { recommendGeminiTurnThoughtLevel } from "../provider/acp/GeminiAcpSupport.ts";
import {
  isProviderContentRefusal,
  isProviderContentRefusalOutput,
  isSafeguardBlock,
} from "../provider/providerContentRefusal.ts";

describe("ClassifierTelemetry 8/8 unified registry", () => {
  beforeEach(() => {
    resetClassifierTelemetryRegistry();
  });

  it("records telemetry for all 8 regex/heuristic classifiers and computes fallback rates", () => {
    // 1. gemini_premature_stop_guard
    evaluatePrematureStopGuard({
      assistantText: "백그라운드 빌드를 진행 중이에요. 끝나는 대로 보고드릴게요.",
      planStatuses: [],
      hasPendingApproval: false,
      isAborted: false,
      retryCount: 0,
      previousSignatures: [],
    });

    // 2. smart_model_router (normal + empty fallback)
    const r1 = classifySmartModelRoute({ prompt: "전체 아키텍처 보안 감사 및 리팩터링" });
    expect(r1.telemetry?.classifier).toBe("smart_model_router");
    const rEmpty = classifySmartModelRoute({ prompt: "" });
    expect(rEmpty.telemetry?.fallbackUsed).toBe(true);

    // 3. gemini_thought_level (xhigh fallback -> high)
    const thought = recommendGeminiTurnThoughtLevel("deep-architectural", {
      prompt: "최종 보안 감사 수행해줘",
      availableLevels: ["low", "medium", "high"],
    });
    expect(thought).toBe("high");

    // 4. text_question_parser (prose list fallback)
    const listQ = parseTextQuestions("gemini", "어느 방식을 원하시나요?\n[1] A안\n[2] B안");
    expect(listQ?.length).toBe(1);

    // 5. exaone_text_question_parser
    parseExaoneTextQuestions("일반 답변입니다.");

    // 6. provider_content_refusal
    expect(isSafeguardBlock("Opus 5.5's safeguards flagged this session")).toBe(true);
    expect(isProviderContentRefusal("flagged for possible cybersecurity risk")).toBe(true);
    expect(isProviderContentRefusalOutput("정상 코드 출력")).toBe(false);

    // 7. deferred_background_claim (negated safe default + positive claim)
    expect(
      detectDeferredBackgroundClaim("현재 별도로 돌리고 있는 백그라운드 작업은 없습니다."),
    ).toBe(false);
    expect(
      detectDeferredBackgroundClaim(
        "백그라운드 전수 검증 진행 중이에요. 끝나는 대로 바로 보고드릴게요.",
      ),
    ).toBe(true);

    // 8. council_triage (empty safe skip + explicit override)
    const tEmpty = evaluateCouncilTriage({ userPrompt: "" });
    expect(tEmpty.recommendation).toBe("skip");
    expect(tEmpty.telemetry?.fallbackUsed).toBe(true);
    const tAuto = evaluateCouncilTriage({ userPrompt: "/council 마이그레이션 설계 검토" });
    expect(tAuto.recommendation).toBe("auto");

    const snapshot = getClassifierTelemetrySnapshot();
    const names = snapshot.map((s) => s.classifier);

    expect(names).toEqual([
      "council_triage",
      "deferred_background_claim",
      "exaone_text_question_parser",
      "gemini_premature_stop_guard",
      "gemini_thought_level",
      "provider_content_refusal",
      "smart_model_router",
      "text_question_parser",
    ]);

    const thoughtMetric = snapshot.find((s) => s.classifier === "gemini_thought_level");
    expect(thoughtMetric?.fallbackCount).toBe(1);
    expect(thoughtMetric?.fallbackRate).toBe(1);

    const routerMetric = snapshot.find((s) => s.classifier === "smart_model_router");
    expect(routerMetric?.totalCalls).toBe(2);
    expect(routerMetric?.fallbackCount).toBe(1);
    expect(routerMetric?.fallbackRate).toBe(0.5);
  });

  it("handles empty or ambiguous inputs safely without throwing across all 8 classifiers", () => {
    expect(classifySmartModelRoute({ prompt: "   " }).tier).toBe("zero_cost_local");
    expect(evaluateCouncilTriage({ userPrompt: "   " }).recommendation).toBe("skip");
    expect(detectDeferredBackgroundClaim("   ")).toBe(false);
    expect(parseTextQuestions("gemini", "")).toBeNull();
    expect(parseExaoneTextQuestions("")).toBeNull();
    expect(isSafeguardBlock(null)).toBe(false);
    expect(isProviderContentRefusal("")).toBe(false);
    expect(isProviderContentRefusalOutput("")).toBe(false);
    expect(
      evaluatePrematureStopGuard({
        assistantText: "",
        planStatuses: [],
        hasPendingApproval: false,
        isAborted: false,
        retryCount: 0,
        previousSignatures: [],
      }).shouldContinue,
    ).toBe(false);
    expect(recommendGeminiTurnThoughtLevel("standard-dev")).toBe("medium");
  });
});
