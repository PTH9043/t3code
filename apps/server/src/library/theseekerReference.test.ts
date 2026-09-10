import { describe, expect, it } from "vite-plus/test";

import { SEEKER_REFERENCE_5494_HTML } from "./__fixtures__/theseekerReference5494.ts";
import {
  decodeJsStringLiteral,
  parseSeekerReferencePage,
  toSeekerLibraryDocument,
} from "./theseekerReference.ts";

describe("decodeJsStringLiteral", () => {
  it("decodes the escapes seroval emits", () => {
    expect(decodeJsStringLiteral(String.raw`"a\nb\x3Cé\"q\\"`)).toBe('a\nb<é"q\\');
  });
});

describe("parseSeekerReferencePage", () => {
  it("reads the structured analysis from the router payload", () => {
    const reference = parseSeekerReferencePage(SEEKER_REFERENCE_5494_HTML, 5494);
    expect(reference).toMatchObject({
      id: 5494,
      title: "채용 관리 대시보드 — 상단 내비와 카드 그리드 지표",
      category: "dashboard",
      tweetUrl: "https://x.com/vektorastudio/status/2096931492639527083",
      postText: "Recruitment Management Dashboard",
      author: { handle: "vektorastudio", name: "Vektora Studio" },
      vibe: ["minimal", "light-mode", "corporate"],
      confidence: 0.93,
    });
    expect(reference?.summary).toBe("밝은 배경에 파란 강조색을 쓴 채용 관리 대시보드 화면이다.");
    expect(reference?.descriptionEn?.startsWith("Below a sticky top navigation")).toBe(true);
    expect(reference?.captions[0]).toContain("상단 내비와 통계 카드");
  });

  it("keeps the similar-reference cards out of this reference", () => {
    const reference = parseSeekerReferencePage(SEEKER_REFERENCE_5494_HTML, 5494);
    // The post's own five colours and fourteen tags — none of the six
    // neighbours' palettes or tag sets that follow it in the payload.
    expect(reference?.palette).toHaveLength(5);
    expect(reference?.palette).toContainEqual({ hex: "#2a5ce0", name: "파랑" });
    expect(reference?.tags).toHaveLength(14);
    expect(reference?.tags).toContainEqual({
      slug: "stat-card",
      label: "통계 카드",
      facet: "component",
    });
  });

  it("rejects a page for another id or without a reference", () => {
    expect(parseSeekerReferencePage(SEEKER_REFERENCE_5494_HTML, 1)).toBeNull();
    expect(parseSeekerReferencePage("<html><body>찾을 수 없음</body></html>")).toBeNull();
  });
});

describe("toSeekerLibraryDocument", () => {
  it("renders Korean-first content with attribution and a stable id", () => {
    const reference = parseSeekerReferencePage(SEEKER_REFERENCE_5494_HTML, 5494);
    expect(reference).not.toBeNull();
    const document = toSeekerLibraryDocument(reference!);
    expect(document.itemId).toBe("theseeker-5494");
    expect(document.sourceUrl).toBe("https://ref.theseeker.io/r/5494");
    expect(document.content.split("\n")[0]).toBe(
      "밝은 배경에 파란 강조색을 쓴 채용 관리 대시보드 화면이다.",
    );
    expect(document.content).toContain("팔레트: #f5f6fa 옅은 회백");
    expect(document.content).toContain("통계 카드(stat-card)");
    expect(document.content).toContain("작가: Vektora Studio (@vektorastudio) · 게시 2026-09-07");
    expect(document.searchExtra).toContain("Recruitment Management Dashboard");
    expect(document.tags).toEqual(expect.arrayContaining(["dashboard", "통계 카드", "minimal"]));
  });
});
