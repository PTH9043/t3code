import { describe, expect, it } from "vite-plus/test";
import { classifyMemorySalience } from "./memorySalience.ts";

describe("memory salience", () => {
  it("keeps explicit user decisions, preferences and prior durable signals", () => {
    for (const text of [
      "앞으로 질문 카드를 우선 사용",
      "기억해 둬",
      "이 설정은 금지",
      "오류의 원인을 조사해",
      "예산은 5달러",
      "always use UTF-8",
    ]) {
      expect(classifyMemorySalience("user", text)).toBe("user-decision");
    }
  });
  it("keeps source-bearing reports as unverified evidence without promoting ordinary chatter", () => {
    expect(
      classifyMemorySalience(
        "assistant",
        "apps/server/src/file.ts:12에서 실제 테스트 실패를 확인했고 같은 경로에 재현 결과를 기록했습니다.",
      ),
    ).toBe("reported-evidence");
    expect(classifyMemorySalience("assistant", "네 진행하겠습니다.")).toBe("ordinary");
    expect(classifyMemorySalience("assistant", "테스트 통과했습니다. 모두 완료했습니다.")).toBe(
      "ordinary",
    );
    expect(classifyMemorySalience("user", "안녕")).toBe("ordinary");
  });
});
