import { describe, expect, it } from "vite-plus/test";
import { parsePersistentVerdict } from "./workspacePersistentRun.ts";

describe("persistent supervisor verdict", () => {
  it("accepts a continuation only with a concrete next task", () => {
    expect(
      parsePersistentVerdict(
        '<t3_persistent_verdict>{"decision":"continue","summary":"done","nextTask":"test"}</t3_persistent_verdict>',
      ),
    ).toMatchObject({ decision: "continue", nextTask: "test" });
    expect(() =>
      parsePersistentVerdict(
        '<t3_persistent_verdict>{"decision":"continue","summary":"done"}</t3_persistent_verdict>',
      ),
    ).toThrow();
  });

  it("does not interpret missing, malformed or unknown verdicts as completion", () => {
    for (const output of [
      "완료했습니다",
      "<t3_persistent_verdict>not json</t3_persistent_verdict>",
      '<t3_persistent_verdict>{"decision":"maybe","summary":"done"}</t3_persistent_verdict>',
    ])
      expect(() => parsePersistentVerdict(output)).toThrow();
  });
});
