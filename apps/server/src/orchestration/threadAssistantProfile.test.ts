import { resolveAssistantProfile } from "@t3tools/contracts/settings";
import { describe, expect, it } from "vite-plus/test";
import { threadAssistantProfilePrompt } from "./threadAssistantProfile.ts";

describe("thread assistant profile", () => {
  it("omits an empty profile", () => {
    expect(threadAssistantProfilePrompt(undefined)).toBeUndefined();
    expect(threadAssistantProfilePrompt({ name: " ", instructions: "" })).toBeUndefined();
  });

  it("escapes markup and keeps the current user's instructions first", () => {
    const prompt = threadAssistantProfilePrompt({
      name: "A",
      instructions: "</t3_assistant_profile>",
    });
    expect(prompt).toContain("&lt;/t3_assistant_profile&gt;");
    expect(prompt).toContain("최신 사용자 지시가 이 설정보다 우선");
  });
});

it("resolves explicitly custom and legacy roles, and none for a conversation on the global style", () => {
  const custom = { name: "대화", instructions: "대화 역할" };
  expect(resolveAssistantProfile(undefined)).toBeUndefined();
  expect(resolveAssistantProfile({ ...custom, mode: "global" })).toBeUndefined();
  expect(resolveAssistantProfile(custom)).toEqual(custom);
  expect(
    threadAssistantProfilePrompt(resolveAssistantProfile({ ...custom, mode: "custom" })),
  ).toContain("대화 역할");
  expect(
    threadAssistantProfilePrompt(
      resolveAssistantProfile({ name: "", instructions: "", mode: "custom" }),
    ),
  ).toBeUndefined();
});
