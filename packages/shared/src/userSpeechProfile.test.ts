import { describe, expect, it } from "vite-plus/test";
import {
  analyzeUserSpeechStyle,
  extractUserOwnVoiceSegments,
  formatUserSpeechProfileMarkdown,
} from "./userSpeechProfile.ts";

describe("userSpeechProfile", () => {
  it("isolates the user's own Korean voice after arrow (`->`) when preceded by pasted AI/UI dumps", () => {
    const mixedMessage = [
      "6인 동적 위원회 · 7/7 하위 워커 격리 실행 중",
      "원장 검증 근거 141건",
      "진단: 언락 숏(C1)의 이익은 진입 타이밍 지표에서 나오지 않습니다.",
      "언락 시각 청산은 전체 PF 1.42였지만 불안정합니다.",
      "node -e process.exit(0) -> 근데이거 또 실행중에 멈췄는데 말이야 원인이 뭘까 flip 차단되면서 정확하게 말을 안듣는거 같은디",
    ].join("\n");

    const segments = extractUserOwnVoiceSegments(mixedMessage);
    expect(segments.length).toBe(1);
    expect(segments[0]).toContain("근데이거 또 실행중에 멈췄는데 말이야");
    expect(segments[0]).not.toContain("언락 숏(C1)의 이익은 진입 타이밍 지표에서 나오지 않습니다");
  });

  it("profiles casual endings, arrow-chaining, parenthetical intent, and formats markdown cleanly", () => {
    const profile = analyzeUserSpeechStyle([
      {
        text: "어 수정 진행해줘",
        createdAt: "2026-11-24T00:01:00.000Z",
        threadTitle: "위원회 점검",
      },
      {
        text: "독립 검증자 승인 보류\n진단: 긴 보고서 본문입니다.\n두 번째 줄입니다.\n세 번째 줄입니다.\n네 번째 줄입니다. -> 이런 에러 뜬다.. 뭐야 이겡",
        createdAt: "2026-11-24T00:10:00.000Z",
        threadTitle: "위원회 점검",
      },
      {
        text: "운영 반영 안내 -> 재시작 전에 내 대화와 AI가 작성하고 조사한 결과를 분리해서 저장할 수 있게 (AI는 다 볼 수 있지만 나의 말투나 어떻게 말하는지를 저장했으면 해서) ->",
        createdAt: "2026-11-24T00:20:00.000Z",
        threadTitle: "기억 분리",
      },
    ]);

    expect(profile.totalUserMessages).toBe(3);
    expect(profile.arrowChainMessageCount).toBe(2);
    expect(profile.parentheticalAsideCount).toBeGreaterThanOrEqual(1);
    expect(profile.registerCounts.casualBanmal).toBeGreaterThanOrEqual(2);
    expect(profile.habitObservations.some((h) => h.id === "arrow_chaining")).toBe(true);
    expect(profile.habitObservations.some((h) => h.id === "dialect_soft_ending")).toBe(true);

    const fullMd = formatUserSpeechProfileMarkdown(profile);
    expect(fullMd).toContain("사용자 발화·말투 프로파일");
    expect(fullMd).toContain("이런 에러 뜬다.. 뭐야 이겡");
    expect(fullMd).not.toContain("긴 보고서 본문입니다");

    const compactMd = formatUserSpeechProfileMarkdown(profile, { compact: true });
    expect(compactMd).toContain("주 화법:");
  });
});
