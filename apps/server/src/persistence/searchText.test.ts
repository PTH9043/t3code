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
});
