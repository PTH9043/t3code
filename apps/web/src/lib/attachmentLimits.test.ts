import { describe, expect, it } from "vite-plus/test";
import { selectComposerFiles } from "./attachmentLimits";

const mib = 1024 * 1024;
function file(name: string, size: number, type = "application/pdf") {
  const value = new File([], name, { type });
  Object.defineProperty(value, "size", { value: size });
  return value;
}

describe("composer attachment budgets", () => {
  it("accepts documents over 10 MB and exactly 50 MB without changing the original", () => {
    for (const size of [10 * mib + 1, 50 * mib]) {
      const original = file("보고서.pdf", size);
      expect(selectComposerFiles([original], { count: 0, bytes: 0 })).toEqual({
        files: [original],
        reservedBytes: size,
        error: null,
      });
    }
  });

  it("rejects sources above 50 MB and empty files before reading them", () => {
    for (const type of ["application/pdf", "image/png"]) {
      const result = selectComposerFiles([file("large", 50 * mib + 1, type)], {
        count: 0,
        bytes: 0,
      });
      expect(result.files).toEqual([]);
      expect(result.error).toContain("50MB");
    }
    expect(selectComposerFiles([file("empty", 0)], { count: 0, bytes: 0 }).error).toContain("비어");
  });

  it("shares the count and byte reservations with overlapping drops, allowing a later fitting file", () => {
    const first = selectComposerFiles([file("a.pdf", 30 * mib)], { count: 0, bytes: 0 });
    const fitting = file("c.txt", 20 * mib);
    const second = selectComposerFiles([file("b.pdf", 21 * mib), fitting], {
      count: first.files.length,
      bytes: first.reservedBytes,
    });
    expect(second.files).toEqual([fitting]);
    expect(second.error).toContain("합계 50MB");
    expect(selectComposerFiles([file("ninth.txt", 1)], { count: 8, bytes: 8 }).error).toContain(
      "8개",
    );
  });
});
