import { describe, expect, it } from "vite-plus/test";
import { characterSpeakingStyle } from "./characterSpeakingStyle.ts";

describe("character speaking style", () => {
  it("gives each selected character a distinct style without changing task instructions", () => {
    const styles = ["type95", "k2", "ots14"] as const;
    const prompts = styles.map(characterSpeakingStyle);
    expect(new Set(prompts).size).toBe(3);
    for (const prompt of prompts) {
      expect(prompt).toContain("문체");
      expect(prompt).toContain("현재 지시");
      expect(prompt).toContain("설명의 깊이와 길이를 줄이거나");
    }
  });

  it("does not inject character style for ordinary or disabled characters", () => {
    for (const character of [undefined, "off", "pixel", "agustina", "vrm"] as const) {
      expect(characterSpeakingStyle(character)).toBeUndefined();
    }
  });
});
