import { describe, expect, it } from "vite-plus/test";
import { live2dCharacterMotion, live2dCharacterSource } from "./live2dCharacterSources";

describe("Live2D character sources", () => {
  it.each([
    ["type95", "95type_405", 9],
    ["k2", "k2_3301", 8],
    ["ots14", "ots14_3001", 8],
  ] as const)(
    "uses the selected normal model and its work motion for %s",
    (character, folder, work) => {
      expect(live2dCharacterSource(character)).toContain(`/${folder}/normal/normal.model3.json`);
      expect(live2dCharacterSource(character)).toBe(
        `/agent-characters/live2d-models/${folder}/normal/normal.model3.json`,
      );
      expect(live2dCharacterMotion(character, false)).toBe(0);
      expect(live2dCharacterMotion(character, true)).toBe(work);
    },
  );
});
