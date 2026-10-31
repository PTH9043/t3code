import { expect, it } from "vite-plus/test";
import {
  workspaceEvidenceBytes,
  workspaceEvidenceHtml,
  workspaceEvidenceText,
} from "./workspaceEvidence.ts";

it("decodes binary evidence without changing bytes and preserves Korean UTF-8 text", () => {
  expect([
    ...workspaceEvidenceBytes({
      label: "image.png",
      contents: "AP+A",
      encoding: "base64",
      byteLength: 3,
      truncated: false,
    }),
  ]).toEqual([0, 255, 128]);
  expect(
    new TextDecoder().decode(
      workspaceEvidenceBytes({
        label: "report.html",
        contents: "검증 자료",
        encoding: "utf8",
        byteLength: 13,
        truncated: false,
      }),
    ),
  ).toBe("검증 자료");
});

it("bounds text layout while keeping the downloaded content available", () => {
  const original = "검증 자료\n".repeat(100_000);
  const preview = workspaceEvidenceText(original);
  expect(preview.contents.length).toBe(50_000);
  expect(preview.shortened).toBe(true);
  expect(original.length).toBeGreaterThan(preview.contents.length);
  expect(workspaceEvidenceText("짧은 결과")).toEqual({ contents: "짧은 결과", shortened: false });
});
it("places the read-only content policy before captured HTML while preserving the report", () => {
  const html = workspaceEvidenceHtml('<h1>검증 결과</h1><script>alert("test")</script>');
  expect(html.indexOf("Content-Security-Policy")).toBeLessThan(html.indexOf("<h1>"));
  expect(html).toContain("script-src 'none'");
  expect(html).toContain("default-src 'none'");
  expect(html).toContain("form-action 'none'");
  expect(html).toContain("<h1>검증 결과</h1>");
});
