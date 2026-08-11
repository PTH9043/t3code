import { describe, expect, it } from "vite-plus/test";

import { resolveMobileStageLabel } from "./mobileBranding";

describe("resolveMobileStageLabel", () => {
  it.each([
    ["development", "개발"],
    ["preview", "나이틀리"],
    ["production", "알파"],
    [undefined, "알파"],
  ])("maps %s builds to %s", (appVariant, expected) => {
    expect(resolveMobileStageLabel(appVariant)).toBe(expected);
  });
});
