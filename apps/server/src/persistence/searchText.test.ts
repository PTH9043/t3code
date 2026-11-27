import { describe, expect, it } from "vite-plus/test";

import {
  analyzeChunks,
  analyzeSearchText,
  buildSearchQuery,
  chunkSearchableContent,
  makeSnippet,
  termCoverage,
} from "./searchText.ts";

it("keeps section headings on long continuations and respects paragraph and Unicode boundaries", () => {
  const chunks = chunkSearchableContent(
    "# Cancellation\n\n" +
      "😀 first paragraph policy. ".repeat(150) +
      "\n\n# Shipping\n\n" +
      "second paragraph delivery. ".repeat(100),
  );
  expect(chunks.every((chunk) => chunk.length <= 1200)).toBe(true);
  expect(
    chunks
      .filter((chunk) => chunk.includes("first paragraph"))
      .every((chunk) => chunk.startsWith("# Cancellation")),
  ).toBe(true);
  expect(
    chunks
      .filter((chunk) => chunk.includes("second paragraph"))
      .every((chunk) => chunk.startsWith("# Shipping")),
  ).toBe(true);
  expect(
    chunks.some((chunk) => chunk.includes("first paragraph") && chunk.includes("second paragraph")),
  ).toBe(false);
  expect(
    chunks.every(
      (chunk) => !/[\uD800-\uDBFF]$/u.test(chunk) && !/[\uDC00-\uDFFF]/u.test(chunk[0] ?? ""),
    ),
  ).toBe(true);
});

describe("analyzeSearchText", () => {
  it("indexes Korean as overlapping bigrams so particles no longer hide a word", () => {
    expect(analyzeSearchText("수익률을 확인")).toBe("수익 익률 률을 확인");
  });

  it("splits mixed-script words and lowercases Latin", () => {
    expect(analyzeSearchText("SaaS대시보드 Card-Grid")).toBe("saas 대시 시보 보드 card grid");
  });

  it("keeps a lone syllable as its own token", () => {
    expect(analyzeSearchText("앱 v2")).toBe("앱 v2");
  });
});

describe("buildSearchQuery", () => {
  it("strips particles and endings, then searches the stem's bigram phrase", () => {
    const query = buildSearchQuery("대시보드를 개선해줘");
    expect(query?.terms).toEqual(["대시보드", "개선"]);
    expect(query?.match).toBe('"대시 시보 보드" OR "개선"');
  });

  it("leaves nouns that only look like they end in a particle whole", () => {
    expect(buildSearchQuery("결과 추가 회의")?.terms).toEqual(["결과", "추가", "회의"]);
    expect(buildSearchQuery("지갑을 추적하는")?.terms).toEqual(["지갑", "추적"]);
  });

  it("drops task-talk and function words entirely", () => {
    expect(buildSearchQuery("작업 진행 확인 해줘")).toBeNull();
    expect(buildSearchQuery("the and of")).toBeNull();
  });

  it("queries Latin words as prefixes and short ones exactly", () => {
    expect(buildSearchQuery("cards dashboard ui")?.match).toBe('"cards"* OR "dashboard"* OR "ui"');
  });

  it("queries a lone syllable as a bigram prefix", () => {
    expect(buildSearchQuery("앱")?.match).toBe('"앱"*');
  });

  it("dedupes and caps the number of terms", () => {
    const query = buildSearchQuery("alpha beta alpha gamma delta", 3);
    expect(query?.terms).toEqual(["alpha", "beta", "gamma"]);
  });

  it("never lets query text inject FTS syntax", () => {
    // Operators and quotes become plain quoted terms; "OR" is a stopword.
    const query = buildSearchQuery('NEAR("alpha" beta) OR "gamma" * -delta');
    expect(query?.match).toBe('"near"* OR "alpha"* OR "beta"* OR "gamma"* OR "delta"*');
  });
});

describe("termCoverage", () => {
  it("counts distinct terms present anywhere, particles included", () => {
    expect(termCoverage(["수익", "지갑", "없음"], "이번 분기 수익률을 지갑별로")).toBe(2);
  });
});

describe("makeSnippet", () => {
  it("centres on the first match and marks every hit", () => {
    const content = `${"앞부분 ".repeat(60)}이번 분기 수익률을 개선했다 ${"뒷부분 ".repeat(60)}`;
    const snippet = makeSnippet(content, ["수익"], 80);
    expect(snippet.startsWith("…")).toBe(true);
    expect(snippet.endsWith("…")).toBe(true);
    expect(snippet).toContain("[수익]률을");
  });
});

describe("chunking", () => {
  it("chunks large content deterministically with bounded pieces", () => {
    const chunks = chunkSearchableContent("paragraph ".repeat(500));
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 1_200)).toBe(true);
  });

  it("analyzes every chunk and drops bookkeeping tags from the index", () => {
    const [chunk] = analyzeChunks({
      title: "배포 체크리스트",
      content: "배포 전에 검증을 끝낸다",
      tags: ["release", "original-chars-812"],
    });
    expect(chunk?.tagsText).toBe("release");
    expect(chunk?.searchTitle).toBe("배포 체크 크리 리스 스트");
    expect(chunk?.searchBody).toContain("검증 증을");
  });

  it("preserves Parent-Child heading hierarchy and Markdown table headers across split chunks", () => {
    const doc = [
      "# 2026년 국내 출장 규정",
      "임직원 국내 출장 기본 안내문. ".repeat(70),
      "## 제3조 숙박비 한도",
      "| 직급 | 서울 숙박비 | 지방 숙박비 |",
      "| :--- | :--- | :--- |",
      ...Array.from({ length: 30 }, (_, i) => `| 등급-${i + 1} | 150,000원 | 120,000원 |`),
      "| 수석연구원 | 180,000원 | 150,000원 |",
    ].join("\n");
    const chunks = chunkSearchableContent(doc);
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.every((chunk) => chunk.length <= 1_200)).toBe(true);
    const tailTableChunk = chunks.find((chunk) => chunk.includes("수석연구원"));
    expect(tailTableChunk).toBeDefined();
    expect(tailTableChunk).toContain("# 2026년 국내 출장 규정");
    expect(tailTableChunk).toContain("## 제3조 숙박비 한도");
    expect(tailTableChunk).toContain("| 직급 | 서울 숙박비 | 지방 숙박비 |");
  });

  it("keeps Korean clause identifiers and hyphenated error/product codes intact and prioritizes them in long queries", () => {
    const query = buildSearchQuery("2026년 국내 출장 시 제3조에 따른 TS-999 및 A-2201 기준은?");
    expect(query?.terms).toContain("제3조");
    expect(query?.terms).toContain("ts-999");
    expect(query?.terms).toContain("a-2201");
    expect(query?.match).toContain('"제3조"');
    expect(query?.match).toContain('"ts 999"');
    expect(query?.match).toContain('"a 2201"');
    expect(termCoverage(["제3조"], "제공된 3개의 조건")).toBe(0);
    expect(termCoverage(["제3조"], "제 3 조 숙박비 한도")).toBe(1);

    const longPreamble = Array.from({ length: 18 }, (_, i) => `일반단어${i + 1}`).join(" ");
    const capped = buildSearchQuery(`${longPreamble} 제3조 TS-999`, 16);
    expect(capped?.terms).toContain("제3조");
    expect(capped?.terms).toContain("ts-999");
  });
});
