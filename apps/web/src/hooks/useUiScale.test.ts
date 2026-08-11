import { describe, expect, it } from "vite-plus/test";

import { normalizeUiScale } from "./useUiScale";

describe("normalizeUiScale", () => {
  it("clamps and rounds UI scale to supported steps", () => {
    expect(normalizeUiScale(71)).toBe(80);
    expect(normalizeUiScale(104)).toBe(100);
    expect(normalizeUiScale(126)).toBe(130);
    expect(normalizeUiScale(999)).toBe(150);
  });

  it("uses the default for invalid values", () => {
    expect(normalizeUiScale(null)).toBe(100);
    expect(normalizeUiScale("not-a-number")).toBe(100);
  });
});
