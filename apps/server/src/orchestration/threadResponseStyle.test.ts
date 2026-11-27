import type { ThreadResponseStyle } from "@t3tools/contracts/settings";
import { describe, expect, it } from "vite-plus/test";

import { threadResponseStylePrompt } from "./threadResponseStyle.ts";

const blank: ThreadResponseStyle = {
  preset: "default",
  tone: "",
  length: "",
  explanation: "",
  instructions: "",
};
const global: ThreadResponseStyle = { ...blank, preset: "concise", instructions: "전역 <지시>" };

describe("global answer style prompt", () => {
  it("turns the global style into prompt text with escaped user text", () => {
    const text = threadResponseStylePrompt(global)!;
    expect(text).toContain("핵심을 먼저 간결하게");
    expect(text).toContain("사용자 추가 지시: 전역 &lt;지시&gt;");
    expect(threadResponseStylePrompt({ ...global, tone: "차분하게" })).toContain("말투: 차분하게");
  });

  it("asks for nothing without a style or with a style that asks for nothing", () => {
    expect(threadResponseStylePrompt(null)).toBeUndefined();
    expect(threadResponseStylePrompt(blank)).toBeUndefined();
    expect(threadResponseStylePrompt({ ...blank, tone: "  " })).toBeUndefined();
  });
});
