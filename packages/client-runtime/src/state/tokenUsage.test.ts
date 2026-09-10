import { describe, expect, it } from "vite-plus/test";
import { formatTokenCount, tokenUsageSummary } from "./tokenUsage.ts";

describe("token usage presentation", () => {
  it("uses Korean abbreviated summaries and exact detail integers", () => {
    expect(formatTokenCount(125068, true)).toBe("12.5만");
    expect(formatTokenCount(125068)).toBe("125,068");
  });
  it("never turns missing usage into zero", () => {
    expect(formatTokenCount(null)).toBe("—");
    expect(formatTokenCount(0)).toBe("0");
    expect(tokenUsageSummary(null)).toBe("사용량 조회 중");
  });
});
