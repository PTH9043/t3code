import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  extractResultFileLinks,
  readResultText,
  resultTextExcerpt,
  resultFileType,
  resultPathKey,
} from "./generatedResults";
afterEach(() => vi.unstubAllGlobals());
describe("generated results", () => {
  it("does not split emoji at the preview boundary", () => {
    expect(resultTextExcerpt("가😀나", 2)).toBe("가");
    expect(resultTextExcerpt("가😀나", 3)).toBe("가😀");
  });
  it("recognizes image and text outputs while leaving archives as downloads", () => {
    expect(resultFileType("result.PNG")?.kind).toBe("image");
    expect(resultFileType("자료.md")).toMatchObject({ kind: "text", language: "md" });
    expect(resultFileType("app.ts")?.kind).toBe("text");
    expect(resultFileType("source.zip")).toBeNull();
  });
  it("extracts Windows, spaced, nested-parenthesis and reference-style output links", () => {
    const text =
      "![image](D:/Project/a.png)\n[문서](<D:/Project/한글 자료.txt>)\n[file](report(1).md)\n[json][result]\n[result]: ./data.json";
    expect(extractResultFileLinks(text)).toEqual([
      "d:/project/a.png",
      "d:/project/한글 자료.txt",
      "report(1).md",
      "./data.json",
    ]);
  });
  it("does not publish web addresses, code examples or source citations", () => {
    const fence = String.fromCharCode(96).repeat(3);
    const text =
      fence +
      "md\n[example](fake.txt)\n" +
      fence +
      "\n[code](app.ts:18)\n[code](app.ts#L18)\n[website](https://example.com/demo.png)";
    expect(extractResultFileLinks(text)).toEqual([]);
  });
  it("normalizes file URIs without turning remote links into local paths", () => {
    expect(resultPathKey("file:///D:/Test/%ED%95%9C%EA%B8%80.png")).toBe("d:/test/한글.png");
    expect(resultPathKey("https://example.com/a.txt")).toBe("");
    expect(resultPathKey("file://remote-server/private.txt")).toBe("");
  });
  it("keeps full text and reports preview truncation separately", async () => {
    const text = "한글\r\n".repeat(10000);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(text, {
          headers: { "x-t3-preview-truncated": "true", "x-t3-asset-bytes": "90000" },
        }),
      ),
    );
    expect(await readResultText("https://test.invalid/result")).toEqual({
      text,
      truncated: true,
      byteLength: 90000,
    });
  });
  it("reports an unavailable file rather than copying an error response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("not a result", { status: 404 })),
    );
    await expect(readResultText("https://test.invalid/missing")).rejects.toThrow("404");
  });
});
